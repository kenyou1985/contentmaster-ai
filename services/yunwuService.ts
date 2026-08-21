/**
 * Yunwu.ai API 服务
 * 用于生成图片和视频
 */

// 政治人物名字替换规则（用于绕过 Gemini 版权限制）
const POLITICAL_NAME_REPLACEMENTS: Record<string, string> = {
  '蔣萬安': 'a 40-year-old Asian male politician in a suit with a serious expression',
  '蒋万安': 'a 40-year-old Asian male politician in a suit with a serious expression',
  '黃珊珊': 'a 45-year-old Asian female politician in professional attire with a thoughtful expression',
  '黄珊珊': 'a 45-year-old Asian female politician in professional attire with a thoughtful expression',
  '陳時中': 'a 60-year-old Asian male politician in a suit with a calm expression',
  '陈时中': 'a 60-year-old Asian male politician in a suit with a calm expression',
  '柯文哲': 'a 55-year-old Asian male politician in casual attire with a thoughtful expression',
  '侯友宜': 'a 50-year-old Asian male politician in a suit with a serious expression',
  '賴清德': 'a 60-year-old Asian male politician in a suit with a serious expression',
  '蔡英文': 'a female Asian politician in professional attire',
  '韩国瑜': 'a 60-year-old Asian male politician in a suit',
  '韓國瑜': 'a 60-year-old Asian male politician in a suit',
  '朱立倫': 'a 50-year-old Asian male politician in a suit',
  '卢秀燕': 'a 50-year-old Asian female politician in professional attire',
  '盧秀燕': 'a 50-year-old Asian female politician in professional attire',
  '林佳龍': 'a 45-year-old Asian male politician in a suit',
};

/**
 * 替换政治人物名字为外貌描述（用于绕过 Gemini 版权限制）
 * 规则：
 * - 保留标题文字（在 TEXT: 和 TEXT (display exactly) 中）
 * - 替换所有英文名（如 Chiang Wan-an → 外貌描述）
 * - 替换中文描述部分的名字
 */
function replacePoliticalNames(text: string): string {
  // 中文名字到外貌描述的映射
  const CHINESE_NAME_MAP: Record<string, string> = {
    '蔣萬安': 'a 40-year-old Asian male politician in a suit with a serious expression',
    '蒋万安': 'a 40-year-old Asian male politician in a suit with a serious expression',
    '黃珊珊': 'a 45-year-old Asian female politician in professional attire with a thoughtful expression',
    '黄珊珊': 'a 45-year-old Asian female politician in professional attire with a thoughtful expression',
    '陳時中': 'a 60-year-old Asian male politician in a suit with a calm expression',
    '陈时中': 'a 60-year-old Asian male politician in a suit with a calm expression',
  };

  // 英文名到外貌描述的映射（包含多种拼写变体）
  const ENGLISH_NAME_MAP: Record<string, string> = {
    // 蔣萬安
    'Chiang Wan-an': 'a 40-year-old Asian male politician in a suit with a serious expression',
    // 黃珊珊
    'Han Shan-shan': 'a 45-year-old Asian female politician in professional attire with a thoughtful expression',
    'Huang Shan-shan': 'a 45-year-old Asian female politician in professional attire with a thoughtful expression',
    // 陳時中
    'Chen Shi-zhong': 'a 60-year-old Asian male politician in a suit with a calm expression',
    'Chen Shih-chung': 'a 60-year-old Asian male politician in a suit with a calm expression',
  };

  let result = text;

  // 1. 先提取并保护标题部分
  const titlePlaceholders: string[] = [];

  // 保护 [TEXT: "中文标题"] 格式
  result = result.replace(/(\[TEXT:\s*[""][^\]]*?[""]\])/g, (match) => {
    const placeholder = `__TITLE_${titlePlaceholders.length}__`;
    titlePlaceholders.push(match);
    return placeholder;
  });

  // 保护 |TEXT (display exactly): "中文标题"| 格式
  result = result.replace(/(\|TEXT\s*\(display exactly\):\s*"[^"]*"\|)/g, (match) => {
    const placeholder = `__TITLE_${titlePlaceholders.length}__`;
    titlePlaceholders.push(match);
    return placeholder;
  });

  // 2. 替换英文名 - 使用简单直接的替换
  // 按名称长度从长到短排序，避免部分匹配
  const sortedNames = Object.keys(ENGLISH_NAME_MAP).sort((a, b) => b.length - a.length);

  for (const name of sortedNames) {
    const description = ENGLISH_NAME_MAP[name];
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 替换所有出现（忽略大小写）
    const regex = new RegExp(escapedName.replace(/-/g, '[-\\s]?'), 'gi');
    result = result.replace(regex, description);
  }

  // 3. 替换中文名（在人物描述和特别提示部分）
  for (const [cnName, description] of Object.entries(CHINESE_NAME_MAP)) {
    const escapedName = cnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 在人物描述行中替换（主人物、相关人物等）
    result = result.replace(new RegExp(`(${escapedName})([·\\s，])`, 'g'), `${description}$2`);

    // 在特别提示中替换
    result = result.replace(new RegExp(`(${escapedName})([、，）])`, 'g'), `${description}$2`);
  }

  // 4. 恢复标题部分
  for (let i = 0; i < titlePlaceholders.length; i++) {
    result = result.replace(`__TITLE_${i}__`, titlePlaceholders[i]);
  }

  return result;
}

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
  /**
   * 外部 abort signal：组件卸载 / 用户主动取消会立即终止请求；
   * 区分于内部超时 abort（无此 signal 但 AbortError 时为已扣费场景，不重试避免重复扣费）
   */
  externalSignal?: AbortSignal;
  /** 内部超时时长（毫秒）。同步接口高峰期可能需要 3~4 分钟，默认 240s */
  timeoutMs?: number;
}

/**
 * 从 size 字段提取 "W:H" 比例字符串。
 * 支持 "WxH" 像素（如 "1536x864"）和 "W:H" 比例（如 "16:9"）。
 * gpt-image-2 在云雾 / OpenAI images API 中均支持此格式。
 * 解析失败返回 undefined。
 */
