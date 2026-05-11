/**
 * Yunwu.ai API 服务
 * 用于生成图片和视频
 */

export interface ImageGenerationOptions {
  model: string;
  prompt: string;
  size?: string;
  quality?: string;
  n?: number;
  /** 参考图：支持 data URL、blob:、http(s):（发请求前会规范为 data URL，供 Gemini inline / OpenAI vision） */
  referenceDataUrls?: string[];
  /** 有参考图时，多模态首条说明（Gemini generateContent）；不传则用封面缩略图专用英文锚定文案 */
  referenceMultimodalPreamble?: string;
  /** 有参考图时，角色名称（用于增强 chat/vision 端 IDENTITY LOCK 提示词） */
  characterName?: string;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('读取图片数据失败'));
    r.readAsDataURL(blob);
  });
}

/** 将各类图片地址转为 data URL，供 Gemini inlineData / chat vision 使用 */
/** Grok vision 参考图过大易超时/失败：限制长边像素（仅浏览器环境生效） */
async function downscaleDataUrlMaxSide(dataUrl: string, maxSide: number): Promise<string> {
  if (!/^data:image\//i.test(dataUrl) || typeof Image === 'undefined') return dataUrl;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h || (w <= maxSide && h <= maxSide)) {
          resolve(dataUrl);
          return;
        }
        const scale = maxSide / Math.max(w, h);
        const nw = Math.max(1, Math.round(w * scale));
        const nh = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = nw;
        canvas.height = nh;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, nw, nh);
        const mime = /^data:image\/png/i.test(dataUrl) ? 'image/png' : 'image/jpeg';
        resolve(
          mime === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.88)
        );
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function downscaleReferenceDataUrlsForVision(urls: string[], maxSide: number): Promise<string[]> {
  return Promise.all(urls.map((u) => downscaleDataUrlMaxSide(u, maxSide)));
}

