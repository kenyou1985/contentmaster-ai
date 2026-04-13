/**
 * AI 内容去味服务
 * 目的：给 AI 生成的内容加"人类噪点"，打破完美感，注入真实结构
 * 让 YouTube 等平台检测判定为「人主导、AI 辅助」的内容
 */

import { streamContentGeneration, type StreamModelArgs } from './geminiService';

export interface AntiAiPolishingOptions {
  /** 云雾 API Key */
  yunwuApiKey: string;
  /** 日志回调 */
  onLog?: (message: string) => void;
  /** 流式输出回调 */
  onChunk?: (text: string) => void;
}

/**
 * AI 内容去味清洗 Prompt
 */
const ANTI_AI_POLISH_PROMPT = `你是内容"去AI味"专家。请对以下文案进行深度改写，让它看起来像真实人类写的，而不是AI批量生成的。

## 改写原则（必须严格遵守）

### 1. 删除 AI 模板词
禁止使用以下模板连接词，全部替换为自然表达或直接删除：
- 首先、其次、另外、此外、因此、总而言之、综上所述、由此可见
- 首先...其次...最后...、第一...第二...第三...、总而言之
- 综上所述、总的来看、整体而言、显而易见、毫无疑问

### 2. 句式混乱化
- 长句、短句、碎句交替使用
- 允许出现不影响理解的小断裂、小停顿
- 主动句和被动句交替使用
- 可以加入倒装、反问、感叹句

### 3. 注入"人类特征"
加入以下元素（每300字至少1处）：
- 口语词：嘛、呢、罢了、其实、说白了、你懂的、讲真、说实话
- 轻微犹豫/不确定：可能、或许、某种程度上、个人感觉、我倾向于认为
- 个人视角：我自己试过、我当时、我发现、我觉得、我最讨厌/喜欢
- 小情绪/小吐槽：真的挺烦、有点无语、说实话挺香、被坑过

### 4. 结构打破"完美感"
- 段落长短不一，不要均匀分布
- 可以突然跳题1-2句（再自然拉回来）
- 结尾不要强行升华，自然收尾即可
- 允许轻微的逻辑跳跃

### 5. 加入"真实感细节"
- 加具体数字、时间（去年3月、上周二、凌晨2点）
- 加具体地点（我家书房、广州城中村、楼下便利店）
- 加具体物品（旧笔记本、iPhone 13、9.9包邮的数据线）
- 加虚构但合理的小场景/小故事

### 6. 替换 AI 高频词
将以下 AI 高频词替换为口语表达：
- 重要的 → 有用的、很重要
- 关键的 → 挺关键的、其实挺关键
- 显著的 → 明显的、确实变好了
- 有效的 → 真管用、有效果
- 提升/优化 → 变好、改一改
- 赋能/抓手/闭环 → （直接删除或换成大白话）
- 布局 → 规划、安排

### 7. 允许"小瑕疵"
- 每800字允许1处小语病（如少个"的"、多一个逗号）
- 列举时留缺口："...等等"、"诸如此类"、"还有很多不一一列了"
- 部分规范词改成口语缩写：不用→甭、怎么样→咋样、这样→酱

## 风格要求
整体风格要像真实博主随口分享，不是机器念稿。读起来要有点"人味儿"，有温度，有情绪，有小瑕疵。

## 输出要求
- 只输出改写后的正文，不要任何解释
- 不要添加任何"以下是改写结果"之类的说明
- 直接输出改写后的完整文案`;

export interface AntiAiPolishingResult {
  success: boolean;
  polishedText: string;
  error?: string;
}

/**
 * 执行 AI 内容去味清洗
 */
export async function polishTextForAntiAi(
  text: string,
  options: AntiAiPolishingOptions,
  ...modelArgs: StreamModelArgs
): Promise<AntiAiPolishingResult> {
  const { onLog, onChunk, yunwuApiKey } = options;

  if (!text || !text.trim()) {
    return { success: false, polishedText: '', error: '输入文本为空' };
  }

  onLog?.('[去AI味] 开始内容清洗...');

  try {
    let polished = '';

    const prompt = `${ANTI_AI_POLISH_PROMPT}

## 待改写文案

${text}`;

    await streamContentGeneration(
      prompt,
      '你是内容去AI味专家，请深度改写文案，让它看起来像真实人类写的。',
      (chunk) => {
        polished += chunk;
        onChunk?.(polished);
      },
      ...modelArgs
    );

    const result = (polished || '').trim();

    if (!result) {
      onLog?.('[去AI味] 清洗返回空，保留原文');
      return { success: false, polishedText: text, error: '清洗返回空' };
    }

    const originalLen = text.replace(/\s+/g, '').length;
    const polishedLen = result.replace(/\s+/g, '').length;

    onLog?.(`[去AI味] 完成: ${originalLen} -> ${polishedLen} 字`);

    return { success: true, polishedText: result };
  } catch (error: any) {
    onLog?.(`[去AI味] 失败: ${error.message || error}`);
    return { success: false, polishedText: text, error: error.message || '未知错误' };
  }
}

/**
 * 快速本地去AI味（不做复杂改写，只做基础清洗）
 * 用于轻量级场景，不需要调用 AI
 */
export function quickLocalAntiAiPolish(text: string): string {
  let result = text;

  // 1. 删除常见 AI 模板词
  const templateWords = [
    '首先', '其次', '另外', '此外', '因此', '总而言之', '综上所述', '由此可见',
    '总的来看', '整体而言', '显而易见', '毫无疑问', '毋庸置疑',
    '值得注意的是', '需要指出的是', '不言而喻', '换句话说', '也就是说',
  ];
  templateWords.forEach(word => {
    result = result.replace(new RegExp(word, 'g'), '');
  });

  // 2. 删除序号列表格式
  result = result.replace(/^\d+[.、:：]\s*/gm, '');
  result = result.replace(/^[一二三四五六七八九十]+[.、:：]\s*/gm, '');

  // 3. 删除多余空行
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}