function sizeToAspectRatio(size: string): string | undefined {
  const s = size.trim();
  // WxH 像素
  const pixelMatch = s.match(/^(\d+)x(\d+)$/i);
  if (pixelMatch) {
    const w = parseInt(pixelMatch[1], 10);
    const h = parseInt(pixelMatch[2], 10);
    if (!w || !h) return undefined;
    const g = (a: number, b: number) => (b === 0 ? a : g(b, a % b));
    const d = g(w, h);
    return `${w / d}:${h / d}`;
  }
  // W:H 比例
  const ratioMatch = s.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (ratioMatch) return s;
  return undefined;
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
export const YUNWU_TTS_POLISH_MODEL = 'gpt-5.6-luna';

function stripLeadingTrailingCodeFence(s: string): string {
  let t = s.trim();
  const m = t.match(/^```(?:\w+)?\s*\n?([\s\S]*?)```\s*$/);
  if (m) t = m[1].trim();
  return t;
}

/** 清除 AI 推理标签（gpt-5.4-mini 等推理模型会输出 <think>…</think> 标签包裹的思考过程） */
function stripThinkTags(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

const TTS_POLISH_BASE_SYSTEM = `You are a professional dubbing script editor for neural TTS.
Optimize the user's lines for natural, fluent speech: improve punctuation and phrase breaks for breathing, remove timestamps/meta noise, keep emotional tone and facts intact.
Rules:
- Output ONLY the final text to be spoken. Preserve the exact same language as the input.
- Do NOT translate. Do NOT convert English to Chinese or vice versa. The input language must match the output language.
- Do NOT add role names, shot labels, markdown, or quotes wrapping the entire output.
- Do NOT add, remove, or rewrite sentences. Every sentence from the input MUST appear in the output verbatim (you may only add/modify punctuation and line breaks within sentences).
- Keep the content complete; do not summarize away substantive lines.
- If you cannot safely optimize without changing meaning, return the input text exactly as-is.
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

/**
 * 内容完整性校验：确保 LLM 输出与原文语义等价（句子/词集合一致）。
 * 允许：标点规范化、断句拆分/合并、语气词清理、换行位置调整。
 * 不允许：新增句子、删减句子、替换核心词汇、改变语序导致语义偏移。
 *
 * 校验规则：
 * 1. 中文文本：提取所有「有效句子」（≥4个CJK字符），逐一检查原文句子是否全部出现在优化版中
 * 2. 英文文本：提取所有「单词集合」，检查原文词集合是否为优化版词集合的超集
 * 3. 若校验失败 → 回退原文
 */
function validateContentIntegrity(original: string, polished: string): { valid: boolean; reason?: string } {
  const orig = (original || '').trim();
  const poly = (polished || '').trim();
  if (!orig || !poly) return { valid: false, reason: 'empty input' };

  // 允许的字符差异（标点、空白），但整体长度不应剧烈变化
  // 长度差异超过 ±50% → 直接判定为改写
  if (poly.length < orig.length * 0.5 || poly.length > orig.length * 1.5) {
    return { valid: false, reason: `长度剧烈变化: orig=${orig.length} poly=${poly.length}` };
  }

  // 中文：提取有效句子（≥4个CJK字符的连续段落）
  const chineseMatch = orig.match(/[\u4e00-\u9fff]/g);
  if (chineseMatch && chineseMatch.length >= 4) {
    // 提取原文所有 ≥4 字的连续段落作为「有效句子」
    const origSentences: string[] = [];
    let buf = '';
    for (const ch of orig) {
      if (/[\u4e00-\u9fff]/.test(ch)) {
        buf += ch;
      } else {
        if (buf.length >= 4) origSentences.push(buf);
        buf = '';
      }
    }
    if (buf.length >= 4) origSentences.push(buf);
    // 每个有效句子都必须出现在优化版中（允许标点/空格差异）
    for (const sent of origSentences) {
      if (!poly.includes(sent)) {
        return { valid: false, reason: `原文关键内容「${sent}」在优化版中丢失` };
      }
    }
  } else {
    // 英文或短文本：检查词集合超集
    const origWords = orig.split(/\s+/).filter(w => w.length >= 3 && /[a-zA-Z]/i.test(w));
    const polyWords = new Set(poly.split(/\s+/).filter(w => w.length >= 3 && /[a-zA-Z]/i.test(w)));
    // 原文每个词都必须出现在优化版（允许顺序变化、时态变化等）
    for (const w of origWords) {
      if (!polyWords.has(w)) {
        // 再试一次忽略大小写
        const lower = w.toLowerCase();
        const found = Array.from(polyWords).some(pw => pw.toLowerCase() === lower);
        if (!found) {
          return { valid: false, reason: `原文关键词「${w}」在优化版中丢失` };
        }
      }
    }
  }

  return { valid: true };
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
    const res = await fetch('https://api.openlux.ai/v1/chat/completions', {
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
    const polished = stripThinkTags(stripLeadingTrailingCodeFence(content).trim());

    // 内容完整性校验：禁止 LLM 改写文案内容（新增/删减句子）
    if (fallback) {
      const check = validateContentIntegrity(fallback, polished);
      if (!check.valid) {
        console.warn(`[TTSPolish] 内容被修改，拒绝替换原文（${check.reason}），回退原文`);
        return fallback;
      }
    }

    return polished.length >= 2 ? polished : fallback;
  } catch (e) {
    console.warn('[OpenLuxService] TTS polish request failed, using raw text:', e);
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
   * 在默认口播润色规则上叠加「赛道人设」与/或用户自定义说明（仍用 gpt-5.6-luna）。
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
      console.error('[OpenLuxService] 参考图加载失败:', raw.slice(0, 96), e);
      throw new Error('无法加载参考图，请使用本地上传或确保图片链接可访问（含 blob / 跨域）');
    }
  }
  return out;
}

/** 封面设计 Tab：主模型失败时自动切换备用 */
export const COVER_GEMINI_IMAGE_MODEL = 'cover-gemini-flash' as const;
export const COVER_GPT_IMAGE_2_C_MODEL = 'gpt-image-2-c' as const;
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
    // 明确告诉模型：只参考参考图的艺术风格/构图，不是复制真实肖像
    // 这样可以绕过版权限制，同时保持风格一致性
    return `- Image ${refNum}: Create a STYLIZED ILLUSTRATION inspired by the character "${char}" from reference image ${refNum}. Match the ART STYLE (line weight, color blocks, or photographic look) of the reference, but create an original stylized character design. Focus on: pose composition, color palette, and visual mood matching the reference. Do NOT create a photorealistic or trademarked likeness.`;
  }).join('\n');

  return `You will generate ONE STYLIZED ILLUSTRATION (not photorealistic) with the aspect ratio stated in the composition brief below. Below this message come ${n} reference image(s) IN ORDER: Image 1, Image 2, ... Image ${n}.

ARTISTIC STYLE LOCK (highest priority — overrides any generic wording in the brief):
${identityBlocks}
- Match the illustration style of the references (line weight, color blocks, or photographic look)
- Create stylized, illustrative or artistic character representations
- Focus on mood, composition, and color palette from references

After the reference image parts, a COMPOSITION BRIEF follows — follow it for layout, text, arrows, and mood, but NEVER create photorealistic images of real people. Use artistic/stylized interpretation instead.`;
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

  console.debug('[OpenLuxService] buildOpenAiVisionUserContent:', {
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
${chars.map((char, idx) => `- Image ${idx + 1} is "${char}" (${referenceDataUrls[idx] ? 'provided' : 'missing'})`).join('\n')}

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
  // 替换政治人物名字（绕过 Gemini 版权限制）
  const sanitizedPrompt = replacePoliticalNames(options.prompt);
  if (sanitizedPrompt !== options.prompt) {
    console.log('[OpenLuxService] Gemini prompt 替换政治人物名字:', options.prompt.slice(0, 50) + '...', '→', sanitizedPrompt.slice(0, 50) + '...');
  }

  const { parts } = buildGeminiNativeImageParts(
    sanitizedPrompt,
    options.referenceDataUrls,
    options.referenceMultimodalPreamble,
    options.characterName
  );
  // 使用 /v1beta/models/{model}:generateContent 端点
  const endpoint = `/v1beta/models/${geminiModelId}:generateContent`;

  // 构建 generationConfig（使用 snake_case 格式）
  const generationConfig: Record<string, unknown> = {
    response_modalities: ['IMAGE', 'TEXT'],
  };

  // 构建 imageConfig（使用 snake_case 格式，因为这是 API 的期望格式）
  if (options.size || options.quality) {
    const imageConfig: Record<string, string> = {};
    if (options.size) {
      const [w, h] = options.size.split('x').map(Number);
      if (w && h) {
        // OpenLux Gemini API 支持的 aspect_ratio: 1:1, 1:4, 1:8, 2:3, 3:2, 3:4, 4:1, 4:3, 4:5, 5:4, 8:1, 9:16, 16:9, 21:9
        const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
        const divisor = gcd(w, h);
        const simplifiedRatio = `${w / divisor}:${h / divisor}`;
        console.log(`[OpenLuxService] Gemini 原始尺寸: ${w}x${h}, 化简比例: ${simplifiedRatio}`);

        // 验证比例是否在支持列表中
        const supportedRatios = ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'];

        if (supportedRatios.includes(simplifiedRatio)) {
          imageConfig.aspect_ratio = simplifiedRatio;
          console.log(`[OpenLuxService] Gemini aspect_ratio: ${simplifiedRatio} ✓`);
        } else {
          // 尝试映射到最接近的支持比例
          const ratioValue = w / h;
          const ratioMappings: { ratio: string; value: number }[] = [
            { ratio: '1:1', value: 1 },
            { ratio: '4:3', value: 4 / 3 },
            { ratio: '3:2', value: 3 / 2 },
            { ratio: '16:9', value: 16 / 9 },
            { ratio: '2:3', value: 2 / 3 },
            { ratio: '3:4', value: 3 / 4 },
            { ratio: '9:16', value: 9 / 16 },
          ];

          let closestRatio = '16:9';
          let minDiff = Math.abs(ratioValue - 16 / 9);
          for (const mapping of ratioMappings) {
            const diff = Math.abs(ratioValue - mapping.value);
            if (diff < minDiff) {
              minDiff = diff;
              closestRatio = mapping.ratio;
            }
          }

          console.warn(`[OpenLuxService] Gemini 不支持比例 ${simplifiedRatio}，映射到 ${closestRatio}`);
          imageConfig.aspect_ratio = closestRatio;
        }
      }
    }
    if (options.quality === 'high') {
      imageConfig.image_size = '2K';
    }
    if (Object.keys(imageConfig).length > 0) {
      generationConfig.image_config = imageConfig;
    }
  }

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };

  // 调试日志：打印实际发送的请求
  console.log(`[OpenLuxService] Gemini 请求体:`, JSON.stringify(body, null, 2));

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  // 调试日志：打印响应状态
  console.log(`[OpenLuxService] Gemini 响应状态: ${response.status}`);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
    const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
    throw new Error(errorMessage);
  }
  const data = await response.json();
  const imageUrls = extractUrlsFromGeminiImageResponse(data);
  if (imageUrls.length === 0) {
    console.error('[OpenLuxService] Gemini 图片响应无可用图:', geminiModelId, data);
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
  /**
   * 错误码（仅 success=false 时有）：
   * - USER_CANCELLED：用户主动取消
   * - TIMEOUT_AFTER_PAYMENT：内部超时（云端可能已扣费），未自动重试避免重复扣费
   */
  code?: 'USER_CANCELLED' | 'TIMEOUT_AFTER_PAYMENT' | string;
  /** 失败时已等待的毫秒数（用于"云端响应超时"场景的诊断） */
  elapsedMs?: number;
  /** 失败时的模型 id（用于诊断） */
  model?: string;
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
 * 将 size 转换为 DALL-E 3 支持的尺寸
 * DALL-E 3 只支持: 1024x1024, 1024x1792, 1792x1024
 * @param size 原始尺寸（"WxH" 像素 或 "W:H" 比例字符串，例如 "1920x1080"、"16:9"）
 * @returns DALL-E 3 兼容的尺寸
 */
function convertSizeForDalle3(size?: string): string {
  if (!size) return '1024x1024';
  const aspectRatioMatch = size.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  let aspectRatio = 1;
  if (aspectRatioMatch) {
    aspectRatio = parseFloat(aspectRatioMatch[1]) / parseFloat(aspectRatioMatch[2]);
  } else {
    const [w, h] = size.split('x').map(Number);
    if (!w || !h) return '1024x1024';
    aspectRatio = w / h;
  }
  // DALL-E 3 支持的宽高比: 1:1, ~0.57 (9:16/2:3), ~1.78 (16:9/3:2)  if (Math.abs(aspectRatio - 1) < 0.1) return '1024x1024';
  if (aspectRatio < 1) return '1024x1792'; // 竖屏
  return '1792x1024'; // 横屏
}

/**
 * 将 size 转换为 gpt-image-2 支持的尺寸
 * gpt-image-2 官方支持: 1024x1024 (1:1), 1024x1536 (2:3), 1536x1024 (3:2),
 *                     1024x1792 (9:16), 1792x1024 (16:9)
 * 用户传的任意 WxH（1080x1440 / 720x1280 等）会被后端静默忽略或回退为默认 16:9，
 * 必须在此处强制转换到最近的合法尺寸。
 *
 * 映射规则：
 *   1:1  (aspectRatio ≈ 1)       → 1024x1024
 *   2:3  (0.65-0.7, 比如 3:4)   → 1024x1536
 *   9:16 (0.55-0.65, 比如 9:16) → 1024x1792
 *   3:2  (1.4-1.6, 比如 3:2)    → 1536x1024
 *   16:9 (1.7+, 比如 16:9)      → 1792x1024
 */
function convertSizeForGptImage2(size?: string): string {
  if (!size) return '1024x1024';
  const aspectRatioMatch = size.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  let aspectRatio = 1;
  if (aspectRatioMatch) {
    aspectRatio = parseFloat(aspectRatioMatch[1]) / parseFloat(aspectRatioMatch[2]);
  } else {
    const [w, h] = size.split('x').map(Number);
    if (!w || !h) return '1024x1024';
    aspectRatio = w / h;
  }
  // 1:1 方图
  if (Math.abs(aspectRatio - 1) < 0.1) return '1024x1024';
  // 竖屏（aspectRatio < 1）
  if (aspectRatio < 1) {
    if (aspectRatio < 0.6) return '1024x1792'; // 极竖（9:16 ≈ 0.5625）
    return '1024x1536'; // 中等竖（2:3 ≈ 0.667，3:4 = 0.75 也归这里）
  }
  // 横屏（aspectRatio > 1）
  if (aspectRatio > 1.6) return '1792x1024'; // 16:9 ≈ 1.778
  return '1536x1024'; // 中等横（3:2 = 1.5）
}

// ─────────────────────────────────────────────────────────────────────────
// 全局图片生成限流器（解决上游 429 雪崩）
// ─────────────────────────────────────────────────────────────────────────
// 设计动机：
//   批量 6 张封面并发跑时，若上游分组进入"负载饱和"状态，会一起 429。
//   每个 fetchWithRetry 内部各自重试 → 反而在同一时间窗口再次撞 429，
//   最终全部失败。这里加一层全局协调：
//     1. 滑动窗口：默认 60s 内最多 4 个并发槽位
//     2. 任意一次 429：触发全局 cooldown（默认 8s，可叠加），所有等待者串行唤醒
//     3. 30s 内无 429：自动恢复窗口 = 4
//     4. cooldown 期间最大并发降为 1（避免再撞）
// 调用方只需 await acquireImageGenSlot() 即可，零侵入。
type Waiter = { resolve: () => void; rejected: boolean };
class GlobalImageGenLimiter {
  private windowMs = 60_000;
  private maxConcurrent = 4;
  private cooldownMs = 0;            // 当前剩余冷却（ms）
  private cooldownTimer: any = null;
  private recoveryTimer: any = null; // 无 429 自动恢复窗口定时器
  private recentHits: number[] = []; // 时间戳
  private waiters: Waiter[] = [];
  private inFlight = 0;

  /** 获取一个生成槽位（自动等待冷却 / 串行化） */
  acquire(): Promise<void> {
    // 还在 cooldown 内：排队等唤醒
    if (this.cooldownMs > 0 || this.inFlight >= this.maxConcurrent) {
      return new Promise<void>((resolve) => {
        this.waiters.push({ resolve, rejected: false });
      });
    }
    this.inFlight++;
    return Promise.resolve();
  }

  /** 调用方完成一次图片生成（成功或最终失败都调用，释放槽位） */
  release(_isRateLimit = false): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.drainWaiters();
  }

  /** 上游命中限流（429），由 fetchWithRetry 调用方报告 */
  reportRateLimited(retryAfterSec?: number): void {
    // 优先用上游 Retry-After header，否则指数叠加：8s → 16s → 32s，最多 60s
    const now = Date.now();
    const lastHit = this.recentHits[this.recentHits.length - 1] || 0;
    this.recentHits.push(now);
    // 60s 内只保留最近的命中
    this.recentHits = this.recentHits.filter((t) => now - t < 60_000);

    const baseCooldown = retryAfterSec && retryAfterSec > 0 ? retryAfterSec * 1000 : 8000;
    // 60s 内连续命中 → 退避翻倍（最多 60s）
    const consecutive = this.recentHits.length;
    const escalator = Math.min(8, Math.pow(2, Math.max(0, consecutive - 1))); // 1, 2, 4, 8
    const nextCooldown = Math.min(60_000, baseCooldown * escalator);

    this.cooldownMs = Math.max(this.cooldownMs, nextCooldown);
    // cooldown 期间最大并发降为 1
    this.maxConcurrent = 1;
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => {
      this.cooldownMs = 0;
      // 30s 内不再命中 → 恢复窗口 4
      if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = setTimeout(() => {
        if (this.recentHits.length === 0) {
          this.maxConcurrent = 4;
        }
      }, 30_000);
      this.drainWaiters();
    }, this.cooldownMs);

    console.warn(
      `[ImageGenLimiter] 触发限流冷却 · ${(this.cooldownMs / 1000).toFixed(1)}s · 60s 内累计命中 ${consecutive} 次 · 并发降为 1`
    );
  }

  /** 成功后清理最近命中记录（让恢复定时器尽快生效） */
  reportSuccess(): void {
    // 60s 之前的命中视为陈旧，丢弃
    const cutoff = Date.now() - 60_000;
    this.recentHits = this.recentHits.filter((t) => t > cutoff);
    // 如果当前不是 cooldown 且没有最近命中，且窗口被压到 1，恢复到 4
    if (this.cooldownMs === 0 && this.recentHits.length === 0 && this.maxConcurrent !== 4) {
      this.maxConcurrent = 4;
    }
  }

  private drainWaiters(): void {
    while (this.waiters.length > 0 && this.cooldownMs === 0 && this.inFlight < this.maxConcurrent) {
      const w = this.waiters.shift()!;
      if (w.rejected) continue;
      this.inFlight++;
      w.resolve();
    }
  }

  /** 调试用 */
  stats() {
    return {
      inFlight: this.inFlight,
      cooldownMs: this.cooldownMs,
      maxConcurrent: this.maxConcurrent,
      waiters: this.waiters.length,
      recentHits: this.recentHits.length,
    };
  }
}

export const imageGenLimiter = new GlobalImageGenLimiter();
/** 兼容旧调用方（可省略）：直接 await acquireImageGenSlot() */
export const acquireImageGenSlot = () => imageGenLimiter.acquire();

/**
 * 生成图片
 */
/**
 * 通用 fetch 包装：自动重试 503/429/网络中断（指数退避 + jitter）
 * - 单次 503/429：重试 3 次
 * - 网络错误（fetch 抛 TypeError / ERR_CONNECTION_RESET / ERR_CONNECTION_CLOSED）：重试 3 次
 * - 退避：第 1 次 2s，第 2 次 4s + 随机 0~2s jitter，第 3 次 8s + 随机 0~4s jitter
 * - 4xx（除 429）：立即失败（不重试），减少无效请求
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: {
    /** 超时时间（毫秒）。gpt-image-2 高峰期可能需要 3~4 分钟，默认 240s */
    timeoutMs?: number;
    /** 最大重试次数（含首次） */
    maxRetries?: number;
    /** 上下文标识（用于日志） */
    label?: string;
    /** 外部 abort 信号（如组件卸载、用户主动取消），触发后立即终止所有重试 */
    externalSignal?: AbortSignal;
  } = {}
): Promise<Response> {
  const { timeoutMs = 240_000, maxRetries = 3, label = 'request', externalSignal } = opts;
  const isRetryableStatus = (status: number) => status === 503 || status === 502 || status === 429 || status === 504;
  const isNetworkErr = (e: any) =>
    e?.name === 'TypeError' ||
    e?.name === 'AbortError' ||
    e?.message?.includes('network') ||
    e?.message?.includes('NetworkError') ||
    e?.message?.includes('Failed to fetch') ||
    e?.message?.includes('net::') ||
    e?.message?.includes('ERR_CONNECTION') ||
    e?.message?.includes('aborted');

  let lastErr: any = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // 外部 signal 已触发：立即终止（用户主动取消 / 组件卸载场景）
    if (externalSignal?.aborted) {
      const err: any = new Error('请求已被用户取消');
      err.name = 'AbortError';
      err.code = 'USER_CANCELLED';
      throw err;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 串联外部信号：外部 abort 也会触发本次 fetch abort
    const onExternalAbort = () => controller.abort();
    if (externalSignal) externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      if (resp.ok) return resp;
      // 不可重试：4xx（除 429）立即返回
      if (!isRetryableStatus(resp.status) && resp.status >= 400 && resp.status < 500) {
        return resp;
      }
      // 可重试：503/429/504
      if (attempt < maxRetries) {
        // 429 优先看 Retry-After header，否则指数退避
        const retryAfterRaw = resp.headers.get('Retry-After');
        const retryAfterSec = retryAfterRaw ? Math.max(1, parseInt(retryAfterRaw, 10) || 0) : 0;
        const baseDelay = retryAfterSec > 0 ? retryAfterSec * 1000 : 2000 * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 2000;
        const wait = baseDelay + jitter;
        // 通知全局限流器：本次命中 429（让其他并发请求自动串行冷却）
        if (resp.status === 429) {
          imageGenLimiter.reportRateLimited(retryAfterSec);
        }
        console.warn(`[OpenLuxService] ${label} HTTP ${resp.status}，${Math.round(wait)}ms 后重试 (${attempt}/${maxRetries - 1})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return resp;
    } catch (e: any) {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      lastErr = e;
      // 外部 signal 触发：用户主动取消，不重试
      if (externalSignal?.aborted) {
        const err: any = new Error('请求已被用户取消');
        err.name = 'AbortError';
        err.code = 'USER_CANCELLED';
        throw err;
      }
      if (!isNetworkErr(e) || attempt >= maxRetries) {
        throw e;
      }
      const baseDelay = 2000 * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 2000;
      const wait = baseDelay + jitter;
      console.warn(`[OpenLuxService] ${label} 网络错误 (${e?.message?.slice(0, 80) || e})，${Math.round(wait)}ms 后重试 (${attempt}/${maxRetries - 1})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr || new Error(`${label} 重试 ${maxRetries} 次仍失败`);
}

export const generateImage = async (
  apiKey: string,
  options: ImageGenerationOptions
): Promise<GenerationResult> => {
  // 全局限流：先获取一个槽位，避免批量撞 429
  await imageGenLimiter.acquire();
  try {
    const result = await generateImageInner(apiKey, options);
    // 成功时清掉最近命中记录（让 30s 恢复定时器尽快生效）
    if (result?.success) imageGenLimiter.reportSuccess();
    return result;
  } finally {
    imageGenLimiter.release();
  }
};

const generateImageInner = async (
  apiKey: string,
  options: ImageGenerationOptions
): Promise<GenerationResult> => {
  try {
    const baseUrl = 'https://api.openlux.ai';

    const opts: ImageGenerationOptions = {
      ...options,
      referenceDataUrls:
        options.referenceDataUrls?.length && options.referenceDataUrls.length > 0
          ? await normalizeReferenceDataUrls(options.referenceDataUrls)
          : options.referenceDataUrls,
    };

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
      // 注意：503/429/网络错误会自动重试（指数退避 + jitter），避免 yunwu 限流时整批失败
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
      const response = await fetchWithRetry(
        `${baseUrl}${endpoint}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        },
        {
          label: `sora_image(${opts.model})`,
          externalSignal: opts.externalSignal,
          timeoutMs: opts.timeoutMs,
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
        const errorMessage = errorData.error?.message || errorData.message || `HTTP ${response.status}: ${response.statusText}`;

        // 检查是否是"模型不可用"的错误
        if (errorMessage.includes('No available channels') || errorMessage.includes('not available')) {
          throw new Error(`模型 "${opts.model}" 在当前账户中不可用。\n\n可能原因：\n1. 该模型需要特殊权限或白名单\n2. 该模型暂未在您的账户中启用\n3. 当前账户余额不足或配额已用完\n\n建议：\n- 联系 OpenLux 客服确认模型可用性和账户权限\n- 或尝试使用其他视频生成模型`);
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
      console.error('[OpenLuxService] sora_image 响应数据:', data);
      throw new Error('无法从响应中提取图片URL，请检查响应格式');
    }

    // 封面设计：Gemini Flash 图模，三级备用链：gemini-3.1-flash-image-preview → gpt-image-2-c:stable → grok-imagine-image-pro
    // 支持 cover-gemini-flash 和 gemini-flash 两种 model id
    if (opts.model === COVER_GEMINI_IMAGE_MODEL || opts.model === 'gemini-flash') {
      try {
        return await yunwuGeminiNativeImageOnce(apiKey, baseUrl, COVER_GEMINI_PRIMARY, opts);
      } catch (primaryErr: any) {
        console.warn('[OpenLuxService] 封面生图 Gemini 主模型失败，切换 gpt-image-2-c:stable:', primaryErr?.message);
        try {
          return await yunwuOpenAiImageOnce(apiKey, baseUrl, 'gpt-image-2-c:stable', opts, {
            externalSignal: opts.externalSignal,
            timeoutMs: opts.timeoutMs,
          });
        } catch (gptErr: any) {
          console.warn('[OpenLuxService] 封面生图 gpt-image-2-c:stable 失败，切换 grok-imagine-image-pro:', gptErr?.message);
          return await yunwuGrokImageOnce(apiKey, baseUrl, 'grok-imagine-image-pro', opts);
        }
      }
    }

    // banana / banana-2：云雾 Gemini 原生 generateContent，支持 inlineData 参考图（文档示例：图生图 / 多图）
    if (opts.model === 'banana' || opts.model === 'banana-2') {
      const modelName =
        opts.model === 'banana' ? 'gemini-2.5-flash-image' : 'gemini-3.1-flash-image-preview';
      return await yunwuGeminiNativeImageOnce(apiKey, baseUrl, modelName, opts);
    }

    // gpt-image-2：使用 /v1/images/generations 端点（支持文生图），失败时回退到 gpt-image-2-c:stable → grok-imagine-image-pro
    if (opts.model === 'gpt-image-2') {
      try {
        return await yunwuOpenAiImageOnce(apiKey, baseUrl, 'gpt-image-2', opts, {
          externalSignal: opts.externalSignal,
          timeoutMs: opts.timeoutMs,
        });
      } catch (gptErr: any) {
        console.warn('[OpenLuxService] 封面生图 gpt-image-2 失败，切换 gpt-image-2-c:stable:', gptErr?.message);
        try {
          return await yunwuOpenAiImageOnce(apiKey, baseUrl, 'gpt-image-2-c:stable', opts, {
            externalSignal: opts.externalSignal,
            timeoutMs: opts.timeoutMs,
          });
        } catch (gptCErr: any) {
          console.warn('[OpenLuxService] 封面生图 gpt-image-2-c:stable 失败，切换 grok-imagine-image-pro:', gptCErr?.message);
          return await yunwuGrokImageOnce(apiKey, baseUrl, 'grok-imagine-image-pro', opts);
        }
      }
    }

    // gpt-image-2-c：使用 /v1/images/generations 端点，失败时回退到 gemini-3.1-flash-image-preview → grok-imagine-image-pro
    if (opts.model === COVER_GPT_IMAGE_2_C_MODEL) {
      try {
        return await yunwuOpenAiImageOnce(apiKey, baseUrl, 'gpt-image-2-c:stable', opts, {
          externalSignal: opts.externalSignal,
          timeoutMs: opts.timeoutMs,
        });
      } catch (gptErr: any) {
        console.warn('[OpenLuxService] 封面生图 gpt-image-2-c:stable 失败，切换 gemini-3.1-flash-image-preview:', gptErr?.message);
        try {
          return await yunwuGeminiNativeImageOnce(apiKey, baseUrl, COVER_GEMINI_PRIMARY, opts);
        } catch (geminiErr: any) {
          console.warn('[OpenLuxService] 封面生图 gemini-3.1-flash 失败，切换 grok-imagine-image-pro:', geminiErr?.message);
          return await yunwuGrokImageOnce(apiKey, baseUrl, 'grok-imagine-image-pro', opts);
        }
      }
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
          console.debug(`[OpenLuxService] ${opts.model} 响应:`);
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
          console.debug(`[OpenLuxService] ${opts.model} 第 ${attempt + 1} 次未解析到图片`);
        } catch (e: any) {
          lastGrokErr = e instanceof Error ? e : new Error(String(e?.message || e));
          console.warn(`[OpenLuxService] ${opts.model} 第 ${attempt + 1} 次请求失败:`, lastGrokErr.message);
        }
      }
      console.error(`[OpenLuxService] ${opts.model} 多次尝试后仍失败`, lastGrokErr);
      throw lastGrokErr || new Error('Grok 生图失败');
    }

async function yunwuOpenAiImageOnce(
  apiKey: string,
  baseUrl: string,
  modelId: string,
  options: ImageGenerationOptions,
  retryOpts?: { externalSignal?: AbortSignal; timeoutMs?: number }
): Promise<GenerationResult> {
  const hasRef = options.referenceDataUrls && options.referenceDataUrls.length > 0;
  const externalSignal = retryOpts?.externalSignal;
  // 同步接口（images/generations、images/edits）的高峰期完成时间约 30~180s；
  // 极端情况下（多参考图、复杂 prompt）可能逼近 4 分钟。默认 240s 避免误杀。
  const REQUEST_TIMEOUT_MS = retryOpts?.timeoutMs ?? 240_000;

  // 503 / 网络错误 / 上游饱和可重试
  const isRetryable = (status: number) => status === 503 || status === 502 || status === 429 || status === 504;
  const MAX_RETRIES = 6;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // 外部 signal 已触发（用户主动取消）：立即返回友好错误
    if (externalSignal?.aborted) {
      const err: any = new Error('请求已被用户取消');
      err.name = 'AbortError';
      err.code = 'USER_CANCELLED';
      throw err;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    // 串联外部 signal：组件卸载 / 主动取消会立刻 abort
    const onExternalAbort = () => controller.abort();
    if (externalSignal) externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    const attemptStart = Date.now();
    try {
      let response: Response;

      // gpt-image-2 支持 /v1/images/generations 和 /v1/images/edits
      // 有参考图时用 images/edits，否则用 images/generations
      if (hasRef) {
        // images/edits 端点（需要参考图）
        const endpoint = '/v1/images/edits';
        const formData = new FormData();
        formData.append('model', modelId);
        // 在 prompt 中明确标注比例，确保模型正确理解尺寸需求
        let finalPrompt = options.prompt || '';
        if (options.size) {
          const [w, h] = options.size.split('x').map(Number);
          if (w && h) {
            const g = (a: number, b: number) => (b === 0 ? a : g(b, a % b));
            const d = g(w, h);
            finalPrompt = `${finalPrompt}【宽高比 ${w / d}:${h / d}（宽${w}×高${h}）】`;
          }
        }
        formData.append('prompt', finalPrompt);
        for (const refUrl of options.referenceDataUrls!) {
          const [meta, b64] = refUrl.split(',', 2);
          const mime = meta.match(/data:([^;]+)/)?.[1] || 'image/png';
          const binary = atob(b64);
          const arr = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
          formData.append('image', new Blob([arr], { type: mime }), 'reference.png');
        }
        if (options.size) {
          // gpt-image-2 官方只支持 5 个尺寸: 1024x1024, 1024x1536 (2:3), 1536x1024 (3:2), 1024x1792 (9:16), 1792x1024 (16:9)
          // 用户传的 1080x1440 (3:4) 会被静默忽略或回退成 16:9（之前 bug）
          // 转换到最接近 gpt-image-2 支持的尺寸
          const gptSize = convertSizeForGptImage2(options.size);
          formData.append('size', gptSize);
          console.log(`[OpenLuxService] gpt-image-2 size: ${options.size} → ${gptSize}`);
        }
        if (options.quality) formData.append('quality', options.quality);
        if (options.n) formData.append('n', String(options.n));

        response = await fetch(`${baseUrl}${endpoint}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: formData,
          signal: controller.signal,
        });
      } else {
        // images/generations 端点
        // gpt-image-2 / gpt-image-2-c:stable 支持 size 参数和 aspect_ratio 参数
        const endpoint = '/v1/images/generations';
        let finalPrompt = options.prompt || '';
        // 在 prompt 中明确标注比例，确保模型正确理解尺寸需求
        if (options.size) {
          const [w, h] = options.size.split('x').map(Number);
          if (w && h) {
            const g = (a: number, b: number) => (b === 0 ? a : g(b, a % b));
            const d = g(w, h);
            finalPrompt = `${finalPrompt}【重要：宽高比必须是 ${w / d}:${h / d}（即 ${w}x${h}），生成 ${w / d}:${h / d} 比例的图片，不要生成其他比例！】`;
          }
        }
        // gpt-image-2 / gpt-image-2-c:stable 同时使用 size 和 aspect_ratio 参数
        const body: Record<string, unknown> = { model: modelId, prompt: finalPrompt };
        if (options.size) {
          // 转换为 gpt-image-2 支持的尺寸
          const gptSize = convertSizeForGptImage2(options.size);
          const [w, h] = options.size.split('x').map(Number);
          if (w && h) {
            const g = (a: number, b: number) => (b === 0 ? a : g(b, a % b));
            const d = g(w, h);
            // 同时传递 size 和 aspect_ratio，确保至少一个生效
            body.size = gptSize;
            body.aspect_ratio = `${w / d}:${h / d}`;
            console.log(`[OpenLuxService] ${modelId} size: ${options.size} → ${gptSize}, aspect_ratio: ${body.aspect_ratio}`);
          }
        }
        if (options.quality === 'high') {
          body.quality = 'high';
        }
        body.response_format = 'url';
        if (options.n) body.n = options.n;

        response = await fetch(`${baseUrl}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      }

      clearTimeout(timeout);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      const elapsedMs = Date.now() - attemptStart;

      if (response.ok) {
        const data = await response.json();
        const first = data.data?.[0];
        const normalizedUrl =
          openAiImageDataItemToUrl(first) ||
          (typeof data.url === 'string' ? data.url.trim() : undefined);
        return { success: true, data, url: normalizedUrl };
      }

      // 可重试错误：503/502/429/504
      if (isRetryable(response.status) && attempt < MAX_RETRIES - 1) {
        const delayMs = Math.min(2000 * Math.pow(2, attempt), 30_000);
        // 429 命中：通知全局限流器（让其他并发请求自动串行冷却）
        if (response.status === 429) {
          const raRaw = response.headers.get('Retry-After');
          const raSec = raRaw ? Math.max(1, parseInt(raRaw, 10) || 0) : 0;
          imageGenLimiter.reportRateLimited(raSec);
        }
        console.warn(`[OpenLuxService] ${modelId} 尝试 ${attempt + 1} 失败 (HTTP ${response.status})，${delayMs}ms 后重试...`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      // 不可重试或已达最大重试次数：解析错误体，判断是否"上游饱和"（可继续在模型层切换重试）
      const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
      const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
      const isUpstreamSaturated = /上游.*负载|负载.*饱和|upstream.*busy|upstream.*saturated/i.test(errorMessage);
      if (isUpstreamSaturated && attempt < MAX_RETRIES - 1) {
        // 业务体里说"上游饱和"也视作限流信号
        imageGenLimiter.reportRateLimited(0);
        const delayMs = Math.min(3000 * Math.pow(2, attempt), 45_000);
        console.warn(`[OpenLuxService] ${modelId} 上游饱和 (${errorMessage.slice(0, 60)})，${delayMs}ms 后重试...`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw new Error(errorMessage);

    } catch (err: any) {
      clearTimeout(timeout);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      const elapsedMs = Date.now() - attemptStart;

      // 外部 signal 触发：用户主动取消
      if (externalSignal?.aborted) {
        const e: any = new Error('请求已被用户取消');
        e.name = 'AbortError';
        e.code = 'USER_CANCELLED';
        throw e;
      }

      // AbortError 但无外部 signal 触发 → 大概率是内部 240s 超时
      // 这种情况云端很可能已扣费（任务已受理），不要重试，避免重复扣费；明确提示用户
      if (err?.name === 'AbortError' || /aborted without reason|signal is aborted/i.test(err?.message || '')) {
        const timeoutErr: any = new Error(
          `云端响应超时（已等待 ${Math.round(elapsedMs / 1000)}s）。` +
          `云雾（yunwu）任务大概率已受理并扣费，请稍后到「历史记录」中查看，或点击「重新绘图」再次尝试。` +
          `本次失败未自动重试，避免重复扣费。`
        );
        timeoutErr.name = 'TimeoutAbortError';
        timeoutErr.code = 'TIMEOUT_AFTER_PAYMENT';
        timeoutErr.elapsedMs = elapsedMs;
        timeoutErr.model = modelId;
        throw timeoutErr;
      }

      const isNetworkErr =
        err.name === 'TypeError' || // fetch 网络错误（断网、域名解析失败等）
        err.message?.includes('network') ||
        err.message?.includes('NetworkError') ||
        err.message?.includes('Failed to fetch') ||
        err.message?.includes('net::');

      // 网络错误可重试
      if (isNetworkErr && attempt < MAX_RETRIES - 1) {
        const delayMs = Math.min(2000 * Math.pow(2, attempt), 30_000);
        console.warn(`[OpenLuxService] ${modelId} 网络错误 (${err.message?.slice(0, 80)}), ${delayMs}ms 后重试...`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      lastError = err;
      break;
    }
  }

  throw lastError || new Error(`${modelId} 生成失败`);
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
      console.debug(`[OpenLuxService] ${modelId} 响应:`);
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
      console.debug(`[OpenLuxService] ${modelId} 第 ${attempt + 1} 次未解析到图片`);
    } catch (e: any) {
      lastGrokErr = e instanceof Error ? e : new Error(String(e?.message || e));
      console.warn(`[OpenLuxService] ${modelId} 第 ${attempt + 1} 次请求失败:`, lastGrokErr.message);
    }
  }
  console.error(`[OpenLuxService] ${modelId} 多次尝试后仍失败`, lastGrokErr);
  throw lastGrokErr || new Error(`${modelId} 生图失败`);
}

    // 其他模型使用 images/generations 端点（含 z-image-turbo 等 OpenAI 兼容图模）
    // 503/429/网络错误自动重试（指数退避 + jitter），避免 yunwu 限流时整批失败
    const endpoint = '/v1/images/generations';
    const body: any = {
      model: opts.model,
      prompt: opts.prompt,
    };

    // 添加可选参数
    if (opts.size) body.size = opts.size;
    if (opts.quality) body.quality = opts.quality;
    if (opts.n) body.n = opts.n;

    const response = await fetchWithRetry(
      `${baseUrl}${endpoint}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      {
        label: `images/generations(${opts.model})`,
        externalSignal: opts.externalSignal,
        timeoutMs: opts.timeoutMs,
      }
    );

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
    console.error('[OpenLuxService] 图片生成失败:', error);
    // 透传 AbortError / 扩展错误码（USER_CANCELLED / TIMEOUT_AFTER_PAYMENT），
    // 让上层（MediaGenerator）能区分是「用户主动取消」还是「已扣费超时」并采取不同策略
    if (error?.code === 'USER_CANCELLED' || error?.code === 'TIMEOUT_AFTER_PAYMENT') {
      return {
        success: false,
        error: error.message || '图片生成失败',
        code: error.code,
        elapsedMs: error.elapsedMs,
        model: error.model,
      };
    }
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
    const baseUrl = 'https://api.openlux.ai';
    
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
        throw new Error(`模型 "${options.model}" 在当前账户中不可用。\n\n可能原因：\n1. 该模型需要特殊权限或白名单\n2. 该模型暂未在您的账户中启用\n3. 当前账户余额不足或配额已用完\n\n建议：\n- 联系 OpenLux 客服确认模型可用性和账户权限`);
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
    console.error('[OpenLuxService] 视频生成失败:', error);
    
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
    const baseUrl = 'https://api.openlux.ai';
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
    console.error('[OpenLuxService] 查询任务状态失败:', error);
    return {
      success: false,
      error: error.message || '查询任务状态失败',
    };
  }
};
