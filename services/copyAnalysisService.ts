/* eslint-disable no-console */
/**
 * 文案成片模块 · 文案解析服务
 *
 * 输入：用户原始文案（一段文本）
 * 输出：6 套「标题 + 封面提示词 + 人物信息」方案（JSON，封面赛道 A~F）
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
  /** v1.4：所属方案（A/B/C/D/E/F），决定封面构图方向 */
  schemeId: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  /** v1.4：方案中文名（场景沉浸/极简底/高反差特写/纵向分屏/信息图数据牌/人像+大字横幅） */
  schemeName: string;
}

export interface CopyCharacterInfo {
  /** 人物姓名（若文中出现多人物，列主人物）—— 兼容旧字段 */
  name: string;
  /** 身份/职位/身份标签 —— 兼容旧字段 */
  title: string;
  /** 视觉特征描述（用于生图） —— 兼容旧字段 */
  visualDescription: string;
  /** 主导情绪 —— 兼容旧字段 */
  dominantEmotion: string;
  /** 视觉标签/关系角色（如：主人物/对手/背景/受访者） */
  role?: string;
}

/**
 * 文案中出现的所有人物（按重要性排序）
 */
export interface CopyCharacterEntry extends CopyCharacterInfo {
  /** 唯一次序（0..N-1），0 = 主人物 */
  order: number;
}

export interface CopyAnalysisResult {
  titleOptions: CopyTitleOption[];
  /**
   * 主人物信息（向后兼容字段）
   * - 始终等于 characters[0]
   * - 旧代码仍可读取 characterInfo.name 等字段
   */
  characterInfo: CopyCharacterInfo;
  /** 文案中出现的所有人物（按重要性排序） */
  characters: CopyCharacterEntry[];
  /** 解析摘要（1-2 句话，告诉用户这段讲什么） */
  summary: string;
}

/**
 * v1.5 解析诊断信息（暴露原始响应 / finish_reason / usage 等，便于排查「LLM 返回为空」等问题）
 */
export interface AnalyzeDiagnostics {
  /** 是否成功 */
  ok: boolean;
  /** HTTP 状态码（成功时也是 200） */
  httpStatus?: number;
  /** API 错误信息（message 字段） */
  apiError?: string;
  /** finish_reason：stop / length / content_filter / tool_calls / function_call 等 */
  finishReason?: string;
  /** 模型名 */
  model?: string;
  /** prompt_tokens / completion_tokens / total_tokens */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** 重试次数 */
  attempts?: number;
  /** 耗时（ms） */
  elapsedMs?: number;
  /** 截断后被丢弃的尾部字符数（input clipping） */
  clippedChars?: number;
  /** 原始 content 长度 */
  rawContentLen?: number;
  /** 错误信息 */
  error?: string;
}

export interface AnalyzeOptions {
  onLog?: (msg: string) => void;
  /** 超时时间（默认 180000ms = 3 分钟） */
  timeoutMs?: number;
  /** 失败时的重试次数（默认 1 次；总尝试 = retries + 1） */
  retries?: number;
  /** 自定义模型名 */
  model?: string;
  /** 失败时回调（用于打印诊断日志） */
  onDiagnostics?: (diag: AnalyzeDiagnostics) => void;
  /** 输入文案最大长度（超过则截断；默认 6000 字） */
  maxInputChars?: number;
}

/**
 * 调用云雾 chat 解析文案
 * v1.5 增强：
 *  - max_tokens 4096 → 8192（适配 6 套方案）
 *  - 加诊断信息（finish_reason / usage / 原始响应长度）
 *  - 自动重试 1 次（失败/空响应）
 *  - 超时 90s → 180s
 *  - 超长 input 自动截断（默认 6000 字）
 */
