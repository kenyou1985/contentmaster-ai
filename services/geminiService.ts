// Yunwu AI API Service - Using OpenAI compatible format
// Based on Python implementation: https://api.openlux.ai/v1/chat/completions

const YUNWU_BASE_URL = "https://api.openlux.ai";
const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com";
/** Yunwu 主力模型（已验证稳定可用） */
const DEFAULT_YUNWU_MODEL = "gpt-5.4-mini";
/** Google 主力模型 */
const GOOGLE_PRIMARY_MODEL = "gemini-2.0-flash";
const GOOGLE_FALLBACK_MODEL = "gemini-3.1-pro-preview";
/** 流式生成专用：强制使用 gpt-5.6-luna（不允许被 localStorage 覆盖） */
const STREAM_PRIMARY_MODEL = "gpt-5.6-luna";

/** OpenLux 支持的模型列表（用户可在 UI 选择） */
export const YUNWU_MODELS = [
  { id: 'gpt-5.6-luna',   label: 'GPT-5.6 Luna（默认）' },
  { id: 'gpt-5.4-mini',   label: 'GPT-5.4 Mini' },
  { id: 'claude-opus-5',   label: 'Claude Opus-5（Anthropic）' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini-3.1 Pro（Google）' },
  { id: 'grok-4.3',       label: 'Grok-4.3（xAI）' },
];
/** Google 支持的模型列表 */
export const GOOGLE_MODELS = [
  { id: 'gemini-2.0-flash',        label: 'Gemini-2.0 Flash（默认）' },
  { id: 'gemini-3.1-pro-preview',   label: 'Gemini-3.1 Pro Preview' },
];
/** RunningHub 支持的模型列表 */
export const RUNNINGHUB_MODELS = [
  { id: 'default', label: '默认模型（RunningHub）' },
];

/** 流式输出在首段文本出现前的最长等待；超时后 Yunwu 会改用备用模型重试一次 */
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = 120_000;
/** Yunwu OpenAI 兼容通道的兜底模型链（按顺序尝试，主模型失败后依次切换）：
 *   1. gpt-5.6-luna   （默认主模型）
 *   2. gemini-3.1-pro-preview （Google 最终兜底）
 */
export const STREAM_FALLBACK_MODEL_OPENAI = "gemini-3.1-pro-preview"; // Google Gemini 最终兜底
export const STREAM_YUNWU_PRIMARY_MODEL = "gpt-5.6-luna";   // Yunwu 主模型常量

const STREAM_FIRST_CHUNK_STALL = "STREAM_FIRST_CHUNK_STALL";
const GOOGLE_GENERATION_STALL = "GOOGLE_GENERATION_STALL";
/** 分段生成超时时的重试次数上限 */
export const SEGMENT_RETRY_MAX = 2;
/** 分段生成超时后重试前的等待时间（毫秒） */
export const SEGMENT_RETRY_DELAY_MS = 2000;
/** 流式输出在收到首包之后，若超过此时间未再收到任何 token，则中止（避免服务端挂起导致界面永远转圈） */
export const STREAM_IDLE_TIMEOUT = "STREAM_IDLE_TIMEOUT";
/** 分块间默认最长静默时间（毫秒），用于长分镜等长流式输出 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000;

export type StreamContentOptions = {
  temperature?: number;
  maxTokens?: number;
  /** 首段输出超时（毫秒），默认 60000 */
  firstChunkTimeoutMs?: number;
  /** 首包之后，若超过此毫秒未再收到新 token 则中止连接；不设则不限制（长输出可能卡死） */
  idleTimeoutMs?: number;
  /** 超时后使用的备用模型；设为 false 关闭自动切换 */
  fallbackModelOnStall?: string | false;
  /** data:image/*;base64,... 参考图（Yunwu OpenAI 兼容 vision / Google Gemini 多模态），用于封面 VAR 等需「看图写词」场景 */
  referenceDataUrls?: string[];
  /** 有参考图时，多模态首条英文说明；不传则用通用锚定（不预设狗/宠物） */
  referenceMultimodalPreamble?: string;
  /** 直接传入 API Key，跳过 localStorage 读取（用于传参调用场景） */
  apiKeyOverride?: string;
};

export type StreamModelArgs = Parameters<typeof streamContentGeneration>;

type Provider = 'yunwu' | 'google';

// Store API Key and Base URL
let apiKey: string | null = null;
let baseUrl: string = YUNWU_BASE_URL;
let provider: Provider = 'yunwu';
let model: string = DEFAULT_YUNWU_MODEL;

