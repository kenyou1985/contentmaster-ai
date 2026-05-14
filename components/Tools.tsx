import React, { useState, useRef } from 'react';
import { ToolMode, NicheType, ApiProvider } from '../types';
import { NICHES, SCRIPT_MODE_SYSTEM } from '../constants';
import {
  streamContentGeneration,
  initializeGemini,
  type StreamContentOptions,
} from '../services/geminiService';
import { fetchYouTubeTranscript, extractYouTubeVideoId, isYouTubeLink } from '../services/youtubeService';
import { ytGetVideoComments, type CommentResult } from '../services/youtubeAnalyticsService';
import { polishTextForAntiAi } from '../services/antiAiPolishService';
import { detectAiFeatures, type AiDetectionResult } from '../services/aiDetectionService';
import { FileText, Maximize2, RefreshCw, Scissors, ArrowRight, Copy, ChevronDown, Video, Download, Plus, X, History, Brain, Loader2, Youtube, Image, Wand2 } from 'lucide-react';
import { saveHistory, getHistory, deleteHistory, clearHistory, HistoryRecord } from '../services/historyService';
import { storage } from '../services/storageService';
import { HistorySelector } from './HistorySelector';
import { useToast } from './Toast';
import { ProgressBar } from './ProgressBar';

/** Mindful Paws 赛道 system 中的欢迎语偶发被模型贴在摘要结果前 */
function stripMindfulPawsSummarizePreamble(text: string): string {
  if (!text) return text;
  const ack = '已接收您的';
  const i = text.indexOf(ack);
  if (i > 0) return text.slice(i).trim();
  // 未带「已接收您的」时：去掉欢迎语至首个 --- 之后
  if (/欢迎使用\s*Mindful\s*Paws|治愈系频道内容生产系统/.test(text)) {
    const sep = text.search(/\n-{3,}\s*\n/);
    if (sep !== -1) {
      const after = text.slice(sep).replace(/^\n-{3,}\s*\n/, '').trim();
      if (after.length > 0 && after.length < text.length) return after;
    }
  }
  return text;
}

/** 工具条赛道下拉：去掉括号内英文名并限制字数，避免与按钮挤版 */
function compactNicheToolbarLabel(name: string, maxChars = 7): string {
  const base = name.split('(')[0].trim() || name;
  if (base.length <= maxChars) return base;
  return `${base.slice(0, maxChars - 1)}…`;
}

/** 与生成 prompt 一致：判断口播稿主体语言（用于摘要 system 指令与模板） */
function detectToolsInputLanguage(text: string): string {
  const hasChinese = /[\u4e00-\u9fff]/.test(text);
  const hasEnglish = /[a-zA-Z]/.test(text);
  let inputLanguage = '简体中文';
  if (!hasChinese && hasEnglish) {
    inputLanguage = 'English';
  } else if (hasChinese && hasEnglish) {
    const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishCount = (text.match(/[a-zA-Z]/g) || []).length;
    if (englishCount > chineseCount * 2) {
      inputLanguage = 'English (主要)';
    } else if (chineseCount > 0) {
      inputLanguage = '简体中文 (主要)';
    }
  }
  return inputLanguage;
}

interface ToolsProps {
  apiKey: string;
  provider: ApiProvider;
  toast?: ReturnType<typeof useToast>;
}

// 任务接口
interface Task {
  id: string;
  mode: ToolMode;
  niche: NicheType;
  inputText: string;
  outputText: string;
  isGenerating: boolean;
  isExtractingTranscript: boolean;
  scriptShotMode?: 'auto' | 'custom';
  scriptShotCount?: number;
}