export async function analyzeCopyWithLlm(
  apiKey: string,
  rawText: string,
  prompt: string,
  options: AnalyzeOptions | ((msg: string) => void) = {}
): Promise<CopyAnalysisResult> {
  // 向后兼容：旧用法 analyzeCopyWithLlm(apiKey, text, prompt, onLog)
  let opts: AnalyzeOptions = {};
  if (typeof options === 'function') {
    opts = { onLog: options };
  } else if (options) {
    opts = options;
  }

  const onLog = opts.onLog;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const retries = opts.retries ?? 1;
  const model = opts.model ?? 'gpt-5.6-luna';
  const maxInputChars = opts.maxInputChars ?? 6000;

  onLog?.('[文案解析] 调用 LLM 解析文案...');
  if (!apiKey?.trim()) {
    throw new Error('云雾 API Key 未配置');
  }
  const trimmed = rawText.trim();
  if (trimmed.length < 50) {
    throw new Error('文案过短（少于 50 字），请输入至少 300 字以获得最佳效果');
  }

  // v1.5：超长文案截断（避免 input 超大导致 LLM 拒答 / 超时）
  let inputText = trimmed;
  let clippedChars = 0;
  if (trimmed.length > maxInputChars) {
    const half = Math.floor(maxInputChars / 2);
    inputText = `${trimmed.slice(0, half)}\n\n……（中间内容已省略，共省略 ${
      trimmed.length - maxInputChars
    } 字）……\n\n${trimmed.slice(-half)}`;
    clippedChars = trimmed.length - maxInputChars;
    onLog?.(
      `[文案解析] ⚠ 文案过长（${trimmed.length} 字），已截断为 ${maxInputChars} 字（保留首尾各 ${half} 字，丢中间）`
    );
  }

  const userMsg = `用户文案如下（请保留原文关键信息，不删改不杜撰）：\n\n${inputText}`;

  const startedAt = Date.now();
  let lastError: Error | null = null;
  let lastDiag: AnalyzeDiagnostics | null = null;
  let raw = '';

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = 1500 * attempt; // 1.5s / 3s
      onLog?.(`[文案解析] 第 ${attempt + 1} 次重试（前一次失败：${lastError?.message || '空响应'}，等待 ${delay}ms）`);
      await new Promise((r) => setTimeout(r, delay));
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const attemptStart = Date.now();
    try {
      const res = await fetch('https://api.openlux.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: userMsg },
          ],
          temperature: 0.5,
          max_tokens: 8192, // v1.5：4096 → 8192，适配 6 套方案 + 长 coverPromptEn
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const msg = `LLM 调用失败 HTTP ${res.status}: ${errText.slice(0, 300)}`;
        lastError = new Error(msg);
        lastDiag = {
          ok: false,
          httpStatus: res.status,
          apiError: errText.slice(0, 300),
          model,
          attempts: attempt + 1,
          elapsedMs: Date.now() - attemptStart,
          clippedChars,
          error: msg,
        };
        continue; // 重试
      }
      const data = await res.json();
      const choice = data?.choices?.[0];
      const content = choice?.message?.content;
      const finishReason = choice?.finish_reason;
      const usage = data?.usage || {};

      // v1.5 诊断：把原始数据 + finish_reason 都写进日志
      const diag: AnalyzeDiagnostics = {
        ok: !!content,
        httpStatus: 200,
        finishReason,
        model,
        usage: {
          promptTokens: usage?.prompt_tokens ?? 0,
          completionTokens: usage?.completion_tokens ?? 0,
          totalTokens: usage?.total_tokens ?? 0,
        },
        attempts: attempt + 1,
        elapsedMs: Date.now() - attemptStart,
        clippedChars,
        rawContentLen: typeof content === 'string' ? content.length : 0,
      };

      onLog?.(
        `[文案解析] 尝试 ${attempt + 1}/${retries + 1}：finish_reason=${
          finishReason || 'n/a'
        } · usage(prompt=${diag.usage!.promptTokens}, completion=${
          diag.usage!.completionTokens
        }, total=${diag.usage!.totalTokens}) · content_len=${
          diag.rawContentLen
        } · 耗时 ${diag.elapsedMs}ms`
      );

      if (typeof content !== 'string' || !content.trim()) {
        // 空 content —— 多半是 finish_reason='length' 触发的截断，或上游风控
        const hint =
          finishReason === 'length'
            ? '达到 max_tokens 上限被截断（请加大 max_tokens 或精简 prompt）'
            : finishReason === 'content_filter'
            ? '上游内容安全过滤拦截'
            : finishReason === 'stop'
            ? '模型正常停止但 content 为空（极少见，可能是 prompt 冲突）'
            : '未知原因';
        lastError = new Error(`LLM 返回内容为空（${hint}）`);
        lastDiag = { ...diag, ok: false, error: lastError.message };
        continue; // 重试
      }

      raw = content.trim();
      lastDiag = diag;
      opts.onDiagnostics?.(diag);
      break; // 成功，跳出循环
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        lastError = new Error(`LLM 解析超时（>${Math.round(timeoutMs / 1000)}s）`);
      } else if (e?.name === 'TypeError' && /network|fetch/i.test(e?.message || '')) {
        lastError = new Error('网络异常：' + (e?.message || 'fetch 失败'));
      } else {
        lastError = new Error(e?.message || 'LLM 调用失败');
      }
      lastDiag = {
        ok: false,
        model,
        attempts: attempt + 1,
        elapsedMs: Date.now() - attemptStart,
        clippedChars,
        error: lastError.message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // 全部尝试都失败
  if (!raw) {
    opts.onDiagnostics?.(lastDiag || { ok: false, error: '未知失败' });
    const elapsed = Date.now() - startedAt;
    const diagSummary = lastDiag
      ? `[finish_reason=${lastDiag.finishReason || 'n/a'} · usage(${
          lastDiag.usage?.promptTokens ?? '?'
        }/${lastDiag.usage?.completionTokens ?? '?'}/${
          lastDiag.usage?.totalTokens ?? '?'
        }) · 已重试 ${lastDiag.attempts || 1} 次 · 累计耗时 ${elapsed}ms]`
      : '';
    throw new Error(`${lastError?.message || 'LLM 调用失败'} ${diagSummary}`);
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
  // v1.4：支持 6 套方案（A~F），兼容旧版 3 套
  const titleOptionsRaw: any[] = Array.isArray(obj.titleOptions) ? obj.titleOptions : [];
  // 上限 6 套（A~F），向下兼容旧 3 套
  const titleOptions: CopyTitleOption[] = titleOptionsRaw.slice(0, 6).map((t: any, i: number) => {
    // schemeId/schemeName 优先读 LLM 输出，否则按 i 映射
    const schemeId = String(t.schemeId || ['A', 'B', 'C', 'D', 'E', 'F'][i] || 'A').toUpperCase();
    const schemeNameMap: Record<string, string> = {
      A: '场景沉浸',
      B: '极简底',
      C: '高反差特写',
      D: '纵向分屏',
      E: '信息图/数据牌',
      F: '人像+大字横幅',
    };
    const schemeName = String(t.schemeName || schemeNameMap[schemeId] || '场景沉浸');
    const defaultEmojiMap: Record<string, string> = {
      A: '🎬',
      B: '🎨',
      C: '🔥',
      D: '📐',
      E: '📊',
      F: '🏆',
    };
    return {
      styleTag: (t.styleTag || '震惊悬念') as CopyTitleStyle,
      emoji: String(t.emoji || defaultEmojiMap[schemeId] || '✨'),
      title: String(t.title || '').trim(),
      styleKeywords: Array.isArray(t.styleKeywords)
        ? t.styleKeywords.map((x: any) => String(x)).slice(0, 5)
        : [],
      coverPromptEn: String(t.coverPromptEn || '').trim(),
      coverDescriptionZh: String(t.coverDescriptionZh || '').trim(),
      schemeId: schemeId as 'A' | 'B' | 'C' | 'D' | 'E' | 'F',
      schemeName,
    };
  });

  // ── 解析人物信息（支持多人物）
  // 1) 优先使用 LLM 返回的 characters 数组
  // 2) 回退到旧字段 characterInfo（保证向后兼容）
  const characters: CopyCharacterEntry[] = [];
  if (Array.isArray(obj.characters) && obj.characters.length > 0) {
    obj.characters.slice(0, 6).forEach((c: any, i: number) => {
      characters.push({
        name: String(c?.name || '').trim(),
        title: String(c?.title || '').trim(),
        visualDescription: String(c?.visualDescription || '').trim(),
        dominantEmotion: String(c?.dominantEmotion || '').trim(),
        role: String(c?.role || (i === 0 ? '主人物' : '相关人物')).trim(),
        order: i,
      });
    });
  } else if (obj.characterInfo && typeof obj.characterInfo === 'object') {
    // 旧字段回退
    const c = obj.characterInfo;
    characters.push({
      name: String(c?.name || '').trim(),
      title: String(c?.title || '').trim(),
      visualDescription: String(c?.visualDescription || '').trim(),
      dominantEmotion: String(c?.dominantEmotion || '').trim(),
      role: '主人物',
      order: 0,
    });
  }

  // 主人物（始终 = characters[0]）
  const characterInfo: CopyCharacterInfo = characters[0] || {
    name: '',
    title: '',
    visualDescription: '',
    dominantEmotion: '',
    role: '主人物',
  };

  if (titleOptions.length === 0) {
    throw new Error('LLM 未生成任何标题方案');
  }

  return {
    titleOptions,
    characterInfo,
    characters,
    summary: String(obj.summary || '').trim(),
  };
}