export const initializeGemini = (
  key: string, 
  options?: { provider?: Provider; baseUrl?: string; model?: string }
) => {
  apiKey = key.trim();
  provider = options?.provider || (apiKey.startsWith('AIza') ? 'google' : 'yunwu');
  if (provider === 'google') {
    baseUrl = GOOGLE_BASE_URL;
    model = options?.model || GOOGLE_PRIMARY_MODEL;
  } else {
    baseUrl = options?.baseUrl?.trim() || YUNWU_BASE_URL;
    model = options?.model || DEFAULT_YUNWU_MODEL;
  }
  baseUrl = baseUrl.replace(/\/$/, "");
  console.log(`[Gemini Service] Initialized (${provider}) with Base URL: ${baseUrl}, model: ${model}`);
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function retryOperation<T>(operation: () => Promise<T>, retries = 5, delay = 3000): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    const msg = (error.message || (error.error && error.error.message) || JSON.stringify(error)).toLowerCase();

    const isQuotaError =
      msg.includes('429') ||
      msg.includes('quota') ||
      msg.includes('配額') ||
      msg.includes('配额') ||
      msg.includes('overloaded') ||
      msg.includes('无可用渠道') ||
      msg.includes('no distributor') ||
      (error.status === 429);

    // 503 无可用渠道：快速失败，不做长时间等待
    const isChannelUnavailable =
      msg.includes('无可用渠道') ||
      msg.includes('no distributor') ||
      msg.includes('no available channel');

    const isRetryable =
      msg.includes('500') ||
      msg.includes('503') ||
      msg.includes('xhr error') ||
      msg.includes('network') ||
      msg.includes('fetch failed') ||
      msg.includes('failed to fetch') ||
      msg.includes('http2') ||
      msg.includes('protocol error') ||
      msg.includes('err_http2');

    // 配额错误：快速失败，不做长时间等待，让调用方快速切换到备用模型
    if (isQuotaError) {
      console.warn(`[Gemini Service] Quota error detected, failing fast for fallback. Error: ${msg}`);
      if (error.error && error.error.message) {
        throw new Error(error.error.message);
      }
      throw error;
    }

    // v9.2：敏感词错误 - 直接抛出，让调用方重试时切换 prompt
    // yunwu API 对「台湾/军事/政治」类 prompt 会触发 sensitive_words 错误
    const isSensitiveWordError =
      msg.includes('sensitive') ||
      msg.includes('敏感词') ||
      msg.includes('敏感词') ||
      msg.includes('sensitive_words') ||
      msg.includes('content_policy') ||
      msg.includes('内容安全') ||
      msg.includes('内容审核');

    if (isSensitiveWordError) {
      console.warn(`[Gemini Service] Sensitive words detected, failing fast for fallback. Error: ${msg}`);
      // 携带元数据，让调用方能识别这是敏感词问题
      const err: any = new Error(error.error?.message || error.message || 'sensitive_words');
      err.isSensitiveWords = true;
      throw err;
    }

    if (retries > 0 && isRetryable) {
      console.warn(`[Gemini Service] Retrying API call... Attempts left: ${retries}. Waiting ${delay}ms. Error: ${msg}`);
      await wait(delay);
      return retryOperation(operation, retries - 1, delay * 2);
    }

    if (error.error && error.error.message) {
      throw new Error(error.error.message);
    }

    if (msg.includes('failed to fetch') || msg.includes('fetch')) {
      throw new Error("网络请求失败。可能原因：1) API Key 无效 2) 网络连接问题 3) Base URL 配置错误 4) CORS 限制");
    }

    throw error;
  }
}

