// Yunwu AI API Service - Using OpenAI compatible format
// Based on Python implementation: https://yunwu.ai/v1/chat/completions

const YUNWU_BASE_URL = "https://yunwu.ai";
const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_YUNWU_MODEL = "gpt-5.4-mini";
const GOOGLE_PRIMARY_MODEL = "gpt-5.4-mini";
const GOOGLE_FALLBACK_MODEL = "gemini-3.1-pro-preview";

/** 流式输出在首段文本出现前的最长等待；超时后 Yunwu 会改用备用模型重试一次 */
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = 120_000;
/** Yunwu OpenAI 兼容通道上的备用模型（主模型排队/首包过慢时使用） */
export const STREAM_FALLBACK_MODEL_OPENAI = "gpt-5.4-mini";

const STREAM_FIRST_CHUNK_STALL = "STREAM_FIRST_CHUNK_STALL";
const GOOGLE_GENERATION_STALL = "GOOGLE_GENERATION_STALL";
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
};

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
          model = GOOGLE_PRIMARY_MODEL;
        } else {
          baseUrl = YUNWU_BASE_URL;
          model = DEFAULT_YUNWU_MODEL;
        }
        baseUrl = baseUrl.replace(/\/$/, "");
      }
    }
    
    if (!apiKey) {
      throw new Error("API Key 未設置。請在設置中輸入您的 API Key。");
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
    const lines = raw
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line
        .replace(/^\d+[\.、]\s*/, '')
        .replace(/^[-*•]\s*/, '')
        .replace(/["']/g, '')
        .trim()
      )
      .filter(line => line.length > 8);
  };

    // 去重并保留顺序（当次内去重）
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const t of lines) {
      if (!seen.has(t)) {
        seen.add(t);
        unique.push(t);
      }
    }
    return unique;

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
    return isQuotaError(err) || isTimeoutError(err);
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
      const shouldFallback = shouldSwitchToFallback(primaryErr);
      console.warn(`[Gemini Service] Primary Yunwu model failed (${primary}): ${primaryErr?.message || primaryErr}, should switch: ${shouldFallback}`);
      if (shouldFallback) {
        console.warn(`[Gemini Service] Detected ${isQuotaError(primaryErr) ? 'quota' : 'timeout'} error, switching to fallback: ${fallback}`);
      }
    }

    // 备用模型：gpt-5.4-mini
    const prevModel = model;
    model = fallback;
    console.warn(`[Gemini Service] Trying fallback model: ${fallback}`);
    try {
      const response = await retryOperation(
        () => callYunwuAPI(inputPrompt, systemInstruction, 0.9, 4096, false, 45000),
        2, 3000
      );
      const content = response.choices?.[0]?.message?.content || "";
      if (content.trim()) {
        console.warn(`[Gemini Service] Fallback model success!`);
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
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: ac.signal,
        keepalive: false,
      } as RequestInit);
    } catch (fetchError: any) {
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
      let errorMsg = `HTTP ${response.status}: ${errorText}`;
      if (response.status === 401 || response.status === 403) {
        errorMsg = "API Key 無效或未授權。請檢查您的 API Key。";
      } else if (response.status === 429) {
        errorMsg = "API 配額已用完，請稍後再試。";
      }
      throw new Error(errorMsg);
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    if (!reader) {
      throw new Error("無法讀取響應流");
    }

    let buffer = "";
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
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const json = JSON.parse(data);
              const piece =
                json.choices?.[0]?.delta?.content ||
                json.choices?.[0]?.message?.content ||
                "";
              if (piece) {
                if (!gotFirstChunk) {
                  gotFirstChunk = true;
                  clearStall();
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
    }

    if (!gotFirstChunk) {
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
  return retryOperation(async () => {
    try {
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
              model = GOOGLE_PRIMARY_MODEL;
            } else {
              baseUrl = YUNWU_BASE_URL;
              model = DEFAULT_YUNWU_MODEL;
            }
            baseUrl = baseUrl.replace(/\/$/, "");
          }
        }

        if (!apiKey) {
          throw new Error("API Key 未設置。請在設置中輸入您的 API Key。");
        }
      }

      const temperature = options?.temperature ?? 0.7;
      const maxTokens = options?.maxTokens ?? 8192;
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

      const primaryModel = modelName || model;

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

      try {
        // 主模型：一次尝试，失败立即切备用（不再重试同一模型浪费时间）
        await streamWithRetry(primaryModel, firstChunkMs);
      } catch (err: any) {
        // "无可用渠道"错误立即切备用模型，不重试
        if (isChannelUnavailable(err)) {
          console.warn(
            `[Gemini Service] Yunwu 主模型无可用渠道 (${primaryModel})，立即切换备用模型: ${fallbackOpenAI}`
          );
          await wait(2000);
          try {
            await streamWithRetry(
              fallbackOpenAI,
              firstChunkMs,
              `${systemInstruction}${FALLBACK_STREAM_FORMAT_HINT}`
            );
          } catch (err2: any) {
            throw new Error(
              `主模型无可用渠道，备用模型也失败。\n主模型错误: ${err?.message || err}\n备用模型错误: ${err2?.message || err2}`
            );
          }
        } else if (
          isRetryableForFallback(err) &&
          fallbackOpenAI &&
          primaryModel !== fallbackOpenAI
        ) {
          console.warn(
            `[Gemini Service] Yunwu 主模型失败 (${primaryModel})，错误: ${err?.message || err}，切换备用模型: ${fallbackOpenAI}`
          );
          await wait(3000);
          try {
            await streamWithRetry(
              fallbackOpenAI,
              firstChunkMs,
              `${systemInstruction}${FALLBACK_STREAM_FORMAT_HINT}`
            );
          } catch (err2: any) {
            throw new Error(
              `主模型与备用模型均失败。请稍后重试或检查网络与 API。\n主模型错误: ${err?.message || err}\n备用模型错误: ${err2?.message || err2}`
            );
          }
        } else {
          throw err;
        }
      }
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
  });
};
