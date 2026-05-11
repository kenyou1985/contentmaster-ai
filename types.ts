
export enum NicheType {
  YI_JING_METAPHYSICS = 'YI_JING_METAPHYSICS',
  TCM_METAPHYSICS = 'TCM_METAPHYSICS',
  STORY_REVENGE = 'STORY_REVENGE',
  FINANCE_CRYPTO = 'FINANCE_CRYPTO',
  GENERAL_VIRAL = 'GENERAL_VIRAL',
  PSYCHOLOGY = 'PSYCHOLOGY',
  PHILOSOPHY_WISDOM = 'PHILOSOPHY_WISDOM',
  EMOTION_TABOO = 'EMOTION_TABOO',
  GREAT_POWER_GAME = 'GREAT_POWER_GAME',
  MINDFUL_PSYCHOLOGY = 'MINDFUL_PSYCHOLOGY'
}

export interface NicheConfig {
  id: NicheType;
  name: string;
  icon: string;
  description: string;
  systemInstruction: string;
  topicPromptTemplate: string;
  scriptPromptTemplate: string;
}

// TCM Sub-categories
export enum TcmSubModeId {
  TIME_TABOO = 'TIME_TABOO',
  KARMA_EROTIC = 'KARMA_EROTIC',
  FACE_READING = 'FACE_READING',
  FENG_SHUI = 'FENG_SHUI',
  TCM_DEBUNK = 'TCM_DEBUNK',
  DIET_HEALTH = 'DIET_HEALTH'
}

// Bo Yi / 格局博弈 子分类（替代旧的 Munger 体系）
// eslint-disable-next-line @typescript-eslint/no-redeclare
export enum FinanceSubModeId {
  GEOPOLITICAL_FLASH = 'GEOPOLITICAL_FLASH',  // 局势炸裂：地缘冲突·军事博弈
  CAPITAL_MARKETS = 'CAPITAL_MARKETS',        // 资本风暴：金融市场·经济暗战
  INVERSE_ANALYSIS = 'INVERSE_ANALYSIS',      // 逆向拆解：反主流·认知陷阱
  POWER_INSIDE = 'POWER_INSIDE',              // 权力内幕：政治权谋·决策博弈
  SURVIVAL_WISDOM = 'SURVIVAL_WISDOM'         // 破局智慧：普通人在博弈中自保
}

// Revenge Story Sub-categories
export enum RevengeSubModeId {
  CULTURAL_ORIGINAL = 'CULTURAL_ORIGINAL',
  ADAPTATION = 'ADAPTATION'
}

// News Commentary Sub-categories
export enum NewsSubModeId {
  GEO_POLITICS = 'GEO_POLITICS',
  GLOBAL_MARKETS = 'GLOBAL_MARKETS',
  TECH_INDUSTRY = 'TECH_INDUSTRY',
  SOCIAL_RISK = 'SOCIAL_RISK',
  GREAT_POWER_GAME = 'GREAT_POWER_GAME'
}

// Revenge Story Settings
export enum StoryLanguage {
  ENGLISH = 'English',
  CHINESE = 'Chinese',
  JAPANESE = 'Japanese',
  SPANISH = 'Spanish',
  HINDI = 'Hindi'
}

export enum StoryDuration {
  SHORT = 'SHORT', // 15-30 mins
  LONG = 'LONG'    // 1 hour+
}

// Generic SubMode Config Interface
export interface SubModeConfig {
  id: string; // TcmSubModeId | FinanceSubModeId | RevengeSubModeId
  title: string;
  subtitle: string;
  icon: any; 
  requiresInput: boolean; 
  optionalInput?: boolean;
  inputPlaceholder?: string;
  prompt: string;
  scriptPromptTemplate?: string;
  continuePromptTemplate?: string;
}

export interface Topic {
  id: string;
  title: string;
  selected: boolean;
}

export enum GenerationStatus {
  IDLE = 'IDLE',
  PLANNING = 'PLANNING',
  WRITING = 'WRITING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

export interface GeneratedContent {
  topic: string;
  content: string;
}

export enum ToolMode {
  REWRITE = 'REWRITE',
  EXPAND = 'EXPAND',
  SUMMARIZE = 'SUMMARIZE',
  POLISH = 'POLISH',
  SCRIPT = 'SCRIPT',
  CHANNEL = 'CHANNEL'
}

export type ApiProvider = 'yunwu' | 'google' | 'runninghub';
