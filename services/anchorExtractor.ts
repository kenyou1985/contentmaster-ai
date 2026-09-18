/**
 * 从全文（视频脚本/字幕/口播稿）中提取高 CTR 锚点。
 *
 * 设计目标：
 * 1. 单句锚点（target_phrase_badge 候选）
 *    - 8–30 字、信息密度高：包含人名/数字/动作/对比/反转/悬念
 *    - 不取关键词罗列、纯描述句、过长或过短句
 *
 * 2. 多句锚点（target_phrase_multi 候选）
 *    - 2–3 句、呈"背景→对比→悬念"节奏
 *    - 句间不重复（含主语/谓语重叠）
 *    - 总字数 ≤ 120
 *
 * 全部本地启发式（无网络/无 API），与 coreTopic 是否被 LLM 改写过无关。
 */

export interface ExtractedAnchors {
  /** 最佳单句锚点（如"30 年冤狱归来的复仇者") */
  one: string;
  /** 2–3 句多句锚点（按原文出现顺序，"\n" 分隔） */
  multi: string;
  /** 复仇故事长文案锚点（一段完整的复仇故事戏剧性铺垫） */
  revenge: string;
  /** 调试信息（每个候选句的得分） */
  _debug?: Array<{ sentence: string; score: number }>;
}

const ZH_SENT_SPLIT = /(?<=[。！？!?\n;；])|(?<=[\u4e00-\u9fff]{30,})(?=\s)/u;
const EN_SENT_SPLIT = /(?<=[.!?])\s+/u;

/** 中文动作词库（针对复仇/反转/暗战/爆料/权谋类高频词加权） */
const ACTION_WORDS =
  '杀|捅|暗刀|宣战|翻盘|逆袭|崩塌|陨落|背刺|翻脸|反水|倒戈|背叛|捅|捅穿|撕|撕开|打脸|封锁|围堵|制裁|决战|先开|抢先|对决|清算|摊牌|撕裂|崩盘|暴跌|屠|猎|追杀|灭门|血洗|清算|暗算|密谋|谋划|隐忍|出狱|归来|揭开|撕开|对簿公堂|翻案';

/** 情绪词库（仇/恨/冤/怒） */
const EMOTION_WORDS =
  '恨|仇|怨|怒|血|泪|寒|冷|孤|痛|悲|悔|苦|冤|屈|辱|虐|埋|逼|陷|坑|欺|瞒|骗|诈|辱|虐|砍|崩';

/** 反转/对比转折词库 */
const CONTRAST_WORDS =
  '却|然而|但是|可是|只是|不过|并非|并非|其实|实际上|真相是|原来是|没想到|万万没想到|意外|震惊';

/** 钩子关键词（与高 CTR 标题钩子一致） */
const HOOK_KEYWORDS =
  '真相|黑幕|内幕|秘密|罪证|证据|档案|案卷|陈年|尘封|30 年|十年|三年|半年|血债|冤狱|平反|复仇|归来|出击|清算';

/**
 * 把任意长文本切成句子数组，过滤掉太短/纯标点/纯空格。
 */
export function splitSentences(text: string, lang: 'zh' | 'en'): string[] {
  const t = (text || '').trim();
  if (!t) return [];
  const parts =
    lang === 'en'
      ? t.split(EN_SENT_SPLIT)
      : t.split(ZH_SENT_SPLIT);
  return parts
    .map((s) => s.replace(/^[\s，,、:：;；]+|[\s，,、:：;。.！!？?]+$/g, '').trim())
    .filter((s) => s.length >= (lang === 'en' ? 8 : 8));
}