export const Tools: React.FC<ToolsProps> = ({ apiKey, provider, toast: externalToast }) => {
  const internalToast = useToast();
  const toast = externalToast || internalToast;
  // 多任务管理
  const [tasks, setTasks] = useState<Task[]>([
    {
      id: 'task-1',
      mode: ToolMode.REWRITE,
      niche: NicheType.TCM_METAPHYSICS,
      inputText: '',
      outputText: '',
      isGenerating: false,
      isExtractingTranscript: false,
      scriptShotMode: 'auto',
      scriptShotCount: 10,
    }
  ]);
  const [activeTaskId, setActiveTaskId] = useState<string>('task-1');
  
  // 当前活动任务
  const activeTask = tasks.find(t => t.id === activeTaskId) || tasks[0];
  const activeTaskIndex = tasks.findIndex(t => t.id === activeTaskId);
  
  // 便捷访问当前任务的状态（保持向后兼容）
  const mode = activeTask.mode;
  const niche = activeTask.niche;
  const inputText = activeTask.inputText;
  const outputText = activeTask.outputText;
  const isGenerating = activeTask.isGenerating;
  const isExtractingTranscript = activeTask.isExtractingTranscript;
  const scriptShotMode = activeTask.scriptShotMode || 'auto';
  const scriptShotCountRaw = activeTask.scriptShotCount;
  const scriptShotCount = Math.min(100, Math.max(10, scriptShotCountRaw || 10));
  const isDeepRewriteMode = [ToolMode.REWRITE, ToolMode.EXPAND, ToolMode.POLISH].includes(mode);
  const lastProgressUpdateRef = useRef<number>(0);
  const getToolsHistoryKey = (m: ToolMode, n: NicheType) => {
    if (m === ToolMode.SCRIPT) return `${ToolMode.SCRIPT}_GLOBAL`;
    return `${m}_${n}`;
  };
  
  // 更新当前任务状态
  const updateActiveTask = (updates: Partial<Task>) => {
    setTasks(prev => prev.map(task => 
      task.id === activeTaskId ? { ...task, ...updates } : task
    ));
  };
  
  // 处理模式切换（不带自动弹窗）
  const handleModeChange = (newMode: ToolMode) => {
    console.log('[Tools] 切换模式:', newMode);
    updateActiveTask({ mode: newMode });
  };

  // 手动触发模式历史记录弹窗
  const handleManualModeHistoryClick = (e: React.MouseEvent, mode: ToolMode) => {
    e.stopPropagation();
    const historyKey = getToolsHistoryKey(mode, activeTask.niche);
    const records = getHistory('tools', historyKey);
    
    if (records.length > 0) {
      setHistoryRecords(records);
      setPendingModeChange({ mode, niche: activeTask.niche });
      setShowHistorySelector(true);
    }
  };

  // 处理赛道切换（不带自动弹窗）
  const handleNicheChange = (newNiche: NicheType) => {
    console.log('[Tools] 切换赛道:', newNiche);
    updateActiveTask({ niche: newNiche });
    setNicheManuallySet(true);
  };

  // 手动触发赛道历史记录弹窗
  const handleManualNicheHistoryClick = (e: React.MouseEvent, niche: NicheType) => {
    e.stopPropagation();
    const historyKey = getToolsHistoryKey(activeTask.mode, niche);
    const records = getHistory('tools', historyKey);
    
    if (records.length > 0) {
      setHistoryRecords(records);
      setPendingModeChange({ mode: activeTask.mode, niche });
      setShowHistorySelector(true);
    }
  };
  
  // 设置模式（更新当前任务）- 保持向后兼容
  const setMode = (newMode: ToolMode) => {
    handleModeChange(newMode);
  };

  // 设置赛道（更新当前任务）- 保持向后兼容
  const setNiche = (newNiche: NicheType) => {
    handleNicheChange(newNiche);
  };
  
  // 处理历史记录选择
  const handleHistorySelect = (record: HistoryRecord) => {
    if (pendingModeChange) {
      let restored = record.content;
      if (
        pendingModeChange.mode === ToolMode.SUMMARIZE &&
        pendingModeChange.niche === NicheType.MINDFUL_PSYCHOLOGY
      ) {
        restored = stripMindfulPawsSummarizePreamble(restored);
      }
      updateActiveTask({
        mode: pendingModeChange.mode,
        niche: pendingModeChange.niche,
        outputText: restored,
        inputText: record.metadata?.input || '',
      });
      setNicheManuallySet(true);
      setPendingModeChange(null);
    }
  };
  
  // 设置输入文本（更新当前任务）
  const setInputText = (text: string) => {
    updateActiveTask({ inputText: text });
  };

  const isChineseHeavy = (text: string) => (text.match(/[\u4e00-\u9fff]/g) || []).length > 25;

  const quickDetectBestNiche = (text: string): { niche: NicheType; score: number; reason: string } | null => {
    const t = text.toLowerCase();
    if (!text.trim() || text.trim().length < 80) return null;

    // ===== 固定关键词优先检测（最高优先级，一票锁定） =====
    // 中医玄学固定关键词
    const cnTCMFixedPatterns = /倪海厦|倪师|南师|曲黎敏|徐文兵|刘渡舟|胡希恕|郝万山|刘力红|郭生白|JT叔叔|谭杰中|千古中医/i;

    // 易经命理固定关键词
    const cnYijingFixedPatterns = /曾仕强|曾教授|傅佩荣|傅教授|王弼|孔颖达|朱熹|邵雍|陈抟|刘伯温|李虚中|袁天罡|推背图/i;

    // 新闻热点固定关键词（优先于金融理财检测）
    const cnNewsFixedPatterns = /绞肉机|收割机|新闻|热点|地缘|关税|贸易战|大选|公投|军事|外交|战争|冲突|和平|抗议|示威|骚乱|暴乱|恐袭|爆炸|坠机|空难|海难|矿难|疫情|病毒|传染病|灾难|事故|伤亡|紧急状态|戒严|宵禁|封锁|禁运|断交|宣战|停火|谈判|协议|条约|论坛|联合国|G20|北约|WTO|OECD|欧盟|东盟|OPEC|安理会|联合国大会|头条|热搜|爆款|突发|快讯|刚刚|重磅|血洗|屠杀|崩盘|危机|转折|震惊|炸裂|逆转|翻盘|逆转|奇迹|突破|揭秘|曝光|实锤|爆料|内幕|真相|隐情|黑幕|潜规则|套路|反转|反转再反转|打脸|神反转|震撼|惊人|惊悚|恐怖|可怕|诡异|荒唐|讽刺|可笑|无语|崩溃|绝望|彻底|彻底完了|完蛋|毁灭|崩塌|瓦解|粉碎|终结|结局|悲剧|惨剧|人间悲剧|悲剧了|惨烈|残酷|残忍|暴行|罪行|恶行|丑闻|丑闻|秽闻|丑闻曝光|丢人|丢脸|脸丢大了|脸都不要了|无语了|醉了|我醉了|笑死|笑喷|笑掉大牙|奇葩|神操作|骚操作|迷惑行为|迷惑|无语子|绝绝子|YYDS|绝绝子|牛逼|牛批|厉害|厉害了我的|666|服了|服了你|服了你了|无语问苍天|天理何在|公道自在人心|正义|公平|平等|人权|自由|民主|法治|制度|规则|秩序|混乱|动荡|不稳定|风险|危险|警告|预警|紧急|迫在眉睫|一触即发|千钧一发|生死存亡|命悬一线|悬了|凉了|凉凉|凉了凉了|死定了|完蛋了|没救了|无可救药|无药可救|没救了|彻底没救了|没救了真的|彻底完了/i;

    // 金融理财固定关键词
    const cnFinanceFixedPatterns = /巴菲特|查理芒格|查理·芒格|沃伦巴菲特|价值投资|安全边际|护城河|长期主义|护城河理论|估值模型|财务报表|资产负债表|利润表|现金流量表|股价|股息率|市盈率|市净率|ROE|净资产收益率|价值股|蓝筹股|白马股|赛道股|庄家|主力资金|北向资金|融资融券|做多|做空|K线|均线|MACD|KDJ RSI|布林线|金叉|死叉|止盈|止损|建仓|清仓|满仓|轻仓|重仓|爆仓|加仓|减仓|补仓|平仓|换手率|成交量|量比|涨停|跌停|停牌|上市|退市|IPO|打新|配股|增发|回购|分红|送股|转增|除权|除息|填权|贴权|牛股|妖股|黑马|白马|蓝筹|仙股|壳资源|并购|重组|收购|定增|可转债|ETF|指数基金|主动基金|被动基金|货币基金|债券基金|混合基金|公募基金|私募基金|对冲基金|风投|VC|PE|天使投资|股权投资|债权投资|期货|期权|原油|黄金|美元|人民币汇率|美联储|加息|降息|缩表|扩表|通货膨胀|通货紧缩|GDP|CPI|PPI|PMI|非农|失业率|利率|存款准备金|逆回购|正回购|SLF|MLF|TLF|SOMO|量化宽松|紧缩政策|财政政策|货币政策/i;

    // ===== 主题关键词优先检测 =====
    // 中文宠物/动物心理学特征词
    const cnAnimalPsychologyPatterns = /猫主子|汪星人|喵星人|猫奴|狗奴|养猫|养狗|流浪猫|流浪狗|弃养|绝育|疫苗|驱虫|猫粮|狗粮|猫砂|猫爬架|狗窝|宠物店|宠物医院|猫舍|犬舍|繁殖|纯种|杂交|品种狗|品种猫|定点|如厕|分离焦虑|护食|扑咬|吠叫|纠正|社会化|猫罐头|狗罐头|猫包|狗包|牵引绳|项圈|驱虫药|猫三联|狗五联|领养|救助站|救助机构|寄养|宠物保险/i;

    // 中文富人思维（精简版，避免与金融理财混淆）
    const cnGreatPowerGamePatterns = /大国博弈|地缘政治|博弈|博弈论|地缘战略|大国竞争|战略博弈|权力博弈|国际博弈|战略竞争|战略误判|战略决策|中美博弈|博弈内幕|博弈真相|博弈逻辑|博弈格局|博弈视角/i;

    // 中文情感禁忌优先检测
    const cnEmotionTabooPatterns = /情感|恋爱|分手|暧昧|禁忌|婚姻|爱情|约会|相亲|出轨|小三|劈腿|备胎|绿茶|渣男|渣女|表白|告白|暗恋|追求|复合|挽回|离婚|再婚|闪婚|异地恋|姐弟恋|PUA|冷暴力|热暴力|家暴|原生家庭/i;

    const rules: Array<{ niche: NicheType; words: string[]; reason: string }> = [
      { niche: NicheType.MINDFUL_PSYCHOLOGY, words: ['dog', 'puppy', 'pet parent', 'canine', 'bark', 'anxiety', 'reactive dog', 'psychology', 'therapist', 'mental health', 'behavior', 'training', 'breed', 'shelter', 'adopt', 'rescue dog', 'feline', 'animal assisted', 'therapy dog', 'service dog', 'emotional support', 'companion', 'bond', 'healing', 'mindful', 'awareness', 'presence', 'calm', 'stress relief', 'comfort', 'attachment', 'trauma recovery', 'animal therapy', 'pet therapy', 'cat', 'kitten', 'meow', 'pet', 'pets', 'animal', 'veterinary', 'cat behavior', 'dog behavior', '养猫', '养狗', '宠物训练', '猫心理', '狗心理', '动物心理', '猫行为', '狗行为'], reason: '检测到治愈心理学（宠物心理）特征词' },
      { niche: NicheType.PSYCHOLOGY, words: ['心理', '创伤', '焦虑', '抑郁', '人格', '认知', '情绪管理', '心理咨询', '心理治疗', '心理疏导', '心理问题', '心理疾病', '心理障碍', '心理健康', '精神分析', '认知行为', '情绪调节', '自我认知', '心理脆弱', '心理压力', '情感障碍', '人格分裂', '焦虑症', '抑郁症', '心理咨询师', '心理防御'], reason: '检测到心理学高频词' },
      { niche: NicheType.FINANCE_CRYPTO, words: ['股票', '基金', '投资', '资产', '估值', '巴菲特', '芒格', '比特币', 'crypto', '财富', '理财', '收益', '回报', '通货膨胀', '美联储', '加息', '降息', '牛市', '熊市', 'K线', '市值', '期权', '期货', '杠杆', '做空', '做多', '止损', '盈利', '亏损', '分红', '股息', '复利', '本金', '收益率', '年化', '赛道股', '蓝筹', '白马', '价值投资', '成长股'], reason: '检测到投资财经相关词' },
      { niche: NicheType.GENERAL_VIRAL, words: ['新闻', '热点', '国际', '地缘', '关税', '贸易战', '突发', '头条', '热搜', '爆款', '刷屏', '病毒式传播', '舆论', '时事', '政治', '经济', '社会', '科技', '娱乐', '体育', '军事', '外交', '制裁', '协议', '峰会', '选举', '公投', '冲突', '战争', '和平', '抗议', '示威'], reason: '检测到新闻热点相关词' },
      { niche: NicheType.TCM_METAPHYSICS, words: ['中医', '玄学', '风水', '气血', '经络', '倪海厦', '阴阳', '五行', '针灸', '推拿', '中药', '草药', '穴位', '脉象', '黄帝内经', '伤寒论', '本草纲目', '扁鹊', '华佗', '李时珍', '张仲景', '药方', '配伍', '君臣佐使', '养生', '食疗', '药膳', '气功', '太极', '八段锦', '易经八卦', '命理', '八字', '紫微斗数', '六爻', '奇门遁甲', '梅花易数', '面相', '手相', '骨相', '风水罗盘', '龙脉', '祖坟', '阳宅', '阴宅'], reason: '检测到中医玄学相关词' },
      { niche: NicheType.YI_JING_METAPHYSICS, words: ['易经', '卦', '爻', '八卦', '命理', '天干地支', '六十四卦', '乾卦', '坤卦', '震卦', '巽卦', '坎卦', '离卦', '艮卦', '兑卦', '太极', '两仪', '四象', '河图', '洛书', '先天八卦', '后天八卦', '梅花易数', '六爻预测', '奇门遁甲', '大六壬', '铁板神数', '邵雍', '孔子', '文王', '周公', '十天干', '十二地支', '甲子', '纳音', '神煞', '冲合', '刑害', '三合', '六合', '择日', '选吉', '方位'], reason: '检测到易经命理相关词' },
      { niche: NicheType.PHILOSOPHY_WISDOM, words: ['哲学', '尼采', '柏拉图', '亚里士多德', '康德', '黑格尔', '海德格尔', '萨特', '加缪', '笛卡尔', '休谟', '罗素', '维特根斯坦', '苏格拉底', '儒家', '道家', '佛学', '禅', '悟道', '涅槃', '般若', '中庸', '天人合一', '道法自然', '存在主义', '形而上学', '唯物主义', '唯心主义', '辩证法'], reason: '检测到哲学智慧相关词' },
      { niche: NicheType.EMOTION_TABOO, words: ['情感', '恋爱', '分手', '暧昧', '禁忌', '婚姻', '爱情', '约会', '相亲', '出轨', '小三', '劈腿', '备胎', '绿茶', '渣男', '渣女', '表白', '告白', '暗恋', '追求', '复合', '挽回', '离婚', '再婚', '闪婚', '异地恋', '姐弟恋', '师生恋', '办公室恋情', '三角恋', '性骚扰', 'PUA', '情感操控', '冷暴力', '热暴力', '家暴', '原生家庭', '原生创伤'], reason: '检测到情感关系相关词' },
      { niche: NicheType.GREAT_POWER_GAME, words: ['大国博弈', '地缘政治', '博弈', '博弈论', '地缘战略', '博弈视角', '博弈分析', '大国竞争', '战略博弈', '博弈格局', '博弈逻辑', '权力博弈', '国际博弈', '战略竞争', '博弈真相', '内幕', '内幕分析', '博弈内幕', '博弈真相', '博弈逻辑', '博弈格局', '战略误判', '战略决策', '大国博弈', '中美博弈', '博弈分析'], reason: '检测到大国博弈相关词' },
      { niche: NicheType.STORY_REVENGE, words: ['复仇', '反击', '剧情', '角色', '冲突', '叙事', '逆袭', '翻盘', '打脸', '打脸爽文', '爽文', '爽文男主', '爽文女主', '装逼', '打脸', '逆袭人生', '废柴逆袭', '王者归来', '战神', '龙王', '赘婿', '神医', '总裁', '豪门', '家族', '恩怨', '阴谋', '陷害', '背叛', '崛起', '蜕变', '黑化', '觉醒', '爆发', '秒杀', '碾压', '完虐', '绝地反击', '绝地翻盘'], reason: '检测到复仇故事相关词' },
    ];

    // ===== 固定关键词优先检测（最高优先级，一票锁定） =====
    // 中医玄学固定关键词
    if (cnTCMFixedPatterns.test(t)) {
      return { niche: NicheType.TCM_METAPHYSICS, score: 10, reason: '检测到中医玄学权威专家关键词' };
    }

    // 易经命理固定关键词
    if (cnYijingFixedPatterns.test(t)) {
      return { niche: NicheType.YI_JING_METAPHYSICS, score: 10, reason: '检测到易经命理权威专家关键词' };
    }

    // 新闻热点固定关键词（优先于金融理财检测）
    if (cnNewsFixedPatterns.test(t)) {
      return { niche: NicheType.GENERAL_VIRAL, score: 10, reason: '检测到新闻热点关键词' };
    }

    // 金融理财固定关键词
    if (cnFinanceFixedPatterns.test(t)) {
      return { niche: NicheType.FINANCE_CRYPTO, score: 10, reason: '检测到金融理财权威专家/专业术语' };
    }

    // ===== 主题关键词优先检测 =====
    // 中文宠物/动物心理学特征词
    if (cnAnimalPsychologyPatterns.test(t)) {
      return { niche: NicheType.MINDFUL_PSYCHOLOGY, score: 5, reason: '检测到中文宠物/动物心理学特征词' };
    }

    // 中文大国博弈
    if (cnGreatPowerGamePatterns.test(t)) {
      return { niche: NicheType.GREAT_POWER_GAME, score: 5, reason: '检测到中文大国博弈特征词' };
    }

    // 中文情感禁忌
    if (cnEmotionTabooPatterns.test(t)) {
      return { niche: NicheType.EMOTION_TABOO, score: 5, reason: '检测到中文情感禁忌特征词' };
    }

    let best: { niche: NicheType; score: number; reason: string } | null = null;
    for (const r of rules) {
      let score = 0;
      for (const w of r.words) {
        if (t.includes(w.toLowerCase())) score += 1;
      }
      if (score > 0 && (!best || score > best.score)) {
        best = { niche: r.niche, score, reason: r.reason };
      }
    }

    // 英文心理学兜底检测
    if (!best) {
      const enPsychologyPatterns = /dog|pet|puppy|canine|psychology|psychologist|therapist|mental health|behavior|behaviour|training|breed|shelter|adopt|rescue|therapy dog|healing|companion|feline|human.animal|bond|wellbeing|well-being|caregiver|cat|kitten|meow/i;
      if (enPsychologyPatterns.test(t)) {
        return { niche: NicheType.MINDFUL_PSYCHOLOGY, score: 3, reason: '检测到英文心理学/宠物心理语料' };
      }
    }

    return best && best.score >= 2 ? best : null;
  };
  
  // 设置输出文本（更新当前任务）
  const setOutputText = (text: string) => {
    updateActiveTask({ outputText: text });
  };
  
  // 设置生成状态（更新当前任务）
  const setIsGenerating = (generating: boolean) => {
    updateActiveTask({ isGenerating: generating });
  };
  
  // 设置提取状态（更新当前任务）
  const setIsExtractingTranscript = (extracting: boolean) => {
    updateActiveTask({ isExtractingTranscript: extracting });
  };
  
  // ⚠️ RapidAPI版本 - 请将下面的 URL 替换为您部署 GAS_RapidAPI集成版.gs 后的新 URL
  // 示例：https://script.google.com/macros/s/AKfycby.../exec
  const [gasApiUrl, setGasApiUrl] = useState<string>('https://script.google.com/macros/s/AKfycbylTL8WWoBBcYo5LaXGsIoUiBVxWVFLEcaH4cMuXbnB2UEQ-tsUI6jqYS8tcYT0wxQaqA/exec'); // ⚠️⚠️⚠️ 必须填入您的实际GAS部署URL，否则无法使用！
  
  // 历史记录相关状态
  const [showHistorySelector, setShowHistorySelector] = useState(false);
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);
  const [pendingModeChange, setPendingModeChange] = useState<{ mode: ToolMode; niche: NicheType } | null>(null);
  // 生成进度
  const [generationProgress, setGenerationProgress] = useState<{ current: number; total: number } | null>(null);
  const [shotPromptProgress, setShotPromptProgress] = useState<{ success: number; failed: number; hint: string } | null>(null);
  const shotSegmentsRef = useRef<string[] | null>(null);
  const originalScriptInputRef = useRef<string>('');

  // 生深度洗稿：5段分段编辑流
  const [rewriteSegments, setRewriteSegments] = useState<string[]>(['', '', '', '', '']);
  const [segmentOutputs, setSegmentOutputs] = useState<string[]>(['', '', '', '', '']);
  const [segmentGenerating, setSegmentGenerating] = useState<boolean[]>([false, false, false, false, false]);
  const [mergedOutput, setMergedOutput] = useState<string>('');
  const [painPointText, setPainPointText] = useState<string>('');
  const [terminalLog, setTerminalLog] = useState<string>('等待任务...');

  // ── 评论区痛点提取状态 ──────────────────────────────
  const [commentResult, setCommentResult] = useState<CommentResult | null>(null);
  const [isExtractingComments, setIsExtractingComments] = useState(false);
  const [isAnalyzingPainPoints, setIsAnalyzingPainPoints] = useState(false);
  const [youtubeApiKey, setYoutubeApiKey] = useState<string>('');

  // ── 频道生成器状态 ──────────────────────────────────
  const [channelTopic, setChannelTopic] = useState('');
  const [channelTargetAudience, setChannelTargetAudience] = useState('');
  const [channelContentType, setChannelContentType] = useState('');
  const [channelBrandPositioning, setChannelBrandPositioning] = useState('');
  const [channelOutput, setChannelOutput] = useState<{
    names: string[];
    avatarPrompts: string[];
    bannerPrompts: string[];
    description: string;
    keywords: string[];
  } | null>(null);
  const [isGeneratingChannel, setIsGeneratingChannel] = useState(false);
  const [generatedAvatarImages, setGeneratedAvatarImages] = useState<string[]>([]);
  const [generatedBannerImages, setGeneratedBannerImages] = useState<string[]>([]);
  const [isGeneratingAvatar, setIsGeneratingAvatar] = useState(false);
  const [isGeneratingBanner, setIsGeneratingBanner] = useState(false);
  const [channelNameLang, setChannelNameLang] = useState<'zh' | 'en' | 'both'>('both');

  // 初始化时加载 YouTube API Key
  React.useEffect(() => {
    const loadKey = async () => {
      const envKey = (import.meta as any).env?.VITE_YOUTUBE_API_KEY as string | undefined;
      if (envKey) {
        setYoutubeApiKey(envKey);
      } else {
        const savedKey = await storage.get<string>('YOUTUBE_API_KEY');
        if (savedKey) setYoutubeApiKey(savedKey);
      }
    };
    void loadKey();
  }, []);
  const [rewriteOutputLanguage, setRewriteOutputLanguage] = useState<'source' | 'zh' | 'en' | 'ja' | 'ko' | 'es' | 'de' | 'hi'>('source');
  const [allSegmentsDoneNotified, setAllSegmentsDoneNotified] = useState(false);
  const [autoMatchedNiche, setAutoMatchedNiche] = useState<{ niche: NicheType; score: number; reason: string } | null>(null);
  const [autoSwitchNicheEnabled, setAutoSwitchNicheEnabled] = useState(true);
  /** 标记赛道是否被用户手动选择过；手动选择后不再自动切换，直到输入文本变化才重置 */
  const [nicheManuallySet, setNicheManuallySet] = useState(false);
  const [isOptimizingMerge, setIsOptimizingMerge] = useState(false);
  const [aiDetectionResult, setAiDetectionResult] = useState<AiDetectionResult | null>(null);
  const [isRunningAiDetection, setIsRunningAiDetection] = useState(false);
  const [rewriteLengthMode, setRewriteLengthMode] = useState<'strict' | 'balanced' | 'expressive'>('balanced');

  /** 深度洗稿 / 深度扩写（含同面板 5 段流）：Yunwu OpenAI 兼容流式主备模型 */
  const DEEP_REWRITE_STREAM_PRIMARY = 'gpt-5.4-mini';
  const DEEP_REWRITE_STREAM_FALLBACK = 'gemini-3-flash-preview';
  const buildDeepRewriteStreamOptions = (maxTokens: number): StreamContentOptions => ({
    fallbackModelOnStall: DEEP_REWRITE_STREAM_FALLBACK,
    maxTokens,
  });
  const deepRewriteStreamModelArgs = (maxTokens: number): [string | undefined, StreamContentOptions | undefined] =>
    provider === 'yunwu'
      ? [DEEP_REWRITE_STREAM_PRIMARY, buildDeepRewriteStreamOptions(maxTokens)]
      : [undefined, { maxTokens }];

  /**
   * 根据目标输出长度计算合适的 maxTokens
   * 中文约 1.5 tokens/字符（留足 buffer），洗稿/去AI味输出 ≈ 输入
   * 使用 1.5 倍确保模型有足够空间生成完整内容，不会因 buffer 不足而提前截断
   */
  const calcMaxTokens = (targetOutputChars: number): number => {
    return Math.ceil(targetOutputChars * 1.5) + 512;
  };

  /**
   * 洗稿/润色字数策略（相对原文去空白后的字符数）：
   * - strict：±5%
   * - balanced：不低于约 95%，不高于 +8%
   * - expressive：不低于约 95%，不高于 +12%
   */
  const rewriteRangeMap = {
    strict: {
      segmentMin: 0.95,
      segmentMax: 1.05,
      finalMin: 0.95,
      finalMax: 1.05,
      label: '严格贴近原文（±5%）',
    },
    balanced: {
      segmentMin: 0.95,
      segmentMax: 1.08,
      finalMin: 0.95,
      finalMax: 1.08,
      label: '适度优化（+8%以内）',
    },
    expressive: {
      segmentMin: 0.95,
      segmentMax: 1.12,
      finalMin: 0.95,
      finalMax: 1.12,
      label: '强化表达（+12%以内）',
    },
  } as const;
  const expandRangeMap = {
    strict: { min: 1.3, max: 1.6 },
    balanced: { min: 1.5, max: 1.9 },
    expressive: { min: 1.8, max: 2.3 },
  } as const;
  const [outlineText, setOutlineText] = useState<string>('');
  const [outlineItems, setOutlineItems] = useState<string[]>(['', '', '', '', '']);
  const [isExtractingOutline, setIsExtractingOutline] = useState(false);
  const [autoPilotStage, setAutoPilotStage] = useState<'idle' | 'outline' | 'split' | 'generate' | 'merge' | 'done'>('idle');

  const segmentDoneCount = segmentOutputs.reduce((acc, s, i) => {
    const base = (rewriteSegments[i] || '').trim();
    const out = (s || '').trim();
    const done = out.length > 0 && out !== base && !segmentGenerating[i] && isTextLikelyComplete(out);
    return acc + (done ? 1 : 0);
  }, 0);
  const segmentProgressPercent = Math.round((segmentDoneCount / 5) * 100);

  const outlineProgressPercent = isExtractingOutline ? 50 : (outlineText.trim() ? 100 : 0);
  const splitProgressPercent = rewriteSegments.some(s => (s || '').trim()) ? 100 : 0;
  const generateProgressPercent = segmentProgressPercent;
  const mergeProgressPercent = isOptimizingMerge ? 60 : (mergedOutput.trim() ? 100 : 0);

  const autoPilotOverallPercent = Math.round(
    (outlineProgressPercent + splitProgressPercent + generateProgressPercent + mergeProgressPercent) / 4
  );

  const sourceLenForDashboard = (inputText || '').replace(/\s+/g, '').length;
  const segmentsTotalLenForDashboard = segmentOutputs.reduce((acc, s) => acc + ((s || '').replace(/\s+/g, '').length), 0);
  const mergedLenForDashboard = (mergedOutput || '').replace(/\s+/g, '').length;
  const rewritePolicyForDashboard = rewriteRangeMap[rewriteLengthMode] || rewriteRangeMap.balanced;
  const expandPolicyForDashboard = expandRangeMap[rewriteLengthMode] || expandRangeMap.balanced;
  const rewriteMinForDashboard = Math.round(sourceLenForDashboard * rewritePolicyForDashboard.finalMin);
  const rewriteMaxForDashboard = Math.round(sourceLenForDashboard * rewritePolicyForDashboard.finalMax);
  const expandMinForDashboard = Math.round(sourceLenForDashboard * expandPolicyForDashboard.min);
  const expandMaxForDashboard = Math.round(sourceLenForDashboard * expandPolicyForDashboard.max);
  const mergedCompleteForDashboard = isTextLikelyComplete(mergedOutput || '');
  const mergedBelowFloor = isDeepRewriteMode && mode !== ToolMode.EXPAND && sourceLenForDashboard > 0 && mergedLenForDashboard > 0 && mergedLenForDashboard < rewriteMinForDashboard;
  const mergedAbovePolicy = isDeepRewriteMode && mode !== ToolMode.EXPAND && sourceLenForDashboard > 0 && mergedLenForDashboard > rewriteMaxForDashboard;
  const mergedWithinRange = isDeepRewriteMode && mode !== ToolMode.EXPAND && sourceLenForDashboard > 0 && mergedLenForDashboard >= rewriteMinForDashboard && mergedLenForDashboard <= rewriteMaxForDashboard;
  const mergedComplianceText = !isDeepRewriteMode || mode === ToolMode.EXPAND || sourceLenForDashboard === 0
    ? '扩写模式/无原文，不做洗稿区间判定'
    : mergedWithinRange
      ? `合规（约 ${Math.round(rewritePolicyForDashboard.finalMin * 100)}%~${Math.round(rewritePolicyForDashboard.finalMax * 100)}% 相对原文）`
      : mergedBelowFloor
        ? '低于下限（未完成）'
        : mergedAbovePolicy
          ? '高于上限（完整性优先）'
          : '待生成';
  
  // 创建新任务
  React.useEffect(() => {
    if ([ToolMode.REWRITE, ToolMode.EXPAND, ToolMode.POLISH].includes(mode) && outputText.trim()) {
      syncFiveSegmentStateFromOutput(outputText, inputText);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputText, mode]);

  React.useEffect(() => {
    if (!isDeepRewriteMode) return;
    const allDone = segmentOutputs.every((s, i) => {
      const base = rewriteSegments[i]?.trim() || '';
      const out = s?.trim() || '';
      return out.length > 0 && out !== base && !segmentGenerating[i] && isTextLikelyComplete(out);
    });
    if (allDone && !allSegmentsDoneNotified) {
      setAllSegmentsDoneNotified(true);
      const modeName = mode === ToolMode.EXPAND ? '深度扩写' : mode === ToolMode.POLISH ? '润色优化' : '深度洗稿';
      toast.success(`5段${modeName}任务已全部完成，可直接导出最终合并文案。`, 6000);
      appendTerminal(`全部分段任务已完成（${modeName}）。`);
    }
    if (!allDone && allSegmentsDoneNotified) {
      setAllSegmentsDoneNotified(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentOutputs, rewriteSegments, segmentGenerating, isDeepRewriteMode, mode]);

  // 赛道检测：始终检测并更新显示状态，不受生成状态影响
  React.useEffect(() => {
    // 输入文本变化时重置手动选择标记，允许重新自动匹配
    setNicheManuallySet(false);
    const text = inputText;
    const currentNiche = niche;
    const detected = quickDetectBestNiche(text);
    setAutoMatchedNiche(detected);
    console.log('[赛道检测] 检测结果:', detected, '当前赛道:', currentNiche, '文本长度:', text.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputText]);

  // 赛道自动切换：仅在满足所有条件时执行
  React.useEffect(() => {
    if (
      autoMatchedNiche &&
      autoSwitchNicheEnabled &&
      !nicheManuallySet &&
      autoMatchedNiche.niche !== niche &&
      autoMatchedNiche.score >= 2 &&
      !isGenerating
    ) {
      console.log('[赛道检测] 满足自动切换条件，切换赛道:', autoMatchedNiche.niche);
      updateActiveTask({ niche: autoMatchedNiche.niche });
      if (isDeepRewriteMode) {
        appendTerminal(`已自动匹配赛道：${NICHES[autoMatchedNiche.niche]?.name || autoMatchedNiche.niche}`);
      }
      toast.info(`已为你自动匹配赛道：${NICHES[autoMatchedNiche.niche]?.name || autoMatchedNiche.niche}`, 3500);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMatchedNiche, autoSwitchNicheEnabled, niche, isGenerating, isDeepRewriteMode]);

  const createNewTask = () => {
    const newTask: Task = {
      id: `task-${Date.now()}`,
      mode: ToolMode.REWRITE,
      niche: NicheType.TCM_METAPHYSICS,
      inputText: '',
      outputText: '',
      isGenerating: false,
      isExtractingTranscript: false,
      scriptShotMode: 'auto',
      scriptShotCount: 10,
    };
    setTasks(prev => [...prev, newTask]);
    setActiveTaskId(newTask.id);
  };
  
  // 删除任务
  const deleteTask = (taskId: string) => {
    if (tasks.length <= 1) {
      // 至少保留一个任务
      return;
    }
    setTasks(prev => prev.filter(t => t.id !== taskId));
    // 如果删除的是当前任务，切换到第一个任务
    if (taskId === activeTaskId) {
      const remainingTasks = tasks.filter(t => t.id !== taskId);
      if (remainingTasks.length > 0) {
        setActiveTaskId(remainingTasks[0].id);
      }
    }
  };
  
  // 切换任务
  const switchTask = (taskId: string) => {
    setActiveTaskId(taskId);
  };

  const splitTextIntoFiveSegments = (text: string): string[] => {
    const fallback = ['', '', '', '', ''];
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned) return fallback;

    const sentenceSplitPattern = /(?<=[。！？.!?])\s+/;
    const sentences = cleaned.split(sentenceSplitPattern).filter(Boolean);
    if (sentences.length <= 5) {
      const out = [...sentences];
      while (out.length < 5) out.push('');
      return out.slice(0, 5);
    }

    const totalChars = cleaned.length;
    const target = Math.max(80, Math.round(totalChars / 5));
    const result: string[] = [];
    let buf = '';

    for (const sentence of sentences) {
      const next = buf ? `${buf} ${sentence}` : sentence;
      if (next.length > target && result.length < 4 && buf) {
        result.push(buf.trim());
        buf = sentence;
      } else {
        buf = next;
      }
    }
    if (buf.trim()) result.push(buf.trim());

    while (result.length < 5) result.push('');
    if (result.length > 5) {
      const head = result.slice(0, 4);
      const tail = result.slice(4).join(' ').trim();
      return [...head, tail];
    }
    return result;
  };

  const mergeFiveSegments = (segs: string[]): string => {
    // 中医玄学赛道合并核心逻辑：
    // 1. 第一段保留开场白和"好了，我们开始上课"
    // 2. 第二至五段去除所有开场白和过渡语
    // 3. 合并后全局去重，确保每个模板句只出现一次

    const cleaned = segs.map((seg, segIdx) => {
      let result = seg.trim();
      
      if (segIdx > 0) {
        // 第二至五段：去除开场白和过渡语
        result = result.replace(/^各位老友们好[，,\s][^\n。！？]+[。！？]\s*/gm, '');
        result = result.replace(/^各位老友们好[^\n]*\n*/gm, '');
        result = result.replace(/^好了，我们开始上课。[。]*\s*/gm, '');
        result = result.replace(/^好了我們開始上課。[。]*\s*/gm, '');
        result = result.replace(/^第[一二三四五六七八九十\d]+节课[:：]?\s*/gm, '');
        result = result.replace(/^第一课\s*/gm, '');
        result = result.replace(/^第二课\s*/gm, '');
        result = result.replace(/^第三课\s*/gm, '');
        result = result.replace(/^第四课\s*/gm, '');
        result = result.replace(/^第五课\s*/gm, '');
        // 段中去除
        result = result.replace(/\n各位老友们好[^\n]*倪海厦[^\n]*\n*/g, '\n');
        result = result.replace(/\n各位老友们好[^\n]*\n*/g, '\n');
        result = result.replace(/\n好了，我们开始上课。[。]*\n*/g, '\n');
        result = result.replace(/\n好了我們開始上課。[。]*\n*/g, '\n');
      }
      
      return result;
    });
    
    // 过滤空段
    const filtered = cleaned.filter(seg => seg.trim().length > 0);
    if (filtered.length === 0) {
      const fallback = segs.find(s => (s || '').trim().length > 0);
      return fallback ? fallback.trim() : '';
    }
    
    // 合并
    let merged = filtered.join('\n\n');
    
    // 全局强制去重：只保留第一个开场白
    const firstOpeningIdx = merged.indexOf('各位老友们好');
    if (firstOpeningIdx !== -1) {
      const secondOpeningIdx = merged.indexOf('各位老友们好', firstOpeningIdx + 1);
      if (secondOpeningIdx !== -1) {
        // 找到"好了，我们开始上课"的位置
        const startClassIdx = merged.indexOf('好了，我们开始上课');
        if (startClassIdx !== -1 && secondOpeningIdx > startClassIdx) {
          // 第二个开场白在"好了"之后，说明是新文章的开始，直接截断
          merged = merged.substring(0, secondOpeningIdx).trim();
        }
      }
    }
    
    // 全局强制去重：只保留第一个"好了，我们开始上课"
    const startClassPattern = '好了，我们开始上课。';
    const regex = new RegExp(startClassPattern, 'g');
    const matches = merged.match(regex);
    if (matches && matches.length > 1) {
      let first = true;
      merged = merged.replace(regex, () => {
        if (first) {
          first = false;
          return startClassPattern;
        }
        return '';
      });
    }
    
    // 清理多余的空行
    merged = merged.replace(/\n{3,}/g, '\n\n');
    merged = merged.trim();
    
    return merged;
  };


  const calcSimilarityRough = (a: string, b: string): number => {
    const sa = (a || '').replace(/\s+/g, '').trim();
    const sb = (b || '').replace(/\s+/g, '').trim();
    if (!sa || !sb) return 0;
    const short = sa.length <= sb.length ? sa : sb;
    const long = sa.length > sb.length ? sa : sb;
    let hit = 0;
    const step = Math.max(2, Math.floor(short.length / 40));
    for (let i = 0; i < short.length; i += step) {
      const chunk = short.slice(i, i + 12);
      if (chunk.length >= 6 && long.includes(chunk)) hit += 1;
    }
    const total = Math.max(1, Math.ceil(short.length / step));
    return hit / total;
  };

  const appendTerminal = (msg: string) => {
    const stamp = new Date().toLocaleTimeString();
    setTerminalLog(prev => `${prev}\n[${stamp}] ${msg}`.trim());
  };

  /** 检测文本是否为英文（超过50%字符为拉丁字母） */
  const isEnglishText = (text: string): boolean => {
    const sample = text.slice(0, Math.min(500, text.length));
    const latinChars = (sample.match(/[A-Za-z]/g) || []).length;
    const totalChars = sample.replace(/\s/g, '').length;
    return totalChars > 0 && latinChars / totalChars > 0.5;
  };

  /**
   * 按句子边界切割文本，保证句子/单词完整性
   * 中文按句号感叹号问号切割
   * 英文按句子标点切割，并保证单词不中间断开
   */
  const splitIntoSentences = (text: string): string[] => {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned) return [];

    const sentences: string[] = [];
    let remaining = cleaned;
    
    while (remaining.length > 0) {
      // 尝试匹配中文句子（优先）
      const chineseMatch = remaining.match(/^([^。！？]*[。！？])/);
      if (chineseMatch) {
        sentences.push(chineseMatch[0].trim());
        remaining = remaining.slice(chineseMatch[0].length).trim();
        continue;
      }
      
      // 尝试匹配英文句子（句号/感叹号/问号后跟空格或结束）
      const englishMatch = remaining.match(/^([^.!?]*[.!?]+[\s]?)/);
      if (englishMatch) {
        sentences.push(englishMatch[0].trim());
        remaining = remaining.slice(englishMatch[0].length).trim();
        continue;
      }
      
      // 没有匹配到句子，添加剩余文本
      if (remaining.length > 0) {
        sentences.push(remaining.trim());
        break;
      }
    }
    
    return sentences.filter(s => s.length > 0);
  };

  /**
   * 智能切分文本为分镜段落
   * - 中文：每段200-300字
   * - 英文：每段300-450字符（含空格）
   * - 禁止句子/单词中间切割
   */
  const segmentTextByShots = (text: string, targetShots: number): string[] => {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned) return [];

    const isEnglish = isEnglishText(cleaned);
    
    // 根据语言设置目标字数范围（每个镜头 100-200 字）
    const avgChars = isEnglish 
      ? Math.max(200, Math.round(cleaned.length / targetShots))
      : Math.max(120, Math.round(cleaned.length / targetShots));
    const minLen = Math.round(avgChars * 0.7);  // 最低 70-140 字
    const maxLen = Math.round(avgChars * 1.4);  // 最高 168-280 字

    // 按句子分割（保证完整性）
    const sentences = splitIntoSentences(cleaned);
    if (sentences.length === 0) return [cleaned];

    const segments: string[] = [];
    let buffer = '';

    const flushBuffer = () => {
      if (buffer.trim()) {
        segments.push(buffer.trim());
        buffer = '';
      }
    };

    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim();
      if (!trimmedSentence) continue;
      
      if (!buffer) {
        buffer = trimmedSentence;
        continue;
      }
      
      const tentative = `${buffer} ${trimmedSentence}`.trim();
      // 如果累积后超过maxLen，先flush当前buffer再处理这个句子
      if (tentative.length > maxLen && buffer.length >= minLen) {
        flushBuffer();
        buffer = trimmedSentence;
      } else if (tentative.length <= maxLen) {
        buffer = tentative;
      } else if (buffer.length < minLen) {
        // buffer还不够长，继续累积
        buffer = tentative;
      } else {
        // 超过maxLen但buffer已经够长，flush并开启新的
        flushBuffer();
        buffer = trimmedSentence;
      }
    }
    flushBuffer();

    // 如果分出的段落数量与目标差距太大，需要合并或拆分
    if (segments.length > targetShots) {
      // 合并相邻段落直到达到目标（优先合并最短的相邻对）
      while (segments.length > targetShots) {
        let minPairIdx = 0;
        let minPairSum = Infinity;
        for (let i = 0; i < segments.length - 1; i++) {
          const sum = segments[i].length + segments[i + 1].length;
          if (sum < minPairSum) {
            minPairSum = sum;
            minPairIdx = i;
          }
        }
        const merged = `${segments[minPairIdx]} ${segments[minPairIdx + 1]}`.trim();
        segments.splice(minPairIdx, 2, merged);
      }
    } else if (segments.length < targetShots && segments.length > 0) {
      // 拆分最长的段落（按句子边界拆分）
      let splitHappened = true;
      while (segments.length < targetShots && splitHappened) {
        splitHappened = false;
        // 找到最长的段落
        let maxIdx = 0;
        let maxSegLen = 0;
        for (let i = 0; i < segments.length; i++) {
          if (segments[i].length > maxSegLen) {
            maxSegLen = segments[i].length;
            maxIdx = i;
          }
        }
        
        const seg = segments[maxIdx];
        if (seg.length <= avgChars * 0.6) break;  // 已经够短了
        
        // 在段落中找合适的切割点（句子边界）
        const mid = Math.floor(seg.length / 2);
        let splitAt = -1;
        
        // 中文标点（优先）
        splitAt = seg.lastIndexOf('。', mid);
        if (splitAt === -1 || splitAt < seg.length * 0.2) splitAt = seg.lastIndexOf('！', mid);
        if (splitAt === -1 || splitAt < seg.length * 0.2) splitAt = seg.lastIndexOf('？', mid);
        // 英文标点
        if (splitAt === -1 || splitAt < seg.length * 0.2) splitAt = seg.lastIndexOf('. ', mid);
        if (splitAt === -1 || splitAt < seg.length * 0.2) splitAt = seg.lastIndexOf('! ', mid);
        if (splitAt === -1 || splitAt < seg.length * 0.2) splitAt = seg.lastIndexOf('? ', mid);
        if (splitAt === -1 || splitAt < seg.length * 0.2) splitAt = seg.lastIndexOf('.', mid);
        
        // 确保切割点合理：不在开头或结尾附近
        if (splitAt > seg.length * 0.25 && splitAt < seg.length * 0.85) {
          const first = seg.slice(0, splitAt + 1).trim();
          const second = seg.slice(splitAt + 1).trim();
          // 确保两边都有足够内容
          if (first.length >= minLen * 0.5 && second.length >= minLen * 0.5) {
            segments.splice(maxIdx, 1, first, second);
            splitHappened = true;
          } else {
            break;
          }
        } else {
          break;
        }
      }
    }

    return segments.slice(0, targetShots);
  };

  const buildTwoStagePrompt = (basePrompt: string, stagedSegments: string[] | null): string => {
    if (!stagedSegments || stagedSegments.length === 0) {
      return basePrompt;
    }

    const stage1 = stagedSegments
      .map((seg, i) => `镜头${i + 1}文案段落：${seg}`)
      .join('\n');

    return `${basePrompt}\n\n## 二段式输出（强制执行）\n第一段：先仅输出全部镜头文案，按镜头数量平均分割并严格一一对应，不输出图片提示词、视频提示词、景别、语音分镜、音效。\n第二段：在第一段全部完成后，再按镜头序号逐个推理并输出图片提示词与视频提示词等其余字段，禁止跨镜头合并推理。\n\n## 第一段镜头文案预分配（必须逐条对应）\n${stage1}`;
  };

  const estimatePromptProgress = (script: string, expectedShots: number): { success: number; failed: number; hint: string } => {
    const maxShot = Math.max(expectedShots, 0);
    if (maxShot === 0) return { success: 0, failed: 0, hint: '等待输出镜头提示词...' };

    const successSet = new Set<number>();
    const failedSet = new Set<number>();

    for (let i = 1; i <= maxShot; i++) {
      const blockRegex = new RegExp(`(?:^|\\n)\s*(?:镜头|鏡頭)${i}\s*[\s\\S]*?(?=(?:\\n\s*(?:镜头|鏡頭)\\d+\s*$)|\\n\s*\\[(?:角色信息|场景信息|場景信息)\\]|$)`, 'm');
      const block = script.match(blockRegex)?.[0] || '';
      if (!block) continue;

      const hasCaption = /镜头文案[：:]/.test(block);
      const hasImage = /(?:图片提示词|圖片提示词)[：:]/.test(block);
      const hasVideo = /视频提示词[：:]/.test(block);

      if (hasCaption && hasImage && hasVideo) {
        successSet.add(i);
      } else if (hasCaption || hasImage || hasVideo) {
        failedSet.add(i);
      }
    }

    const success = successSet.size;
    const failed = failedSet.size;
    const pending = Math.max(0, maxShot - success - failed);

    let hint = `镜头提示词进度：成功 ${success}，失败 ${failed}，待生成 ${pending}`;
    if (failed > 0) {
      hint += `（失败镜头：${Array.from(failedSet).slice(0, 8).join('、')}${failed > 8 ? '...' : ''}）`;
    }

    return { success, failed, hint };
  };

  const parseLessonNumber = (raw: string): number | null => {
    const map: Record<string, number> = {
      '一': 1,
      '二': 2,
      '三': 3,
      '四': 4,
      '五': 5,
      '六': 6,
      '七': 7,
      '八': 8,
      '九': 9,
    };
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return Number(raw);
    return map[raw] ?? null;
  };

  const getLessonSequence = (text: string): Array<{ num: number; index: number }> => {
    const matches = [...text.matchAll(/第\s*([一二三四五六七八九]|\d+)\s*(?:节课|堂课)/g)];
    return matches
      .map(m => ({ num: parseLessonNumber(m[1]) ?? -1, index: m.index ?? -1 }))
      .filter(m => m.num > 0 && m.index >= 0);
  };

  const hasAllNineLessons = (text: string): boolean => {
    const seq = getLessonSequence(text);
    const nums = seq.map(s => s.num);
    for (let i = 1; i <= 9; i += 1) {
      if (!nums.includes(i)) return false;
    }
    const indexByNum = new Map<number, number>();
    for (const s of seq) {
      if (!indexByNum.has(s.num)) indexByNum.set(s.num, s.index);
    }
    for (let i = 1; i < 9; i += 1) {
      const a = indexByNum.get(i);
      const b = indexByNum.get(i + 1);
      if (a === undefined || b === undefined) return false;
      if (a >= b) return false;
    }
    return true;
  };

  const getMissingLessons = (text: string): number[] => {
    const seq = getLessonSequence(text).map(s => s.num);
    const missing: number[] = [];
    for (let i = 1; i <= 9; i += 1) {
      if (!seq.includes(i)) missing.push(i);
    }
    return missing;
  };

  const normalizeRewriteFramework = (text: string): string => {
    if (!text) return text;
    let out = text;

    // 超过第9节/堂课时直接截断
    const invalidLesson = out.match(/(?:^|\n)\s*第\s*(?:10|1[1-9]|[2-9]\d|十|十一|十二|十三|十四|十五|十六|十七|十八|十九|二十)\s*(?:节课|堂课)/mi);
    if (invalidLesson && typeof invalidLesson.index === 'number') {
      out = out.slice(0, invalidLesson.index).trim();
    }

    const hasNine = hasAllNineLessons(out);

    // 若未完成9节课，移除提前收尾语，避免被截断
    if (!hasNine) {
      out = out
        .replace(/下期再见[！!。,.，]*/gi, '')
        .replace(/下期再見[！!。,.，]*/gi, '')
        .replace(/下课[！!。,.，]*/gi, '')
        .replace(/下課[！!。,.，]*/gi, '')
        .replace(/今天就到这里[！!。,.，]*/gi, '')
        .replace(/今天就到這[！!。,.，]*/gi, '')
        .trim();
      return out;
    }

    // 若出现收尾词，仅保留到第一次收尾句末，避免“下期再见”后继续输出
    const endingMatch = out.match(/(下期再见|下期再見|下课|下課|今天就到这里|今天就到這)[^。！？.!?]*[。！？.!?]/i);
    if (endingMatch && typeof endingMatch.index === 'number') {
      out = out.slice(0, endingMatch.index + endingMatch[0].length).trim();
    }

    return out;
  };

  const truncateToLength = (text: string, maxChars: number): string => {
    if (!text || text.length <= maxChars) return text;
    const slice = text.slice(0, maxChars);
    const lastPunct = Math.max(
      slice.lastIndexOf('。'),
      slice.lastIndexOf('！'),
      slice.lastIndexOf('？'),
      slice.lastIndexOf('.'),
      slice.lastIndexOf('!'),
      slice.lastIndexOf('?')
    );
    return (lastPunct > 0 ? slice.slice(0, lastPunct + 1) : slice).trim();
  };

  function isTextLikelyComplete(text: string): boolean {
    const t = (text || '').trim();
    if (!t) return false;
    const hasEndingPunct = /[。！？.!?]$/.test(t);
    const looksAbrupt = /(因此|所以|但是|然而|并且|同时|另外|此外|尤其是|如果|因为|比如|例如|首先|其次|最后)$/i.test(t);
    return hasEndingPunct && !looksAbrupt;
  }

  const getCompletenessScore = (text: string): number => {
    const t = (text || '').trim();
    if (!t) return 0;

    let score = 0;
    const hasEndingPunct = /[。！？.!?]$/.test(t);
    const paragraphCount = t.split(/\n+/).map(s => s.trim()).filter(Boolean).length;
    const sentenceCount = t.split(/[。！？.!?]+/).map(s => s.trim()).filter(Boolean).length;
    const looksAbrupt = /(例如|比如|首先|其次|最后|综上|总之|因此|所以|但|然而|并且|同时|以及|另外|此外|可见|这说明|换句话说)$/i.test(t);

    if (hasEndingPunct) score += 2;
    if (paragraphCount >= 2) score += 1;
    if (sentenceCount >= 5) score += 1;
    if (!looksAbrupt) score += 1;

    return score;
  };

  const normalizeSummarizeOutput = (text: string, summarizeNiche?: NicheType): string => {
    if (!text) return text;
    let body =
      summarizeNiche === NicheType.MINDFUL_PSYCHOLOGY
        ? stripMindfulPawsSummarizePreamble(text)
        : text;
    const lines = body.split('\n');

    // 1) 热门标签强制带 #
    let inTagBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(熱門標籤|热门标签)[：:]?\s*$/i.test(line)) {
        inTagBlock = true;
        continue;
      }
      if (inTagBlock && /^\s*$/.test(line)) {
        inTagBlock = false;
        continue;
      }
      if (inTagBlock) {
        lines[i] = line.replace(/(^|\s)([^#\s][^\s]*)/g, (m, p1, p2) => {
          if (/^[#＃]/.test(p2)) return `${p1}${p2}`;
          return `${p1}#${p2}`;
        });
      }
    }

    // 2) 爆款标题/封面文案中第一人称替换为「倪师」
    let inTitleOrCover = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/爆款标题|爆款標題|封面标题文案|封面標題文案|封面文案/.test(line)) {
        inTitleOrCover = true;
        continue;
      }
      if (inTitleOrCover && /^\s*$/.test(line)) {
        inTitleOrCover = false;
        continue;
      }
      if (inTitleOrCover) {
        lines[i] = line
          .replace(/\b我\b/g, '倪师')
          .replace(/我们|我們|咱们|咱們|本人/g, '倪师');
      }
    }

    return lines.join('\n');
  };

  // 清理Markdown格式符号，输出纯文本（保留编号格式）
  const cleanMarkdownFormat = (text: string, mode?: ToolMode, nicheOverride?: NicheType): string => {
    if (!text) return '';
    const effectiveNiche = nicheOverride ?? niche;
    let cleaned = text
      // 移除Markdown标题标记
      .replace(/^#{1,6}\s+/gm, '')
      // 移除续写占位标记
      .replace(/^\s*生成中\s*$/gm, '')
      // 移除所有Markdown特殊符号
      .replace(/\*\*/g, '') // 移除 **粗体**
      .replace(/\*/g, '') // 移除 *斜体*（但要保留编号中的点，所以先处理**）
      .replace(/__/g, '') // 移除 __粗体__
      .replace(/_/g, '') // 移除 _斜体_
      .replace(/~~/g, '') // 移除 ~~删除线~~
      .replace(/~/g, '') // 移除 ~删除线~
      .replace(/`/g, '') // 移除 `代码`
      .replace(/<[^>]+>/g, ''); // 移除HTML标签
    
    // 对于脚本模式，保留方括号格式（如[序號]、[名稱]等）
    if (mode === ToolMode.SCRIPT) {
      // 保留方括号格式，只移除链接格式
      cleaned = cleaned.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1'); // 移除链接格式，保留文本
      // 移除续写分隔符行
      cleaned = cleaned
        .replace(/^\s*-{3,}\s*$/gm, '')
        .replace(/^\s*生成中[\s。.!！?？-]*$/gm, '');
      // 清理模型偶发输出的说明/自检文本
      cleaned = cleaned
        .replace(/^\s*\d+\.\s*Review against Constraints[\s\S]*?(?=^\s*\d+\.|^\s*镜头\d+|^\s*鏡頭\d+|^\s*\[角色信息\]|^\s*\[场景信息\]|^\s*\[場景信息\]|$)/gmi, '')
        .replace(/^\s*\d+\.\s*Final Polish[\s\S]*?(?=^\s*\d+\.|^\s*镜头\d+|^\s*鏡頭\d+|^\s*\[角色信息\]|^\s*\[场景信息\]|^\s*\[場景信息\]|$)/gmi, '');
      // 不移除方括号格式，保留[序号]、[名称]等
    } else {
      // 其他模式移除方括号格式
      cleaned = cleaned
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // 移除链接格式，保留文本
        .replace(/\[([^\]]+)\]/g, '$1'); // 移除引用链接格式
    }
    
    // 移除无序列表标记（保留编号格式）
    cleaned = cleaned.replace(/^\s*[-*+•]\s+/gm, '');
    
    // 对于摘要模式，保留编号格式（1. 2. 3.等）
    if (mode === ToolMode.SUMMARIZE) {
      // 不移除编号，只清理其他格式
    } else if (mode !== ToolMode.SCRIPT) {
      // 脚本模式也保留编号格式（镜头序号）
      // 其他模式移除编号格式
      cleaned = cleaned.replace(/^\s*\d+\.\s+/gm, '');
    }
    
    let finalText = cleaned
      // 清理多余空行
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim();

    if (mode === ToolMode.REWRITE && effectiveNiche === NicheType.TCM_METAPHYSICS) {
      finalText = normalizeRewriteFramework(finalText);
    }

    if (mode === ToolMode.SUMMARIZE) {
      finalText = normalizeSummarizeOutput(finalText, effectiveNiche);
    }

    return finalText;
  };

  // 清洗脚本输出，保留镜头、角色信息、场景信息，删除重复镜头和无关内容
  const cleanScriptOutput = (text: string): string => {
    if (!text) return '';
    
    const lines = text.split('\n');
    const cleanedLines: string[] = [];
    let inShot = false;
    let inRoleInfo = false;
    let inSceneInfo = false;
    const seenShots = new Set<number>(); // 记录已见过的镜头号，防止重复
    let currentShotNumber = 0;
    let skipCurrentShot = false; // 标记当前镜头是否需要跳过（重复镜头）
    let sceneInfoComplete = false; // 标记场景信息是否已完成
    let skipInvalidBlock = false; // 标记是否在跳过无效格式块（如【脚本角色清单】）
    const targetShots = scriptShotMode === 'custom'
      ? Math.min(100, Math.max(10, scriptShotCount))
      : Math.min(60, Math.max(30, Math.ceil(inputText.length / 150)));
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // 检测并跳过非模板格式的内容（更全面的检测）
      const invalidPatterns = [
        '【脚本角色清单】', '【脚本场景清单】',
        '----', // 分隔符
        /^角色\d+:/,  // 角色1:、角色2:等
        /^场景\d+:/,  // 场景1:、场景2:等
        /^性别:/,     // 性别: 男
        /^年龄:/,     // 年龄: 90岁
        /^外貌特征:/,  // 外貌特征: ...
        /^性格特征:/,  // 性格特征: ...
        /^语言风格:/,  // 语言风格: ...
        /^描述:/      // 描述: (作为独立行，不是[描述])
      ];
      
      const isInvalidLine = invalidPatterns.some(pattern => {
        if (typeof pattern === 'string') {
          return line === pattern;
        } else {
          return pattern.test(line);
        }
      });
      
      if (isInvalidLine) {
        console.log(`[cleanScriptOutput] 跳过非模板格式内容: ${line}`);
        skipInvalidBlock = true;
        continue;
      }
      
      // 检测是否回到有效内容（镜头、角色信息、场景信息）
      if (skipInvalidBlock) {
        // 检查是否遇到模板格式的开始标记
        if (/^镜头\d+|^鏡頭\d+/.test(line) || 
            line === '[角色信息]' || 
            line === '[场景信息]' || line === '[場景信息]' ||
            /^\[(名称|名稱|别名|別名|描述)\]/.test(line)) {
          skipInvalidBlock = false;
          console.log(`[cleanScriptOutput] 回到有效内容: ${line}`);
          // 继续处理该行
        } else {
          // 继续跳过非模板内容
          continue;
        }
      }
      
      // 自定义镜头数：未达标时，禁止进入角色/场景信息
      const shotCountSoFar = seenShots.size;
      if (scriptShotMode === 'custom' && shotCountSoFar < targetShots) {
        if (line === '[角色信息]' || line === '[场景信息]' || line === '[場景信息]') {
          skipInvalidBlock = true;
          console.log(`[cleanScriptOutput] 自定义镜头未达标(${shotCountSoFar}/${targetShots})，丢弃角色/场景信息`);
          continue;
        }
      }
      
      // 检测角色信息开始（兼容无方括号标题）
      if (line === '[角色信息]' || line === '角色信息') {
        inShot = false;
        inRoleInfo = true;
        inSceneInfo = false;
        skipCurrentShot = false;
        cleanedLines.push(lines[i]);
        continue;
      }
      
      // 检测场景信息开始（兼容无方括号标题）
      if (line === '[场景信息]' || line === '[場景信息]' || line === '场景信息' || line === '場景信息') {
        inShot = false;
        inRoleInfo = false;
        inSceneInfo = true;
        skipCurrentShot = false;
        cleanedLines.push(lines[i]);
        continue;
      }
      
      // 自定义镜头数：未达标时，丢弃非模板角色信息内容
      if (scriptShotMode === 'custom' && shotCountSoFar < targetShots && (inRoleInfo || inSceneInfo)) {
        continue;
      }
      
      // 如果在角色信息块内
      if (inRoleInfo) {
        // 检查是否遇到场景信息（表示角色信息块结束）
        if (line === '[场景信息]' || line === '[場景信息]' || line === '场景信息' || line === '場景信息') {
          inRoleInfo = false;
          inSceneInfo = true;
          cleanedLines.push(lines[i]);
          continue;
        }
        
        // 修复：如果字段挤在一起（如 [名称]xxx[别名]xxx[描述]xxx），需要拆分
        const fieldPattern = /\[(名称|名稱|别名|別名|描述)\]([^\[]*)/g;
        const matches = Array.from(line.matchAll(fieldPattern));
        
        if (matches.length > 1) {
          // 多个字段挤在一行，需要拆分
          console.log(`[cleanScriptOutput] 角色信息：检测到字段挤在一起，拆分: ${line.substring(0, 50)}...`);
          matches.forEach(match => {
            const fieldName = match[1];
            const fieldContent = match[2].trim();
            cleanedLines.push(`[${fieldName}]${fieldContent}`);
          });
        } else {
          // 单个字段，正常处理
          cleanedLines.push(lines[i]);
        }
        continue;
      }
      
      // 如果在场景信息块内
      if (inSceneInfo) {
        // 场景信息后若又出现镜头，说明模型续写越界，直接截断后续内容
        if (/^(?:镜头|鏡頭)\d+/.test(line)) {
          console.log('[cleanScriptOutput] 场景信息后检测到镜头，截断后续越界内容');
          break;
        }

        // 兼容无方括号字段写法，统一转为模板字段
        if (/^名称\s+/.test(line)) {
          cleanedLines.push(`[名称]${line.replace(/^名称\s+/, '').trim()}`);
          continue;
        }
        if (/^别名\s+/.test(line)) {
          cleanedLines.push(`[别名]${line.replace(/^别名\s+/, '').trim()}`);
          continue;
        }
        if (/^描述\s+/.test(line)) {
          cleanedLines.push(`[描述]${line.replace(/^描述\s+/, '').trim()}`);
          continue;
        }

        // 修复：如果字段挤在一起（如 [名称]xxx[别名]xxx[描述]xxx），需要拆分
        const fieldPattern = /\[(名称|名稱|别名|別名|描述)\]([^\[]*)/g;
        const matches = Array.from(line.matchAll(fieldPattern));
        
        if (matches.length > 1) {
          // 多个字段挤在一行，需要拆分
          console.log(`[cleanScriptOutput] 场景信息：检测到字段挤在一起，拆分: ${line.substring(0, 50)}...`);
          matches.forEach(match => {
            const fieldName = match[1];
            const fieldContent = match[2].trim();
            cleanedLines.push(`[${fieldName}]${fieldContent}`);
          });
        } else {
          // 单个字段，正常处理
          cleanedLines.push(lines[i]);
        }
        
        // 检测场景信息是否已完成（已有至少一个完整的场景条目）
        // 当遇到连续空行或者下一个不相关的内容时，认为场景信息完成
        if (/^\[(描述)\]/.test(line)) {
          // 刚输出了描述字段，下一个条目可能是另一个场景或结束
          // 继续等待，看看是否有下一个 [名称]
        }
        continue;
      }
      
      // 检测镜头开始
      const shotMatch = line.match(/^(?:镜头|鏡頭)(\d+)/);
      if (shotMatch) {
        const shotNum = parseInt(shotMatch[1]);
        
        // 检查是否重复镜头
        if (seenShots.has(shotNum)) {
          console.log(`[cleanScriptOutput] 跳过重复镜头: ${shotNum}`);
          skipCurrentShot = true; // 标记需要跳过这个镜头的所有内容
          inShot = false;
          continue;
        }

        // 自定义镜头数：超过目标镜头数直接丢弃并终止后续（防止22、23镜头继续污染）
        if (scriptShotMode === 'custom' && seenShots.size >= targetShots) {
          console.log(`[cleanScriptOutput] 超出目标镜头数(${targetShots})，从镜头${shotNum}开始截断后续内容`);
          break;
        }
        
        seenShots.add(shotNum);
        currentShotNumber = shotNum;
        inShot = true;
        skipCurrentShot = false;
        cleanedLines.push(lines[i]);
        continue;
      }
      
      // 如果当前镜头需要跳过，则跳过所有相关行
      if (skipCurrentShot) {
        continue;
      }
      
      // 如果在镜头块内，只保留镜头模板字段，过滤无关文案
      if (inShot) {
        if (!line) {
          cleanedLines.push(lines[i]);
          continue;
        }
        if (/^(?:镜头|鏡頭)\d+/.test(line)) {
          cleanedLines.push(lines[i]);
          continue;
        }
        if (/^(镜头文案|圖片提示词|图片提示词|视频提示词|视频提示词|景别|景別|语音分镜|語音分鏡|音效)[：:]/.test(line)) {
          cleanedLines.push(lines[i]);
          // 关键兜底：检测到音效行后，当前镜头视为完整结束，避免后续说明文本混入镜头体导致误判不完整
          if (/^音效[：:]/.test(line)) {
            inShot = false;
          }
        }
        continue;
      }
      
      // 如果行包含镜头相关字段（镜头文案、图片提示词等），也保留
      if (/^(镜头文案|圖片提示词|图片提示词|视频提示词|视频提示词|景别|景別|语音分镜|語音分鏡|音效)[：:]/.test(line)) {
        cleanedLines.push(lines[i]);
        continue;
      }
      
      // 如果行包含角色或场景信息字段，也保留
      // 修复：如果字段挤在一起（如 [名称]xxx[别名]xxx[描述]xxx），需要拆分
      if (/^\[(名称|名稱|别名|別名|描述)\]/.test(line)) {
        // 检查是否有多个字段挤在一行（如 [名称]医生[别名]倪医生[描述]...）
        const fieldPattern = /\[(名称|名稱|别名|別名|描述)\]([^\[]*)/g;
        const matches = Array.from(line.matchAll(fieldPattern));
        
        if (matches.length > 1) {
          // 多个字段挤在一行，需要拆分
          console.log(`[cleanScriptOutput] 检测到字段挤在一起，拆分: ${line.substring(0, 50)}...`);
          matches.forEach(match => {
            const fieldName = match[1];
            const fieldContent = match[2].trim();
            cleanedLines.push(`[${fieldName}]${fieldContent}`);
          });
        } else {
          // 单个字段，正常处理
          cleanedLines.push(lines[i]);
        }
        continue;
      }
      
      // 其他行跳过（删除不相关信息）
    }
    
    // 检测场景信息是否真正完成（有[场景信息]标记）
    let finalText = cleanedLines.join('\n');
    if (finalText.includes('[场景信息]') || finalText.includes('[場景信息]')) {
      sceneInfoComplete = true;
      console.log(`[cleanScriptOutput] 场景信息已完成，已清洗后续多余内容`);
    }

    const normalizeInfoBlock = (blockText: string, blockLabel: '[角色信息]' | '[场景信息]'): string => {
      if (!blockText) return '';
      const lines = blockText.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length === 0) return '';

      const entries: Array<{ name: string; alias: string; desc: string }> = [];
      let current: { name: string; alias: string; desc: string } | null = null;

      const flush = () => {
        if (current && (current.name || current.alias || current.desc)) {
          entries.push({
            name: current.name || '',
            alias: current.alias || '',
            desc: current.desc || ''
          });
        }
        current = null;
      };

      for (const line of lines) {
        if (line === '[角色信息]' || line === '[场景信息]' || line === '[場景信息]' || line === '生成中') continue;

        const fieldMatch = line.match(/^\[(名称|名稱|别名|別名|描述)\](.*)$/);
        if (fieldMatch) {
          if (!current) current = { name: '', alias: '', desc: '' };
          const field = fieldMatch[1];
          const value = fieldMatch[2].trim();
          if (field === '名称' || field === '名稱') current.name = value;
          if (field === '别名' || field === '別名') current.alias = value;
          if (field === '描述') current.desc = value;
          continue;
        }

        // 非模板行：按顺序推断 [名称] -> [别名] -> [描述]
        if (!current) current = { name: '', alias: '', desc: '' };
        if (!current.name) {
          current.name = line;
        } else if (!current.alias) {
          current.alias = line;
        } else {
          current.desc = current.desc ? `${current.desc}${current.desc.endsWith('。') ? '' : '。'}${line}` : line;
        }
      }
      flush();

      if (entries.length === 0) return '';
      const formatted = entries
        .filter(entry => entry.name || entry.alias || entry.desc)
        .map(entry => {
          return [
            `[名称]${entry.name}`,
            `[别名]${entry.alias}`,
            `[描述]${entry.desc}`
          ].join('\n');
        })
        .join('\n\n');

      return formatted ? `${blockLabel}\n${formatted}` : '';
    };

    const roleBlockPattern = /\[角色信息\][\s\S]*?(?=\[场景信息\]|\[場景信息\]|$)/;
    const sceneBlockPattern = /\[(?:场景信息|場景信息)\][\s\S]*$/;
    const rawRoleBlock = finalText.match(roleBlockPattern)?.[0] || '';
    const rawSceneBlock = finalText.match(sceneBlockPattern)?.[0] || '';

    const normalizedRole = normalizeInfoBlock(rawRoleBlock, '[角色信息]');
    const normalizedScene = normalizeInfoBlock(rawSceneBlock.replace('[場景信息]', '[场景信息]'), '[场景信息]');

    if (rawRoleBlock || rawSceneBlock) {
      finalText = finalText
        .replace(roleBlockPattern, '')
        .replace(sceneBlockPattern, '')
        .trim();
      const normalizedBlocks = [normalizedRole, normalizedScene].filter(Boolean).join('\n\n');
      finalText = normalizedBlocks ? `${finalText}\n${normalizedBlocks}`.trim() : finalText;
      console.log('[cleanScriptOutput] 角色/场景信息已按模板格式重排（不改内容）');
    }
    
    console.log(`[cleanScriptOutput] 保留的镜头数量: ${seenShots.size}, 镜头编号: ${Array.from(seenShots).sort((a,b)=>a-b).join(', ')}`);
    return finalText;
  };

  // 检查是否有提前的收尾词（字数不足时不应该出现）
  const hasPrematureEnding = (text: string): boolean => {
    const endingKeywords = [
      /下課/i,
      /下课/i,
      /散會/i,
      /散会/i,
      /下期再見/i,
      /下期再见/i,
      /今天就到這/i,
      /今天就到这/i,
      /咱們下次/i,
      /咱们下次/i,
    ];
    return endingKeywords.some(pattern => pattern.test(text));
  };

  const getUniqueShotCount = (text: string): number => {
    // 只统计“镜头序号行”，避免把镜头文案或说明文字里的“镜头14”误计入
    const headerPattern = /^\s*(?:镜头|鏡頭)(\d+)\s*$/gm;
    const numbers = new Set<number>();
    let m: RegExpExecArray | null;
    while ((m = headerPattern.exec(text)) !== null) {
      const num = parseInt(m[1], 10);
      if (!Number.isNaN(num)) numbers.add(num);
    }
    return numbers.size;
  };

  // 检测并清理不完整的镜头（脚本模式专用）
  const cleanIncompleteShot = (text: string): { cleaned: string; lastShotNumber: number; needsRework: boolean } => {
    // 匹配镜头标题行格式：镜头[数字] 或 鏡頭[数字]
    const shotPattern = /^\s*(?:镜头|鏡頭)(\d+)\s*$/gm;
    const shots: Array<{ number: number; startIndex: number }> = [];
    let match;
    const shotMatches: RegExpExecArray[] = [];
    
    // 收集所有镜头匹配
    while ((match = shotPattern.exec(text)) !== null) {
      shotMatches.push(match);
      shots.push({ 
        number: parseInt(match[1]), 
        startIndex: match.index 
      });
    }
    
    if (shots.length === 0) {
      return { cleaned: text, lastShotNumber: 0, needsRework: false };
    }
    
    // 检查最后一个“有效镜头号”是否完整（按最大镜头号判定，避免被重复的旧镜头干扰）
    const maxShotNumber = Math.max(...shots.map(s => s.number));
    const maxShotCandidates = shots.filter(s => s.number === maxShotNumber);
    const lastShot = maxShotCandidates.reduce((prev, curr) => (curr.startIndex > prev.startIndex ? curr : prev));
    const lastShotStart = lastShot.startIndex;
    // 查找最后一个镜头的结束位置（下一个镜头开始或文本末尾）
    let lastShotEnd = text.length;
    // 检查是否有角色信息或场景信息开始
    const roleInfoIndex = text.indexOf('[角色信息]', lastShotStart);
    const sceneInfoIndex = text.indexOf('[场景信息]', lastShotStart);
    const sceneInfoIndex2 = text.indexOf('[場景信息]', lastShotStart);
    
    if (roleInfoIndex > lastShotStart && roleInfoIndex < lastShotEnd) {
      lastShotEnd = roleInfoIndex;
    }
    if (sceneInfoIndex > lastShotStart && sceneInfoIndex < lastShotEnd) {
      lastShotEnd = sceneInfoIndex;
    }
    if (sceneInfoIndex2 > lastShotStart && sceneInfoIndex2 < lastShotEnd) {
      lastShotEnd = sceneInfoIndex2;
    }
    
    const lastShotContent = text.substring(lastShotStart, lastShotEnd);
    
    // 检查是否包含所有必需字段（简体优先）
    const requiredFields = [
      { zh: '镜头文案', tw: '鏡頭文案' },
      { zh: '图片提示词', tw: '圖片提示词' },
      { zh: '视频提示词', tw: '视频提示词' },
      { zh: '景别', tw: '景別' },
      { zh: '语音分镜', tw: '語音分鏡' },
      { zh: '音效', tw: '音效' }
    ];
    
    const hasAllFields = requiredFields.every(field => 
      lastShotContent.includes(field.zh) || lastShotContent.includes(field.tw)
    );
    
    // 检查最后一个字段（音效）是否完整（有值，不是空行）
    const hasCompleteLastField = /音效[：:]\s*[^\n\r]+/.test(lastShotContent);
    
    // 检查镜头内容是否被截断
    // 只有在缺少字段或最后字段不完整时，才检查长度
    // 如果所有字段都存在且最后字段完整，则认为镜头完整，不管长度
    let isTruncated = false;
    if (!hasAllFields || !hasCompleteLastField) {
      // 如果字段不完整，检查长度是否过短（可能被截断）
      isTruncated = lastShotContent.length < 150; // 放宽到150字符
    }
    
    // 不再用“每镜头字数范围”判定镜头是否不完整：
    // 真实生产中模型会出现镜头长短不均，若强制按范围回收，会导致镜头反复被删除并卡循环。
    // 仅以“字段完整性 + 末字段完整 + 明显截断”作为回收条件。
    if (!hasAllFields || !hasCompleteLastField || isTruncated) {
      // 删除不完整的最后一个镜头
      const cleaned = text.substring(0, lastShotStart).trim();
      console.log(`[cleanIncompleteShot] 镜头${lastShot.number}不完整: hasAllFields=${hasAllFields}, hasCompleteLastField=${hasCompleteLastField}, isTruncated=${isTruncated}, length=${lastShotContent.length}`);
      return { cleaned, lastShotNumber: lastShot.number, needsRework: true };
    }
    
    return { cleaned: text, lastShotNumber: lastShot.number, needsRework: false };
  };

  const patchIncompleteLastShot = (text: string): string => {
    const shotPattern = /^\s*(?:镜头|鏡頭)(\d+)\s*$/gm;
    const shots: Array<{ number: number; startIndex: number }> = [];
    let m;
    while ((m = shotPattern.exec(text)) !== null) {
      shots.push({ number: parseInt(m[1]), startIndex: m.index });
    }
    if (shots.length === 0) return text;

    const lastShot = shots[shots.length - 1];
    const start = lastShot.startIndex;
    let end = text.length;
    const roleInfoIndex = text.indexOf('[角色信息]', start);
    const sceneInfoIndex = text.indexOf('[场景信息]', start);
    const sceneInfoIndex2 = text.indexOf('[場景信息]', start);
    if (roleInfoIndex > start && roleInfoIndex < end) end = roleInfoIndex;
    if (sceneInfoIndex > start && sceneInfoIndex < end) end = sceneInfoIndex;
    if (sceneInfoIndex2 > start && sceneInfoIndex2 < end) end = sceneInfoIndex2;

    const block = text.substring(start, end).trimEnd();
    if (!/镜头文案[：:]/.test(block)) return text;

    let patched = block;
    if (!/图片提示词[：:]/.test(patched) && !/圖片提示词[：:]/.test(patched)) {
      patched += '\n图片提示词: 中景, 根据镜头文案提炼核心场景元素, 环境叙事氛围';
    }
    if (!/视频提示词[：:]/.test(patched)) {
      patched += '\n视频提示词: 8s: 根据镜头文案呈现场景与动作重点, 固定机位';
    }
    if (!/景别[：:]/.test(patched) && !/景別[：:]/.test(patched)) {
      patched += '\n景别: 中景';
    }
    if (!/语音分镜[：:]/.test(patched) && !/語音分鏡[：:]/.test(patched)) {
      patched += '\n语音分镜: 旁白';
    }
    if (!/音效[：:]/.test(patched)) {
      patched += '\n音效: 背景环境音';
    }

    return `${text.substring(0, start)}${patched}${text.substring(end)}`;
  };

  const normalizeForCompare = (s: string): string => s.replace(/\s+/g, '').replace(/[“”"「」]/g, '');

  const hasRoleInfoBlock = (text: string): boolean => {
    return text.includes('[角色信息]') || /(^|\n)\s*角色信息\s*(\n|$)/.test(text);
  };

  const hasSceneInfoBlock = (text: string): boolean => {
    return text.includes('[场景信息]') || text.includes('[場景信息]') || /(^|\n)\s*(场景信息|場景信息)\s*(\n|$)/.test(text);
  };

  const getLastShotMeta = (text: string): { number: number; startIndex: number } | null => {
    const shotPattern = /^\s*(?:镜头|鏡頭)(\d+)\s*$/gm;
    const shots: Array<{ number: number; startIndex: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = shotPattern.exec(text)) !== null) {
      shots.push({ number: parseInt(m[1], 10), startIndex: m.index });
    }
    if (shots.length === 0) return null;
    const maxNum = Math.max(...shots.map(s => s.number));
    const candidates = shots.filter(s => s.number === maxNum);
    return candidates.reduce((prev, curr) => (curr.startIndex > prev.startIndex ? curr : prev));
  };

  const getLastShotText = (text: string): string => {
    const lastShot = getLastShotMeta(text);
    if (!lastShot) return '';

    const start = lastShot.startIndex;
    let end = text.length;
    const roleInfoIndex = text.indexOf('[角色信息]', start);
    const sceneInfoIndex = text.indexOf('[场景信息]', start);
    const sceneInfoIndex2 = text.indexOf('[場景信息]', start);
    if (roleInfoIndex > start && roleInfoIndex < end) end = roleInfoIndex;
    if (sceneInfoIndex > start && sceneInfoIndex < end) end = sceneInfoIndex;
    if (sceneInfoIndex2 > start && sceneInfoIndex2 < end) end = sceneInfoIndex2;

    const block = text.substring(start, end);
    const quoted = block.match(/镜头文案[：:][\s\S]*?[“"「]([\s\S]*?)[”"」]/);
    if (quoted?.[1] !== undefined) return quoted[1];
    const plain = block.match(/镜头文案[：:]\s*([^\n\r]+)/);
    return plain?.[1] || '';
  };

  const isLastShotTailAligned = (scriptText: string, originalText: string): boolean => {
    if (!scriptText || !originalText) return false;
    const lastShotRaw = getLastShotText(scriptText);
    const tailRaw = originalText.slice(-Math.max(260, lastShotRaw.length));
    const lastShot = normalizeForCompare(lastShotRaw);
    const tail = normalizeForCompare(tailRaw);
    if (!lastShot || !tail) return false;

    // 强对齐：完整尾部匹配
    if (tail.length >= lastShot.length && tail.endsWith(lastShot)) return true;
    if (lastShot.length >= tail.length && lastShot.endsWith(tail)) return true;

    // 兜底：至少要求尾部关键后缀严格对齐，避免“看起来对齐但因前段细微差异卡死”
    const suffixLen = Math.min(120, tail.length, lastShot.length);
    if (suffixLen >= 60) {
      return tail.slice(-suffixLen) === lastShot.slice(-suffixLen);
    }

    return false;
  };

  const getCopiedTextLength = (text: string): number => {
    let copiedTextLength = 0;
    const shotPattern = /^\s*(?:镜头|鏡頭)(\d+)\s*$/gm;
    const starts: number[] = [];
    let m: RegExpExecArray | null;

    while ((m = shotPattern.exec(text)) !== null) {
      starts.push(m.index);
    }

    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      const end = i + 1 < starts.length ? starts[i + 1] : text.length;
      const block = text.substring(start, end);

      const quoted = block.match(/镜头文案[：:][\s\S]*?[“"「]([\s\S]*?)[”"」]/);
      if (quoted?.[1] !== undefined) {
        copiedTextLength += quoted[1].length;
        continue;
      }

      const plain = block.match(/镜头文案[：:]\s*([^\n\r]+)/);
      if (plain?.[1] !== undefined) {
        copiedTextLength += plain[1].length;
      }
    }

    return copiedTextLength;
  };

  const getScriptConsistencyDebug = (scriptText: string, originalText: string) => {
    const copied = getCopiedTextLength(scriptText);
    const original = originalText.length;
    const diff = copied - original;
    const lastShotRaw = getLastShotText(scriptText);
    const lastShotLen = lastShotRaw.length;
    const tailAligned = isLastShotTailAligned(scriptText, originalText);
    const shotCount = getUniqueShotCount(scriptText);
    const hasRoleInfo = hasRoleInfoBlock(scriptText);
    const hasSceneInfo = hasSceneInfoBlock(scriptText);
    return {
      shotCount,
      copied,
      original,
      diff,
      progress: original > 0 ? `${((copied / original) * 100).toFixed(1)}%` : '0% ',
      lastShotLen,
      tailAligned,
      hasRoleInfo,
      hasSceneInfo,
    };
  };

  // 检查内容是否完整（是否有明确的结尾）
  const isContentComplete = (text: string, mode: ToolMode, originalLength: number, niche?: NicheType): boolean => {
    if (mode === ToolMode.SUMMARIZE) {
      // 摘要模式：检查是否有标签部分（表示完整输出）
      // 如果有"熱門標籤"或"#"，肯定是完整的
      if (text.includes('熱門標籤') || text.includes('#')) {
        return true;
      }
      // 如果没有标签，但包含关键部分（核心主題、YouTube 爆款标题、视频簡介、核心知識點等），也认为是完整的
      // 因为有些情况下可能标签部分被省略或格式不同
      const hasCoreTheme = text.includes('核心主題') || text.includes('核心主题');
      const hasTitles = text.includes('YouTube 爆款标题') || text.includes('YouTube 爆款标题') || text.includes('标题') || text.includes('标题');
      const hasDescription = text.includes('视频簡介') || text.includes('视频简介');
      // 新模板使用"核心知識點"，旧模板使用"核心要點"
      const hasKeyPoints = text.includes('核心要點') || text.includes('核心要点') || text.includes('核心知識點');
      // 检查是否有时间轴导航（新模板特有）
      const hasTimeline = text.includes('精彩時間軸導航') || text.includes('精彩时间轴导航') || text.includes('👇');
      // 检查是否有免责声明（新模板特有）
      const hasDisclaimer = text.includes('免責聲明') || text.includes('免责声明');

      // 新模板检查：包含时间轴或免责声明 + 核心知识点 = 完整
      if ((hasTimeline || hasDisclaimer) && hasKeyPoints) {
        console.log('[isContentComplete] 摘要模式：新模板格式完整');
        return true;
      }

      // 旧模板检查：如果包含至少3个关键部分，且内容长度合理（至少500字符），认为完整
      const keyPartsCount = [hasCoreTheme, hasTitles, hasDescription, hasKeyPoints].filter(Boolean).length;
      if (keyPartsCount >= 3 && text.length >= 500) {
        console.log('[isContentComplete] 摘要模式：缺少标签但包含关键部分，认为完整');
        return true;
      }
      // 如果内容很长（超过2000字符），即使没有标签也认为是完整的
      if (text.length >= 2000) {
        console.log('[isContentComplete] 摘要模式：内容长度足够，认为完整');
        return true;
      }
      return false;
    }
    
    if (mode === ToolMode.SCRIPT) {
      // 脚本模式：检查场景信息是否已输出（最关键的完成标志）
      const hasRoleInfo = hasRoleInfoBlock(text);
      const hasSceneInfo = hasSceneInfoBlock(text);
      
      const shotCount = getUniqueShotCount(text);
      const targetShots = scriptShotMode === 'custom'
        ? Math.min(100, Math.max(10, scriptShotCount))
        : Math.min(60, Math.max(30, Math.ceil(originalLength / 150)));
      
      // 不能仅凭角色/场景信息提前判定完成，必须通过尾部对齐和字数搬运校验
      
      // 检查是否有未完成的标记（----表示还需要续写）
      const hasIncompleteMarker = text.includes('生成中') || text.includes('----');
      
      // 如果有未完成标记，说明不完整
      if (hasIncompleteMarker) return false;

      // 自定义镜头数：镜头数不等于目标即视为不完整
      if (scriptShotMode === 'custom' && shotCount !== targetShots) {
        return false;
      }
      
      // 如果镜头数量为0，说明还没开始输出，不算完整
      if (shotCount === 0) return false;
      
      // 检查最后一个镜头是否完整
      const { needsRework } = cleanIncompleteShot(text);
      if (needsRework) return false;
      
      const copiedTextLength = getCopiedTextLength(text);
      console.log(`[isContentComplete] 已搬运原文: ${copiedTextLength}/${originalLength} 字 (${(copiedTextLength/originalLength*100).toFixed(1)}%)`);
      
      // ✅ 原文搬运达到或超过 100%，且最后镜头与原文末尾对齐，优先进入收尾
      if (copiedTextLength >= originalLength) {
        const tailAligned = isLastShotTailAligned(text, originalScriptInputRef.current || '');
        console.log(`[isContentComplete] 原文已搬运完毕（>=100%），尾部对齐=${tailAligned}`);
        return tailAligned && hasRoleInfo && hasSceneInfo;
      }
      
      // ⚠️ 关键：如果已搬运的文案长度 >= 原文长度的95%，需先验证最后镜头是否覆盖原文末尾
      if (copiedTextLength >= originalLength * 0.95) {
        const tailAligned = isLastShotTailAligned(text, originalScriptInputRef.current || '');
        console.log(`[isContentComplete] 原文已基本搬运完毕（${copiedTextLength}/${originalLength}字），尾部对齐=${tailAligned}`);
        return tailAligned && hasRoleInfo && hasSceneInfo;
      }
      
      // 其他情况：继续生成
      return false;
    }
    
    // 其他模式：检查字数和结尾完整性
    const length = text.length;
    const hasProperEnding = /[。！？.!?]$/.test(text.trim()); // 以标点结尾
    const notTruncated = !text.endsWith('...') && !text.endsWith('…');
    
    if (mode === ToolMode.REWRITE || mode === ToolMode.POLISH) {
      // 改写和润色：必须字数>=原文的90%才认为完整
      // 如果字数不足但出现了收尾词，说明提前结束了，需要继续
      const reachedMinimum = length >= originalLength * 0.9;
      const reachedTarget = length >= originalLength * 0.95;
      
      // 如果字数不足90%，即使有收尾标点也不算完整
      if (!reachedMinimum) {
        return false;
      }

      // 中医玄学改写：强制校验内容充实度，避免只输出开头就收尾
      // 新版已移除"第X节课"固定标记，改为检测内容完整性和充实度
      if (mode === ToolMode.REWRITE && niche === NicheType.TCM_METAPHYSICS) {
        const hasOpening = /各位老友们好.*倪海厦/.test(text);
        const hasStartLine = /好了.*我们开始上课/.test(text);
        if (!hasOpening) return false;
        if (!hasStartLine) return false;
        
        const tcmMinLength = 7500;
        const tcmMaxLength = 8500;
        const hasMinLength = length >= tcmMinLength;
        const hasMaxLength = length <= tcmMaxLength;
        
        // 新版检查：末尾300字包含收尾关键词才认为有实质性结尾
        const tail = text.slice(-300);
        const hasRealEnding = /下课|下期再见|下期再見|散会|散會|好了.*话讲完了/.test(tail);
        
        console.log(`[isContentComplete] 中医玄学改写检查: 字数=${length}, 最小=${tcmMinLength}, 最大=${tcmMaxLength}, 有开场白=${hasOpening}, 有开始语=${hasStartLine}, 有实质结尾=${hasRealEnding}`);
        
        if (!hasMinLength) {
          console.log(`[isContentComplete] 字数不足 ${tcmMinLength} 字，需要继续生成`);
          return false;
        }
        if (!hasMaxLength) {
          console.log(`[isContentComplete] 字数超过 ${tcmMaxLength} 字，内容过长`);
          return false;
        }
        if (!hasRealEnding) {
          console.log(`[isContentComplete] 没有实质性结尾，需要继续生成`);
          return false;
        }
        
        return hasProperEnding && notTruncated;
      }
      
      // 字数达到90-95%，且有标点结尾，才算完整
      return reachedTarget && hasProperEnding && notTruncated;
    } else if (mode === ToolMode.EXPAND) {
      // 扩写：必须字数>=1.4倍才认为接近完成
      const reachedMinimum = length >= originalLength * 1.4;
      const reachedTarget = length >= originalLength * 1.5;
      
      if (!reachedMinimum) {
        return false;
      }
      
      return reachedTarget && hasProperEnding && notTruncated;
    }

    // 易经命理赛道特判（改写/扩写共用户选赛道）
    if (niche === NicheType.YI_JING_METAPHYSICS) {
      if (mode === ToolMode.REWRITE) {
        const yjRewriteMin = originalLength * 0.9;   // ≥原文90% → 保留80%核心
        const yjRewriteMax = originalLength * 1.1;   // ≤原文110% → 不超10%
        const reachedMin = length >= yjRewriteMin;
        const reachedMax = length <= yjRewriteMax;
        console.log(`[isContentComplete] 易经改写: 字数=${length}, 要求=${yjRewriteMin}-${yjRewriteMax}, reachedMin=${reachedMin}, reachedMax=${reachedMax}`);
        if (!reachedMin) return false;
        if (!reachedMax) return false;
        return hasProperEnding && notTruncated;
      }
      if (mode === ToolMode.EXPAND) {
        const yjExpandMin = Math.max(8000, Math.floor(originalLength * 1.2));
        const yjExpandMax = Math.max(9600, Math.floor(originalLength * 1.5));
        const reachedMin = length >= yjExpandMin;
        const reachedMax = length <= yjExpandMax;
        console.log(`[isContentComplete] 易经扩写: 字数=${length}, 要求≥${yjExpandMin}, reachedMin=${reachedMin}, reachedMax=${reachedMax}`);
        if (!reachedMin) return false;
        if (!reachedMax) return false;
        return hasProperEnding && notTruncated;
      }
    }
    
    return hasProperEnding && notTruncated;
  };

  // 提取YouTube字幕
  const handleExtractTranscript = async () => {
    const videoId = extractYouTubeVideoId(inputText.trim());
    if (!videoId) {
      toast.error('无法识别 YouTube 视频链接，请检查链接格式');
      return;
    }
    
    setIsExtractingTranscript(true);
    toast.info('正在提取 YouTube 视频字幕，请稍候...', 3500);
    
    try {
      const result = await fetchYouTubeTranscript(videoId, gasApiUrl || undefined);
      
      if (result.success && result.transcript) {
        // 将字幕显示在输入框中，并在深度洗稿模式下自动拆分5段
        setInputText(result.transcript);
        if (isDeepRewriteMode) {
          await initializeFiveSegmentsFromText(result.transcript, 'YouTube 字幕提取成功，已自动提炼大纲并拆分为5段。');
        }
        toast.success('字幕提取成功！已自动填入输入框。', 5000);
        console.log(`[Tools] YouTube字幕提取成功，长度: ${result.transcript.length}字`);
      } else {
        // 字幕提取失败，提供手动操作指南
        const manualGuide = `❌ 自动提取字幕失败

📋 请手动提取字幕（2分钟完成）：

**方法1：使用 YouTube 内置字幕**
1. 打开视频：https://www.youtube.com/watch?v=${videoId}
2. 点击视频下方的 "..." 菜单
3. 选择 "显示转录文本" 或 "Show transcript"
4. 复制全部文本
5. 粘贴到输入框中（可以保留或删除 YouTube 链接）

**方法2：使用在线工具**
• DownSub: https://downsub.com/
• SaveSubs: https://savesubs.com/
• 粘贴视频链接，下载 TXT 格式字幕
• 复制内容到输入框

**方法3：使用浏览器扩展**
• Video Transcript（Chrome）
• YouTube Transcript（Firefox）

---
失败原因：${result.error || '未知'}

💡 提示：手动提取后，自动字幕功能仍在开发调试中。`;
        
        toast.error(result.error || '自动提取字幕失败，请改为手动提取', 6000);
        appendTerminal('自动提取字幕失败，已提示手动提取路径。');
        console.error('[Tools] YouTube字幕提取失败:', result.error);
      }
    } catch (error: any) {
      toast.error(`字幕提取异常：${error.message || '未知错误'}`, 6000);
      console.error('[Tools] YouTube字幕提取异常:', error);
    } finally {
      setIsExtractingTranscript(false);
    }
  };

  const handleAction = async () => {
    // ⚠️ 关键：锁定当前任务ID，确保整个生成过程都更新正确的任务
    const currentTaskId = activeTaskId;
    const currentTask = tasks.find(t => t.id === currentTaskId);
    
    if (!apiKey || !currentTask || !currentTask.inputText) return;
    
    // 使用当前任务的输入文本
    const taskInputText = currentTask.inputText;
    const taskMode = currentTask.mode;
    const taskNiche = currentTask.niche;
    const isRevengeScriptTask = false; // 复仇脚本回归通用镜头模板流程（参考金融赛道）
    
    // 更新特定任务的函数
    const updateTask = (updates: Partial<Task>) => {
      setTasks(prev => prev.map(task => 
        task.id === currentTaskId ? { ...task, ...updates } : task
      ));
    };
    
    // 脚本输出模式：不依赖赛道配置，作为独立通用模块
    const nicheConfig = taskMode === ToolMode.SCRIPT
      ? NICHES[NicheType.TCM_METAPHYSICS] // 脚本模式统一使用全局通用模板，不再依赖赛道选择
      : NICHES[taskNiche];
    let localOutput = '';
    let stagnantRounds = 0; // 连续无进展轮次，用于防卡死
    const skippedReworkShots = new Set<number>(); // 已判定反复卡死的镜头，后续跳过回收
    let lastReworkShotNumber = 0;
    let sameShotReworkCount = 0;
    const dynamicTargetShots = scriptShotMode === 'custom'
      ? Math.min(100, Math.max(10, scriptShotCount))
      : Math.min(60, Math.max(30, Math.ceil(taskInputText.length / 150)));
    if (taskMode === ToolMode.SCRIPT && !isRevengeScriptTask) {
      // 二段式输出：无论自动/自定义镜头数，都先做均分切段，供第一段镜头文案使用
      shotSegmentsRef.current = segmentTextByShots(taskInputText, dynamicTargetShots);
    } else {
      shotSegmentsRef.current = null;
    }
    // 中医玄学专用：流式输出去重，防止LLM在续写时重复生成完整文章结构
    const deduplicateStreamingOutput = (text: string): string => {
      if (!text || taskNiche !== NicheType.TCM_METAPHYSICS) return text;

      // 策略A：检测第二个"各位老友"出现位置，只保留第一个
      const openingRe = /各位老友们好[\s\S]{0,100}倪海厦[。！？]/;
      const firstOpeningMatch = openingRe.exec(text);
      if (firstOpeningMatch) {
        const secondPos = text.indexOf('各位老友们好', firstOpeningMatch.index + 1);
        if (secondPos !== -1) {
          // 找到第二个开场白：保留第一个，删除第二个及其后到第一个正文结束之间的内容
          const afterSecond = text.slice(secondPos);
          // 在第一个开场白后找到"好了，我们开始上课。"的第二次出现
          const afterFirst = text.slice(firstOpeningMatch.index + firstOpeningMatch[0].length);
          const secondStartClass = afterFirst.indexOf('好了，我们开始上课');
          if (secondStartClass !== -1) {
            const firstEndClass = afterFirst.indexOf('好了，我们开始上课');
            // 只保留第一个完整结构，删除后续的重复结构
            const keepEnd = firstOpeningMatch.index + firstOpeningMatch[0].length + secondStartClass;
            const restAfterFirst = afterFirst.slice(secondStartClass);
            // 检查restAfterFirst是否看起来像一个完整的新文章开头
            if (/^各位老友们/.test(restAfterFirst) || /^好了，我们开始上课/.test(restAfterFirst)) {
              // 这是一段新文章的过渡语，保留但去掉新文章的开场白
              const newArticleStart = restAfterFirst.search(/[^\s]/);
              if (newArticleStart !== -1 && newArticleStart < 50) {
                // 第二个"开始上课"后面紧跟新内容，很可能是新文章，直接截断
                return text.slice(0, keepEnd).trim();
              }
            }
          }
        }
      }

      // 策略B：检测重复段落（完整的开场+过渡+正文循环）
      // 如果"好了，我们开始上课"出现超过1次，说明有多次课程开头
      const startClassMatches = text.match(/好了，我们开始上课/g);
      if (startClassMatches && startClassMatches.length > 1) {
        // 找到第二个"好了，我们开始上课"的位置
        const firstSC = text.indexOf('好了，我们开始上课');
        const secondSC = text.indexOf('好了，我们开始上课', firstSC + 1);
        if (secondSC !== -1) {
          // 在第二个"好了"之前的内容是完整的，保留
          // 去掉第二个"好了"之后的所有内容（可能包含新文章）
          return text.slice(0, secondSC).trim();
        }
      }

      // 策略C：检测并去除末尾的"文章重复片段"（以"各位老友们好"开头到末尾的片段）
      const lastOpeningIdx = text.lastIndexOf('各位老友们好');
      const firstOpeningIdx = text.indexOf('各位老友们好');
      if (lastOpeningIdx > firstOpeningIdx && lastOpeningIdx > text.length - 500) {
        // 末尾出现新的开场白，说明LLM又开了一篇，截断到第一个开场白之前
        const firstSCAfter = text.indexOf('好了，我们开始上课');
        if (firstSCAfter !== -1 && lastOpeningIdx > firstSCAfter + 50) {
          // 新文章已经开始，截断
          return text.slice(0, lastOpeningIdx).trim();
        }
      }

      return text;
    };

    const MAX_CONTINUATIONS = scriptShotMode === 'custom'
      ? Math.min(30, Math.max(10, dynamicTargetShots))
      : 15; // 自动模式增加到15次（原文较长时需要更多续写）
    let continuationCount = 0;
    
    updateTask({ isGenerating: true, outputText: '' });
    setGenerationProgress({ current: 3, total: 100 }); // 首包未到时避免长时间 0%
    if (taskMode === ToolMode.SCRIPT) {
      setShotPromptProgress({ success: 0, failed: 0, hint: '开始生成镜头提示词...' });
    } else {
      setShotPromptProgress(null);
    }
    
    // 检测是否为YouTube链接
    const isYouTube = isYouTubeLink(taskInputText.trim());
    const videoId = isYouTube ? extractYouTubeVideoId(taskInputText.trim()) : null;
    
    // 如果只有 YouTube 链接，没有其他文本内容，提示用户点击"提取字幕"按钮
    if (isYouTube && videoId) {
      const textWithoutLink = taskInputText.trim().replace(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)[^\s]*/gi, '').trim();
      
      // 如果移除链接后没有其他文本，说明只有链接
      if (!textWithoutLink || textWithoutLink.length < 10) {
        updateTask({ isGenerating: false, outputText: `📺 检测到 YouTube 视频链接\n\n视频ID: ${videoId}\n\n💡 请点击输入框旁的「提取字幕」按钮，系统将自动提取视频字幕并填入输入框。\n\n⚠️ 注意：需要在设置中配置 Google Apps Script API URL 才能使用自动提取功能。` });
        return;
      }
    }
    
    // Inject Niche Persona into the system instruction, enforce Chinese
    // 脚本输出模式：使用全领域万能短视频分镜生成器系统
    let systemInstruction = '';
    if (taskMode === ToolMode.SCRIPT) {
      // 使用全领域万能分镜系统指令
      systemInstruction = SCRIPT_MODE_SYSTEM;
      if (taskMode === ToolMode.SCRIPT) {
        originalScriptInputRef.current = taskInputText;
      }
    } else {
      // 其他模式：使用赛道配置
      if (!nicheConfig) {
        setIsGenerating(false);
        setOutputText('错误：找不到赛道配置');
        return;
      }
      const toolsInputLang = detectToolsInputLanguage(taskInputText);
      const summarizeNeedsEnglish =
        taskMode === ToolMode.SUMMARIZE && /^English/i.test(toolsInputLang);
      if (summarizeNeedsEnglish) {
        systemInstruction = `${nicheConfig.systemInstruction}\nYou are also a professional YouTube packaging editor.\n【Output language · highest priority】This turn is a "summary & optimization" task. The transcript/script is primarily in English. You MUST write the entire response in English (all section headings, titles, description, outline, timestamps, SEO lines, hashtags, cover copy, and image prompts). Do not output body paragraphs in Chinese. Keep proper nouns from the source as needed.`;
      } else {
        systemInstruction = `${nicheConfig.systemInstruction}\n你也是一位专业的内容编辑。请务必使用简体中文输出。`;
      }
    }
    
    // 如果是YouTube链接（且有文本内容），添加特殊说明
    if (isYouTube && videoId) {
      systemInstruction += `\n\n⚠️ 重要提示：用户提供了一個 YouTube 视频链接（视频ID: ${videoId}），同时也提供了转录文本。请直接处理转录文本内容，忽略链接部分。`;
    }
    
    const originalLength = taskInputText.length;

    // 生成初始prompt的函数
    const generateInitialPrompt = (mode: ToolMode, originalLength: number): string => {
        const inputSection = isYouTube && videoId 
            ? `## Input Data
⚠️ **检测到 YouTube 视频链接**（视频ID: ${videoId}）

${taskInputText}

**注意**：上述输入包含 YouTube 视频链接和转录文本。请直接处理转录文本内容，忽略链接部分。`
            : `## Input Data
${taskInputText}`;
        const stagedSegments = mode === ToolMode.SCRIPT ? shotSegmentsRef.current : null;

    // 易经命理改写/扩写特判（早于 REWRITE/EXPAND 分支，统一设置返回）
    if (niche === NicheType.YI_JING_METAPHYSICS && (mode === ToolMode.REWRITE || mode === ToolMode.EXPAND)) {
        const isYiJingRewrite = mode === ToolMode.REWRITE;
        const yjRewriteMin = Math.floor(originalLength * 0.9);   // ≥原文90%（即保留≥80%核心）
        const yjRewriteMax = Math.floor(originalLength * 1.1);   // ≤原文110%（即不超过原文+10%）
        const yjExpandMin = Math.max(8000, Math.floor(originalLength * 1.2));
        const yjExpandMax = Math.max(9600, Math.floor(originalLength * 1.5));

        if (isYiJingRewrite) {
            return `### 任务指令：曾仕强易经命理风格·轻度改写（保留80%核心）
【改写目标】保留原文80%以上核心思想与结构，改写表达方式，不改变主题与故事走向。

${inputSection}

## 原文字数
原文共 ${originalLength} 字

## 语言一致性（最高优先级）
⚠️ **输入语言：简体中文**
⚠️ **输出必须为简体中文，禁止中英切换**

## 曾仕强风格·轻度改写规则
1. **核心保留**：原文的论点、故事、人物关系、时间线不变；只换表达方式。
2. **改写幅度**：仅改动表达措辞，整体改动不超过20%（即至少80%原句核心信息须保留）。
3. **表达升级**：把原文替换为曾仕强教授的口吻，大量使用"各位朋友""我常常讲""我告诉你""老祖宗说""易经告诉我们""你仔细去看""不要瞎折腾""这就是智慧""大错特错"等标志性口头禅。
4. **结构遵循**：严格按以下曾氏5大模块框架改写，禁止输出任何章节标题或标记（如"第一部分""模块一"等）：

【第一部分：直击痛点，反常识破局】
亲切开场+抛出错误做法+打破常识。

【第二部分：引入《易经》天道规律与阴阳转换】
引入卦象或阴阳、时位伦理，讲解天道轮回、不可逆转的规律感。

【第三部分：海量正反面故事对冲】
至少3-4个详细身边人故事（正面/反面对比，细节含起居、固执、破财、生病等），推导人性弱点。

【第四部分：给出最落地的曾氏实操心法】
3-5条极接地气建议（闭嘴艺术、看淡金钱、儿女界限、情绪管理等），结合吃饭、说话、睡觉、交友细节。

【第五部分：升华境界，通透结语】
人生四季轮回或日常修行，收束到"你的命不在别人嘴里，就在你自己起心动念里"。

5. **字数要求**：输出字数必须在 **${yjRewriteMin}–${yjRewriteMax} 字** 之间（原文的90%–110%，允许±10%浮动）。
6. **禁止提前收尾**：⚠️ 未达目标字数前严禁出现"谢谢大家""感谢收听""我们下期见"等收场语。
7. **文末收尾与互动（仅在全文已进入目标字数区间后写，约最后 150–400 字）**：
   - **适度收尾**：用曾仕强口吻简短收束，如「今天先跟大家聊到这儿」「谢谢各位朋友耐心听完」「我们下回再聊」等，二至三句即可，勿冗长重复。
   - **互动引导**：自然邀请听众留言交流，如「欢迎在评论区留下一句你的感触」「你觉得哪一句最戳中你，留言告诉我」「有心得的朋友也欢迎分享」等，一至二句即可。
   - 收尾与互动须接在通透结语之后，整体读起来像完整的一期口播收束，不要戛然而止。
8. **TTS纯净输出**：禁止方括号、括号内提示、**/*等Markdown符号、章节标记；只输出纯第一人称口播文稿。

## 零解释输出（从第一个字开始正文，禁止任何引导语）
直接开始改写，从第一句正文开始，不要有任何前置说明。`;
        } else {
            // 扩写
            return `### 任务指令：曾仕强易经命理风格·深度扩写（扩写至8000字+）
【扩写目标】以原文为核心，向深度展开曾氏5大模块，每模块写满2000字左右，总字数不低于8000字。

${inputSection}

## 原文字数
原文共 ${originalLength} 字

## 语言一致性（最高优先级）
⚠️ **输入语言：简体中文**
⚠️ **输出必须为简体中文，禁止中英切换**

## 曾仕强风格·深度扩写规则
1. **以原文为核心**：不改变原文主题与核心论点，在此基础上深度展开。
2. **扩写幅度**：新增内容须超过原文字数的20%，且总字数不低于8000字（目标 ${yjExpandMin}–${yjExpandMax} 字）。
3. **表达升级**：全文替换为曾仕强教授口吻，大量使用"各位朋友""我常常讲""我告诉你""老祖宗说""易经告诉我们""你仔细去看""不要瞎折腾""这就是智慧""大错特错"等标志性口头禅。
4. **严格按曾氏5大模块框架展开，每模块必须写满约2000字**：

【第一部分：直击痛点，反常识破局】（约2000字）
亲切开场："各位朋友，我今天想跟大家谈一个很严肃/很实在的话题……"
抛出现实中最普遍的错误做法或焦虑现象。
打破常识："很多人以为……我告诉你，大错特错！其实老祖宗早就把道理说透了……"

【第二部分：引入《易经》天道规律与阴阳转换】（约2000字）
详细引入一个《易经》卦象（如损卦、益卦、乾坤、见卦等）或中医理念。
拆解这个规律在人生中的表现（年轻时该怎样，到了一定年纪又该怎样；男人怎样，女人怎样）。
语调带有天道轮回、不可逆转的规律感。

【第三部分：海量正反面故事对冲】（约2000字）
讲述至少3-4个极为详细的"身边人"故事：
- 故事A："我认识一个老先生/女强人，年轻时如何如何，老了之后违背天道，结果落得个什么下场……"（细节含固执、破财、生病等）
- 故事B："相反，我见过另一位看起来平平无奇的人，但他懂得顺应自然/装傻/留有余地，结果晚年福报深厚……"
通过故事推导出人性弱点。

【第四部分：给出最落地的曾氏实操心法】（约2000字）
"既然这样，我们到底该怎么做？记住，不用花钱去算命，就从以下这几件事开始修……"
列出3-5条极接地气建议（闭嘴的艺术、看淡金钱、对待儿女的界限感、情绪的管理等），每条结合吃饭、说话、睡觉、交友细节。

【第五部分：升华境界，通透结语】（约2000字）
总结人生不过是四季轮回，或者修行都在日常。
极具分量的金句："记住，你的命不在别人嘴里，就在你自己起心动念里。"
在全文接近收尾、且总字数已达约8000字以上时，用约最后 200–500 字完成：**适度收尾**（如「今天先聊到这儿」「谢谢各位朋友」）+ **互动引导**（如欢迎在评论区留下感触或一句心得），二至四句即可，与上文自然衔接。

5. **禁止章节标记**：禁止输出"第一部分""模块一""第二节"等字样；用自然过渡语承上启下。
6. **禁止提前收尾**：⚠️ 未满约8000字前严禁出现"谢谢大家""感谢收听""我们下期见"等收场语。
7. **TTS纯净输出**：禁止方括号、括号内提示、**/*等Markdown符号；只输出纯第一人称口播文稿。

## 零解释输出（从第一个字开始正文）
直接开始扩写，从第一句正文开始，不要有任何前置说明。`;
        }
    }

    const inputLanguage = detectToolsInputLanguage(taskInputText);
    console.log(`[Tools] 检测输入语言: ${inputLanguage}, 中文字符数: ${(taskInputText.match(/[\u4e00-\u9fff]/g) || []).length}, 英文字符数: ${(taskInputText.match(/[a-zA-Z]/g) || []).length}`);

    switch (taskMode) {
        case ToolMode.REWRITE:
                // 中医玄学改写特殊配置
                const isTcmRewrite = niche === NicheType.TCM_METAPHYSICS;
                const tcmRewritePrompt = isTcmRewrite ? `
【中医玄学改写特殊规则（必须严格遵守）】
⚠️ 本次任务是中医玄学（倪海厦风格）改写，目标是生成约8000字的完整课程内容。
1. **字数要求**：输出字数必须在 7500-8500 字之间，不得少于 7500 字，也不得超过 8500 字。
2. **禁止课程编号标记**：⚠️ 全文禁止出现"第一节课："、"第二节课："..."第九节课："等固定标签——这是导致重复的根源！改为自然段落过渡，每节之间用过渡句承接。
3. **禁止重复开场白**：全文只允许出现一次"各位老友们好，欢迎来到我的频道，我是你们的老朋友倪海厦。"，且只在文章最开头出现一次。
4. **禁止重复过渡语**：全文只允许出现一次"好了，我们开始上课。"，放在引子与正文之间。
5. **禁止重复自我纠正故事**：全文只允许出现一次"我年轻时候也铁齿，有年交运日偏要去爬山，结果摔了一跤，膝盖肿了半个月。"（禁止在其他节重复出现同一故事）
6. **语气词限量**："我跟你讲""你听懂没有""说真的"全文各不超过2次；"我讲到这里，你可能觉得""你们不要笑""我年轻时候也铁齿"全文各只出现1次。
7. **案例限量**：全文只使用1个案例，要有具体人名/地名/细节，禁止泛化。爬山故事只写一次，不要在多处重复。
8. **禁止提前收尾**：未满7000字前禁止出现"下课""下期再见""今天就讲到这"等收尾语。
9. **结尾风格**：结尾用倪海厦霸气收尾，如"好了，我话讲完了，信不信随你。下课！"——禁止"晚安"。
10. **开场白**：必须以"各位老友们好，欢迎来到我的频道，我是你们的老朋友倪海厦。"开头，引子结束后原样输出"好了，我们开始上课。"。
` : '';

                return `### 任务指令：文本洗稿與像素級改編${tcmRewritePrompt}

${inputSection}

## 原文字数統計
原文共 ${originalLength} 字

## 語言一致性要求（CRITICAL - 最高優先級）
⚠️ **输入語言：${inputLanguage}**
⚠️ **输出語言必須與输入語言完全一致**
- 如果原文是英文，洗稿後的文本也必須是英文
- 如果原文是中文，洗稿後的文本也必須是中文
- 如果原文是中英混合，洗稿後也必須保持相同的語言比例和風格
- **絕對禁止語言轉換**（如英文變中文、中文變英文）

## 洗稿策略（CRITICAL）
⚠️ **像素級模仿 - 1比1復刻原文框架**
- **洗稿為主，弱改編**：保持原文的敘事結構、情節發展、人物關係、時間線完全不變
- **框架100%復刻**：開頭-發展-高潮-結尾的結構必須與原文一致
- **情節1比1對應**：每個情節點、每個轉折、每個細節都必須在洗稿版本中找到對應
- **只改表達方式**：僅替換詞彙、调整句式、變換表達角度，但不改變内容實質
- **禁止深度改編**：禁止添加新情節、刪除原有情節、改變情節順序、修改人物設定

## Style Context
请以 ${nicheConfig.name} 的风格和语气进行洗稿，遵循该赛道的选题与文案逻辑，并用**简单易懂的大白话**表达。

## Constraints & Rules
1. **詞彙替換**：使用同義詞或更高級的詞彙替換原有詞彙，避免重複。
2. **句式變換**：將主動句改為被動句，長句拆短，短句合併，改變敘述語序。
3. **框架鎖定**：在不影响逻辑的前提下，可以微调句子顺序，但绝不改变段落结构和情节顺序。
4. **改写幅度上限**：整体改动不超过20%，至少80%原句核心信息需保留（可同义改写，不可重写剧情）。
5. **去AI味**：避免死板翻译腔，增加口语化连接词（如“其实”“换句话说”“说白了”），整体用大白话。
5. **完整性**：絕對不能丟失原文的关键數據、專有名詞和核心論點。
6. **赛道風格融合**：確保洗稿後的文本符合 ${nicheConfig.name} 的獨特語氣和表達習慣。
7. **字数保持（重要）**：洗稿後的文本字数必須 >= ${originalLength * 0.9} 字（至少保持原文90%的長度），不得大幅縮減内容。
8. **改写幅度限制（关键）**：
   - 必须以原文为底稿进行轻度改写，改写内容占比不得超过20%
   - 保持原故事的时间线、场景、人物关系、关键事件和结局不变
   - 禁止改成全新故事、禁止新增主线、禁止替换核心冲突
9. **禁止提前收尾（关键）**：
   - ⚠️ **一次性输出不可能完成全部内容，系统会自动续写**
   - 在首次输出時，**严禁使用任何收尾語**（如「下課」「散會」「下期再見」等）
   - 保持内容連貫流暢，自然過渡，不要有結束的意思
   - 只有在字数達標後的最終收尾時才使用收尾語
10. **TTS 纯净输出（关键）**：
   - 严禁输出任何括號內的描述詞，如「（教室的燈光漸漸暗去...）」「（院師猛地一拍驚堂木...）」
   - 严禁使用 **、*、__、~~ 等 Markdown 特殊符號
   - 严禁输出章节标记、段落编号、说明文字、注釋或元信息
   - 只输出純粹的第一人稱語音文稿内容，適合直接 TTS 配音

## 零解釋输出規則（CRITICAL - 絕對禁止違反）
⚠️ **從第一個字就開始洗稿内容，禁止任何前置内容**
- ❌ 禁止输出：「這裡為您提供...」「以下是改写後的内容」「根據您的要求...」等任何说明文字
- ❌ 禁止输出：「---」「----」「-----」「生成中」「##」「标题：」等任何分隔符、标题、标记
- ❌ 禁止输出：「改写如下：」「洗稿版本：」「最終版本：」等任何引導語
- ✅ 正确做法：直接從故事的第一句話開始输出，零解釋，零标记，純文本

## Output Format
**立即開始输出洗稿内容（使用 ${inputLanguage}），從故事的第一個字開始，不要有任何前置说明、标题、分隔符或解釋。**`;
        case ToolMode.EXPAND:
                const targetMinLength = Math.floor(originalLength * 1.5);
                const targetMaxLength = Math.floor(originalLength * 2);
                return `### 任务指令：深度内容扩写

${inputSection}

## 原文字数統計
原文共 ${originalLength} 字
目標字数：${targetMinLength}-${targetMaxLength} 字（1.5-2倍扩写）

## 語言一致性要求（CRITICAL - 最高優先級）
⚠️ **输入語言：${inputLanguage}**
⚠️ **输出語言必須與输入語言完全一致**
- 如果原文是英文，扩写後的文本也必須是英文
- 如果原文是中文，扩写後的文本也必須是中文
- 如果原文是中英混合，扩写後也必須保持相同的語言比例和風格
- **絕對禁止語言轉換**（如英文變中文、中文變英文）

## Goals
將提供的簡短文本或大綱擴展為一篇内容詳實、邏輯嚴密的深度文章，遵循 ${nicheConfig.name} 的赛道选题与文案逻辑，并用**简单易懂的大白话**表达。

## Workflow
1. **分析核心观点**：識別输入文本中的主要論點和关键詞。
2. **多維展開**：
   - **What（是什麼）**：詳細解釋概念定義，使用 ${nicheConfig.name} 領域的專業術語。
   - **Why（為什麼）**：分析背後的原因、背景或動機，結合該領域的邏輯和思維方式。
   - **How（怎麼做）**：提供具體的方法論、步驟或解決方案。
   - **Example（举例）**：根據上下文虛構或引用一個貼切的場景/案例來佐證观点，案例要符合該領域特色。
3. **補充細節**：增加形容詞、描寫性語句和修辭手法，豐富文本的顆粒度。
4. **邏輯銜接**：使用過渡句，確保從一個點到另一個點的流動自然。
5. **風格融合**：全文保持 ${nicheConfig.name} 的獨特語氣和表達習慣。

## Constraints
- 扩写後的字数必須達到 ${targetMinLength}-${targetMaxLength} 字（原文的1.5-2倍）。
- 保持原文的語氣（專業、幽默或嚴肅），並融入 ${nicheConfig.name} 的風格特色。
- 不要堆砌無意義的廢話，確保新增内容有實質信息量。
- **禁止提前收尾**：一次性输出不可能完成全部内容，首次输出時严禁使用「下課」「散會」等收尾語，保持内容連貫。
- **TTS 纯净输出**：严禁输出括號內的描述詞、**、*等特殊符號、章节标记、段落编号、说明文字或注釋。

## Output Format
直接输出扩写後的完整纯净文章（使用 ${inputLanguage} 输出），保持簡潔連貫流暢，無需分段标记或元信息。严禁使用「## 」「### 」「第一章」「（）」「**」等标记。`;
        case ToolMode.SUMMARIZE: {
                const sumEn = /^English/i.test(inputLanguage);
                const sumWpmLow = 200;
                const sumWpmHigh = 250;
                const sumWordCount = Math.max(1, taskInputText.trim().split(/\s+/).filter(Boolean).length);
                let sumMinDur: number;
                let sumMaxDur: number;
                if (sumEn) {
                  sumMinDur = sumWordCount / 160;
                  sumMaxDur = sumWordCount / 130;
                } else {
                  sumMinDur = originalLength / sumWpmHigh;
                  sumMaxDur = originalLength / sumWpmLow;
                }
                if (sumEn) {
                  return `### Task: YouTube summary & channel packaging

${inputSection}

## Spoken script length (strict)
- The input is approximately **${originalLength}** characters / **${sumWordCount}** words.
- Assume **130–160 words per minute** for voiceover: total runtime about **${sumMinDur.toFixed(1)}–${sumMaxDur.toFixed(1)}** minutes.
- Timestamps must stay within that range; do not invent a much longer timeline.

## Language (CRITICAL — highest priority)
⚠️ **Detected input language: ${inputLanguage}**
⚠️ **Write the ENTIRE output in English** — headings, titles, description, bullets, tags, prompts, and cover lines. No Chinese paragraphs. Do not translate the packaging into Chinese.

**Zero-preamble rule**
- ❌ No intros ("Here is…", "Based on your request…", task receipts, etc.)
- ❌ No horizontal rules (---)
- ❌ No mode explanations or welcome text
- ✅ Start the first line with exactly: Core Theme:

Follow this structure. **Everything must be grounded in the source text** — no fabrication:

Core Theme:
(one sharp, attractive sentence)

Clickworthy YouTube titles (4, different angles, strong hooks):
1.
2.
3.
4.

Video description:
(compelling blurb: key points, emotional hook, practical value)

Outline:
(main sections from the source, one line each)

👇 Chapter timestamps (click to jump):
(lines as MM:SS Section title)

🔑 Key takeaways & SEO keywords:
(4–5 keywords with short explanations)

Hashtags:
(10–15 tags, each starting with #, English only, source-grounded)

Cover design:

AI image prompts (5):
1.
2.
3.
4.
5.

Cover title lines (5 sets, each with upper / middle / lower line):
1. Upper:
   Middle:
   Lower:
2. Upper:
   Middle:
   Lower:
3. Upper:
   Middle:
   Lower:
4. Upper:
   Middle:
   Lower:
5. Upper:
   Middle:
   Lower:
`;
                }
                return `### 任务指令：YouTube 内容摘要与优化

${inputSection}

## 口播稿时长（必严格遵守）
- 以上输入口播稿约 **${originalLength}** 字。
- 配音语速按 **200–250 字/分钟** 估算：整片时长约 **${sumMinDur.toFixed(1)}–${sumMaxDur.toFixed(1)} 分钟**。
- 时间轴应落在上述时长范围内，禁止编造超长时间轴。

## 語言一致性（CRITICAL · 最高优先级）
⚠️ **输入語言：${inputLanguage}**
⚠️ **输出語言必須與输入語言完全一致** — 标题、简介、大纲、时间轴、标签、封面与提示词均使用中文（原文中的英文专有名词可保留）。

## 输出要求（必须与原文语言一致）

**【零前言铁律 · 最高优先级】**
- ❌ 禁止在正文前输出任何开场白、引言、说明文字（如"以下是摘要""根据您的要求…""已收到您的任务"等）
- ❌ 禁止输出分隔线（---、---- 等）
- ❌ 禁止输出任何模式说明、欢迎语或自我介绍
- ✅ 从第一行开始直接以「核心主題：」起笔，不得有任何前置文字

请严格按以下格式输出，**所有内容必须根据原文提取生成**，禁止凭空编造：

核心主題：
（用一句话精准概括原文在讲什么，要精准且吸引人）

YouTube 爆款标题（4個，标题党风格，留钩子，用不同角度）：
1.
2.
3.
4.

視頻簡介：
（基于原文内容写一段有吸引力的视频简介，包含核心看点、情绪钩子和实用价值）

大纲：
（基于原文提取的主要章节/段落，每条一行）

👇 精彩时间轴导航 (点击时间跳转)：
（根据原文结构估算时间轴，每条格式：MM:SS 章节标题）

🔑 本期核心知識點 (SEO長尾詞覆蓋)：
（4-5个关键词及其简短解释，用于SEO覆盖）

熱門標籤：
（根据原文内容提取的标签，10-15个，用 # 开头，中文标签全部简体中文，英文标签全部英文，禁止混用，禁止凭空添加与原文无关的标签）

封面設計方案：

AI 圖片提示词（5個）：
1.
2.
3.
4.
5.

封面标题文案（5個，每個分上中下三行）：
1. 上行：
   中行：
   下行：
2. 上行：
   中行：
   下行：
3. 上行：
   中行：
   下行：
4. 上行：
   中行：
   下行：
5. 上行：
   中行：
   下行：
`;
        }
        case ToolMode.POLISH:
                return `### 任务指令：文本润色與优化

${inputSection}

## 原文字数統計
原文共 ${originalLength} 字

## 語言一致性要求（CRITICAL - 最高優先級）
⚠️ **输入語言：${inputLanguage}**
⚠️ **输出語言必須與输入語言完全一致**
- 如果原文是英文，润色後的文本也必須是英文
- 如果原文是中文，润色後的文本也必須是中文
- 如果原文是中英混合，润色後也必須保持相同的語言比例和風格
- **絕對禁止語言轉換**（如英文變中文、中文變英文）

## Goals
像一位嚴厲的文字編輯一樣，以 ${nicheConfig.name} 的赛道风格与选题逻辑优化这段文本，使其更专业、更顺滑，但仍用**简单易懂的大白话**表达。

## Checkpoints
1. **語法修正**：糾正所有錯別字、標點错误和語病。
2. **詞彙升級**：將平庸的詞彙替換為更精準、更具表現力的詞彙（例如將"很多"改為"不勝枚舉"，將"好"改為"卓越"），並融入 ${nicheConfig.name} 領域的專業術語。
3. **修辭增強**：在合適的地方加入排比、比喻、反問等修辭手法，增強感染力和說服力。
4. **精簡冗餘**：刪除囉嗦的重複表達，使句子更乾練有力。
5. **语气统一**：确保全文语气一致，并强化 ${nicheConfig.name} 的独特风格，同时保持大白话表达。
6. **邏輯流暢**：优化句子之間的銜接，確保思路連貫、層次分明。
7. **字数保持**：润色後的字数應與原文相當（約 ${originalLength * 0.9}-${originalLength * 1.1} 字），不要大幅縮減或擴充。
8. **禁止提前收尾**：首次输出時严禁使用「下課」「散會」等收尾語，保持内容連貫流暢。
9. **TTS 纯净输出（关键）**：严禁输出括號內的描述詞、**、*等特殊符號，只输出純粹的第一人稱語音文稿。

## Comparison Standard
在"信（準確）、達（通順）、雅（優美）"三個維度上都必須有明顯提升，同时保持 ${nicheConfig.name} 的專業風範。

## Output Format
请直接输出润色後的纯净最終版本（使用 ${inputLanguage} 输出），保持簡潔連貫流暢，無需標註修改痕跡或解釋。严禁使用「## 」「### 」「修改说明：」「（）」「**」等任何标记。`;
        case ToolMode.SCRIPT:
                // 计算镜头数量和字数范围
                const targetShots = scriptShotMode === 'custom'
                  ? Math.min(100, Math.max(10, scriptShotCount))
                  : Math.min(60, Math.max(30, Math.ceil(originalLength / 150)));
                const avgChars = Math.max(120, Math.min(200, Math.round(originalLength / targetShots)));
                const minChars = Math.max(100, Math.round(avgChars * 0.7));
                const maxChars = Math.min(220, Math.round(avgChars * 1.4));
                
                const scriptPrompt = `### 任务指令：视频分镜生成

${inputSection}

## 镜头数量要求（强制）
- **目标镜头数**：${targetShots} 个
- **每个镜头文案字数**：${minChars}-${maxChars} 字（约 ${avgChars} 字）
- **【重要】必须将多个短句合并为一个镜头的文案**，不能每个短句单独成一个镜头！

## 格式要求（严格按顺序输出所有镜头）

按以下格式输出所有分镜，禁止输出任何分析过程：

镜头N
镜头文案:[必须包含该分镜对应的多个原文句子（合并为一个镜头），100%原文还原]
图片提示词:图片背景为[主要场景]，[时间段]，[环境简述]。[构图描述]
视频提示词:[运镜或动态趋势的描述]
景别:[特写/近景/中景/全景/微观/宏观]
语音分镜:[旁白/主讲人（标注语气）]
音效:[环境音或特殊音效]

## 角色信息格式（紧接最后一个分镜条目之后输出）

角色信息
[名称]主讲人
[别名]讲述者/专家
[描述][根据识别出的赛道，自动生成符合该领域权威人设的外貌描述]

[名称]场景-[核心场景名称]
[别名]场景-[核心场景名称]
[描述][描述该场景的视觉基调与色彩风格]`;
                return scriptPrompt;
            default:
                return '';
        }
    };

    // 生成续写prompt
    const generateContinuePrompt = (currentContent: string, mode: ToolMode, originalLength: number, cleanInfo?: { cleaned: string; lastShotNumber: number; needsRework: boolean } | null, originalText?: string): string => {
        const context = currentContent.slice(-2000); // 取最后2000字作为上下文（脚本模式需要更多上下文）
        const currentLength = currentContent.length;
        
        if (mode === ToolMode.REWRITE || mode === ToolMode.POLISH) {
            // 中医玄学改写续写（放在最前面，优先级最高）
            if (niche === NicheType.TCM_METAPHYSICS) {
                const tcmMin = Math.floor(originalLength * 0.9);
                const tcmMax = Math.floor(originalLength * 1.1);
                const progress = (currentLength / tcmMin * 100).toFixed(0);
                const needsMore = currentLength < tcmMin;
                
                // 强制检测重复开场：搜索已输出内容中是否有第二个"各位老友"
                const allOpeningMatches = currentContent.match(/各位老友们好[\s\S]{0,50}倪海厦/g);
                const duplicateOpenings = allOpeningMatches ? allOpeningMatches.length : 0;
                
                // 强制检测重复"开始上课"
                const allStartMatches = currentContent.match(/好了[\s\S]{0,30}我们开始上课/g);
                const duplicateStarts = allStartMatches ? allStartMatches.length : 0;
                
                // 强制检测重复"爬山摔跤"故事段落
                const allClimbingMatches = currentContent.match(/我年轻时候也铁齿[\s\S]{0,200}膝盖肿了半个月/g);
                const duplicateClimbing = allClimbingMatches ? allClimbingMatches.length : 0;
                
                const dupWarning = duplicateOpenings > 1
                    ? `\n\n【严重警告】检测到重复开场白出现${duplicateOpenings}次！继续生成时必须**完全跳过开场白部分**，从正文内容继续！禁止再次输出"各位老友们好，欢迎来到我的频道，我是你们的老朋友倪海厦。"！`
                    : '';
                const startWarning = duplicateStarts > 1
                    ? `\n【严重警告】检测到重复过渡语出现${duplicateStarts}次！禁止再次输出"好了，我们开始上课。"！`
                    : '';
                const climbWarning = duplicateClimbing > 1
                    ? `\n【严重警告】检测到重复自我故事出现${duplicateClimbing}次！禁止再次讲"有年交运日偏要去爬山"故事！`
                    : '';
                
                return `继续完成倪海厦中医玄学风格轻度改写，从上文的最后一句**无缝衔接**，继续正文内容。
${dupWarning}${startWarning}${climbWarning}

【已完成部分（末尾）】
${context}

【字数统计】
- 原文：${originalLength} 字
- 目标：${tcmMin}–${tcmMax} 字（允许±10%）
- 已完成：${currentLength} 字（${progress}%）
${needsMore ? `- ⚠️ 还需要约 ${tcmMin - currentLength} 字` : '- ✓ 字数已达标，可收尾'}

【强制续写规则】
${needsMore ?
`⚠️ **字数严重不足，严禁使用任何收尾语！**
1. **必须从上文最后一句继续**，不得重新开始或插入开场白
2. **禁止输出开场白**：不得写"各位老友们好，欢迎来到我的频道，我是你们的老朋友倪海厦。"
3. **禁止输出过渡语**：不得写"好了，我们开始上课。"
4. **禁止输出章节标记**：不得写"第一课"、"第二课"、"第X节课"等
5. **禁止重复自我故事**：不得再讲"有年交运日偏要去爬山"故事
6. **禁止整段重复**：不得重复上文已讲过的案例或论点
7. 直接自然衔接上文最后一句，以倪海厦口吻继续正文` :
`✓ 字数已达标，请写完通透结语后收束全文。
1. 用倪海厦霸气风格收尾（如"好了，我话讲完了，信不信随你。下课！"）
2. 全文仅允许出现一次收尾语，禁止重复`}
- **TTS 纯净输出**：禁止方括号、括号内提示、**/* 等符号
- 直接续写正文，不要任何占位词`;
            }

            // 易经改写续写
            if (niche === NicheType.YI_JING_METAPHYSICS) {
                const yjRewriteMin = Math.floor(originalLength * 0.9);
                const yjRewriteMax = Math.floor(originalLength * 1.1);
                const progress = (currentLength / yjRewriteMin * 100).toFixed(0);
                const needsMore = currentLength < yjRewriteMin;
                return `继续完成曾仕强易经命理风格轻度改写，无缝衔接上文。

【已完成部分（末尾）】
${context}

【字数统计】
- 原文：${originalLength} 字
- 目标：${yjRewriteMin}–${yjRewriteMax} 字（原文90%–110%，允许±10%）
- 已完成：${currentLength} 字（${progress}%）
- ${needsMore ? `⚠️ 还需要约 ${yjRewriteMin - currentLength} 字` : '✓ 字数已达标，可收尾'}

【续写规则（重要）】
${needsMore ?
`⚠️ **字数严重不足，严禁使用任何收场语！**
- 未满 ${yjRewriteMin} 字前禁止"谢谢大家""感谢收听""我们下期见"等收场语
- 直接自然衔接上文，继续以曾仕强口吻改写（"各位朋友""易经告诉我们""老祖宗说"等）
- 禁止输出章节标记，保持纯口播文稿` :
`✓ 字数已达标，请写完通透结语后收束全文：
- 先完成第五部分金句与升华（如"你的命不在别人嘴里，就在你自己起心动念里"）
- 再用约 150–400 字写**适度收尾**（如"今天先聊到这儿""谢谢各位朋友耐心听完"）+ **互动引导**（如欢迎在评论区留下一句感触、或哪一句最戳中你），一至四句即可，语气亲切不啰嗦
- 全文须在 ${yjRewriteMin}–${yjRewriteMax} 字区间内结束`}
- **TTS 纯净输出**：禁止方括号、括号内提示、**/* 等符号
- 直接续写正文，不要任何占位词`;
            }

            const progress = (currentLength / originalLength * 100).toFixed(0);
            const needsMore = currentLength < originalLength * 0.9;
            
            return `繼續完成上述 ${nicheConfig.name} 風格的${mode === ToolMode.REWRITE ? '改写' : '润色'}，保持風格一致。

【已完成部分（末尾）】
${context}

【字数統計】
- 原文：${originalLength} 字
- 已完成：${currentLength} 字（${progress}%）
- ${needsMore ? `⚠️ 還需要約 ${originalLength - currentLength} 字` : '✓ 接近目標'}

【续写規則（重要）】
${needsMore ? 
`⚠️ **字数嚴重不足，严禁使用任何收尾語！**
- 严禁使用「下課」「散會」「下期再見」「今天就到這」等收尾詞
- 直接自然銜接上文，繼續${mode === ToolMode.REWRITE ? '改写' : '润色'}
- 保持内容流暢連貫，不要有結束的意思` :
`✓ 字数已接近目標，可以適當收尾
- 在内容自然結束時，可以使用「下課」「下期再見」等收尾語
- 添加互動引導（如「歡迎在評論區分享你的看法」）`}
- **TTS 纯净输出**：严禁输出括號內的描述詞、**、*等特殊符號
- 直接续写正文，不要输出任何占位词（包括“生成中”）`;
        } else if (mode === ToolMode.EXPAND) {
            // 易经扩写续写
            if (niche === NicheType.YI_JING_METAPHYSICS) {
                const yjExpandMin = Math.max(8000, Math.floor(originalLength * 1.2));
                const progress = (currentLength / yjExpandMin * 100).toFixed(0);
                const needsMore = currentLength < Math.max(8000, Math.floor(originalLength * 1.1));
                return `繼續完成曾仕强易经命理风格深度扩写，无缝衔接上文。

【已完成部分（末尾）】
${context}

【字数统计】
- 原文：${originalLength} 字
- 目标：${yjExpandMin} 字以上（且不超过原文×1.5）
- 已完成：${currentLength} 字（${progress}%）
- ${needsMore ? `⚠️ 还需要约 ${yjExpandMin - currentLength} 字` : '✓ 已达目标字数，可收尾'}

【续写规则（重要）】
${needsMore ?
`⚠️ **字数严重不足，严禁使用任何收场语！**
- 未满 ${yjExpandMin} 字前禁止"谢谢大家""感谢收听""我们下期见"等收场语
- 直接自然衔接上文，继续深入展开曾氏5大模块（尤其故事与心法要写实写细）
- 禁止输出"第一部分""模块一"等章节标记` :
`✓ 已达目标字数，可以适当收尾
- 自然结束，通透结语（如"你的命不在别人嘴里，就在你自己起心动念里"）
- 可引导互动（如"评论区留下一句你的感触"）`}
- **TTS 纯净输出**：禁止方括号、括号内提示、**/* 等符号
- 直接续写正文，不要任何占位词`;
            }
            
            const targetMin = Math.floor(originalLength * 1.5);
            const progress = (currentLength / targetMin * 100).toFixed(0);
            const needsMore = currentLength < originalLength * 1.4;
            
            return `繼續完成上述 ${nicheConfig.name} 風格的深度扩写，保持風格一致。

【已完成部分（末尾）】
${context}

【字数統計】
- 原文：${originalLength} 字，目標：${targetMin} 字
- 已扩写：${currentLength} 字（${progress}%）
- ${needsMore ? `⚠️ 還需要約 ${targetMin - currentLength} 字` : '✓ 接近目標'}

【续写規則（重要）】
${needsMore ?
`⚠️ **字数嚴重不足，严禁使用任何收尾語！**
- 直接自然銜接上文，繼續深入展開論述
- 保持内容流暢，不要有結束的意思` :
`✓ 字数已接近目標，可以適當收尾
- 確保内容完整、邏輯閉環
- 可以使用適當的收尾語和互動引導`}
- **TTS 纯净输出**：严禁输出括號內的描述詞、**、*等特殊符號
- 直接续写正文，不要输出任何占位词（包括“生成中”）`;
        } else if (mode === ToolMode.SCRIPT) {
            // 检测语言
            const isChinese = /[\u4e00-\u9fff]/.test(inputText);
            
            // 统计已完成的镜头数量
            const shotCount = getUniqueShotCount(currentContent);
            
            // 计算已搬运的原文字数（与完成判定保持同一统计口径）
            const copiedTextLength = getCopiedTextLength(currentContent);
            const originalTextContent = originalText || inputText;
            const remainingTextLength = originalTextContent.length - copiedTextLength;
            const copyProgress = copiedTextLength > 0 
                ? ((copiedTextLength / originalTextContent.length) * 100).toFixed(0)
                : '0';
            
            // 估算还需要多少镜头（基于原文长度和已完成内容）
            // 自动模式：30-60个镜头，每个镜头100-200字文案
            // 镜头数量 = 原文字数 / 150（目标每个镜头150字左右）
            const baseShotCount = Math.ceil(originalLength / 150);
            const estimatedTotalShots = scriptShotMode === 'custom'
              ? Math.min(100, Math.max(10, scriptShotCount))
              : Math.min(60, Math.max(30, baseShotCount));
            const expectedSegments = scriptShotMode === 'custom' ? shotSegmentsRef.current : null;
            // 【修复】自动模式：每个镜头100-200字，确保内容均衡分布
            // 目标：每个镜头文案150字左右，既不太短也不太长
            const avgChars = Math.max(120, Math.min(200, Math.round(originalLength / estimatedTotalShots)));
            const minChars = Math.max(100, Math.round(avgChars * 0.7)); // 最低100字
            const maxChars = Math.min(220, Math.round(avgChars * 1.4)); // 最高220字
            const remainingShots = Math.max(0, estimatedTotalShots - shotCount);
            const nextShotNumber = Math.min(estimatedTotalShots, shotCount + 1);
            
            // 检查是否需要重新输出不完整的镜头
            const needsRework = cleanInfo?.needsRework || false;
            const lastShotNumber = cleanInfo?.lastShotNumber || shotCount;
            
            let reworkInstruction = '';
            if (needsRework) {
                reworkInstruction = `\n\n【重要：重新输出不完整镜头】
检测到镜头${lastShotNumber}输出不完整（缺少必需字段或字段未完成）。
请从「----」下一行开始，重新完整输出镜头${lastShotNumber}，包含所有必需字段：
- 镜头${lastShotNumber}
- 镜头文案: [角色名]-[语气词]："[完整文本]"
- 图片提示词: [景别], [画面描述], [环境描述]
- 视频提示词: [秒数]s: [画面描述], [运镜方式]
- 景别: [全景/中景/特写]
- 语音分镜: [角色名]
- 音效: [具体的音效名]

输出完镜头${lastShotNumber}后，如果还有剩余镜头，继续输出下一个镜头。`;
            }
            
            // 检查是否所有镜头都已完成
            // ⚠️ 关键判断：自定义镜头必须严格达到设定数量；自动模式可按原文完成度判断
            const expectedSegmentsCount = expectedSegments?.length || 0;
            const allShotsComplete = scriptShotMode === 'custom'
              ? (shotCount >= estimatedTotalShots && (expectedSegmentsCount === 0 || shotCount >= expectedSegmentsCount) && !cleanInfo?.needsRework)
              : ((shotCount >= estimatedTotalShots || copiedTextLength >= originalLength * 0.95) && !cleanInfo?.needsRework);
            const hasRoleInfo = hasRoleInfoBlock(currentContent);
            const hasSceneInfo = hasSceneInfoBlock(currentContent);
            
            let roleSceneInstruction = '';
            // 只有在所有镜头都完成后，才输出角色信息和场景信息
            if (allShotsComplete && !hasRoleInfo && !hasSceneInfo) {
                roleSceneInstruction = `\n\n【输出角色信息和场景信息 - 所有镜头已完成】
⚠️ 重要：所有镜头（${shotCount}个）已输出完成，现在必须输出角色信息和场景信息。

⚠️ **绝对禁止输出以下格式（违反即失败）**：
- ❌ 【脚本角色清单】
- ❌ 角色1:、角色2:
- ❌ 性别:、年龄:、外貌特征:、性格特征:、语言风格:
- ❌ 【脚本场景清单】
- ❌ 场景1:、场景2:
- ❌ 描述: (作为单独字段)
- ❌ 或任何其他不在模板中的格式

⚠️ **只能使用以下模板格式（一个字都不能改）**：

[角色信息]
[名称]医生
[别名]倪医生，主播
[描述]一位55岁中年男性，身高175cm，一头整齐的黑白相间短发，身材适中，穿着一身深灰色的传统长衫（或中山装），面容清癯，眼神深邃且坚定，有一种看透世事的智慧感。

[名称]助手
[别名]小李，助理
[描述]一位30岁左右的年轻女性，身着白色工作服，表情专注认真。

[场景信息]
[名称]场景-室内
[别名]无
[描述]古色古香的书房或诊室，背景有书架、医学经络图、毛笔字画，光线柔和庄重。

[名称]场景-户外
[别名]无
[描述]自然风光，山水画卷般的场景，展现天人合一的理念。

⚠️⚠️⚠️ **格式要求（CRITICAL - 绝对铁律 - 写死格式 - 违反即失败）**：
1. ✅ **必须使用 [角色信息] 作为开头标记**（方括号+角色信息+方括号，无空格，无其他字符）
2. ✅ **必须使用 [场景信息] 作为开头标记**（方括号+场景信息+方括号，无空格，无其他字符）
3. ✅ **每个角色/场景必须且只能包含三个字段：[名称]、[别名]、[描述]**
4. ✅ **⚠️⚠️⚠️ 每个字段必须独占一行 ⚠️⚠️⚠️**（这是最容易犯的错误！）
   - ❌ 错误：[名称]医生[别名]倪医生[描述]一位55岁...（所有字段在一行）
   - ✅ 正确：
     [名称]医生
     [别名]倪医生，主播
     [描述]一位55岁中年男性...（每个字段独占一行）
5. ✅ **字段格式：[字段名]内容**（方括号+字段名+方括号+内容，字段名和内容之间无空格，无换行）
6. ✅ **字段名称必须完全一致**：[名称]、[别名]、[描述]（不能改为"角色名称"、"场景名称"、"角色别名"、"场景别名"等）
7. ✅ **[描述] 字段必须输出详细内容**：
   - 角色描述：年龄、性别、身高、外貌、穿着、性格等（至少50字）
   - 场景描述：场景类型、环境特点、视觉元素、氛围等（至少30字）
8. ❌ **禁止省略 [描述] 字段或输出空内容**
9. ❌ **禁止增加任何其他字段（如性别、年龄、外貌特征等作为单独字段）**
10. ❌ **禁止使用任何其他格式（如角色1:、场景1:、【脚本角色清单】等）**
11. ❌ **禁止将所有字段挤在一行**
12. ❌ **禁止在字段名称中添加或删除任何字符**
13. ❌ **禁止修改字段名称（如改为"角色名"、"场景名"等）**
14. ✅ **内容必须从原文中提取或合理推断**
15. ✅ **每个角色/场景之间用空行分隔**
12. 每个角色/场景之间用空行分隔
13. **⚠️⚠️⚠️ 输出完场景信息的最后一个[描述]字段后，立即停止，不要输出任何其他内容，包括镜头、说明文字、注释等，任务完成！⚠️⚠️⚠️**`;
            }
            
            return `继续完成视频脚本生成，保持格式一致。

⚠️ **绝对铁律（续写时同样适用，特别是镜头14及之后）**：
1. **镜头文案必须100%原文还原**：
   - 前面的镜头（镜头1-镜头13）和原文一致
   - **后面的镜头（镜头14、镜头15、镜头16...所有后续镜头）也必须和原文一致，一个字都不能改**
   - **禁止任何改写、润色、扩写、缩写**
   - **只进行格式转换，不进行任何内容改写**
2. **脚本输出模块作为独立模块**：
   - 只做原文格式转换输出
   - 不做任何扩写和文案修改
   - 必须从原文中直接复制粘贴，不能有任何改动

【原文内容（CRITICAL - 必须从这里复制粘贴）】
${originalText || inputText}

【已完成部分（末尾）】
${context}

【进度统计】
- 原文总长度：${originalLength} 字
- 已搬运原文：${copiedTextLength} 字（${copyProgress}%）
- 还需搬运：约 ${remainingTextLength} 字
- 已完成镜头：${shotCount} 个
- 预计总镜头：${estimatedTotalShots} 个（${scriptShotMode === 'custom' ? '自定义' : '自动估算'}）
- 还需完成：约 ${remainingShots} 个镜头
- 每镜头字数目标：约 ${avgChars} 字（允许范围 ${minChars}-${maxChars} 字）
- 角色信息：${hasRoleInfo ? '✓ 已完成' : '✗ 未完成'}
- 场景信息：${hasSceneInfo ? '✓ 已完成' : '✗ 未完成'}
${copiedTextLength >= originalLength * 0.95 ? '\n⚠️⚠️⚠️ 原文已搬运完毕（≥95%），如果所有镜头都已输出完成，必须立即输出角色信息和场景信息，然后结束任务！⚠️⚠️⚠️' : ''}${reworkInstruction}${roleSceneInstruction}

【续写要求（CRITICAL）】${!needsRework && !roleSceneInstruction ? `
1. **继续输出镜头**：从「----」下一行开始，继续输出下一个镜头
2. **镜头格式**：必须包含所有字段（镜头序号、镜头文案、图片提示词、视频提示词、景别、语音分镜、音效）
3. **【强制合并短句】**：如果原文由多个短句组成，必须将多个短句合并为一个镜头的文案，确保每个镜头文案有 ${minChars}-${maxChars} 字（约 ${avgChars} 字）。**禁止把每个短句单独输出为一个镜头！**
4. **镜头文案（绝对铁律 - 100%原文还原，绝对禁止修改）**：
   ⚠️ **这是最重要的规则，违反即失败**：
   - **必须从上面提供的【原文内容】中继续复制粘贴，不能有任何改动**
   - **根据【进度统计】，你已经搬运了${copiedTextLength}字（${copyProgress}%），还需要搬运约${remainingTextLength}字**
   - **查看【已完成部分】的最后一个镜头文案，找到对应的原文位置，然后从该位置之后继续搬运**
   - **不要重复已搬运的内容，也不要跳过任何原文内容**
   - **若提供了【预切分镜头文案】，必须严格按序号使用对应段落作为该镜头文案，不得改写、拆分或合并**
   - **必须100%按照原文输出，一个字都不能改**
   - **禁止任何改写、润色、扩写、缩写**
   - **禁止添加任何新内容**
   - **禁止删除任何原文内容**
   - **禁止修改任何标点符号**
   - **禁止修改任何字词**
   - **禁止替换任何同义词**
   - **禁止改变任何句式**
   - **禁止调整任何语序**
   - **必须从原文中直接复制粘贴，不能有任何改动**
   - **前面的镜头文案和原文一致，后面的也必须和原文一致，不能有任何变化**
   - **续写时同样适用：镜头16、镜头17、镜头18...所有后续镜头都必须100%原文还原**
   - **⚠️ 最后一个镜头文案必须包含【原文结尾片段】中的句子（原样出现）**
4. **镜头文案格式**：
   - **【原文完整性优先】字数限制仅作为参考，不要为了符合字数而删减原文！**
   - **核心原则：100%保留原文内容，一个字都不能少；宁可超过字数限制，也要确保内容完整**
   - **如果原文段落较长（如100-300字），直接保留完整段落，不要压缩截断**
   - **字数参考范围：${minChars}-${maxChars}字（约${avgChars}字/镜头），但原文内容完整性是第一优先**
   - 格式：[角色名]-[语气词]："[原文文本内容，100%还原]"
   - 语气词限定：只能使用以下六种之一：高兴、愤怒、悲伤、害怕、惊讶、平静
   - 必须是原文的连续长段落，无动作描述，纯净文本
   - ⚠️ **绝对禁止压缩原文**：不得删除、缩写、省略原文的任何部分
4. **图片提示词**：适合 AI 绘图工具，包含景别、画面描述、环境描述
   - 镜头1-3允许以人物为主做主体交代；从镜头4开始必须更多体现文案对应的具体场景与物件，避免清一色人物特写
   - 至少每2个镜头中包含1个非人物主导画面（环境/物件/空间关系），禁止连续两个镜头都以人物特写为主
   - 图片提示词必须与镜头文案语义一一对应，优先强调场景叙事
5. **视频提示词**：格式 [秒数]s: [画面描述], [运镜方式]
6. **景别**：必须是 全景、中景、特写 三者之一
7. **完成标记**：
   - 如果本次输出无法完成全部镜头，在最后一个完整镜头后输出「----」（4个横线）
   - ⚠️ **严禁提前输出角色信息和场景信息**：只有在所有镜头（${estimatedTotalShots}个）都输出完成后，才能输出角色信息和场景信息
   - 如果所有镜头都已完成，不需要输出「----」
8. **镜头编号铁律（必须遵守）**：
   - 下一镜头必须从「镜头${nextShotNumber}」开始，之后严格按 +1 递增
   - 自定义镜头模式下，禁止输出大于「镜头${estimatedTotalShots}」的任何镜头编号
   - 禁止回退编号（例如输出到镜头20后又回到镜头14）` : ''}

【输出格式（CRITICAL - 绝对禁止违反）】
第一行必须是「生成中」，第二行开始直接输出。

⚠️ **只能输出以下三种内容**：
1. **镜头信息**：镜头[序号] + 镜头文案 + 图片提示词 + 视频提示词 + 景别 + 语音分镜 + 音效
2. **角色信息**（所有镜头完成后）：[角色信息] + [名称][别名][描述] （每个角色重复[名称][别名][描述]）
3. **场景信息**（所有镜头完成后）：[场景信息] + [名称][别名][描述] （每个场景重复[名称][别名][描述]）

⚠️ **绝对禁止输出以下内容**：
- ❌ 【脚本角色清单】、【脚本场景清单】
- ❌ 角色1:、角色2:、场景1:、场景2:
- ❌ 性别:、年龄:、外貌特征:、性格特征:、语言风格:
- ❌ 描述: (作为独立行)
- ❌ 任何说明性文字、注释、解释
- ❌ 任何不在模板中的格式

请使用简体中文输出（包括镜头文案、角色和场景描述）。如原文为繁体，请先转换为简体再输出。严禁使用 **、*、__、~~ 等 Markdown 特殊符号。

⚠️ **输出完场景信息后，立即结束，不要输出任何其他内容。**`;
        }
        
        return '';
    };

    try {
        initializeGemini(apiKey, { provider });

        // 生成初始内容
        const initialPrompt = generateInitialPrompt(taskMode, originalLength);
        await streamContentGeneration(initialPrompt, systemInstruction, (chunk) => {
            localOutput += chunk;
            const now = Date.now();
            if (now - lastProgressUpdateRef.current < 250) {
                return;
            }
            lastProgressUpdateRef.current = now;
            updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });
            
            // 实时更新生成进度（基于内容长度）
            const calculateProgress = () => {
                if (taskMode === ToolMode.SCRIPT) {
                    if (isRevengeScriptTask) {
                        return Math.min(95, (localOutput.length / Math.max(originalLength, 1)) * 100);
                    }
                    const targetShots = scriptShotMode === 'custom'
                      ? Math.min(100, Math.max(10, scriptShotCount))
                      : Math.min(60, Math.ceil(originalLength / 250));

                    if (scriptShotMode === 'custom') {
                        const shotCount = getUniqueShotCount(localOutput);
                        const hasRoleInfo = hasRoleInfoBlock(localOutput);
                        const hasSceneInfo = hasSceneInfoBlock(localOutput);
                        const shotProgress = Math.min(95, (shotCount / targetShots) * 100);
                        const roleSceneProgress = (hasRoleInfo ? 2.5 : 0) + (hasSceneInfo ? 2.5 : 0);
                        return Math.min(100, shotProgress + roleSceneProgress);
                    }

                    // 自动模式：基于已搬运的原文长度
                    const copiedLength = getCopiedTextLength(localOutput);
                    // 脚本模式：原文搬运进度 + 角色场景信息完成度
                    const hasRoleInfo = hasRoleInfoBlock(localOutput);
                    const hasSceneInfo = hasSceneInfoBlock(localOutput);
                    const textProgress = Math.min(95, (copiedLength / originalLength) * 100);
                    const roleSceneProgress = (hasRoleInfo ? 2.5 : 0) + (hasSceneInfo ? 2.5 : 0);
                    return Math.min(100, textProgress + roleSceneProgress);
                } else {
                    // 其他模式：基于输出文本长度估算
                    let est: number;
                    if (taskMode === ToolMode.EXPAND && taskNiche === NicheType.YI_JING_METAPHYSICS) {
                        est = Math.max(9600, Math.floor(originalLength * 1.5));
                    } else if (taskMode === ToolMode.REWRITE && taskNiche === NicheType.YI_JING_METAPHYSICS) {
                        est = Math.floor(originalLength * 1.1);
                    } else {
                        est = originalLength * (taskMode === ToolMode.EXPAND ? 3 : taskMode === ToolMode.REWRITE ? 1.1 : 1.2);
                    }
                    return Math.min(95, (localOutput.length / est) * 100);
                }
            };
            
            const progress = Math.max(3, calculateProgress());
            setGenerationProgress({ 
                current: Math.round(progress), 
                total: 100 
            });
            if (taskMode === ToolMode.SCRIPT) {
                const expectedShots = scriptShotMode === 'custom'
                  ? Math.min(100, Math.max(10, scriptShotCount))
                  : Math.min(60, Math.ceil(originalLength / 250));
                setShotPromptProgress(estimatePromptProgress(localOutput, expectedShots));
            }
        });
        
        // 检查是否需要续写（摘要模式不需要续写，但在生成完成后需要保存历史）
        let shouldSaveHistory = false;
        
        if (taskMode === ToolMode.SUMMARIZE) {
            // 摘要模式：不需要续写，生成完成后立即保存历史记录
            // 即使 isContentComplete 返回 false，也保存历史记录（因为摘要模式不续写）
            shouldSaveHistory = localOutput.trim().length > 0;
        } else {
            let roleSceneInjected = false;
            let earlyRoleSceneRounds = 0;
            while (!isContentComplete(localOutput, taskMode, originalLength, taskNiche) && continuationCount < MAX_CONTINUATIONS) {
                continuationCount++;
                console.log(`[Tools] Content incomplete, continuing (${continuationCount}/${MAX_CONTINUATIONS})...`);

                // 自定义镜头：镜头数达标后，按“末尾对齐 + 角色场景完整”推进，不再误删已完成信息
                if (!roleSceneInjected && taskMode === ToolMode.SCRIPT && scriptShotMode === 'custom' && !isRevengeScriptTask) {
                    const uniqueShotCount = getUniqueShotCount(localOutput);
                    const targetShots = Math.min(100, Math.max(10, scriptShotCount));
                    if (uniqueShotCount >= targetShots) {
                        const tailAlignedNow = isLastShotTailAligned(localOutput, originalScriptInputRef.current || '');
                        let hasRoleInfo = hasRoleInfoBlock(localOutput);
                        let hasSceneInfo = hasSceneInfoBlock(localOutput);

                        // 仅在“末尾未对齐”时才移除角色/场景信息，避免已经完成又被清掉
                        if (!tailAlignedNow && (hasRoleInfo || hasSceneInfo)) {
                            localOutput = localOutput
                                .replace(/\n?\[角色信息\][\s\S]*$/g, '')
                                .replace(/\n?角色信息\n[\s\S]*$/g, '')
                                .replace(/\n?\[场景信息\][\s\S]*$/g, '')
                                .replace(/\n?\[場景信息\][\s\S]*$/g, '')
                                .replace(/\n?(?:场景信息|場景信息)\n[\s\S]*$/g, '')
                                .trim();
                            updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });
                            hasRoleInfo = false;
                            hasSceneInfo = false;
                        }

                        if (tailAlignedNow && (!hasRoleInfo || !hasSceneInfo)) {
                            roleSceneInjected = true;
                            const separator = '\n\n生成中\n\n';
                            localOutput += separator;
                            updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });

                            const roleScenePrompt = `### 任务指令：补全角色信息与场景信息\n\n你已经完成所有镜头输出（镜头数量已达标），且最后一个镜头文案已覆盖原文末尾。\n\n现在只需要输出角色信息和场景信息。\n\n【必须严格按模板输出，禁止任何额外文字】\n[角色信息]\n[名称]医生\n[别名]倪医生，主播\n[描述]（根据原文合理推断，至少50字）\n\n[名称]助手\n[别名]小李，助理\n[描述]（根据原文合理推断，至少50字）\n\n[场景信息]\n[名称]场景-室内\n[别名]无\n[描述]（根据原文合理推断，至少30字）\n\n[名称]场景-户外\n[别名]无\n[描述]（根据原文合理推断，至少30字）\n\n⚠️ 规则：\n1. 每个字段必须独占一行\n2. 只能输出以上两块信息，不要输出镜头，不要解释，不要加标题或分隔符\n3. 必须简体中文`;

                            await streamContentGeneration(roleScenePrompt, systemInstruction, (chunk) => {
                                localOutput += chunk;
                                updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });
                            });

                            // 生成完成后继续走后面的清洗与保存逻辑
                        }
                    }
                }
                
                // 中医玄学改写特判：字数达标 + 收尾关键词 → 强制收尾
                // 注意：新版已移除"第X节课"标记，改用自然段落，改为检测内容完整性
                if (taskMode === ToolMode.REWRITE && taskNiche === NicheType.TCM_METAPHYSICS) {
                    const tcmLen = localOutput.length;
                    const tcmMinLen = Math.floor(originalLength * 0.9);
                    const tcmMaxLen = Math.floor(originalLength * 1.1);
                    if (tcmLen >= tcmMinLen && tcmLen <= tcmMaxLen) {
                        const tcmClosingKeywords = [
                            /下期再见/i, /下期再見/i, /下课/i, /下課/i,
                            /今天就到这/i, /今天就到這/i, /咱们下期再见/i,
                            /咱們下期再見/i, /散会/i, /散會/i,
                            /点个赞.*订阅.*转发/s, /點個讚.*訂閱.*轉發/s,
                            /信不信随你.*下课/s, /好了.*话讲完了.*下课/s,
                        ];
                        if (tcmClosingKeywords.some(kw => kw.test(localOutput))) {
                            console.log('[Tools] TCM rewrite: 字数达标+收尾关键词，强制退出续写循环');
                            break;
                        }
                    }
                }

                // 易经改写/扩写特判：字数已在目标区间且有收尾语 → 立即退出
                if (taskNiche === NicheType.YI_JING_METAPHYSICS &&
                    (taskMode === ToolMode.REWRITE || taskMode === ToolMode.EXPAND)) {
                    const yjLen = localOutput.length;
                    const yjRewriteMin = Math.floor(originalLength * 0.9);
                    const yjRewriteMax = Math.floor(originalLength * 1.1);
                    const yjExpandMin = Math.max(8000, Math.floor(originalLength * 1.2));
                    const yjExpandMax = Math.max(9600, Math.floor(originalLength * 1.5));
                    const yjMin = taskMode === ToolMode.REWRITE ? yjRewriteMin : yjExpandMin;
                    const yjMax = taskMode === ToolMode.REWRITE ? yjRewriteMax : yjExpandMax;
                    const yjHasEnding = /[。！？.!?]$/.test(yjLen > 0 ? localOutput.trim().slice(-20) : '');
                    if (yjLen >= yjMin && yjLen <= yjMax && yjHasEnding) {
                        console.log(`[Tools] YiJing ${taskMode === ToolMode.REWRITE ? 'rewrite' : 'expand'}: 字数达标(${yjLen}字)且有收尾语，强制退出续写循环`);
                        break;
                    }
                }
                
                // 脚本模式：检测并清理不完整的镜头（复仇脚本纯文本模式跳过）
                let cleanInfo: { cleaned: string; lastShotNumber: number; needsRework: boolean } | null = null;
                if (taskMode === ToolMode.SCRIPT && !isRevengeScriptTask) {
                    // 计算当前进度
                    const currentShotCount = getUniqueShotCount(localOutput);
                    const currentCopiedLength = getCopiedTextLength(localOutput);
                    const progress = ((currentCopiedLength / originalLength) * 100).toFixed(1);
                    console.log(`[Tools] 续写前进度: 镜头${currentShotCount}个, 已搬运${currentCopiedLength}/${originalLength}字 (${progress}%)`);
                    
                    cleanInfo = cleanIncompleteShot(localOutput);
                    if (cleanInfo.needsRework && skippedReworkShots.has(cleanInfo.lastShotNumber)) {
                        console.log(`[Tools] Skip rework for shot ${cleanInfo.lastShotNumber} (anti-stall memory)`);
                        cleanInfo = { cleaned: localOutput, lastShotNumber: cleanInfo.lastShotNumber, needsRework: false };
                    }
                    if (cleanInfo.needsRework) {
                        // 先尝试补齐最后镜头缺失字段，避免直接删除导致反复回到镜头1
                        const patchedOutput = patchIncompleteLastShot(localOutput);
                        if (patchedOutput !== localOutput) {
                            localOutput = patchedOutput;
                            updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });
                            cleanInfo = cleanIncompleteShot(localOutput);
                            if (!cleanInfo.needsRework) {
                                console.log(`[Tools] Patched incomplete shot ${cleanInfo.lastShotNumber}, continue generation`);
                                sameShotReworkCount = 0;
                                stagnantRounds = 0;
                            }
                        }
                    }

                    if (cleanInfo.needsRework) {
                        console.log(`[Tools] Detected incomplete shot ${cleanInfo.lastShotNumber}, cleaning and reworking...`);
                        const beforeLength = localOutput.length;
                        const beforeCopied = currentCopiedLength;

                        // 统计同一镜头被回收次数，超过阈值直接跳过该镜头回收，避免卡死在镜头1
                        if (cleanInfo.lastShotNumber === lastReworkShotNumber) {
                            sameShotReworkCount += 1;
                        } else {
                            lastReworkShotNumber = cleanInfo.lastShotNumber;
                            sameShotReworkCount = 1;
                        }

                        if (sameShotReworkCount >= 3) {
                            console.log(`[Tools] Force skip rework for shot ${cleanInfo.lastShotNumber} (same shot loop)`);
                            skippedReworkShots.add(cleanInfo.lastShotNumber);
                            cleanInfo = { cleaned: localOutput, lastShotNumber: cleanInfo.lastShotNumber, needsRework: false };
                        } else {
                            localOutput = cleanInfo.cleaned;
                            updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });

                            const afterCopied = getCopiedTextLength(localOutput);
                            // 若清理没有带来有效进展（反复卡同一镜头），触发防卡死兜底
                            if (Math.abs(beforeLength - localOutput.length) < 80 || Math.abs(beforeCopied - afterCopied) < 30) {
                                stagnantRounds += 1;
                                console.log(`[Tools] Stagnant round detected: ${stagnantRounds}`);
                            } else {
                                stagnantRounds = 0;
                            }
                        }
                    } else {
                        stagnantRounds = 0;
                        sameShotReworkCount = 0;
                    }

                    // 连续无进展时，跳过本轮清理，避免无限回收同一镜头
                    if (stagnantRounds >= 3) {
                        const stuckShot = cleanInfo?.lastShotNumber || (currentShotCount + 1);
                        console.log(`[Tools] Anti-stall activated: mark shot ${stuckShot} as skip-rework`);
                        skippedReworkShots.add(stuckShot);
                        // 强制将卡住镜头补齐关键字段，避免下一轮继续判定不完整
                        localOutput = patchIncompleteLastShot(localOutput);
                        cleanInfo = { cleaned: localOutput, lastShotNumber: stuckShot, needsRework: false };
                        updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });
                        stagnantRounds = 0;
                    }
                }
                
                // 生成续写prompt（使用干净上下文，避免“生成中”干扰模型）
                const continuePrompt = generateContinuePrompt(localOutput, taskMode, originalLength, cleanInfo, taskInputText);
                // 取消“生成中”占位符注入，避免污染正文
                updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });

                // 脚本模式：若已达到或超过原文长度，强制进入角色/场景信息（复仇脚本纯文本模式跳过）
                if (taskMode === ToolMode.SCRIPT && !isRevengeScriptTask) {
                    const copiedTextLength = getCopiedTextLength(localOutput);
                    const hasRoleInfo = hasRoleInfoBlock(localOutput);
                    const hasSceneInfo = hasSceneInfoBlock(localOutput);
                    if (copiedTextLength >= originalLength && (!hasRoleInfo || !hasSceneInfo)) {
                        const separator = '\n\n生成中\n\n';
                        localOutput += separator;
                        updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });

                        const roleScenePrompt = `### 任务指令：补全角色信息与场景信息\n\n你已经完成所有镜头输出，且镜头文案已覆盖原文末尾。\n\n现在只需要输出角色信息和场景信息。\n\n【必须严格按模板输出，禁止任何额外文字】\n[角色信息]\n[名称]医生\n[别名]倪医生，主播\n[描述]（根据原文合理推断，至少50字）\n\n[名称]助手\n[别名]小李，助理\n[描述]（根据原文合理推断，至少50字）\n\n[场景信息]\n[名称]场景-室内\n[别名]无\n[描述]（根据原文合理推断，至少30字）\n\n[名称]场景-户外\n[别名]无\n[描述]（根据原文合理推断，至少30字）\n\n⚠️ 规则：\n1. 每个字段必须独占一行\n2. 只能输出以上两块信息，不要输出镜头，不要解释，不要加标题或分隔符\n3. 必须简体中文`;

                        await streamContentGeneration(roleScenePrompt, systemInstruction, (chunk) => {
                            localOutput += chunk;
                            updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });
                        });

                        break;
                    }
                }
                
                // 续写
                // 中医玄学改写：收尾时内容已接近完成，备用模型应快速响应，缩短超时避免长时间卡住
                const tcmContinuationTimeout = (taskMode === ToolMode.REWRITE && taskNiche === NicheType.TCM_METAPHYSICS)
                    ? { firstChunkTimeoutMs: 30_000 } : undefined;
                await streamContentGeneration(continuePrompt, systemInstruction, (chunk) => {
                    // 中医玄学模式：对新chunk执行去重，防止LLM在续写时重复生成完整文章结构
                    // 每次只处理"已累计输出 + 新chunk"的末尾部分（策略：检测第二个开场白出现就截断）
                    if (taskNiche === NicheType.TCM_METAPHYSICS) {
                      const prevLen = localOutput.length;
                      localOutput += chunk;
                      const deduped = deduplicateStreamingOutput(localOutput);
                      if (deduped.length < localOutput.length) {
                        console.log(`[Tools] TCM去重：${localOutput.length} → ${deduped.length} 字，移除重复文章片段`);
                      }
                      localOutput = deduped;
                    } else {
                      localOutput += chunk;
                    }
                    updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });
                    
                    // 实时更新生成进度（基于内容长度）
                    const calculateProgress = () => {
                        if (taskMode === ToolMode.SCRIPT) {
                            // 脚本模式：基于已搬运的原文长度
                            const copiedLength = getCopiedTextLength(localOutput);
                            // 脚本模式：原文搬运进度 + 角色场景信息完成度
                            const hasRoleInfo = hasRoleInfoBlock(localOutput);
                            const hasSceneInfo = hasSceneInfoBlock(localOutput);
                            const textProgress = Math.min(95, (copiedLength / originalLength) * 100);
                            const roleSceneProgress = (hasRoleInfo ? 2.5 : 0) + (hasSceneInfo ? 2.5 : 0);
                            return Math.min(100, textProgress + roleSceneProgress);
                        } else {
                            let est: number;
                            if (taskMode === ToolMode.EXPAND && taskNiche === NicheType.YI_JING_METAPHYSICS) {
                                est = Math.max(9600, Math.floor(originalLength * 1.5));
                            } else if (taskMode === ToolMode.REWRITE && taskNiche === NicheType.YI_JING_METAPHYSICS) {
                                est = Math.floor(originalLength * 1.1);
                            } else {
                                est = originalLength * (taskMode === ToolMode.EXPAND ? 3 : taskMode === ToolMode.REWRITE ? 1.1 : 1.2);
                            }
                            return Math.min(95, (localOutput.length / est) * 100);
                        }
                    };
                    
                    const progress = Math.max(3, calculateProgress());
                    setGenerationProgress({ 
                        current: Math.round(progress), 
                        total: 100 
                    });
                    if (taskMode === ToolMode.SCRIPT) {
                        const expectedShots = scriptShotMode === 'custom'
                          ? Math.min(100, Math.max(10, scriptShotCount))
                          : Math.min(60, Math.max(30, Math.ceil(originalLength / 150)));
                        setShotPromptProgress(estimatePromptProgress(localOutput, expectedShots));
                    }
                });
                
                // ⚠️ 关键：每次续写后立即检查是否已输出场景信息
                if (taskMode === ToolMode.SCRIPT) {
                    const hasRoleInfo = hasRoleInfoBlock(localOutput);
                    const hasSceneInfo = hasSceneInfoBlock(localOutput);
                    const currentShotCount = getUniqueShotCount(localOutput);
                    const targetShots = scriptShotMode === 'custom'
                      ? Math.min(100, Math.max(10, scriptShotCount))
                      : Math.min(60, Math.max(30, Math.ceil(originalLength / 150)));
                    const tailAligned = isLastShotTailAligned(localOutput, originalScriptInputRef.current || '');
                    if (hasSceneInfo || hasRoleInfo) {
                        if (currentShotCount < targetShots) {
                            earlyRoleSceneRounds += 1;
                            console.log(`[Tools] 续写中检测到提前的角色/场景信息，继续生成镜头（${earlyRoleSceneRounds}）`);
                            // 丢弃提前输出的角色/场景信息，避免污染后续续写
                            localOutput = localOutput
                                .replace(/\n?\[角色信息\][\s\S]*$/g, '')
                                .replace(/\n?角色信息\n[\s\S]*$/g, '')
                                .replace(/\n?\[场景信息\][\s\S]*$/g, '')
                                .replace(/\n?\[場景信息\][\s\S]*$/g, '')
                                .replace(/\n?(?:场景信息|場景信息)\n[\s\S]*$/g, '')
                                .trim();
                            updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });

                            // 防止模型反复提前吐角色/场景导致卡死：连续多次后强制要求只补镜头
                            if (earlyRoleSceneRounds >= 3) {
                                const forceMirrorPrompt = `请仅继续输出镜头内容，从镜头${Math.min(targetShots, currentShotCount + 1)}开始，严格按模板输出镜头字段。\n禁止输出任何角色信息或场景信息。\n当且仅当镜头达到${targetShots}个且最后镜头文案对齐原文末尾后，才可输出[角色信息]和[场景信息]。`;
                                const separator = '\n\n生成中\n\n';
                                localOutput += separator;
                                updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });
                                await streamContentGeneration(forceMirrorPrompt, systemInstruction, (chunk) => {
                                    localOutput += chunk;
                                    updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });
                                });
                            }
                            continue;
                        }
                        earlyRoleSceneRounds = 0;
                        if (currentShotCount > targetShots) {
                            console.log('[Tools] 续写中检测到镜头数超出目标，裁剪尾部并继续');
                            localOutput = localOutput.replace(/\n?\[角色信息\][\s\S]*$/g, '').replace(/\n?\[场景信息\][\s\S]*$/g, '').replace(/\n?\[場景信息\][\s\S]*$/g, '').trim();
                            updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });
                            continue;
                        }
                        if (!tailAligned) {
                            console.log('[Tools] 检测到角色/场景信息但末尾未对齐，丢弃信息后继续修正末镜头');
                            localOutput = localOutput
                              .replace(/\n?\[角色信息\][\s\S]*$/g, '')
                              .replace(/\n?角色信息\n[\s\S]*$/g, '')
                              .replace(/\n?\[场景信息\][\s\S]*$/g, '')
                              .replace(/\n?\[場景信息\][\s\S]*$/g, '')
                              .replace(/\n?(?:场景信息|場景信息)\n[\s\S]*$/g, '')
                              .trim();
                            updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });
                            continue;
                        }
                        if (hasSceneInfo && hasRoleInfo && currentShotCount === targetShots) {
                            console.log('[Tools] 续写中检测到场景信息且镜头数与尾部对齐达标，立即停止续写！');
                            break; // 立即退出续写循环
                        }
                    }
                }
            }
            // 非摘要模式：生成完成后检查是否完整
            shouldSaveHistory = isContentComplete(localOutput, taskMode, originalLength, taskNiche);
            if (taskMode === ToolMode.SCRIPT && !isRevengeScriptTask) {
                const dbg = getScriptConsistencyDebug(localOutput, originalScriptInputRef.current || taskInputText);
                console.log('[Tools][Consistency][LoopEnd]', dbg);
            }
        }
        
        // 清理续写分隔符（脚本模式使用----，其他模式使用-----）
        if (taskMode === ToolMode.SCRIPT) {
                localOutput = localOutput.replace(/\n*生成中\n*/g, '\n\n').replace(/\n*----\n*/g, '\n\n').replace(/\n*-----\n*/g, '\n\n');
                // 复仇脚本纯文本模式：不做镜头清洗，避免被镜头规则误伤
                if (!isRevengeScriptTask) {
                  // 脚本模式：清洗内容，保留镜头、角色信息、场景信息，删除重复镜头
                  localOutput = cleanScriptOutput(localOutput);
                }
                
                if (!isRevengeScriptTask) {
                  // 强制检查：如果场景信息已完成，立即停止
                  const hasRoleInfo = hasRoleInfoBlock(localOutput);
                  const hasSceneInfo = hasSceneInfoBlock(localOutput);
                  const currentShotCount = getUniqueShotCount(localOutput);
                  const targetShots = scriptShotMode === 'custom'
                    ? Math.min(100, Math.max(10, scriptShotCount))
                    : Math.min(60, Math.max(30, Math.ceil(originalLength / 150)));
                  const shouldStop = scriptShotMode === 'custom'
                    ? (hasSceneInfo && hasRoleInfo && currentShotCount >= targetShots)
                    : (hasSceneInfo && hasRoleInfo);
                  const dbg = getScriptConsistencyDebug(localOutput, originalScriptInputRef.current || taskInputText);
                  console.log('[Tools][Consistency][BeforeFinalStopCheck]', dbg);
                  if (!shouldStop && scriptShotMode === 'custom' && (hasSceneInfo || hasRoleInfo) && currentShotCount < targetShots) {
                      // 丢弃提前的角色/场景信息
                      localOutput = localOutput
                          .replace(/\n?\[角色信息\][\s\S]*$/g, '')
                          .replace(/\n?角色信息\n[\s\S]*$/g, '')
                          .replace(/\n?\[场景信息\][\s\S]*$/g, '')
                          .replace(/\n?\[場景信息\][\s\S]*$/g, '')
                          .replace(/\n?(?:场景信息|場景信息)\n[\s\S]*$/g, '')
                          .trim();
                  }
                  if (shouldStop) {
                      console.log('[Tools] 检测到场景信息已完成，强制结束生成');
                      const dbgStop = getScriptConsistencyDebug(localOutput, originalScriptInputRef.current || taskInputText);
                      console.log('[Tools][Consistency][ForceStop]', dbgStop);
                      // 清理场景信息后的所有内容
                      const sceneInfoIndex = Math.max(
                          localOutput.lastIndexOf('[场景信息]'),
                          localOutput.lastIndexOf('[場景信息]'),
                          localOutput.lastIndexOf('\n场景信息\n'),
                          localOutput.lastIndexOf('\n場景信息\n')
                      );
                      if (sceneInfoIndex !== -1) {
                          // 找到场景信息后的最后一个 [描述] 字段
                          const afterSceneInfo = localOutput.substring(sceneInfoIndex);
                          const lastDescIndex = afterSceneInfo.lastIndexOf('[描述]');
                          if (lastDescIndex !== -1) {
                              // 找到描述内容的结束位置（下一个换行或文本结束）
                              const descStartInFull = sceneInfoIndex + lastDescIndex;
                              let descEndInFull = localOutput.indexOf('\n\n', descStartInFull);
                              if (descEndInFull === -1) {
                                  descEndInFull = localOutput.length;
                              } else {
                                  // 保留描述后的一个空行
                                  descEndInFull += 2;
                              }
                              localOutput = localOutput.substring(0, descEndInFull).trim();
                          }
                      }
                  }
                }
            } else {
                localOutput = localOutput.replace(/\n*生成中\n*/g, '\n\n').replace(/\n*-----\n*/g, '\n\n').replace(/\n*----\n*/g, '\n\n');
            }
            // 清理多余空行
            localOutput = localOutput.replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

            // 中医玄学改写：最终字数兜底（限制在原文±10%内），并再次规范9节课框架
            if (taskMode === ToolMode.REWRITE && taskNiche === NicheType.TCM_METAPHYSICS) {
                const maxAllowed = Math.floor(originalLength * 1.1);
                localOutput = normalizeRewriteFramework(localOutput);
                if (localOutput.length > maxAllowed) {
                    localOutput = truncateToLength(localOutput, maxAllowed);
                }
                localOutput = normalizeRewriteFramework(localOutput);
            }

            // 易经改写：截断至原文±10%内；易经扩写：截断至不超原文×1.5
            if (taskNiche === NicheType.YI_JING_METAPHYSICS) {
                if (taskMode === ToolMode.REWRITE) {
                    const yjMax = Math.floor(originalLength * 1.1);
                    if (localOutput.length > yjMax) {
                        localOutput = truncateToLength(localOutput, yjMax);
                    }
                } else if (taskMode === ToolMode.EXPAND) {
                    const yjExpandMax = Math.max(9600, Math.floor(originalLength * 1.5));
                    if (localOutput.length > yjExpandMax) {
                        localOutput = truncateToLength(localOutput, yjExpandMax);
                    }
                }
            }

            updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });
            
            // 保存历史记录（所有模式，包括摘要模式）
            if (shouldSaveHistory && localOutput.trim()) {
                console.log('[Tools] Content generation complete, saving history...');
                try {
                    const historyKey = getToolsHistoryKey(taskMode, taskNiche);
                    saveHistory('tools', historyKey, localOutput, {
                        input: taskInputText,
                    });
                    console.log('[Tools] 历史记录已保存:', historyKey);
                    
                    // 显示成功通知
                    const modeNames: Record<ToolMode, string> = {
                        [ToolMode.REWRITE]: '改写',
                        [ToolMode.EXPAND]: '扩写',
                        [ToolMode.SUMMARIZE]: '摘要总结',
                        [ToolMode.POLISH]: '润色',
                        [ToolMode.SCRIPT]: '脚本生成（全局模板）',
                    };
                    const modeName = modeNames[taskMode] || '内容';
                    
                    // 确保使用 externalToast（App.tsx 中的 toast 实例）
                    const targetToast = externalToast || internalToast;
                    if (targetToast && typeof targetToast.success === 'function') {
                        targetToast.success(`${modeName}完成！`, 6000);
                    }
                } catch (error) {
                    console.warn('[Tools] 保存历史记录失败:', error);
                }
            }
            
            // 脚本模式：生成完成后保存到 localStorage（保持向后兼容）
            if (taskMode === ToolMode.SCRIPT && localOutput.trim() && isContentComplete(localOutput, taskMode, originalLength, taskNiche)) {
                console.log('[Tools] Content generation complete (verified)');
                try {
                    // 保存最新脚本
                    localStorage.setItem('lastGeneratedScript', localOutput);
                    
                    // 同时保存到历史缓存（最多保留10条）
                    const historyKey = 'scriptHistory_GLOBAL';
                    const historyStr = localStorage.getItem(historyKey);
                    let history: Array<{ content: string; timestamp: number }> = [];
                    
                    if (historyStr) {
                        try {
                            history = JSON.parse(historyStr);
                            if (!Array.isArray(history)) {
                                history = [];
                            }
                        } catch {
                            history = [];
                        }
                    }
                    
                    // 添加新记录到历史（最新的在前）
                    history.unshift({
                        content: localOutput,
                        timestamp: Date.now()
                    });
                    
                    // 只保留最近10条
                    if (history.length > 10) {
                        history = history.slice(0, 10);
                    }
                    
                    localStorage.setItem(historyKey, JSON.stringify(history));
                    console.log('[Tools] Script saved to localStorage');
                } catch (error) {
                    console.warn('[Tools] Failed to save script to localStorage:', error);
                }
            }
            
            // 如果达到最大续写次数但内容不完整，给出提示（非摘要模式）
            if (taskMode !== ToolMode.SUMMARIZE && !shouldSaveHistory && continuationCount >= MAX_CONTINUATIONS) {
                console.log('[Tools] Reached max continuations, stopping');
                
                // 脚本模式：如果达到最大续写次数但内容不完整，给出提示
                if (taskMode === ToolMode.SCRIPT) {
                    if (isRevengeScriptTask) {
                        const textProgress = ((localOutput.length / originalLength) * 100).toFixed(0);
                        if (localOutput.length < originalLength * 0.9) {
                            const warningMsg = `\n\n⚠️ 注意：已达到最大续写次数（${MAX_CONTINUATIONS}次），当前内容可能仍未完成。\n\n当前进度：\n- 已生成长度：${localOutput.length}/${originalLength} 字（${textProgress}%）\n\n请点击“继续生成”再次补全。`;
                            localOutput += warningMsg;
                            updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });
                        }
                    } else {
                        // 计算已搬运的原文字数（与完成判定保持同一统计口径）
                        const copiedTextLength = getCopiedTextLength(localOutput);
                        const copyProgress = ((copiedTextLength / originalLength) * 100).toFixed(0);
                        const shotCount = (localOutput.match(/鏡頭\d+|镜头\d+/g) || []).length;
                        
                        if (copiedTextLength < originalLength * 0.95) {
                            const warningMsg = `\n\n⚠️ 注意：已达到最大续写次数（${MAX_CONTINUATIONS}次），但原文可能未完全转换完成。\n\n当前进度：\n- 已完成镜头：${shotCount} 个\n- 已搬运原文：${copiedTextLength}/${originalLength} 字（${copyProgress}%）\n\n请点击“继续生成”再次补全。`;
                            localOutput += warningMsg;
                            updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode, taskNiche) });
                        }
                    }
                }
            }
    } catch (e: any) {
        const errorMsg = e?.message || String(e) || '未知错误';
        console.error('[Tools] Error:', e);
        
        // 如果是 YouTube 链接且错误信息提示需要转录文本，显示友好提示
        if (isYouTube && (errorMsg.includes('网络') || errorMsg.includes('API Key') || errorMsg.includes('連接'))) {
            updateTask({ outputText: `⚠️ YouTube 视频处理提示\n\n检测到您输入的是 YouTube 视频链接。\n\n由于系统无法直接访问 YouTube 视频内容，请按以下步骤操作：\n\n1. 打开 YouTube 视频\n2. 点击「⋯」菜单 → 选择「显示转录」或「字幕」\n3. 复制完整的转录文本\n4. 将转录文本粘贴到此处（可以保留或删除 YouTube 链接）\n5. 再次点击生成按钮\n\n或者，如果您已经有转录文本，请将文本和链接一起粘贴，系统会自动处理文本内容。\n\n---\n\n错误详情：${errorMsg}` });
        } else {
            // 显示详细的错误信息
            updateTask({ outputText: `❌ 生成内容時发生错误\n\n错误信息：${errorMsg}\n\n请检查：\n1. API Key 是否正确配置\n2. 网络連接是否正常\n3. API 服务是否可用\n\n如果问题持续，请联系技术支持。` });
        }
    } finally {
        updateTask({ isGenerating: false });
        setGenerationProgress(null); // 清除进度
        setShotPromptProgress(null);
    }
  };

  const syncFiveSegmentStateFromOutput = (text: string, sourceInput?: string) => {
    const t = (text || '').trim();
    if (!t) return;
    if (/^✅|^❌|^⏳/.test(t) || /字幕提取成功|YouTube|自动提取字幕失败|手动提取/.test(t)) {
      return;
    }

    const baseInput = (sourceInput ?? inputText) || '';
    const baseSegs = splitTextIntoFiveSegments(baseInput);
    const outSegs = splitTextIntoFiveSegments(t);
    setRewriteSegments(baseSegs);
    setSegmentOutputs(outSegs.map((s, i) => s || baseSegs[i] || ''));
    setMergedOutput('');
  };

  const parseOutlineToFiveItems = (outline: string): string[] => {
    const lines = outline
      .split('\n')
      .map(l => l.replace(/^\s*[-*\d一二三四五六七八九十\.、:：\)\(]+\s*/, '').trim())
      .filter(Boolean);
    const items = lines.slice(0, 5);
    while (items.length < 5) items.push('');
    return items;
  };

  const extractOutlineAndInitializeFiveSegments = async (text: string): Promise<string[]> => {
    const raw = text.trim();
    if (!raw) {
      toast.warning('请先输入原文');
      return ['', '', '', '', ''];
    }

    if (!apiKey?.trim()) {
      const segs = splitTextIntoFiveSegments(raw);
      setOutlineItems(segs.map((s, i) => `第${i + 1}段要点：${(s || '').slice(0, 36)}...`));
      setOutlineText(segs.map((s, i) => `${i + 1}. 第${i + 1}段要点：${(s || '').slice(0, 60)}`).join('\n'));
      setRewriteSegments(segs);
      setSegmentOutputs(segs);
      setMergedOutput('');
      appendTerminal('未配置 API Key，已使用本地规则拆分并生成简版大纲。');
      return segs;
    }

    setIsExtractingOutline(true);
    setAutoPilotStage('outline');
    appendTerminal('正在提炼原文5段大纲...');
    try {
      initializeGemini(apiKey, { provider });
      let outline = '';
      const prompt = `请将以下原文提炼为严格5条分段大纲（第1段-第5段），每条1-2句，按原文逻辑推进，不要遗漏核心观点。只输出5条，不要解释。\n\n原文：\n${raw}`;
      await streamContentGeneration(
        prompt,
        '你是专业中文总编，只输出5条清晰大纲。',
        (chunk) => {
          outline += chunk;
          setOutlineText(outline);
        },
        ...deepRewriteStreamModelArgs(calcMaxTokens(600))
      );

      const parsed = parseOutlineToFiveItems(outline || raw);
      const segs = splitTextIntoFiveSegments(raw);
      setOutlineItems(parsed);
      setOutlineText(outline.trim());
      setRewriteSegments(segs);
      setSegmentOutputs(segs);
      setMergedOutput('');
      setAutoPilotStage('split');
      setAllSegmentsDoneNotified(false);
      appendTerminal('5段大纲提炼完成，已初始化分段。');
      return segs;
    } catch (e: any) {
      const segs = splitTextIntoFiveSegments(raw);
      setOutlineItems(segs.map((s, i) => `第${i + 1}段要点：${(s || '').slice(0, 36)}...`));
      setOutlineText('大纲提炼失败，已回退本地拆分。');
      setRewriteSegments(segs);
      setSegmentOutputs(segs);
      setMergedOutput('');
      appendTerminal(`大纲提炼失败，已回退本地拆分：${e?.message || e}`);
      return segs;
    } finally {
      setIsExtractingOutline(false);
    }
  };

  const initializeFiveSegmentsFromText = async (text: string, logMessage?: string) => {
    await extractOutlineAndInitializeFiveSegments(text);
    appendTerminal(logMessage || '已将原文拆分为5段，可逐段洗稿/扩写/润色。');
  };

  const handleInitializeFiveSegments = async () => {
    if (!inputText.trim()) {
      toast.warning('请先输入需要处理的文案');
      return;
    }
    await initializeFiveSegmentsFromText(inputText);
  };

  const handleClearDeepRewritePanel = () => {
    setInputText('');
    setPainPointText('');
    setTerminalLog('等待任务...\n[系统] 已清空深度洗稿面板。');
    setRewriteSegments(['', '', '', '', '']);
    setSegmentOutputs(['', '', '', '', '']);
    setSegmentGenerating([false, false, false, false, false]);
    setMergedOutput('');
    setOutlineText('');
    setOutlineItems(['', '', '', '', '']);
    setOutputText('');
    // 清空评论区提取状态
    setCommentResult(null);
    setIsExtractingComments(false);
    setIsAnalyzingPainPoints(false);
    toast.success('面板已清空');
  };

  // 频道生成器清理函数
  const handleClearChannelPanel = () => {
    setChannelTopic('');
    setChannelTargetAudience('');
    setChannelContentType('');
    setChannelBrandPositioning('');
    setChannelOutput(null);
    setGeneratedAvatarImages([]);
    setGeneratedBannerImages([]);
    toast.success('频道生成器已清空');
  };

  const getRewriteTargetLanguageInstruction = (sampleText: string) => {
    const map: Record<string, string> = {
      source: '与原文保持同语言输出（原文中文就输出中文，原文英文就输出英文，其他语言同理）',
      zh: '简体中文',
      en: 'English',
      ja: '日本語',
      ko: '한국어',
      es: 'Español',
      de: 'Deutsch',
      hi: 'हिन्दी',
    };
    if (rewriteOutputLanguage !== 'source') return map[rewriteOutputLanguage];
    const detected = detectToolsInputLanguage(sampleText || inputText);
    if (/English/i.test(detected)) return 'English';
    return '与原文保持同语言输出（原文中文就输出中文，原文英文就输出英文，其他语言同理）';
  };

  // ── 评论区痛点提取 ──────────────────────────────────────
  /** 从左侧原始文案输入框的 YouTube 链接提取评论并自动分析痛点 */
  async function extractCommentsAndPainPoints() {
    const videoId = extractYouTubeVideoId(inputText.trim());
    if (!videoId) {
      toast.error('无法识别的 YouTube 链接，请确保左侧输入框包含有效的 YouTube 链接');
      return;
    }

    setIsExtractingComments(true);
    setCommentResult(null);
    setIsAnalyzingPainPoints(false);
    appendTerminal(`[评论提取] 开始提取视频 ${videoId} 的评论...`);

    try {
      const result = await ytGetVideoComments(videoId, youtubeApiKey || undefined, 50);
      setCommentResult(result);

      if (result.comments.length === 0) {
        appendTerminal(`[评论提取] 该视频暂无评论或评论已关闭`);
        toast.warning('该视频暂无评论或评论已关闭');
        setIsExtractingComments(false);
        return;
      }

      appendTerminal(`[评论提取] 成功提取 ${result.comments.length} 条评论，开始分析用户痛点...`);

      // 自动调用 Gemini 分析痛点
      await analyzePainPointsFromComments(result);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      appendTerminal(`[评论提取] 提取失败: ${errMsg}`);
      toast.error(`评论提取失败: ${errMsg}`);
    } finally {
      setIsExtractingComments(false);
    }
  }

  /** 分析评论提取痛点 */
  async function analyzePainPointsFromComments(result: CommentResult) {
    setIsAnalyzingPainPoints(true);
    appendTerminal(`[痛点分析] 正在调用 Gemini 模型分析评论...`);

    const commentsText = result.comments
      .map((c, i) => `${i + 1}. ${c.text}`)
      .join('\n');

    const systemInstruction = `你是一个用户评论分析助手。

【你的任务】
从评论中提炼出用户的核心痛点需求。

【清洗规则】
过滤掉以下无效评论：
- 广告、推广信息
- 刷屏内容（"沙发"、"前排"、"哈哈"、"666"等无意义内容）
- 纯表情、符号
- 与视频内容无关的评论

【输出要求】
- 只输出 3-5 条用户痛点，每条一行
- 格式：1. 痛点内容
- 不要有任何解释、前言、总结
- 不要说"根据评论分析"之类的话
- 直接输出纯痛点列表`;

    const prompt = `评论内容：\n${commentsText}\n\n请直接输出用户痛点列表。`;

    let rawResult = '';
    try {
      await streamContentGeneration(
        prompt,
        systemInstruction,
        (chunk) => {
          rawResult += chunk;
          let cleaned = rawResult
            .replace(/^(以下是|根据评论|用户痛点[:：]?|分析结果[:：]?|用户反馈[:：]?)\s*/gim, '')
            .replace(/^[-—–_=*~`#]+$/gm, '')
            .trim();
          setPainPointText(cleaned);
        },
        'gpt-5.4-mini',
        { temperature: 0.3, maxTokens: 1024 }
      );
      appendTerminal(`[痛点分析] 分析完成`);
      toast.success('用户痛点已提取并填入评论区输入框');
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      appendTerminal(`[痛点分析] 分析失败: ${errMsg}`);
      toast.error(`痛点分析失败: ${errMsg}`);
    } finally {
      setIsAnalyzingPainPoints(false);
    }
  }

  const handleRegenerateSingleSegment = async (idx: number, forcedSource?: string, forcedMode?: ToolMode): Promise<string> => {
    const source = (forcedSource ?? rewriteSegments[idx] ?? '').trim();
    if (!apiKey || !source) {
      toast.warning('该分段为空，无法重新生成');
      return '';
    }

    const segSource = source;
      const effectiveMode = forcedMode ?? mode;

      const sourceCharCount = segSource.replace(/\s+/g, '').length;
    setSegmentGenerating(prev => prev.map((v, i) => (i === idx ? true : v)));
    appendTerminal(`开始生成第 ${idx + 1} 段...`);

    try {
      initializeGemini(apiKey, { provider });
      let out = '';
      const modeText =
        effectiveMode === ToolMode.EXPAND ? '深度扩写' : effectiveMode === ToolMode.POLISH ? '润色优化' : '深度洗稿';
      const targetLang = getRewriteTargetLanguageInstruction(segSource);
      const segmentOutline = outlineItems[idx] || `第${idx + 1}段`;
      const rewriteRange = rewriteRangeMap[rewriteLengthMode] || rewriteRangeMap.balanced;
      const expandRange = expandRangeMap[rewriteLengthMode] || expandRangeMap.balanced;
      const rewritePolicy = rewriteRangeMap[rewriteLengthMode] || rewriteRangeMap.balanced;
      const rewriteTargetMin =
        effectiveMode === ToolMode.EXPAND
          ? (sourceCharCount > 0 ? Math.round(sourceCharCount * expandRange.min) : 40)
          : Math.max(Math.round(sourceCharCount * rewritePolicy.segmentMin), 40);
      const rewriteTargetMax =
        effectiveMode === ToolMode.EXPAND
          ? Math.max(
              sourceCharCount > 0 ? Math.round(sourceCharCount * expandRange.max) : 80,
              rewriteTargetMin + 10
            )
          : Math.max(Math.round(sourceCharCount * rewritePolicy.segmentMax), rewriteTargetMin + 10);
      const expectedMin = rewriteTargetMin;
      const nicheName = NICHES[niche]?.name || niche;
      const segPctMin = Math.round(rewritePolicy.segmentMin * 100);
      const segPctMax = Math.round(rewritePolicy.segmentMax * 100);
      const expandPctMin = Math.round(expandRange.min * 100);
      const expandPctMax = Math.round(expandRange.max * 100);
      const isChineseSeg = /[\u4e00-\u9fff]/.test(segSource);
      const charUnit = isChineseSeg ? '字（去空白）' : '字符（去空白）';
      
      // 中医玄学赛道特殊约束：根据段索引生成不同内容
      const tcmSegmentConstraint = niche === NicheType.TCM_METAPHYSICS ? (() => {
        // 获取前段结尾用于衔接
        const prevEnding = idx > 0 ? (segmentOutputs[idx - 1] || '').trim().slice(-200) : '';
        
        if (idx === 0) {
          // 第1段：开场白 + 引子（聚焦当天风险与核心警告）
          return `【中医玄学赛道·第1段特殊约束·必须严格遵守】
【⚠️ 核心概念】这是长篇文章的第1章，不是完整文章！全文共5章，必须连贯！
【第1段结构】
1. 以"各位老友们好，欢迎来到我的频道，我是你们的老朋友倪海厦。"开场（只出现一次，在第1段开头）
2. 紧接着输出引子段落（聚焦当天风险与核心警告）
3. 引子结束后输出"好了，我们开始上课。"
4. 然后输出第1章正文内容（围绕本段大纲展开）
【强制禁止】
- "各位老友们好..."只允许在第1段开头出现一次
- "好了，我们开始上课。"只允许在第1段引子后出现一次
- 禁止输出"第1课"、"第2课"等章节标记
- 禁止输出任何其他开场白或过渡语
- 第1章正文要有实质性内容，不能只是引子`;
        } else if (idx === 4) {
          // 第5段：正文承接 + 收尾升华
          return `【中医玄学赛道·第5段特殊约束·必须严格遵守】
【⚠️ 核心概念】这是长篇文章的第5章（最后一章），不是完整文章！
【前段结尾衔接参考】${prevEnding || '无'}
【第5段结构】
1. 自然承接上文内容，不要重复前段已讲的内容
2. 深入展开本段大纲主题
3. 结尾要有倪海厦风格收尾（如"好了，我话讲完了，信不信随你。下课！"）
【强制禁止】
- 禁止输出任何开场白（"各位老友们好..."）
- 禁止输出任何过渡语（"好了，我们开始上课。"）
- 禁止输出"第5课"、"最后一课"等章节标记
- 禁止输出任何引导语或解释性文字
- 禁止生成"下期再见"、"今天就讲到这"等收尾语（用倪海厦霸气风格代替）`;
        } else {
          // 第2-4段：纯正文承接
          return `【中医玄学赛道·第${idx + 1}段特殊约束·必须严格遵守】
【⚠️ 核心概念】这是长篇文章的第${idx + 1}章，不是完整文章！
【前段结尾衔接参考】${prevEnding || '无'}
【第${idx + 1}段结构】
1. 自然承接前段内容，使用过渡句衔接
2. 围绕本段大纲展开论述，要有具体案例或细节
3. 内容要有深度，不能泛泛而谈
【强制禁止】
- 禁止输出任何开场白（"各位老友们好..."）
- 禁止输出任何过渡语（"好了，我们开始上课。"）
- 禁止输出"第${idx + 1}课"、"第${idx + 2}课"等章节标记
- 禁止输出任何引导语或解释性文字
- 禁止重复前段已讲过的案例或观点`;
        }
      })() : '';
      
      const prompt = `请执行【${modeText}】，基于以下规则重写第${idx + 1}段：

【赛道】${nicheName}
【输出语言】${targetLang}
【分段大纲】${segmentOutline}
【评论区痛点/关键词】${painPointText || '无'}
【本段序号】第${idx + 1}段（共5段）
${niche === NicheType.TCM_METAPHYSICS ? '' : idx > 0 ? `【前段结尾】（仅作衔接参考，不可照抄）\n${(segmentOutputs[idx - 1] || '').trim().slice(-100)}` : '【前段结尾】无'}

【原文分段】
${segSource}

【硬性约束】
${niche === NicheType.TCM_METAPHYSICS ? tcmSegmentConstraint : `【赛道】${nicheName}
【字数要求（去空白计字）】${rewriteTargetMin} ~ ${rewriteTargetMax} ${charUnit}
- 不得照抄原句，不得只换同义词
- 保留核心中心思想，但表达必须重构`}
- ${effectiveMode === ToolMode.EXPAND
    ? `【深度扩写 · 扩写强度策略】该段原文约 ${sourceCharCount} 字，输出必须控制在 ${rewriteTargetMin}~${rewriteTargetMax} 字，约为原文 ${expandPctMin}%~${expandPctMax}% 体量（约 ${expandRange.min}~${expandRange.max} 倍），且必须明显长于原文`
    : `输出字数（去空白计字）控制在 ${rewriteTargetMin} ~ ${rewriteTargetMax} 字（${modeText}，按当前洗稿字数策略执行）`}
${niche !== NicheType.TCM_METAPHYSICS ? `- 必须完整收尾，结尾句闭环` : ''}
- 输出字数必须在 ${rewriteTargetMin} ~ ${rewriteTargetMax} ${charUnit} 之间，超出上限算失败！
- 只输出正文，不要解释，不要标题`;
      // 强制字数上限（按非空白字符计）：目标上限 * 1.3，安全截止不截断
      const hardCap = Math.ceil(rewriteTargetMax * 1.3);
      await streamContentGeneration(
        prompt,
        '你是资深多语种内容总编，必须深度重写并满足长度与维度约束。',
        (chunk) => {
          const nonWhiteAcc = (out || '').replace(/\s+/g, '');
          const remaining = hardCap - nonWhiteAcc.length;
          if (remaining <= 0) return;
          const nonWhiteChunk = (chunk || '').replace(/\s+/g, '');
          if (nonWhiteChunk.length <= remaining) {
            out += chunk;
          } else {
            // 按非空白字符数截断，防止截断到 char 中间导致乱码
            let ci = 0;
            let count = 0;
            for (ci = 0; ci < (chunk || '').length && count < remaining; ci++) {
              if (!/\s/.test(chunk[ci])) count++;
            }
            out += (chunk || '').slice(0, ci);
          }
          setSegmentOutputs(prev => prev.map((v, i) => (i === idx ? out : v)));
        },
        ...deepRewriteStreamModelArgs(calcMaxTokens(hardCap))
      );

      let finalOut = out.trim();
      const segMin = rewriteTargetMin;
      const segMax = rewriteTargetMax;

      if (effectiveMode === ToolMode.EXPAND) {
        const maxExpandPasses = 3;
        let segLen = finalOut.replace(/\s+/g, '').length;
        let pass = 0;
        while (segLen < segMin && pass < maxExpandPasses) {
          pass += 1;
          appendTerminal(
            `第 ${idx + 1} 段扩写字数偏低（${segLen} < ${segMin}，去空白计字），基于当前成稿继续扩写（第 ${pass}/${maxExpandPasses} 次）...`
          );
          let expanded = '';
          const deepenPrompt = `你是深度扩写编辑。请在「当前成稿」上继续扩写，禁止推翻重写、禁止只重复堆砌同义句。

【计字】去空白后的字符数；输出必须在 ${segMin}~${segMax} 字之间。
【策略】该段原文约 ${sourceCharCount} 字，目标约为原文 ${expandPctMin}%~${expandPctMax}% 体量（扩写强度约 ${expandRange.min}~${expandRange.max} 倍），必须明显长于原文。
【要求】
1) 在现有成稿上增量展开：至少加强场景/细节/论证/情绪/过渡/事例/金句中的多类维度
2) 保留当前成稿的核心观点与叙事主线
3) 结尾完整闭环；只输出正文

【该段原文】
${segSource}

【当前成稿】
${finalOut}`;
          const expandHardCap = Math.ceil(segMax * 1.3);
          await streamContentGeneration(
            deepenPrompt,
            '你是深度扩写编辑，只在成稿上增量扩写直至字数达标。',
            (chunk) => {
              const accLen = (expanded || '').replace(/\s+/g, '').length;
              const remaining = expandHardCap - accLen;
              if (remaining <= 0) return;
              const chunkLen = (chunk || '').replace(/\s+/g, '').length;
              expanded += chunkLen <= remaining ? chunk : chunk.slice(0, Math.max(0, remaining));
              setSegmentOutputs(prev => prev.map((v, i) => (i === idx ? expanded : v)));
            },
            ...deepRewriteStreamModelArgs(calcMaxTokens(expandHardCap))
          );
          if (expanded.trim()) finalOut = expanded.trim();
          segLen = finalOut.replace(/\s+/g, '').length;
        }

        if (segLen > segMax) {
          appendTerminal(`第 ${idx + 1} 段扩写字数偏高（${segLen} > ${segMax}），基于当前成稿做温和压缩...`);
          let compressed = '';
          const compressExpandPrompt = `你是内容编辑。请在「当前成稿」上做温和压缩，不要推翻主线。

【计字】去空白后的字符数；输出必须在 ${segMin}~${segMax} 字之间（该段原文约 ${sourceCharCount} 字，扩写强度约 ${expandRange.min}~${expandRange.max} 倍）。
【要求】删除重复与赘述，保留核心信息与因果；结尾完整；只输出正文

【该段原文】
${segSource}

【当前成稿】
${finalOut}`;
          await streamContentGeneration(
            compressExpandPrompt,
            '你是精简编辑，只做保真压缩以回到目标区间。',
            (chunk) => {
              const accLen = (compressed || '').replace(/\s+/g, '').length;
              const remaining = segMax - accLen;
              if (remaining <= 0) return;
              const chunkLen = (chunk || '').replace(/\s+/g, '').length;
              compressed += chunkLen <= remaining ? chunk : chunk.slice(0, Math.max(0, remaining));
              setSegmentOutputs(prev => prev.map((v, i) => (i === idx ? compressed : v)));
            },
            ...deepRewriteStreamModelArgs(calcMaxTokens(segMax))
          );
          if (compressed.trim()) finalOut = compressed.trim();
          segLen = finalOut.replace(/\s+/g, '').length;
        }

        const inRange = segLen >= segMin && segLen <= segMax;
        const complete = isTextLikelyComplete(finalOut);
        if (!inRange || !complete) {
          appendTerminal(
            `⚠️ 第 ${idx + 1} 段扩写仍未完全达标（字数 ${segLen}，目标 ${segMin}~${segMax}；${complete ? '收尾完整' : '收尾不完整'}），可再点「重新生成该部分」。`
          );
        }
      } else {
        let segLen = finalOut.replace(/\s+/g, '').length;

        // 补强扩写只在字数明显不足时触发（超过5%不足）
        if (segLen < segMin && segLen < segMin * 0.95) {
          let expanded = '';
          const expandPrompt = `请在“当前改写结果”基础上做补强扩写，不要推翻重写。\n\n要求：\n1) 输出字数控制在 ${segMin}~${segMax} 字（约原段 ${segPctMin}%~${segPctMax}%，与当前洗稿字数策略一致）\n2) 保留当前段核心观点与结构\n3) 增加必要过渡、细节、解释，避免灌水\n4) 结尾必须完整闭环\n5) 只输出正文\n\n【原文分段】\n${segSource}\n\n【当前改写结果】\n${finalOut}`;
          await streamContentGeneration(
            expandPrompt,
            '你是内容补强编辑，只做增量扩写，保持原有主线。',
            (chunk) => {
              expanded += chunk;
              setSegmentOutputs(prev => prev.map((v, i) => (i === idx ? expanded : v)));
            },
            ...deepRewriteStreamModelArgs(calcMaxTokens(rewriteTargetMax))
          );
          if (expanded.trim()) finalOut = expanded.trim();
          segLen = finalOut.replace(/\s+/g, '').length;
        }

        // 压缩：超出即触发，最多2次；2次后切换补强扩写（而非继续压短导致内容被过度删除）
        if (segLen > segMax) {
          let compressPass = 0;
          const maxCompressPasses = 2;
          let lastCompressed = finalOut;
          while (segLen > segMax && compressPass < maxCompressPasses) {
            compressPass++;
            const targetCompress = Math.ceil((segLen - segMax) / segMax * 100);
            appendTerminal(`第 ${idx + 1} 段字数偏高（${segLen} > ${segMax}），第 ${compressPass}/${maxCompressPasses} 次压缩（需删减约${targetCompress}%）...`);
            let compressed = '';
            const compressPrompt = `你是一个严格的内容精简编辑器。当前文本超出字数上限，必须删减内容以符合字数要求。

