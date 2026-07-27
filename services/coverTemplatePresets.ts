export interface CoverTemplatePreset {
  id: string;
  name: string;
  icon: string;
  /** 风格 DNA：颜色、构图、字体、情绪的整体方向 */
  styleDna: string;
  /** A 方案：场景沉浸 — 给模型的构图方向 */
  schemeAHint: string;
  /** B 方案：极简底 — 给模型的构图方向 */
  schemeBHint: string;
  /** C 方案：高反差特写 — 给模型的构图方向 */
  schemeCHint: string;
  /** D 方案：纵向分屏 — 给模型的构图方向 */
  schemeDHint: string;
  /** E 方案：信息图 / 数据牌 — 给模型的构图方向 */
  schemeEHint: string;
  /** F 方案：人像 + 大字横幅 — 给模型的构图方向 */
  schemeFHint: string;
  /** 模板说明文案 */
  desc: string;
}

/** 封面模板预设（与赛道正交，作为可选的第二层风格锁定） */
export const COVER_TEMPLATES: CoverTemplatePreset[] = [
  {
    id: 'soccer',
    name: '足球',
    icon: '⚽️',
    desc: '绿茵球场灯光、球员特写、比分条、激情解说风格',
    styleDna:
      '足球 / Football 向：墨绿草皮与夜场灯光对比色，球员射门/庆祝/拼抢特写，速度线与飞溅草屑，顶部比分条（比分+时间），球衣与俱乐部色彩鲜明，整体体育直播激情质感，避免卡通化。',
    schemeAHint:
      '比赛场景沉浸：球员庆祝瞬间或射门瞬间全景，背景为主队球迷看台，标题占上三分之一。',
    schemeBHint:
      '深绿底 + 球衣色块对撞 + 球员头像剪影 + 巨大比分条横向贯穿。',
    schemeCHint:
      '球员眼神/球鞋特写写实 + 荧光色字牌承载 Hook + 雷达速度感飞线。',
    schemeDHint:
      '上下纵向分屏：上半部实时比赛截图（球员+草坪），下半部比分条+球员数据牌（进球/助攻/跑动距离），中线用俱乐部色分割。',
    schemeEHint:
      '信息图风格：中央巨型「VS」对阵牌 + 两侧队徽 + 角标红黄牌、控球率柱状对比，标题横压顶部。',
    schemeFHint:
      '当家球星半身特写 + 大字姓名横幅（底色荧光）+ 角标球衣号+位置，整体 ESPN 演播室字体感。',
  },
  {
    id: 'basketball',
    name: '篮球公园',
    icon: '🏀',
    desc: '街头球场、紫金灯光、扣篮瞬间、嘻哈运动质感',
    styleDna:
      '篮球公园 / Streetball 向：城市街头球场、霓虹紫金灯、混凝土墙 + 涂鸦、扣篮/过人/拉杆瞬间质感，嘻哈与运动服饰混搭，暖橙与冷紫对撞，整体活力炸裂。',
    schemeAHint:
      '街头球场中景：球员突破或扣篮瞬间，背景涂鸦墙 + 霓虹街灯，标题占上三分之一。',
    schemeBHint:
      '深紫底 + 橙色大字 + 篮球火焰轨迹 + 球员剪影持球姿势。',
    schemeCHint:
      '篮球入框/手部特写 + 霓虹紫光晕 + 涂鸦字体承载 Hook。',
    schemeDHint:
      '上下分屏：上半部扣篮瞬间（球场+球员+篮筐），下半部涂鸦风格的数据牌（得分/助攻/篮板），中线霓虹光束。',
    schemeEHint:
      '信息图风格：中央计分板（比分+节次+剩余时间），两侧球员头像+球队 LOGO，Hook 字横压顶部。',
    schemeFHint:
      '当家球星持球半身 + 球衣号巨型字牌（涂鸦描边）+ 角落「ALL-STAR」「MVP」徽章贴。',
  },
  {
    id: 'sports_focus',
    name: '体育焦点',
    icon: '🎯',
    desc: '综合体育、深度评论、ESPN 演播室质感',
    styleDna:
      '体育焦点 / Sports Focus 向：ESPN 演播室深色蓝红配色、数据可视化面板、麦克风/耳机/解说员剪影、综合赛事快剪海报感，专业冷静富有权威，避免卡通与花哨。',
    schemeAHint:
      '演播室桌面：解说员半身剪影 + 身后多个赛事小窗 + 标题叠加。',
    schemeBHint:
      '深蓝黑底 + 红色高亮边 + 数据图表（柱状/折线）作底纹 + 粗壮无衬线大字。',
    schemeCHint:
      '麦克风特写 + 红色环形高光 + 体育话题关键词墙。',
    schemeDHint:
      '演播室分屏：上半部主持人半身，下半部赛事关键镜头+分数条，中线频道 LOGO 走带。',
    schemeEHint:
      '中央大数据雷达/折线面板 + 四周赛事小窗 + Hook 字横压顶部 + 「LIVE」红色角标闪烁。',
    schemeFHint:
      '评论员头像特写 + 大字姓名牌 + 角标节目名+期数，专业演播室字体（无衬线粗体）。',
  },
  {
    id: 'movie_ent',
    name: '娱乐电影',
    icon: '🎬',
    desc: '电影海报、IMDB 风格、明星特写、票房质感',
    styleDna:
      '娱乐电影 / Movie & Entertainment 向：电影海报式构图（IMDB / 漫威 / 诺兰风），明星特写与半身剪影、胶片颗粒、暗角与光束，戏剧化色彩（橙红+冷蓝或深紫+金），整体高质感娱乐大片感，避免综艺廉价感。',
    schemeAHint:
      '电影场景沉浸：明星特写 or 标志性场景全景，标题以电影海报字体置于底部条带。',
    schemeBHint:
      '黑底 + 顶/底条带 + 侧边明星半身剪影 + 巨大片名式 Hook。',
    schemeCHint:
      '明星眼神或道具特写 + 暗角 + 戏剧光束 + 红色高亮字牌。',
    schemeDHint:
      '电影海报式竖向分屏：上半部主形象（演员或场景），下半部片名大字条 + 排片/票房/IMDb 评分角标。',
    schemeEHint:
      '信息图风格：中央巨大「IMDb 9.2 ★」「票房破亿」字牌 + 上方明星剪影 + 角落档期/上映日角标。',
    schemeFHint:
      '演员半身特写 + 巨型姓名横幅（剧组字体）+ 角标角色名+导演署名，电影海报字体（大写、紧凑）。',
  },
  {
    id: 'science_mystery',
    name: '科普探秘',
    icon: '🔬',
    desc: '黑洞、显微镜、星空、宇宙探秘质感',
    styleDna:
      '科普探秘 / Science Mystery 向：深空深蓝/紫黑底、星系黑洞、星云光晕、显微镜/粒子轨迹、数据流与等高线，理性又带神秘感，避免低龄卡通与儿童风。',
    schemeAHint:
      '宇宙/微观场景沉浸：黑洞、星云、显微镜下细胞或粒子轨迹全景，标题占上三分之一。',
    schemeBHint:
      '深空黑紫底 + 等高线/数据流光束 + 巨大冷色 Hook 字 + 角落显微镜图标。',
    schemeCHint:
      '粒子/星云/瞳孔特写 + 荧光青/紫色光晕 + 银色字牌。',
    schemeDHint:
      '上下纵向分屏：上半部深空/显微镜画面，下半部数据面板（公式/年份/参数），中线等高线光束。',
    schemeEHint:
      '信息图风格：中央巨型公式/年份/数字 + 上方星系或粒子背景 + Hook 横压顶部 + 角标「SCIENCE」「UNEXPLAINED」徽章。',
    schemeFHint:
      '科学家/教授半身剪影（轮廓光）+ 巨型名字横幅（无衬线银白）+ 角标研究机构+职位，宇宙深空作底。',
  },
];

export function getCoverTemplate(id: string | null | undefined): CoverTemplatePreset | null {
  if (!id) return null;
  return COVER_TEMPLATES.find((t) => t.id === id) ?? null;
}
