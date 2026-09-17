/**
 * 英文同义词替换表（context-safe 单字替换）
 *
 * 设计原则（来自 StealthHumanizer postprocess.ts）：
 * 1. 只替换保留语义的词（同义）
 * 2. 跳过专有名词 / 缩写 / 全大写
 * 3. 保持首字母大小写
 * 4. 跳过引号内的内容
 */

export const SYNONYMS_EN: Record<string, string[]> = {
  // AI 高频词 → 自然同义
  utilize: ['use', 'work with', 'make use of'],
  leverage: ['use', 'take advantage of', 'build on'],
  facilitate: ['help', 'make easier', 'enable'],
  demonstrate: ['show', 'reveal', 'make clear'],
  illustrates: ['shows', 'reveals'],
  showcases: ['shows', 'highlights'],
  underscores: ['highlights', 'shows'],
  comprehensive: ['thorough', 'complete', 'full'],
  innovative: ['new', 'fresh', 'creative'],
  'cutting-edge': ['latest', 'modern', 'new'],
  'state-of-the-art': ['latest', 'most modern'],
  groundbreaking: ['new', 'major', 'important'],
  transformative: ['major', 'big', 'important'],
  unprecedented: ['new', 'unusual', 'rare'],
  seamless: ['smooth', 'easy', 'natural'],
  seamlessly: ['smoothly', 'easily'],
  streamline: ['simplify', 'speed up', 'improve'],
  robust: ['strong', 'solid', 'reliable'],
  synergy: ['cooperation', 'working together'],
  paradigm: ['model', 'pattern', 'approach'],
  holistic: ['complete', 'full', 'overall'],
  multifaceted: ['complex', 'many-sided', 'varied'],
  embark: ['start', 'begin', 'set out'],
  delve: ['explore', 'look at', 'dig into'],
  'a myriad of': ['many', 'lots of', 'countless'],
  'in conclusion': ['overall', 'so', 'in short'],
  'in summary': ['in short', 'overall', 'to sum up'],
  'to summarize': ['in short', 'overall'],
  furthermore: ['also', 'and', 'plus'],
  moreover: ['also', 'and', 'besides'],
  additionally: ['also', 'and', 'on top of that'],
  consequently: ['so', 'which means', 'as a result'],
  significantly: ['noticeably', 'clearly', 'quite a bit'],
  substantially: ['noticeably', 'clearly', 'quite a bit'],
  notably: ['especially', 'mainly'],
  particularly: ['especially', 'mainly', 'mostly'],
  essentially: ['basically', 'really', 'in essence'],
  fundamentally: ['basically', 'at its core'],
  ultimately: ['in the end', 'finally'],
  inherently: ['naturally', 'by its nature'],
  'plays a crucial role': ['is really important', 'matters a lot'],
  'plays an important role': ['matters', 'is important'],
  'plays a pivotal role': ['is central', 'is key'],
  'has the potential to': ['could', 'might', 'stands to'],
  'it is important to note': ['notably', 'worth noting', 'keep in mind'],
  'it is worth noting': ['worth noting', 'notably'],
  'it is worth mentioning': ['worth mentioning', 'also'],
  'it is evident that': ['clearly', 'obviously'],
  'it is clear that': ['clearly', 'obviously'],
  'in today\'s world': ['now', 'these days', 'right now'],
  'in the modern era': ['now', 'these days'],

  // ─── LLM 过度使用的高频内容词（rareWordBoost 用） ───
  // 改写后 LLM 经常一个段落里用 N 次同一个"安全"词，必须有同义选项
  very: ['extremely', 'incredibly', 'remarkably', 'awfully', 'terribly'],
  really: ['genuinely', 'truly', 'actually', 'honestly'],
  think: ['believe', 'reckon', 'figure', 'imagine'],
  know: ['understand', 'realize', 'see', 'recognize'],
  important: ['key', 'crucial', 'major', 'central', 'vital'],
  way: ['manner', 'approach', 'method', 'path'],
  thing: ['matter', 'item', 'point', 'detail'],
  kind: ['sort', 'type', 'variety', 'form'],
  make: ['create', 'produce', 'build', 'craft'],
  get: ['obtain', 'receive', 'gain', 'pick up'],
  big: ['large', 'major', 'huge', 'enormous'],
  good: ['great', 'solid', 'fine', 'decent'],
  bad: ['poor', 'rough', 'lousy', 'awful'],
  many: ['several', 'numerous', 'a bunch of', 'plenty of'],
  much: ['a great deal of', 'plenty of'],
  show: ['reveal', 'display', 'indicate'],
  help: ['assist', 'aid', 'support'],
  start: ['begin', 'kick off', 'commence'],
  end: ['finish', 'wrap up', 'conclude'],
  try: ['attempt', 'aim', 'work to'],
  use: ['employ', 'apply', 'utilize'], // 已有，但补一个更口语的
  need: ['require', 'demand'],
  seem: ['appear', 'feel'],
  come: ['arrive', 'reach'],
  go: ['head', 'move', 'travel'],
  see: ['spot', 'notice', 'observe'],
  say: ['state', 'note', 'mention'],
  tell: ['inform', 'let know'],
  actually: ['in fact', 'truth is', 'as it turns out'],
  probably: ['likely', 'most likely', 'presumably'],
  basically: ['essentially', 'fundamentally', 'at its core'],
  literally: ['genuinely', 'in fact'],
  definitely: ['certainly', 'surely', 'absolutely'],
  obviously: ['clearly', 'plainly'],
  exactly: ['precisely', 'just so'],
  especially: ['particularly', 'mainly'],
};

export const SYNONYMS_EN_PRESERVE_CASE: string[] = [
  'utilize',
  'leverage',
  'facilitate',
  'demonstrate',
  'comprehensive',
  'innovative',
  'seamless',
  'robust',
  'embark',
  'delve',
];

/** 保护名单：这些词即使在黑名单里也不要替换（语义敏感） */
export const SYNONYMS_EN_NEVER_REPLACE: Set<string> = new Set([
  // 专有名词/品牌（示例）
  'Apple',
  'Google',
  'Microsoft',
  'GitHub',
  // 单字符
  'a',
  'I',
  // 缩写
  'AI',
  'API',
  'URL',
  'LLM',
]);