【字数要求（必须严格执行）】
- 当前字数：${segLen} 字（去空白）
- 上限：${segMax} 字
- 需删减至：${segMax} 字以内
- 删减比例：约 ${targetCompress}%

【删减原则】
1. 删除重复表达、冗余描述
2. 合并相同观点的句子
3. 精简过渡句和解释性语句
4. 保留核心观点、关键数据和结论
5. 不得改变原意，不得删除关键信息

【当前文本】
${finalOut}

【输出要求】
- 输出字数必须在 ${segMax} 字以内
- 只输出精简后的正文，不要解释
- 必须完整收尾`;

            await streamContentGeneration(
              compressPrompt,
              '你是严格的内容精简编辑，必须删除内容以满足字数要求。',
              (chunk) => {
                compressed += chunk;
                setSegmentOutputs(prev => prev.map((v, i) => (i === idx ? compressed : v)));
              },
              ...deepRewriteStreamModelArgs(calcMaxTokens(rewriteTargetMax))
            );
            if (compressed.trim()) {
              lastCompressed = compressed.trim();
              finalOut = lastCompressed;
              segLen = finalOut.replace(/\s+/g, '').length;
            }
          }

          // 压缩2次后仍未达标 → 切换为补强扩写：保留较长的那次结果，在此基础上扩展至达标
          if (segLen > segMax && compressPass >= maxCompressPasses) {
            appendTerminal(`⚠️ 第 ${idx + 1} 段压缩${maxCompressPasses}次后仍偏长（${segLen} > ${segMax}），切换补强扩写而非继续压短...`);
            // 保留 lastCompressed（已精简的版本），在其基础上做补强扩写
            const expandAfterCompressPrompt = `请在"当前精简后成稿"基础上做补强扩写，使其达到目标字数。

