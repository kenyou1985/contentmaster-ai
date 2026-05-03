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
    characterName: '大师',
    characterDescription: '中年男士，精瘦体型，台湾口音，面容清癯，目光锐利有神，常戴细框眼镜，身着深色中山装或素色长衫，手执毛笔或翻阅古籍，神态严厉而睿智，立于古朴诊室或书房之中',
    roleDescription: '以大师形象出现，作为讲述者的引路人与良师，须在至少3个分镜中出现（开场引入、中间关键转折、结尾总结），以正侧脸、局部特写、诊室侧影等形式融入；其余分镜以场景、氛围、情绪意境为主',
    visualStyle: '水墨古风、宣纸肌理、墨色晕染、朱砂点缀、古籍书卷、诊室药柜、老式台灯；整体色调沉稳克制，以深墨、中灰、赭石为主；画面以环境氛围为主，人物占比约30%',
    frequencySuggestion: '至少3个分镜必须出现（开场、中段关键转折、结尾），其余分镜以场景环境和情绪意境为主；人物可采用正侧脸、局部特写、诊室侧影等抽象形式出现'
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
    characterName: '大师',
    characterDescription: '中式长衫老者或中年人，手持折扇或罗盘，面相堂堂，气质沉稳，通晓易经八卦',
    roleDescription: '以曾仕强等大师为形象，代表传统命理智慧，须在至少3个分镜中出现（开场引入、中段转折、结尾总结），其余分镜以场景氛围和情绪意境为主',
    visualStyle: '棕金底、祥云、八卦线稿、书卷、水墨古风、宣纸肌理；整体沉稳克制，以深墨、赭石、棕金为主；人物占比≤30%',
    frequencySuggestion: '至少3个分镜必须出现（开场、中段转折、结尾），其余分镜以场景环境和情绪意境为主；人物可采用正侧脸、局部特写、书房侧影等抽象形式出现'
  },

  [NicheType.GREAT_POWER_GAME]: {
    nicheName: '大国博弈',
    characterName: '博弈 Bo Yi',
    characterDescription: '前军方/情报高官形象，深色西装，表情冷峻，目光如炬，站姿沉稳，自带不怒自威的威慑气场',
    roleDescription: '以博弈为原型，代表大国博弈内幕分析者，前国家安全系统官员',
    visualStyle: '深色冷峻配色、战略地图背景、棋盘暗纹，地图与数据可视化元素穿插',
    frequencySuggestion: '每3-5个分镜出现1次，在揭露内幕、分析博弈逻辑、揭示被掩盖真相时出现'
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
