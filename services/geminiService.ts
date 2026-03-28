// Yunwu AI API Service - Using OpenAI compatible format
// Based on Python implementation: https://yunwu.ai/v1/chat/completions

const YUNWU_BASE_URL = "https://yunwu.ai";
const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_YUNWU_MODEL = "gemini-3.1-pro-preview";
const GOOGLE_PRIMARY_MODEL = "gemini-3.1-pro-preview";
const GOOGLE_FALLBACK_MODEL = "gemini-3-pro-preview-thinking";

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

async function retryOperation<T>(operation: () => Promise<T>, retries = 3, delay = 2000): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    const msg = (error.message || (error.error && error.error.message) || JSON.stringify(error)).toLowerCase();
    
    const isRetryable = 
      msg.includes('429') || 
      msg.includes('quota') ||
      msg.includes('500') || 
      msg.includes('503') || 
      msg.includes('xhr error') || 
      msg.includes('network') || 
      msg.includes('fetch failed') ||
      msg.includes('overloaded') ||
      msg.includes('failed to fetch') ||
      msg.includes('http2') ||
      msg.includes('protocol error') ||
      msg.includes('err_http2');

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

// OpenAI compatible API call
async function callYunwuAPI(
  prompt: string,
  systemInstruction: string,
  temperature: number = 0.85,
  maxTokens: number = 8192,
  stream: boolean = false
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
    max_tokens: maxTokens,
    stream: stream
  };

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(payload),
    timeout: 300000, // 5 minutes for long content
    // Fix HTTP2 protocol errors by disabling keepalive
    keepalive: false,
  } as any).catch((fetchError: any) => {
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

async function callGoogleAPI(
  modelName: string,
  prompt: string,
  systemInstruction: string,
  temperature: number = 0.85,
  maxTokens: number = 8192
): Promise<any> {
  if (!apiKey) {
    throw new Error("API Key 未設置。請在設置中輸入您的 API Key。");
  }

  const payload: Record<string, any> = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens
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
  preferredModel?: string
): Promise<any> {
  const primaryModel = preferredModel || model || GOOGLE_PRIMARY_MODEL;
  try {
    return await retryOperation(() => callGoogleAPI(primaryModel, prompt, systemInstruction, temperature, maxTokens));
  } catch (error) {
    if (primaryModel !== GOOGLE_FALLBACK_MODEL) {
      console.warn(`[Gemini Service] Google model failed, switching to fallback: ${GOOGLE_FALLBACK_MODEL}`);
      const fallbackResponse = await retryOperation(() => callGoogleAPI(GOOGLE_FALLBACK_MODEL, prompt, systemInstruction, temperature, maxTokens));
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

export const generateTopics = async (
  prompt: string, 
  systemInstruction: string,
  modelName?: string
): Promise<string[]> => {
  return retryOperation(async () => {
    try {
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

        // 去重并保留顺序
        const unique: string[] = [];
        const seen = new Set<string>();
        for (const t of lines) {
          if (!seen.has(t)) {
            seen.add(t);
            unique.push(t);
          }
        }
        return unique;
      };

      const requestOnce = async (inputPrompt: string): Promise<string> => {
        if (provider === 'google') {
          const response = await callGoogleWithFallback(inputPrompt, systemInstruction, 0.9, 4096, modelName);
          return extractGoogleText(response);
        }
        const response = await callYunwuAPI(inputPrompt, systemInstruction, 0.9, 4096, false);
        return response.choices?.[0]?.message?.content || "";
      };

      const firstContent = await requestOnce(prompt);
      if (!firstContent) {
        throw new Error("API 返回了空響應。請檢查 API Key 和配置。");
      }

      let topics = parseTopics(firstContent);

      // 兜底补齐：若不足10个，最多补齐3轮
      let fillRounds = 0;
      while (topics.length > 0 && topics.length < 10 && fillRounds < 3) {
        fillRounds += 1;
        const need = 10 - topics.length;
        const fillPrompt = `${prompt}\n\n【补齐要求】\n你上一次只返回了${topics.length}个选题。请只补齐剩余${need}个，不要重复，不要解释，不要前言，每行一个标题。\n已生成（禁止重复）：\n${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
        const extraContent = await requestOnce(fillPrompt);
        const extraTopics = parseTopics(extraContent).filter(t => !topics.includes(t));
        if (extraTopics.length === 0) break;
        topics = [...topics, ...extraTopics];
      }

      topics = topics.slice(0, 10);

      if (topics.length === 0) {
        throw new Error("API 返回了空響應。請檢查 API Key 和配置。");
      }
      
      return topics;
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      if (errorMsg.includes('Failed to fetch') || errorMsg.includes('fetch')) {
        throw new Error("網絡連接失敗。請檢查：1) 網絡連接 2) API Key 是否正確 3) Base URL 是否可訪問");
      }
      throw error;
    }
  });
};

export const streamContentGeneration = async (
  prompt: string,
  systemInstruction: string,
  onChunk: (chunk: string) => void,
  modelName?: string,
  options?: { temperature?: number; maxTokens?: number }
) => {
  return retryOperation(async () => {
    try {
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

      const temperature = options?.temperature ?? 0.85;
      const maxTokens = options?.maxTokens ?? 8192;

      if (provider === 'google') {
        const response = await callGoogleWithFallback(prompt, systemInstruction, temperature, maxTokens, modelName);
        const content = extractGoogleText(response);
        if (!content) {
          throw new Error("API 返回了空響應。請檢查 API Key 和配置。");
        }
        onChunk(content);
        return;
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      };

      const messages = [];
      if (systemInstruction) {
        messages.push({ role: "system", content: systemInstruction });
      }
      messages.push({ role: "user", content: prompt });

      const payload = {
        model: modelName || model,
        messages: messages,
        temperature: temperature,
        max_tokens: maxTokens,
        stream: true
      };

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload),
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

      // Read stream
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error("無法讀取響應流");
      }

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            
            try {
              const json = JSON.parse(data);
              const content = json.choices?.[0]?.delta?.content || '';
              if (content) {
                onChunk(content);
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      }
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      if (errorMsg.includes('Failed to fetch') || errorMsg.includes('fetch')) {
        throw new Error("網絡連接失敗。請檢查：1) 網絡連接 2) API Key 是否正確 3) Base URL 是否可訪問");
      }
      throw error;
    }
  });
};