要求：
1) 输出字数控制在 ${segMin}~${segMax} 字
2) 保留当前成稿核心内容，只做适度扩展（增加细节/过渡/案例）
3) 不得推翻精简后的结构，不得删除任何已有内容
4) 结尾必须完整闭环
5) 只输出正文，不要解释

【原文分段】
${segSource}

【当前精简成稿】
${finalOut}`;
            let expandedAfterCompress = '';
            await streamContentGeneration(
              expandAfterCompressPrompt,
              '你是补强扩写编辑，在精简稿基础上适度扩展至目标字数。',
              (chunk) => {
                expandedAfterCompress += chunk;
                setSegmentOutputs(prev => prev.map((v, i) => (i === idx ? expandedAfterCompress : v)));
              },
              ...deepRewriteStreamModelArgs(calcMaxTokens(rewriteTargetMax))
            );
            if (expandedAfterCompress.trim()) {
              finalOut = expandedAfterCompress.trim();
              segLen = finalOut.replace(/\s+/g, '').length;
            }
          }
        }

        const inRange = segLen >= segMin && segLen <= segMax;
        const complete = isTextLikelyComplete(finalOut);
        if (!inRange || !complete) {
          appendTerminal(`⚠️ 第 ${idx + 1} 段仍未完全达标（字数 ${segLen}，目标 ${segMin}~${segMax}；${complete ? '收尾完整' : '收尾不完整'}），请手动点“重新生成该部分”。`);
        }
      }

      // 中医玄学赛道：第2-5段生成后清洗所有固定开场语（段首+段中）
      if (niche === NicheType.TCM_METAPHYSICS && idx > 0) {
        const TCM_FIXED_PATTERNS = [
          /^各位老友们好，欢迎来到我的频道，我是(你们的老朋友)?倪海厦[。!！]\s*/,
          /^各位老友们好，欢迎来到我的频道，我是(你们的老朋友)?祝海霞[。!！]\s*/,
          /^各位老友们好，欢迎来到我的频道，我是(你们的老朋友)?[^\s，,。!！]+[。!！]\s*/,
        ];
        TCM_FIXED_PATTERNS.forEach(p => {
          finalOut = finalOut.replace(p, '');
        });
        // 清洗段中任何位置的"好了，我们开始上课"（包括前后有换行、空格的情况）
        finalOut = finalOut.replace(/[\n\s]*好了，我们开始上课[。]\s*/g, '\n');
        finalOut = finalOut.replace(/\s*好了，我们开始上课[。.。]\s*/g, '\n');
        finalOut = finalOut.replace(/好了[\s\S]*們開始上課[。.。]/g, '');
        // 清洗"第X节课"开头（段首）
        finalOut = finalOut.replace(/^第[一二三四五六七八九十\d]+节课[:：]?\s*/g, '');
        // 清洗段中的"第X节课"
        finalOut = finalOut.replace(/\n第[一二三四五六七八九十\d]+节课[:：]?\s*/g, '\n');
        // 清洗段中的"第X课"
        finalOut = finalOut.replace(/\n第一课\s*/g, '\n');
        finalOut = finalOut.replace(/\n第二课\s*/g, '\n');
        finalOut = finalOut.replace(/\n第三课\s*/g, '\n');
        finalOut = finalOut.replace(/\n第四课\s*/g, '\n');
        finalOut = finalOut.replace(/\n第五课\s*/g, '\n');
        finalOut = finalOut.replace(/\n第[一二三四五六七八九十\d]+课\s*/g, '\n');
        // 清理连续空行
        finalOut = finalOut.replace(/\n{3,}/g, '\n\n');
        finalOut = finalOut.trim();
      }

      setSegmentOutputs(prev => prev.map((v, i) => (i === idx ? finalOut : v)));
      appendTerminal(`第 ${idx + 1} 段生成完成。`);
      return finalOut;
    } catch (e: any) {
      appendTerminal(`第 ${idx + 1} 段生成失败：${e?.message || e}`);
      toast.error(`第 ${idx + 1} 段生成失败`);
      return '';
    } finally {
      setSegmentGenerating(prev => prev.map((v, i) => (i === idx ? false : v)));
    }
  };

  const handleAutoPilotGenerateFiveSegments = async () => {
    if (!inputText.trim()) {
      toast.warning('请先输入需要处理的文案');
      return;
    }

    appendTerminal('开始自动一键：提炼大纲 -> 拆分5段 -> 并行生成 -> 自动合并...');
    const sourceSegs = await extractOutlineAndInitializeFiveSegments(inputText);
    setAutoPilotStage('generate');
    appendTerminal(`已完成前置规划：5段框架 + 目标字数策略（${mode === ToolMode.EXPAND ? '扩写' : '洗稿/润色'}-${rewriteLengthMode}）。`);

    const indexes = [0, 1, 2, 3, 4].filter(i => (sourceSegs[i] || '').trim().length > 0);
    if (indexes.length === 0) {
      toast.warning('没有可生成的分段内容');
      return;
    }

    const generatedList = await Promise.all(indexes.map((i) => handleRegenerateSingleSegment(i, sourceSegs[i], ToolMode.EXPAND)));
    const finalSegments = [...sourceSegs];
    indexes.forEach((idx, p) => {
      const generated = (generatedList[p] || '').trim();
      if (generated) finalSegments[idx] = generated;
    });

    setSegmentOutputs(finalSegments);

    appendTerminal('5段并行生成完成，开始自动合并最终文案...');
    await handleMergeFinalWithPolish(finalSegments);

    setAutoPilotStage('done');
    appendTerminal('全自动一键流程完成（含大纲提炼 + 自动合并）。');
  };

  const handleMergeFinalWithPolish = async (segmentsOverride?: string[]) => {
    const effectiveSegments = (segmentsOverride && segmentsOverride.length === 5)
      ? segmentsOverride
      : segmentOutputs;
    const rawMerged = mergeFiveSegments(effectiveSegments);
    if (!rawMerged.trim()) {
      toast.warning('没有可合并的内容');
      return;
    }

    if (!apiKey?.trim()) {
      setMergedOutput(rawMerged);
      appendTerminal('未配置 API Key，已按原样合并。');
      toast.info('已原样合并（未配置 API Key，跳过衔接优化）');
      return;
    }

    setIsOptimizingMerge(true);
    setAutoPilotStage('merge');
    appendTerminal('开始执行“分段清洗 -> 全文合并优化”流程...');

    try {
      initializeGemini(apiKey, { provider });
      let polished = '';
      const modeText = mode === ToolMode.EXPAND ? '深度扩写' : mode === ToolMode.POLISH ? '润色优化' : '深度洗稿';
      const targetLang = getRewriteTargetLanguageInstruction(rawMerged);
      const sourceLen = (inputText || '').replace(/\s+/g, '').length;
      const rewriteRange = rewriteRangeMap[rewriteLengthMode] || rewriteRangeMap.balanced;
      const expandRange = expandRangeMap[rewriteLengthMode] || expandRangeMap.balanced;
      const minFinalLen = mode === ToolMode.EXPAND
        ? Math.round(sourceLen * expandRange.min)
        : Math.round(sourceLen * rewriteRange.finalMin);
      const maxFinalLen = mode === ToolMode.EXPAND
        ? Math.round(sourceLen * expandRange.max)
        : Math.round(sourceLen * rewriteRange.finalMax);
      const mergeRewriteLenRule =
        mode !== ToolMode.EXPAND
          ? `最终成稿（去空白计字）控制在 ${minFinalLen}~${maxFinalLen} 字，对应「${rewriteRange.label}」：相对全篇原文约 ${Math.round(rewriteRange.finalMin * 100)}%~${Math.round(rewriteRange.finalMax * 100)}%，完整性优先，禁止重构成全新文案`
          : '';

      let cleanedSegmentsForMerge = [...effectiveSegments];
      const preCleanTotal = cleanedSegmentsForMerge.reduce((s, seg) => s + ((seg || '').replace(/\s+/g, '').length), 0);
      // 关键修外\uff1a如果合并前总字数已低于下限\uff0c行接清洗时禁止压缩\uff0c只能轻微衔接调整
      const skipCompressInClean = preCleanTotal < minFinalLen;
      if (skipCompressInClean) {
        appendTerminal(`⚠️ 合并前总字数 ${preCleanTotal} 已低于目标下限 ${minFinalLen}\uff0c行接清洗跳过压缩\uff0c直接拼接...`);
      } else {
        appendTerminal('开始逐段“衔接检查式清洗”（并行执行，仅检查段首/段尾衔接，不改主体）...');
      }


      const cleanedResults = await Promise.all(
        cleanedSegmentsForMerge.map(async (segRaw, i) => {
          const seg = (segRaw || '').trim();
          if (!seg) return { idx: i, text: segRaw, changed: false, note: `第 ${i + 1} 段为空，跳过。` };

          const prev = i > 0 ? (cleanedSegmentsForMerge[i - 1] || '').trim() : '';
          const next = i < cleanedSegmentsForMerge.length - 1 ? (cleanedSegmentsForMerge[i + 1] || '').trim() : '';

          if (isTextLikelyComplete(seg) && !prev && !next) {
            return { idx: i, text: segRaw, changed: false, note: `第 ${i + 1} 段衔接检查：通过（首尾无上下文，保持原段）。` };
          }

          let cleaned = '';
          const segLen = seg.replace(/\s+/g, '').length;
          // 洗稿模式：衔接清洗只做边界微调，字数基本不变
          const segMin = Math.max(Math.round(segLen * 0.97), segLen - 50); // 允许减少最多50字
          const segMax = Math.round(segLen * 1.03); // 最多增加3%
          const segPrompt = `你要做"衔接检查式微调"，禁止重写本段主体，禁止大幅增加字数。