/** 单句打分（满分约 25，命中率最高约 12–20） */
function scoreSentence(s: string, lang: 'zh' | 'en'): number {
  let score = 0;
  if (!s) return -Infinity;

  // 长度甜区：中文 12–28 字、英文 6–14 词。
  if (lang === 'zh') {
    if (s.length >= 12 && s.length <= 28) score += 6;
    else if (s.length > 28 && s.length <= 40) score += 3;
    else if (s.length > 40) score -= 1;
    else if (s.length < 10) score -= 2;
  } else {
    const wc = s.split(/\s+/).length;
    if (wc >= 6 && wc <= 14) score += 6;
    else if (wc > 14 && wc <= 22) score += 3;
    else if (wc > 22) score -= 1;
    else if (wc < 5) score -= 2;
  }

  if (lang === 'zh') {
    if (new RegExp(ACTION_WORDS).test(s)) score += 5;
    if (new RegExp(EMOTION_WORDS).test(s)) score += 4;
    if (new RegExp(CONTRAST_WORDS).test(s)) score += 3;
    if (new RegExp(HOOK_KEYWORDS).test(s)) score += 4;
    if (/\d/.test(s)) score += 3;
    if (/[？?！!]/.test(s)) score += 4;
    // 句首人名（2–4 字中文词 + 标点）
    if (/^[\u4e00-\u9fff]{2,4}[，,：:]/.test(s)) score += 3;
    // "X 后 / 归来 / 终于" 类信号
    if (/后|归来|终于|竟然|居然|首次|首次|首度|第一次/.test(s)) score += 2;
    // 反转句型："从 X 到 Y"
    if (/从[\u4e00-\u9fff]{2,8}到[\u4e00-\u9fff]{2,8}/.test(s)) score += 4;
    // "X：Y" 冒号结构（事实 + 评价）
    if (/[：:][^，,。；;]{2,}/.test(s)) score += 2;
  } else {
    if (/\?|!/.test(s)) score += 4;
    if (/\b(shocking|truth|revenge|betrayal|secret|never|hidden|blood|killer|exposed)\b/i.test(s)) score += 4;
    if (/\d/.test(s)) score += 3;
    if (/\b(years?|months?|days?|hours?)\b/i.test(s)) score += 3;
    if (/\b(finally|actually|turns out|in fact)\b/i.test(s)) score += 2;
  }

  // 负面信号：纯描述、模板套话
  if (/^(大家好|今天我们来|欢迎收看|本视频)/i.test(s)) score -= 8;
  if (/^(今天我们|大家好|欢迎来到)/i.test(s)) score -= 8;
  if (/(订阅|点赞|关注|点击下方|打开小铃铛)/i.test(s)) score -= 10;
  if (/(喜欢记得|别忘了|评论区)/i.test(s)) score -= 10;

  return score;
}

/** 两个句子是否有 ≥ 6 字（中文）或 ≥ 4 词（英文）的连续重叠（视为重复） */
function isNearDuplicate(a: string, b: string, lang: 'zh' | 'en'): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (lang === 'zh') {
    // 滑动窗口比对 6 字连续子串
    for (let i = 0; i <= a.length - 6; i++) {
      const sub = a.slice(i, i + 6);
      if (b.includes(sub)) return true;
    }
    // 主语重叠（前 6 字相同视为同主语）
    return a.slice(0, 6) === b.slice(0, 6);
  }
  const aw = a.toLowerCase().split(/\s+/);
  const bw = b.toLowerCase().split(/\s+/);
  for (let i = 0; i <= aw.length - 4; i++) {
    const sub = aw.slice(i, i + 4).join(' ');
    if (bw.join(' ').includes(sub)) return true;
  }
  return false;
}

/**
 * 提取复仇故事长文案：从全文中寻找戏剧性的复仇故事铺垫段落
 * 特征：包含"某人说X然后...我/他/她做了Y...等待这通电话/时机已到"等复仇叙事结构
 */
