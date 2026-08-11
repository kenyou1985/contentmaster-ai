import React, { useState, useCallback, useRef, useEffect } from 'react';
import { NicheType, ApiProvider } from '../types';
import { NICHES } from '../constants';
import { streamContentGeneration } from '../services/geminiService';
import { generateImage } from '../services/yunwuService';
import {
  COVER_NICHE_ORDER,
  getCoverNicheProfile,
  getCoverReferenceMultimodalPreamble,
} from '../services/coverDesignProfiles';
import { COVER_STYLE_PRESETS } from '../services/coverStylePresets';
import { COVER_TEMPLATES, getCoverTemplate } from '../services/coverTemplatePresets';
import { useToast } from './Toast';
import { Copy, Check, Loader2, Upload, Sparkles, Image as ImageIcon, X, Download, Edit3 } from 'lucide-react';

const MAX_REFERENCE_IMAGES = 12;

/** 封面绘图模型配置 */
type CoverImageModelId = 'gemini-flash' | 'gpt-image-2-all' | 'grok-imagine';
const COVER_IMAGE_MODELS: {
  id: CoverImageModelId;
  name: string;
  desc: string;
}[] = [
  {
    id: 'gemini-flash',
    name: 'Gemini Flash（默认）',
    desc: 'gemini-3.1-flash-image-preview，备用 gemini-2.5-flash-image-preview',
  },
  {
    id: 'gpt-image-2-all',
    name: 'GPT Image 2（OpenAI）',
    desc: '固定使用 gpt-image-2，失败不静默回退到其它模型',
  },
  {
    id: 'grok-imagine',
    name: 'Grok Imagine',
    desc: 'grok-imagine-image-pro',
  },
];

type CoverAspectId = '16:9' | '9:16' | '1:1' | '4:3' | '3:4';

const COVER_ASPECT_OPTIONS: {
  id: CoverAspectId;
  label: string;
  size: string;
  /** Tailwind aspect ratio for preview frame */
  ratioClass: string;
}[] = [
  { id: '16:9', label: '16:9 横屏', size: '1920x1080', ratioClass: 'aspect-video' },
  { id: '9:16', label: '9:16 竖屏', size: '1080x1920', ratioClass: 'aspect-[9/16]' },
  { id: '1:1', label: '1:1 方图', size: '1080x1080', ratioClass: 'aspect-square' },
  { id: '4:3', label: '4:3', size: '1440x1080', ratioClass: 'aspect-[4/3]' },
  { id: '3:4', label: '3:4 竖图', size: '1080x1440', ratioClass: 'aspect-[3/4]' },
];

function newRefId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

interface RefImageItem {
  id: string;
  dataUrl: string;
}

interface CoverDesignProps {
  apiKey: string;
  provider: ApiProvider;
  toast?: ReturnType<typeof useToast>;
}

export interface CoverBundle {
  titles_warning: string;
  titles_anti_truth: string;
  titles_stop_doing: string;
  golden_description: string;
  seo_tags: string;
  visual_emotion_lock: string;
  target_phrase_badge: string;
  /** 2–3 句，SEO/长尾风格，供长句封面分层排版 */
  target_phrase_multi: string;
  var_a: string;
  var_b: string;
  var_c: string;
  var_d: string;
  var_e: string;
  var_f: string;
}