function parseGrokChatImageResults(data: any): string[] {
  const imageUrls: string[] = [];
  if (Array.isArray(data.data)) {
    for (const item of data.data) {
      if (typeof item === 'string') {
        imageUrls.push(item);
        continue;
      }
      if (item?.url) imageUrls.push(String(item.url));
      else if (item?.b64_json) {
        const b = String(item.b64_json);
        imageUrls.push(b.startsWith('data:') ? b : `data:image/png;base64,${b}`);
      }
    }
  }
  for (const choice of data.choices ?? []) {
    const content = choice?.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const u = part?.image_url?.url || part?.url;
        if (typeof u === 'string' && (u.startsWith('http') || u.startsWith('data:image'))) {
          imageUrls.push(u);
        }
      }
      continue;
    }
    const str = typeof content === 'string' ? content : '';
    for (const m of str.matchAll(/!\[.*?\]\((https?:\/\/[^\s\)]+)\)/g)) {
      imageUrls.push(m[1]);
    }
    for (const m of str.matchAll(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi)) {
      imageUrls.push(m[0]);
    }
    if (!imageUrls.length) {
      for (const u of str.match(/https?:\/\/[^\s\)"'<>]+/g) ?? []) {
        const t = u.replace(/[),;<>]+$/, '');
        if (
          /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(t) ||
          /\/grok\/|\.r2\.dev\/|\/cdn\./i.test(t) ||
          /i\.imgur\.com/i.test(t)
        ) {
          imageUrls.push(t);
        }
      }
    }
  }
  const rp = data.revised_prompt;
  if (typeof rp === 'string') {
    imageUrls.push(...(rp.match(/https?:\/\/[^\s\)"'<>]+/g) ?? []));
  }
  const flat = imageUrls
    .map((u) => String(u).trim().replace(/[),;<>]+$/, ''))
    .filter((u) => u.startsWith('http') || u.startsWith('data:image'));
  return [...new Set(flat)];
}

/**
 * OpenAI images/generations（及兼容）单条结果：url 或 b64_json → 可展示、可写入本地历史的地址。
 * 纯 base64 无 data: 前缀时补全为 PNG data URL，否则会被历史持久化层丢弃。
 */
export function openAiImageDataItemToUrl(item: unknown): string | undefined {
  if (item == null) return undefined;
  if (typeof item === 'string') {
    const s = item.trim();
    if (!s) return undefined;
    if (/^(https?:|data:|blob:)/i.test(s)) return s;
    const compact = s.replace(/\s/g, '');
    if (/^[A-Za-z0-9+/=_-]+$/.test(compact) && compact.length >= 80) {
      return `data:image/png;base64,${compact}`;
    }
    return undefined;
  }
  if (typeof item === 'object') {
    const o = item as { url?: string; b64_json?: string };
    if (typeof o.url === 'string' && o.url.trim()) return o.url.trim();
    if (o.b64_json != null && String(o.b64_json).trim()) {
      const b = String(o.b64_json).trim().replace(/\s/g, '');
      if (b.startsWith('data:')) return b;
      return `data:image/png;base64,${b}`;
    }
  }
  return undefined;
}

/** 提交 TTS 前口播润色（与项目内其它 Yunwu 轻量任务一致） */
export const YUNWU_TTS_POLISH_MODEL = 'gpt-5.4-mini';

function stripLeadingTrailingCodeFence(s: string): string {
  let t = s.trim();
  const m = t.match(/^```(?:\w+)?\s*\n?([\s\S]*?)```\s*$/);
  if (m) t = m[1].trim();
  return t;
}

const TTS_POLISH_BASE_SYSTEM = `You are a professional dubbing script editor for neural TTS.
Optimize the user's lines for natural, fluent speech: improve punctuation and phrase breaks for breathing, remove timestamps/meta noise, keep emotional tone and facts intact.
Rules:
- Output ONLY the final text to be spoken. Preserve the exact same language as the input.
- Do NOT translate. Do NOT convert English to Chinese or vice versa. The input language must match the output language.
- Do NOT add role names, shot labels, markdown, or quotes wrapping the entire output.
- Keep the content complete; do not summarize away substantive lines.
- Input is expected to stay within about 5000 characters; keep the output in the same ballpark—no gratuitous lengthening or filler.`;

/** 简单检测文本是否以中文字符为主（混合文本时以多数判断） */
function detectLanguage(text: string): 'zh' | 'en' | 'mixed' {
  const cleaned = text.replace(/\s+/g, '');
  if (!cleaned) return 'mixed';
  const chineseCount = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const total = cleaned.length;
  const zhRatio = chineseCount / total;
  if (zhRatio > 0.5) return 'zh';
  if (zhRatio < 0.1) return 'en';
  return 'mixed';
}

/** 构建带语言检测的 TTS 润色 system prompt */
function buildTtsPolishSystem(text: string): string {
  const lang = detectLanguage(text);
  const langLabel = lang === 'zh' ? '中文（Chinese）' : lang === 'en' ? '英文（English）' : '原文本（保留输入语言）';
  return `${TTS_POLISH_BASE_SYSTEM}
- IMPORTANT: The input text is in ${langLabel}. You MUST output in the SAME language. NEVER translate.`;
}

async function runTtsPolishChat(
  apiKey: string,
  system: string,
  user: string,
  fallback: string
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 55_000);
  try {
    const res = await fetch('https://yunwu.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: YUNWU_TTS_POLISH_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.35,
        max_tokens: 4096,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(errText.slice(0, 200) || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) return fallback;
    const out = stripLeadingTrailingCodeFence(content).trim();
    return out.length >= 2 ? out : fallback;
  } catch (e) {
    console.warn('[YunwuService] TTS polish request failed, using raw text:', e);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用大模型将口播稿优化为更适合 TTS 的断句与节奏（自然停顿、去时间戳/赘词，保持原意与语种）。
 * 失败或未配置 key 时返回原文，不抛错。
 */
export async function polishTextForTtsSpeech(apiKey: string, rawText: string): Promise<string> {
  const text = rawText.trim();
  if (!text || !apiKey?.trim()) return text;
  if (text.length < 8) return text;

  const user = `以下是一段需要配音朗读的口播正文，请只做「导演级切行与朗读友好化」优化后输出：\n\n${text}`;
  return runTtsPolishChat(apiKey, buildTtsPolishSystem(text), user, text);
}

/**
 * 在默认口播润色规则上叠加「赛道人设」与/或用户自定义说明（仍用 gpt-5.4-mini）。
 * 二者皆空时等价于 {@link polishTextForTtsSpeech}。
 */
export async function polishTextForTtsSpeechWithStyle(
  apiKey: string,
  rawText: string,
  opts?: { trackPersona?: string; customHint?: string }
): Promise<string> {
  const text = rawText.trim();
  if (!text || !apiKey?.trim()) return text;
  if (text.length < 8) return text;

  const persona = opts?.trackPersona?.trim();
  const hint = opts?.customHint?.trim();
  if (!persona && !hint) {
    return polishTextForTtsSpeech(apiKey, rawText);
  }

  const styleBlock = persona
    ? `\n\n【演绎风格 / 人设】\n${persona}\n请在此风格下做断句与语气调整，使口播更贴人设，但不歪曲事实、不删减关键信息。`
    : '';
  const system = buildTtsPolishSystem(text) + styleBlock;

  let user = `以下是一段需要配音朗读的口播正文，请只做「导演级切行与朗读友好化」优化后输出：\n\n${text}`;
  if (hint) {
    user += `\n\n【用户额外说明】\n${hint}`;
  }
  return runTtsPolishChat(apiKey, system, user, text);
}

export async function normalizeReferenceDataUrls(urls: string[]): Promise<string[]> {
  const proxyUrl = (typeof process !== 'undefined' && process.env?.IMAGE_PROXY_URL) || '';
  const out: string[] = [];
  for (const u of urls) {
    const raw = u?.trim();
    if (!raw) continue;
    if (raw.startsWith('data:')) {
      out.push(raw);
      continue;
    }
    try {
      // 生产环境：优先使用配置的代理 URL（绕过 CORS）；开发环境使用 /__image_proxy
      const fetchUrl = proxyUrl
        ? `${proxyUrl.replace(/\/$/, '')}?url=${encodeURIComponent(raw)}`
        : `/__image_proxy?url=${encodeURIComponent(raw)}`;
      const res = await fetch(fetchUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      out.push(await blobToDataUrl(blob));
    } catch (e) {
      console.error('[YunwuService] 参考图加载失败:', raw.slice(0, 96), e);
      throw new Error('无法加载参考图，请使用本地上传或确保图片链接可访问（含 blob / 跨域）');
    }
  }
  return out;
}

/** 封面设计 Tab：主模型失败时自动切换备用 */
export const COVER_GEMINI_IMAGE_MODEL = 'cover-gemini-flash' as const;
const COVER_GEMINI_PRIMARY = 'gemini-3.1-flash-image-preview';
const COVER_GEMINI_FALLBACK = 'gemini-2.5-flash-image-preview';

const DEFAULT_GEMINI_REF_PREAMBLE_THUMBNAIL = `You will generate ONE YouTube thumbnail with the aspect ratio stated in the composition brief below. Below this message come REF_COUNT_PLACEHOLDER reference image(s) IN ORDER: Image 1, Image 2, ...

IDENTITY LOCK (highest priority — overrides any generic wording in the brief):
- Reproduce the SAME human as in the references: hair length/shape, face silhouette, clothing, proportions. Do NOT substitute a random man/woman or "faceless" placeholder if the ref shows a specific character design.
- If the references show a pet or other animal, reproduce the same species, markings, and silhouette. If the references show NO animal, do NOT add a dog, cat, or pet — keep only what appears in the refs plus the composition brief.
- Keep the same illustration / photo language as the references (line weight, color blocks, or photographic look).

After the reference image parts, a COMPOSITION BRIEF follows — follow it for layout, text, arrows, and mood, but NEVER break the identity lock above.`;

/** Gemini 原生图模的多角色 preamble（封面设计使用） */
function buildGeminiNativeMultiCharacterPreamble(referenceDataUrls: string[], characterName?: string): string {
  const n = referenceDataUrls.length;
  const chars = characterName?.split(',').map(c => c.trim()).filter(Boolean) || [];

  if (chars.length === 0) {
    return DEFAULT_GEMINI_REF_PREAMBLE_THUMBNAIL.replace(/REF_COUNT_PLACEHOLDER/g, String(n));
  }

  const identityBlocks = chars.map((char, idx) => {
    const refNum = idx + 1;
    return `- Image ${refNum}: Reproduce the character "${char}" with exact appearance matching reference image ${refNum}. For humans: face shape, skin tone, hair style/color, clothing, accessories, and body proportions. For animals: species, breed, markings, and silhouette.`;
  }).join('\n');

  return `You will generate ONE image with the aspect ratio stated in the composition brief below. Below this message come ${n} reference image(s) IN ORDER: Image 1, Image 2, ... Image ${n}.

IDENTITY LOCK (highest priority — overrides any generic wording in the brief):
${identityBlocks}
- Keep the same illustration / photo language as the references (line weight, color blocks, or photographic look).

After the reference image parts, a COMPOSITION BRIEF follows — follow it for layout, text, arrows, and mood, but NEVER break the identity lock above.`;
}

function buildGeminiNativeImageParts(
  prompt: string,
  referenceDataUrls?: string[],
  multimodalPreamble?: string,
  characterName?: string
): { parts: Record<string, unknown>[] } {
  const parts: Record<string, unknown>[] = [];
  if (referenceDataUrls?.length) {
    const n = referenceDataUrls.length;
    // 优先使用传入的 preamble，否则使用多角色 preamble
    const preambleText = multimodalPreamble?.trim()
      || buildGeminiNativeMultiCharacterPreamble(referenceDataUrls, characterName);
    parts.push({
      text: preambleText,
    });
    for (const url of referenceDataUrls) {
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
      }
    }
    parts.push({
      text: `GENERATION BRIEF:\n${prompt}`,
    });
    return { parts };
  }
  parts.push({ text: prompt });
  return { parts };
}

/** OpenAI 兼容 chat：有参考图时用 vision 多段 content */
function buildOpenAiVisionUserContent(
  text: string,
  referenceDataUrls?: string[],
  characterName?: string
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (!referenceDataUrls?.length) return text;

  console.log('[YunwuService] buildOpenAiVisionUserContent:', {
    text: text.slice(0, 100),
    refCount: referenceDataUrls.length,
    characterName,
    firstRefUrl: referenceDataUrls[0]?.slice(0, 50)
  });

  // 支持多角色分别生成身份锁定说明
  let preamble: string;
  const chars = characterName?.split(',').map(c => c.trim()).filter(Boolean) || [];

  if (chars.length > 0) {
    // 多角色：分别为每个角色生成身份锁定说明
    const identityBlocks = chars.map((char, idx) => {
      const refNum = idx + 1;
      return `- Image ${refNum} (${char}): You MUST reproduce this character's exact appearance — face shape, skin tone, hair style/color, clothing, accessories, and body proportions (for humans) or species, breed, markings, and silhouette (for animals). Do NOT substitute a generic or different person/breed. Keep the same medium as shown in the reference.`;
    }).join('\n');

    preamble = `CRITICAL: The following ${chars.length} character(s) appear in the attached reference image(s) IN ORDER:
- Image 1 is "${chars[0]}" (${referenceDataUrls[0] ? 'provided' : 'missing'})
${chars.length > 1 ? `- Image 2 is "${chars[1]}" (${referenceDataUrls[1] ? 'provided' : 'missing'})` : ''}
${chars.length > 2 ? `- Image 3 is "${chars[2]}" (${referenceDataUrls[2] ? 'provided' : 'missing'})` : ''}

IDENTITY LOCK (highest priority — overrides any generic wording in the brief):
${identityBlocks}

IMPORTANT: You MUST include ALL ${chars.length} character(s) in the generated image. Each character's appearance must exactly match their reference image.

Image generation instructions:
${text}`;
  } else {
    preamble = `Reference image(s) are attached in order. Preserve identity: for people match face shape, hair, and clothing; for animals match species, coat pattern, and body proportions; keep the same art medium (photo vs illustration) unless the instructions clearly require otherwise.

Image generation instructions:
${text}`;
  }

  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: 'text', text: preamble },
  ];
  for (const url of referenceDataUrls) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

/** Gemini 原生图模：比例须在 imageConfig.aspectRatio，且需 responseModalities（顶层 aspectRatio 无效） */
function buildGeminiImageGenerationConfig(
  options: Pick<ImageGenerationOptions, 'size' | 'quality'>
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    responseModalities: ['TEXT', 'IMAGE'],
  };
  const imageConfig: Record<string, unknown> = {};
  if (options.size) {
    const [width, height] = options.size.split('x').map(Number);
    if (width && height) {
      const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
      const divisor = gcd(width, height);
      imageConfig.aspectRatio = `${width / divisor}:${height / divisor}`;
    }
  }
  if (options.quality === 'high') {
    imageConfig.imageSize = '2K';
  } else if (options.quality && /^[124]K$/i.test(String(options.quality).replace(/\s/g, ''))) {
    imageConfig.imageSize = String(options.quality).toUpperCase().replace(/\s/g, '');
  }
  if (Object.keys(imageConfig).length > 0) {
    generationConfig.imageConfig = imageConfig;
  }
  return generationConfig;
}

function extractUrlsFromGeminiImageResponse(data: any): string[] {
  const imageUrls: string[] = [];
  if (data.candidates && Array.isArray(data.candidates)) {
    for (const candidate of data.candidates) {
      if (candidate.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.inlineData?.data) {
            const base64Data = part.inlineData.data;
            const mimeType = part.inlineData.mimeType || 'image/png';
            imageUrls.push(`data:${mimeType};base64,${base64Data}`);
          }
          if (part.url) {
            imageUrls.push(part.url);
          }
        }
      }
    }
  }
  if (imageUrls.length === 0) {
    if (data.data && Array.isArray(data.data)) {
      imageUrls.push(...data.data.map((item: any) => item.url || item).filter(Boolean));
    } else if (data.url) {
      imageUrls.push(data.url);
    }
  }
  return imageUrls;
}