function extractRevengeStory(
  text: string,
  scored: Array<{ sentence: string; score: number }>,
  lang: 'zh' | 'en'
): string {
  // 复仇故事关键词模式（用于识别戏剧性复仇铺垫段落）
  const revengePatterns = lang === 'zh'
    ? [
        /[我他她]给?[他她我]打?[了个]?电话[，,]?[他她说 Dad|爹|父亲|爸][：:].{0,30}等?待?这?[通个]?电话/g,
        /[我他她]说?[：:][ Dad|爹|父亲|爸|先生|老板][：:].{0,50}时机[已到成熟准备就绪]/g,
        /[我他她]拨通了[电话][，][他她说].{0,50}[已到来了]/g,
        /[我他她]等待[这这一刻已很久了]/g,
        /[30三十]+[年岁]+[冤狱归来|牢狱归来|出狱]/g,
        /[他们她]以为[我他她].{0,30}[没想到|万万没想到]/g,
        /[他们她]不知道[我他她].{0,30}[已经|早就]/g,
      ]
    : [
        /I CALLED (MY |THE )?[A-Z][a-z]+(\.|,|"|\s).{0,100}(IT'S TIME|THE TIME|HAS COME|HE'S WAITING|SHE'S WAITING)/gi,
        /AFTER (THEY|SHE|HE|IT) LEFT, I CALLED.{0,100}(I'VE BEEN WAITING|THE TIME HAS COME)/gi,
        /WHEN (THEY|SHE|HE|IT) (HEARD|SAW|FOUND OUT).{0,100}(THEY DIDN'T KNOW|I HAD|HE HAD|SHE HAD).{0,100}(BUT WHAT THEY)/gi,
        /AFTER\s+\d+\s+(YEARS?|DAYS?|MONTHS?).{0,200}(HE'S BACK|SHE'S BACK|I'M BACK|REVENGE)/gi,
        /[A-Z][a-z]+\s+(THOUGHT|BELIEVED|KNEW).{0,50}(BUT|WHAT THEY DIDN'T).{0,50}(KNOW|REALIZE)/gi,
      ];

  for (const pattern of revengePatterns) {
    const match = text.match(pattern);
    if (match && match[0].length >= 50) {
      return match[0].trim();
    }
  }

  // 如果没有匹配到特定模式，尝试从高得分句子中构建复仇叙事
  // 找包含"等"、"时"、"后"等时间顺序词的戏剧性句子组合
  const dramaticSentences = scored
    .filter(({ sentence, score }) => {
      if (score < 2) return false;
      const timeWords = lang === 'zh'
        ? /[后时等当]/.test(sentence)
        : /(after|when|then|before|now|finally|what they didn't)/i.test(sentence);
      return timeWords;
    })
    .slice(0, 3);

  if (dramaticSentences.length >= 2) {
    // 按原文顺序重组
    const positions = dramaticSentences.map((s) => ({
      s: s.sentence,
      idx: text.indexOf(s.sentence),
    }));
    positions.sort((a, b) => a.idx - b.idx);
    return positions.map((p) => p.s).join(lang === 'zh' ? '。' : '. ');
  }

  return '';
}

/**
 * 从全文中提取单句 + 多句锚点。
 * @param text 完整视频脚本/口播稿/字幕
 */
export function extractAnchorsFromText(text: string): ExtractedAnchors {
  const trimmed = (text || '').trim();
  const debug: Array<{ sentence: string; score: number }> = [];
  if (!trimmed) return { one: '', multi: '', _debug: debug };

  // 检测语言（与 CoverDesign 中的 detectTopicLang 保持一致）
  const zh = (trimmed.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = (trimmed.match(/[a-zA-Z]/g) || []).length;
  const lang: 'zh' | 'en' = en > zh * 1.5 ? 'en' : 'zh';

  const sentences = splitSentences(trimmed, lang);
  if (!sentences.length) return { one: '', multi: '', _debug: debug };

  const scored = sentences.map((s) => {
    const sc = scoreSentence(s, lang);
    debug.push({ sentence: s, score: sc });
    return { sentence: s, score: sc };
  });

  // 按得分降序
  const sorted = scored.slice().sort((a, b) => b.score - a.score);

  // 单句：取最高分
  const bestOne = sorted[0]?.sentence.trim() || '';

  // 多句：取前 2–3 个不重复且得分非负的候选，按原文出现顺序排列
  const multiCandidates: string[] = [];
  for (const { sentence, score } of sorted) {
    if (score < 0) continue;
    if (multiCandidates.length >= 3) break;
    const dup = multiCandidates.some((m) => isNearDuplicate(m, sentence, lang));
    if (!dup) multiCandidates.push(sentence.trim());
  }
  // 重新按原文出现顺序排序，保证叙事节奏自然
  const positions = multiCandidates.map((s) => ({
    s,
    idx: trimmed.indexOf(s),
  }));
  positions.sort((a, b) => a.idx - b.idx);
  const bestMulti = positions.map((p) => p.s).join('\n');

  return {
    one: bestOne,
    multi: bestMulti,
    revenge: extractRevengeStory(trimmed, sorted, lang),
    _debug: debug.slice(0, 20),
  };
}
