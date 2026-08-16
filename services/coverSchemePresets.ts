/**
 * 封面赛道 6 方案模板（A~F）
 *
 * 来源：components/CoverDesign.tsx 的 system / user 拼接（prompt 1:1）
 * 用途：
 *   - CopyBasedPanel 复用此 6 套方案生成封面（不再只有 3 套）
 *   - CoverDesign 复用 6 套 A~F 构图方向（保持行为一致）
 *
 * 每条方案对应 YouTube 高 CTR 缩略图的一种差异化构图方向：
 *   A：场景沉浸（全景 + 主体居中）
 *   B：极简/单色底（剪影 + 大字）
 *   C：高反差特写（紧贴 + 戏剧光）
 *   D：纵向分屏（上下分割）
 *   E：信息图/数据牌（中央巨型字牌 + 主体剪影）
 *   F：人像+大字横幅（半身特写 + 横幅）
 */

export interface CoverSchemeHint {
  /** 方案 ID（A/B/C/D/E/F） */
  id: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  /** 中文标签（方案名） */
  name: string;
  /** 英文标签（用于日志/UI） */
  label: string;
  /** emoji 前缀 */
  emoji: string;
  /** 该方案给 LLM 的构图方向（中文） */
  hint: string;
}

export const COVER_SCHEME_HINTS: CoverSchemeHint[] = [
  {
    id: 'A',
    name: '场景沉浸',
    label: 'VAR A · 场景沉浸',
    emoji: '🎬',
    hint: '场景沉浸：全景/中景展现宏大场景（比赛/事件/城市/战场/演播室等），主体居中或三分线居中，背景层次丰富；标题作为顶部或底部巨型横幅（最大字号 + 粗体 + 描边），占画面宽度 80%+。',
  },
  {
    id: 'B',
    name: '极简底',
    label: 'VAR B · 极简/单色底',
    emoji: '🎨',
    hint: '极简/单色底：纯净渐变背景（深蓝到深紫 / 深灰到深蓝 / 单色 +1 点缀色），主体三分线下移或一侧放置，巨型无衬线主标题单独占左下或底部 70% 画面宽度，副标题作为角落小亮点；杂志感、干净背景。',
  },
  {
    id: 'C',
    name: '高反差特写',
    label: 'VAR C · 高反差/特写',
    emoji: '🔥',
    hint: '高反差/特写：紧贴主体面部或上半身（占画面 75-85%），夸张表情或动作；主标题作为超大字号覆盖在主体身上（半透明黑底或无底），副标题在画面下方；箭头或红圈强调关键部位；硬边光、锐化颗粒、胶片质感。',
  },
  {
    id: 'D',
    name: '纵向分屏',
    label: 'VAR D · 纵向分屏',
    emoji: '📐',
    hint: '纵向分屏：上下分屏构图，上半部主体画面（人物特写/场景/数据），下半部数据牌/信息条/对比信息，中线光束或色带分割；上下结构对比清晰、信息密度高，适合议题性内容。',
  },
  {
    id: 'E',
    name: '信息图/数据牌',
    label: 'VAR E · 信息图/数据牌',
    emoji: '📊',
    hint: '信息图/数据牌风格：中央巨型数字/徽章/VS 对阵牌 + 主体剪影或头像特写；Hook 字横压顶部；四角贴角标（比分/排行/排名/年龄/数字）；整体像 ESPN/IMDb/商业信息图。',
  },
  {
    id: 'F',
    name: '人像+大字横幅',
    label: 'VAR F · 人像+大字横幅',
    emoji: '🏆',
    hint: '人像+大字横幅：主角半身或头像特写 + 巨型姓名/称呼横幅（底色荧光或印章感）；角标职位/节目名/期数；字体大写紧凑，海报式或演播室字体感；适合明星/专家/主讲人封面。',
  },
];

/**
 * 渲染「6 个差异化方案方向」给 LLM（用于 COPY_ANALYSIS_PROMPT 的 user 段拼接）
 */
export function renderSchemeHintsForLlm(): string {
  return COVER_SCHEME_HINTS.map(
    (s) =>
      `- 方案 ${s.id}（${s.name}）：${s.hint}`
  ).join('\n');
}

/**
 * 渲染「6 个差异化方案方向」给 LLM（system 段拼接，简短版）
 */
export function renderSchemeHintsShortForLlm(): string {
  return COVER_SCHEME_HINTS.map((s) => `${s.id} ${s.name}`).join(' / ');
}