任务：
- 只允许改本段开头1-2句和结尾1-2句，用于与上下文无缝衔接
- 中间主体段落必须保持不变
- 如果本段已连贯且不突兀，原样返回
- 严禁增加新内容或展开细节

硬性限制：
1) 输出字数必须在 ${segMin}~${segMax} 字（禁止大幅增加）
2) 不得删减核心观点，不得重写为新文案，不得增加新内容
3) 只输出修订后的本段正文

【上一段结尾】
${prev ? prev.slice(-220) : '（��）'}

【当前段】
${seg}

【下一段开头】
${next ? next.slice(0, 220) : '（无）'}`;
          await streamContentGeneration(
            segPrompt,
            '你是衔接编辑，只做边界微调，不动主体，不增加字数。',
            (chunk) => {
              cleaned += chunk;
            },
            ...deepRewriteStreamModelArgs(calcMaxTokens(segMax))
          );

          const cleanedText = (cleaned || '').trim();
          if (!cleanedText) {
            return { idx: i, text: segRaw, changed: false, note: `第 ${i + 1} 段衔接清洗返回空，已保留原段。` };
          }

          const cleanedLen = cleanedText.replace(/\s+/g, '').length;
          const lenOk = cleanedLen >= segMin && cleanedLen <= segMax;
          if (!lenOk) {
            return { idx: i, text: segRaw, changed: false, note: `第 ${i + 1} 段衔接清洗超出长度边界（${segLen} -> ${cleanedLen}，边界 ${segMin}~${segMax}），已回退原段。` };
          }

          return { idx: i, text: cleanedText, changed: true, note: `第 ${i + 1} 段衔接清洗完成：${segLen} -> ${cleanedLen} 字` };
        })
      );

      cleanedResults.forEach((r) => {
        cleanedSegmentsForMerge[r.idx] = r.text;
        appendTerminal(r.note);
      });

      // 合并前再次清洗固定模式（防止衔接清洗后重新出现）
      cleanedSegmentsForMerge = cleanedSegmentsForMerge.map((seg, segIdx) => {
        let result = (seg || '').trim();
        const patterns = [
          /^各位老友们好，欢迎来到我的频道，我是(你们的老朋友)?倪海厦[。!！]\s*/,
          /^各位老友们好，欢迎来到我的频道，我是(你们的老朋友)?祝海霞[。!！]\s*/,
          /^各位老友们好，欢迎来到我的频道，我是(你们的老朋友)?[^\s，,。!！]+[。!！]\s*/,
          /^好了，我们开始上课[。]\s*/,
          /^好了，我們開始上課[。]\s*/,
          /^第[一二三四五六七八九十]节课[:：]?\s*/,
          /^第[一二三四五六七八九十]節課[:：]?\s*/,
          /^第[一二三四五六七八九十\d]+节课[:：]?\s*/,
        ];
        patterns.forEach(p => { result = result.replace(p, ''); });
        // 段中清洗"好了，我们开始上课"
        if (segIdx > 0) {
          result = result.replace(/\n\s*好了，我们开始上课[。.。]\s*/g, '\n');
          result = result.replace(/\s*好了，我们开始上课[。.。]\s*/g, '\n');
          result = result.replace(/[\s\S]*我們開始上課[。.。]/g, '');
          result = result.replace(/\n各位老友们好，欢迎来到我的频道，我是你们的老朋友倪海厦[。!！]\s*/g, '\n');
          result = result.replace(/\n各位老友们好，欢迎来到我的频道，我是[^\s，,。!！]+[。!！]\s*/g, '\n');
          result = result.replace(/\n第一课\s*/g, '\n');
          result = result.replace(/\n第二课\s*/g, '\n');
          result = result.replace(/\n第三课\s*/g, '\n');
          result = result.replace(/\n第四课\s*/g, '\n');
          result = result.replace(/\n第五课\s*/g, '\n');
          result = result.replace(/\n第[一二三四五六七八九十\d]+节课[:：]?\s*/g, '\n');
        }
        result = result.replace(/\n{3,}/g, '\n\n');
        return result.trim();
      });

      const mergeInstruction = niche === NicheType.TCM_METAPHYSICS
        ? `【中医玄学赛道·合并规则（倪海厦风格）】