// OpenAI compatible API call with timeout
async function callYunwuAPI(
  prompt: string,
  systemInstruction: string,
  temperature: number = 0.7,
  maxTokens: number = 8192,
  stream: boolean = false,
  timeoutMs: number = 60000 // 默认 60 秒超时
): Promise<any> {
  if (!apiKey) {
    // Try to get from localStorage
    if (typeof window !== 'undefined' && window.localStorage) {
      const storedKey = window.localStorage.getItem('GEMINI_API_KEY');
      const storedProvider = window.localStorage.getItem('GEMINI_PROVIDER') as Provider | null;
      if (storedKey) {
        apiKey = storedKey;
        provider = storedProvider === 'google' ? 'google' : 'yunwu';
        if (provider === 'google') {
          baseUrl = GOOGLE_BASE_URL;
          const storedModel = window.localStorage.getItem('GEMINI_GOOGLE_MODEL');
          model = storedModel && storedModel !== 'default'
            ? storedModel
            : GOOGLE_PRIMARY_MODEL;
        } else {
          baseUrl = YUNWU_BASE_URL;
          const storedModel = window.localStorage.getItem('GEMINI_YUNWU_MODEL');
          model = storedModel && storedModel !== 'default'
            ? storedModel
            : DEFAULT_YUNWU_MODEL;
        }
        baseUrl = baseUrl.replace(/\/$/, "");
      }
    }
    
    if (!apiKey) {
      throw new Error("API Key 未設置。請在設置中輸入您的 API Key。");
    }
  } else {
    // apiKey 存在时，检查用户保存的模型偏好
    if (typeof window !== 'undefined' && window.localStorage) {
      const storedModel = window.localStorage.getItem(
        provider === 'google' ? 'GEMINI_GOOGLE_MODEL' : 'GEMINI_YUNWU_MODEL'
      );
      if (storedModel && storedModel !== 'default') {
        model = storedModel;
      }
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`
  };

  // Combine system instruction and user prompt
  const messages = [];
  if (systemInstruction) {
    messages.push({ role: "system", content: systemInstruction });
  }
  messages.push({ role: "user", content: prompt });

  const payload = {
    model: model,
    messages: messages,
    temperature: temperature,
    top_p: 0.95,
    max_tokens: maxTokens,
    stream: stream
  };

  // 使用 AbortController 实现超时
  const ac = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn(`[Gemini Service] Request timeout after ${timeoutMs}ms, aborting...`);
    ac.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
      signal: ac.signal,
      // Fix HTTP2 protocol errors by disabling keepalive
      keepalive: false,
    }).catch((fetchError: any) => {
      // Handle network errors including HTTP2 protocol errors
      const errorMsg = fetchError?.message || String(fetchError);
      if (errorMsg.includes('ERR_HTTP2_PROTOCOL_ERROR') || errorMsg.includes('HTTP2')) {
        throw new Error('HTTP2协议错误，可能是网络连接不稳定，系统将自动重试');
      }
      throw fetchError;
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = `HTTP ${response.status}: ${errorText}`;
      
      if (response.status === 401 || response.status === 403) {
        errorMsg = "API Key 無效或未授權。請檢查您的 API Key。";
      } else if (response.status === 429) {
        errorMsg = "API 配額已用完，請稍後再試。";
      }
      
      throw new Error(errorMsg);
    }

    return await response.json();
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError' || err?.message?.includes('aborted')) {
      throw new Error(`请求超时（${timeoutMs / 1000}秒未响应），请稍后重试或检查网络。`);
    }
    throw err;
  }
}

const DEFAULT_REFERENCE_MULTIMODAL_PREAMBLE =
  'The following reference images are in order: Image 1, Image 2, ... Observe ONLY what is actually visible (people, clothing, props, environment, animals only if clearly shown) and the art style. Reflect these concretely in your answer. Do not invent subjects not present in the images.';

function buildGoogleUserParts(
  prompt: string,
  referenceDataUrls?: string[],
  referenceMultimodalPreamble?: string
): { text?: string; inlineData?: { mimeType: string; data: string } }[] {
  const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [];
  if (referenceDataUrls?.length) {
    parts.push({
      text: referenceMultimodalPreamble?.trim() || DEFAULT_REFERENCE_MULTIMODAL_PREAMBLE,
    });
    for (const url of referenceDataUrls) {
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
      }
    }
  }
  parts.push({ text: prompt });
  return parts;
}

async function callGoogleAPI(
  modelName: string,
  prompt: string,
  systemInstruction: string,
  temperature: number = 0.7,
  maxTokens: number = 8192,
  referenceDataUrls?: string[],
  referenceMultimodalPreamble?: string
): Promise<any> {
  if (!apiKey) {
    throw new Error("API Key 未設置。請在設置中輸入您的 API Key。");
  }

  const payload: Record<string, any> = {
    contents: [
      {
        role: "user",
        parts: buildGoogleUserParts(prompt, referenceDataUrls, referenceMultimodalPreamble),
      },
    ],
    generationConfig: {
      temperature,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: maxTokens,
      responseMimeType: "text/plain"
    }
  };

  if (systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }

  const response = await fetch(
    `${GOOGLE_BASE_URL}/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Fix HTTP2 protocol errors by disabling keepalive
      keepalive: false,
    }
  ).catch((fetchError: any) => {
    // Handle network errors including HTTP2 protocol errors
    const errorMsg = fetchError?.message || String(fetchError);
    if (errorMsg.includes('ERR_HTTP2_PROTOCOL_ERROR') || errorMsg.includes('HTTP2')) {
      throw new Error('HTTP2协议错误，可能是网络连接不稳定，系统将自动重试');
    }
    throw fetchError;
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = `HTTP ${response.status}: ${errorText}`;
    if (response.status === 401 || response.status === 403) {
      errorMsg = "API Key 無效或未授權。請檢查您的 API Key。";
    } else if (response.status === 429) {
      errorMsg = "API 配額已用完，請稍後再試。";
    }
    throw new Error(errorMsg);
  }

  return await response.json();
}

async function callGoogleWithFallback(
  prompt: string,
  systemInstruction: string,
  temperature: number,
  maxTokens: number,
  preferredModel?: string,
  referenceDataUrls?: string[],
  referenceMultimodalPreamble?: string
): Promise<any> {
  const primaryModel = preferredModel || model || GOOGLE_PRIMARY_MODEL;
  try {
    return await retryOperation(() =>
      callGoogleAPI(
        primaryModel,
        prompt,
        systemInstruction,
        temperature,
        maxTokens,
        referenceDataUrls,
        referenceMultimodalPreamble
      )
    );
  } catch (error) {
    if (primaryModel !== GOOGLE_FALLBACK_MODEL) {
      console.warn(`[Gemini Service] Google model failed, switching to fallback: ${GOOGLE_FALLBACK_MODEL}`);
      const fallbackResponse = await retryOperation(() =>
        callGoogleAPI(
          GOOGLE_FALLBACK_MODEL,
          prompt,
          systemInstruction,
          temperature,
          maxTokens,
          referenceDataUrls,
          referenceMultimodalPreamble
        )
      );
      model = GOOGLE_FALLBACK_MODEL;
      return fallbackResponse;
    }
    throw error;
  }
}

const extractGoogleText = (response: any): string => {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!parts || !Array.isArray(parts)) return '';
  return parts.map((p: any) => p?.text || '').join('');
};

export type GenerateTopicsOptions = {
  modelName?: string;
  /** 选题条数，默认 5，范围 1–50 */
  topicCount?: number;
  /** 易经命理：近期已出选题，用于跨次去重（避免重复生成相似标题） */
  avoidTopics?: string[];
};

