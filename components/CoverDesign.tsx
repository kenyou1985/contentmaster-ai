import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ApiProvider } from '../types';
import { streamContentGeneration } from '../services/geminiService';
import { generateImage } from '../services/yunwuService';
import { COVER_STYLE_PRESETS } from '../services/coverStylePresets';
import { useToast } from './Toast';
import { Copy, Check, Loader2, Upload, Sparkles, Image as ImageIcon, X, Download, Edit3 } from 'lucide-react';

const MAX_REFERENCE_IMAGES = 12;

/** 封面绘图模型配置 */
type CoverImageModelId = 'gemini-flash' | 'gpt-image-2' | 'gpt-image-2-c';
const COVER_IMAGE_MODELS: {
  id: CoverImageModelId;
  name: string;
  desc: string;
}[] = [
  {
    id: 'gemini-flash',
    name: 'Gemini 3.1 Flash（默认）',
    desc: 'gemini-3.1-flash-image-preview，备用 gpt-image-2-c:stable → grok-imagine-image-pro',
  },
  {
    id: 'gpt-image-2',
    name: 'GPT Image 2（默认）',
    desc: 'gpt-image-2，失败自动回退 gpt-image-2-c:stable → grok-imagine-image-pro',
  },
  {
    id: 'gpt-image-2-c',
    name: 'GPT Image 2（/edits）',
    desc: 'gpt-image-2-c:stable，失败回退 gemini-3.1-flash → grok-imagine-image-pro',
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
  /** 方案 G 长文案/复仇海报模版 — 用户提到加的第七种封面方案 */
  var_g: string;
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

    // 检测无效的 JSON 响应（如 {"status":"ok"} 或 {"message":"..."}）
    const jsonKeys = Object.keys(r);
    const hasOnlyStatusOrMessage = jsonKeys.length <= 2 &&
      (jsonKeys.includes('status') || jsonKeys.includes('message') || jsonKeys.includes('error'));
    if (hasOnlyStatusOrMessage) {
      // 这种 JSON 不是我们需要的，继续尝试其他候选
      continue;
    }

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
    const NUM_MAP: Record<string, string> = { a: '1', b: '2', c: '3', d: '4', e: '5', f: '6', g: '7' };
    const directVar = (suffix: 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g') => {
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
      g: directVar('g'),
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
      var_g: vars_.g || '',
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

  const [coreTopic, setCoreTopic] = useState('');
  const [refPreviews, setRefPreviews] = useState<RefImageItem[]>([]);
  const [refLocked, setRefLocked] = useState(false);
  const [rawOut, setRawOut] = useState('');
  const [bundle, setBundle] = useState<CoverBundle | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const [schemeUrls, setSchemeUrls] = useState<Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', string | null>>({
    A: null,
    B: null,
    C: null,
    D: null,
    E: null,
    F: null,
    G: null,
  });
  const [schemeLoading, setSchemeLoading] = useState<Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', boolean>>({
    A: false,
    B: false,
    C: false,
    D: false,
    E: false,
    F: false,
    G: false,
  });
  const [copied, setCopied] = useState<string | null>(null);
  const [coverAspect, setCoverAspect] = useState<CoverAspectId>('16:9');
  const [coverStyleId, setCoverStyleId] = useState<string>('realistic');
  const [coverImageModel, setCoverImageModel] = useState<CoverImageModelId>('gpt-image-2');
  /** 用户手动勾选的方案（默认全选 7 个；空时不允许生成） */
  const [enabledSchemes, setEnabledSchemes] = useState<Set<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'>>(
    () => new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
  );
  const toggleScheme = (k: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G') => {
    setEnabledSchemes((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };
  /** 用户编辑后的 bundle（用户对靶点文案等的修改；优先于 bundle 渲染） */
  const [editedBundle, setEditedBundle] = useState<CoverBundle | null>(null);
  /** bundle 更新时同步初始化 editedBundle */
  useEffect(() => {
    setEditedBundle(bundle);
  }, [bundle]);
  /** 渲染使用的活跃 bundle：用户编辑优先 */
  const live = editedBundle ?? bundle;

  /** 与 refPreviews 同步，避免在 setState updater 里启动异步（Strict Mode 会双次调用 updater 导致重复追加） */
  const refPreviewsRef = useRef<RefImageItem[]>([]);
  useEffect(() => {
    refPreviewsRef.current = refPreviews;
  }, [refPreviews]);

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

  const buildPrompts = useCallback((copyOnly = false, effectiveTopic = '') => {
    const lang = detectTopicLang(effectiveTopic || coreTopic);

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
        ? '【画面内文字·最高优先级】七条 var_*_prompt_en 用英文撰写（供文生图模型阅读），每条都必须包含明确指令：画面上所有可见文字（主标题、副标、角标、装饰字等）必须为**英文 ALL-CAPS**，不得出现任何中文字符或其它外文（用户原文专有名词除外）。'
        : '【画面内文字·最高优先级】七条 var_*_prompt_en 用英文撰写（供文生图模型阅读），每条都必须包含明确指令：画面上所有可见中文（主标题、副标、角标、印章字、小字等）须为**繁体中文（Traditional Chinese）**字形呈现；语义可与 target_phrase_badge / target_phrase_multi 的简体草稿一致，但字形须繁体；不得出现英文或其它外文（用户明确给出的品牌拉丁缩写除外）。';

    const hookRule =
      `【一句话靶点】须填写 target_phrase_badge（单句极限 Hook）。\n【多句靶点】须填写 target_phrase_multi：共 2–3 句，风格参考本页「SEO 标题库 & 长尾标签库」：信息密度高，可含数字、禁忌/悬念、身份指向、结果承诺、搜索长尾组合；与 target_phrase_badge 同一主题但分层展开，供封面副标题/条带/小字使用。\n【主标题铁律】七条 var_*_prompt_en 须把 target_phrase_badge 的语义做成画面最醒目、最大字号主标题；若构图需要副文案，可融入 target_phrase_multi 中的句子且不矛盾。\n【方案 G 长文案铁律】**严禁将方案 G 写成方案 A 那样的震惊悬念单行标题！** var_g_prompt_en 必须是"复仇/反转故事卡片海报"——9:16 竖屏，画面上半部 5–9 行 ALL-CAPS 英文长文案（**完整的故事情节叙述，采用"第一视角叙事 + 对话引用 + 悬念结尾"的复仇故事卡片结构**，严禁只写一行标题），故事示例：①"WHEN MY HUSBAND & M.I.L HEARD THE DOCTOR SAY..." ②"THEY LAUGHED: \"YOU'RE NOT IMPORTANT...\"" ③"AFTER THEY LEFT, I PICKED UP MY PHONE..." ④"HE SAID: \"I'VE BEEN WAITING FOR THIS CALL.\""；底部 1/4 处暗红/纯黑实色横条压一句全新续写悬念（不超过 12 词）。`;

    const refSystemNote =
      refLocked && refPreviews.length > 0
        ? `\n\n⚠️ 参考图已锁定（${refPreviews.length} 张）：var_*_prompt_en 须忠实描述参考图中实际出现的人物、服饰、道具、场景与画风；禁止编造图中不存在的动物（尤其禁止无故加入狗/宠物），禁止混入其它赛道的代表元素。`
        : '';

    /** 用户实际勾选的方案列表（用于告诉模型哪些方案是"必出"的） */
    const enabledList = Array.from(enabledSchemes).join('、');
    const system = `你是 YouTube 高转化缩略图与标题总监。

【关键·必读】你的任务是输出**严格的 JSON 对象**，**仅此而已**：
- 不要输出任何解释、问候、提问、礼貌性回复
- 不要输出 "Sure"、"Here is"、"How can I help"、"I cannot" 等开场白
- 不要输出 Markdown 代码块（如 \`\`\`json）
- **直接以 { 字符开头**，**直接以 } 字符结尾**

JSON 的键必须**恰好 16 个**（字符串值）：titles_warning, titles_anti_truth, titles_stop_doing, golden_description, seo_tags, visual_emotion_lock, target_phrase_badge, target_phrase_multi, var_a_prompt_en, var_b_prompt_en, var_c_prompt_en, var_d_prompt_en, var_e_prompt_en, var_f_prompt_en, var_g_prompt_en。
【禁止漏字段、禁止合并、禁止省略 var_*_prompt_en 的 a/b/c/d/e/f/g 后缀。】如果只输出 var_prompt_en 这种单字段视为格式错误。
titles_* 为「60 字内极简标题」风格的三类：THE WARNING / THE ANTI-TRUTH / THE STOP DOING（各一条，${lang === 'en' ? '英文' : '中文'}）。
golden_description 为黄金两行视频简介。${seoTagsRule}
visual_emotion_lock 描述画面情绪弧线。target_phrase_badge 为封面一句话极限靶点（${lang === 'en' ? '英文 Hook 短语' : '中文单句 Hook，可简体'}）。target_phrase_multi 为 2–3 句多句靶点（${lang === 'en' ? '英文' : '中文'}），写法参考爆款 SEO 标题与长尾标签组合。
var_a/b/c_prompt_en 对应 A/B/C 三个差异化构图方向，var_d_prompt_en 对应 D（纵向分屏），var_e_prompt_en 对应 E（信息图 / 数据牌），var_f_prompt_en 对应 F（人像/主角 + 大字横幅），var_g_prompt_en 对应 G（长文案 / 复仇故事海报模版）。每条 80–180 词，用英文撰写（供文生图），须包含：构图、光线、配色、字体排版、点击率元素（箭头/高亮框等）。
【关键·必须 7 条全部输出】每个 var_*_prompt_en 必须独立写出，绝不允许：
- 用 "var_prompt_en" / "var_a_prompt_en" 这种无后缀或合并字段
- 只输出 1 条或 2 条然后省略剩余
- 7 条内容必须彼此差异（A 与 B 不能只是调色版本）
否则前端会判定格式错误并丢弃本次输出。

【用户已勾选的方案（必出）】：${enabledList}
- 用户只勾选了上述方案，前端会按勾选列表分别请求单方案 prompt
- 即便如此，JSON 中所有 16 个字段都必须输出完整内容（**包括用户未勾选的方案**也要有合理的占位 prompt）
- 未勾选的方案：可使用通用极简构图占位（与勾选方案的渲染风格统一，但不要与勾选方案的 prompt 内容雷同）

【角色动态识别硬规则·所有 var_*_prompt_en 通用】主角的**性别 / 年龄 / 体型 / 气质 / 服饰**必须**严格从「核心议题」与文案内容中识别并匹配**，禁止锁定为某个性别或某类身材：
- 文案主角是成年女性 → 用符合该女性设定的描述（必要时可加 voluptuous / curvy / hourglass / sensual 等词，但必须与人物身份/气质一致，**不可强加与设定不符的色情化标签**）
- 文案主角是成年男性 → 用符合该男性设定的描述（strong jawline / tailored suit / cold stare 等）
- 文案主角是少年 / 老人 / 动物 / 非人实体 → 必须按设定如实描述
- **绝对禁止**把任何主角描述成儿童、可爱卡通、Q 版娃娃或性感化的儿童式形象（任何性别都不允许）
${hookRule}
${imageTextRule}
${refSystemNote}
${langRule}

【再次强调】第一个字符必须是 {，最后一个字符必须是 }。不要有任何其他字符在 JSON 对象之外。`;

    const user = `## 7 个差异化方案方向（写入对应 var_*_prompt_en）
- 方案 A（场景沉浸）：场景沉浸：全景/中景展现宏大场景（比赛/事件/城市/战场/演播室等），主体居中或三分线居中，背景层次丰富；标题作为顶部或底部巨型横幅（最大字号 + 粗体 + 描边），占画面宽度 80%+。
- 方案 B（极简底）：极简/单色底：纯净渐变背景（深蓝到深紫 / 深灰到深蓝 / 单色 +1 点缀色），主体三分线下移或一侧放置，巨型无衬线主标题单独占左下或底部 70% 画面宽度，副标题作为角落小亮点；杂志感、干净背景。
- 方案 C（高反差特写）：高反差/特写：紧贴主体面部或上半身（占画面 75-85%），夸张表情或动作；主标题作为超大字号覆盖在主体身上（半透明黑底或无底），副标题在画面下方；箭头或红圈强调关键部位；硬边光、锐化颗粒、胶片质感。
- 方案 D（纵向分屏）：上下分屏：上半部主体画面（人物特写/场景/数据），下半部数据牌/信息条/对比信息，中线光束或色带分割；上下结构对比清晰、信息密度高，适合议题性内容。
- 方案 E（信息图 / 数据牌）：信息图风格：中央巨型数据 / 数字 / 徽章 + 主体剪影 + Hook 字横压顶部。
- 方案 F（人像 + 大字横幅）：主角半身特写 + 巨型姓名/称呼横幅 + 角标职位/节目名。
- 方案 G（长文案 / 复仇故事海报）：9:16 竖屏长文案海报：**严禁生成震惊悬念/单行标题式的封面，必须是完整的复仇/反转故事卡片**。画面上半部排版 5–9 行 ALL-CAPS 英文长文案（**这才是方案 G 的核心 —— 必须是完整的复仇/反转故事叙述，采用"第一视角叙事 + 对话引用 + 悬念结尾"的复仇故事卡片结构**，严禁只写一行标题或像方案 A 那样的"震惊悬念"式封面！），故事结构示例：①开场"WHEN MY HUSBAND & M.I.L HEARD..." ②冲突"THEY LAUGHED: \"YOU\'RE NOT IMPORTANT...\"" ③反转"AFTER THEY LEFT, I PICKED UP MY PHONE..." ④悬念"HE SAID: \"I\'VE BEEN WAITING FOR THIS CALL.\""），每行 4–10 词，关键人名与动作动词用亮黄色（#FFD400）或暗血红（#B91C1C）高亮、其余白色，对话引用用英文双引号包裹；画面下半部主角半身特写（主角性别/年龄/气质由核心议题动态识别，禁止锁定某个性别），单束顶光或侧逆光；文案末行下方加斜切的暗血红或纯黑实色条带写故事型续写钩子；底部 1/4 处一条暗红或纯黑实色横条压一句全新续写悬念（如"THE ENDING WAS INCREDIBLY SATISFYING."）；暗角 + 胶片颗粒；整体 Reddit/TikTok 复仇故事卡片海报质感。

## 核心议题 / 文案（视频在讲什么）
${effectiveTopic ? effectiveTopic : '（未填写）请自行根据输入文案生成一个高 CTR 占位主题，整段 prompt 仍要严格输出 JSON，禁止在 JSON 之外补充任何提示文字。'}

## 语言（文案类字段）
${langRule}

请严格输出 JSON，每个 var_*_prompt_en 必须明确按其方案（A~G）的构图写，不能只是色调变体。`;

    if (copyOnly) {
      // 简化模式：只生成 8 个文案字段（不要写 var_*_prompt_en）
      const zhHookRule = `【靶点 Hook·硬性结构铁律】
target_phrase_badge（封面主标题·一句话极限靶点）：
- **必须是完整句子**，必须有主谓宾结构，**严禁输出关键词罗列/名词堆砌/用顿号/逗号/空格隔开的词组**！
- 6–20 字，单句，**至少含 1 个动词或 1 个问号/感叹号**（如"暗刀"、"捅刀"、"开战"、"锁定"等具体动作词）
- 必须从核心议题「${effectiveTopic || coreTopic}」的具体事件/争议/反转中提炼，**禁止脱离议题**
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
      const copyOnlySystem = `You are a YouTube copy & SEO director.

【关键·必读】你的任务是输出**严格的 JSON 对象**，**仅此而已**：
- 不要输出任何解释、问候、提问、礼貌性回复
- 不要输出 "Sure"、"Here is"、"How can I help"、"I cannot" 等开场白
- 不要输出 Markdown 代码块（如 \`\`\`json）
- **直接以 { 字符开头**，**直接以 } 字符结尾**
- JSON 必须包含**恰好 8 个键**：titles_warning, titles_anti_truth, titles_stop_doing, golden_description, seo_tags, visual_emotion_lock, target_phrase_badge, target_phrase_multi
- 字段顺序不限，但所有 8 个键必须存在

${lang === 'en' ? enHookRule : zhHookRule}
${lang === 'en' ? 'All copy fields in English.' : '文案字段用简体中文；seo_tags 用中文词组标签。'}

【再次强调】第一个字符必须是 {，最后一个字符必须是 }。不要有任何其他字符在 JSON 对象之外。`;

      const copyOnlyUser = `## 核心议题 / 文案（视频在讲什么）
${effectiveTopic || coreTopic}

记住：直接输出 JSON 对象，不要任何前言或后记。**不要输出 var_*_prompt_en 字段**。`;

      return { system: copyOnlySystem, user: copyOnlyUser };
    }

    return { system, user };
  }, [coreTopic, refLocked, refPreviews.length, enabledSchemes]);

  const runGenerateBundle = async (copyOnly = false) => {
    if (!apiKey.trim()) {
      toast.error('请先配置 API Key');
      return;
    }
    if (!coreTopic.trim()) {
      toast.error('请先填写文案输入框');
      return;
    }
    if (enabledSchemes.size < 1) {
      toast.error('请至少勾选 1 个方案（A~G）');
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

    // 直接以用户输入的文案作为核心议题（去掉全文输入 + 锚点提取链路）
    const effectiveTopic = coreTopic.trim();

    const { system, user } = buildPrompts(copyOnly, effectiveTopic);
    const refForJson =
      refLocked && refPreviews.length > 0
        ? refPreviews.map((x) => x.dataUrl)
        : undefined;
    const baseOpts = {
      temperature: copyOnly ? 0.6 : 0.7,
      referenceDataUrls: refForJson,
      referenceMultimodalPreamble: refForJson?.length
        ? 'The following reference images are in order: Image 1, Image 2, ... Observe ONLY what is actually visible: people, clothing, props, environment, symbolic objects, and animals ONLY if they clearly appear in the images. Note palette, line style, and composition. Your JSON var_*_prompt_en must faithfully describe THESE visible subjects and this art direction. CRITICAL: Do NOT add a dog, pet, or any animal that is not clearly present in the references. Do NOT import visual tropes from unrelated YouTube niches.'
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

    /**
     * JSON 流（带重试）：强制模型输出严格 JSON，解析失败时自动重试
     * 最多重试 5 次，每次重试会自动追加"必须输出严格 JSON"提示
     */
    const retryStreamJSON = async (
      sys: string,
      usr: string,
      maxTokens = 4096,
      maxRetries = 5
    ): Promise<string> => {
      const isValidJSONWithFields = (text: string): { valid: boolean; filledFields: number; totalFields: number } => {
        const t = text.trim();
        if (!t || t.length < 20) return { valid: false, filledFields: 0, totalFields: 0 };
        // 排除礼貌性回复
        const lower = t.toLowerCase();
        if (lower.startsWith('how can i help') || lower.startsWith('i cannot') || lower.startsWith('i\'m sorry') || lower.startsWith('sure') || lower.startsWith('hello') || lower.startsWith('以下') || lower.startsWith('here') || lower.startsWith('抱歉')) {
          return { valid: false, filledFields: 0, totalFields: 0 };
        }
        // 必须包含 JSON 起始和结束标记
        const s = t.indexOf('{');
        const e = t.lastIndexOf('}');
        if (s === -1 || e <= s) return { valid: false, filledFields: 0, totalFields: 0 };
        try {
          const parsed = JSON.parse(t.slice(s, e + 1));
          // 检测无效的 JSON 响应
          const keys = Object.keys(parsed);
          const hasOnlyStatusOrMessage = keys.length <= 2 &&
            (keys.includes('status') || keys.includes('message') || keys.includes('error'));
          if (hasOnlyStatusOrMessage) return { valid: false, filledFields: 0, totalFields: 0 };

          // 计算有内容的字段数量
          const requiredFields = ['titles_warning', 'titles_anti_truth', 'titles_stop_doing', 'golden_description', 'seo_tags', 'visual_emotion_lock', 'target_phrase_badge', 'target_phrase_multi'];
          let filledFields = 0;
          for (const field of requiredFields) {
            const value = parsed[field];
            if (value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)) {
              filledFields++;
            }
          }

          // 至少需要 4 个字段有内容才认为有效
          return { valid: filledFields >= 4, filledFields, totalFields: requiredFields.length };
        } catch {
          return { valid: false, filledFields: 0, totalFields: 0 };
        }
      };

      let acc = '';
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const retryHint = attempt > 0
            ? `\n\n【重要·这是第 ${attempt + 1} 次重试】你必须输出一个包含以下字段的**完整 JSON 对象**，每个字段都必须有**具体内容**（不能是空字符串或空数组）：\n- titles_warning: 警告类标题（具体文字）\n- titles_anti_truth: 反转真相类标题（具体文字）\n- titles_stop_doing: 停止做某事的标题（具体文字）\n- golden_description: 黄金两行描述（具体文字）\n- seo_tags: SEO 标签数组（具体标签）\n- visual_emotion_lock: 视觉情绪描述（具体文字）\n- target_phrase_badge: 一句话极限靶点（具体文字）\n- target_phrase_multi: 多句极限靶点（具体文字）\n**所有字段必须有内容，禁止空值！**`
            : '';
          const userPrompt = `${usr}${retryHint}`;
          const systemPrompt = attempt === 0
            ? sys
            : `${sys}\n\n【强制要求】你必须**严格**输出 JSON，**禁止**任何前言、解释、Markdown 代码块、礼貌性回复。你的输出必须以 { 开始，以 } 结束。**所有 8 个字段必须有具体内容，禁止空值！**`;
          await streamContentGeneration(
            userPrompt,
            systemPrompt,
            (chunk) => {
              acc += chunk;
              setRawOut((prev) => prev + chunk);
            },
            undefined,
            { ...baseOpts, temperature: 0.5, maxTokens }
          );
        } catch (err: any) {
          console.error(`[CoverDesign] JSON 流第 ${attempt + 1} 次失败:`, err?.message || err);
          if (attempt < maxRetries - 1) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          return acc;
        }

        const result = isValidJSONWithFields(acc);
        if (result.valid) {
          if (attempt > 0) {
            console.log(`[CoverDesign] JSON 流在第 ${attempt + 1} 次重试后成功（${result.filledFields}/${result.totalFields} 字段有内容）`);
          }
          return acc;
        }
        console.warn(`[CoverDesign] JSON 流第 ${attempt + 1} 次无效（${result.filledFields}/${result.totalFields} 字段有内容），内容:`, acc.slice(0, 300));
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      return acc;
    };

    try {
      // ========== copyOnly 模式：直接单次请求 8 字段 JSON ==========
      if (copyOnly) {
        const acc = await retryStreamJSON(system, user, 4096, 3);
        const parsed = parseCoverBundle(acc, effectiveTopic || coreTopic);

        // 不使用本地兜底，只保留 LLM 返回的内容
        if (!parsed) {
          console.error('[CoverDesign] copyOnly 解析失败。原始输出:', acc);
          toast.error('AI 返回格式异常，请重试');
          setLoadingText(false);
          return;
        }

        // 只保留 LLM 返回的文案内容
        const merged = {
          ...(existing || {}),
          titles_warning: parsed.titles_warning || '',
          titles_anti_truth: parsed.titles_anti_truth || '',
          titles_stop_doing: parsed.titles_stop_doing || '',
          golden_description: parsed.golden_description || '',
          seo_tags: parsed.seo_tags || '',
          visual_emotion_lock: parsed.visual_emotion_lock || '',
          target_phrase_badge: (parsed.target_phrase_badge && isSentenceLike(parsed.target_phrase_badge))
            ? parsed.target_phrase_badge
            : '',
          target_phrase_multi: (parsed.target_phrase_multi && isSentenceLike(parsed.target_phrase_multi))
            ? parsed.target_phrase_multi
            : '',
        };
        setBundle(merged);
        const filledCopy = [
          merged.titles_warning, merged.titles_anti_truth, merged.titles_stop_doing,
          merged.golden_description, merged.seo_tags, merged.visual_emotion_lock,
          merged.target_phrase_badge, merged.target_phrase_multi,
        ].filter(Boolean).length;
        if (filledCopy >= 4) {
          toast.success('文案已补全');
        } else {
          toast.warning(`文案字段不完整（${filledCopy}/8），请手动补充`);
        }
        return;
      }

      // ========== 完整模式：分阶段生成 ==========
      // Step 1：用户勾选的 N 个 var 并行请求（每个独立 prompt，不要求 JSON，只输出纯文本）
      const allSchemeKeys: Array<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'> = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
      const schemeKeys = allSchemeKeys.filter((k) => enabledSchemes.has(k));
      setRawOut(`▶ Step 1/2：并行生成 ${schemeKeys.length} 个 VAR 提示词（${Array.from(schemeKeys).join('/')}）...\n\n`);
      const { system: varSystem, user: varUser } = buildPrompts(false, effectiveTopic);
      const varResults = await Promise.all(
        schemeKeys.map(async (key) => {
          const otherKeys = schemeKeys.filter((k) => k !== key);
          const singleSystem = `${varSystem}\n\n【本次唯一任务】只输出方案 ${key} 的一段 80–180 词英文文生图 prompt。\n- 禁止 JSON、禁止 Markdown 代码块、禁止前言后记。\n- 直接输出纯英文段落，不要再写方案 ${otherKeys.join('/')} 的内容。`;
          const singleUser = `${varUser}\n\n【聚焦方案 ${key}】请只输出方案 ${key} 的英文 prompt 段落，不要重复方案方向列表。`;
          const text = await safeStream(singleSystem, singleUser, 1024);
          return { key, text: text.trim() };
        })
      );

      // 检查是否有足够的 VAR 结果
      const successfulVars = varResults.filter(r => r.text.length > 0);
      if (successfulVars.length < 1) {
        toast.error(`VAR 生成失败（${successfulVars.length}/${schemeKeys.length} 个成功），请重试`);
        setLoadingText(false);
        return;
      }

      // 把 varResults 按 key 映射到 vars 对象（保留未勾选的方案原值，勾选的方案覆盖）
      const vars: Record<'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g', string> = {
        a: existing?.var_a || '',
        b: existing?.var_b || '',
        c: existing?.var_c || '',
        d: existing?.var_d || '',
        e: existing?.var_e || '',
        f: existing?.var_f || '',
        g: existing?.var_g || '',
      };
      for (const r of varResults) {
        vars[r.key.toLowerCase() as 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g'] = r.text;
      }

      // Step 2：单次请求 8 个文案字段（强制 JSON，带重试）
      setRawOut((prev) => prev + '\n\n▶ Step 2/2：生成文案 / SEO / 靶点...\n\n');
      const { system: copySystem, user: copyUser } = buildPrompts(true, effectiveTopic);
      const copyAcc = await retryStreamJSON(copySystem, copyUser, 4096, 3);
      const copyParsed = parseCoverBundle(copyAcc, effectiveTopic || coreTopic);

      // 不使用本地兜底
      if (!copyParsed) {
        console.error('[CoverDesign] 文案解析失败。原始输出:', copyAcc);
        toast.error('AI 返回格式异常，请重试');
        setLoadingText(false);
        return;
      }

      const bundleOut: CoverBundle = {
        titles_warning: copyParsed.titles_warning || '',
        titles_anti_truth: copyParsed.titles_anti_truth || '',
        titles_stop_doing: copyParsed.titles_stop_doing || '',
        golden_description: copyParsed.golden_description || '',
        seo_tags: copyParsed.seo_tags || '',
        visual_emotion_lock: copyParsed.visual_emotion_lock || '',
        target_phrase_badge: (copyParsed.target_phrase_badge && isSentenceLike(copyParsed.target_phrase_badge))
          ? copyParsed.target_phrase_badge
          : '',
        target_phrase_multi: (copyParsed.target_phrase_multi && isSentenceLike(copyParsed.target_phrase_multi))
          ? copyParsed.target_phrase_multi
          : '',
        var_a: vars.a,
        var_b: vars.b,
        var_c: vars.c,
        var_d: vars.d,
        var_e: vars.e,
        var_f: vars.f,
        var_g: vars.g,
      };
      setBundle(bundleOut);

      const filledCopy = [
        bundleOut.titles_warning, bundleOut.titles_anti_truth, bundleOut.titles_stop_doing,
        bundleOut.golden_description, bundleOut.seo_tags, bundleOut.visual_emotion_lock,
        bundleOut.target_phrase_badge, bundleOut.target_phrase_multi,
      ].filter(Boolean).length;
      if (filledCopy >= 4) {
        toast.success(`文案 + ${schemeKeys.length} 个方案提示词已生成（${Array.from(schemeKeys).join('/')}）`);
      } else {
        toast.warning(`文案字段不完整（${filledCopy}/8），请手动补充`);
      }
    } catch (err: any) {
      console.error('[CoverDesign] runGenerateBundle 异常:', err);
      toast.error(err?.message || '生成失败');
    } finally {
      setLoadingText(false);
    }
  };
  const runSchemeImage = async (key: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G') => {
    if (!canYunwuImage) {
      toast.error('缩略图生成需 Yunwu（sk-）Key，请在设置中配置');
      return;
    }
    const varKey = (`var_${key.toLowerCase()}` as 'var_a' | 'var_b' | 'var_c' | 'var_d' | 'var_e' | 'var_f' | 'var_g');
    const prompt = live[varKey];
    if (!prompt?.trim()) {
      toast.error(`请先生成 ${key} 指令（点击上方「生成高转化文案」）`);
      return;
    }
    /** 优先用用户编辑后的靶点文案（实时同步） */
    const liveBadge = (editedBundle?.target_phrase_badge ?? bundle?.target_phrase_badge ?? '').trim();
    const aspectOpt =
      COVER_ASPECT_OPTIONS.find((o) => o.id === coverAspect) ?? COVER_ASPECT_OPTIONS[0];
    const topicLang = detectTopicLang(coreTopic);
    const imageTextEnforcement =
      topicLang === 'zh'
        ? '\n\nMandatory: all Chinese characters on the thumbnail (titles, subtitles, stamps, badges) must be in Traditional Chinese (繁體中文) script only; no simplified Chinese forms. No English except user-provided proper nouns if any.'
        : '\n\nMandatory: all on-image text must be English only; no Chinese or other scripts on the thumbnail.';
    const hookEnforcement = liveBadge
      ? `\n\nThe largest, most dominant title text on the thumbnail must express this hook meaning: "${liveBadge}".`
      : '';
    /** 方案 G 默认推荐 9:16（竖屏长文案海报更易铺多行字），但仍允许用户在 UI 切换 */
    const effectiveAspectId: CoverAspectId = key === 'G' && coverAspect === '16:9' ? '9:16' : coverAspect;
    const effectiveAspectOpt =
      COVER_ASPECT_OPTIONS.find((o) => o.id === effectiveAspectId) ?? aspectOpt;
    if (key === 'G' && coverAspect === '16:9') {
      toast('方案 G 已自动切到 9:16 竖屏，更适合长文案海报', { icon: 'ℹ️' });
    }
    const stylePreset =
      COVER_STYLE_PRESETS.find((s) => s.id === coverStyleId) ??
      COVER_STYLE_PRESETS.find((s) => s.id === 'minimal_flat')!;
    const styleEnforcement = `\n\nVisual style preset (must match): ${stylePreset.promptEn}`;

    setSchemeLoading((m) => ({ ...m, [key]: true }));
    try {
      const modelMap: Record<CoverImageModelId, string> = {
        'gemini-flash': 'cover-gemini-flash',
        'gpt-image-2': 'gpt-image-2',
        'gpt-image-2-c': 'gpt-image-2-c',
      };
      const res = await generateImage(apiKey, {
        model: modelMap[coverImageModel],
        prompt: `${prompt}\n\nYouTube thumbnail, ${effectiveAspectOpt.id} aspect ratio, bold readable main title, high CTR composition.${styleEnforcement}${hookEnforcement}${imageTextEnforcement}`,
        size: effectiveAspectOpt.size,
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

  const onDownloadScheme = async (key: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', src: string) => {
    try {
      await downloadCoverImage(src, `cover-scheme-${key}-${coverAspect}-${Date.now()}.png`);
      toast.success('已开始下载');
    } catch {
      toast.error('下载失败，可右键图片另存为');
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-8 text-center">
      <p className="text-slate-400 text-sm">
        封面功能已迁移至「文案成片」页面的「AI 一键成片」Tab。
        <br />
        请前往「原创」标签页使用文案成片与封面生成功能。
      </p>
    </div>
  );
};