async function yunwuGeminiNativeImageOnce(
  apiKey: string,
  baseUrl: string,
  geminiModelId: string,
  options: ImageGenerationOptions
): Promise<GenerationResult> {
  const { parts } = buildGeminiNativeImageParts(
    options.prompt,
    options.referenceDataUrls,
    options.referenceMultimodalPreamble,
    options.characterName
  );
  const endpoint = `/v1beta/models/${geminiModelId}:generateContent`;
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig: buildGeminiImageGenerationConfig(options),
  };
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
    const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
    throw new Error(errorMessage);
  }
  const data = await response.json();
  const imageUrls = extractUrlsFromGeminiImageResponse(data);
  if (imageUrls.length === 0) {
    console.error('[YunwuService] Gemini 图片响应无可用图:', geminiModelId, data);
    throw new Error('无法从响应中提取图片，请检查响应格式');
  }
  return {
    success: true,
    data: {
      ...data,
      data: imageUrls.map((url) => ({ url })),
    },
    url: imageUrls[0],
  };
}

export interface VideoGenerationOptions {
  model: string; // Sora 模型：'sora-2' 或 'sora-2-pro'
  prompt: string; // 视频提示词
  duration?: number; // 视频时长（秒）：10, 15, 或 25
  size?: string; // 视频分辨率："small" (720p) 或 "large" (1080p)
  orientation?: string; // 视频方向："landscape"（横屏）或 "portrait"（竖屏）
  images?: string[]; // 图片链接数组（如果有图片，则为图生视频；如果没有，则为文生视频）
  watermark?: boolean; // 是否添加水印（默认为 true）
  private?: boolean; // 是否隐藏视频（可选）
}