function parseCoverBundle(raw: string, coreTopic = ''): CoverBundle | null {
  if (!raw) return null;
  const t = raw.trim();
  // 1) 优先抽取 markdown 代码块中的 JSON
  const fences = Array.from(t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi));
  const bodies: string[] = fences.map((m) => m[1].trim());
  // 2) 兜底：直接尝试整段
  bodies.push(t);

  for (const body of bodies) {
    if (!body) continue;
    const s = body.indexOf('{');
    const e = body.lastIndexOf('}');
    if (s === -1 || e <= s) continue;

    // 2a) 整段先解析（最常见）
    let o: any = null;
    try {
      o = JSON.parse(body.slice(s, e + 1));
    } catch {
      // 2b) 尝试 repair：去掉 JSON 中的注释、转义错误的换行/控制字符
      const slice = body.slice(s, e + 1);
      const repaired = (() => {
        try {
          return JSON.parse(
            slice
              // 去掉 /* */ 与 // 注释
              .replace(/\/\*[\s\S]*?\*\//g, '')
              .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
              // 把裸换行符（不在引号内）替换为 \n
              .replace(/[\u0000-\u0008\u000B-\u001F]/g, ' ')
          );
        } catch {
          return null;
        }
      })();
      if (repaired && typeof repaired === 'object') o = repaired;
    }

    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;

    const str = (k: string, ...alts: string[]): string => {
      for (const key of [k, ...alts]) {
        const v = r[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number') return String(v);
      }
      return '';
    };

    // 文案类（非 var_*）字段
    const copyFields = {
      titles_warning: str('titles_warning', 'warning'),
      titles_anti_truth: str('titles_anti_truth', 'anti_truth'),
      titles_stop_doing: str('titles_stop_doing', 'stop_doing'),
      golden_description: str('golden_description', 'description'),
      seo_tags: str('seo_tags', 'seo_tags_csv'),
      visual_emotion_lock: str('visual_emotion_lock', 'emotion_lock'),
      target_phrase_badge: str('target_phrase_badge', 'badge'),
      target_phrase_multi: str('target_phrase_multi', 'target_phrase_long', 'multi_hook'),
    };

    // var 字段：每个独立读取（同时兼容字母和数字后缀格式）
    const NUM_MAP: Record<string, string> = { a: '1', b: '2', c: '3', d: '4', e: '5', f: '6' };
    const directVar = (suffix: 'a' | 'b' | 'c' | 'd' | 'e' | 'f') => {
      const n = NUM_MAP[suffix];
      return str(`var_${suffix}_prompt_en`, `var_${suffix}_prompt`, `var_${suffix}`,
        `var_${n}_prompt_en`, `var_${n}_prompt`, `var_${n}`);
    };
    const vars_ = {
      a: directVar('a'),
      b: directVar('b'),
      c: directVar('c'),
      d: directVar('d'),
      e: directVar('e'),
      f: directVar('f'),
    };

    // 退化兜底：var_prompt_en 单字段
    const fallbackVar = str('var_prompt_en', 'prompt_en');

    // ── 从 var_prompt_en 提取关键事实来填充空白的 copy 字段 ──
    // 当 copyOnly 模式下模型返回了 var_prompt_en 而非 8 个文案字段时触发
    if (fallbackVar && Object.values(copyFields).every(v => !v)) {
      const text = fallbackVar;

      // 用 coreTopic 而非 fallbackVar（英文 prompt）检测语言，保证中文议题生成中文文案
      const lang = detectTopicLang(coreTopic);
      if (lang === 'en') {
        // 从 coreTopic 提取关键词，而非英文 prompt
        const properNouns = coreTopic.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
        const numbers = coreTopic.match(/\d+(?:\.\d+)?(?:\s*(?:year|month|day|hour|minute|second|percent|%))?/gi) || [];
        const core = properNouns[0] || numbers[0] || 'this topic';
        copyFields.titles_warning = `⚠️ What 90% Get Wrong About ${core}`;
        copyFields.titles_anti_truth = `The Truth About ${core} Nobody Tells You First`;
        copyFields.titles_stop_doing = `Stop Doing This Before It's Too Late`;
        copyFields.golden_description = `Deep analysis breaking down "${text.slice(0, 100)}..." — core principles and real-world applications in 3 minutes. Subscribe for weekly breakdowns.`;
        copyFields.seo_tags = `#${core.replace(/\s+/g, '')} #DeepDive #Explained #MustKnow #TruthRevealed #CriticalThinking #Analysis #HowTo #ProTips`;
        copyFields.visual_emotion_lock = 'Start with shock → resolve in middle → confirmation at end. Anxiety to certainty.';
        copyFields.target_phrase_badge = `The Shocking Truth About ${core} Nobody Tells You`;
        copyFields.target_phrase_multi = `Why ${core} Actually Matters\nThe Hidden Pattern Nobody Talks About\nWhat Experts Just Confirmed`;
      } else {
        // 用 coreTopic 原文作为锚点，不做正则截断（避免把"阿根廷充满争议的"截在"的"字上）
        // 截取核心观点前 24 字作为标题嵌入（超出截断，避免 SEO 标题过长）
        const fullTopic = (coreTopic || '').trim() || '本期内容';
        const topicShort = fullTopic.length > 24 ? fullTopic.slice(0, 24) : fullTopic;

        // 兼容：如果 coreTopic 含换行/句号，取第一句精华（更适合做标题嵌入）
        const firstClause = fullTopic
          .split(/[。！？!?\n;；]+/)
          .map(s => s.trim())
          .filter(s => s.length >= 4)[0] || fullTopic;
        const anchor = firstClause.length > 24 ? firstClause.slice(0, 24) : firstClause;

        // 仍然提取中文实体用于 SEO 标签和叙事类型检测
        const zhFacts: string[] = [];
        const zhNouns = fullTopic.match(/[\u4e00-\u9fff]{2,}/g) || [];
        if (zhNouns.length) zhFacts.push(...[...new Set(zhNouns)].slice(0, 8));
        const zhNumbers = fullTopic.match(/\d+(?:\.\d+)?(?:年|岁|天|月|周|次|个|万|亿|%)?/g) || [];
        if (zhNumbers.length) zhFacts.push(...zhNumbers);
        const zhAnchor = zhFacts[0] || anchor.slice(0, 8) || '本期内容';

        // ========== SEO 热门标签：基于赛道推理，生成 5 个相关联标签 ==========
        const topicStr = fullTopic.toLowerCase();
        const isSports = /足球|篮球|世界杯|奥运|冠军|球员|球队|联赛|进球|得分|金牌|体育|阿根廷|梅西|c罗/i.test(topicStr);
        const isTech = /ai|人工智能|手机|芯片|电脑|科技|互联网、软件|技术|数据|算法|openai|google|苹果/i.test(topicStr);
        const isFinance = /股票|基金|比特币|加密|货币|经济|投资|理财|银行|金融|市场|房价|工资/i.test(topicStr);
        const isEntertainment = /明星|电影|综艺|偶像|演唱会|韩流|流量|八卦|网红|塌房|粉丝|娱乐圈/i.test(topicStr);
        const isPolitics = /政治|政府|国家|总统|选举|外交|战争|军事|俄罗斯|美国|中国|国际/i.test(topicStr);
        const isEducation = /教育|学校|考试|学生|老师|高考|考研|留学|大学|学习|培训/i.test(topicStr);
        const isHealth = /健康|减肥|养生|医院|医生|疾病|疫苗|病毒|身体|锻炼|睡眠/i.test(topicStr);
        const isFood = /美食|餐厅|烹饪|食材|网红店|减肥|热量|健康/i.test(topicStr);

        const tagPool: string[] = (() => {
          if (isSports) return ['#体育内幕', '#足球争议', '#冠军故事', '#体育科普', '#冷知识', '#真相揭秘', '#历史回顾', '#人物传奇'];
          if (isTech) return ['#科技前沿', '#ai趋势', '#技术解析', '#行业内幕', '#产品测评', '#数码科技', '#互联网观察', '#硬核知识'];
          if (isFinance) return ['#财经真相', '#投资逻辑', '#经济解读', '#财富密码', '#理财干货', '#市场分析', '#商业内幕', '#财经科普'];
          if (isEntertainment) return ['#娱乐圈', '#偶像故事', '#八卦爆料', '#粉丝必看', '#综艺解读', '#影视推荐', '#流量密码', '#明星内幕'];
          if (isPolitics) return ['#国际关系', '#政治解读', '#历史真相', '#大国博弈', '#地缘政治', '#世界格局', '#历史科普', '#深度分析'];
          if (isEducation) return ['#教育真相', '#学习方法', '#考试技巧', '#学霸养成', '#留学指南', '#职场干货', '#知识科普', '#成长故事'];
          if (isHealth) return ['#健康科普', '#养生知识', '#医学真相', '#生活习惯', '#身体警报', '#科学养生', '#健康饮食', '#疾病预防'];
          if (isFood) return ['#美食探店', '#烹饪技巧', '#食材知识', '#健康饮食', '#网红美食', '#减脂餐', '#食谱分享', '#美食测评'];
          return ['#深度解析', '#真相揭秘', '#知识科普', '#冷知识', '#历史真相', '#热门话题', '#必看推荐', '#硬核内容'];
        })();

        // 合并：赛道标签（前3个）+ 话题实体词（后2个），共5个
        const coreTags = tagPool.slice(0, 3);
        const entityTags = zhFacts.slice(0, 3).map(f => `#${f}`);
        const seoTags = [...coreTags, ...entityTags].sort(() => Math.random() - 0.5).slice(0, 5).join(' ');

        // 检测叙事类型
        const isReversal = /从.*到|英雄.*公敌|逆袭|翻盘|崩塌|陨落|坠落|爆发|翻身|神话.*破灭|绝杀|封神|认错|逆风.*翻盘|争议|黑幕|黑哨|假球|不公|不正/i.test(fullTopic);
        const isNumbers = /\d{4}|四年|三年|\d+年|世界杯|奥运|冠军|第一|倒数|排名|进球|失球/i.test(fullTopic);
        const isShocking = /震惊|震撼|吓人|可怕|99%|90%|竟然|居然|万万没想到|第一次|终于|不可思议/i.test(fullTopic);

        // ========== 一句话靶点：从核心观点提炼金句（必须包含核心观点完整信息）==========
        const badgeTemplates: string[] = [];

        if (isReversal) {
          // 反转/争议类：保留完整核心观点 + 加入反思钩子
          badgeTemplates.push(
            `${anchor}——冠军光环下的另一面`,
            `争议从未停止：${anchor}`,
            `${anchor}，是神话还是谎言？`,
            `${anchor}？重新审视这段历史`,
          );
        }
        if (isNumbers) {
          // 数字/成绩驱动
          badgeTemplates.push(
            `${anchor}——数据会给出答案`,
            `${anchor}：成绩背后的争议`,
            `数字不会说谎：${anchor}`,
            `${anchor}，含金量到底如何？`,
          );
        }
        if (isShocking) {
          // 震惊/意外类
          badgeTemplates.push(
            `${anchor}？看完你会有新的答案`,
            `没想到是这样：${anchor}`,
            `${anchor}——颠覆你的认知`,
          );
        }
        // 默认：直接引用核心观点作为钩子句
        badgeTemplates.push(
          `深度解析：${anchor}`,
          `${anchor}，本期内容一次讲透`,
          `关于「${anchor}」，你可能误会了`,
          `重新理解：${anchor}`,
        );

        // ========== 多句靶点：基于核心观点延伸 2-3 句（必须包含核心观点完整信息）==========
        const multiTemplates: string[] = [];

        if (isReversal) {
          // 反转叙事：从光环到争议
          multiTemplates.push(
            `${anchor}\n有人说是传奇，有人说是笑话\n数据摆在眼前，为什么评价天差地别？\n本期还原完整真相`,
            `${anchor}\n冠军光环下藏着多少质疑？\n支持者与反对者各执一词\n本期用数据说话`,
          );
        }
        if (isNumbers) {
          // 数字驱动：成绩单拆解
          multiTemplates.push(
            `${anchor}\n官方给出了答案，但民间质疑从未停止\n这些数字背后的故事你可能不知道\n本期一次讲透`,
            `${anchor}\n为什么有人追捧，有人嗤之以鼻？\n数据面前，争议的根源是什么？\n本期深度拆解`,
          );
        }
        if (isShocking) {
          // 震惊类
          multiTemplates.push(
            `${anchor}\n这个真相很少有人愿意提起\n不是因为不重要，而是因为太颠覆\n今天我们把它说清楚`,
            `${anchor}\n说出来你可能不信\n但事实就摆在历史记录里\n看完你会改变看法`,
          );
        }
        // 默认兜底：基于核心观点本身延伸
        if (multiTemplates.length < 3) {
          multiTemplates.push(
            `${anchor}\n背后隐藏着不为人知的逻辑\n为什么有人支持，有人反对？\n本期深度拆解，一次讲透`,
            `关于「${anchor}」，网上说法众说纷纭\n到底哪个版本才是真相？\n本期内容给你完整答案`,
            `${anchor}\n本期内容带你重新审视这个话题\n争议背后的逻辑一次讲清\n欢迎评论区留下你的看法`,
          );
        }

        // ========== SEO 标题库（必须包含完整核心观点）==========
        copyFields.titles_warning = `⚠️ 关于「${anchor}」，你可能只知道一半`;
        copyFields.titles_anti_truth = `「${anchor}」的真相，被人为掩盖了`;
        copyFields.titles_stop_doing = `千万别再误解「${anchor}」了`;
        copyFields.golden_description = `${anchor} —— 深度拆解，3 分钟讲透底层原理与实战路径。订阅获取每周爆款拆解。`;
        copyFields.seo_tags = seoTags;
        copyFields.visual_emotion_lock = '开场紧张 → 中段释疑 → 结尾顿悟，情绪弧线由焦虑转为笃定。';
        copyFields.target_phrase_badge = badgeTemplates[Math.floor(Math.random() * badgeTemplates.length)];
        copyFields.target_phrase_multi = multiTemplates[Math.floor(Math.random() * multiTemplates.length)];
      }
    }

    // 质量门禁：必须至少 1 个 var 相关字段非空
    // 接受任意形式：var_prompt_en / var_a_prompt_en / prompt_en / var_a 等
    const filledCopy = Object.values(copyFields).filter(Boolean).length;
    const filledVars = Object.values(vars_).filter(Boolean).length;

    // 命中条件：至少有 1 个文案字段 OR 至少有 1 个 var 字段 OR 有 fallback var
    // 这让 copyOnly 路径（只有文案、无 var_*）也能命中
    if (filledVars < 1 && !fallbackVar && filledCopy < 1) continue;

    // 退化兜底：仅 fallbackVar 有内容（6 个 var 全空）→ 复制到 A~F
    if (fallbackVar && filledVars < 1) {
      vars_.a = vars_.b = vars_.c = vars_.d = vars_.e = vars_.f = fallbackVar;
    }
    // 退化兜底：仅 A 有内容、其他 5 个空 → 复制到 B~F
    else if (vars_.a && filledVars === 1) {
      vars_.b = vars_.c = vars_.d = vars_.e = vars_.f = vars_.a;
    }
    // 极端兜底：完全不是 JSON，但 raw 字符串有明显 portrait/prompt 内容（"YouTube thumbnail"/"portrait"/"thumbnail"），
    // 提取最长一段作为 A，其他由本地变体派生
    else if (
      filledVars < 1 &&
      !fallbackVar &&
      /(YouTube thumbnail|thumbnail|portrait|prompt)/i.test(raw) &&
      raw.length > 50
    ) {
      const portraitLine = raw
        .split(/\n+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 30 && /[A-Za-z]/.test(s))
        .sort((a, b) => b.length - a.length)[0] || raw.trim();
      const base = portraitLine.length > 400 ? portraitLine.slice(0, 400) : portraitLine;
      const suffixA = '';
      const suffixB = ' Alternative minimalist composition: ultra-clean background, single subject, rule-of-thirds placement, soft editorial lighting, one dominant accent color, bold display typography in corner, premium magazine feel.';
      const suffixC = ' High-contrast close-up variant: intense expression, hard rim light, oversaturated red-vs-blue color clash, oversized typography overlapping subject, gritty film-grain texture.';
      const suffixD = ' Vertical split variant: top half main cinematic scene, bottom half a stat/data card panel, vertical beam splits both halves, oversized stat number below.';
      const suffixE = ' Infographic variant: central giant number or shield, subject silhouette behind it, top horizontal Hook text band, side card with 3 short stats, flat-design vector accents.';
      const suffixF = ' Portrait + giant banner variant: subject half-body close-up, oversized name/title banner across frame, corner badge with role/program name, dramatic cinematic lighting.';
      vars_.a = base + suffixA;
      vars_.b = base + suffixB;
      vars_.c = base + suffixC;
      vars_.d = base + suffixD;
      vars_.e = base + suffixE;
      vars_.f = base + suffixF;
    }

    return {
      ...copyFields,
      var_a: vars_.a,
      var_b: vars_.b,
      var_c: vars_.c,
      var_d: vars_.d,
      var_e: vars_.e,
      var_f: vars_.f,
    };
  }

  return null;
}

function detectTopicLang(text: string): 'en' | 'zh' {
  const zh = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = (text.match(/[a-zA-Z]/g) || []).length;
  if (en > zh * 1.5) return 'en';
  return 'zh';
}

/**
 * 判断文本是否像"句子"而非"关键词罗列"。
 * 三层过滤：
 * 1. 长度 ≥ 6
 * 2. 4+ 顿号/逗号分隔 → 判定关键词堆砌
 * 3. 必须含至少一个中文动/系词（否则即使是短句也可能只是名词短语）
 * 返回 true = 句子，false = 关键词堆砌或纯名词短语
 */
export function isSentenceLike(text: string): boolean {
  const t = (text || '').trim();
  if (!t || t.length < 6) return false;
  const separatorCount = (t.match(/[、，；;]/g) || []).length;
  if (separatorCount >= 4) return false;
  // 必须含动/系词（否则即使有标点也可能只是名词短语）
  if (!/是|有|在|为|了|被|把|让|给|从|到|看|说|想|做|打|攻|开|关|停|爆|崩|翻|输|赢|推|拉|撕|咬|捅|杀|抓|抢|夺|战|争|斗|压|撑|扛|背|藏|锁|盯|揭|曝|戳|刺|砍|砸|挖|掘|折|叠|卷|铺|张|合|并|切|断|连|接|通|堵|塞|挡|拦|阻|卡|分|裂|碎|烂|腐|坏|损|伤|亡|死|活|生|长|成|败|盈|亏|得|失|获|取|夺|请|求|要|需|盼|愿|思|念|感|觉|见|听|闻|握|拿|放|丢|投|挂|盖|绑|扎|捏|揉|搓|拍|劈|掏|抓|提|搬|搞|弄|推|抗|挡|围|封|绞|催|逼/.test(t)) return false;
  return true;
}

/** 多句靶点拆行（换行优先，否则按句末标点切） */
function splitMultiHookLines(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const byNl = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (byNl.length > 1) return byNl;
  return t
    .split(/(?<=[。！？!?])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 行内色值（避免 Tailwind 扫描不到模板字符串里的 text-* 类） */
const MULTI_HOOK_LINE_HEX = ['#fcd34d', '#7dd3fc', '#f0abfc', '#6ee7b7', '#fdba74'] as const;

/** SEO 标签：展示/复制时去掉逗号、顿号与引号，仅用空格分隔 */
function formatSeoTagsForDisplay(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  return t
    .split(/[，,、;；]+|\s+/u)
    .map((s) =>
      s
        .trim()
        .replace(/^["'"「」『』]/u, '')
        .replace(/["'"「」『』]$/u, '')
        .trim()
    )
    .filter(Boolean)
    .join(' ');
}

/** Converts any image URL to a blob URL, using the image proxy when needed for CORS */
async function fetchImageAsBlob(src: string): Promise<string> {
  if (src.startsWith('data:')) {
    const res = await fetch(src);
    if (!res.ok) throw new Error('fetch failed');
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }
  const proxyUrl = (typeof process !== 'undefined' && process.env?.IMAGE_PROXY_URL) || '';
  const fetchUrl = proxyUrl
    ? `${proxyUrl.replace(/\/$/, '')}?url=${encodeURIComponent(src)}`
    : `/__image_proxy?url=${encodeURIComponent(src)}`;
  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error('fetch failed');
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

async function downloadCoverImage(src: string, filename: string): Promise<void> {
  if (src.startsWith('data:')) {
    const a = document.createElement('a');
    a.href = src;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  try {
    const url = await fetchImageAsBlob(src);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    // 代理 fetch 失败（生产环境无 /__image_proxy），降级：直接用 <a download> 指向原始 URL
    // 图片已在页面上渲染并缓存，浏览器可直接从缓存下载，绕过 fetch CORS
    const a = document.createElement('a');
    a.href = src;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

export const CoverDesign: React.FC<CoverDesignProps> = ({
  apiKey,
  provider,
  toast: externalToast,
}) => {
  const internalToast = useToast();
  const toast = externalToast || internalToast;

  const [niche, setNiche] = useState<NicheType | null>(null);
  const [nicheModalOpen, setNicheModalOpen] = useState(false);
  const [coreTopic, setCoreTopic] = useState('');
  const [refPreviews, setRefPreviews] = useState<RefImageItem[]>([]);
  const [refLocked, setRefLocked] = useState(false);
  const [rawOut, setRawOut] = useState('');
  const [bundle, setBundle] = useState<CoverBundle | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const [schemeUrls, setSchemeUrls] = useState<Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F', string | null>>({
    A: null,
    B: null,
    C: null,
    D: null,
    E: null,
    F: null,
  });
  const [schemeLoading, setSchemeLoading] = useState<Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F', boolean>>({
    A: false,
    B: false,
    C: false,
    D: false,
    E: false,
    F: false,
  });
  const [copied, setCopied] = useState<string | null>(null);
  const [coverAspect, setCoverAspect] = useState<CoverAspectId>('16:9');
  /** 出图时采用一句话或多句极限靶点 */
  const [coverHookSource, setCoverHookSource] = useState<'one' | 'multi'>('one');
  const [coverStyleId, setCoverStyleId] = useState<string>('realistic');
  const [coverImageModel, setCoverImageModel] = useState<CoverImageModelId>('gpt-image-2-all');
  /** 封面模板（可选·与赛道正交的第二层风格锁定） */
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('cover_template_id');
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (selectedTemplateId) localStorage.setItem('cover_template_id', selectedTemplateId);
      else localStorage.removeItem('cover_template_id');
    } catch {
      /* ignore */
    }
  }, [selectedTemplateId]);
  /** 用户编辑后的 bundle（用户对靶点文案等的修改；优先于 bundle 渲染） */
  const [editedBundle, setEditedBundle] = useState<CoverBundle | null>(null);
  /** bundle 更新时同步初始化 editedBundle */
  useEffect(() => {
    setEditedBundle(bundle);
  }, [bundle]);
  /** 渲染使用的活跃 bundle：用户编辑优先 */
  const live = editedBundle ?? bundle;
  const selectedTemplate = getCoverTemplate(selectedTemplateId);

  /** 与 refPreviews 同步，避免在 setState updater 里启动异步（Strict Mode 会双次调用 updater 导致重复追加） */
  const refPreviewsRef = useRef<RefImageItem[]>([]);
  useEffect(() => {
    refPreviewsRef.current = refPreviews;
  }, [refPreviews]);

  const nicheRef = useRef<NicheType | null>(niche);
  useEffect(() => {
    nicheRef.current = niche;
  }, [niche]);

  const canYunwuImage = apiKey.trim().startsWith('sk-');

  const onRefFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const files = input.files;
    if (!files?.length) return;
    const filtered = Array.from(files).filter((f) => f.type.startsWith('image/'));
    input.value = '';
    if (!filtered.length) return;

    const prev = refPreviewsRef.current;
    const room = MAX_REFERENCE_IMAGES - prev.length;
    if (room <= 0) {
      toast.warning(`最多 ${MAX_REFERENCE_IMAGES} 张参考图`);
      return;
    }
    const toRead = filtered.slice(0, room);
    if (filtered.length > room) {
      toast.warning(`本次仅添加 ${room} 张（总数上限 ${MAX_REFERENCE_IMAGES}）`);
    }

    void (async () => {
      try {
        const urls = await Promise.all(
          toRead.map(
            (f) =>
              new Promise<string>((resolve, reject) => {
                const r = new FileReader();
                r.onload = () =>
                  typeof r.result === 'string' ? resolve(r.result) : reject(new Error('read'));
                r.onerror = () => reject(new Error('read'));
                r.readAsDataURL(f);
              })
          )
        );
        setRefPreviews((p) => {
          const remaining = MAX_REFERENCE_IMAGES - p.length;
          if (remaining <= 0) return p;
          const add = urls.slice(0, remaining).map((dataUrl) => ({ id: newRefId(), dataUrl }));
          return [...p, ...add].slice(0, MAX_REFERENCE_IMAGES);
        });
        if (urls.length > 0) {
          setRefLocked(true);
          if (nicheRef.current === null) {
            setNicheModalOpen(true);
          }
        }
      } catch {
        toast.error('读取图片失败');
      }
    })();
  };

  const removeRefById = (id: string) => {
    setRefPreviews((prev) => prev.filter((x) => x.id !== id));
  };

  useEffect(() => {
    if (refPreviews.length === 0) {
      setRefLocked(false);
    }
  }, [refPreviews.length]);

  const clearAllRefs = () => {
    setRefPreviews([]);
    setRefLocked(false);
  };

  const copy = useCallback(
    (key: string, text: string) => {
      if (!text?.trim()) return;
      navigator.clipboard.writeText(text).then(() => {
        setCopied(key);
        toast.success('已复制');
        setTimeout(() => setCopied(null), 2000);
      });
    },
    [toast]
  );

  const buildPrompts = useCallback((copyOnly = false) => {
    if (niche === null) {
      return { system: '', user: '' };
    }
    const profile = getCoverNicheProfile(niche);
    const nicheName = NICHES[niche].name;
    const lang = detectTopicLang(coreTopic);
    const aspectOpt =
      COVER_ASPECT_OPTIONS.find((o) => o.id === coverAspect) ?? COVER_ASPECT_OPTIONS[0];

    const langRule =
      lang === 'en'
        ? '文案类字段（titles_*、golden_description、seo_tags、visual_emotion_lock、target_phrase_badge、target_phrase_multi）使用英文。'
        : '文案类字段（titles_*、golden_description、visual_emotion_lock、target_phrase_badge、target_phrase_multi）使用简体中文；seo_tags 见下条单独规则。';

    const seoTagsRule =
      lang === 'en'
        ? 'seo_tags：约 12 个英文主题标签，每个以 # 开头；**标签之间仅用单个空格分隔**，禁止使用逗号、分号或引号包裹；不要输出 "#tag1, #tag2" 这种格式。'
        : 'seo_tags：约 12 个标签，每个以 # 开头，**标签主体必须为中文词语**（可含必要数字）；**标签之间仅用单个空格分隔**，禁止使用英文逗号、中文逗号、顿号或引号「」"" 包裹或分隔；禁止整串英文驼峰式标签（如 #TraditionalChineseMedicine）。';

    const imageTextRule =
      lang === 'en'
        ? '【画面内文字·最高优先级】六条 var_*_prompt_en 用英文撰写（供文生图模型阅读），每条都必须包含明确指令：画面上所有可见文字（主标题、副标、角标、装饰字等）必须为英文，不得出现中文或其它文字（用户原文专有名词除外）。'
        : '【画面内文字·最高优先级】六条 var_*_prompt_en 用英文撰写（供文生图模型阅读），每条都必须包含明确指令：画面上所有可见中文（主标题、副标、角标、印章字、小字等）须为**繁体中文（Traditional Chinese）**字形呈现；语义可与 target_phrase_badge / target_phrase_multi 的简体草稿一致，但字形须繁体；不得出现英文或其它外文（用户明确给出的品牌拉丁缩写除外）。';

    const hookRule =
      '【一句话靶点】须填写 target_phrase_badge（单句极限 Hook）。\n【多句靶点】须填写 target_phrase_multi：共 2–3 句，风格参考本页「SEO 标题库 & 长尾标签库」：信息密度高，可含数字、禁忌/悬念、身份指向、结果承诺、搜索长尾组合；与 target_phrase_badge 同一主题但分层展开，供封面副标题/条带/小字使用。\n【主标题铁律】六条 var_*_prompt_en 须把 target_phrase_badge 的语义做成画面最醒目、最大字号主标题；若构图需要副文案，可融入 target_phrase_multi 中的句子且不矛盾。';


    const crossNicheBan =
      niche === NicheType.HISTORICAL_FIGURE
        ? ''
        : '【跨赛道禁令】当前非「睡前历史人物」赛道：var_* 中禁止无故加入狗、宠物犬、hound、puppy、canine 等与核心议题及风格 DNA 无关的犬类或「睡前宠物」符号，除非用户「核心议题」原文明确提到宠物/狗且与视频内容一致。画面元素须严格服务于该赛道风格 DNA。';

    const refSystemNote =
      refLocked && refPreviews.length > 0
        ? niche === NicheType.HISTORICAL_FIGURE
          ? `\n\n⚠️ 参考图已锁定（${refPreviews.length} 张）：var_*_prompt_en 须描述参考图中人物外形（发型、服饰）、若图中有宠物则写清品种与毛色花纹耳朵等、以及画风特征，不得写通用模糊描述。`
          : `\n\n⚠️ 参考图已锁定（${refPreviews.length} 张）：var_*_prompt_en 须忠实描述参考图中实际出现的人物、服饰、道具、场景与画风；禁止编造图中不存在的动物（尤其禁止无故加入狗/宠物），禁止混入其它赛道的代表元素。`
        : '';

    const templateBlock = selectedTemplate
      ? `\n\n【封面模板锁定】用户已选模板：${selectedTemplate.icon} ${selectedTemplate.name}\n模板风格 DNA：${selectedTemplate.styleDna}\nA 方案构图方向：${selectedTemplate.schemeAHint}\nB 方案构图方向：${selectedTemplate.schemeBHint}\nC 方案构图方向：${selectedTemplate.schemeCHint}\nD 方案构图方向：${selectedTemplate.schemeDHint}\nE 方案构图方向：${selectedTemplate.schemeEHint}\nF 方案构图方向：${selectedTemplate.schemeFHint}\n所有 6 条 var_*_prompt_en 须严格遵循此模板的视觉风格（颜色、构图、字体、情绪）以及上述 A~F 的方案差异化（不要把同一个画面改改色调就交差）。`
      : '';

    const system = `你是 YouTube 高转化缩略图与标题总监，熟悉 ${nicheName} 赛道视觉包装。${selectedTemplate ? `同时你正在使用 ${selectedTemplate.icon} ${selectedTemplate.name} 模板。` : ''}
只输出一个 JSON 对象，禁止 Markdown 代码块、禁止前言后记。
JSON 的键必须完全一致（字符串值，15 个完整字段）：titles_warning, titles_anti_truth, titles_stop_doing, golden_description, seo_tags, visual_emotion_lock, target_phrase_badge, target_phrase_multi, var_a_prompt_en, var_b_prompt_en, var_c_prompt_en, var_d_prompt_en, var_e_prompt_en, var_f_prompt_en。
【禁止漏字段、禁止合并、禁止省略 var_*_prompt_en 的 a/b/c/d/e/f 后缀。】如果只输出 var_prompt_en 这种单字段视为格式错误。
titles_* 为「60 字内极简标题」风格的三类：THE WARNING / THE ANTI-TRUTH / THE STOP DOING（各一条，${lang === 'en' ? '英文' : '中文'}）。
golden_description 为黄金两行视频简介。${seoTagsRule}
visual_emotion_lock 描述画面情绪弧线。target_phrase_badge 为封面一句话极限靶点（${lang === 'en' ? '英文 Hook 短语' : '中文单句 Hook，可简体'}）。target_phrase_multi 为 2–3 句多句靶点（${lang === 'en' ? '英文' : '中文'}），写法参考爆款 SEO 标题与长尾标签组合。
var_a/b/c_prompt_en 对应 A/B/C 三个差异化构图方向，var_d_prompt_en 对应 D（纵向分屏），var_e_prompt_en 对应 E（信息图 / 数据牌），var_f_prompt_en 对应 F（人像/主角 + 大字横幅）。每条 80–180 词，用英文撰写（供文生图），须包含：构图、光线、配色、字体排版、点击率元素（箭头/高亮框等）。
【关键·必须 6 条全部输出】每个 var_*_prompt_en 必须独立写出，绝不允许：
- 用 "var_prompt_en" / "var_a_prompt_en" 这种无后缀或合并字段
- 只输出 1 条或 2 条然后省略剩余
- 6 条内容必须彼此差异（A 与 B 不能只是调色版本）
否则前端会判定格式错误并丢弃本次输出。
${hookRule}
${imageTextRule}
${crossNicheBan}${templateBlock}${refSystemNote}
${langRule}`;

    const user = `${nicheName ? `## 赛道：${nicheName}\n` : ''}${selectedTemplate ? `## 封面模板：${selectedTemplate.icon} ${selectedTemplate.name}\n模板风格 DNA：${selectedTemplate.styleDna}\n\n` : ''}${profile ? `## 风格 DNA（赛道）\n${profile.styleDna}\n\n` : ''}## 6 个差异化方案方向（写入对应 var_*_prompt_en）
- 方案 A（场景沉浸）：${selectedTemplate?.schemeAHint ?? profile?.schemeAHint ?? '通用极简构图'}
- 方案 B（极简底）：${selectedTemplate?.schemeBHint ?? profile?.schemeBHint ?? '通用极简构图'}
- 方案 C（高反差特写）：${selectedTemplate?.schemeCHint ?? profile?.schemeCHint ?? '通用极简构图'}
- 方案 D（纵向分屏）：${selectedTemplate?.schemeDHint ?? '上下分屏：上半部主体画面，下半部数据牌 / 信息条，中线光束分割'}
- 方案 E（信息图 / 数据牌）：${selectedTemplate?.schemeEHint ?? '信息图风格：中央巨型数据 / 数字 / 徽章 + 主体剪影 + Hook 字横压顶部'}
- 方案 F（人像 + 大字横幅）：${selectedTemplate?.schemeFHint ?? '主角半身特写 + 巨型姓名/称呼横幅 + 角标职位/节目名'}

## 核心议题（视频在讲什么）
${coreTopic.trim() ? coreTopic : '（未填写）请自行根据赛道 / 模板生成一个高 CTR 占位主题（例如：豪门夜战 · 七号回归后连续三轮 0:2 被吊打的真相），整段 prompt 仍要严格输出 JSON，禁止在 JSON 之外补充任何提示文字。'}

## 语言（文案类字段）
${langRule}

请严格输出 JSON，每个 var_*_prompt_en 必须明确按其方案（A~F）的构图写，不能只是色调变体。`;

    if (copyOnly) {
      // 简化模式：只生成 8 个文案字段（不要写 var_*_prompt_en）
      const zhHookRule = `【靶点 Hook·硬性结构铁律】
target_phrase_badge（封面主标题·一句话极限靶点）：
- **必须是完整句子**，必须有主谓宾结构，**严禁输出关键词罗列/名词堆砌/用顿号/逗号/空格隔开的词组**！
- 6–20 字，单句，**至少含 1 个动词或 1 个问号/感叹号**（如"暗刀"、"捅刀"、"开战"、"锁定"等具体动作词）
- 必须从核心议题「${coreTopic.trim()}」的具体事件/争议/反转中提炼，**禁止脱离议题**
- 技法：① 反直觉反转（真相反转）② 身份/结果承诺（99%的人不知道）③ 禁忌窥探（被隐瞒的真相）④ 数字冲击（3个致命误区）⑤ 极端化（千万别这么做）
- ❌ 错误示范："卢秀燕、赖清德、中华民国"（仅名词罗列）
- ✅ 正确示范："卢秀燕这一刀，捅穿了国民党初选"
- ✅ 正确示范："2028 先开战的，是卢秀燕背后这一招"

target_phrase_multi（多句极限靶点·2–3 句）：
- **每句必须是完整句子**，2–3 句用 \\n 隔开；与 badge 同主题但分层展开
- **句式节奏**：第一句陈述事件背景+反问；第二句递进反差/结果；第三句预判/悬念收尾；**禁止三句全是反问句**
- **人名出现规则**：人物全名（如"郑丽文"、"卢秀燕"）仅在第一句出现一次；第二/三句用"这/接下来/各方/此后"替代，**禁止人名重复出现**
- ❌ 错误示范（全反问）："郑丽文为什么要这么做？\\n为什么她会这样做？\\n为什么没有人阻止？"
- ❌ 错误示范（人名重复）："郑丽文为什么向日方献支票\\n郑丽文的动机是什么\\n郑丽文下一步会怎样"
- ✅ 正确示范："郑丽文在731纪念日向日方献百万支票，为什么会被解读为政治表态？\\n面对广西洪灾却反应冷淡，巨大反差背后藏着什么逻辑？\\n若舆论持续围攻，她的政治形象会不会直接失分？"

seo_tags（封面 SEO 长尾标签库）：
- 必须输出 8–10 个标签，**用空格分隔**，每个标签**必须以 # 开头**
- 标签组合策略（每类至少 1 个）：
  · 热搜词标签：核心人物 + 核心事件词（如 #卢秀燕 #国民党初选 #2028选举）
  · 悬念钩子标签：1–2 个搜索长尾（如 #谁在背后捅 #初选暗战）
  · 垂直赛道标签：1–2 个赛道大类（如 #台海局势 #政治解读 #时政辣评）
- ❌ 错误示范："卢秀燕 赖清德 中华民国"（无 # 前缀、空格分隔的纯名词）
- ✅ 正确示范："#卢秀燕 #国民党初选 #2028 #谁在背后捅 #初选暗战 #台海局势 #时政辣评"`;
      const enHookRule = `[Hook] target_phrase_badge: one punchline Hook, transform from topic (do NOT copy verbatim). Techniques: ① counter-intuitive flip ② identity/commitment promise ③ forbidden truth ④ number shock ⑤ extreme. Single line, 6–12 words, punchy. target_phrase_multi: 2–3 Hook lines, same theme layered, do NOT repeat badge.`;
      const copyOnlySystem = `YouTube copy & SEO director for ${nicheName} niche.${selectedTemplate ? ` Template: ${selectedTemplate.icon} ${selectedTemplate.name}.` : ''}
Output STRICT JSON only. No explanations. No markdown. No code fences. Just raw JSON starting with { and ending with }. The JSON must contain exactly these 8 keys: titles_warning, titles_anti_truth, titles_stop_doing, golden_description, seo_tags, visual_emotion_lock, target_phrase_badge, target_phrase_multi.
${lang === 'en' ? enHookRule : zhHookRule}
${lang === 'en' ? 'All copy fields in English.' : '文案字段用简体中文；seo_tags 用中文词组标签。'}`;

      const copyOnlyUser = `## ${nicheName}\n${selectedTemplate ? `## Template: ${selectedTemplate.icon} ${selectedTemplate.name}\n` : ''}${profile ? `## Style DNA: ${profile.styleDna}\n\n` : ''}## 核心议题（视频在讲什么）
${coreTopic.trim()}

Output JSON only. Do NOT output var_*_prompt_en fields.`;

      return { system: copyOnlySystem, user: copyOnlyUser };
    }

    return { system, user };
  }, [niche, coreTopic, refLocked, refPreviews.length, coverAspect, selectedTemplate]);

  /**
   * 本地兜底：6 个差异化 var prompt 模板（基于赛道 + 模板 + 核心议题）
   */
  const buildLocalVarPrompts = useCallback((): Record<'a'|'b'|'c'|'d'|'e'|'f', string> => {
    const aspectOpt =
      COVER_ASPECT_OPTIONS.find((o) => o.id === coverAspect) ?? COVER_ASPECT_OPTIONS[0];
    const ar = aspectOpt.id;
    const topic = coreTopic.trim() || 'this video core topic';
    const tpl = selectedTemplate;
    const dna = (tpl?.styleDna || '').slice(0, 120);
    const a = `YouTube thumbnail. Scheme A — immersive cinematic scene about "${topic.slice(0, 40)}". Wide cinematic composition with main subject front-center, dramatic ${dna || "high-contrast"} lighting, dominant complementary color palette, bold headline at top in sans-serif heavy weight, click-rate elements like glowing highlight ring or arrow pointing to subject, sharp focus, high detail, photorealistic.`;
    const b = `YouTube thumbnail. Scheme B — minimal base about "${topic.slice(0, 40)}". Ultra-clean background with single gradient, subject placed off-center rule-of-thirds, soft ${dna || "editorial"} lighting, monochrome accent + one pop color, large display typography bottom-left, subtle glow halo, no clutter, premium magazine layout.`;
    const c = `YouTube thumbnail. Scheme C — high-contrast close-up of "${topic.slice(0, 40)}". Tight crop on subject face/upper body, intense expression, hard rim light, ${dna || "saturation-boosted"} color clash (red vs blue), oversized typography overlapping subject, arrow + circled emphasis, gritty film-grain texture, photorealistic.`;
    const d = `YouTube thumbnail. Scheme D — vertical split about "${topic.slice(0, 40)}". Top half shows main cinematic scene, bottom half shows a stat panel / data card; vertical light beam splits the two halves. High-contrast palette, bold number or stat in lower half, sans-serif heavy numerals, clean infographic typography.`;
    const e = `YouTube thumbnail. Scheme E — infographic / data card for "${topic.slice(0, 40)}". Center-stage giant number or badge with subject silhouette behind it, top horizontal Hook text band, side info card with 3 short stats, ${dna || 'flat-design'} vector accents, clean modern infographic.`;
    const f = `YouTube thumbnail. Scheme F — portrait + huge banner for "${topic.slice(0, 40)}". Subject half-body close-up, giant name/title banner stretching across frame, corner badge with role/program name, ${dna || "premium"} dramatic lighting, type dominates composition, photorealistic subject.`;
    return { a, b, c, d, e, f };
  }, [coreTopic, coverAspect, selectedTemplate]);

  /**
   * 本地启发式兜底：8 个文案字段（基于核心议题）
   * 策略：从议题提取关键事实锚点，用「事实+反转/悬念」结构生成 Hook（非关键词+套语）
   */
  const buildLocalCopyPrompts = useCallback(() => {
    const tRaw = coreTopic.trim();
    const lang = detectTopicLang(coreTopic);

    // ── 提取关键事实锚点 ──
    function extractFacts(text: string): string[] {
      const facts: string[] = [];

      // 中文：提取专有名词（人名/地名/机构名/事件名，2-8字汉字词组）
      const properNouns = text.match(/[\u4e00-\u9fff]{2,8}(?:队|杯|赛|国|王|帝|王|神|星|王|皇|协|会|团|联|赛|运|赛|联|盟|机构|公司|组织|党|派|集团|企业|组织)/g);
      if (properNouns) facts.push(...properNouns);

      // 数字 + 单位/年份（2026、4年、3分钟等）
      const numbers = text.match(/\d+(?:\.\d+)?(?:年|岁|天|月|周|次|个|人|万|亿|%|分|秒)?/g);
      if (numbers) facts.push(...numbers);

      // 含数字的词组（四年、世界杯、2026世界杯）
      const numPhrases = text.match(/[\u4e00-\u9fff\d]{3,12}/g);
      if (numPhrases) facts.push(...numPhrases);

      // 具体动作词（夺冠/被围攻/沉默/反转/逆袭/坠落/爆发/认错）
      const actionPhrases = text.match(/[\u4e00-\u9fff]{2,6}(?:夺冠|围攻|沉默|反转|逆袭|坠落|爆发|认错|逆风|翻盘|封神|崩塌|陨落|觉醒|突破|翻车|暴雷)/g);
      if (actionPhrases) facts.push(...actionPhrases);

      // 完整高价值短语（从…到…结构）
      const arcPhrases = text.match(/从[\u4e00-\u9fff]{1,6}到[\u4e00-\u9fff]{1,6}/g);
      if (arcPhrases) facts.push(...arcPhrases);

      return [...new Set(facts)].slice(0, 8);
    }

    // 英文：提取关键词
    function extractEnKeywords(text: string): string[] {
      const stop = ['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'about', 'and', 'but', 'or', 'not', 'this', 'that', 'these', 'those', 'it', 'its', 'what', 'which', 'who', 'whom', 'how', 'why'];
      const words = text.split(/\s+/).filter(w => w.length > 3 && !stop.includes(w.toLowerCase()));
      return [...new Set(words)].slice(0, 6);
    }

    const facts = lang === 'en' ? extractEnKeywords(tRaw) : extractFacts(tRaw);
    // 选最有信息量的锚点：优先选含数字或动作的，其次选专有名词
    const anchor = facts.find(f => /^\d|年|岁|次|夺冠|围攻|沉默|反转|逆袭|坠落|爆发|封神|崩塌|陨落/.test(f))
                || facts[0]
                || (lang === 'en' ? 'this topic' : '本期内容');
    const topicFull = tRaw || (lang === 'en' ? 'this video' : '本期视频');

    if (lang === 'en') {
      const badgeTemplates = [
        `The Shocking Truth About ${anchor} Nobody Tells You`,
        `Why ${anchor} Is More Important Than You Think`,
        `The Real Reason Behind ${anchor}`,
        `What 99% Get Wrong About ${anchor}`,
      ];
      const multiTemplates = [
        `Why ${anchor} Actually Matters in 2026\nThe Hidden Pattern Nobody Talks About\nWhat Experts Just Confirmed`,
        `The Truth About ${anchor} They Don\'t Want You to Know\nWhy This Changes Everything\nWhat You Need to Understand Now`,
        `How ${anchor} Became the Biggest Story of the Year\nThe Facts They\'re Hiding From You\nWhy This Matters More Than You Realize`,
      ];
      return {
        titles_warning: `⚠️ What 90% Get Wrong About ${anchor}`,
        titles_anti_truth: `The Truth About ${anchor} Nobody Tells You First`,
        titles_stop_doing: `Stop Doing This Before It\'s Too Late`,
        golden_description: `Deep analysis of "${topicFull}" — breaking down core principles and real-world applications in 3 minutes. Subscribe for weekly viral breakdowns.`,
        seo_tags: `#${anchor.replace(/\s+/g, '')} #DeepDive #Explained #MustKnow #TruthRevealed #CriticalThinking #Analysis #HowTo #ProTips`,
        visual_emotion_lock: 'Start with shock → resolve in middle → confirmation at end. Anxiety to certainty.',
        target_phrase_badge: badgeTemplates[Math.floor(Math.random() * badgeTemplates.length)],
        target_phrase_multi: multiTemplates[Math.floor(Math.random() * multiTemplates.length)],
      };
    }

    // ── 中文 Hook：基于核心观点句子结构生成金句 ──
    // 策略：核心观点本身往往就是金句（"X：Y"或"X，谁 Y"），优先复用其结构
    // 抽取出"主语 + 谓语 + 关键动作"，围绕该动作延伸 5 种技法的金句
    const cleanedTopic = topicFull.replace(/[：:]\s*/, '：').trim();

    // 抽取核心观点里的关键短语作为"动作锚点"（避免单纯用 anchor 替换导致跑题）
    // 优先匹配含动作词/争议词的子句
    function extractCoreClause(text: string): string {
      // 1) 含动作词的子句优先（开战/暗刀/捅/盯/锁/翻/塌/暴/反/逆/冲/爆/撕/掀/打）
      const actionRegex = /([^，,。；;\n]{2,20}(?:开战|暗刀|捅刀|捅|盯上|锁死|翻盘|塌|暴跌|暴雷|反转|逆袭|冲|爆|撕|掀|打脸|封锁|围堵|制裁|决战|抢先|先开|对决|开战|宣战|清算|摊牌|背刺|翻脸|反水|倒戈|背叛|下架|退场|开战|撕裂|崩盘|暴跌))/;
      const actionMatch = text.match(actionRegex);
      if (actionMatch) return actionMatch[1].replace(/[？?。！！]+$/, "").trim();

      // 2) 含反问/疑问的子句
      const qMatch = text.match(/([^，,。；;\n]{4,30}[？?])/);
      if (qMatch) return qMatch[1].replace(/[？?。！！]+$/, "").trim();

      // 3) 含"X：Y"或"X——Y"结构的冒号后部分
      const colonMatch = text.match(/[：:]([^，,。；;\n]{4,30})/);
      if (colonMatch) return colonMatch[1].replace(/[？?。！！]+$/, "").trim();

      // 4) 否则返回核心观点第一句精华
      const firstClause = text.split(/[。！？!?\n;；]+/).map(s => s.trim()).filter(s => s.length >= 4)[0] || text;
      return firstClause.slice(0, 24).replace(/[？?。！！]+$/, "");
    }

    const coreClause = extractCoreClause(topicFull);
    const mainSubject = facts[0] || '这件事';

    // ── 一句话极限靶点（6–18 字、必须含动作/悬念）──
    const zhBadgeTemplates = [
      // ① 直接引用核心观点中的动作子句（最相关）
      `${coreClause}`,
      // ② 极端化悬念
      `${mainSubject}这步棋，下得太狠了`,
      // ③ 反直觉反转
      `${mainSubject}：你只看到了表面`,
      // ④ 数字/结果承诺
      `${mainSubject}背后，藏着 3 个真相`,
      // ⑤ 禁忌窥探
      `谁在${coreClause.replace(/^[是谁在有让]/, '')}？没人敢直说`,
    ];

    // ── 提取人物全名（2–3 字汉姓，用于多句靶点强制出现）──
    // ── 提取人物全名（2–3 字汉姓，用于多句靶点强制出现）──
    // 策略：扫描姓氏出现位置，取其后 1–2 个汉字（避免被英文/数字打断）
    // ── 提取人物全名（2–3 字汉姓，用于多句靶点强制出现）──
    // 策略：姓氏 + 合法人名用字（常见名用字白名单）
    // ── 提取人物全名（2–3 字汉姓，用于多句靶点强制出现）──
    // 策略：姓氏 + 合法人名用字（常见名用字白名单）
    // ── 提取人物全名（2–3 字汉姓，用于多句靶点强制出现）──
    // 策略：宽松正则提 2-3 字汉词，强力黑名单过滤，去重后按长度降序
    function extractPersonNames(text: string): string[] {
      const surnameSet = new Set('王李张刘陈杨黄赵吴周徐孙马朱胡郭林何高梁罗郑谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈余姚姜邱侯尹万段雷钱汤黎陶贺顾毛郝龚邵赖苏邹巫卢柯孔廖严向钱江史欧阳司马诸葛'.split(''));
      // 强力黑名单：常见地名/虚词/截断词
      const blacklist = new Set(['日本','广西','中国','美国','欧洲','亚洲','非洲','各国','全球','国内','国外','中央','731','纪念日','无动于衷','高调','低调','沉默','表态','回应','宣布','背后','官方','事实上','这是','什么是','所谓','其实','实际上','为什么','到底','究竟','终于','竟然','居然','因此','因为','所以','而是','但是','如果','假如','虽然','然而','然后','最后','百万','千万','亿元','支票','洪灾','地震','台风','暴雷','暴跌','暴动','受困','受难','灾情','灾民','遇难','救援','捐款','捐赠','为何','如何','何为','因何','怎样','怎么样','这是','什么','为什','怎样','怎么','何人','为何','如何','于衷','无动','的得','的是','了的','在地','在对','在被','再次','次打','打破','破纪','纪录','呼吁','声明','宣称','表示','指出','强调','公开','曝光','揭露','开始','进行','发生','出现','看来','梅西宣','罗再次','王毅紧','何深意']);
      // 姓氏后紧跟的单字符黑名单（常见助词/介词/代词）
      const afterSurnameChars = new Set('为在的得地了和与对对把被在有从到在和但或而而且');
      // 匹配 2-3 字连续汉字词组
      const results: string[] = [];
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (!surnameSet.has(ch)) continue;
        // 取其后第 1 个汉字字符（不跳过非汉字）
        let j = i + 1;
        while (j < text.length && !/[\u4e00-\u9fff]/.test(text[j])) j++;
        const rest1 = text[j];
        if (!rest1) continue;
        const name2 = ch + rest1;
        // 2 字名：第 2 字必须是合法名用字（不能在黑名单中）
        if (!blacklist.has(name2) && !afterSurnameChars.has(rest1)) {
          results.push(name2);
          // 尝试 3 字名
          let k = j + 1;
          while (k < text.length && !/[\u4e00-\u9fff]/.test(text[k])) k++;
          const rest2 = text[k];
          if (rest2 && !blacklist.has(name2 + rest2)) {
            results.push(name2 + rest2);
          }
        }
      }
      // 去重 + 按长度降序（优先 3 字名）
      return [...new Set(results)].sort((a, b) => b.length - a.length);
    }
    const personNames = extractPersonNames(topicFull);
    // 用第一个人名（如有），否则用 mainSubject
    const primaryName = personNames[0] || mainSubject;

    // ── 多句极限靶点（人名仅首句出现，句式陈述/反问混合）──
    // 策略：句1 = 人名 + 从 topicFull 提取的人名后动作片段；句2/3 基于 topicFull 其他内容
    // 1) 提取 topicFull 中人名后的动作片段（避免句1中人名重复出现）
    const nameIdx = topicFull.indexOf(primaryName);
    const afterName = nameIdx >= 0 ? topicFull.slice(nameIdx + primaryName.length).trim() : topicFull.trim();
    // 去除 leading 标点/助词
    const actionPart = afterName.replace(/^[，、：:;；的得地在了有]/, '').replace(/[？?。！!]$/, '').trim();
    // 句1 人名 + 动作片段（若 coreClause 已含人名则不重复；去除所有中文问号避免双问号）
    const cleanCore = (coreClause || '').replace(/[？?]+$/, '').replace(/[？?]/g, '');
    const sentence1 = actionPart.length > 0 && cleanCore.length > primaryName.length + 2
      ? `${primaryName}${actionPart.replace(/[？?]/g, '')}`
      : `${primaryName}${cleanCore}`;
    // 句2/3 用 topicFull 中与人名+句1不同的内容片段
    const nonNamePart = topicFull.replace(primaryName, '').replace(/^[，、：:;；]/, '').trim();
    const seg2 = nonNamePart.slice(0, Math.min(nonNamePart.length, 20));

    const zhMultiTemplates = [
      // ① 事件背景 + 反问 + 动机追问
      `${sentence1}，\n为什么会被外界解读为政治表态？\n这背后到底藏着什么动机？`,
      // ② 反差递进（陈述 + 反问 + 结果预判）
      `${sentence1}，\n而面对另一边却反应冷淡，\n这种强烈反差说明了什么？`,
      // ③ 结果预判（陈述 + 反问 + 悬念收尾）
      `${sentence1}，\n各方反应越来越强烈，\n接下来的局势会不会直接失分？`,
      // ④ 混合节奏（陈述 + 反问 + 结论）
      `${sentence1}，\n舆论开始出现两极分化，\n这场操作到底是算计还是失误？`,
    ];

    // ── SEO 长尾标签（热搜词 + 长尾 + 赛道大类）──
    // 赛道大类标签库
    const topicStr = topicFull.toLowerCase();
    const isSports = /足球|篮球|世界杯|奥运|冠军|球员|球队|联赛|进球|得分|金牌|体育|阿根廷|梅西|c罗/i.test(topicStr);
    const isTech = /ai|人工智能|手机|芯片|电脑|科技|互联网、软件|技术|数据|算法|openai|google|苹果/i.test(topicStr);
    const isFinance = /股票|基金|比特币|加密|货币|经济|投资|理财|银行|金融|市场|房价|工资/i.test(topicStr);
    const isPolitics = /政治|政府|国家|总统|选举|外交|战争|军事|俄罗斯|美国|中国|国际|卢秀燕|国民党|赖清德|柯文哲|民进党|民进|台海|两岸|初选/i.test(topicStr);

    const nicheTrackTags = isPolitics
      ? ['#时政辣评', '#政治解读', '#台海局势', '#大国博弈']
      : isFinance
        ? ['#财经真相', '#投资逻辑', '#经济解读']
        : isSports
          ? ['#体育内幕', '#深度解析']
          : isTech
            ? ['#科技前沿', '#行业内幕']
            : ['#深度解析', '#真相揭秘', '#热门话题'];

    // 核心人物/事件标签（取 facts 前 4 个 + 主语）
    const entityTagSet = new Set<string>();
    entityTagSet.add(`#${mainSubject}`);
    facts.slice(0, 4).forEach(f => entityTagSet.add(`#${f}`));

    // 长尾钩子标签（基于 coreClause 提取关键词）
    const longTailSet = new Set<string>();
    if (/背后|捅|暗刀|暗战|内幕|博弈/.test(topicFull)) longTailSet.add('#背后真相');
    if (/开战|对决|先开|抢先/.test(topicFull)) longTailSet.add('#抢先开战');
    if (/2028|2026|2027/.test(topicFull)) longTailSet.add('#选举布局');
    if (/初选|提名|候选人/.test(topicFull)) longTailSet.add('#初选暗战');
    if (/谁在/.test(topicFull)) longTailSet.add('#谁在背后');

    // 合并：长尾(1-2) + 人物事件(2-3) + 赛道大类(1-2)，共 6-8 个
    const seoTagList: string[] = [
      ...Array.from(longTailSet).slice(0, 2),
      ...Array.from(entityTagSet).slice(0, 3),
      ...nicheTrackTags.slice(0, 2),
    ].filter(Boolean).slice(0, 7);

    const badgeIdx = Math.floor(Math.random() * zhBadgeTemplates.length);
    const multiIdx = Math.floor(Math.random() * zhMultiTemplates.length);

    return {
      titles_warning: `⚠️ 关于「${mainSubject}」，90% 的人都理解错了`,
      titles_anti_truth: `「${mainSubject}」的真相，被掩盖了太久了`,
      titles_stop_doing: `千万别再误解「${mainSubject}」了`,
      golden_description: `${topicFull} —— 深度拆解，3 分钟讲透底层原理与实战路径。订阅获取每周爆款拆解。`,
      seo_tags: seoTagList.join(' '),
      visual_emotion_lock: '开场紧张 → 中段释疑 → 结尾顿悟，情绪弧线由焦虑转为笃定。',
      target_phrase_badge: zhBadgeTemplates[badgeIdx],
      target_phrase_multi: zhMultiTemplates[multiIdx],
    };
  }, [coreTopic]);

  const runGenerateBundle = async (copyOnly = false) => {
    if (!apiKey.trim()) {
      toast.error('请先配置 API Key');
      return;
    }
    if (niche === null && !selectedTemplateId) {
      toast.error('请先选择赛道或封面模板');
      return;
    }
    if (!coreTopic.trim()) {
      toast.error('请先填写「核心议题」，赛道检测与文案生成均依赖此字段');
      return;
    }
    if (provider === 'runninghub') {
      toast.error('封面文案生成需要 Yunwu 或 Google 文本模型，请切换 API 服务');
      return;
    }
    setLoadingText(true);
    setRawOut('');
    const existing = bundle;
    if (!copyOnly) setBundle(null);

    const { system, user } = buildPrompts(copyOnly);
    const refForJson =
      refLocked && refPreviews.length > 0
        ? refPreviews.map((x) => x.dataUrl)
        : undefined;
    const baseOpts = {
      temperature: copyOnly ? 0.6 : 0.7,
      referenceDataUrls: refForJson,
      referenceMultimodalPreamble: refForJson?.length
        ? getCoverReferenceMultimodalPreamble(niche)
        : undefined,
    };

    /**
     * 安全流：即使模型没输出 JSON 也返回原始文本（用于单字段 prompt）
     */
    const safeStream = async (sys: string, usr: string, maxTokens = 1024): Promise<string> => {
      let acc = '';
      try {
        await streamContentGeneration(
          usr,
          sys,
          (chunk) => {
            acc += chunk;
            setRawOut((prev) => prev + chunk);
          },
          undefined,
          { ...baseOpts, temperature: 0.7, maxTokens }
        );
      } catch (err: any) {
        // 单轮失败不致命：返回空字符串，由调用方做兜底
        console.error('[CoverDesign] 单轮生成失败:', err?.message || err);
      }
      return acc;
    };

    try {
      // ========== copyOnly 模式：直接单次请求 8 字段 JSON ==========
      if (copyOnly) {
        let acc = '';
        try {
          await streamContentGeneration(
            user,
            system,
            (chunk) => {
              acc += chunk;
              setRawOut(acc);
            },
            undefined,
            { ...baseOpts, maxTokens: 4096 }
          );
        } catch (err: any) {
          console.error('[CoverDesign] copyOnly 流失败:', err?.message || err);
        }
        let parsed = parseCoverBundle(acc, coreTopic);

        // 兜底：本地启发式生成 8 个字段
        if (!parsed) {
          console.warn('[CoverDesign] copyOnly 解析失败,使用本地启发式兜底。原始输出:', acc);
        }
        const localCopy = buildLocalCopyPrompts();
        const localVars = buildLocalVarPrompts();
        // existing 为空时退化为 localCopy + 本地兜底 VAR（保证用户至少有内容）
        const ex = existing || {};
        const merged = {
          ...ex,
          titles_warning: parsed?.titles_warning || localCopy.titles_warning,
          titles_anti_truth: parsed?.titles_anti_truth || localCopy.titles_anti_truth,
          titles_stop_doing: parsed?.titles_stop_doing || localCopy.titles_stop_doing,
          golden_description: parsed?.golden_description || localCopy.golden_description,
          seo_tags: parsed?.seo_tags || localCopy.seo_tags,
          visual_emotion_lock: parsed?.visual_emotion_lock || localCopy.visual_emotion_lock,
          // 关键：靶点必须是句子。LLM 偶发输出纯名词罗列（如"卢秀燕、赖清德、中华民国"），此时丢弃走本地兜底
          target_phrase_badge: (parsed?.target_phrase_badge && isSentenceLike(parsed.target_phrase_badge))
            ? parsed.target_phrase_badge
            : localCopy.target_phrase_badge,
          target_phrase_multi: (parsed?.target_phrase_multi && isSentenceLike(parsed.target_phrase_multi))
            ? parsed.target_phrase_multi
            : localCopy.target_phrase_multi,
          var_a: ex.var_a || localVars.a,
          var_b: ex.var_b || localVars.b,
          var_c: ex.var_c || localVars.c,
          var_d: ex.var_d || localVars.d,
          var_e: ex.var_e || localVars.e,
          var_f: ex.var_f || localVars.f,
        };
        setBundle(merged);
        const filledCopy = [
          merged.titles_warning, merged.titles_anti_truth, merged.titles_stop_doing,
          merged.golden_description, merged.seo_tags, merged.visual_emotion_lock,
          merged.target_phrase_badge, merged.target_phrase_multi,
        ].filter(Boolean).length;
        if (parsed && filledCopy >= 4) {
          toast.success('文案已补全');
        } else if (parsed && filledCopy > 0) {
          toast.warning(`文案补全不完整（${filledCopy}/8），已用本地启发式填充`);
        } else {
          toast.warning(`LLM 未响应或解析失败，已用本地启发式填充文案（${filledCopy}/8）`);
        }
        return;
      }

      // ========== 完整模式：分阶段生成 ==========
      // Step 1：6 个 var 并行请求（每个独立 prompt，不要求 JSON，只输出纯文本）
      setRawOut('▶ Step 1/2：并行生成 6 个 VAR 提示词...\n\n');
      const { system: varSystem, user: varUser } = buildPrompts(false);
      const schemeKeys: Array<'A' | 'B' | 'C' | 'D' | 'E' | 'F'> = ['A', 'B', 'C', 'D', 'E', 'F'];
      const varResults = await Promise.all(
        schemeKeys.map(async (key) => {
          const singleSystem = `${varSystem}\n\n【本次唯一任务】只输出方案 ${key} 的一段 80–180 词英文文生图 prompt。\n- 禁止 JSON、禁止 Markdown 代码块、禁止前言后记。\n- 直接输出纯英文段落，不要再写方案 B/C/D/E/F 的内容。`;
          const singleUser = `${varUser}\n\n【聚焦方案 ${key}】请只输出方案 ${key} 的英文 prompt 段落，不要重复方案方向列表。`;
          const text = await safeStream(singleSystem, singleUser, 1024);
          return { key, text: text.trim() };
        })
      );
      const localFallback = buildLocalVarPrompts();
      const vars: Record<'a' | 'b' | 'c' | 'd' | 'e' | 'f', string> = {
        a: varResults[0].text || localFallback.a,
        b: varResults[1].text || localFallback.b,
        c: varResults[2].text || localFallback.c,
        d: varResults[3].text || localFallback.d,
        e: varResults[4].text || localFallback.e,
        f: varResults[5].text || localFallback.f,
      };

      // Step 2：单次请求 8 个文案字段（强制 JSON，但降级容忍）
      setRawOut((prev) => prev + '\n\n▶ Step 2/2：生成文案 / SEO / 靶点...\n\n');
      const copySystem = buildPrompts(true).system;
      const copyUser = buildPrompts(true).user;
      let copyAcc = '';
      try {
        await streamContentGeneration(
          copyUser,
          copySystem,
          (chunk) => {
            copyAcc += chunk;
            setRawOut((prev) => prev + chunk);
          },
          undefined,
          { ...baseOpts, maxTokens: 4096 }
        );
      } catch (err: any) {
        console.error('[CoverDesign] 文案生成失败:', err?.message || err);
      }
      const copyParsed = parseCoverBundle(copyAcc, coreTopic);

      const localCopy = buildLocalCopyPrompts();
      const bundleOut: CoverBundle = {
        titles_warning: copyParsed?.titles_warning || localCopy.titles_warning,
        titles_anti_truth: copyParsed?.titles_anti_truth || localCopy.titles_anti_truth,
        titles_stop_doing: copyParsed?.titles_stop_doing || localCopy.titles_stop_doing,
        golden_description: copyParsed?.golden_description || localCopy.golden_description,
        seo_tags: copyParsed?.seo_tags || localCopy.seo_tags,
        visual_emotion_lock: copyParsed?.visual_emotion_lock || localCopy.visual_emotion_lock,
        target_phrase_badge: (copyParsed?.target_phrase_badge && isSentenceLike(copyParsed.target_phrase_badge))
          ? copyParsed.target_phrase_badge
          : localCopy.target_phrase_badge,
        target_phrase_multi: (copyParsed?.target_phrase_multi && isSentenceLike(copyParsed.target_phrase_multi))
          ? copyParsed.target_phrase_multi
          : localCopy.target_phrase_multi,
        var_a: vars.a,
        var_b: vars.b,
        var_c: vars.c,
        var_d: vars.d,
        var_e: vars.e,
        var_f: vars.f,
      };
      setBundle(bundleOut);

      const filledCopy = [
        bundleOut.titles_warning, bundleOut.titles_anti_truth, bundleOut.titles_stop_doing,
        bundleOut.golden_description, bundleOut.seo_tags, bundleOut.visual_emotion_lock,
        bundleOut.target_phrase_badge, bundleOut.target_phrase_multi,
      ].filter(Boolean).length;
      const uniqVars = new Set(
        [vars.a, vars.b, vars.c, vars.d, vars.e, vars.f].map((v) => (v || '').trim()).filter(Boolean)
      );
      const allVarsFromLLM = varResults.every((r) => r.text.trim().length > 0);
      if (filledCopy >= 4 && uniqVars.size >= 3) {
        toast.success('文案与 A~F 矩阵指令已生成');
      } else if (!allVarsFromLLM) {
        toast.warning(`部分 VAR 由本地模板兜底（${varResults.filter((r) => !r.text.trim()).length}/6 个失败）`);
      } else if (filledCopy < 4) {
        toast.warning(`文案字段补全 ${filledCopy}/8，部分由本地启发式兜底`);
      } else {
        toast.warning('生成完成，但差异化方案不足，请手动微调');
      }
    } catch (err: any) {
      console.error('[CoverDesign] runGenerateBundle 异常:', err);
      toast.error(err?.message || '生成失败');
    } finally {
      setLoadingText(false);
    }
  };
  const runSchemeImage = async (key: 'A' | 'B' | 'C' | 'D' | 'E' | 'F') => {
    if (!canYunwuImage) {
      toast.error('缩略图生成需 Yunwu（sk-）Key，请在设置中配置');
      return;
    }
    const varKey = (`var_${key.toLowerCase()}` as 'var_a' | 'var_b' | 'var_c' | 'var_d' | 'var_e' | 'var_f');
    const prompt = live[varKey];
    if (!prompt?.trim()) {
      toast.error(`请先生成 ${key} 指令（点击上方「生成高转化文案」）`);
      return;
    }
    /** 优先用用户编辑后的靶点文案（实时同步） */
    const liveBadge = (editedBundle?.target_phrase_badge ?? bundle?.target_phrase_badge ?? '').trim();
    const liveMulti = (editedBundle?.target_phrase_multi ?? bundle?.target_phrase_multi ?? '').trim();
    if (coverHookSource === 'multi' && !liveMulti) {
      toast.error('多句极限靶点为空，请重新生成文案，或改选「一句话极限靶点」');
      return;
    }
    const aspectOpt =
      COVER_ASPECT_OPTIONS.find((o) => o.id === coverAspect) ?? COVER_ASPECT_OPTIONS[0];
    const topicLang = detectTopicLang(coreTopic);
    const imageTextEnforcement =
      topicLang === 'zh'
        ? '\n\nMandatory: all Chinese characters on the thumbnail (titles, subtitles, stamps, badges) must be in Traditional Chinese (繁體中文) script only; no simplified Chinese forms. No English except user-provided proper nouns if any.'
        : '\n\nMandatory: all on-image text must be English only; no Chinese or other scripts on the thumbnail.';
    const useMulti = coverHookSource === 'multi' && liveMulti;
    const hookEnforcement = useMulti
      ? topicLang === 'zh'
        ? `\n\nLayered thumbnail copy (render all Chinese on-image text in Traditional Chinese 繁體):\n${liveMulti}\nUse the strongest line as the largest dominant title; place remaining 1–2 sentences as secondary strips or subtitles without clutter.`
        : `\n\nLayered thumbnail copy from multi-sentence hook:\n${liveMulti}\nUse the strongest line as the largest dominant title; place remaining 1–2 sentences as secondary strips or subtitles without clutter.`
      : liveBadge
        ? `\n\nThe largest, most dominant title text on the thumbnail must express this hook meaning: "${liveBadge}".`
        : '';
    const stylePreset =
      COVER_STYLE_PRESETS.find((s) => s.id === coverStyleId) ??
      COVER_STYLE_PRESETS.find((s) => s.id === 'minimal_flat')!;
    const styleEnforcement = `\n\nVisual style preset (must match): ${stylePreset.promptEn}`;
    const templateEnforcement = selectedTemplate
      ? `\n\nLocked cover template (must match): ${selectedTemplate.icon} ${selectedTemplate.name} — ${selectedTemplate.styleDna}`
      : '';

    setSchemeLoading((m) => ({ ...m, [key]: true }));
    try {
      const modelMap: Record<CoverImageModelId, string> = {
        'gemini-flash': 'cover-gemini-flash',
        'gpt-image-2-all': 'gpt-image-2-all',
        'grok-imagine': 'grok-imagine',
      };
      const res = await generateImage(apiKey, {
        model: modelMap[coverImageModel],
        prompt: `${prompt}\n\nYouTube thumbnail, ${aspectOpt.id} aspect ratio, bold readable main title, high CTR composition.${styleEnforcement}${templateEnforcement}${hookEnforcement}${imageTextEnforcement}`,
        size: aspectOpt.size,
        quality: 'high',
        referenceDataUrls:
          refLocked && refPreviews.length > 0
            ? refPreviews.map((x) => x.dataUrl)
            : undefined,
      });
      if (res.success && res.url) {
        setSchemeUrls((m) => ({ ...m, [key]: res.url || null }));
        toast.success(`方案 ${key} 已生成`);
      } else {
        toast.error(res.error || '图片生成失败');
      }
    } catch (e: any) {
      toast.error(e?.message || '图片生成失败');
    } finally {
      setSchemeLoading((m) => ({ ...m, [key]: false }));
    }
  };

  const profile = niche !== null ? getCoverNicheProfile(niche) : null;

  const onDownloadScheme = async (key: 'A' | 'B' | 'C' | 'D' | 'E' | 'F', src: string) => {
    try {
      await downloadCoverImage(src, `cover-scheme-${key}-${coverAspect}-${Date.now()}.png`);
      toast.success('已开始下载');
    } catch {
      toast.error('下载失败，可右键图片另存为');
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-16">
      <div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-emerald-400/90 font-mono uppercase tracking-wider mb-2">
          <span className="px-2 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10">
            MULTI-NICHE COVER
          </span>
        </div>
        <h1 className="text-2xl font-bold text-slate-100">YouTube 封面设计</h1>
      </div>

      {/* 赛道 */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {COVER_NICHE_ORDER.map((id) => {
            const n = NICHES[id];
            const on = niche === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setNiche(id);
                  setSelectedTemplateId(null); // 与模板互斥
                }}
                className={`px-3 py-1.5 rounded-lg text-sm border transition-all flex items-center gap-1.5 ${
                  on
                    ? 'bg-emerald-600 text-white border-emerald-500 shadow-lg shadow-emerald-500/20'
                    : 'bg-slate-900/60 text-slate-400 border-slate-700 hover:border-slate-600'
                }`}
              >
                <span>{n.icon}</span>
                <span className="max-w-[140px] truncate">{n.name}</span>
              </button>
            );
          })}
        </div>
        {niche === null && !selectedTemplate && (
          <p className="text-xs text-amber-500/90">
            请选择赛道或封面模板后再生成文案；上传参考图时也会弹出快捷选择（赛道和模板互斥，只能选其一）。
          </p>
        )}
      </div>

      {/* 封面模板（可选·与赛道正交的第二层风格锁定） */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 font-mono uppercase tracking-wider">
            封面模板（可选）
          </span>
          {selectedTemplate && (
            <button
              type="button"
              onClick={() => setSelectedTemplateId(null)}
              className="text-[10px] text-slate-500 hover:text-rose-400 transition-colors"
            >
              清除模板
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {COVER_TEMPLATES.map((t) => {
            const on = selectedTemplateId === t.id;
            return (
              <button
                key={t.id}
                type="button"
                title={t.desc}
                onClick={() => {
                  setSelectedTemplateId(on ? null : t.id);
                  if (!on) setNiche(null); // 与赛道互斥
                }}
                className={`px-3 py-1.5 rounded-lg text-sm border transition-all flex items-center gap-1.5 ${
                  on
                    ? 'bg-amber-600 text-white border-amber-500 shadow-lg shadow-amber-500/20'
                    : 'bg-slate-900/60 text-slate-400 border-slate-700 hover:border-slate-600'
                }`}
              >
                <span>{t.icon}</span>
                <span className="max-w-[140px] truncate">{t.name}</span>
              </button>
            );
          })}
        </div>
        {selectedTemplate && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/90 flex items-start gap-2">
            <span className="shrink-0 mt-0.5">已锁定模板：</span>
            <span>
              <b className="text-amber-200">
                {selectedTemplate.icon} {selectedTemplate.name}
              </b>
              <span className="text-slate-400"> · 风格 DNA 已注入 → 生成文案 / 出图</span>
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-emerald-400 flex items-center gap-2">
            <span className="w-6 h-6 rounded bg-emerald-500/20 flex items-center justify-center text-xs text-emerald-300">
              1
            </span>
            参考图（可选，支持多张）
          </h2>
          <p className="text-xs text-slate-500">
            {profile?.refUploadHint ??
              '上传前可先选赛道；若尚未选择，上传成功后会弹出赛道选择。'}
          </p>
          <p className="text-xs text-slate-600">
            已选 {refPreviews.length} / {MAX_REFERENCE_IMAGES} 张 · 可多次选择累加 · 上传成功后会自动锁定参考（可点击按钮取消）
          </p>
          <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-700 rounded-xl p-8 cursor-pointer hover:border-emerald-500/40 transition-colors">
            <Upload className="w-8 h-8 text-slate-500 mb-2" />
            <span className="text-sm text-slate-400">点击选择一张或多张参考图</span>
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={onRefFiles}
            />
          </label>
          {refPreviews.length > 0 && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {refPreviews.map((item) => (
                  <div
                    key={item.id}
                    className="relative group rounded-lg border border-slate-800 bg-black/40 overflow-hidden aspect-video"
                  >
                    <img src={item.dataUrl} alt="" className="w-full h-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removeRefById(item.id)}
                      className="absolute top-1 right-1 p-1 rounded-md bg-black/70 text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-label="移除"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setRefLocked((v) => !v)}
                  className={`flex-1 min-w-[140px] py-2 rounded-lg text-sm font-medium border transition-colors ${
                    refLocked
                      ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-300'
                      : 'bg-slate-800 border-slate-700 text-slate-300'
                  }`}
                >
                  {refLocked ? '取消锁定（文案/生图暂不带参考图）' : '锁定参考（写入文案 + 生图多模态）'}
                </button>
                <button
                  type="button"
                  onClick={clearAllRefs}
                  className="py-2 px-3 rounded-lg text-sm border border-slate-700 text-slate-400 hover:bg-slate-800"
                >
                  清空全部
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-4 flex flex-col">
          <h2 className="text-sm font-semibold text-emerald-400 flex items-center gap-2">
            <span className="w-6 h-6 rounded bg-emerald-500/20 flex items-center justify-center text-xs text-emerald-300">
              2
            </span>
            核心观点（视频核心议题）
          </h2>
          <textarea
            value={coreTopic}
            onChange={(e) => setCoreTopic(e.target.value)}
            placeholder="例如：How the quiet presence of a dog can help rewire your nervous system..."
            className="flex-1 min-h-[220px] w-full bg-slate-950/80 border border-slate-800 rounded-lg p-4 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 resize-y"
          />
        </div>
      </div>

      <button
        type="button"
        disabled={loadingText || (niche === null && !selectedTemplateId)}
        onClick={runGenerateBundle}
        className="w-full py-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-sm shadow-lg shadow-emerald-900/30 flex items-center justify-center gap-2"
      >
        {loadingText ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <Sparkles className="w-5 h-5" />
        )}
        生成高转化文案与 A/B/C 矩阵指令
      </button>

      {bundle && (() => {
        const emptyCopy = [
          bundle.titles_warning,
          bundle.titles_anti_truth,
          bundle.titles_stop_doing,
          bundle.golden_description,
          bundle.seo_tags,
          bundle.visual_emotion_lock,
          bundle.target_phrase_badge,
          bundle.target_phrase_multi,
        ].filter((v) => !v || !v.trim()).length;
        if (emptyCopy < 5) return null;
        return (
          <button
            type="button"
            disabled={loadingText}
            onClick={() => runGenerateBundle(true)}
            className="w-full py-2.5 rounded-xl bg-amber-600/30 hover:bg-amber-600/50 border border-amber-500/40 disabled:opacity-50 text-amber-200 font-semibold text-sm flex items-center justify-center gap-2"
          >
            {loadingText ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            📝 补全标题 / SEO / 靶点文案（针对 VAR 单独生成）
          </button>
        );
      })()}

      {!bundle && rawOut && (
        <pre className="text-xs text-slate-500 whitespace-pre-wrap break-words max-h-48 overflow-y-auto border border-slate-800 rounded-lg p-3 bg-slate-950/60">
          {rawOut}
        </pre>
      )}

      {bundle && (
        <>
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-emerald-400 flex items-center gap-2">
              <span className="w-6 h-6 rounded bg-emerald-500/20 flex items-center justify-center text-xs text-emerald-300">
                3
              </span>
              SEO 标题库 &amp; 长尾标签库
            </h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 min-w-0">
              <div className="space-y-4 min-w-0">
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-2 relative">
                  <button
                    type="button"
                    onClick={() => copy('tw', live.titles_warning)}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400 z-10"
                  >
                    {copied === 'tw' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="text-xs text-slate-500 pr-10">THE WARNING</div>
                  <p className="text-sm text-slate-200 pr-10">{live.titles_warning}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-2 relative">
                  <button
                    type="button"
                    onClick={() => copy('tat', live.titles_anti_truth)}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400 z-10"
                  >
                    {copied === 'tat' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="text-xs text-slate-500 pr-10">THE ANTI-TRUTH</div>
                  <p className="text-sm text-slate-200 pr-10">{live.titles_anti_truth}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-2 relative">
                  <button
                    type="button"
                    onClick={() => copy('tsd', live.titles_stop_doing)}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400 z-10"
                  >
                    {copied === 'tsd' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="text-xs text-slate-500 pr-10">THE STOP DOING</div>
                  <p className="text-sm text-slate-200 pr-10">{live.titles_stop_doing}</p>
                </div>
                <div className="rounded-xl border border-emerald-900/40 bg-emerald-950/20 p-4 relative">
                  <button
                    type="button"
                    onClick={() => copy('gd', live.golden_description)}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400"
                  >
                    {copied === 'gd' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="text-xs text-emerald-500/80 mb-2">黄金两行描述</div>
                  <p className="text-sm text-slate-200 pr-10">{live.golden_description}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 relative min-w-0 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => copy('tags', formatSeoTagsForDisplay(live.seo_tags))}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400 z-10"
                  >
                    {copied === 'tags' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="text-xs text-slate-500 mb-2 pr-10">SEO 热门标签</div>
                  <p className="text-sm text-slate-300 break-words [overflow-wrap:anywhere] whitespace-pre-wrap pr-10 max-w-full">
                    {formatSeoTagsForDisplay(live.seo_tags)}
                  </p>
                </div>
              </div>
              <div className="space-y-4 min-w-0">
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                  <div className="text-xs text-slate-500 mb-2">系统锁定视觉情绪</div>
                  <p className="text-sm text-slate-200">{live.visual_emotion_lock}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 relative min-w-0">
                  <button
                    type="button"
                    onClick={() => copy('badge', live.target_phrase_badge)}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400"
                  >
                    {copied === 'badge' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="flex items-center gap-2 text-xs text-slate-500 mb-2 pr-10">
                    <Edit3 className="w-3 h-3" />
                    <span>一句话极限靶点（可编辑）</span>
                  </div>
                  <textarea
                    value={live.target_phrase_badge}
                    onChange={(e) =>
                      setEditedBundle((p) => ({
                        ...(p ?? bundle!),
                        target_phrase_badge: e.target.value,
                      }))
                    }
                    rows={1}
                    className="w-full text-lg font-bold bg-gradient-to-r from-pink-400 to-violet-400 text-transparent bg-clip-text tracking-tight break-words bg-transparent border border-transparent hover:border-slate-700 focus:border-pink-500/60 focus:outline-none rounded-md p-1 -m-1 pr-10 resize-none leading-snug transition-colors"
                  />
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 relative min-w-0">
                  <button
                    type="button"
                    onClick={() => copy('multi', live.target_phrase_multi)}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400 z-10"
                  >
                    {copied === 'multi' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="flex items-center gap-2 text-xs text-slate-500 mb-2 pr-10">
                    <Edit3 className="w-3 h-3" />
                    <span>多句极限靶点·2–3 句（可编辑 · SEO/长尾风格）</span>
                  </div>
                  <textarea
                    value={live.target_phrase_multi}
                    onChange={(e) =>
                      setEditedBundle((p) => ({
                        ...(p ?? bundle!),
                        target_phrase_multi: e.target.value,
                      }))
                    }
                    rows={3}
                    placeholder="（本批 JSON 未包含该字段，请点击上方「生成」重新拉取。）"
                    className="w-full text-sm font-semibold bg-gradient-to-r from-cyan-400 to-blue-400 text-transparent bg-clip-text bg-slate-950/60 border border-slate-800 hover:border-slate-700 focus:border-cyan-500/60 focus:outline-none rounded-md p-2 pr-10 leading-relaxed transition-colors overflow-hidden"
                    style={{ resize: 'none', overflow: 'hidden', minHeight: 'unset' }}
                    onInput={(e) => {
                      const el = e.currentTarget;
                      el.style.height = 'auto';
                      el.style.height = el.scrollHeight + 'px';
                    }}
                  />
                  <p className="text-[10px] text-slate-500 mt-2 pr-10">
                    提示：编辑后已实时同步到 VAR 提示词与出图；如需重新生成 VAR，请点「生成高转化文案」。
                  </p>
                </div>
                {(['var_a', 'var_b', 'var_c', 'var_d', 'var_e', 'var_f'] as const).map((k, i) => {
                  const labels = [
                    'VAR A · 场景构图',
                    'VAR B · 极简底',
                    'VAR C · 高反差特写',
                    'VAR D · 纵向分屏',
                    'VAR E · 信息图 / 数据牌',
                    'VAR F · 人像 + 大字横幅',
                  ];
                  const descs = [
                    '场景沉浸 / Sport-Scene / Hero-Intro',
                    '极简主色块 / 巨型字 / 角标',
                    '高反差人物 / 道具 / 面部特写',
                    '上下分屏：上半部主体画面，下半部数据牌',
                    '中央巨型数据 / 数字徽章 + 主体剪影',
                    '主角半身特写 + 姓名横幅 + 角标职位',
                  ];
                  const borders = [
                    'border-l-red-500',
                    'border-l-emerald-500',
                    'border-l-blue-500',
                    'border-l-purple-500',
                    'border-l-yellow-500',
                    'border-l-cyan-500',
                  ];
                  const label = labels[i];
                  const desc = descs[i];
                  const border = borders[i];
                  const val = live[k];
                  return (
                    <div
                      key={k}
                      className={`rounded-xl border border-slate-800 bg-slate-900/40 p-4 border-l-4 ${border} relative`}
                    >
                      <button
                        type="button"
                        onClick={() => copy(k, val)}
                        className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400 z-10"
                      >
                        {copied === k ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                      </button>
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-2 pr-10">
                        <Edit3 className="w-3 h-3" />
                        <span>{label}（可编辑）</span>
                      </div>
                      <div className="text-[10px] text-slate-600 mb-2 pr-10">{desc}</div>
                      <textarea
                        value={val}
                        onChange={(e) =>
                          setEditedBundle((p) => ({
                            ...(p ?? bundle!),
                            [k]: e.target.value,
                          }))
                        }
                        rows={6}
                        placeholder={`（${label.split(' · ')[1] || label} 提示词，点击上方「生成」）`}
                        className="w-full text-xs text-slate-300 bg-slate-950/60 border border-slate-800 hover:border-slate-700 focus:border-emerald-500/60 focus:outline-none rounded-md p-2 pr-10 resize-y leading-relaxed font-mono transition-colors placeholder:text-slate-600"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-emerald-400 flex items-center gap-2">
              <span className="w-6 h-6 rounded bg-emerald-500/20 flex items-center justify-center text-xs text-emerald-300">
                4
              </span>
              缩略图设计区
            </h2>
            {!canYunwuImage && (
              <p className="text-xs text-amber-500/90">
                当前 Key 非 Yunwu（sk-），无法直接出图；可复制 VAR 提示词到「一键成片」或其它工具。
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 shrink-0">绘图模型：</span>
                <select
                  value={coverImageModel}
                  onChange={(e) => setCoverImageModel(e.target.value as CoverImageModelId)}
                  className="bg-slate-900 border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 min-w-[160px]"
                >
                  {COVER_IMAGE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
                <span className="text-[10px] text-slate-600">
                  {COVER_IMAGE_MODELS.find((m) => m.id === coverImageModel)?.desc}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500 shrink-0">封面比例：</span>
              {COVER_ASPECT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setCoverAspect(opt.id)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                    coverAspect === opt.id
                      ? 'bg-emerald-600/30 border-emerald-500/60 text-emerald-200'
                      : 'bg-slate-900/80 border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:gap-3">
              <span className="text-xs text-slate-500 shrink-0">主文案来源：</span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setCoverHookSource('one')}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                    coverHookSource === 'one'
                      ? 'bg-emerald-600/30 border-emerald-500/60 text-emerald-200'
                      : 'bg-slate-900/80 border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  一句话极限靶点（默认）
                </button>
                <button
                  type="button"
                  disabled={!live.target_phrase_multi?.trim()}
                  onClick={() => setCoverHookSource('multi')}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    coverHookSource === 'multi'
                      ? 'bg-emerald-600/30 border-emerald-500/60 text-emerald-200'
                      : 'bg-slate-900/80 border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  多句极限靶点
                </button>
              </div>
              <p className="text-[11px] text-slate-600 w-full sm:w-auto sm:ml-1">
                中文赛道出图时画面汉字以繁体为准；与左侧靶点文案可不同字形但需同义。
              </p>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 min-w-0">
              <label className="text-xs text-slate-500 shrink-0 sm:pt-0.5" htmlFor="cover-style-preset">
                画面风格：
              </label>
              <select
                id="cover-style-preset"
                value={coverStyleId}
                onChange={(e) => setCoverStyleId(e.target.value)}
                className="flex-1 min-w-0 max-w-xl bg-slate-950/90 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
              >
                {COVER_STYLE_PRESETS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 min-w-0">
              {(
                [
                  { k: 'A' as const, title: '方案 A：场景沉浸', bar: 'bg-red-500' },
                  { k: 'B' as const, title: '方案 B：极简/单色底', bar: 'bg-emerald-400' },
                  { k: 'C' as const, title: '方案 C：高反差/特写', bar: 'bg-blue-500' },
                  { k: 'D' as const, title: '方案 D：纵向分屏', bar: 'bg-purple-500' },
                  { k: 'E' as const, title: '方案 E：信息图/数据牌', bar: 'bg-yellow-500' },
                  { k: 'F' as const, title: '方案 F：人像+横幅', bar: 'bg-cyan-500' },
                ] as const
              ).map(({ k, title, bar }) => {
                const ratioClass =
                  COVER_ASPECT_OPTIONS.find((o) => o.id === coverAspect)?.ratioClass ?? 'aspect-video';
                return (
                  <div
                    key={k}
                    className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden flex flex-col min-w-0"
                  >
                    <div className="p-3 flex items-center gap-2 border-b border-slate-800">
                      <span className={`w-1 h-5 rounded ${bar}`} />
                      <span className="text-sm text-slate-200 flex-1 truncate">{title}</span>
                    </div>
                    <div className="p-3 flex-1 flex flex-col gap-3">
                      <button
                        type="button"
                        disabled={!canYunwuImage || schemeLoading[k]}
                        onClick={() => runSchemeImage(k)}
                        className="w-full py-2 rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 text-sm hover:bg-emerald-600/30 disabled:opacity-40"
                      >
                        {schemeLoading[k] ? '生成中…' : '点击生成'}
                      </button>
                      <div
                        className={`${ratioClass} group relative w-full max-h-[min(420px,70vh)] rounded-lg bg-black/50 border border-slate-800 flex items-center justify-center overflow-hidden mx-auto`}
                      >
                        {schemeUrls[k] ? (
                          <>
                            <img src={schemeUrls[k]!} alt="" className="w-full h-full object-cover" />
                            <button
                              type="button"
                              onClick={() => void onDownloadScheme(k, schemeUrls[k]!)}
                              className="absolute bottom-2 right-2 z-10 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-black/80 text-white text-xs font-medium border border-slate-600 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity hover:bg-emerald-700/90 hover:border-emerald-500/60"
                            >
                              <Download className="w-3.5 h-3.5 shrink-0" />
                              下载
                            </button>
                          </>
                        ) : (
                          <span className="text-slate-600 text-sm flex flex-col items-center gap-2 px-2 text-center">
                            <ImageIcon className="w-8 h-8 opacity-40" />
                            待生成
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {nicheModalOpen && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/75"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cover-niche-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setNicheModalOpen(false);
          }}
        >
          <div
            className="max-w-lg w-full max-h-[85vh] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="cover-niche-modal-title" className="text-base font-semibold text-slate-100">
              请选择参考图对应的风格（赛道 / 模板 二选一）
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              不同垂类与不同模板的封面 DNA 不同；上传参考图后请先选定其中一个。
            </p>

            <div className="space-y-2">
              <div className="text-xs text-emerald-400/80">赛道（10 个）</div>
              <div className="flex flex-wrap gap-2">
                {COVER_NICHE_ORDER.map((id) => {
                  const n = NICHES[id];
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setNiche(id);
                        setSelectedTemplateId(null);
                        setNicheModalOpen(false);
                      }}
                      className="px-3 py-1.5 rounded-lg text-sm border border-slate-600 bg-slate-800/80 text-slate-200 hover:border-emerald-500/50 hover:bg-emerald-950/40 transition-colors flex items-center gap-1.5"
                    >
                      <span>{n.icon}</span>
                      <span className="max-w-[140px] truncate">{n.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs text-amber-400/80">封面模板（5 个）</div>
              <div className="flex flex-wrap gap-2">
                {COVER_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      setSelectedTemplateId(t.id);
                      setNiche(null);
                      setNicheModalOpen(false);
                    }}
                    className="px-3 py-1.5 rounded-lg text-sm border border-slate-600 bg-slate-800/80 text-slate-200 hover:border-amber-500/50 hover:bg-amber-950/30 transition-colors flex items-center gap-1.5"
                  >
                    <span>{t.icon}</span>
                    <span className="max-w-[140px] truncate">{t.name}</span>
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setNicheModalOpen(false)}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              稍后再选（可关闭弹窗后在上方手动选择）
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