|
|【强制合并规则·违反则输出无效】
|⚠️ 最重要：输出必须是一篇完整文章，不是5篇短文的拼接！
|1. 全篇只允许出现一次"各位老友们好，欢迎来到我的频道，我是你们的老朋友倪海厦。"（必须只在最开头出现一次）
|2. 全篇只允许出现一次"好了，我们开始上课。"（必须在引子与正文之间出现一次）
|3. 禁止出现"第一课"、"第二课"、"第X节课"等章节标记——改为自然段落过渡
|4. 禁止出现5段式结构，禁止输出5个独立短篇——必须是单一连贯长文
|5. 禁止重复：同一个案例故事只讲一次，同一个观点只表达一次
|6. 只输出正文，不要任何章节编号或解释`
        : '';

      const cleanedMerged = mergeFiveSegments(cleanedSegmentsForMerge);
      const cleanedTotalLen = cleanedSegmentsForMerge.reduce((s, seg) => s + (seg || '').replace(/\s+/g, '').length, 0);
      const needsStrengthen = mode !== ToolMode.EXPAND && cleanedTotalLen < sourceLen * 0.9;

      // 非扩写模式：检查5段总字数是否达标，若不达标则调用补强扩写
      if (mode !== ToolMode.EXPAND && !needsStrengthen) {
        polished = cleanedMerged;
        // 治愈心理学赛道：确保结尾有CTA引导
        if (niche === NicheType.MINDFUL_PSYCHOLOGY) {
          const hasCTA = /subscribe|订阅|follow|评论|comment/i.test(polished);
          if (!hasCTA) {
            polished = polished.trim() + '\n\nFeel free to share your thoughts in the comments—I read every one!\n\nDon\'t forget to subscribe for more insights on mindful dog parenting.';
          }
        }
        setMergedOutput(polished);
        appendTerminal('衔接清洗完成，直接拼接（字数达标，跳过补强）。');
      } else {
        // 补强扩写 OR EXPAND 模式：调用 AI 合并，目标是让总字数 >= 原文
        // 补强扩写\u6a21式\uff1a\u8c03\u7528AI\u5408并\uff0c\u76ee\u6807\u662f\u8ba9\u603b\u5b57\u6570 >= \u539f\u6587\uff08\u591a\u6b21\u91cd\u8bd5\uff09
        const strengthenMinLen = Math.max(cleanedTotalLen, Math.round(sourceLen * 0.95));
        const strengthenMaxLen = Math.round(sourceLen * 1.10);
        // \u91cd\u8bd5\u903b\u8f91\uff1a\u6bcf\u6b21\u8c03\u7528AI\u5c1d\u8bd5\u8fbe\u5230\u76ee\u6807\u533a\u95f4\uff0c\u5982\u672a\u8fbe\u6807\u5219\u5728\u6b64\u57fa\u7840\u4e0a\u7ee7\u7eed\u6269\u5c55\uff0c\u6700\u591a3\u6b21
        let strengthenPolished = '';
        let bestStrengthenResult = '';
        let bestStrengthenLen = 0;
        let strengthenRound = 0;
        const maxStrengthenRounds = 3;
        // \u6bcf\u6b21\u8c03\u7528\u7684\u76ee\u6807\u533a\u95f4\uff1a\u4ece\u5f53\u524d\u5df2\u6709\u5185\u5bb9\u7684\u957f\u5ea6\u5f00\u59cb\uff0c\u9010\u6b21\u63d0\u9ad8
        while (strengthenRound < maxStrengthenRounds) {
          strengthenRound++;
          const roundMin = Math.max(strengthenPolished.replace(/\s+/g, '').length, Math.round(sourceLen * 0.95));
          const roundMax = strengthenMaxLen;
          const mergeHardCap = Math.ceil(roundMax * 2.5);
          appendTerminal(`\u884c\u63a5\u6e05\u6d17 \u2192 \u8865\u5f3a\u6269\u5199\u5408\u5e76\uff08\u7b2c ${strengthenRound}/${maxStrengthenRounds} \u6b21\uff09\uff1a\u76ee\u6807 ${roundMin}~${roundMax} \u5b57\uff0c\u5f53\u524d ${strengthenPolished.replace(/\s+/g, '').length} \u5b57...`);
          const strengthenPrompt = strengthenRound === 1
            ? `\u8bf7\u57fa\u4e8e\u4ee5\u4e0b\u5df2\u6e05\u6d17\u76845\u6bb5\u5185\u5bb9\uff0c\u8fdb\u884c\u8865\u5f3a\u6269\u5199\u5408\u5e76\uff0c\u6700\u7ec8\u603b\u5b57\u6570\u5fc5\u987b >= ${roundMin} \u5b57\uff08\u539f\u6587\u7ea6 ${sourceLen} \u5b57\uff09\u3002

\u3010\u5df2\u6709\u5185\u5bb9\u3011
${strengthenPolished || cleanedSegmentsForMerge.map((seg, i) => `\u3010\u7b2c${i + 1}\u6bb5\u3011
${seg}
---`).join('\n')}

\u8981\u6c42\uff1a
1) \u4fdd\u7559\u6bcf\u6bb5\u6838\u5fc3\u4fe1\u606f\uff0c\u4e0d\u4e22\u89c2\u70b9\uff0c\u5fc5\u987b\u5b8c\u6574\u5305\u542b\u51685\u6bb5\u5185\u5bb9
2) \u5728\u6bb5\u95f4\u8865\u4e0a\u627f\u4e0a\u542f\u4e0b\u8fc7\u6e21\u53e5\uff0c\u8ba9\u5168\u6587\u8fde\u8d2f\u81ea\u7136
3) \u7ed9\u6bcf\u6bb5\u589e\u52a0\u66f4\u591a\u7ec6\u8282\u3001\u6848\u4f8b\u3001\u8bdd\u9898\u548c\u8fc7\u6e21\uff0c\u8ba9\u5185\u5bb9\u66f4\u5145\u5b9e
4) \u8f93\u51fa\u8bed\u8a00\uff1a${targetLang}
5) \u6700\u7ec8\u603b\u5b57\u6570\uff08\u53bb\u7a7a\u767d\uff09\u5fc5\u987b\u5728 ${roundMin}~${roundMax} \u5b57\u4e4b\u95f4\u2014\u2014\u4e0d\u5f97\u4f4e\u4e8e ${roundMin} \u5b57\uff01
6) \u5fc5\u987b\u5b8c\u6574\u8f93\u51fa\u51685\u6bb5\u5185\u5bb9\uff0c\u4e0d\u5f97\u9057\u6f0c\u4efb\u4f55\u4e00\u6bb5
7) \u53ea\u8f93\u51fa\u6b63\u6587\uff0c\u4e0d\u8981\u89e3\u91ca`
            : `\u8bf7\u5728\u300c\u5f53\u524d\u6210\u7a3f\u300d\u5e95\u7840\u4e0a\u7ee7\u7eed\u6269\u5199\uff0c\u6bcf\u6bb5\u81f3\u5c11\u518d\u586b\u51452-3\u4e2a\u7ef4\u5ea6\u7684\u5185\u5bb9\uff0c\u76ee\u6807\u603b\u5b57\u6570 >= ${roundMin} \u5b57\u3002

\u3010\u5f53\u524d\u6210\u7a3f\u3011
${strengthenPolished}