export interface GenerationResult {
  success: boolean;
  data?: any;
  error?: string;
  url?: string;
  taskId?: string;
}

/**
 * 将比例ID转换为【比例】格式（用于sora-image）
 */
const convertRatioToSoraFormat = (ratioId: string): string => {
  // 将比例ID转换为【比例】格式，例如 '1:1' -> '【1:1】', '16:9' -> '【16:9】'
  const ratioMap: Record<string, string> = {
    '1:1': '【1:1】',
    '16:9': '【16:9】',
    '9:16': '【9:16】',
    '4:3': '【4:3】',
    '3:4': '【3:4】',
    '2:3': '【2:3】',
    '3:2': '【3:2】',
    'dall-e-3-portrait': '【9:16】', // 1024x1792 接近 9:16
    'dall-e-3-landscape': '【16:9】', // 1792x1024 接近 16:9
  };
  return ratioMap[ratioId] || '【1:1】';
};

/**
 * 生成图片
 */
export const generateImage = async (
  apiKey: string,
  options: ImageGenerationOptions
): Promise<GenerationResult> => {
  try {
    const baseUrl = 'https://yunwu.ai';

    // 调试日志：打印传入的参考图信息
    console.log('[YunwuService] generateImage 调用参数:', {
      model: options.model,
      prompt: options.prompt?.slice(0, 100),
      referenceDataUrlsCount: options.referenceDataUrls?.length,
      referenceDataUrls: options.referenceDataUrls?.map((u, i) => `${i}: ${u.slice(0, 50)}...`),
      characterName: options.characterName,
    });

    const opts: ImageGenerationOptions = {
      ...options,
      referenceDataUrls:
        options.referenceDataUrls?.length && options.referenceDataUrls.length > 0
          ? await normalizeReferenceDataUrls(options.referenceDataUrls)
          : options.referenceDataUrls,
    };

    console.log('[YunwuService] normalizeReferenceDataUrls 后:', {
      referenceDataUrlsCount: opts.referenceDataUrls?.length,
      referenceDataUrls: opts.referenceDataUrls?.map((u, i) => `${i}: ${u.slice(0, 50)}...`),
    });

    if (
      (opts.model === 'grok-3-image' || opts.model === 'grok-4-image' || opts.model === 'grok-imagine') &&
      opts.referenceDataUrls?.length
    ) {
      opts.referenceDataUrls = await downscaleReferenceDataUrlsForVision(opts.referenceDataUrls, 1024);
    }

    // sora_image 使用 chat/completions 端点
    // 注意：模型名称是 sora_image（下划线），不是 sora-image
    if (opts.model === 'sora-image' || opts.model === 'sora_image') {
      // 构建提示词：原提示词 + 【比例】
      // sora_image 只支持三种比例：1:1, 2:3, 3:2
      let finalPrompt = opts.prompt;

      // 从 size 中提取比例（格式：widthxheight）
      let ratio = '1:1'; // 默认比例
      if (opts.size) {
        const [width, height] = opts.size.split('x').map(Number);
        if (width && height) {
          // 计算最简比例
          const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
          const divisor = gcd(width, height);
          const calculatedRatio = `${width / divisor}:${height / divisor}`;
          
          // 只支持 1:1, 2:3, 3:2，如果不匹配则使用最接近的
          if (calculatedRatio === '1:1' || calculatedRatio === '2:3' || calculatedRatio === '3:2') {
            ratio = calculatedRatio;
          } else {
            // 根据宽高比选择最接近的支持比例
            const aspectRatio = width / height;
            if (Math.abs(aspectRatio - 1) < 0.1) {
              ratio = '1:1';
            } else if (aspectRatio < 1) {
              ratio = '2:3'; // 竖屏
            } else {
              ratio = '3:2'; // 横屏
            }
          }
        }
      }
      
      // 在提示词末尾添加比例标记
      finalPrompt = `${finalPrompt}【${ratio}】`;
      
      // 使用 chat/completions 端点，模型名称使用 sora_image（下划线）
      const endpoint = '/v1/chat/completions';
      const body = {
        model: 'sora_image', // 使用下划线
        messages: [
          {
            role: 'user',
            content: buildOpenAiVisionUserContent(finalPrompt, opts.referenceDataUrls, opts.characterName),
          },
        ],
        temperature: 0.7,
      };
      
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
        const errorMessage = errorData.error?.message || errorData.message || `HTTP ${response.status}: ${response.statusText}`;
        
        // 检查是否是"模型不可用"的错误
        if (errorMessage.includes('No available channels') || errorMessage.includes('not available')) {
          throw new Error(`模型 "${opts.model}" 在当前账户中不可用。\n\n可能原因：\n1. 该模型需要特殊权限或白名单\n2. 该模型暂未在您的账户中启用\n3. 当前账户余额不足或配额已用完\n\n建议：\n- 联系 yunwu.ai 客服确认模型可用性和账户权限\n- 或尝试使用其他视频生成模型`);
        }

        throw new Error(errorMessage);
      }

      const data = await response.json();

      // 解析 chat/completions 响应格式
      // sora_image 返回的是 Markdown 格式的图片链接：![图片](url)
      let imageUrls: string[] = [];

      if (data.choices && Array.isArray(data.choices)) {
        for (const choice of data.choices) {
          if (choice.message?.content) {
            const content = choice.message.content;

            // 提取 Markdown 格式的图片链接：![图片](url) 或 ![alt](url)
            const markdownImagePattern = /!\[.*?\]\((https?:\/\/[^\s\)]+)\)/g;
            let match;
            while ((match = markdownImagePattern.exec(content)) !== null) {
              if (match[1]) {
                imageUrls.push(match[1]);
              }
            }
            
            // 如果没有找到 Markdown 格式，尝试直接提取 URL
            if (imageUrls.length === 0) {
              const urlPattern = /https?:\/\/[^\s\)"']+\.(jpg|jpeg|png|gif|webp)/gi;
              const matches = content.match(urlPattern);
              if (matches) {
                imageUrls.push(...matches);
              }
            }
          }
        }
      }
      
      // 如果从 choices 中提取到了图片，返回
      if (imageUrls.length > 0) {
        // 去重
        imageUrls = [...new Set(imageUrls)];
        return {
          success: true,
          data: {
            ...data,
            data: imageUrls.map(url => ({ url }))
          },
          url: imageUrls[0],
        };
      }
      
      // 如果没找到，尝试从 data 的其他字段提取
      if (data.data && Array.isArray(data.data)) {
        imageUrls = data.data.map((item: any) => item.url || item).filter(Boolean);
      } else if (data.url) {
        imageUrls = [data.url];
      } else if (data.image_url) {
        imageUrls = [data.image_url];
      } else if (data.images && Array.isArray(data.images)) {
        imageUrls = data.images.map((img: any) => img.url || img).filter(Boolean);
      }
      
      if (imageUrls.length > 0) {
        return {
          success: true,
          data: {
            ...data,
            data: imageUrls.map(url => ({ url }))
          },
          url: imageUrls[0],
        };
      }
      
      // 如果还是没找到，返回错误
      console.error('[YunwuService] sora_image 响应数据:', data);
      throw new Error('无法从响应中提取图片URL，请检查响应格式');
    }

    // 封面设计：Gemini Flash 图模，三级备用链：gemini-3.1-flash → gpt-image-2-all → grok-imagine-image-pro
    if (opts.model === COVER_GEMINI_IMAGE_MODEL) {
      try {
        return await yunwuGeminiNativeImageOnce(apiKey, baseUrl, COVER_GEMINI_PRIMARY, opts);
      } catch (primaryErr: any) {
        console.warn('[YunwuService] 封面生图 Gemini 主模型失败，切换 gpt-image-2-all:', primaryErr?.message);
        try {
          return await yunwuOpenAiImageOnce(apiKey, baseUrl, 'gpt-image-2-all', opts);
        } catch (gptErr: any) {
          console.warn('[YunwuService] 封面生图 gpt-image-2-all 失败，切换 grok-imagine-image-pro:', gptErr?.message);
          return await yunwuGrokImageOnce(apiKey, baseUrl, 'grok-imagine-image-pro', opts);
        }
      }
    }

    // banana / banana-2：云雾 Gemini 原生 generateContent，支持 inlineData 参考图（文档示例：图生图 / 多图）
    if (opts.model === 'banana' || opts.model === 'banana-2') {
      const modelName =
        opts.model === 'banana' ? 'gemini-2.5-flash-image' : 'gemini-3-pro-image-preview';
      return await yunwuGeminiNativeImageOnce(apiKey, baseUrl, modelName, opts);
    }

    // grok-3-image / grok-4-image / grok-imagine：均走 chat/completions + vision 多段 content（云雾 images/generations 无参考图参数）
    if (opts.model === 'grok-3-image' || opts.model === 'grok-4-image' || opts.model === 'grok-imagine') {
      const modelName = opts.model === 'grok-imagine' ? 'grok-imagine-image-pro' : opts.model;
      let finalPrompt = opts.prompt;
      if (opts.size) {
        const [w, h] = opts.size.split('x').map(Number);
        if (w && h) {
          const g = (a: number, b: number) => (b === 0 ? a : g(b, a % b));
          const d = g(w, h);
          finalPrompt = `${finalPrompt}【${w / d}:${h / d}】`;
        }
      }
      const endpoint = '/v1/chat/completions';
      const body = {
        model: modelName,
        messages: [
          {
            role: 'user',
            content: buildOpenAiVisionUserContent(finalPrompt, opts.referenceDataUrls, opts.characterName),
          },
        ],
        temperature: 0.7,
        max_tokens: 4096,
      };
      const grokAttempts = 3;
      const grokRetryDelayMs = 2800;
      let lastGrokErr: Error | null = null;
      for (let attempt = 0; attempt < grokAttempts; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, grokRetryDelayMs));
        }
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 120_000);
          const response = await fetch(`${baseUrl}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!response.ok) {
            const err = await response.json().catch(() => ({ error: { message: response.statusText } }));
            throw new Error(err.error?.message || err.message || `HTTP ${response.status}`);
          }
          const data = await response.json();
          console.log(`[YunwuService] ${opts.model} 响应:`, JSON.stringify(data).slice(0, 2000));
          const clean = parseGrokChatImageResults(data);
          if (clean.length > 0) {
            const first = clean[0];
            return {
              success: true,
              data: clean.map((url) => ({ url })),
              url: first.startsWith('data:') ? first : first,
            };
          }
          lastGrokErr = new Error('无法从响应中提取图片URL');
          console.warn(`[YunwuService] ${opts.model} 第 ${attempt + 1} 次未解析到图片`);
        } catch (e: any) {
          lastGrokErr = e instanceof Error ? e : new Error(String(e?.message || e));
          console.warn(`[YunwuService] ${opts.model} 第 ${attempt + 1} 次请求失败:`, lastGrokErr.message);
        }
      }
      console.error(`[YunwuService] ${opts.model} 多次尝试后仍失败`, lastGrokErr);
      throw lastGrokErr || new Error('Grok 生图失败');
    }

    // gpt-image-2-all：走 images/generations 端点，主模型失败则切换备用
    if (opts.model === 'gpt-image-2-all') {
      const gptImagePrimary = 'gpt-image-2-all';
      const gptImageFallback = 'dall-e-3';
      try {
        return await yunwuOpenAiImageOnce(apiKey, baseUrl, gptImagePrimary, opts);
      } catch (primaryErr: any) {
        console.warn(
          '[YunwuService] gpt-image-2-all 主模型失败，切换备用:',
          gptImagePrimary,
          primaryErr?.message
        );
        return await yunwuOpenAiImageOnce(apiKey, baseUrl, gptImageFallback, opts);
      }
    }

async function yunwuOpenAiImageOnce(
  apiKey: string,
  baseUrl: string,
  modelId: string,
  options: ImageGenerationOptions
): Promise<GenerationResult> {
  const endpoint = '/v1/images/generations';
  const body: Record<string, unknown> = {
    model: modelId,
    prompt: options.prompt,
  };
  if (options.size) body.size = options.size;
  if (options.quality) body.quality = options.quality;
  if (options.n) body.n = options.n;

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
    const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
    throw new Error(errorMessage);
  }

  const data = await response.json();
  const first = data.data?.[0];
  const normalizedUrl =
    openAiImageDataItemToUrl(first) || (typeof data.url === 'string' ? data.url.trim() : undefined);

  return {
    success: true,
    data,
    url: normalizedUrl,
  };
}

async function yunwuGrokImageOnce(
  apiKey: string,
  baseUrl: string,
  modelId: string,
  options: ImageGenerationOptions
): Promise<GenerationResult> {
  let finalPrompt = options.prompt;
  if (options.size) {
    const [w, h] = options.size.split('x').map(Number);
    if (w && h) {
      const g = (a: number, b: number) => (b === 0 ? a : g(b, a % b));
      const d = g(w, h);
      finalPrompt = `${finalPrompt}【${w / d}:${h / d}】`;
    }
  }
  const endpoint = '/v1/chat/completions';
  const body = {
    model: modelId,
    messages: [
      {
        role: 'user',
        content: buildOpenAiVisionUserContent(finalPrompt, options.referenceDataUrls, options.characterName),
      },
    ],
    temperature: 0.7,
    max_tokens: 4096,
  };
  const grokAttempts = 3;
  const grokRetryDelayMs = 2800;
  let lastGrokErr: Error | null = null;
  for (let attempt = 0; attempt < grokAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, grokRetryDelayMs));
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: { message: response.statusText } }));
        throw new Error(err.error?.message || err.message || `HTTP ${response.status}`);
      }
      const data = await response.json();
      console.log(`[YunwuService] ${modelId} 响应:`, JSON.stringify(data).slice(0, 2000));
      const clean = parseGrokChatImageResults(data);
      if (clean.length > 0) {
        const first = clean[0];
        return {
          success: true,
          data: clean.map((url) => ({ url })),
          url: first.startsWith('data:') ? first : first,
        };
      }
      lastGrokErr = new Error('无法从响应中提取图片URL');
      console.warn(`[YunwuService] ${modelId} 第 ${attempt + 1} 次未解析到图片`);
    } catch (e: any) {
      lastGrokErr = e instanceof Error ? e : new Error(String(e?.message || e));
      console.warn(`[YunwuService] ${modelId} 第 ${attempt + 1} 次请求失败:`, lastGrokErr.message);
    }
  }
  console.error(`[YunwuService] ${modelId} 多次尝试后仍失败`, lastGrokErr);
  throw lastGrokErr || new Error(`${modelId} 生图失败`);
}

    // 其他模型使用 images/generations 端点（含 z-image-turbo 等 OpenAI 兼容图模）
    let endpoint = '/v1/images/generations';
    let body: any = {
      model: opts.model,
      prompt: opts.prompt,
    };

    // 添加可选参数
    if (opts.size) body.size = opts.size;
    if (opts.quality) body.quality = opts.quality;
    if (opts.n) body.n = opts.n;
    
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
      const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
      throw new Error(errorMessage);
    }
    
    const data = await response.json();
    const first = data.data?.[0];
    const normalizedUrl =
      openAiImageDataItemToUrl(first) || (typeof data.url === 'string' ? data.url.trim() : undefined);

    return {
      success: true,
      data,
      url: normalizedUrl,
    };
  } catch (error: any) {
    console.error('[YunwuService] 图片生成失败:', error);
    return {
      success: false,
      error: error.message || '图片生成失败',
    };
  }
};

/**
 * 生成视频
 */
/**
 * 生成视频（仅支持 Sora 系列模型）
 * 支持两种模式：
 * 1. 文生视频（Text-to-Video）：当 images 为空或未提供时
 * 2. 图生视频（Image-to-Video）：当 images 不为空时
 */
export const generateVideo = async (
  apiKey: string,
  options: VideoGenerationOptions
): Promise<GenerationResult> => {
  try {
    const baseUrl = 'https://yunwu.ai';
    
    // 只支持 Sora 系列模型
    const supportedModels = ['sora-2', 'sora-2-pro', 'sora-2-all'];
    if (!supportedModels.includes(options.model)) {
      throw new Error(`不支持的视频模型: ${options.model}。当前仅支持 Sora 系列模型（sora-2, sora-2-pro）。`);
    }
    
    // 使用 /v1/video/create 端点
    const endpoint = '/v1/video/create';
    
    // 判断模式：如果有图片，则为图生视频；否则为文生视频
    const hasImages = options.images && options.images.length > 0;
    const mode = hasImages ? 'image-to-video' : 'text-to-video';
    
    console.log(`[generateVideo] 模式: ${mode}, 图片数量: ${options.images?.length || 0}`);
    
    // 转换 size 格式：720P -> small, 1080P -> large
    let sizeValue = options.size;
    if (sizeValue === '720P') {
      sizeValue = 'small';
    } else if (sizeValue === '1080P' || sizeValue === '4K') {
      sizeValue = 'large';
    } else if (!sizeValue) {
      sizeValue = 'large'; // 默认使用 large
    }
    
    // 确保 orientation 是 portrait 或 landscape（不能是 square）
    let orientationValue = options.orientation;
    if (orientationValue === 'square') {
      // 正方形默认使用 landscape
      orientationValue = 'landscape';
    }
    if (!orientationValue) {
      orientationValue = 'landscape'; // 默认横屏
    }
    
    // 构建请求体
    let body: any = {
      model: options.model === 'sora-2-all' ? 'sora-2' : options.model, // sora-2-all 使用 sora-2 模型名
      prompt: options.prompt,
      orientation: orientationValue, // 必需字段：portrait 或 landscape
      size: sizeValue, // 必需字段：small 或 large
      duration: options.duration || 10, // 必需字段：10, 15, 或 25
      watermark: options.watermark !== undefined ? options.watermark : true, // 必需字段，默认为 true
    };
    
    // 图生视频模式：添加 images 字段
    if (hasImages) {
      body.images = options.images; // 图生视频：传入图片数组
    }
    // 文生视频模式：不添加 images 字段（或传入空数组）
    
    // 添加可选参数
    if (options.private !== undefined) {
      body.private = options.private;
    }
      
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      // 尝试解析错误响应
      let errorData: any = {};
      let errorMessage = '';
      
      try {
        const responseText = await response.text();
        if (responseText) {
          try {
            errorData = JSON.parse(responseText);
          } catch {
            errorMessage = responseText;
          }
        }
      } catch {
        // 如果读取响应失败，使用默认错误信息
      }
      
      // 从多个可能的字段中提取错误信息
      errorMessage = errorMessage || 
        errorData.error?.message || 
        errorData.message || 
        errorData.error || 
        errorData.msg ||
        `HTTP ${response.status}: ${response.statusText}`;
      
      // 检查是否是"模型不可用"的错误
      if (errorMessage.includes('No available channels') || 
          errorMessage.includes('not available') ||
          errorMessage.includes('不可用') ||
          errorMessage.includes('未启用')) {
        throw new Error(`模型 "${options.model}" 在当前账户中不可用。\n\n可能原因：\n1. 该模型需要特殊权限或白名单\n2. 该模型暂未在您的账户中启用\n3. 当前账户余额不足或配额已用完\n\n建议：\n- 联系 yunwu.ai 客服确认模型可用性和账户权限`);
      }
      
      // 检查是否是服务器负载饱和的错误
      if (response.status === 500 || 
          errorMessage.includes('负载已饱和') || 
          errorMessage.includes('saturated') || 
          errorMessage.includes('负载') ||
          errorMessage.includes('繁忙') ||
          errorMessage.includes('busy') ||
          errorMessage.includes('overload')) {
        throw new Error(`服务器暂时繁忙，请稍后重试。\n\n错误详情：${errorMessage}\n\n建议：\n1. 等待 30 秒 - 2 分钟后重试\n2. 如果是高峰期，建议错峰使用`);
      }
      
      throw new Error(errorMessage);
    }
    
    const data = await response.json();
    
    // Sora 返回 task_id，需要轮询获取结果（如果需要）
    // 如果直接返回了 url，则使用 url；否则需要轮询 task_id
    return {
      success: true,
      data,
      url: data.url || data.data?.[0]?.url || data.video_url,
      taskId: data.id || data.task_id || data.taskId,
    };
  } catch (error: any) {
    console.error('[YunwuService] 视频生成失败:', error);
    
    // 如果错误信息已经包含详细说明（可能原因、建议等），直接返回
    if (error.message && (error.message.includes('可能原因：') || error.message.includes('建议：') || error.message.includes('服务器暂时繁忙'))) {
      return {
        success: false,
        error: error.message,
      };
    }
    
    // 检查是否是服务器负载饱和的错误（未在之前捕获的情况）
    const errorMsg = error.message || '视频生成失败';
    if (errorMsg.includes('负载已饱和') || errorMsg.includes('saturated') || errorMsg.includes('负载')) {
      return {
        success: false,
        error: `服务器暂时繁忙，请稍后重试。\n\n错误详情：${errorMsg}\n\n建议：\n1. 等待 30 秒 - 2 分钟后重试\n2. 尝试使用其他视频生成模型\n3. 如果是高峰期，建议错峰使用`,
      };
    }
    
    return {
      success: false,
      error: errorMsg,
    };
  }
};

/**
 * 查询任务状态（用于异步任务）
 */
export const checkTaskStatus = async (
  apiKey: string,
  taskId: string
): Promise<GenerationResult> => {
  try {
    const baseUrl = 'https://yunwu.ai';
    const endpoint = `/v1/tasks/${taskId}`;
    
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    return {
      success: true,
      data,
      url: data.url || data.result?.url,
    };
  } catch (error: any) {
    console.error('[YunwuService] 查询任务状态失败:', error);
    return {
      success: false,
      error: error.message || '查询任务状态失败',
    };
  }
};