export const generateTopics = async (
  prompt: string,
  systemInstruction: string,
  options?: GenerateTopicsOptions
): Promise<string[]> => {
  const topicCount = Math.min(
    50,
    Math.max(1, Math.floor(options?.topicCount ?? 5))
  );
  const modelName = options?.modelName;
  const parseTopics = (raw: string): string[] => {
    if (!raw) return [];
    // v9.3：先按行分割；如果只有 1-2 行（即 LLM 输出了聊天回复段落），再按句号/问号/感叹号拆分
    let lines = raw
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    if (lines.length <= 2) {
      // 把整段按句号/问号/感叹号/分号/换行拆
      const sentences = raw.split(/[。！？!?\n；;]+/).map(s => s.trim()).filter(s => s.length > 0);
      if (sentences.length > lines.length) {
        lines = sentences;
      }
    }

    const cleaned = lines
      .map(line => line
        .replace(/^\d+[\.、]\s*/, '')
        .replace(/^[-*•]\s*/, '')
        .replace(/^["']/, '')
        .replace(/["']$/, '')
        .trim()
      )
      .filter(line => line.length >= 8 && line.length <= 60)
      // 排除明显是聊天/解释/请求的句子
      .filter(line => !/^(我不能|我无法|抱歉|对不起|很抱歉|无法|不知道|无法确定|我需要|请提供|请输入|请告诉我|如果你想|以下是|以下是我|下面这些是|这些是一些|这是一些|下面是|I'm|I cannot|I can't|sorry|Sorry|as an AI|作为一个|作为AI|由于|因此|另外|此外|首先|然后|最后|根据|针对|通过|你好|您好)/i.test(line.trim()));

    // 去重并保留顺序（当次内去重）
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const t of cleaned) {
      if (!seen.has(t)) {
        seen.add(t);
        unique.push(t);
      }
    }
    return unique;
  };

  /**
   * 易经命理跨次去重：提取关键词，移除与历史选题过于相似的标题。
   * 相似判定：标题 A 和 B 共享超过 50% 的核心关键词（长度 1-2 的词），
   * 且两者主题词（女人/男人/名人/部位/行为）相同。
   */
  const isSimilarToHistory = (topic: string, history: string[]): boolean => {
    if (!history || history.length === 0) return false;
    const extractCoreWords = (s: string): string[] => {
      return s
        .replace(/曾仕强|曾师/g, '')
        .replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 2)
        .map(w => w.toLowerCase());
    };
    const words = new Set(extractCoreWords(topic));
    if (words.size < 3) return false; // 太短的标题不比较
    for (const h of history) {
      const hw = extractCoreWords(h);
      if (hw.length === 0) continue;
      // 共享关键词超过阈值
      const shared = hw.filter(w => words.has(w.toLowerCase()));
      const ratio = shared.length / Math.max(hw.length, words.size);
      if (ratio > 0.45) return true;
    }
    return false;
  }

  const isQuotaError = (err: any): boolean => {
    const msg = (err?.message || String(err)).toLowerCase();
    return (
      msg.includes('429') ||
      msg.includes('quota') ||
      msg.includes('配額') ||
      msg.includes('配额') ||
      msg.includes('overloaded') ||
      (err?.status === 429)
    );
  };

  const isTimeoutError = (err: any): boolean => {
    const msg = (err?.message || String(err)).toLowerCase();
    return (
      msg.includes('timeout') ||
      msg.includes('超时') ||
      msg.includes('aborted') ||
      msg.includes('abort')
    );
  };

  const shouldSwitchToFallback = (err: any): boolean => {
    return isQuotaError(err) || isTimeoutError(err) || (err?.message || String(err)).toLowerCase().includes('failed to fetch');
  };

  const requestOnce = async (inputPrompt: string, isRetry = false): Promise<string> => {
    if (provider === 'google') {
      const response = await callGoogleWithFallback(inputPrompt, systemInstruction, 0.9, 4096, modelName);
      return extractGoogleText(response);
    }

    const primary = modelName || model;
    const fallback = STREAM_FALLBACK_MODEL_OPENAI;
    const primaryTimeout = isRetry ? 45000 : 60000; // 重试时用更短超时

    // 尝试主模型
    try {
      const response = await retryOperation(
        () => callYunwuAPI(inputPrompt, systemInstruction, 0.9, 4096, false, primaryTimeout),
        1, 2000
      );
      const content = response.choices?.[0]?.message?.content || "";
      if (content.trim()) return content;
    } catch (primaryErr) {
      // v9.2：敏感词错误透传 - 不吞掉，直接抛出让 Generator 降级
      const isSensitive = primaryErr?.isSensitiveWords ||
        ((primaryErr?.message || JSON.stringify(primaryErr)).toLowerCase().includes('sensitive') &&
         (primaryErr?.message || JSON.stringify(primaryErr)).includes('words'));
      if (isSensitive) {
        const err: any = new Error(primaryErr?.message || primaryErr?.error?.message || 'sensitive_words');
        err.isSensitiveWords = true;
        throw err;
      }
      const shouldFallback = shouldSwitchToFallback(primaryErr);
      console.warn(`[Gemini Service] Primary Yunwu model failed (${primary}): ${primaryErr?.message || primaryErr}, should switch: ${shouldFallback}`);
      if (shouldFallback) {
        console.warn(`[Gemini Service] Detected ${isQuotaError(primaryErr) ? 'quota' : 'timeout'} error, switching to fallback: ${fallback}`);
      }
    }

    // 备用模型：gpt-5.4-mini (备用)
    const prevModel = model;
    model = fallback;
    console.debug(`[Gemini Service] Trying fallback model: ${fallback}`);
    try {
      const response = await retryOperation(
        () => callYunwuAPI(inputPrompt, systemInstruction, 0.9, 4096, false, 45000),
        2, 3000
      );
      const content = response.choices?.[0]?.message?.content || "";
      if (content.trim()) {
        console.debug(`[Gemini Service] Fallback model success!`);
        return content;
      }
    } catch (fallbackErr) {
      console.error(`[Gemini Service] Fallback model also failed: ${fallbackErr?.message || fallbackErr}`);
    } finally {
      model = prevModel;
    }

    return "";
  };

  try {
    const firstContent = await requestOnce(prompt);
    if (!firstContent) {
      throw new Error("所有模型均返回空響應。請稍後再試或檢查 API Key。");
    }

    let topics = parseTopics(firstContent);
    console.log(`[Gemini Service] First response parsed ${topics.length} topics`);

    // 兜底补齐：若不足目标条数，最多补齐 3 轮
    let fillRounds = 0;
    while (topics.length > 0 && topics.length < topicCount && fillRounds < 3) {
      fillRounds += 1;
      const need = topicCount - topics.length;
      const fillPrompt = `${prompt}\n\n【补齐要求】\n你上一次只返回了${topics.length}个选题。请只补齐剩余${need}个，不要重复，不要解释，不要前言，每行一个标题。\n已生成（禁止重复）：\n${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
      const extraContent = await requestOnce(fillPrompt, true);
      const extraTopics = parseTopics(extraContent).filter(t => !topics.includes(t));
      console.log(`[Gemini Service] Fill round ${fillRounds}: got ${extraTopics.length} new topics`);
      if (extraTopics.length === 0) break;
      topics = [...topics, ...extraTopics];
    }

    // 易经命理跨次去重：过滤与历史选题过于相似的标题
    const avoidTopics = options?.avoidTopics ?? [];
    if (avoidTopics.length > 0) {
      const before = topics.length;
      topics = topics.filter(t => !isSimilarToHistory(t, avoidTopics));
      const removed = before - topics.length;
      console.log(`[generateTopics] Dedup removed ${removed} similar topics, ${topics.length} remaining`);
    }

    topics = topics.slice(0, topicCount);

    if (topics.length === 0) {
      throw new Error("未能生成有效选题。请稍後再試。");
    }
    
    return topics;
  } catch (error: any) {
    const errorMsg = error.message || String(error);
    console.error(`[Gemini Service] generateTopics error: ${errorMsg}`);
    if (errorMsg.includes('Failed to fetch') || errorMsg.includes('fetch')) {
      throw new Error("網絡連接失敗。請檢查：1) 網絡連接 2) API Key 是否正確 3) Base URL 是否可訪問");
    }
    throw error;
  }
};

/** 流式选题生成器：每解析出一条选题立即通过 onTopic 回调显示，逐条输出避免长时间等待。
 *  @param prompt 选题 prompt
 *  @param systemInstruction 系统指令
 *  @param options 生成选项
 *  @param onTopic 每解析出一条选题时调用（显示用）
 *  @param onComplete 所有选题生成完毕时调用，传入完整列表
 */
export const generateTopicsStreaming = async (
  prompt: string,
  systemInstruction: string,
  options: GenerateTopicsOptions & {
    onTopic?: (topic: string) => void;
    onComplete?: (topics: string[]) => void;
  }
): Promise<string[]> => {
  const topicCount = Math.min(50, Math.max(1, Math.floor(options?.topicCount ?? 5)));
  const avoidTopics = options?.avoidTopics ?? [];

  // 用于判断是否与历史选题重复
  const isSimilarToHistory = (topic: string): boolean => {
    if (!avoidTopics.length) return false;
    const extractCoreWords = (s: string): string[] => {
      return s
        .replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 2)
        .map(w => w.toLowerCase());
    };
    const words = new Set(extractCoreWords(topic));
    if (words.size < 3) return false;
    for (const h of avoidTopics) {
      const hw = extractCoreWords(h);
      if (!hw.length) continue;
      const shared = hw.filter(w => words.has(w.toLowerCase()));
      const ratio = shared.length / Math.max(hw.length, words.size);
      if (ratio > 0.45) return true;
    }
    return false;
  };

  const seen = new Set<string>();
  const allTopics: string[] = [];

  const tryParseLine = (rawLine: string): string | null => {
    const line = rawLine
      .replace(/^\d+[\.、]\s*/, '')
      .replace(/^[-*•]\s*/, '')
      .replace(/^["']/, '')
      .replace(/["']$/, '')
      .trim();

    if (line.length < 8 || line.length > 80) return null;
    if (/^(我不能|我无法|抱歉|对不起|很抱歉|无法|不知道|无法确定|我需要|请提供|请输入|请告诉我|如果你想|以下是|以下是我|下面这些是|这些是|下面是|I'm|I cannot|I can't|sorry|Sorry|as an AI|作为一个|作为AI|由于|因此|另外|此外|首先|然后|最后|根据|针对|通过|你好|您好)/i.test(line)) return null;
    return line;
  };

  const onChunk = (chunk: string) => {
    // 先按行分割
    const lines = chunk
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    for (const rawLine of lines) {
      const parsed = tryParseLine(rawLine);
      if (parsed) {
        if (!seen.has(parsed)) {
          seen.add(parsed);
          if (!isSimilarToHistory(parsed)) {
            allTopics.push(parsed);
            options?.onTopic?.(parsed);
            continue;
          }
        }
        continue;
      }
      // 行解析失败（可能是段落）：尝试按句号/问号/感叹号拆分
      const sentences = rawLine.split(/[。！？!?\n；;]+/).map(s => s.trim()).filter(s => s.length > 0);
      for (const s of sentences) {
        const parsedS = tryParseLine(s);
        if (parsedS && !seen.has(parsedS) && !isSimilarToHistory(parsedS)) {
          seen.add(parsedS);
          allTopics.push(parsedS);
          options?.onTopic?.(parsedS);
        }
      }
    }
  };

  return new Promise<string[]>((resolve, reject) => {
    let settled = false;
    const finish = (topics: string[]) => {
      if (settled) return;
      settled = true;
      const final = topics.slice(0, topicCount);
      options?.onComplete?.(final);
      resolve(final);
    };

    streamContentGeneration(
      prompt,
      systemInstruction,
      onChunk,
      options?.modelName,
      {
        temperature: 0.7,
        maxTokens: 8192,
        firstChunkTimeoutMs: 120000,
        idleTimeoutMs: 60000,
      }
    ).then(() => {
      console.log(`[generateTopicsStreaming] 流完成，共解析 ${allTopics.length} 条选题`);
      finish(allTopics);
    }).catch((err: any) => {
      console.warn(`[generateTopicsStreaming] 流错误: ${err?.message || err}, 已解析 ${allTopics.length} 条`);
      if (settled) return;
      // 如果流结束但已有选题，返回已有的
      if (allTopics.length > 0) {
        finish(allTopics);
      } else {
        // 抛出原始错误，让调用方决定是否兜底重试
        reject(err);
      }
    });
  });
};

async function streamYunwuOpenAIOnce(
  resolvedModel: string,
  prompt: string,
  systemInstruction: string,
  temperature: number,
  maxTokens: number,
  onChunk: (chunk: string) => void,
  firstChunkMs: number,
  idleTimeoutMs?: number,
  referenceDataUrls?: string[],
  referenceMultimodalPreamble?: string
): Promise<void> {
  console.log('[streamYunwuOpenAIOnce] 开始请求', {
    model: resolvedModel,
    baseUrl,
    hasApiKey: !!apiKey,
    keyPrefix: apiKey ? apiKey.substring(0, 8) : null,
    promptLength: prompt.length,
    systemLength: systemInstruction.length
  });

  if (!apiKey) {
    throw new Error("API Key 未設置。請在設置中輸入您的 API Key。");
  }

  const ac = new AbortController();
  let gotFirstChunk = false;
  const stallTimer = setTimeout(() => {
    if (!gotFirstChunk) {
      console.warn(
        `[Gemini Service] ${firstChunkMs}ms 内未收到首段输出，中止连接（模型: ${resolvedModel}）`
      );
      ac.abort();
    }
  }, firstChunkMs);

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const bumpIdle = () => {
    clearIdle();
    if (!idleTimeoutMs || idleTimeoutMs <= 0 || !gotFirstChunk) return;
    idleTimer = setTimeout(() => {
      console.warn(
        `[Gemini Service] ${idleTimeoutMs}ms 内未收到新的流式片段，中止连接（模型: ${resolvedModel}）`
      );
      ac.abort();
    }, idleTimeoutMs);
  };

  const clearStall = () => {
    clearTimeout(stallTimer);
  };

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    const messages: Array<{
      role: string;
      content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
    }> = [];
    if (systemInstruction) {
      messages.push({ role: "system", content: systemInstruction });
    }
    if (referenceDataUrls?.length) {
      const userParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
        {
          type: "text",
          text: referenceMultimodalPreamble?.trim() || DEFAULT_REFERENCE_MULTIMODAL_PREAMBLE,
        },
      ];
      for (const url of referenceDataUrls) {
        userParts.push({ type: "image_url", image_url: { url } });
      }
      userParts.push({ type: "text", text: prompt });
      messages.push({ role: "user", content: userParts });
    } else {
      messages.push({ role: "user", content: prompt });
    }

    const payload = {
      model: resolvedModel,
      messages,
      temperature,
      top_p: 0.95,
      max_tokens: maxTokens,
      stream: true,
    };

    let response: Response;
    try {
      const fetchUrl = `${baseUrl}/v1/chat/completions`;
      console.log('[streamYunwuOpenAIOnce] 发送请求到:', fetchUrl);
      response = await fetch(fetchUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: ac.signal,
        keepalive: false,
      } as RequestInit);
      console.log('[streamYunwuOpenAIOnce] 收到响应:', response.status, response.statusText);
    } catch (fetchError: any) {
      console.error('[streamYunwuOpenAIOnce] fetch 错误:', fetchError?.message, fetchError?.name);
      const name = fetchError?.name || "";
      const msg = fetchError?.message || String(fetchError);
      if (!gotFirstChunk && (name === "AbortError" || ac.signal.aborted || msg.toLowerCase().includes("abort"))) {
        throw new Error(STREAM_FIRST_CHUNK_STALL);
      }
      if (gotFirstChunk && idleTimeoutMs && idleTimeoutMs > 0 && (name === "AbortError" || ac.signal.aborted)) {
        throw new Error(STREAM_IDLE_TIMEOUT);
      }
      if (msg.includes("ERR_HTTP2_PROTOCOL_ERROR") || msg.includes("HTTP2")) {
        throw new Error("HTTP2协议错误，可能是网络连接不稳定，系统将自动重试");
      }
      throw fetchError;
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[streamYunwuOpenAIOnce] HTTP 错误:', response.status, errorText);
      let errorMsg = `HTTP ${response.status}: ${errorText}`;
      if (response.status === 401 || response.status === 403) {
        errorMsg = "API Key 無效或未授權。請檢查您的 API Key。";
      } else if (response.status === 429) {
        errorMsg = "API 配額已用完，請稍後再試。";
      }
      throw new Error(errorMsg);
    }

    // 诊断：打印响应头
    const contentType = response.headers.get('content-type') || 'unknown';
    console.log('[streamYunwuOpenAIOnce] Content-Type:', contentType);
    const transferEncoding = response.headers.get('transfer-encoding') || 'none';
    console.log('[streamYunwuOpenAIOnce] Transfer-Encoding:', transferEncoding);

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    if (!reader) {
      throw new Error("無法讀取響應流");
    }

    let buffer = "";
    let totalBytesRead = 0;
    let totalLinesParsed = 0;
    let chunksReceived = 0;
    try {
      while (true) {
        let readResult: Awaited<ReturnType<typeof reader.read>>;
        try {
          readResult = await reader.read();
        } catch (readErr: any) {
          if (
            !gotFirstChunk &&
            (readErr?.name === "AbortError" || ac.signal.aborted)
          ) {
            throw new Error(STREAM_FIRST_CHUNK_STALL);
          }
          if (
            gotFirstChunk &&
            idleTimeoutMs &&
            idleTimeoutMs > 0 &&
            (readErr?.name === "AbortError" || ac.signal.aborted)
          ) {
            throw new Error(STREAM_IDLE_TIMEOUT);
          }
          throw readErr;
        }

        const { done, value } = readResult;
        if (done) {
          console.log('[streamYunwuOpenAIOnce] 流读取完成', {
            totalBytesRead,
            totalLinesParsed,
            chunksReceived,
            bufferRemaining: buffer.length
          });
          break;
        }

        totalBytesRead += value?.length || 0;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const json = JSON.parse(data);
              totalLinesParsed++;
              const piece =
                json.choices?.[0]?.delta?.content ||
                json.choices?.[0]?.message?.content ||
                "";
              if (piece) {
                chunksReceived++;
                if (!gotFirstChunk) {
                  gotFirstChunk = true;
                  clearStall();
                  console.log('[streamYunwuOpenAIOnce] 收到第一个 chunk:', json.choices?.[0]?.delta?.content?.substring(0, 50));
                }
                bumpIdle();
                onChunk(piece);
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
    } finally {
      clearStall();
      clearIdle();
      console.log('[streamYunwuOpenAIOnce] finally 块执行', {
        gotFirstChunk,
        totalBytesRead,
        totalLinesParsed,
        chunksReceived,
        bufferRemaining: buffer.length
      });
    }

    if (!gotFirstChunk) {
      console.error('[streamYunwuOpenAIOnce] 未收到任何有效 chunk，抛出 STREAM_FIRST_CHUNK_STALL');
      throw new Error(STREAM_FIRST_CHUNK_STALL);
    }
  } finally {
    clearStall();
    clearIdle();
  }
}

export const streamContentGeneration = async (
  prompt: string,
  systemInstruction: string,
  onChunk: (chunk: string) => void,
  modelName?: string,
  options?: StreamContentOptions
) => {
  try {
      if (options?.apiKeyOverride) {
        apiKey = options.apiKeyOverride;
        // 根据 key 判断 provider（简单 heuristic）
        provider = 'yunwu';
        baseUrl = YUNWU_BASE_URL.replace(/\/$/, "");
        model = modelName || 'gpt-5.6-luna';
      } else {
        if (!apiKey) {
          if (typeof window !== "undefined" && window.localStorage) {
            const storedKey = window.localStorage.getItem("GEMINI_API_KEY");
            const storedProvider = window.localStorage.getItem(
              "GEMINI_PROVIDER"
            ) as Provider | null;
            if (storedKey) {
              apiKey = storedKey;
              provider = storedProvider === "google" ? "google" : "yunwu";
              if (provider === "google") {
                baseUrl = GOOGLE_BASE_URL;
                const storedModel = window.localStorage.getItem("GEMINI_GOOGLE_MODEL");
                model = storedModel && storedModel !== 'default'
                  ? storedModel
                  : GOOGLE_PRIMARY_MODEL;
              } else {
                baseUrl = YUNWU_BASE_URL;
                const storedModel = window.localStorage.getItem("GEMINI_YUNWU_MODEL");
                model = storedModel && storedModel !== 'default'
                  ? storedModel
                  : DEFAULT_YUNWU_MODEL;
              }
              baseUrl = baseUrl.replace(/\/$/, "");
            }
          }

          if (!apiKey) {
            throw new Error("API Key 未設置。請在設置中輸入您的 API Key。");
          }
        } else {
          // apiKey 存在时，也检查用户保存的模型偏好
          const storedModel = typeof window !== "undefined" && window.localStorage
            ? window.localStorage.getItem(
                provider === "google" ? "GEMINI_GOOGLE_MODEL" : "GEMINI_YUNWU_MODEL"
              )
            : null;
          if (storedModel && storedModel !== 'default') {
            model = storedModel;
          }
        }
      }

      const temperature = options?.temperature ?? 1.0;
      const maxTokens = options?.maxTokens ?? 16384;
      const firstChunkMs =
        options?.firstChunkTimeoutMs ?? STREAM_FIRST_CHUNK_TIMEOUT_MS;
      const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
      const fallbackOpenAI =
        options?.fallbackModelOnStall === false
          ? null
          : options?.fallbackModelOnStall ?? STREAM_FALLBACK_MODEL_OPENAI;

      const refUrls = options?.referenceDataUrls;
      const refPreamble = options?.referenceMultimodalPreamble;

      if (provider === "google") {
        const googlePrimary = modelName || model || GOOGLE_PRIMARY_MODEL;
        console.log('[Gemini Service] 使用 Google provider，模型:', googlePrimary);

        const runGoogleOnce = async (m: string) => {
          return Promise.race([
            callGoogleAPI(
              m,
              prompt,
              systemInstruction,
              temperature,
              maxTokens,
              refUrls,
              refPreamble
            ),
            new Promise<never>((_, rej) =>
              setTimeout(
                () => rej(new Error(GOOGLE_GENERATION_STALL)),
                firstChunkMs
              )
            ),
          ]);
        };

        try {
          const response = await runGoogleOnce(googlePrimary);
          const content = extractGoogleText(response);
          if (!content) {
            throw new Error("API 返回了空響應。請檢查 API Key 和配置。");
          }
          onChunk(content);
          return;
        } catch (err: any) {
          if (
            err?.message === GOOGLE_GENERATION_STALL &&
            googlePrimary !== GOOGLE_FALLBACK_MODEL
          ) {
            console.warn(
              `[Gemini Service] Google 主模型 ${firstChunkMs}ms 内无响应，切换备用: ${GOOGLE_FALLBACK_MODEL}`
            );
            const response = await runGoogleOnce(GOOGLE_FALLBACK_MODEL);
            const content = extractGoogleText(response);
            if (!content) {
              throw new Error("API 返回了空響應。請檢查 API Key 和配置。");
            }
            onChunk(content);
            return;
          }
          throw err;
        }
      }

      // Yunwu 流式调用
      console.log('[Gemini Service] 使用 Yunwu provider');
      const primaryModel = modelName || STREAM_PRIMARY_MODEL; // 流式强制用 gpt-5.6-luna
      console.log('[Gemini Service] 主模型:', primaryModel);

      const isQuotaError = (err: any): boolean => {
        const msg = (err?.message || String(err)).toLowerCase();
        return (
          msg.includes('429') ||
          msg.includes('quota') ||
          msg.includes('配額') ||
          msg.includes('配额') ||
          msg.includes('overloaded')
        );
      };

      const isChannelUnavailable = (err: any): boolean => {
        const msg = (err?.message || String(err)).toLowerCase();
        return (
          msg.includes('无可用渠道') ||
          msg.includes('no distributor') ||
          msg.includes('no available distributor') ||
          msg.includes('no channel')
        );
      };

      const isRetryableForFallback = (err: any): boolean => {
        const msg = (err?.message || String(err)).toLowerCase();
        return (
          msg === STREAM_FIRST_CHUNK_STALL.toLowerCase() ||
          msg === STREAM_IDLE_TIMEOUT.toLowerCase() ||
          msg.includes('429') ||
          msg.includes('quota') ||
          msg.includes('配額') ||
          msg.includes('配额') ||
          msg.includes('500') ||
          msg.includes('503') ||
          msg.includes('overloaded') ||
          msg.includes('xhr error') ||
          msg.includes('network') ||
          msg.includes('fetch failed') ||
          msg.includes('failed to fetch') ||
          msg.includes('http2') ||
          msg.includes('protocol error') ||
          msg.includes('err_http2')
        );
      };

      const FALLBACK_STREAM_FORMAT_HINT =
        '\n\n【格式强制】正文必须换行分段（每段若干句）；「第N节课」「第N堂课」等标题必须单独成行；句号、问号、叹号后适时换行。禁止输出整块无换行、上万字一行的正文。';

      // 流式调用包装：主模型 STALL 或配额错误立即失败，切备用模型不做额外等待
      const streamWithRetry = async (
        modelToUse: string,
        timeoutMs: number,
        systemInstructionOverride?: string
      ): Promise<void> => {
        const sys =
          systemInstructionOverride !== undefined
            ? systemInstructionOverride
            : systemInstruction;
        try {
          await streamYunwuOpenAIOnce(
            modelToUse,
            prompt,
            sys,
            temperature,
            maxTokens,
            onChunk,
            timeoutMs,
            idleTimeoutMs,
            refUrls,
            refPreamble
          );
          return; // 成功
        } catch (err: any) {
          const isQuota = isQuotaError(err);
          const isStall = err?.message === STREAM_FIRST_CHUNK_STALL;
          const isIdle = err?.message === STREAM_IDLE_TIMEOUT;
          console.warn(
            `[Gemini Service] Model ${modelToUse} failed: ${err?.message || err} (isStall=${isStall}, isIdle=${isIdle}, isQuota=${isQuota})`
          );
          // STALL 和配额错误均立即失败，触发外层 fallback 切换
          throw err;
        }
      };

      // 模型兜底链（主 → Yunwu 兜底 → Google 最终兜底）
      const FALLBACK_CHAIN: Array<{ model: string; baseUrl?: string; isGoogle?: boolean }> = [
        { model: 'gpt-5.6-luna', baseUrl: YUNWU_BASE_URL }, // Yunwu 兜底
        { model: 'gpt-5.4-mini', baseUrl: YUNWU_BASE_URL }, // Yunwu 第二兜底
        { model: GOOGLE_FALLBACK_MODEL, baseUrl: GOOGLE_BASE_URL, isGoogle: true }, // gemini-3.1-pro-preview
      ];

      const shouldFallback = (err: any): boolean => {
        if (isChannelUnavailable(err)) return true;
        return isRetryableForFallback(err);
      };

      let lastError: any = null;

      // 先尝试主模型（gpt-5.6-luna），失败后才进入 fallback 链
      console.log('[streamContentGeneration] 尝试主模型:', primaryModel);
      try {
        await streamWithRetry(primaryModel, firstChunkMs);
        return; // 主模型成功
      } catch (err: any) {
        lastError = err;
        console.warn(`[streamContentGeneration] 主模型失败: ${err?.message || err}`);
      }

      console.log('[streamContentGeneration] 开始 fallback 链检查', {
        lastError,
        shouldFallbackNull: shouldFallback(null),
        isChannelUnavailableNull: isChannelUnavailable(null),
        isRetryableNull: isRetryableForFallback(null)
      });
      for (const fb of FALLBACK_CHAIN) {
        if (!shouldFallback(lastError)) {
          console.log('[streamContentGeneration] shouldFallback 返回 false，break 循环');
          break;
        }
        console.warn(`[Gemini Service] 主模型 ${primaryModel} 失败，切备用: ${fb.model}`);
        await wait(1000);
        try {
          if (fb.isGoogle) {
            // Google 最终兜底：非流式，整体返回
            const googleResult = await callGoogleAPI(fb.model, prompt, systemInstruction);
            const text = extractGoogleText(googleResult);
            if (text) { onChunk(text); return; }
          } else {
            // Yunwu 兜底：流式
            await streamYunwuOpenAIOnce(
              fb.model, prompt, systemInstruction,
              temperature, maxTokens, onChunk,
              firstChunkMs, idleTimeoutMs, refUrls, refPreamble
            );
            return;
          }
        } catch (err2: any) {
          console.warn(`[Gemini Service] 备用模型 ${fb.model} 也失败: ${err2?.message || err2}`);
          lastError = err2;
        }
      }
      throw lastError || new Error("所有模型均失败，请稍后重试。");
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      if (errorMsg === STREAM_FIRST_CHUNK_STALL) {
        throw new Error(
          "模型在设定时间内未返回首段文本，请稍后重试或检查网络。"
        );
      }
      if (errorMsg === STREAM_IDLE_TIMEOUT) {
        throw new Error(
          "分镜生成超时（服务端长时间无输出），已截断当前进度。下方将自动续写剩余镜头。"
        );
      }
      if (errorMsg === GOOGLE_GENERATION_STALL) {
        throw new Error(
          "Google 模型在等待时间内无响应，请稍后重试。"
        );
      }
      if (errorMsg.includes('Failed to fetch') || errorMsg.includes('fetch')) {
        throw new Error(
          "網絡連接失敗。請檢查：1) 網絡連接 2) API Key 是否正確 3) Base URL 是否可訪問"
        );
      }
      throw error;
  }
};