\u8981\u6c42\uff1a
1) \u4fdd\u6301\u7b56\u7565\u4e0d\u53d8\uff0c\u5728\u6b64\u57fa\u7840\u4e0a\u6bcf\u6bb5\u5185\u5bb9\u7ee7\u7eed\u6269\u5145
2) \u589e\u52a0\u66f4\u591a\u7ec6\u8282\u3001\u6848\u4f8b\u3001\u6570\u636e\u3001\u8bdd\u9898\u548c\u8fc7\u6e21\uff0c\u8ba9\u5185\u5bb9\u66f4\u5145\u5b9e
3) \u8f93\u51fa\u5b57\u6570\uff08\u53bb\u7a7a\u767d\uff09\u5fc5\u987b >= ${roundMin} \u5b57\uff0c\u4e0d\u5f97\u4f4e\u4e8e ${roundMin} \u5b57
4) \u53ea\u8f93\u51fa\u6b63\u6587\uff0c\u4e0d\u8981\u89e3\u91ca`;
          let roundResult = '';
          await streamContentGeneration(
            strengthenPrompt,
            '\u4f60\u662f\u4e13\u4e1a\u603b\u7f16\uff0c\u8bf7\u5728\u5df2\u6709\u5185\u5bb9\u4e0a\u505a\u8865\u5f3a\u6269\u5199\u5408\u5e76\uff0c\u786e\u4fdd\u603b\u5b57\u6570\u8fbe\u6807\u3002',
            (chunk) => {
              roundResult += chunk;
            },
            ...deepRewriteStreamModelArgs(calcMaxTokens(mergeHardCap))
          );
          const roundLen = (roundResult || '').replace(/\s+/g, '').length;
          appendTerminal(`  \u7b2c ${strengthenRound} \u6b21\u8fd4\u56de ${roundLen} \u5b57\uff0c\u76ee\u6807 ${roundMin} \u5b57...`);
          if (roundLen > bestStrengthenLen) {
            bestStrengthenResult = roundResult || '';
            bestStrengthenLen = roundLen;
          }
          // \u5982\u679c\u8fd4\u56de\u7684\u5b57\u6570\u5df2\u8fbe\u5230\u76ee\u6807\u533a\u95f4\uff0c\u63a5\u53d7\u7ed3\u679c
          if (roundLen >= roundMin) {
            strengthenPolished = roundResult.trim();
            appendTerminal(`  \u7b2c ${strengthenRound} \u6b21\u8fbe\u6807\uff01${roundLen} \u5b57 >= ${roundMin} \u5b57\uff0c\u5b8c\u6210\u8865\u5f3a\u3002`);
            break;
          } else if (strengthenRound >= maxStrengthenRounds) {
            // \u6700\u591a\u91cd\u8bd5\u540e\u4ecd\u672a\u8fbe\u6807\uff0c\u4f7f\u7528\u6700\u957f\u7684\u7ed3\u679c
            strengthenPolished = bestStrengthenResult.trim();
            appendTerminal(`\u26a0\ufe0f \u8865\u5f3a\u6269\u5199${maxStrengthenRounds}\u6b21\u540e\u672a\u8fbe\u5230\u76ee\u6807\u533a\u95f4\uff08${bestStrengthenLen} \u5b57 < ${roundMin}\uff09\uff0c\u4f7f\u7528\u6700\u957f\u7ed3\u679c ${bestStrengthenLen} \u5b57\u3002`);
          } else {
            // \u672a\u8fbe\u6807\uff0c\u5c06\u5f53\u524d\u7ed3\u679c\u5408\u5e76\u5185\u5bb9\u540e\u7ee7\u7eed\u91cd\u8bd5
            if (roundResult && roundResult.trim().length > 0) {
              strengthenPolished = (strengthenPolished + '\n\n' + roundResult).trim();
            }
          }
        }
        const strengthenLen = strengthenPolished.replace(/\s+/g, '').length;
        if (strengthenLen >= strengthenMinLen) {
          polished = strengthenPolished.trim();
          appendTerminal(`衔接清洗完成，补强扩写合并完成（${strengthenLen} 字 >= ${strengthenMinLen} 字）。`);
        } else {
          polished = cleanedMerged;
          appendTerminal(`⚠️ 补强扩写未达标（${strengthenLen} < ${strengthenMinLen}），保留拼接结果（${cleanedTotalLen} 字）。`);
        }
      }

if (polished.trim()) {
        let finalText = polished.trim();
        const sourceLen = (inputText || '').replace(/\s+/g, '').length;
        const expandRange = expandRangeMap[rewriteLengthMode] || expandRangeMap.balanced;
        const minFinalLenExpand = Math.round(sourceLen * expandRange.min);
        const maxFinalLenExpand = Math.round(sourceLen * expandRange.max);

        const mergedLen = finalText.replace(/\s+/g, '').length;
        // 计算5段清洗后的总字数（作为基准）
        const cleanedSegmentsTotalLen = cleanedSegmentsForMerge.reduce((sum, seg) => sum + (seg || '').replace(/\s+/g, '').length, 0);

        // 如果合并结果远短于5段清洗后的总字数，说明合并API出了问题，回退使用清洗后的分段合并
        if (cleanedSegmentsTotalLen > 0 && mergedLen < cleanedSegmentsTotalLen * 0.5) {
          appendTerminal(`⚠️ 合并API返回内容过短（${mergedLen} 字），回退使用5段清洗后的合并结果（${cleanedSegmentsTotalLen} 字）。`);
          finalText = cleanedMerged;
        }

        if (mode === ToolMode.EXPAND && mergedLen < minFinalLenExpand) {
          let strengthenRound = 0;
          const maxStrengthen = 4;
          while (strengthenRound < maxStrengthen) {
            strengthenRound += 1;
            const curLenBefore = finalText.replace(/\s+/g, '').length;
            appendTerminal(
              `合并结果长度不足（${curLenBefore} < ${minFinalLenExpand}，去空白计字），第 ${strengthenRound}/${maxStrengthen} 次基于当前成稿补强扩写...`
            );
            let pass2 = '';
            const strengthenPrompt = `请在「当前成稿」末尾**增量续写扩写**，禁止推翻重写、禁止只重复堆砌同义句。

【计字规则】全文去空白字符数必须达到 ${minFinalLenExpand}~${maxFinalLenExpand} 字（原文字数约 ${sourceLen}，扩写强度约 ${expandRange.min}~${expandRange.max} 倍）。
【模式】在「当前成稿」基础上增量展开，每段至少补充2-3个维度的内容（场景描写/情绪细节/案例数据/对比论证/金句升华/过渡衔接）。
【原则】保持原中心思想不变；只输出正文，不要任何解释。

