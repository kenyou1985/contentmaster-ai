/**
 * 赛道人物配置
 * 每个赛道对应一个核心人物角色，用于动画分镜中的图片提示词
 * 人物会融入到各个场景中，不需要每个分镜都出现，但适当出现能增强代入感
 */

import { NicheType } from '../types';

export interface NicheCharacterProfile {
  /** 赛道名称 */
  nicheName: string;
  /** 核心人物名称 */
  characterName: string;
  /** 人物描述（用于图片提示词） */
  characterDescription: string;
  /** 角色定位说明 */
  roleDescription: string;
  /** 视觉风格 */
  visualStyle: string;
  /** 出现频率建议 */
  frequencySuggestion: string;
}

/** 各赛道核心人物配置 */
export const NICHE_CHARACTER_PROFILES: Record<NicheType, NicheCharacterProfile> = {
  [NicheType.TCM_METAPHYSICS]: {
    nicheName: '中医玄学',
    characterName: '倪海厦',
    characterDescription: '身着素雅中式长衫的中医老者，手执毛笔或翻阅古籍，神情深邃睿智，常立于古朴书房或讲堂之中',
    roleDescription: '以倪海厦医师形象出现，作为讲述者的引路人与良师，在关键转折点或引用古籍理论时适当现身，约30%镜头融入',
    visualStyle: '水墨古风、宣纸肌理、朱砂点缀、古籍书卷、墨色晕染，庄重沉稳如讲座海报',
    frequencySuggestion: '每3-5个分镜出现1次，约30%镜头融入，在关键转折点或引用古籍理论时出现'
  },

  [NicheType.FINANCE_CRYPTO]: {
    nicheName: '金融投资',
    characterName: '查理·芒格',
    characterDescription: '年迈智者，银色短发戴细框眼镜，西装革履或休闲针织衫，表情沉稳内敛，常手握书本或咖啡杯沉思',
    roleDescription: '以巴菲特搭档查理·芒格为原型，象征价值投资与跨学科思维',
    visualStyle: '深蓝炭黑底、K线网格背景、专业冷静的财经媒体感',
    frequencySuggestion: '每4-6个分镜出现1次，在讲解投资原则或引用智慧时出现'
  },

  [NicheType.PSYCHOLOGY]: {
    nicheName: '心理学',
    characterName: '心理专家',
    characterDescription: '知性女性，短发或挽髻，穿着考究的深色西装外套，眼神洞察人心，表情温和但犀利',
    roleDescription: '以专业心理咨询师形象出现，作为讲述者的导师或引路人',
    visualStyle: '霓虹暗房、高噪点、单强光源、神秘略带压迫但克制',
    frequencySuggestion: '每4-6个分镜出现1次，在讲解心理学概念或分析案例时出现'
  },

  [NicheType.PHILOSOPHY_WISDOM]: {
    nicheName: '哲学智慧',
    characterName: '东方智者',
    characterDescription: '古装智者，宽袍大袖，须发皆白，立于山水之间或茅屋之中，神态超然物外',
    roleDescription: '以道家/儒家先贤为形象，代表东方哲学智慧',
    visualStyle: '低饱和青灰、水墨晕染、雾中山水、莲、极简留白',
    frequencySuggestion: '每6-8个分镜出现1次，在总结哲理或升华主题时出现'
  },

  [NicheType.EMOTION_TABOO]: {
    nicheName: '情感禁忌',
    characterName: '都市男女',
    characterDescription: '时尚都市男女，穿着考究，神情复杂微妙，在烛光或雨夜中若隐若现',
    roleDescription: '代表都市情感中的复杂人性，不做道德评判',
    visualStyle: '烛光、雨窗、剪影、深红与藏青色调，亲密但禁忌',
    frequencySuggestion: '每5-7个分镜出现1次，在情感转折或高潮时出现'
  },

  [NicheType.STORY_REVENGE]: {
    nicheName: '复仇故事',
    characterName: '复仇者',
    characterDescription: '冷峻面孔，半隐于暗影中，眼神坚毅果决，穿着黑色系服装，气场强大',
    roleDescription: '代表被伤害后选择反击的主人公',
    visualStyle: '黑红配色、雨夜、刀锋/火焰隐喻、粗衬线标题',
    frequencySuggestion: '每4-6个分镜出现1次，在故事高潮或关键抉择时出现'
  },

  [NicheType.GENERAL_VIRAL]: {
    nicheName: '新闻热点',
    characterName: '新闻主播',
    characterDescription: '专业新闻主播形象，穿着正式，妆容精致，表情严肃认真',
    roleDescription: '代表客观中立的新闻视角',
    visualStyle: '头条大字、红黄警示条、地球/新闻演播室虚化',
    frequencySuggestion: '每5-8个分镜出现1次，在新闻分析或数据展示时出现'
  },

  [NicheType.YI_JING_METAPHYSICS]: {
    nicheName: '易经命理',
    characterName: '命理大师',
    characterDescription: '中式长衫老者或中年人，手持折扇或罗盘，面相堂堂，气质沉稳，通晓易经八卦',
    roleDescription: '以曾仕强等大师为形象，代表传统命理智慧',
    visualStyle: '棕金底、祥云、八卦线稿、书卷，亲民讲座感',
    frequencySuggestion: '每5-7个分镜出现1次，在引用易经理论或命理分析时出现'
  },

  [NicheType.RICH_MINDSET]: {
    nicheName: '富人思维',
    characterName: '马云',
    characterDescription: '成功企业家形象，穿着简约商务装，面带自信微笑，站姿挺拔，气场强大且亲和',
    roleDescription: '以马云为原型，代表中国创业者和富人思维',
    visualStyle: '黑金配色、城市天际线虚化、聚光灯，成功学但不油腻',
    frequencySuggestion: '每4-6个分镜出现1次，在分享创业经验或商业智慧时出现'
  },

  [NicheType.MINDFUL_PSYCHOLOGY]: {
    nicheName: '治愈心理学',
    characterName: '讲述者与小狗',
    characterDescription: '温暖的人类与治愈系小狗（无具体品种要求）同框，画面温馨和谐',
    roleDescription: '保持现有治愈风格不变，小狗作为情感寄托',
    visualStyle: '极简2D扁平矢量插画、手绘卡通感、暖米色/奶油色背景',
    frequencySuggestion: '每3-5个分镜出现1次，保持治愈温馨感'
  }
};

/**
 * 生成赛道专属的图片提示词前缀
 */
export function getNicheImagePromptPrefix(niche: NicheType): string {
  const profile = NICHE_CHARACTER_PROFILES[niche];
  return profile.characterDescription;
}

/**
 * 生成赛道专属的角色信息（用于分镜输出的角色信息部分）
 */
export function getNicheCharacterInfo(niche: NicheType): {
  name: string;
  alias: string;
  description: string;
} {
  const profile = NICHE_CHARACTER_PROFILES[niche];
  return {
    name: profile.characterName,
    alias: profile.characterName,
    description: profile.characterDescription
  };
}

/**
 * 生成赛道专属场景描述
 */
export function getNicheSceneDescription(niche: NicheType): string {
  const profile = NICHE_CHARACTER_PROFILES[niche];
  return profile.visualStyle;
}
