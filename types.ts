
export enum NicheType {
  TCM_METAPHYSICS = 'TCM_METAPHYSICS',
  STORY_REVENGE = 'STORY_REVENGE',
  FINANCE_CRYPTO = 'FINANCE_CRYPTO',
  GENERAL_VIRAL = 'GENERAL_VIRAL'
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

// Finance (Munger) Sub-categories
export enum FinanceSubModeId {
  MACRO_WARNING = 'MACRO_WARNING',
  COGNITIVE_BIAS = 'COGNITIVE_BIAS',
  INVERSE_THINKING = 'INVERSE_THINKING',
  MOAT_VALUE = 'MOAT_VALUE',
  LIFE_WISDOM = 'LIFE_WISDOM'
}

// Revenge Story Sub-categories
export enum RevengeSubModeId {
  CULTURAL_ORIGINAL = 'CULTURAL_ORIGINAL',
  ADAPTATION = 'ADAPTATION'
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
  POLISH = 'POLISH'
}

export type ApiProvider = 'yunwu' | 'google';