【当前成稿】
${finalText}`;
            await streamContentGeneration(
              strengthenPrompt,
              '你是增量扩写编辑，只在成稿末尾追加新内容，直至全文达标。',
              (chunk) => {
                const accLen = (pass2 || '').replace(/\s+/g, '').length;
                const remaining = maxFinalLenExpand - accLen;
                if (remaining <= 0) return;
                const chunkLen = (chunk || '').replace(/\s+/g, '').length;
                pass2 += chunkLen <= remaining ? chunk : chunk.slice(0, Math.max(0, remaining));
                if (pass2.trim()) setMergedOutput(pass2);
              },
              ...deepRewriteStreamModelArgs(calcMaxTokens(maxFinalLenExpand))
            );
            if (pass2.trim()) finalText = pass2.trim();
            const newLen = finalText.replace(/\s+/g, '').length;
            if (newLen >= minFinalLenExpand) break;
          }
        }

        if (mode !== ToolMode.EXPAND) {
          const srcLen = (inputText || '').replace(/\s+/g, '').length;
          const rr = rewriteRangeMap[rewriteLengthMode] || rewriteRangeMap.balanced;
          const maxRewriteLen = Math.round(srcLen * rr.finalMax);
          const minRewriteLen = Math.round(srcLen * rr.finalMin);
          const nowLen = finalText.replace(/\s+/g, '').length;

          if (srcLen > 0 && nowLen > maxRewriteLen) {
            appendTerminal(`⚠️ 最终合并字数偏长（当前 ${nowLen}，建议上限 ${maxRewriteLen}）。按“基于5段结果”原则，不再二次重写，已保留当前合并稿。`);
          }
          if (srcLen > 0 && nowLen < minRewriteLen) {
            appendTerminal(`⚠️ 最终合并字数偏短（当前 ${nowLen}，建议下限 ${minRewriteLen}）。按“基于5段结果”原则，不再二次补写，已保留当前合并稿。`);
          }
        }

        const sourceLenForGate = (inputText || '').replace(/\s+/g, '').length;
        const policyRange = rewriteRangeMap[rewriteLengthMode] || rewriteRangeMap.balanced;
        const hardMaxForRewrite = Math.round(sourceLenForGate * policyRange.finalMax);

        let gateNote = '';
        let needsSoftRecheck = false;

        if (mode !== ToolMode.EXPAND && sourceLenForGate > 0) {
          const beforeLen = finalText.replace(/\s+/g, '').length;
          const completenessScore = getCompletenessScore(finalText);
          const completeEnough = completenessScore >= 4;

          if (beforeLen > hardMaxForRewrite && completeEnough) {
            gateNote = `⚠️ 超出策略上限（当前 ${beforeLen}，上限 ${hardMaxForRewrite}）。为保证完整性，未强制截断，请考虑再温和压缩。`;
            needsSoftRecheck = true;
          } else if (beforeLen > hardMaxForRewrite && !completeEnough) {
            gateNote = `⚠️ 超出策略上限（当前 ${beforeLen}，上限 ${hardMaxForRewrite}），且内容可能未完整。已保留原文案，建议人工检查。`;
            needsSoftRecheck = true;
          }
        }

        // 中医玄学赛道：最终输出前再次清洗"好了，我们开始上课"（只保留第1段的）
        if (niche === NicheType.TCM_METAPHYSICS) {
          // 先找到第一段之后的所有"好了，我们开始上课"，全部删除
          const firstOccurrence = finalText.indexOf('好了，我们开始上课。');
          if (firstOccurrence !== -1) {
            // 保留第一段的开场白，删除后面的
            const beforeFirst = finalText.substring(0, firstOccurrence + '好了，我们开始上课。'.length);
            const afterFirst = finalText.substring(firstOccurrence + '好了，我们开始上课。'.length);
            const cleanedAfter = afterFirst
              .replace(/\n好了，我们开始上课。[。]\s*/g, '\n')
              .replace(/\s*好了，我们开始上课。[。]\s*/g, '\n')
              .replace(/\n好了，我們開始上課。[。]\s*/g, '\n')
              .replace(/好了，我們開始上課。[。]/g, '');
            finalText = beforeFirst + cleanedAfter;
          }
        }

        // 中医玄学赛道：强制添加第X课课程序号和固定开场白
        if (niche === NicheType.TCM_METAPHYSICS) {
          const sectionHeaders = ['第一课', '第二课', '第三课', '第四课', '第五课'];
          // 先找到每段的位置
          const paragraphs = finalText.split(/\n\n+/);
          const result: string[] = [];
          
          for (let i = 0; i < paragraphs.length; i++) {
            let para = paragraphs[i].trim();
            if (!para) continue;
            
            if (i === 0) {
              // 第1段：添加第一课标题 + 开场白
              result.push('第一课');
              result.push('各位老友们好，欢迎来到我的频道，我是你们的老朋友倪海厦。');
              result.push('好了，我们开始上课。');
              // 移除可能残留的开场白
              para = para.replace(/^各位老友们好，欢迎来到我的频道，我是[^\n]+。\n?/g, '');
              para = para.replace(/^好了，我们开始上课。\n?/g, '');
              result.push(para.trim());
            } else if (i >= 1 && i <= 4) {
              // 第2-5段：添加课程序号
              result.push(sectionHeaders[i]);
              // 移除可能残留的开场白
              para = para.replace(/^各位老友们好，欢迎来到我的频道，[^\n]+。\n?/g, '');
              para = para.replace(/^好了，我们开始上课。\n?/g, '');
              result.push(para.trim());
            } else {
              // 超过5段的内容归入第5段
              result.push(para.trim());
            }
          }
          finalText = result.join('\n\n');
        }

        setMergedOutput(finalText);
        appendTerminal('合并文案衔接优化完成。');

        // 检测文章主题：猫还是狗
        const catKeywords = /\b(cat|kitten|meow|purr|whisker|feline)\b/i;
        const dogKeywords = /\b(dog|puppy|paw|canine|woof|pet)\b/i;
        const articleAnimal = catKeywords.test(finalText) && !dogKeywords.test(finalText) ? 'cat' : 'dog';

        // 提取并保留文末自然结尾（根据主题动态选择 animal）
        const ctaPatterns = [
          // 英文自然收尾（随意/晚安式，无 animal 关键词）
          /((?:Anyway[,\s][^\n]{0,80}(?:Good night|Time to sleep|I should go)[^\n]{0,40}?)\s*)$/i,
          // 英文自然收尾（animal 相关）
          articleAnimal === 'cat'
            ? /((?:My cat[^\n]{0,80}(?:snoring|asleep|flopped|pillow|curled)[^\n]{0,40}?)\s*)$/i
            : /((?:My dog[^\n]{0,80}(?:snoring|asleep|flopped|pillow|curled)[^\n]{0,40}?)\s*)$/i,
          articleAnimal === 'cat'
            ? /((?:Okay[,\s][^\n]{0,80}(?:asleep|nap|rest|purring)[^\n]{0,40}?)\s*)$/i
            : /((?:Okay[,\s][^\n]{0,80}(?:asleep|nap|rest)[^\n]{0,40}?)\s*)$/i,
          /((?:Good night[^\n]{0,60})\s*)$/i,
          /((?:Time to (?:sleep|go)[^\n]{0,40})\s*)$/i,
          // 中文自然收尾
          /((?:希望[^\n。！？]{0,60}[。！？]?)\s*)$/i,
          /((?:[^\n。！？]*(?:你也不是一个人|至少我懂|一起慢慢来|不急|我也睡了|晚安)[^\n。！？]{0,60}[。！？]?)\s*)$/i,
          /((?:[^\n。！？]*(?:写到这儿|写到这|写到这了)[^\n。！？]{0,60}[。！？]?)\s*)$/i,
          /((?:[^\n。！？]*(?:就这样吧|好吧|行吧)[^\n。！？]{0,60}[。！？]?)\s*)$/i,
          // 英文旧订阅CTA（向后兼容）
          /((?:like and subscribe|subscribe to my channel|please like)[^\n。！？]{0,50}[。！？]?)\s*$/i,
          // 中文硬广CTA（向后兼容）
          /((?:请点赞|喜欢本文|如果觉得有收获)[^\n。！？]{0,50}[。！？]?)\s*$/i,
        ];
        let savedCta = '';
        for (const pattern of ctaPatterns) {
          const match = finalText.match(pattern);
          if (match) {
            savedCta = match[1].trim();
            break;
          }
        }

        // ===== 去AI味内容清洗 =====
        // 在合并完成后执行一轮"去AI味"清洗，让内容看起来更像人工写的
        appendTerminal('[去AI味] 开始深度去味改写（替换+添加）...');
        appendTerminal(`[去AI味] 输入文本长度: ${(finalText || '').replace(/\s+/g, '').length} 字` + (savedCta ? '（已保留末尾自然结尾）' : ''));
        appendTerminal('[去AI味] 正在调用 AI 模型进行深度去味改写...');

        let antiAiPolished = '';
        let antiAiSuccess = false;
        let antiAiPolishingResult: Awaited<ReturnType<typeof polishTextForAntiAi>> | null = null;

        try {
          // 自动检测输入语言，用于去AI味清洗
          const detectedLang = detectToolsInputLanguage(finalText);
          const outputLang = detectedLang.includes('English') ? 'en' : 'zh';
          
          antiAiPolishingResult = await polishTextForAntiAi(
            finalText,
            {
              apiKey,
              outputLanguage: outputLang,
              onLog: (msg) => {
                appendTerminal(`[去AI味] ${msg}`);
              },
              onChunk: (chunk) => {
                antiAiPolished = chunk;
                setMergedOutput(antiAiPolished);
                const chunkLen = (chunk || '').replace(/\s+/g, '').length;
                // 只在关键节点记录进度（每2000字）
                if (chunkLen > 0 && chunkLen % 2000 < 10) {
                  appendTerminal(`[去AI味] 清洗进度: ${chunkLen} 字`);
                }
              },
            },
            ...deepRewriteStreamModelArgs(calcMaxTokens(Math.max(mergedLen, 1000)))
          );
          antiAiSuccess = antiAiPolishingResult.success;

          const polishedLen = (antiAiPolished || '').replace(/\s+/g, '').length;
          appendTerminal(`[去AI味] AI 返回结果长度: ${polishedLen} 字`);

          if (antiAiPolished.trim() && polishedLen > 0) {
            // 只删除明显的英文订阅引导，不是互动引导
            let cleanedPolish = antiAiPolished.trim();
            cleanedPolish = cleanedPolish.replace(/\s*my channel\.?\s*$/i, '');
            cleanedPolish = cleanedPolish.replace(/\s*please like and subscribe to my channel\.?\s*$/i, '');
            cleanedPolish = cleanedPolish.replace(/\s*subscribe to my channel\.?\s*$/i, '');
            cleanedPolish = cleanedPolish.replace(/\s*like and subscribe to my channel.*$/i, '');

            // 检查去 AI 味后文末是否还有 CTA，如果没有则添加保留的 CTA
            let hasCtaInResult = false;
            for (const pattern of ctaPatterns) {
              if (pattern.test(cleanedPolish)) {
                hasCtaInResult = true;
                break;
              }
            }
            if (savedCta && !hasCtaInResult) {
              cleanedPolish = cleanedPolish.trim() + '\n\n' + savedCta;
              appendTerminal('[去AI味] 已补充保留的末尾 CTA');
            }

            if (!/[。！？.!?]$/.test(cleanedPolish.trim())) {
              cleanedPolish = cleanedPolish.trim() + '。';
            }

            const cleanedLen = (cleanedPolish || '').replace(/\s+/g, '').length;
            appendTerminal(`[去AI味] 清理残留后长度: ${cleanedLen} 字`);

            // 关键修外\uff1a如果去AI味后字数重降\uff08<合并结果的70%\uff09\uff0c保畏合并结果\uff0c跳过去AI味清洗
            if (cleanedLen < mergedLen * 0.7) {
              appendTerminal(`\u26a0\ufe0f 去AI味后字数重降\uff08${cleanedLen} < ${mergedLen}\uff09\uff0c保畏合并结果\uff0c跳过去AI味清洗。`);
            } else {
            finalText = cleanedPolish;
            }
            setMergedOutput(finalText);
            appendTerminal('[去AI味] ✅ 清洗完成');
            antiAiSuccess = true;
          } else {
            appendTerminal('[去AI味] ⚠️ 清洗返回为空，保留合并结果');
          }
        } catch (e: any) {
          appendTerminal(`[去AI味] ❌ 清洗失败: ${e?.message || e}`);
          appendTerminal('[去AI味] 保留合并结果，不影响内容输出');
        }

        // 验证清洗效果
        if (antiAiSuccess) {
          if (antiAiPolishingResult?.isEffective) {
            appendTerminal('[去AI味] ✅ 验证通过：AI 去味清洗已成功执行');
          } else {
            appendTerminal('[去AI味] ⚠️ 验证通过但口语词添加较少，建议再次清洗');
          }
        } else {
          appendTerminal('[去AI味] ⚠️ 警告：去AI味未完全执行，内容可能保留AI特征');
        }
        // ===== 去AI味清洗结束 =====

        // ===== 人类感检测 =====
        appendTerminal('[人类感检测] 开始检测内容人类感...');
        setIsRunningAiDetection(true);
        try {
          const detection = detectAiFeatures(finalText);
          setAiDetectionResult(detection);
          appendTerminal(`[人类感检测] 完成 - 人类感 ${detection.score}/10分 (${detection.level === 'weak' ? '优秀' : detection.level === 'medium' ? '一般' : '较弱'})`);
          if (detection.issues.length > 0) {
            detection.issues.slice(0, 3).forEach(issue => {
              appendTerminal(`[人类感检测] 问题: ${issue}`);
            });
          }
          if (detection.level === 'strong') {
            appendTerminal('[人类感检测] ⚠️ 人类感较弱（<5分），建议点击"重新去AI味"按钮再次清洗');
            toast.warning('人类感检测为"较弱"，建议继续清洗', 5000);
          } else {
            appendTerminal('[人类感检测] ✅ 人类感良好（≥5分），内容可发布');
          }
        } catch (e: any) {
          appendTerminal(`[人类感检测] 检测失败: ${e?.message || e}`);
        } finally {
          setIsRunningAiDetection(false);
        }
        // ===== 人类感检测结束 =====

        const finalLenForGate = finalText.replace(/\s+/g, '').length;
        const rewriteBelowSource =
          mode !== ToolMode.EXPAND &&
          sourceLenForGate > 0 &&
          finalLenForGate < Math.round(sourceLenForGate * policyRange.finalMin);

        if (gateNote) appendTerminal(gateNote);

        if (rewriteBelowSource) {
          appendTerminal(`⚠️ 洗稿字数未达下限：当前 ${finalLenForGate}，原文 ${sourceLenForGate}（策略下限约 ${Math.round(policyRange.finalMin * 100)}%）。已标记为未完成，请继续补强。`);
          toast.error(
            `字数低于策略下限（约 ${Math.round(policyRange.finalMin * 100)}% 相对原文），已标记未完成，请继续补强`
          );
        } else if (needsSoftRecheck) {
          toast.warning('字数超出策略上限，但为保证完整性已保留，请人工确认');
        } else {
          toast.success('已完成清洗优化并无缝合并');
        }
      } else {
        setMergedOutput(cleanedMerged || rawMerged);
        appendTerminal('合并优化返回为空，已回退为“清洗后分段合并结果”。');
      }
    } catch (e: any) {
      setMergedOutput(rawMerged);
      appendTerminal(`合并优化失败，已回退原样合并：${e?.message || e}`);
      toast.error('合并优化失败，已回退原样合并');
    } finally {
      setIsOptimizingMerge(false);
      setAutoPilotStage('done');
    }
  };

  // 重新执行去AI味清洗
  const handleReAntiAiPolish = async () => {
    if (!mergedOutput.trim()) {
      toast.warning('没有可清洗的内容');
      return;
    }
    if (!apiKey?.trim()) {
      toast.warning('请先配置 API Key');
      return;
    }

    appendTerminal('[去AI味] 手动重新执行去AI味清洗...');
    appendTerminal(`[去AI味] 输入文本长度: ${(mergedOutput || '').replace(/\s+/g, '').length} 字`);
    setIsOptimizingMerge(true);
    setAiDetectionResult(null);

    let antiAiPolished = '';
    let antiAiSuccess = false;
    let antiAiPolishingResult: Awaited<ReturnType<typeof polishTextForAntiAi>> | null = null;

    try {
      // 自动检测输入语言，用于去AI味清洗
      const detectedLang2 = detectToolsInputLanguage(mergedOutput);
      const outputLang2 = detectedLang2.includes('English') ? 'en' : 'zh';
      const reAntiAiMergedLen = (mergedOutput || '').replace(/\s+/g, '').length;

      antiAiPolishingResult = await polishTextForAntiAi(
        mergedOutput,
        {
          apiKey,
          outputLanguage: outputLang2,
          onLog: (msg) => appendTerminal(`[去AI味] ${msg}`),
          onChunk: (chunk) => {
            antiAiPolished = chunk;
            setMergedOutput(antiAiPolished);
          },
        },
        undefined,
        { maxTokens: calcMaxTokens(Math.max(reAntiAiMergedLen, 1000)) }
      );
      antiAiSuccess = antiAiPolishingResult.success;

      const polishedLen = (antiAiPolished || '').replace(/\s+/g, '').length;
      appendTerminal(`[去AI味] AI 返回结果长度: ${polishedLen} 字`);

      if (antiAiPolished.trim() && polishedLen > 0) {
        let cleanedPolish = antiAiPolished.trim();
        cleanedPolish = cleanedPolish.replace(/\s*my channel\.?\s*$/i, '');
        cleanedPolish = cleanedPolish.replace(/\s*please like and subscribe to my channel\.?\s*$/i, '');
        cleanedPolish = cleanedPolish.replace(/\s*subscribe to my channel\.?\s*$/i, '');
        cleanedPolish = cleanedPolish.replace(/\s*请点赞并订阅我的频道。?\s*$/, '');
        cleanedPolish = cleanedPolish.replace(/\s*like and subscribe.*$/i, '');

        if (!/[。！？.!?]$/.test(cleanedPolish.trim())) {
          cleanedPolish = cleanedPolish.trim() + '。';
        }

        const cleanedLen = (cleanedPolish || '').replace(/\s+/g, '').length;
        appendTerminal(`[去AI味] 清理残留后长度: ${cleanedLen} 字`);

        setMergedOutput(cleanedPolish);
        appendTerminal('[去AI味] ✅ 重新清洗完成');

        // 验证清洗效果
        if (antiAiPolishingResult?.isEffective) {
          appendTerminal('[去AI味] ✅ 验证通过：AI 去味清洗已成功执行');
        } else {
          appendTerminal('[去AI味] ⚠️ 验证通过但口语词添加较少，建议再次清洗');
        }

        // 重新检测
        const detection = detectAiFeatures(cleanedPolish);
        setAiDetectionResult(detection);
        appendTerminal(`[人类感检测] 重新检测完成 - 人类感 ${detection.score}/10分 (${detection.level === 'weak' ? '优秀' : detection.level === 'medium' ? '一般' : '较弱'})`);

        if (detection.level === 'strong') {
          toast.warning('人类感仍为"较弱"，可继续清洗', 5000);
        } else {
          toast.success(`人类感检测为"${detection.level === 'weak' ? '优秀' : '一般'}"，清洗效果良好`, 5000);
        }
      } else {
        appendTerminal('[去AI味] 清洗返回为空');
        toast.warning('清洗返回为空，保留原内容');
      }
    } catch (e: any) {
      appendTerminal(`[去AI味] 重新清洗失败: ${e?.message || e}`);
      toast.error('重新清洗失败');
    } finally {
      setIsOptimizingMerge(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(outputText);
  };

  const exportTextAsTxt = (content: string, fileName: string) => {
    if (!content || !content.trim()) {
      toast.warning('没有可导出的内容');
      return;
    }

    try {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      a.download = `${fileName}_${timestamp}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const targetToast = externalToast || internalToast;
      targetToast?.success?.('内容已成功导出为 TXT 文件', 5000);
    } catch (error: any) {
      console.error('导出失败:', error);
      const targetToast = externalToast || internalToast;
      targetToast?.error?.(`导出失败: ${error.message || '未知错误'}`, 6000);
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // 频道生成器功能
  // ═══════════════════════════════════════════════════════════════════
  
  const generateChannelAssets = async () => {
    if (!apiKey?.trim()) {
      toast.error('请先配置 API Key');
      return;
    }
    if (!channelTopic.trim()) {
      toast.warning('请输入频道主题');
      return;
    }

    setIsGeneratingChannel(true);
    setChannelOutput(null);
    appendTerminal('开始生成频道资产...');

    try {
      initializeGemini(apiKey, { provider });

      const input = [
        `【频道主题】${channelTopic}`,
        `【目标观众】${channelTargetAudience || '未指定'}`,
        `【内容类型】${channelContentType || '未指定'}`,
        `【品牌定位】${channelBrandPositioning || '未指定'}`,
      ].join('\n');

      // 根据语言选择构建频道名称要求
      const nameLangReq = channelNameLang === 'zh'
        ? '频道名称必须是中文、清晰、专业、10个中文字符以内'
        : channelNameLang === 'en'
        ? '频道名称必须是英文、专业、30个英文字符以内'
        : '方案1-2中文频道名称（10字符以内），方案3英文频道名称（30字符以内）';

      const prompt = `你是 YouTube Channel Setup Co-Pilot。请根据以下信息生成完整的频道资产。

【输入信息】
${input}

【输出要求】
请严格按以下格式输出，包含所有字段：

## 频道名称（3个备选方案）
${channelNameLang === 'zh' ? '- 必须为中文、清晰、专业、10个中文字符以内' : channelNameLang === 'en' ? '- 必须为英文、专业、30个英文字符以内' : '- 方案1-2为中文（10字符以内），方案3为英文（30字符以内）'}
1. [名称1]
2. [名称2]
3. [名称3]

## 头像提示词（3个备选方案，英文，可直接用于AI生成头像）
1. [英文提示词1，描述要专业、清晰、可直接用于AI绘图]
2. [英文提示词2]
3. [英文提示词3]

## 横幅提示词（3个备选方案，英文，可直接用于AI生成横幅）
1. [英文提示词1，包含2560x1440px尺寸要求、品牌元素、安全区等]
2. [英文提示词2]
3. [英文提示词3]

## 频道说明文本（${channelNameLang === 'zh' ? '中文' : channelNameLang === 'en' ? '英文' : '中英双语（先中文后英文）'}，包含价值主张、发布频率、CTA和关键词，950字符内）
[完整的频道说明文本]

## 关键词字段（3个方案：中文/英文/混合，每方案5-10个关键词，用逗号分隔）
方案1（中文）：[关键词1]，[关键词2]，[关键词3]...
方案2（英文）：keyword1, keyword2, keyword3...
方案3（混合）：[关键词1]，keyword2，[关键词3]...

【重要】
- ${nameLangReq}
- 头像和横幅提示词必须是英文、可直接用于AI生图
- 频道说明要包含CTA（呼吁订阅）
- 只输出上述格式内容，不要有任何解释`;

      let result = '';
      await streamContentGeneration(
        prompt,
        '你是专业YouTube频道品牌策划专家。',
        (chunk) => {
          result += chunk;
        },
        'gpt-5.4-mini',
        { temperature: 0.7 }
      );

      // 解析结果
      const output = parseChannelOutput(result);
      if (output) {
        setChannelOutput(output);
        appendTerminal('频道资产生成完成');
        toast.success('频道资产生成完成！');
      } else {
        throw new Error('解析生成结果失败');
      }
    } catch (e: any) {
      appendTerminal(`生成失败：${e?.message || e}`);
      toast.error('生成失败：' + (e?.message || e));
    } finally {
      setIsGeneratingChannel(false);
    }
  };

  // 解析频道生成结果
  const parseChannelOutput = (text: string): {
    names: string[];
    avatarPrompts: string[];
    bannerPrompts: string[];
    description: string;
    keywords: string[];
  } | null => {
    try {
      const lines = text.split('\n');
      let section = '';
      const names: string[] = [];
      const avatarPrompts: string[] = [];
      const bannerPrompts: string[] = [];
      let description = '';
      const keywords: string[] = [];
      let currentList: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        
        if (trimmed.includes('频道名称') || trimmed.match(/^#+\s*频道名称/)) {
          section = 'names';
          currentList = names;
        } else if (trimmed.includes('头像提示词') || trimmed.match(/^#+\s*头像/)) {
          section = 'avatar';
          currentList = avatarPrompts;
        } else if (trimmed.includes('横幅提示词') || trimmed.match(/^#+\s*横幅/)) {
          section = 'banner';
          currentList = bannerPrompts;
        } else if (trimmed.includes('频道说明') || trimmed.match(/^#+\s*频道说明/)) {
          section = 'description';
        } else if (trimmed.includes('关键词') || trimmed.match(/^#+\s*关键词/)) {
          section = 'keywords';
        } else if (section === 'names' || section === 'avatar' || section === 'banner') {
          // 匹配列表项：1. xxx 或 - xxx 或 方案1：
          const match = trimmed.match(/^\d+[\.、:：]\s*(.+)/) || trimmed.match(/^[a-z][\.、:：]\s*(.+)/i);
          if (match) {
            currentList.push(match[1].trim());
          }
        } else if (section === 'description' && trimmed.length > 20) {
          description += (description ? '\n' : '') + trimmed;
        } else if (section === 'keywords') {
          const kwMatch = trimmed.match(/方案\d+[（(]?[^{}（）()]+[）)]?[:：]\s*(.+)/);
          if (kwMatch) {
            keywords.push(kwMatch[1].trim());
          }
        }
      }

      // 确保有3个方案
      while (names.length < 3) names.push(`Channel ${names.length + 1}`);
      while (avatarPrompts.length < 3) avatarPrompts.push('Professional channel avatar');
      while (bannerPrompts.length < 3) bannerPrompts.push('YouTube banner 2560x1440px');
      while (keywords.length < 3) keywords.push(keywords[0] || '');

      return {
        names: names.slice(0, 3),
        avatarPrompts: avatarPrompts.slice(0, 3),
        bannerPrompts: bannerPrompts.slice(0, 3),
        description: description.slice(0, 1000),
        keywords: keywords.slice(0, 3),
      };
    } catch (e) {
      console.error('解析频道输出失败:', e);
      return null;
    }
  };

  // 生成头像图片
  const generateAvatarImage = async (index: number) => {
    if (!channelOutput?.avatarPrompts?.[index]) return;
    
    setIsGeneratingAvatar(true);
    const prompt = channelOutput.avatarPrompts[index];
    
    try {
      const { generateImage } = await import('../services/yunwuService');
      const result = await generateImage(apiKey, {
        model: 'flux',
        prompt,
        size: '1024x1024',
        quality: 'standard',
        n: 1,
      });

      if (result.success && result.url) {
        const newImages = [...generatedAvatarImages];
        newImages[index] = result.url;
        setGeneratedAvatarImages(newImages);
        toast.success('头像生成成功！');
      } else {
        toast.error('头像生成失败：' + (result.error || '未知错误'));
      }
    } catch (e: any) {
      toast.error('生成失败：' + (e?.message || e));
    } finally {
      setIsGeneratingAvatar(false);
    }
  };

  // 生成横幅图片
  const generateBannerImage = async (index: number) => {
    if (!channelOutput?.bannerPrompts?.[index]) return;
    
    setIsGeneratingBanner(true);
    const prompt = channelOutput.bannerPrompts[index];
    
    try {
      const { generateImage } = await import('../services/yunwuService');
      const result = await generateImage(apiKey, {
        model: 'flux',
        prompt,
        size: '1280x720',
        quality: 'standard',
        n: 1,
      });

      if (result.success && result.url) {
        const newImages = [...generatedBannerImages];
        newImages[index] = result.url;
        setGeneratedBannerImages(newImages);
        toast.success('横幅生成成功！');
      } else {
        toast.error('横幅生成失败：' + (result.error || '未知错误'));
      }
    } catch (e: any) {
      toast.error('生成失败：' + (e?.message || e));
    } finally {
      setIsGeneratingBanner(false);
    }
  };

  // 导出常规输出为 txt
  const exportToTxt = () => {
    let fileName = '脚本';
    if (mode === ToolMode.SCRIPT) {
      fileName = '视频脚本';
    } else if (mode === ToolMode.REWRITE) {
      fileName = '深度洗稿内容';
    } else if (mode === ToolMode.EXPAND) {
      fileName = '扩写内容';
    } else if (mode === ToolMode.SUMMARIZE) {
      fileName = '摘要总结';
    } else if (mode === ToolMode.POLISH) {
      fileName = '润色内容';
    }
    exportTextAsTxt(outputText, fileName);
  };

  const exportMergedToTxt = () => {
    exportTextAsTxt(mergedOutput || outputText, '最终合并文案');
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
       {/* Settings Bar */}
       <div className="bg-slate-800/50 p-2.5 sm:p-3 rounded-xl border border-slate-800">
         {/* 从左到右顺排，不用 ml-auto，避免中间大块留白 */}
         <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center lg:flex-nowrap gap-3 sm:gap-3.5">
           <div className="flex flex-wrap items-center gap-2 sm:gap-2 min-w-0 shrink-0">
             {/* Tool Modes：短标签，悬停可看全称 */}
            {[
              { id: ToolMode.REWRITE, short: '洗稿', full: '深度洗稿', icon: <RefreshCw size={14} strokeWidth={2.25} /> },
              { id: ToolMode.EXPAND, short: '扩写', full: '深度扩写', icon: <Maximize2 size={14} strokeWidth={2.25} /> },
              { id: ToolMode.SUMMARIZE, short: '摘要', full: '摘要总结', icon: <Scissors size={14} strokeWidth={2.25} /> },
              { id: ToolMode.POLISH, short: '润色', full: '润色优化', icon: <FileText size={14} strokeWidth={2.25} /> },
              { id: ToolMode.SCRIPT, short: '脚本', full: '脚本输出', icon: <Video size={14} strokeWidth={2.25} /> },
            ].map((tool) => {
              const hasHistory = getHistory('tools', getToolsHistoryKey(tool.id as ToolMode, niche)).length > 0;
              return (
                <button
                  key={tool.id}
                  type="button"
                  title={tool.full}
                  onClick={() => handleModeChange(tool.id as ToolMode)}
                  className={`px-2.5 py-1.5 rounded-md border flex items-center gap-1.5 transition-all text-xs sm:text-[13px] font-semibold whitespace-nowrap ${
                    mode === tool.id
                      ? 'bg-emerald-600 text-white border-emerald-500 shadow-sm'
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {tool.icon}
                  <span>{tool.short}</span>
                  {hasHistory && (
                    <span
                      onClick={(e) => handleManualModeHistoryClick(e as unknown as React.MouseEvent, tool.id as ToolMode)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleManualModeHistoryClick(e as unknown as React.MouseEvent, tool.id as ToolMode);
                        }
                      }}
                      className="p-0.5 rounded hover:bg-slate-600/50 transition-colors inline-flex cursor-pointer -mr-0.5"
                      title="历史记录"
                      role="button"
                      tabIndex={0}
                    >
                      <History size={12} className="text-emerald-300 hover:text-emerald-200" />
                    </span>
                  )}
                </button>
              );
            })}
           </div>

           {/* 与左侧模式按钮区分隔 */}
           <div
             className="hidden sm:block w-px shrink-0 self-stretch min-h-[1.75rem] bg-slate-600/50 mx-0.5 sm:mx-1"
             aria-hidden
           />

           <div className="flex flex-wrap items-center gap-3 sm:gap-3 min-w-0 shrink-0">
             {/* Niche Context Selector */}
            {mode !== ToolMode.SCRIPT && (
              <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 min-w-0 max-w-full">
                <div className="relative group w-[10rem] sm:w-[11rem] max-w-[min(100%,12rem)] shrink-0">
                  <select
                    value={niche}
                    onChange={(e) => handleNicheChange(e.target.value as NicheType)}
                    className="w-full max-w-full appearance-none bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm text-slate-200 font-medium focus:outline-none focus:border-emerald-500 cursor-pointer pr-7"
                    title={`${NICHES[niche]?.icon ?? ''} ${NICHES[niche]?.name ?? ''}`.trim()}
                  >
                    {Object.values(NICHES).map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.icon} {compactNicheToolbarLabel(n.name)}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none shrink-0" size={14} />
                </div>
                {(() => {
                  const hasNicheHistory = getHistory('tools', getToolsHistoryKey(mode, niche)).length > 0;
                  return hasNicheHistory ? (
                    <button
                      type="button"
                      onClick={(e) => handleManualNicheHistoryClick(e, niche)}
                      className="p-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 transition-colors shrink-0"
                      title="赛道历史"
                    >
                      <History size={14} className="text-emerald-300" />
                    </button>
                  ) : null;
                })()}
                <label
                  className="flex items-center gap-1.5 text-xs text-slate-400 whitespace-nowrap shrink-0"
                  title="自动匹配赛道"
                >
                  <input
                    type="checkbox"
                    className="shrink-0 rounded border-slate-600"
                    checked={autoSwitchNicheEnabled}
                    onChange={(e) => setAutoSwitchNicheEnabled(e.target.checked)}
                  />
                  <span>自动匹配</span>
                </label>
              </div>
            )}

             {mode === ToolMode.SCRIPT && (
               <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 min-w-0">
                 <label className="text-xs sm:text-sm font-semibold text-emerald-300 whitespace-nowrap shrink-0">镜头</label>
                 <select
                   value={scriptShotMode}
                   onChange={(e) => updateActiveTask({ scriptShotMode: e.target.value as 'auto' | 'custom' })}
                   className="w-[96px] bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs sm:text-sm text-slate-200 font-medium focus:outline-none focus:border-emerald-500 cursor-pointer"
                 >
                   <option value="auto">自动</option>
                   <option value="custom">自定</option>
                 </select>
                 <input
                   type="number"
                   min={10}
                   max={100}
                   value={scriptShotCountRaw ?? ''}
                   placeholder="10-100"
                   disabled={scriptShotMode !== 'custom'}
                   onChange={(e) => {
                     const nextValue = e.target.value;
                     if (nextValue === '') {
                       updateActiveTask({ scriptShotCount: undefined });
                       return;
                     }
                     updateActiveTask({ scriptShotCount: Number(nextValue) });
                   }}
                   onBlur={(e) => {
                     const nextValue = e.target.value;
                     if (nextValue === '') {
                       updateActiveTask({ scriptShotCount: 10 });
                       return;
                     }
                     const clamped = Math.min(100, Math.max(10, Number(nextValue)));
                     updateActiveTask({ scriptShotCount: clamped });
                   }}
                   className="w-[84px] bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs sm:text-sm text-slate-200 font-medium focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                 />
               </div>
             )}

             {/* Generate Button */}
             <button
               type="button"
               onClick={handleAction}
               disabled={isGenerating || !inputText}
               className="flex items-center justify-center gap-2 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs sm:text-sm font-semibold rounded-lg shadow-md shadow-emerald-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:scale-[1.02] active:scale-[0.98] whitespace-nowrap shrink-0"
             >
               <ArrowRight size={16} strokeWidth={2.5} />
               <span>生成</span>
             </button>
           </div>
         </div>
       </div>

      {/* 任务标签页 */}
      <div className="flex items-center justify-between gap-3 pb-2">
        <div className="flex items-center gap-2 overflow-x-auto">
          {tasks.map((task, index) => (
            <div
              key={task.id}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all whitespace-nowrap ${
                task.id === activeTaskId
                  ? 'bg-emerald-600/20 border-emerald-500 text-emerald-400'
                  : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:bg-slate-700/50'
              }`}
            >
              <button
                onClick={() => switchTask(task.id)}
                className="flex items-center gap-2 text-sm font-medium"
              >
                <span>任务 {index + 1}</span>
                {task.isGenerating && (
                  <span className="inline-block w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                )}
              </button>
              {tasks.length > 1 && (
                <button
                  onClick={() => deleteTask(task.id)}
                  className="text-slate-500 hover:text-red-400 transition-colors"
                  title="删除任务"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
          <button
            onClick={createNewTask}
            className="flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-700 bg-slate-800/50 text-slate-400 hover:bg-slate-700/50 hover:text-emerald-400 transition-all"
            title="新建任务"
          >
            <Plus size={16} />
            <span className="text-sm font-medium">新建</span>
          </button>

          {isDeepRewriteMode && autoMatchedNiche && autoMatchedNiche.niche !== niche && (
            <div className="ml-2 flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-500/35 bg-amber-500/10 text-amber-200 whitespace-nowrap">
              <span className="text-xs">
                检测建议赛道：{NICHES[autoMatchedNiche.niche]?.name || autoMatchedNiche.niche}（置信度 {autoMatchedNiche.score}）
              </span>
              <button
                onClick={() => handleNicheChange(autoMatchedNiche.niche)}
                className="px-2 py-0.5 rounded bg-amber-500/25 hover:bg-amber-500/35 text-xs text-amber-100"
              >
                一键切换
              </button>
            </div>
          )}
        </div>

        {isDeepRewriteMode && (
          <div className="flex items-center gap-2 text-xs text-emerald-300 shrink-0 bg-emerald-500/10 border border-emerald-500/35 rounded-lg px-2 py-1">
            <span className="font-semibold tracking-wide">{mode === ToolMode.EXPAND ? '扩写强度策略' : '洗稿字数策略'}</span>
            <select
              value={rewriteLengthMode}
              onChange={(e) => setRewriteLengthMode(e.target.value as 'strict' | 'balanced' | 'expressive')}
              className="bg-slate-900 border border-emerald-500/50 rounded-lg px-2 py-1 text-emerald-100 font-semibold shadow-[0_0_0_1px_rgba(16,185,129,0.25)]"
            >
              {mode === ToolMode.EXPAND ? (
                <>
                  <option value="strict">稳健扩写（约1.3~1.6x）</option>
                  <option value="balanced">标准扩写（约1.5~1.9x）</option>
                  <option value="expressive">强力扩写（约1.8~2.3x）</option>
                </>
              ) : (
                <>
                  <option value="strict">严格贴近原文（±5%）</option>
                  <option value="balanced">适度优化（+8%以内）</option>
                  <option value="expressive">强化表达（+12%以内）</option>
                </>
              )}
            </select>
          </div>
        )}
      </div>

      {/* 生成进度条 */}
      {generationProgress && isGenerating && (
        <div className="mb-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700">
          <ProgressBar
            current={generationProgress.current}
            total={generationProgress.total}
            label={mode === ToolMode.SCRIPT ? '生成进度（镜头提示词）' : '生成进度'}
            showPercentage={true}
            showCount={true}
            color="emerald"
            successCount={shotPromptProgress?.success}
            failedCount={shotPromptProgress?.failed}
            statusHint={shotPromptProgress?.hint}
          />
        </div>
      )}

      {/* Grid: Input and Output */}
      {isDeepRewriteMode ? (
        <div className="space-y-4">
          {/* 顶部：终端日志 + 原文输入 + 评论区/痛点 */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 min-h-[280px]">
            <div className="xl:col-span-3 flex flex-col gap-2">
              <label className="text-sm font-medium text-slate-400">终端日志</label>
              <textarea
                value={terminalLog}
                onChange={(e) => setTerminalLog(e.target.value)}
                className="h-full min-h-[260px] bg-slate-900/70 border border-slate-700 rounded-xl p-3 text-[12px] text-emerald-300 resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500 custom-scrollbar"
              />
            </div>

            <div className="xl:col-span-6 flex flex-col gap-2">
              <label className="text-sm font-medium text-slate-400 flex justify-between items-center">
                <span>原始文案（自动拆分为5段，支持 YouTube 链接提取字幕）</span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-slate-600 font-mono">{inputText.length.toLocaleString()} 字</span>
                  {isYouTubeLink(inputText.trim()) && (
                    <button
                      onClick={handleExtractTranscript}
                      disabled={isExtractingTranscript}
                      className="flex items-center gap-1 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-md shadow disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                      <Download size={14} />
                      <span>{isExtractingTranscript ? '提取中...' : '提取字幕'}</span>
                    </button>
                  )}
                </span>
              </label>
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="请粘贴需要扩写/洗稿/润色的原文，或直接粘贴 YouTube 链接..."
                className="h-full min-h-[260px] bg-slate-800/60 border border-slate-700 rounded-xl p-4 text-slate-200 resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500 custom-scrollbar"
              />
              {/* 检测状态提示 */}
              {inputText.trim() && (
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="flex items-center gap-1.5 text-slate-500">
                    <span className="w-2 h-2 rounded-full bg-emerald-500/70" />
                    检测语言：{detectToolsInputLanguage(inputText)}
                  </span>
                  {autoMatchedNiche && autoMatchedNiche.niche !== niche && autoMatchedNiche.score >= 2 && (
                    <button
                      onClick={() => handleNicheChange(autoMatchedNiche.niche)}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 transition-colors"
                    >
                      <span className="w-2 h-2 rounded-full bg-amber-400" />
                      <span>切换赛道：{NICHES[autoMatchedNiche.niche]?.name || autoMatchedNiche.niche}</span>
                      <span className="text-amber-400/70 ml-1">→ 点击切换</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="xl:col-span-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-400">评论区 / 用户痛点植入</label>
                <button
                  onClick={() => void extractCommentsAndPainPoints()}
                  disabled={isExtractingComments || isAnalyzingPainPoints || !inputText.trim()}
                  className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:bg-amber-600/50 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5"
                >
                  {isExtractingComments || isAnalyzingPainPoints ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>{isExtractingComments ? '提取评论中...' : '分析痛点中...'}</span>
                    </>
                  ) : (
                    <>
                      <Brain className="w-3 h-3" />
                      <span>提取痛点</span>
                    </>
                  )}
                </button>
              </div>

              {/* 提取状态提示 */}
              {(isExtractingComments || isAnalyzingPainPoints) && (
                <div className="text-xs text-amber-400/70 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>{isExtractingComments ? `正在提取评论...` : `正在分析用户痛点...`}</span>
                </div>
              )}

              <textarea
                value={painPointText}
                onChange={(e) => setPainPointText(e.target.value)}
                placeholder="点击右侧「提取痛点」按钮自动从左侧链接提取用户痛点，或手动输入评论区热词、情绪关键词..."
                className="flex-1 bg-slate-800/60 border border-slate-700 rounded-xl p-3 text-sm text-slate-200 resize-none focus:outline-none focus:ring-1 focus:ring-amber-500/50 custom-scrollbar"
              />
            </div>
          </div>

          {/* 操作条（上移到大纲区上方，提升可点击性） */}
          <div className="flex flex-wrap items-center gap-2 bg-slate-900/50 border border-slate-800 rounded-xl p-3">
            <button
              onClick={handleInitializeFiveSegments}
              disabled={isExtractingOutline}
              className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm text-white disabled:opacity-50"
            >
              {isExtractingOutline ? '提炼并拆分中...' : '提炼大纲并拆分5段'}
            </button>
            <button
              onClick={handleAutoPilotGenerateFiveSegments}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm text-white"
            >
              全自动一键生成（Auto-Pilot）
            </button>
            <button
              onClick={handleMergeFinalWithPolish}
              disabled={isOptimizingMerge}
              className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm text-white disabled:opacity-60"
            >
              {isOptimizingMerge ? '优化合并中...' : '合并最终文案'}
            </button>
            <button
              onClick={handleClearDeepRewritePanel}
              className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-sm text-white"
            >
              清空面板
            </button>

            <div className="ml-auto flex items-center gap-2 text-xs text-slate-400">
              <span>输出语言</span>
              <select
                value={rewriteOutputLanguage}
                onChange={(e) => setRewriteOutputLanguage(e.target.value as any)}
                className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-slate-200"
              >
                <option value="source">原文输出（默认）</option>
                <option value="en">English</option>
                <option value="zh">中文</option>
                <option value="ja">日文</option>
                <option value="ko">韩文</option>
                <option value="es">西班牙语</option>
                <option value="de">德语</option>
                <option value="hi">印度语</option>
              </select>
            </div>
          </div>

          {/* 大纲提炼区 */}
          <div className="bg-slate-900/45 border border-slate-800 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-300">原文大纲（5段，可编辑）</label>
              <button
                onClick={() => initializeFiveSegmentsFromText(inputText, '已重新提炼大纲并重置5段。')}
                disabled={isExtractingOutline || !inputText.trim()}
                className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs text-white disabled:opacity-50"
              >
                {isExtractingOutline ? '提炼中...' : '重新提炼大纲'}
              </button>
            </div>
            <textarea
              value={outlineText}
              onChange={(e) => {
                const v = e.target.value;
                setOutlineText(v);
                setOutlineItems(parseOutlineToFiveItems(v));
              }}
              placeholder="这里会显示根据原文提炼的5段大纲，可手动编辑后再执行分段生成。"
              className="w-full min-h-[120px] bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm text-slate-200 resize-y focus:outline-none focus:ring-1 focus:ring-emerald-500 custom-scrollbar"
            />
          </div>

          {/* 字数与合规仪表盘 */}
          <div className="bg-slate-900/45 border border-slate-800 rounded-xl p-3 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-300">字数与合规仪表盘</span>
              <span className={`font-semibold ${mergedBelowFloor ? 'text-rose-300' : mergedAbovePolicy ? 'text-amber-300' : mergedWithinRange ? 'text-emerald-300' : 'text-slate-400'}`}>
                {mergedComplianceText}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <div className="rounded border border-slate-800 bg-slate-900/60 p-2">
                <div className="text-[11px] text-slate-400 mb-1">原文字数</div>
                <div className="text-sm font-semibold text-slate-100">{sourceLenForDashboard.toLocaleString()} 字</div>
              </div>
              <div className="rounded border border-slate-800 bg-slate-900/60 p-2">
                <div className="text-[11px] text-slate-400 mb-1">5段合计字数（预留）</div>
                <div className="text-sm font-semibold text-cyan-200">{segmentsTotalLenForDashboard.toLocaleString()} 字</div>
                {mode === ToolMode.EXPAND && sourceLenForDashboard > 0 && (
                  <div className="text-[10px] text-slate-500 mt-1">
                    分段目标（去空白计字）：相对本段原文约 {expandPolicyForDashboard.min}~{expandPolicyForDashboard.max}{' '}
                    倍（与当前扩写强度策略一致）
                  </div>
                )}
                {mode !== ToolMode.EXPAND && sourceLenForDashboard > 0 && (
                  <div className="text-[10px] text-slate-500 mt-1">
                    分段建议相对本段原文：约 {Math.round(rewritePolicyForDashboard.segmentMin * 100)}% ~{' '}
                    {Math.round(rewritePolicyForDashboard.segmentMax * 100)}%（与当前洗稿字数策略一致）
                  </div>
                )}
              </div>
              <div className="rounded border border-slate-800 bg-slate-900/60 p-2">
                <div className="text-[11px] text-slate-400 mb-1">最终合并字数</div>
                <div className={`text-sm font-semibold ${mergedBelowFloor ? 'text-rose-300' : mergedAbovePolicy ? 'text-amber-300' : 'text-emerald-200'}`}>
                  {mergedLenForDashboard.toLocaleString()} 字
                </div>
                {mode === ToolMode.EXPAND && sourceLenForDashboard > 0 && (
                  <div className="text-[10px] text-slate-500 mt-1">
                    全文目标区间：{expandMinForDashboard.toLocaleString()} ~ {expandMaxForDashboard.toLocaleString()} 字（约{' '}
                    {expandPolicyForDashboard.min}~{expandPolicyForDashboard.max} 倍）
                  </div>
                )}
                {mode !== ToolMode.EXPAND && sourceLenForDashboard > 0 && (
                  <div className="text-[10px] text-slate-500 mt-1">目标区间：{rewriteMinForDashboard.toLocaleString()} ~ {rewriteMaxForDashboard.toLocaleString()} 字</div>
                )}
              </div>
            </div>
            <div className={`text-[11px] ${mergedCompleteForDashboard ? 'text-emerald-300' : 'text-amber-300'}`}>
              完整性检测：{mergedOutput.trim() ? (mergedCompleteForDashboard ? '收尾完整' : '可能未完整（建议补尾）') : '待生成'}
            </div>

            {/* AI 味检测结果 */}
            <div className="rounded border border-slate-800 bg-slate-900/60 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] text-slate-400">人类感评分</span>
                {isRunningAiDetection && (
                  <span className="text-[10px] text-cyan-400 animate-pulse">检测中...</span>
                )}
              </div>
              {aiDetectionResult ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className={`text-lg font-bold px-2 py-0.5 rounded ${
                      aiDetectionResult.level === 'weak' ? 'bg-emerald-500/20 text-emerald-300' :
                      aiDetectionResult.level === 'medium' ? 'bg-amber-500/20 text-amber-300' :
                      'bg-rose-500/20 text-rose-300'
                    }`}>
                      {aiDetectionResult.level === 'weak' ? '优秀' : aiDetectionResult.level === 'medium' ? '一般' : '较弱'}
                    </span>
                    <span className="text-sm text-slate-300">
                      人类感 {aiDetectionResult.score}/10分
                    </span>
                  </div>
                  {/* 9维度详情 */}
                  <div className="grid grid-cols-3 gap-x-3 gap-y-1">
                    {/* D1 模板清洁 */}
                    <div>
                      <div className="text-[9px] text-slate-500 mb-0.5">模板清洁</div>
                      <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden">
                        <div
                          className={`h-full ${aiDetectionResult.dimensions.templateWords < 50 ? 'bg-rose-400' : 'bg-emerald-400'}`}
                          style={{ width: `${aiDetectionResult.dimensions.templateWords}%` }}
                        />
                      </div>
                    </div>
                    {/* D2 口语密度 */}
                    <div>
                      <div className="text-[9px] text-slate-500 mb-0.5">口语密度</div>
                      <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden">
                        <div
                          className={`h-full ${aiDetectionResult.dimensions.colloquialDensity < 50 ? 'bg-rose-400' : 'bg-emerald-400'}`}
                          style={{ width: `${aiDetectionResult.dimensions.colloquialDensity}%` }}
                        />
                      </div>
                    </div>
                    {/* D3 句式变化 */}
                    <div>
                      <div className="text-[9px] text-slate-500 mb-0.5">句式变化</div>
                      <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden">
                        <div
                          className={`h-full ${aiDetectionResult.dimensions.sentenceVariation < 50 ? 'bg-rose-400' : 'bg-emerald-400'}`}
                          style={{ width: `${aiDetectionResult.dimensions.sentenceVariation}%` }}
                        />
                      </div>
                    </div>
                    {/* D4 段落变化 */}
                    <div>
                      <div className="text-[9px] text-slate-500 mb-0.5">段落变化</div>
                      <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden">
                        <div
                          className={`h-full ${aiDetectionResult.dimensions.paragraphVariation < 50 ? 'bg-rose-400' : 'bg-emerald-400'}`}
                          style={{ width: `${aiDetectionResult.dimensions.paragraphVariation}%` }}
                        />
                      </div>
                    </div>
                    {/* D5 第一人称 */}
                    <div>
                      <div className="text-[9px] text-slate-500 mb-0.5">第一人称</div>
                      <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden">
                        <div
                          className={`h-full ${aiDetectionResult.dimensions.firstPersonVoice < 50 ? 'bg-rose-400' : 'bg-emerald-400'}`}
                          style={{ width: `${aiDetectionResult.dimensions.firstPersonVoice}%` }}
                        />
                      </div>
                    </div>
                    {/* D6 细节锚点 */}
                    <div>
                      <div className="text-[9px] text-slate-500 mb-0.5">细节锚点</div>
                      <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden">
                        <div
                          className={`h-full ${aiDetectionResult.dimensions.concreteDetails < 50 ? 'bg-rose-400' : 'bg-emerald-400'}`}
                          style={{ width: `${aiDetectionResult.dimensions.concreteDetails}%` }}
                        />
                      </div>
                    </div>
                    {/* D7 自嘲打断 */}
                    <div>
                      <div className="text-[9px] text-slate-500 mb-0.5">自嘲打断</div>
                      <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden">
                        <div
                          className={`h-full ${aiDetectionResult.dimensions.selfDeprecation < 50 ? 'bg-rose-400' : 'bg-emerald-400'}`}
                          style={{ width: `${aiDetectionResult.dimensions.selfDeprecation}%` }}
                        />
                      </div>
                    </div>
                    {/* D8 结尾质量 */}
                    <div>
                      <div className="text-[9px] text-slate-500 mb-0.5">结尾质量</div>
                      <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden">
                        <div
                          className={`h-full ${aiDetectionResult.dimensions.endingQuality < 50 ? 'bg-rose-400' : 'bg-emerald-400'}`}
                          style={{ width: `${aiDetectionResult.dimensions.endingQuality}%` }}
                        />
                      </div>
                    </div>
                    {/* D9 故事结构 */}
                    <div>
                      <div className="text-[9px] text-slate-500 mb-0.5">故事结构</div>
                      <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden">
                        <div
                          className={`h-full ${aiDetectionResult.dimensions.storyStructure < 50 ? 'bg-rose-400' : 'bg-emerald-400'}`}
                          style={{ width: `${aiDetectionResult.dimensions.storyStructure}%` }}
                        />
                      </div>
                    </div>
                    {/* D10 狗名一致性 */}
                    <div>
                      <div className="text-[9px] text-slate-500 mb-0.5">狗名一致</div>
                      <div className="w-full h-1.5 bg-slate-800 rounded overflow-hidden">
                        <div
                          className={`h-full ${aiDetectionResult.dimensions.nameConsistency < 50 ? 'bg-rose-400' : 'bg-emerald-400'}`}
                          style={{ width: `${aiDetectionResult.dimensions.nameConsistency}%` }}
                        />
                      </div>
                    </div>
                  </div>
                  {aiDetectionResult.level === 'strong' && (
                    <button
                      onClick={handleReAntiAiPolish}
                      disabled={isOptimizingMerge}
                      className="w-full mt-2 px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500 disabled:bg-slate-700 disabled:text-slate-500 text-sm text-white transition-colors flex items-center justify-center gap-1"
                    >
                      {isOptimizingMerge ? (
                        <>
                          <Loader2 size={12} className="animate-spin" />
                          清洗中...
                        </>
                      ) : (
                        <>
                          <RefreshCw size={12} />
                          重新去AI味
                        </>
                      )}
                    </button>
                  )}
                  {aiDetectionResult.issues.length > 0 && aiDetectionResult.level !== 'weak' && (
                    <div className="mt-1.5 text-[9px] text-amber-400 space-y-0.5">
                      {aiDetectionResult.issues.slice(0, 2).map((issue, i) => (
                        <div key={i}>• {issue}</div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-slate-500">
                  {mergedOutput.trim() ? '点击"开始合并"后自动检测' : '待生成内容后检测'}
                </div>
              )}
            </div>
          </div>

          {/* 频道模式清空按钮 */}
          {mode === ToolMode.CHANNEL && (
            <div className="flex justify-end">
              <button
                onClick={handleClearChannelPanel}
                className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-sm text-white"
              >
                清空面板
              </button>
            </div>
          )}

          {/* Auto-Pilot 百分比进度 */}
          <div className="bg-slate-900/45 border border-slate-800 rounded-xl p-3 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-300">Auto-Pilot 总进度</span>
              <span className="text-emerald-300 font-semibold">{autoPilotOverallPercent}%</span>
            </div>
            <div className="w-full h-2 rounded bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all duration-300"
                style={{ width: `${autoPilotOverallPercent}%` }}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {[
                { label: '1. 提炼大纲', pct: outlineProgressPercent },
                { label: '2. 拆分5段', pct: splitProgressPercent },
                { label: `3. 并行生成（${segmentDoneCount}/5）`, pct: generateProgressPercent },
                { label: '4. 合并优化', pct: mergeProgressPercent },
              ].map((item) => (
                <div key={item.label} className="rounded border border-slate-800 bg-slate-900/50 p-2">
                  <div className="flex items-center justify-between text-[11px] text-slate-300 mb-1">
                    <span>{item.label}</span>
                    <span className="text-slate-400">{item.pct}%</span>
                  </div>
                  <div className="w-full h-1.5 rounded bg-slate-800 overflow-hidden">
                    <div className="h-full bg-sky-500 transition-all duration-300" style={{ width: `${item.pct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 中部：5段输出编辑框 */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 5 }).map((_, idx) => (
              <div key={idx} className="bg-slate-900/55 border border-slate-800 rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold text-slate-200">第{idx + 1}段</h4>
                      {(() => {
                        const base = (rewriteSegments[idx] || '').trim();
                        const out = (segmentOutputs[idx] || '').trim();
                        const generating = !!segmentGenerating[idx];
                        const done = out.length > 0 && out !== base && !generating && isTextLikelyComplete(out);
                        return (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${generating ? 'text-amber-200 border-amber-400/60 bg-amber-500/25 shadow-[0_0_0_1px_rgba(251,191,36,0.35)]' : done ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' : 'text-slate-400 border-slate-600 bg-slate-800/60'}`}>
                            {generating ? '生成中' : done ? '已完成' : '原始/待补全'}
                          </span>
                        );
                      })()}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
                      {(() => {
                        const rp = rewriteRangeMap[rewriteLengthMode] || rewriteRangeMap.balanced;
                        const er = expandRangeMap[rewriteLengthMode] || expandRangeMap.balanced;
                        const segRatioMin = mode === ToolMode.EXPAND ? er.min : rp.segmentMin;
                        const segRatioMax = mode === ToolMode.EXPAND ? er.max : rp.segmentMax;
                        const src = ((rewriteSegments[idx] || '').replace(/\s+/g, '').length);
                        const out = ((segmentOutputs[idx] || '').replace(/\s+/g, '').length);
                        const min =
                          mode === ToolMode.EXPAND
                            ? (src > 0 ? Math.round(src * segRatioMin) : 0)
                            : Math.max(Math.round(src * segRatioMin), 40);
                        const max = Math.max(Math.round(src * segRatioMax), min + 10);
                        const ratio = src > 0 && out > 0 ? ((out / src) * 100).toFixed(0) : null;
                        const inRange = src > 0 && out >= min && out <= max;
                        const tooLow = src > 0 && out > 0 && out < min;
                        const tooHigh = src > 0 && out > max;
                        const rangeLabel = src > 0 ? `${min.toLocaleString()}~${max.toLocaleString()} 字` : '待输入原文';

                        return (
                          <>
                            <span className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800/80 text-slate-300">
                              原文 {src.toLocaleString()} 字
                            </span>
                            <span className="px-1.5 py-0.5 rounded border border-cyan-600/40 bg-cyan-500/10 text-cyan-200">
                              改写 {out.toLocaleString()} 字
                            </span>
                            {ratio && <span className="text-slate-500">({ratio}%)</span>}
                            <span className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-900/70 text-slate-400">
                              目标 {rangeLabel}
                            </span>
                            <span className={`px-1.5 py-0.5 rounded border font-semibold ${inRange ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' : tooLow ? 'text-rose-300 border-rose-500/40 bg-rose-500/10' : tooHigh ? 'text-amber-300 border-amber-500/40 bg-amber-500/10' : 'text-slate-400 border-slate-600 bg-slate-800/60'}`}>
                              {inRange ? '字数合规' : tooLow ? '偏低' : tooHigh ? '偏高' : '待生成'}
                            </span>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRegenerateSingleSegment(idx)}
                    disabled={segmentGenerating[idx]}
                    className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs text-white disabled:opacity-50"
                  >
                    {segmentGenerating[idx] ? '生成中...' : '重新生成该部分'}
                  </button>
                </div>
                <textarea
                  value={segmentOutputs[idx]}
                  onChange={(e) => {
                    const val = e.target.value;
                    const next = segmentOutputs.map((v, i) => (i === idx ? val : v));
                    setSegmentOutputs(next);
                  }}
                  placeholder="该段生成结果会显示在这里..."
                  className="w-full h-40 bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm text-slate-200 resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500 custom-scrollbar"
                />
              </div>
            ))}
          </div>

          {/* 下方：最终合并文案 */}
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-slate-300 flex justify-between items-center">
              <span className="flex items-center gap-2">
                <span>最终合并文案（可继续编辑）</span>
                {aiDetectionResult && (
                  <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                    aiDetectionResult.level === 'weak' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' :
                    aiDetectionResult.level === 'medium' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' :
                    'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                  }`}>
                    AI味:{aiDetectionResult.level === 'weak' ? '优秀' : aiDetectionResult.level === 'medium' ? '一般' : '较弱'} {aiDetectionResult.score}/10分
                  </span>
                )}
                {(() => {
                  const allSegmentsCompleted = segmentOutputs.every((s, i) => {
                    const base = (rewriteSegments[i] || '').trim();
                    const out = (s || '').trim();
                    return out.length > 0 && out !== base && isTextLikelyComplete(out);
                  });
                  const sourceLen = (inputText || '').replace(/\s+/g, '').length;
                  const mergedLen = (mergedOutput || '').replace(/\s+/g, '').length;
                  const policy = rewriteRangeMap[rewriteLengthMode] || rewriteRangeMap.balanced;
                  const belowHardThreshold =
                    mode !== ToolMode.EXPAND &&
                    sourceLen > 0 &&
                    mergedLen > 0 &&
                    mergedLen < Math.round(sourceLen * policy.finalMin);
                  const aboveSoftMax =
                    mode !== ToolMode.EXPAND && sourceLen > 0 && mergedLen > Math.round(sourceLen * policy.finalMax);
                  const completed = mergedOutput.trim().length > 0 && allSegmentsCompleted && !belowHardThreshold;
                  return (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${belowHardThreshold ? 'text-rose-300 border-rose-500/40 bg-rose-500/10' : aboveSoftMax ? 'text-amber-200 border-amber-400/50 bg-amber-500/15' : completed ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' : 'text-slate-400 border-slate-600 bg-slate-800/60'}`}>
                      {belowHardThreshold ? '未完成（低于原文）' : aboveSoftMax ? '完成（超上限，完整性优先）' : completed ? '已完成' : '原始'}
                    </span>
                  );
                })()}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-slate-600 font-mono">{mergedOutput.length.toLocaleString()} 字</span>
                <button
                  onClick={() => navigator.clipboard.writeText(mergedOutput || outputText)}
                  className="text-xs flex items-center gap-1 text-emerald-400 hover:text-emerald-300"
                >
                  <Copy size={12} /> 复制
                </button>
                <button
                  onClick={exportMergedToTxt}
                  className="text-xs flex items-center gap-1 text-blue-400 hover:text-blue-300"
                >
                  <Download size={12} /> 导出 TXT
                </button>
              </span>
            </label>
            <textarea
              value={mergedOutput}
              onChange={(e) => setMergedOutput(e.target.value)}
              placeholder={mergedOutput.trim() ? "可继续编辑最终成稿..." : "当前为空。请先完成5段生成并点击「合并最终文案」，系统会抓取各分段结果并清洗后显示最终文案。"}
              className="w-full min-h-[220px] bg-slate-950 border border-slate-800 rounded-xl p-4 text-slate-200 resize-y focus:outline-none focus:ring-1 focus:ring-emerald-500 custom-scrollbar"
            />
          </div>
        </div>
      ) : mode === ToolMode.CHANNEL ? (
        // ══════════════════════════════════════════════════════
        // 频道生成器面板
        // ══════════════════════════════════════════════════════
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* 左侧：输入区域 */}
            <div className="flex flex-col gap-4">
              <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700">
                <h3 className="text-sm font-semibold text-emerald-300 mb-3 flex items-center gap-2">
                  <Youtube size={16} />
                  频道信息输入
                </h3>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">频道主题</label>
                    <textarea
                      value={channelTopic}
                      onChange={(e) => setChannelTopic(e.target.value)}
                      placeholder="例如：生物大战长视频、历史对比、奇特组合..."
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 resize-none focus:outline-none focus:border-emerald-500"
                      rows={2}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">目标观众</label>
                    <textarea
                      value={channelTargetAudience}
                      onChange={(e) => setChannelTargetAudience(e.target.value)}
                      placeholder="例如：喜欢历史对比、生物科普、奇特组合的观众"
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 resize-none focus:outline-none focus:border-emerald-500"
                      rows={2}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">内容类型</label>
                    <textarea
                      value={channelContentType}
                      onChange={(e) => setChannelContentType(e.target.value)}
                      placeholder="例如：长视频，强调时代、数量、体型、能力与规则的对比"
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 resize-none focus:outline-none focus:border-emerald-500"
                      rows={2}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">品牌定位</label>
                    <textarea
                      value={channelBrandPositioning}
                      onChange={(e) => setChannelBrandPositioning(e.target.value)}
                      placeholder="例如：高冲击力、专业、极具视觉张力"
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 resize-none focus:outline-none focus:border-emerald-500"
                      rows={2}
                    />
                  </div>
                </div>
                
                {/* 语言选择 */}
                <div className="mt-3 pt-3 border-t border-slate-700">
                  <label className="text-xs text-slate-400 mb-2 block">频道名称语言</label>
                  <div className="flex gap-2">
                    {[
                      { value: 'both', label: '中英各半' },
                      { value: 'zh', label: '中文' },
                      { value: 'en', label: '英文' },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setChannelNameLang(opt.value as 'zh' | 'en' | 'both')}
                        className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                          channelNameLang === opt.value
                            ? 'bg-emerald-600 text-white'
                            : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                
                <button
                  onClick={() => generateChannelAssets()}
                  disabled={isGeneratingChannel || !channelTopic.trim()}
                  className="w-full mt-4 px-4 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:from-slate-600 disabled:to-slate-600 text-white text-sm font-semibold rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg disabled:shadow-none"
                >
                  {isGeneratingChannel ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      生成中...
                    </>
                  ) : (
                    <>
                      <Wand2 size={16} />
                      生成频道资产
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* 右侧：生成结果 */}
            <div className="flex flex-col gap-4">
              {channelOutput ? (
                <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 space-y-4 overflow-y-auto max-h-[500px]">
                  {/* 频道名称 */}
                  <div>
                    <h4 className="text-sm font-semibold text-emerald-300 mb-2 flex items-center gap-2">
                      <Youtube size={14} />
                      频道名称（3个方案）
                    </h4>
                    <div className="space-y-2">
                      {channelOutput.names.map((name, i) => (
                        <div key={i} className="bg-slate-900/80 rounded-lg p-3 border border-slate-700">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs text-slate-500">方案 {i + 1}</span>
                            <button
                              onClick={() => navigator.clipboard.writeText(name)}
                              className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                            >
                              <Copy size={10} /> 复制
                            </button>
                          </div>
                          <p className="text-sm text-slate-200 font-medium">{name}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 头像提示词 */}
                  <div>
                    <h4 className="text-sm font-semibold text-blue-300 mb-2 flex items-center gap-2">
                      <Image size={14} />
                      头像提示词（3个方案）
                    </h4>
                    <div className="space-y-2">
                      {channelOutput.avatarPrompts.map((prompt, i) => (
                        <div key={i} className="bg-slate-900/80 rounded-lg p-3 border border-slate-700">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-slate-500">方案 {i + 1}</span>
                            <div className="flex gap-2">
                              <button
                                onClick={() => navigator.clipboard.writeText(prompt)}
                                className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                              >
                                <Copy size={10} /> 复制
                              </button>
                              <button
                                onClick={() => generateAvatarImage(i)}
                                disabled={isGeneratingAvatar}
                                className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                              >
                                <Image size={10} /> 生图
                              </button>
                            </div>
                          </div>
                          <p className="text-xs text-slate-300 leading-relaxed">{prompt}</p>
                          {generatedAvatarImages[i] && (
                            <img src={generatedAvatarImages[i]} alt={`Avatar ${i + 1}`} className="mt-2 rounded-lg w-32 h-32 object-cover border border-slate-600" />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 横幅提示词 */}
                  <div>
                    <h4 className="text-sm font-semibold text-purple-300 mb-2 flex items-center gap-2">
                      <Image size={14} />
                      横幅提示词（3个方案）
                    </h4>
                    <div className="space-y-2">
                      {channelOutput.bannerPrompts.map((prompt, i) => (
                        <div key={i} className="bg-slate-900/80 rounded-lg p-3 border border-slate-700">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-slate-500">方案 {i + 1}</span>
                            <div className="flex gap-2">
                              <button
                                onClick={() => navigator.clipboard.writeText(prompt)}
                                className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                              >
                                <Copy size={10} /> 复制
                              </button>
                              <button
                                onClick={() => generateBannerImage(i)}
                                disabled={isGeneratingBanner}
                                className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1"
                              >
                                <Image size={10} /> 生图
                              </button>
                            </div>
                          </div>
                          <p className="text-xs text-slate-300 leading-relaxed line-clamp-3">{prompt}</p>
                          {generatedBannerImages[i] && (
                            <img src={generatedBannerImages[i]} alt={`Banner ${i + 1}`} className="mt-2 rounded-lg w-full h-24 object-cover border border-slate-600" />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 频道说明 */}
                  <div>
                    <h4 className="text-sm font-semibold text-amber-300 mb-2">频道说明</h4>
                    <div className="bg-slate-900/80 rounded-lg p-3 border border-slate-700">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-slate-500">{channelOutput.description.length} 字符</span>
                        <button
                          onClick={() => navigator.clipboard.writeText(channelOutput.description)}
                          className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                        >
                          <Copy size={10} /> 复制
                        </button>
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{channelOutput.description}</p>
                    </div>
                  </div>

                  {/* 关键词 */}
                  <div>
                    <h4 className="text-sm font-semibold text-rose-300 mb-2">关键词字段</h4>
                    <div className="bg-slate-900/80 rounded-lg p-3 border border-slate-700">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-slate-500">3个方案（中文/英文/混合）</span>
                        <button
                          onClick={() => navigator.clipboard.writeText(channelOutput.keywords.join('\n'))}
                          className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                        >
                          <Copy size={10} /> 复制全部
                        </button>
                      </div>
                      <div className="space-y-2">
                        {channelOutput.keywords.map((kw, i) => (
                          <div key={i} className="flex items-start gap-2">
                            <span className="text-xs text-slate-500 shrink-0">方案{i + 1}：</span>
                            <p className="text-xs text-slate-300">{kw}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-slate-800/50 p-8 rounded-xl border border-slate-700 flex flex-col items-center justify-center text-center h-full min-h-[300px]">
                  <Youtube size={48} className="text-slate-600 mb-4" />
                  <p className="text-slate-400 text-sm">填写左侧频道信息，点击"生成频道资产"开始</p>
                  <p className="text-slate-500 text-xs mt-2">将为你生成频道名称、头像提示词、横幅提示词、频道说明和关键词</p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
       <div className="grid grid-cols-1 md:grid-cols-2 gap-6 h-[600px]">
            {/* Input */}
            <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-400 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>原始文本</span>
              <span className="text-xs text-slate-600">（支持 YouTube 链接自动提取）</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-600 font-mono">{inputText.length.toLocaleString()} 字</span>
              {isYouTubeLink(inputText.trim()) && (
                <button
                  onClick={handleExtractTranscript}
                  disabled={isExtractingTranscript}
                  className="flex items-center gap-1 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-md shadow disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  <Download size={14} />
                  <span>{isExtractingTranscript ? '提取中...' : '提取字幕'}</span>
                </button>
              )}
            </div>
          </label>
                <textarea 
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
            placeholder="请在此粘貼您的内容或 YouTube 链接..."
                    className="flex-1 bg-slate-800/50 border border-slate-700 rounded-xl p-4 text-slate-200 resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500 leading-relaxed custom-scrollbar"
                />
            </div>

            {/* Output */}
            <div className="flex flex-col gap-2 relative">
                <label className="text-sm font-medium text-slate-400 flex justify-between items-center">
                    <span>生成结果</span>
                    <div className="flex items-center gap-2">
                        {outputText && (
                          <span className="text-xs text-slate-600 font-mono">{outputText.length.toLocaleString()} 字</span>
                        )}
                        {outputText && (
                            <span className="flex items-center gap-2">
                                <button 
                                    onClick={copyToClipboard} 
                                    className="text-xs flex items-center gap-1 text-emerald-400 hover:text-emerald-300 transition-colors"
                                    title="复制到剪貼板"
                                >
                                    <Copy size={12} /> 复制
                                </button>
                                <button 
                                    onClick={exportToTxt} 
                                    className="text-xs flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
                                    title="导出為 TXT 文件"
                                >
                                    <Download size={12} /> 导出 TXT
                                </button>
                            </span>
                        )}
                    </div>
                </label>
                <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl p-4 text-slate-200 overflow-y-auto whitespace-pre-wrap leading-relaxed relative custom-scrollbar">
                    {outputText}
                    {isGenerating && (
                        <>
                            {!outputText && (
                                <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">
                                    <div className="flex items-center gap-2">
                                        <span className="inline-block w-2 h-4 bg-emerald-500 animate-pulse" />
                                        <span>生成中...</span>
                </div>
                </div>
                            )}
                            {outputText && <span className="inline-block w-2 h-4 bg-emerald-500 ml-1 animate-pulse" />}
                        </>
                    )}
                    {!outputText && !isGenerating && (
                        <div className="absolute inset-0 flex items-center justify-center text-slate-600 text-sm">
                            結果將显示于此
                </div>
                    )}
                </div>
            </div>
       </div>
      )}
       
       {/* 历史记录选择器 */}
       {showHistorySelector && (
           <HistorySelector
               records={historyRecords}
               onSelect={handleHistorySelect}
               onClose={() => {
                   // 如果用户关闭选择器，仍然执行切换操作
                   if (pendingModeChange) {
                       const { mode: newMode, niche: newNiche } = pendingModeChange;

                       // 执行模式或赛道的切换
                       if (newMode !== activeTask.mode) {
                           // 切换模式
                           updateActiveTask({ mode: newMode });
                       } else if (newNiche !== activeTask.niche) {
                           // 切换赛道
                           updateActiveTask({ niche: newNiche });
                           setNicheManuallySet(true);
                       }
                   }
                   
                   setShowHistorySelector(false);
                   setPendingModeChange(null);
               }}
               onDelete={(record) => {
                   if (pendingModeChange) {
                       const historyKey = getToolsHistoryKey(pendingModeChange.mode, pendingModeChange.niche);
                       deleteHistory('tools', historyKey, record.timestamp);
                       setHistoryRecords(getHistory('tools', historyKey));
                   }
               }}
               onClearAll={() => {
                   if (pendingModeChange) {
                       const historyKey = getToolsHistoryKey(pendingModeChange.mode, pendingModeChange.niche);
                       clearHistory('tools', historyKey);
                       setHistoryRecords([]);
                   }
               }}
               title="选择历史记录"
           />
       )}
    </div>
  );
};