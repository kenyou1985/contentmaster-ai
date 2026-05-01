import { NicheType } from '../types';

/** 与站内赛道下拉顺序一致（用于封面设计 Tab） */
export const COVER_NICHE_ORDER: NicheType[] = [
  NicheType.TCM_METAPHYSICS,
  NicheType.FINANCE_CRYPTO,
  NicheType.PSYCHOLOGY,
  NicheType.PHILOSOPHY_WISDOM,
  NicheType.EMOTION_TABOO,
  NicheType.STORY_REVENGE,
  NicheType.GENERAL_VIRAL,
  NicheType.YI_JING_METAPHYSICS,
  NicheType.RICH_MINDSET,
  NicheType.MINDFUL_PSYCHOLOGY,
];

export interface CoverNicheProfile {
  /** 注入 LLM：该赛道缩略图应有的整体美术与情绪 */
  styleDna: string;
  /** A 方案：场景沉浸 — 给模型的构图方向 */
  schemeAHint: string;
  /** B 方案：极简底 — 给模型的构图方向 */
  schemeBHint: string;
  /** C 方案：高反差特写 — 给模型的构图方向 */
  schemeCHint: string;
  /** 参考图区域说明文案 */
  refUploadHint: string;
}

const PROFILES: Record<NicheType, CoverNicheProfile> = {
  [NicheType.MINDFUL_PSYCHOLOGY]: {
    styleDna: `治愈心理学 / Mindful Paws 向：极简 2D 扁平矢量插画风，无脸或弱五官的治愈系角色，人类与「治愈小狗」常同框；粗黑描边、手绘卡通感、暖米色/奶油色或柔和粉绿背景；情绪从疲惫→被安抚；适合 YouTube 封面的大字号 Hook、可选粗红箭头/高亮框强调一句英文 Hook；整体干净、温暖、非写实照片。`,
    schemeAHint:
      '客厅或沙发场景：人物与狗安静同框，全景/中景，留白放巨大 Hook 字，可加红色箭头指向情绪焦点。',
    schemeBHint:
      '白或浅灰纯色底：手轻抚狗头或狗脸特写轮廓，极简扁平图标感，粗体无衬线大字 + 锐利红色高亮条。',
    schemeCHint:
      '高反差特写：人物盘坐地面或狗眼情绪特写，亮黄色/荧光色文字牌承载 Hook，强对比光影，漫画式强调线。',
    refUploadHint:
      '可上传 1 张或多张人物/宠物/风格参考图；锁定后文案与「点击生成」缩略图均会融合多张参考的造型与配色（扁平插画风一致）。',
  },
  [NicheType.TCM_METAPHYSICS]: {
    styleDna:
      '中医玄学 / 倪师向：宣纸肌理、水墨晕染、朱砂点缀、太极/经络线稿作底纹；**融入身着素雅中式长衫的中医老者形象**，庄重沉稳，避免卡通卖萌；封面像讲座海报。',
    schemeAHint: '诊室书房场景：中医老者侧影+古籍书架背景，中景，标题占上三分之一。',
    schemeBHint: '浅麻色底：中医老者剪影+单枚印章图形，极简对称。',
    schemeCHint: '高对比：深色底金色字，中医老者手执毛笔特写，光束聚焦。',
    refUploadHint: '可上传讲师形象或品牌主色参考；提示词注明传统中式医疗美学、禁止低龄卡通。',
  },
  [NicheType.FINANCE_CRYPTO]: {
    styleDna:
      '金融投资 / **查理·芒格**向：深蓝或炭黑底、细网格或K线虚化背景、少量高亮绿/红；**融入年迈智者戴细框眼镜、手握书本的形象**，专业冷静、数据感，避免花哨插画。',
    schemeAHint: '书房场景：芒格式智者坐于书架前，手握书本，窗外K线若隐若现。',
    schemeBHint: '纯色底 + 巨大数字/百分比符号 + 智者剪影侧脸特写。',
    schemeCHint: '特写眼睛或握拳手势叠在波动曲线上，强侧光，警示感。',
    refUploadHint: '可上传品牌Logo色板；提示词强调财经媒体级排版。',
  },
  [NicheType.PSYCHOLOGY]: {
    styleDna:
      '暗黑/清醒心理学向：霓虹暗房、高噪点、单强光源、剪影人脸或裂隙意象；**融入知性女性心理专家形象**，神秘、略带压迫但克制。',
    schemeAHint: '心理咨询室一角，知性女性背影立于窗前，霓虹光影投射，标题荧光色。',
    schemeBHint: '纯黑底 + 一句质问式大字 + 女性心理专家剪影特写。',
    schemeCHint: '眼部极端特写，红蓝双色光，电影海报比例。',
    refUploadHint: '可上传主色参考；提示词强调心理惊悚纪录片风而非卡通。',
  },
  [NicheType.PHILOSOPHY_WISDOM]: {
    styleDna:
      '哲学智慧 / 禅意向：低饱和青灰、雾、远山、莲、留白；**融入古装东方智者形象**，静谧、抽象、文字为主。',
    schemeAHint: '山水极简层叠 + 东方智者古装剪影立于山巅，小舟或云雾点缀。',
    schemeBHint: '大面积留白 + 居中一句金句 + 智者侧影小图标。',
    schemeCHint: '明暗对半构图，撕裂雾中的光，象征顿悟瞬间。',
    refUploadHint: '可上传水墨参考；提示词强调东方极简与留白。',
  },
  [NicheType.EMOTION_TABOO]: {
    styleDna:
      '情感禁忌向：烛光、雨窗、剪影、深红与藏青；**融入时尚都市男女身影**，亲密但禁忌感，避免低俗直给。',
    schemeAHint: '室内烛光双人距离感构图，都市男女身影若隐若现，标题弱化在角落。',
    schemeBHint: '单色深红底 + 白字一句禁忌Hook + 烛光剪影小图标。',
    schemeCHint: '雨中车窗模糊外景 + 都市男女手特写，高情绪对比。',
    refUploadHint: '可上传色调参考；提示词强调电影剧照感、成人向情绪片。',
  },
  [NicheType.STORY_REVENGE]: {
    styleDna:
      '复仇故事向：黑红配色、雨夜、刀锋/火焰隐喻、粗衬线标题；**融入冷峻复仇者身影**，戏剧张力、叙事片预告。',
    schemeAHint: '雨夜街道，复仇者背影或侧影立于街角，电影宽画幅。',
    schemeBHint: '黑底血红十字线或断裂符号 + 复仇宣言大字。',
    schemeCHint: '复仇者半脸阴影分割，眼神特写，高噪点。',
    refUploadHint: '可上传反派/主角剪影参考；提示词强调暗黑剧情片缩略图。',
  },
  [NicheType.GENERAL_VIRAL]: {
    styleDna:
      '新闻热点向：头条大字、红黄警示条、地球/新闻演播室虚化；**融入专业新闻主播身影**，紧迫、可信、像breaking news。',
    schemeAHint: '新闻分屏或地图底 + 新闻主播剪影 + 滚动条元素。',
    schemeBHint: '红黄条 + 超大黑体标题 + 新闻主播侧影图标（火焰/地球）。',
    schemeCHint: '地图热点特写 + 箭头 + 倒计时数字感。',
    refUploadHint: '可上传频道角标颜色；提示词强调新闻台包装。',
  },
  [NicheType.YI_JING_METAPHYSICS]: {
    styleDna:
      '易经命理 / 曾仕强向：棕金、祥云、八卦线稿、书卷；**融入手持折扇的命理大师身影**，亲民讲座感，避免阴森恐怖。',
    schemeAHint: '讲台与八卦背景，命理大师温和身影，标题稳重。',
    schemeBHint: '浅金底深褐字 + 大师手持罗盘特写 + 单卦符号居中。',
    schemeCHint: '太极阴阳高对比分割 + 手掐指一算剪影。',
    refUploadHint: '可上传中式纹样参考；提示词强调传统文化讲座封面。',
  },
  [NicheType.RICH_MINDSET]: {
    styleDna:
      '富人思维 / **马云**向：黑金、城市天际线虚化、聚光灯；**融入成功企业家的自信身影**，成功学但不油腻，留白大气。',
    schemeAHint: '演讲台聚光 + 马云式企业家侧影 + 城市夜景虚化 + 金句标题。',
    schemeBHint: '黑底金边大字 + 极简钻石或阶梯符号 + 企业家剪影。',
    schemeCHint: '侧脸剪影 + 金色轮廓光 + 反问句Hook。',
    refUploadHint: '可上传黑金配色参考；提示词强调商业演讲缩略图。',
  },
};

export function getCoverNicheProfile(niche: NicheType): CoverNicheProfile {
  return PROFILES[niche];
}

/** 封面 JSON 流式请求里，参考图前的英文锚定说明（避免非治愈赛道被「人+狗」模板污染） */
export function getCoverReferenceMultimodalPreamble(niche: NicheType): string {
  if (niche === NicheType.MINDFUL_PSYCHOLOGY) {
    return (
      'The following reference images are in order: Image 1, Image 2, ... Study exact identity — human (hair, face shape, clothing colors/cut), dog or pet if visible (breed silhouette, fur pattern, markings, ear shape), and flat-art style. ' +
      'You MUST reflect these in the JSON var_*_prompt_en fields with concrete visual detail. Do not invent generic substitutes.'
    );
  }
  return (
    'The following reference images are in order: Image 1, Image 2, ... Observe ONLY what is actually visible: people, clothing, props, environment, symbolic objects, and animals ONLY if they clearly appear in the images. Note palette, line style, and composition. ' +
    'Your JSON var_*_prompt_en must faithfully describe THESE visible subjects and this art direction. ' +
    'CRITICAL: Do NOT add a dog, pet, or any animal that is not clearly present in the references. Do NOT import visual tropes from unrelated YouTube niches.'
  );
}
