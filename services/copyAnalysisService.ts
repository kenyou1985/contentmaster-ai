/**
 * 文案成片模块 · 文案解析服务
 *
 * 输入：用户原始文案（一段文本）
 * 输出：3 套「标题 + 封面提示词 + 人物信息」方案（JSON）
 *
 * 复用：openlux.ai /v1/chat/completions（与 yunwuService.polishTextForTtsSpeech 同源）
 */

export type CopyTitleStyle =
  | '震惊悬念'
  | '冲突博弈'
  | '洞察揭示'
  | '悬念层层递进'
  | '强对抗'
  | '人性透视';

export interface CopyTitleOption {
  /** 风格标签（如「震惊悬念」） */
  styleTag: CopyTitleStyle;
  /** 表情前缀（用于 UI 显示） */
  emoji: string;
  /** 三段式爆款标题，25-40 字 */
  title: string;
  /** 风格关键词（用于封面提示词） */
  styleKeywords: string[];
  /** 英文文生图封面提示词（人物特写 + 文字叠加） */
  coverPromptEn: string;
  /** 中文封面描述（10-15 字） */
  coverDescriptionZh: string;
}

export interface CopyCharacterInfo {
  /** 人物姓名（若文中出现多人物，列主人物） */
  name: string;
  /** 身份/职位/身份标签 */
  title: string;
  /** 视觉特征描述（用于生图） */
  visualDescription: string;
  /** 主导情绪 */
  dominantEmotion: string;
}

export interface CopyAnalysisResult {
  titleOptions: CopyTitleOption[];
  characterInfo: CopyCharacterInfo;
  /** 解析摘要（1-2 句话，告诉用户这段讲什么） */
  summary: string;
}

/**
 * 调用云雾 chat 解析文案（轻量级封装，复用与 yunwuService 一致的 endpoint）
 */
export async function analyzeCopyWithLlm(
  apiKey: string,
  rawText: string,
  prompt: string,
  onLog?: (msg: string) => void
): Promise<CopyAnalysisResult> {
  onLog?.('[文案解析] 调用 LLM 解析文案...');
  if (!apiKey?.trim()) {
    throw new Error('云雾 API Key 未配置');
  }
  const trimmed = rawText.trim();
  if (trimmed.length < 50) {
    throw new Error('文案过短（少于 50 字），请输入至少 300 字以获得最佳效果');
  }

  const userMsg = `用户文案如下（请保留原文关键信息，不删改不杜撰）：\n\n${trimmed}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90_000);
  let raw = '';
  try {
    const res = await fetch('https://api.openlux.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.5,
        max_tokens: 4096,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`LLM 调用失败 HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('LLM 返回内容为空');
    }
    raw = content.trim();
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error('LLM 解析超时（>90s）');
    }
    throw new Error(e?.message || 'LLM 调用失败');
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseAnalysisJson(raw);
  onLog?.(`[文案解析] 完成：${parsed.titleOptions.length} 套方案`);
  return parsed;
}

/**
 * 解析 LLM 返回的 JSON（带宽松容错）
 */
function parseAnalysisJson(raw: string): CopyAnalysisResult {
  // 去掉 markdown 代码块包裹
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  // 尝试直接解析
  let obj: any;
  try {
    obj = JSON.parse(s);
  } catch {
    // 容错：提取首个 { 到末尾 }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        obj = JSON.parse(s.slice(start, end + 1));
      } catch {
        throw new Error('LLM 返回的不是合法 JSON：' + s.slice(0, 200));
      }
    } else {
      throw new Error('LLM 返回中找不到 JSON：' + s.slice(0, 200));
    }
  }

  // 校验 + 默认值
  const titleOptions: CopyTitleOption[] = Array.isArray(obj.titleOptions)
    ? obj.titleOptions.slice(0, 3).map((t: any, i: number) => ({
        styleTag: t.styleTag || '震惊悬念',
        emoji: t.emoji || ['🔥', '⚔️', '💡'][i] || '✨',
        title: String(t.title || '').trim(),
        styleKeywords: Array.isArray(t.styleKeywords)
          ? t.styleKeywords.map((x: any) => String(x)).slice(0, 5)
          : [],
        coverPromptEn: String(t.coverPromptEn || '').trim(),
        coverDescriptionZh: String(t.coverDescriptionZh || '').trim(),
      }))
    : [];

  const characterInfo: CopyCharacterInfo = {
    name: String(obj.characterInfo?.name || '').trim(),
    title: String(obj.characterInfo?.title || '').trim(),
    visualDescription: String(obj.characterInfo?.visualDescription || '').trim(),
    dominantEmotion: String(obj.characterInfo?.dominantEmotion || '').trim(),
  };

  if (titleOptions.length === 0) {
    throw new Error('LLM 未生成任何标题方案');
  }

  return {
    titleOptions,
    characterInfo,
    summary: String(obj.summary || '').trim(),
  };
}
