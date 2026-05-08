/**
 * RunningHub API 服务
 * 支持多模板调用：视频模板、音频TTS模板、图片模板
 * API文档: https://www.runninghub.cn/runninghub-api-doc-cn/
 */

import {
  INDEXTTS2_DEFAULT_REFERENCE_AUDIO_PATH,
  INDEXTTS2_RUNNINGHUB_WORKFLOW_ID,
  INDEXTTS2_WORKFLOW_TEMPLATE,
} from './indexTts2WorkflowTemplate';

/** 判断文本主要语言：包含汉字 → 中文，纯拉丁字母且含英文字母 → 英文 */
function detectPrimaryLanguage(text: string): 'zh' | 'en' {
  const hasChinese = /[\u4e00-\u9fff]/.test(text);
  if (hasChinese) return 'zh';
  const hasLatin = /[a-zA-Z]/.test(text);
  if (hasLatin) return 'en';
  return 'zh';
}

export interface RunningHubImageOptions {
  prompt: string;
  model: 'flux' | 'z-image' | 'qwen-image';
  width?: number;
  height?: number;
  num_images?: number;
  image_url?: string;
}

export interface RunningHubVideoOptions {
  /** 完整 workflow JSON（模板）；不填则用 nodeInfoList 方式 */
  workflow?: Record<string, any>;
  /** workflow JSON 模板（JSON 字符串格式） */
  workflowTemplate?: string;
  prompt: string;
  model: 'wan2.2' | 'ltx2';
  image_url?: string;
  duration?: number;
  /** Wan2.2 run/ai-app：最大边像素（节点 112），默认 1280（约 720P 长边） */
  maxResolutionPixels?: number;
  /** Wan2.2 run/ai-app：帧率（节点 124），默认 16 */
  frameRate?: number;
}

export interface RunningHubAudioOptions {
  text: string;
  /** 保留字段；当前 TTS 走 ai-app 固定模板，可不传 */
  model?: 'indextts2.0';
  /** 可选：RunningHub 上的参考音频路径（如 "xxx.MP3"），写入 nodeId=13/15；省略则用平台默认参考音 */
  referenceAudioPath?: string;
  /** 可选：指定参考音语言（auto=自动检测，zh=强制中文，en=强制英文）；省略则 auto */
  referenceLanguage?: 'auto' | 'zh' | 'en';
  speed?: number;
  /** 以下为“仅优化朗读方式，不改文本”的增强开关 */
  prosodyEnhance?: boolean;
  breath?: boolean;
  autoPause?: boolean;
  pauseStrength?: number;
  emphasisStrength?: number;
  pitch?: number;
  volume?: number;
}

export interface RunningHubResult {
  success: boolean;
  data?: any;
  error?: string;
  taskId?: string;
  status?: string;
  progress?: number;
  url?: string;
  urls?: string[];
}

const BASE_URL = 'https://www.runninghub.cn';

/**
 * query / 任务结果里常见为相对路径（如 api/xxx.wav），浏览器与剪映下载需补全为站点绝对 URL
 */
export const resolveRunningHubOutputUrl = (urlOrPath: string): string => {
  const t = (urlOrPath || '').trim();
  if (!t) return t;
  if (/^(https?:|data:|blob:)/i.test(t)) return t;
  if (t.startsWith('//')) return `https:${t}`;
  const path = t.startsWith('/') ? t : `/${t}`;
  return `${BASE_URL}${path}`;
};

/** 拉取远程图片为 Blob；直连失败时（常见：R2/OSS 未配 CORS）在开发环境走 Vite /__image_proxy */
async function fetchRemoteImageAsBlob(imageUrl: string): Promise<Blob> {
  const tryDirect = async () => {
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`无法获取图片: ${resp.status} ${resp.statusText}`);
    return resp.blob();
  };
  try {
    const blob = await tryDirect();
    console.log('[RunningHub] 远程图片直连成功，blob size:', blob.size);
    return blob;
  } catch (e: unknown) {
    const msg = String(e instanceof Error ? e.message : e);
    const looksLikeCorsOrNetwork =
      msg.includes('Failed to fetch') ||
      msg.includes('NetworkError') ||
      msg.includes('Load failed') ||
      msg.includes('blocked by CORS') ||
      msg.includes('Network request failed');
    if (!looksLikeCorsOrNetwork || typeof window === 'undefined') {
      throw e instanceof Error ? e : new Error(msg);
    }
    const proxy = `/__image_proxy?url=${encodeURIComponent(imageUrl)}`;
    console.warn('[RunningHub] 远程图片直连失败，尝试本地代理:', msg.slice(0, 120));
    const resp = await fetch(proxy);
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(
        `无法获取图片（外链可能禁止浏览器跨域读取）。` +
          `本地开发请使用 Vite 启动以启用 /__image_proxy；或让图床返回 Access-Control-Allow-Origin。` +
          ` 代理错误: ${resp.status} ${t.slice(0, 200)}`
      );
    }
    const blob = await resp.blob();
    console.log('[RunningHub] 通过代理拉取图片成功，blob size:', blob.size);
    return blob;
  }
}

/** 标准模型 OpenAPI v2 基址（与官方 ComfyUI 节点一致：提交 {endpoint}，轮询 POST .../query） */
const OPENAPI_V2_BASE = `${BASE_URL}/openapi/v2`;

/** 通用请求头（官方文档要求） */
const makeHeaders = (apiKey: string) => ({
  'Content-Type': 'application/json',
  'Host': 'www.runninghub.cn',
  'Authorization': `Bearer ${apiKey}`,
});

const tryParseJson = (raw: string): any => {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

/** 从 OpenAPI v2 query / 提交响应的 results 中取输出 URL（视频任务优先 mp4；TTS 多为 wav/mp3） */
export const extractUrlsFromOpenApiV2Results = (body: any): string[] => {
  const results = body?.results ?? body?.data?.results;
  const collected: string[] = [];

  // 方法1：从 results 数组提取
  if (Array.isArray(results) && results.length > 0) {
    const visit = (r: any) => {
      if (!r || typeof r !== 'object') return;
      for (const k of ['url', 'outputUrl', 'fileUrl', 'downloadUrl', 'path', 'videoUrl', 'audioUrl']) {
        const v = r[k];
        if (typeof v === 'string' && v.trim()) collected.push(v.trim());
      }
      if (typeof r.fileName === 'string' && r.fileName.trim()) collected.push(r.fileName.trim());
      if (Array.isArray(r.outputs)) r.outputs.forEach(visit);
      if (Array.isArray(r.files)) r.files.forEach(visit);
    };
    results.forEach(visit);
  }

  // 方法2：从 body.data 提取（不同 API 响应格式）
  const data = body?.data ?? body;
  if (data) {
    // 直接字段
    for (const k of ['url', 'outputUrl', 'fileUrl', 'downloadUrl', 'path', 'videoUrl', 'audioUrl', 'output_url']) {
      const v = data[k];
      if (typeof v === 'string' && v.trim()) collected.push(v.trim());
      // 数组格式
      if (Array.isArray(v)) {
        v.forEach((item: any) => {
          if (typeof item === 'string' && item.trim()) collected.push(item.trim());
          if (typeof item === 'object' && item) {
            for (const sk of ['url', 'outputUrl', 'fileUrl', 'path']) {
              const sv = item[sk];
              if (typeof sv === 'string' && sv.trim()) collected.push(sv.trim());
            }
          }
        });
      }
    }

    // files / outputs 数组
    const mediaArrays = data.files || data.outputs || data.data || [];
    if (Array.isArray(mediaArrays)) {
      mediaArrays.forEach((item: any) => {
        if (!item || typeof item !== 'object') return;
        for (const k of ['url', 'outputUrl', 'fileUrl', 'path', 'fileName', 'videoUrl']) {
          const v = item[k];
          if (typeof v === 'string' && v.trim()) collected.push(v.trim());
        }
      });
    }

    // video / audio 对象
    if (data.video) {
      const v = data.video;
      if (typeof v === 'string' && v.trim()) collected.push(v.trim());
      if (typeof v === 'object') {
        for (const k of ['url', 'outputUrl', 'fileUrl', 'path']) {
          const sv = v[k];
          if (typeof sv === 'string' && sv.trim()) collected.push(sv.trim());
        }
      }
    }
    if (data.audio) {
      const a = data.audio;
      if (typeof a === 'string' && a.trim()) collected.push(a.trim());
      if (typeof a === 'object') {
        for (const k of ['url', 'outputUrl', 'fileUrl', 'path']) {
          const sv = a[k];
          if (typeof sv === 'string' && sv.trim()) collected.push(sv.trim());
        }
      }
    }
  }

  // 方法3：从 body 顶层提取
  if (collected.length === 0) {
    for (const k of ['url', 'outputUrl', 'fileUrl', 'downloadUrl', 'path', 'videoUrl', 'audioUrl', 'output_url']) {
      const v = body?.[k];
      if (typeof v === 'string' && v.trim()) collected.push(v.trim());
    }
  }

  // 去重
  const seen = new Set<string>();
  const urls = collected.filter((u) => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  // 优先返回 mp4
  const mp4s = urls.filter((u) => /\.mp4(\?|#|$)/i.test(u));
  return mp4s.length > 0 ? mp4s : urls;
};

/** 从 openapi/v2/query 或 get-status 的失败体中拼出可读说明（含 failedReason.exception_message 首行） */
export const formatRunningHubQueryFailurePayload = (q: any): string => {
  if (!q || typeof q !== 'object') return '任务失败';
  const qMsg = q.errorMessage ?? q.error_message ?? '';
  const qErr = q.errorCode ?? q.error_code ?? '';
  let base = String(qMsg || qErr || '').trim();
  const fr = q.failedReason ?? q.failed_reason;
  if (fr && typeof fr === 'object') {
    const em = fr.exception_message ?? fr.exceptionMessage;
    if (typeof em === 'string' && em.trim()) {
      const first = em
        .split('\n')
        .map((s: string) => s.trim())
        .find(Boolean);
      if (first) return base ? `${base}（${first}）` : first;
    }
    const et = fr.exception_type ?? fr.exceptionType;
    if (typeof et === 'string' && et.trim()) {
      return base ? `${base}（${et}）` : et;
    }
  } else if (typeof fr === 'string' && fr.trim()) {
    return base ? `${base}（${fr}）` : fr;
  }
  return base || '任务失败';
};

/** POST /openapi/v2/query，Body 仅 taskId（与 HM-RunningHub/ComfyUI_RH_OpenAPI core/task.py 一致） */
export const fetchOpenApiV2Query = async (
  apiKey: string,
  taskId: string
): Promise<any | null> => {
  try {
    const r = await fetch(`${OPENAPI_V2_BASE}/query`, {
      method: 'POST',
      headers: makeHeaders(apiKey),
      body: JSON.stringify({ taskId }),
    });
    const raw = await r.text();
    const data = tryParseJson(raw);
    if (!r.ok) {
      console.warn('[RunningHub] openapi/v2/query HTTP 非 2xx:', r.status, raw.slice(0, 200));
      return null;
    }
    return data && typeof data === 'object' ? data : null;
  } catch (err: any) {
    // CORS 或网络错误时不抛出异常，而是返回 null，让调用方继续轮询
    console.warn('[RunningHub] openapi/v2/query 网络错误（CORS 或连接问题）:', err.message);
    return null;
  }
};

/** 轮询 OpenAPI v2 任务直到拿到媒体 URL 或失败/超时
 * 视频生成较慢，默认间隔 30 秒，最大 25 分钟
 */
const pollOpenApiV2ForOutputUrls = async (
  apiKey: string,
  taskId: string,
  opts?: { maxMs?: number; intervalMs?: number }
): Promise<string[]> => {
  const maxMs = opts?.maxMs ?? 25 * 60 * 1000;  // 默认 25 分钟
  const intervalMs = opts?.intervalMs ?? 30000;  // 默认 30 秒
  const t0 = Date.now();

  // 辅助函数：尝试 get-outputs 获取 URL
  const tryGetOutputs = async (): Promise<string[]> => {
    try {
      const r = await fetch(`${BASE_URL}/task/openapi/get-outputs`, {
        method: 'POST',
        headers: makeHeaders(apiKey),
        body: JSON.stringify({ apiKey, taskId }),
      });
      if (!r.ok) return [];
      const raw = await r.text();
      try {
        const data = JSON.parse(raw);
        // 优先使用增强的 extractUrlsFromOpenApiV2Results
        const urls = extractUrlsFromOpenApiV2Results(data);
        if (urls.length > 0) return urls;
        // 兜底：从 data.files / data.outputs 提取
        const files = data.data?.files || data.data?.outputs || data.files || data.outputs || [];
        if (Array.isArray(files) && files.length > 0) {
          const results: string[] = [];
          for (const f of files) {
            if (f?.url) results.push(f.url);
            if (f?.fileUrl) results.push(f.fileUrl);
            if (f?.fileName) results.push(f.fileName);
          }
          if (results.length > 0) return results;
        }
      } catch { /* ignore */ }
    } catch { /* ignore */ }
    return [];
  };

  while (Date.now() - t0 < maxMs) {
    await new Promise((res) => setTimeout(res, intervalMs));
    const data = await fetchOpenApiV2Query(apiKey, taskId);
    if (!data) continue;

    const errCode = data.errorCode ?? data.error_code ?? '';
    const errMsg = data.errorMessage ?? data.error_message ?? '';
    if (errCode || errMsg) {
      throw new Error(String(errMsg || errCode));
    }

    const st = String(data.status || '').toUpperCase();

    if (st === 'SUCCESS') {
      // 首次 query 提取 URL
      let urls = extractUrlsFromOpenApiV2Results(data);
      if (urls.length > 0) return urls;
      // 二次 query 重试
      const retryData = await fetchOpenApiV2Query(apiKey, taskId);
      urls = extractUrlsFromOpenApiV2Results(retryData || {});
      if (urls.length > 0) return urls;
      // 尝试 get-outputs
      urls = await tryGetOutputs();
      if (urls.length > 0) return urls;
      // 三次 query（兜底）
      const retry2 = await fetchOpenApiV2Query(apiKey, taskId);
      urls = extractUrlsFromOpenApiV2Results(retry2 || {});
      if (urls.length > 0) return urls;
    }
    if (st === 'FAILED') {
      throw new Error(String(errMsg || '任务失败'));
    }
    // 每 15 次轮询（约 45 秒）输出日志
    const elapsed = Date.now() - t0;
    if (elapsed > 0 && elapsed % (15 * intervalMs) < intervalMs) {
      console.log(`[RunningHub] 任务轮询中 ${Math.round(elapsed / 1000)}s…`);
    }
  }
  throw new Error(`任务超时（${Math.round(maxMs / 1000)}s），请稍后在 RunningHub 控制台查看任务 ${taskId?.slice(0, 16)}… 是否已完成`);
};

const ASPECT_PRESETS_COLON = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '5:4',
  '4:5',
  '21:9',
] as const;

const closestColonAspectRatio = (w: number, h: number): string => {
  const r = w / Math.max(h, 1);
  let best = ASPECT_PRESETS_COLON[0];
  let bestDiff = Infinity;
  for (const s of ASPECT_PRESETS_COLON) {
    const [a, b] = s.split(':').map(Number);
    const ratio = a / b;
    const d = Math.abs(r - ratio);
    if (d < bestDiff) {
      bestDiff = d;
      best = s;
    }
  }
  // 图生图接口仅接受预设比例，避免传平台不认识的 "W:H"
  return best;
};

/** Flux f-2-dev：API 接受真实比例字符串；不匹配预设时仍传 best + customWidth + customHeight */
const fluxAspectSelect = (
  w: number,
  h: number
): { select: string; cw?: number; ch?: number } => {
  const cw = Math.min(1536, Math.max(256, Math.round(w)));
  const ch = Math.min(1536, Math.max(256, Math.round(h)));
  const r = cw / ch;
  const map: [string, number][] = [
    ['1:1', 1],
    ['3:4', 3 / 4],
    ['4:3', 4 / 3],
    ['9:16', 9 / 16],
    ['16:9', 16 / 9],
    ['2:3', 2 / 3],
    ['3:2', 3 / 2],
  ];
  let best = map[0][0];
  let bd = Infinity;
  for (const [label, ratio] of map) {
    const d = Math.abs(r - ratio);
    if (d < bd) {
      bd = d;
      best = label;
    }
  }
  return { select: best, cw: bd > 0.06 ? cw : undefined, ch: bd > 0.06 ? ch : undefined };
};

/** Qwen image 2512：API 接受真实比例字符串 '1:1','3:4',...（非内部代码）；不匹配时 fallback custom */
const qwenAspectSelect = (
  w: number,
  h: number
): { select: string; cw?: number; ch?: number } => {
  const cw = Math.min(5000, Math.max(1, Math.round(w)));
  const ch = Math.min(5000, Math.max(1, Math.round(h)));
  const r = cw / ch;
  const map: [string, number][] = [
    ['1:1', 1],
    ['3:4', 3 / 4],
    ['4:3', 4 / 3],
    ['9:16', 9 / 16],
    ['16:9', 16 / 9],
    ['2:3', 2 / 3],
    ['3:2', 3 / 2],
  ];
  let best = map[0][0];
  let bd = Infinity;
  for (const [label, ratio] of map) {
    const d = Math.abs(r - ratio);
    if (d < bd) {
      bd = d;
      best = label;
    }
  }
  if (bd > 0.06) return { select: best, cw, ch };
  return { select: best };
};

/** Z-Image turbo-lora：API 接受真实比例字符串；不匹配时 fallback '1:1'（无 custom） */
const zImageAspectSelect = (w: number, h: number): string => {
  const r = w / Math.max(h, 1);
  const map: [string, number][] = [
    ['1:1', 1],
    ['3:4', 3 / 4],
    ['4:3', 4 / 3],
    ['9:16', 9 / 16],
    ['16:9', 16 / 9],
    ['2:3', 2 / 3],
    ['3:2', 3 / 2],
  ];
  let best = map[0][0];
  let bd = Infinity;
  for (const [label, ratio] of map) {
    const d = Math.abs(r - ratio);
    if (d < bd) {
      bd = d;
      best = label;
    }
  }
  return best;
};

const resolutionFromDimensions = (w: number, h: number): '1k' | '2k' | '4k' => {
  const m = Math.max(w, h);
  if (m >= 3000) return '4k';
  if (m >= 1600) return '2k';
  return '1k';
};

/**
 * 生成图片：走官方 OpenAPI v2（非 /v1/images/generations，否则会 401）
 * 提交后异步任务，通过 POST /openapi/v2/query 轮询 results[].url
 */
export const generateImage = async (
  apiKey: string,
  options: RunningHubImageOptions
): Promise<RunningHubResult> => {
  try {
    const w = options.width ?? 1024;
    const h = options.height ?? 1024;

    let endpoint: string;
    let body: Record<string, any>;

    if (options.image_url) {
      endpoint = '/rhart-image-n-g31-flash-official/image-to-image';
      body = {
        imageUrls: [options.image_url],
        prompt: options.prompt,
        aspectRatio: closestColonAspectRatio(w, h),
        resolution: resolutionFromDimensions(w, h),
      };
    } else if (options.model === 'flux') {
      endpoint = '/rhart-image/f-2-dev/text-to-image';
      const fa = fluxAspectSelect(w, h);
      body = {
        prompt: options.prompt,
        aspectRatio: fa.select,
        outputFormat: 'png',
      };
      if (fa.cw != null && fa.ch != null) {
        body.aspectRatio = 'custom';
        body.customWidth = fa.cw;
        body.customHeight = fa.ch;
      }
    } else if (options.model === 'z-image') {
      endpoint = '/rhart-image/z-image/turbo-lora';
      body = {
        prompt: options.prompt,
        aspectRatio: zImageAspectSelect(w, h),
        outputFormat: 'png',
      };
    } else if (options.model === 'qwen-image') {
      endpoint = '/rhart-image/qwen-image/text-to-image-2512';
      const qa = qwenAspectSelect(w, h);
      body = {
        prompt: options.prompt,
        aspectRatio: qa.select,
        outputFormat: 'png',
      };
      if (qa.cw != null && qa.ch != null) {
        body.aspectRatio = 'custom';
        body.customWidth = qa.cw;
        body.customHeight = qa.ch;
      }
    } else {
      throw new Error(`不支持的 RunningHub 图片模型: ${options.model}`);
    }

    const url = `${OPENAPI_V2_BASE}${endpoint}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: makeHeaders(apiKey),
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    const data = tryParseJson(raw);

    if (!response.ok) {
      throw new Error(
        data.errorMessage || data.message || data.msg || raw || `HTTP ${response.status}`
      );
    }

    const errCode = data.errorCode ?? data.error_code ?? '';
    const errMsg = data.errorMessage ?? data.error_message ?? '';
    if (errCode || errMsg) {
      throw new Error(String(errMsg || errCode));
    }

    let urls = extractUrlsFromOpenApiV2Results(data);
    const taskId = data.taskId != null ? String(data.taskId) : undefined;

    if (urls.length === 0 && taskId) {
      urls = await pollOpenApiV2ForOutputUrls(apiKey, taskId);
    }

    if (urls.length === 0) {
      throw new Error('图片生成完成但未返回 URL');
    }

    const resolved = urls.map(resolveRunningHubOutputUrl);
    return {
      success: true,
      data,
      taskId,
      url: resolved[0],
      urls: resolved.length > 1 ? resolved : undefined,
    };
  } catch (error: any) {
    console.error('[RunningHub] 图片生成失败:', error);
    return { success: false, error: error.message || '图片生成失败' };
  }
};

/**
 * 上传图片到 RunningHub（/task/openapi/upload）
 * 导出供其他模块使用（如即梦图生视频需要先上传图片到 RunningHub）
 */
export const uploadImageToRunningHub = async (apiKey: string, imageUrl: string): Promise<string> => {
  if (!imageUrl) {
    throw new Error('图片 URL 为空');
  }

  // 检查 URL 格式
  console.log('[RunningHub] uploadImage 开始，URL 长度:', imageUrl.length, 'URL 前缀:', imageUrl.slice(0, 50));
  console.log('[RunningHub] URL 类型判断:', {
    isDataUrl: imageUrl.startsWith('data:'),
    isBlob: imageUrl.startsWith('blob:'),
    isHttp: imageUrl.startsWith('http'),
    isRelative: !imageUrl.startsWith('data:') && !imageUrl.startsWith('blob:') && !imageUrl.startsWith('http')
  });

  // 如果已经是 RunningHub 的图片路径，直接返回
  if (imageUrl.includes('runninghub.cn') || imageUrl.includes('rh-images') || imageUrl.includes('/uploads/')) {
    console.log('[RunningHub] 已是 RunningHub 图片路径，直接返回:', imageUrl);
    return imageUrl;
  }

  let imageBlob: Blob;

  if (imageUrl.startsWith('data:')) {
    // data:image/png;base64,... → 解码为 Blob
    try {
      const [header, base64data] = imageUrl.split(',', 2);
      const binary = atob(base64data);
      const arr = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
      const mimeType = imageUrl.match(/^data:([^;]+)/)?.[1] || 'image/png';
      imageBlob = new Blob([arr], { type: mimeType });
      console.log('[RunningHub] data URL 解码成功，blob size:', imageBlob.size);
    } catch (decodeError: any) {
      console.error('[RunningHub] data URL 解码失败:', decodeError);
      throw new Error(`data URL 解码失败: ${decodeError?.message}`);
    }
  } else if (imageUrl.startsWith('blob:')) {
    // blob: URL → 多种方式尝试读取
    console.log('[RunningHub] 尝试读取 blob URL:', imageUrl.slice(0, 80));

    // 方式1：fetch（浏览器会自动解析 blob: 协议）
    try {
      const resp = await fetch(imageUrl);
      if (!resp.ok) throw new Error(`fetch ${resp.status}: ${resp.statusText}`);
      imageBlob = await resp.blob();
      console.log('[RunningHub] blob URL fetch 成功，blob size:', imageBlob.size);
    } catch (fetchError: any) {
      console.warn('[RunningHub] blob URL fetch 失败:', fetchError?.message);

      // 方式2：XMLHttpRequest 兜底
      try {
        imageBlob = await new Promise<Blob>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', imageUrl);
          xhr.responseType = 'blob';
          xhr.timeout = 30000;
          xhr.onload = () => {
            console.log('[RunningHub] XMLHttpRequest 成功，blob size:', xhr.response?.size);
            resolve(xhr.response);
          };
          xhr.onerror = () => reject(new Error('XMLHttpRequest onerror'));
          xhr.ontimeout = () => reject(new Error('XMLHttpRequest timeout'));
          xhr.send();
        });
      } catch (xhrError: any) {
        console.error('[RunningHub] blob URL 所有方法均失败:', {
          fetchError: fetchError?.message,
          xhrError: xhrError?.message
        });
        throw new Error(`blob URL 读取失败 (fetch: ${fetchError?.message}, xhr: ${xhrError?.message})。请尝试重新生成图片后再次生成视频。`);
      }
    }
  } else if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
    // 相对路径 → 拼完整地址走 fetch
    const resolvedUrl = `${window.location.origin}/${imageUrl.replace(/^\//, '')}`;
    console.log('[RunningHub] 读取相对路径图片:', resolvedUrl);
    try {
      const resp = await fetch(resolvedUrl);
      if (!resp.ok) throw new Error(`无法获取图片: ${resp.status} ${resp.statusText}`);
      imageBlob = await resp.blob();
      console.log('[RunningHub] 相对路径图片读取成功，blob size:', imageBlob.size);
    } catch (e: any) {
      console.error('[RunningHub] 相对路径图片读取失败:', e?.message);
      throw new Error(`相对路径图片读取失败: ${e?.message}。请尝试重新生成图片后再次生成视频。`);
    }
  } else {
    // 普通 http/https URL
    console.log('[RunningHub] 读取普通 URL 图片:', imageUrl.slice(0, 120));
    try {
      imageBlob = await fetchRemoteImageAsBlob(imageUrl);
      console.log('[RunningHub] 普通 URL 图片读取成功，blob size:', imageBlob.size);
    } catch (e: any) {
      console.error('[RunningHub] 普通 URL 图片读取失败:', e?.message);
      // 提供更友好的错误提示
      const errorHint = e?.message?.includes('CORS') || e?.message?.includes('Failed to fetch')
        ? '图片链接无法被服务器访问，可能是临时链接或需要先上传到 RunningHub。请尝试重新生成图片后再次生成视频。'
        : e?.message;
      throw new Error(`图片 URL 读取失败: ${errorHint}`);
    }
  }

  const formData = new FormData();
  formData.append('file', imageBlob, 'image.jpg');
  formData.append('fileType', 'image');
  formData.append('apiKey', apiKey);

  console.log('[RunningHub] 开始上传图片到 RunningHub，blob size:', imageBlob.size, 'mime:', imageBlob.type);
  console.log('[RunningHub] 上传端点:', `${BASE_URL}/task/openapi/upload`);

  const uploadResponse = await fetch(`${BASE_URL}/task/openapi/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
  });

  console.log('[RunningHub] 上传响应状态:', uploadResponse.status, uploadResponse.statusText);

  if (!uploadResponse.ok) {
    const raw = await uploadResponse.text();
    console.error('[RunningHub] 上传失败，响应:', raw.slice(0, 500));
    throw new Error(`图片上传失败: ${raw}`);
  }

  const data = await uploadResponse.json();
  console.log('[RunningHub] 上传成功，响应数据:', JSON.stringify(data).slice(0, 200));
  if (data.code !== 0) throw new Error(`图片上传失败: ${data.msg || data.message}`);

  // 返回相对路径（不带 base URL），ComfyUI LoadImageFromUrl 节点会自行拼接完整 URL
  // ⚠️ 传完整 URL（如 https://www.runninghub.cn/api/xxx.jpg）会导致 ComfyUI
  //   HTTP 下载时拿到无效内容（403/401/重定向页面），PIL 无法识别为图片
  const uploadedPath = data.data?.fileName || data.data?.filePath || imageUrl;
  const relativePath = (uploadedPath || '').startsWith('/')
    ? uploadedPath
    : `/${uploadedPath}`;
  return relativePath;
};

/**
 * 上传参考音频到 RunningHub（与图片同一 openapi/upload，fileType 使用 audio）
 */
export const uploadAudioToRunningHub = async (
  apiKey: string,
  audioUrl: string
): Promise<string> => {
  const trimmed = (audioUrl || '').trim();
  if (trimmed.startsWith('api/')) return trimmed;

  let resolvedUrl = trimmed;
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
    resolvedUrl = trimmed;
  } else if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    resolvedUrl = `${window.location.origin}/${trimmed.replace(/^\//, '')}`;
  }

  const res = await fetch(resolvedUrl);
  if (!res.ok) throw new Error(`无法读取音频数据: ${resolvedUrl}`);

  const blob = await res.blob();
  const ext =
    blob.type.includes('mpeg') || blob.type.includes('mp3')
      ? 'mp3'
      : blob.type.includes('mp4') || blob.type.includes('m4a')
        ? 'm4a'
        : 'wav';
  const formData = new FormData();
  formData.append('file', blob, `voice_ref.${ext}`);
  formData.append('fileType', 'audio');
  formData.append('apiKey', apiKey);

  const uploadResponse = await fetch(`${BASE_URL}/task/openapi/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!uploadResponse.ok) {
    const raw = await uploadResponse.text();
    throw new Error(`音频上传失败: ${raw}`);
  }

  const data = await uploadResponse.json();
  if (data.code !== 0) {
    throw new Error(`音频上传失败: ${data.msg || data.message || '未知错误'}`);
  }
  const path = data.data?.fileName || data.data?.filePath;
  if (!path || typeof path !== 'string') {
    throw new Error('音频上传成功但未返回文件路径');
  }
  return path;
};

/**
 * 生成视频
 * - LTX-2：POST /task/openapi/create + 完整 workflow JSON（见 api-425749013）
 * - Wan2.2：POST /openapi/v2/run/ai-app/1894637279242027010 + nodeInfoList（与官方 curl 示例一致）
 *
 * Header：Authorization=Bearer {apiKey}，Content-Type=application/json
 */
/** Wan2.2 图生视频：官方 run/ai-app 模板 ID */
const WAN22_AI_APP_RUN_ID = '1950058606949523457';

/**
 * 默认 TTS / 配音：POST /openapi/v2/run/ai-app/{id}
 * 控制台 API 说明：https://www.runninghub.cn/call-api/api-detail/1986388299516411905?apiType=4
 *
 * ⚠️ 节点 ID 必须与控制台「调用 API」里显示的完全一致（JSON workflow 中的实际编号）。
 *   - 文本字段：nodeId='14'，fieldName='value'
 *   - 参考音频（主）：nodeId='13'，fieldName='audio'（可在语音库配置 runningHubAudioPath）
 *   - 情感音频（次）：nodeId='15'，fieldName='audio'（可复用主参考音频）
 */
const TTS_AI_APP_RUN_ID = '1986388299516411905';
const TTS_TEXT_NODE_ID = '14';
const TTS_TEXT_FIELD = 'value';
const TTS_AUDIO_NODE_ID = '13';
const TTS_EMO_NODE_ID = '15';

const extractTaskIdFromRunResponse = (data: any): string | undefined => {
  if (!data || typeof data !== 'object') return undefined;
  const tid =
    data.taskId ??
    data.task_id ??
    data.data?.taskId ??
    data.data?.task_id;
  if (tid != null && String(tid).trim() !== '') return String(tid);
  return undefined;
};

export const generateVideo = async (
  apiKey: string,
  options: RunningHubVideoOptions
): Promise<RunningHubResult> => {
  try {
    // 官方要求固定 header
    const headers = makeHeaders(apiKey);

    // ── LTX-2 路径：完整 workflow JSON ────────────────────────────────────
    if (options.workflow || options.workflowTemplate) {
      const workflowId = '2033053099966865410';
      let wf: Record<string, any>;
      if (options.workflow) {
        wf = JSON.parse(JSON.stringify(options.workflow));
      } else {
        wf = JSON.parse(options.workflowTemplate!);
      }

      let uploadedImagePath: string | undefined;
      if (options.image_url) {
        try {
          uploadedImagePath = await uploadImageToRunningHub(apiKey, options.image_url);
          console.log('[RunningHub] LTX-2 图片上传成功:', uploadedImagePath);
        } catch (e: any) {
          throw new Error(`图片上传失败: ${e.message}`);
        }
      }

      // 替换关键节点
      if (uploadedImagePath && wf['269']) {
        // 去掉前导斜杠，与 RunningHub 成功示例保持一致（api/xxx.jpg 而非 /api/xxx.jpg）
        wf['269'].inputs.image = uploadedImagePath.replace(/^\/+/, '');
      }
      if (options.prompt && wf['325']) wf['325'].inputs.value = options.prompt;
      if (options.duration && wf['301']) wf['301'].inputs.value = Math.round(options.duration * 24);

      const requestBody = {
        apiKey,
        workflowId,
        workflow: JSON.stringify(wf),
        instanceType: 'plus',
        usePersonalQueue: false,
      };

      console.log('[RunningHub] LTX-2 请求:', { endpoint: `${BASE_URL}/task/openapi/create`, workflowId });

      const response = await fetch(`${BASE_URL}/task/openapi/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      const raw = await response.text();
      console.log('[RunningHub] LTX-2 响应:', { status: response.status, raw: raw.slice(0, 600) });

      if (!response.ok) {
        let data: any = {};
        try { data = JSON.parse(raw); } catch { /* ignore */ }
        throw new Error(data.msg || data.errorMessage || raw || `HTTP ${response.status}`);
      }

      const data = JSON.parse(raw);
      if (data.code !== 0 || !data.data?.taskId) {
        throw new Error(data.msg || data.errorMessage || 'LTX-2 视频生成失败（无 taskId）');
      }

      return { success: true, data, taskId: String(data.data.taskId), status: data.data.taskStatus || 'QUEUED', progress: 0 };
    }

    // ── Wan2.2：POST /openapi/v2/run/ai-app/{id}（与官方 curl 示例一致）───
    if (options.model !== 'wan2.2') {
      throw new Error('当前仅支持 LTX-2（workflow）与 Wan2.2（ai-app）视频模型');
    }
    if (!options.image_url) throw new Error('图生视频模式需要提供图片URL');

    let uploadedImagePath: string | undefined;
    try {
      uploadedImagePath = await uploadImageToRunningHub(apiKey, options.image_url);
      console.log('[RunningHub] Wan2.2 图片上传成功:', uploadedImagePath);
    } catch (e: any) {
      throw new Error(`图片上传失败: ${e.message}. 图生视频需要先上传图片`);
    }

    const seconds = Math.round(Math.max(1, options.duration ?? 5));
    // 宽高比默认 9:16（竖版），宽 848，高 480；allow wider 16:9
    const targetWidth = Math.max(256, Math.min(1280, options.maxResolutionPixels ?? 848));
    const targetHeight = Math.round(targetWidth * 9 / 16);

    const nodeInfoList: Array<{
      nodeId: string;
      fieldName: string;
      fieldValue: string;
      description: string;
    }> = [
      {
        nodeId: '67',
        fieldName: 'image',
        // 纯文件名（无 api/ 前缀），与官方 curl 示例一致：xxx.webp 而非 api/xxx.webp
        fieldValue: uploadedImagePath.replace(/^api\//, '').replace(/^\/+/, ''),
        description: '上传参考图像',
      },
      {
        nodeId: '98',
        fieldName: 'text',
        fieldValue: options.prompt || '',
        description: '输入提示词',
      },
      {
        nodeId: '111',
        fieldName: 'int',
        fieldValue: String(targetWidth),
        description: '输入视频宽度',
      },
      {
        nodeId: '112',
        fieldName: 'int',
        fieldValue: String(targetHeight),
        description: '输入视频高度',
      },
      {
        nodeId: '114',
        fieldName: 'int',
        fieldValue: String(seconds),
        description: '输入视频时长(秒)',
      },
    ];

    const requestBody = {
      nodeInfoList,
      instanceType: 'default',
      usePersonalQueue: 'false' as const,
    };

    const runUrl = `${OPENAPI_V2_BASE}/run/ai-app/${WAN22_AI_APP_RUN_ID}`;
    console.log('[RunningHub] Wan2.2 ai-app 请求:', { endpoint: runUrl, seconds, targetWidth, targetHeight });

    const response = await fetch(runUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    const raw = await response.text();
    console.log('[RunningHub] Wan2.2 ai-app 响应:', { status: response.status, raw: raw.slice(0, 800) });

    let data: any = {};
    try {
      data = JSON.parse(raw);
    } catch {
      if (!response.ok) throw new Error(raw || `HTTP ${response.status}`);
      throw new Error('Wan2.2 响应不是有效 JSON');
    }

    if (!response.ok) {
      throw new Error(
        data.errorMessage || data.message || data.msg || raw || `HTTP ${response.status}`
      );
    }

    const errCode = data.errorCode ?? data.error_code ?? '';
    const errMsg = data.errorMessage ?? data.error_message ?? '';
    if (errCode || errMsg) {
      throw new Error(String(errMsg || errCode));
    }

    const taskId = extractTaskIdFromRunResponse(data);
    if (!taskId) {
      if (data.code != null && data.code !== 0) {
        throw new Error(data.msg || data.message || 'Wan2.2 视频生成失败');
      }
      throw new Error(data.msg || data.message || 'Wan2.2 视频生成失败（无 taskId）');
    }

    const taskStatus =
      data.status ||
      data.data?.taskStatus ||
      data.data?.status ||
      'QUEUED';

    return {
      success: true,
      data,
      taskId,
      status: String(taskStatus),
      progress: 0,
    };
  } catch (error: any) {
    console.error('[RunningHub] 视频生成失败:', error);
    return { success: false, error: error.message || '视频生成失败' };
  }
};

/**
 * IndexTTS2 工作流配音：POST /task/openapi/create（与控制台 curl 一致）
 * 文案写入节点 29（KepStringLiteral.inputs.String）
 */
export const createIndexTts2VoiceoverTask = async (
  apiKey: string,
  captionText: string,
  opts?: { loadAudioApiPath?: string }
): Promise<RunningHubResult> => {
  try {
    const headers = makeHeaders(apiKey);
    const wf = JSON.parse(JSON.stringify(INDEXTTS2_WORKFLOW_TEMPLATE)) as Record<string, any>;
    const node29 = wf['29'];
    if (!node29?.inputs) {
      throw new Error('IndexTTS2 工作流模板缺少节点 29');
    }
    const rawCaption = (captionText || '').trim();
    node29.inputs.String = rawCaption;
    console.log('[RunningHub] IndexTTS2 提交原文（不改字）:', {
      rawLen: rawCaption.length,
      preview: rawCaption.slice(0, 80),
    });

    const node25 = wf['25'];
    if (opts?.loadAudioApiPath && node25?.inputs) {
      node25.inputs.audio = opts.loadAudioApiPath;
    }

    const requestBody = {
      apiKey,
      workflowId: INDEXTTS2_RUNNINGHUB_WORKFLOW_ID,
      workflow: JSON.stringify(wf),
      randomSeed: true,
      retainSeconds: 0,
      usePersonalQueue: false,
    };

    const response = await fetch(`${BASE_URL}/task/openapi/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    const raw = await response.text();
    console.log('[RunningHub] IndexTTS2 create 响应:', { status: response.status, raw: raw.slice(0, 500) });

    if (!response.ok) {
      let data: any = {};
      try {
        data = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      throw new Error(data.msg || data.errorMessage || raw || `HTTP ${response.status}`);
    }

    const data = JSON.parse(raw);
    if (data.code !== 0 || !data.data?.taskId) {
      throw new Error(data.msg || data.errorMessage || '配音任务提交失败（无 taskId）');
    }

    return {
      success: true,
      data,
      taskId: String(data.data.taskId),
      status: data.data.taskStatus || 'QUEUED',
      progress: 0,
    };
  } catch (error: any) {
    console.error('[RunningHub] IndexTTS2 配音任务提交失败:', error);
    return { success: false, error: error.message || '配音任务提交失败' };
  }
};

/**
 * 轮询直至任务产出媒体 URL（配音常为 wav/flac/mp3，视频为 mp4）
 * 配音一般较快，间隔 30 秒，最大 25 分钟
 */
const pollRunningHubUntilMediaUrl = async (
  apiKey: string,
  taskId: string,
  maxAttempts = 50,  // 50 * 30s = 25 分钟
  intervalMs = 30000  // 30 秒
): Promise<string> => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, intervalMs));
    const result = await checkTaskStatus(apiKey, taskId);
    if (result.success === false && String(result.status).toUpperCase() === 'FAILED') {
      throw new Error(result.error || '配音任务失败');
    }
    if (result.url) return resolveRunningHubOutputUrl(result.url);
    // 每 15 次轮询（约 37.5 秒）输出一次日志，让用户感知到仍在等待
    if (attempt > 0 && attempt % 15 === 0) {
      console.log(`[RunningHub] 配音轮询中 ${Math.round((attempt * intervalMs) / 1000)}s…`);
    }
  }
  throw new Error(`轮询超时（${maxAttempts * intervalMs / 1000}s），请稍后在 RunningHub 控制台查看任务 ${taskId?.slice(0, 16)}… 是否已完成`);
};

/**
 * 生成音频 TTS：OpenAPI v2「快捷创作」run/ai-app（非已废弃的 /v1/audio/speech，避免 401）
 */
export const generateAudio = async (
  apiKey: string,
  options: RunningHubAudioOptions
): Promise<RunningHubResult> => {
  try {
    const headers = makeHeaders(apiKey);
    const text = (options.text || '').trim();
    if (!text) {
      return { success: false, error: '配音文本为空' };
    }

    // 模板 1986388299516411905 要求节点 13/15 的参考音与 14 的文案同时存在
    // 用户上传了自定义音色则优先用之；否则根据文案语言自动选择参考音
    const lang = options.referenceLanguage === 'auto' || !options.referenceLanguage
      ? detectPrimaryLanguage(text)
      : (options.referenceLanguage === 'en' ? 'en' : 'zh');
    const refAudio = options.referenceAudioPath?.trim() || INDEXTTS2_DEFAULT_REFERENCE_AUDIO_PATH;

    const nodeInfoList: Array<{
      nodeId: string;
      fieldName: string;
      fieldValue: string;
      description: string;
    }> = [
      {
        nodeId: TTS_AUDIO_NODE_ID,
        fieldName: 'audio',
        fieldValue: refAudio,
        description: '输入人物音频（重要）',
      },
      {
        nodeId: TTS_EMO_NODE_ID,
        fieldName: 'audio',
        fieldValue: refAudio,
        description: '加载情感（次要）',
      },
      {
        nodeId: TTS_TEXT_NODE_ID,
        fieldName: TTS_TEXT_FIELD,
        fieldValue: text,
        description: '输入提示词',
      },
    ];

    const requestBody = {
      nodeInfoList,
      instanceType: 'default' as const,
      usePersonalQueue: 'false' as const,
      // 不改文案，仅优化朗读方式（若后端忽略这些字段也不影响主流程）
      prosody_enhance: options.prosodyEnhance ?? true,
      breath: options.breath ?? true,
      auto_pause: options.autoPause ?? true,
      pause_strength: options.pauseStrength ?? 0.7,
      emphasis_strength: options.emphasisStrength ?? 0.5,
      speed: options.speed ?? 1.0,
      pitch: options.pitch ?? 0,
      volume: options.volume ?? 1.0,
    };

    const runUrl = `${OPENAPI_V2_BASE}/run/ai-app/${TTS_AI_APP_RUN_ID}`;
    console.log('[RunningHub] TTS ai-app 请求:', {
      endpoint: runUrl,
      textLen: text.length,
      refAudio: refAudio?.slice(0, 80),
      speed: requestBody.speed,
    });

    const response = await fetch(runUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    const raw = await response.text();
    let data: any = {};
    try {
      data = JSON.parse(raw);
    } catch {
      /* not JSON — e.g. 500 error page */
    }

    if (!response.ok) {
      const status = response.status;
      const serverMsg = data?.errorMessage || data?.message || data?.msg || '';
      const htmlHint = !data?.code && raw.toLowerCase().includes('<!doctype') ? '（服务器返回 HTML，可能是接口临时不可用）' : '';
      const errText = serverMsg || (raw.length > 200 ? raw.slice(0, 200) + '…' : raw) || `HTTP ${status}`;
      console.error(`[RunningHub] TTS HTTP ${status}:`, errText);
      return { success: false, error: `${errText}${htmlHint}` };
    }

    const errCode = data.errorCode ?? data.error_code ?? '';
    const errMsg = data.errorMessage ?? data.error_message ?? '';
    if (errCode || errMsg) {
      return { success: false, error: String(errMsg || errCode) };
    }

    const taskId = extractTaskIdFromRunResponse(data);
    if (!taskId) {
      if (data.code != null && data.code !== 0) {
        return { success: false, error: data.msg || data.message || 'TTS 提交失败' };
      }
      return { success: false, error: data.msg || data.message || 'TTS 提交失败（无 taskId）' };
    }

    const audioUrl = await pollRunningHubUntilMediaUrl(apiKey, taskId);
    return { success: true, data, url: audioUrl, taskId, status: 'SUCCESS' };
  } catch (error: any) {
    console.error('[RunningHub] 音频生成失败:', error);
    return { success: false, error: error.message || '音频生成失败' };
  }
};

/** 自动重试次数（不含首次请求），共 1 + TTS_AUTO_RETRY_COUNT 次 */
export const TTS_AUTO_RETRY_COUNT = 2;

export type GenerateAudioRetryHooks = {
  onRetry?: (info: {
    /** 即将执行的第几次请求（2 表示第 2 次尝试） */
    attemptNumber: number;
    maxAttempts: number;
    error: string;
    delayMs: number;
  }) => void;
};

/**
 * 与 {@link generateAudio} 相同，但在 success===false 时自动重试，缓解网络抖动与服务器显存/队列瞬时失败。
 * 轮询超时时额外尝试直接查询任务状态（后台可能已完成但轮询未能获取 URL）。
 */
export const generateAudioWithRetry = async (
  apiKey: string,
  options: RunningHubAudioOptions,
  hooks?: GenerateAudioRetryHooks
): Promise<RunningHubResult> => {
  const maxAttempts = 1 + TTS_AUTO_RETRY_COUNT;
  let last: RunningHubResult = { success: false, error: 'TTS 未知错误' };
  for (let i = 0; i < maxAttempts; i++) {
    last = await generateAudio(apiKey, options);
    if (last.success) return last;

    // 轮询超时时，尝试直接查询任务状态（后台可能已完成但轮询未获取到 URL）
    if (last.error?.includes('轮询超时') || last.error?.includes('超时')) {
      const taskId = last.taskId;
      if (taskId) {
        hooks?.onRetry?.({
          attemptNumber: i + 1,
          maxAttempts,
          error: `轮询超时，尝试直接查询任务 ${taskId.slice(0, 16)}…`,
          delayMs: 0,
        });
        const statusResult = await checkTaskStatus(apiKey, taskId);
        if (statusResult.success && statusResult.url) {
          return { ...statusResult, success: true };
        }
      }
    }

    if (i < maxAttempts - 1) {
      const delayMs = 700 * (i + 1) * (i + 1);
      const errStr = (last.error || '失败').slice(0, 160);
      hooks?.onRetry?.({
        attemptNumber: i + 2,
        maxAttempts,
        error: errStr,
        delayMs,
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return last;
};

/**
 * 查询任务状态：优先 POST /openapi/v2/query（Comfy 任务完成后 get-outputs 常返回业务 404，统一 query 可拿到 results[].url）
 * 失败时再回退 /task/openapi/get-outputs + get-status
 */
export const checkTaskStatus = async (
  apiKey: string,
  taskId: string
): Promise<RunningHubResult> => {
  const tryParse = (raw: string): any => {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  };

  const doOutputs = async () => {
    try {
      const r = await fetch(`${BASE_URL}/task/openapi/get-outputs`, {
        method: 'POST',
        headers: makeHeaders(apiKey),
        body: JSON.stringify({ apiKey, taskId }),
      });
      const raw = await r.text();
      return { ok: r.ok, status: r.status, data: tryParse(raw), raw };
    } catch (err: any) {
      // CORS 或网络错误时返回失败状态，让调用方继续轮询
      console.warn('[RunningHub] doOutputs 网络错误（CORS 或连接问题）:', err.message);
      return { ok: false, status: 0, data: null, raw: '', networkError: true };
    }
  };

  const doStatus = async () => {
    try {
      const r = await fetch(`${BASE_URL}/task/openapi/get-status`, {
        method: 'POST',
        headers: makeHeaders(apiKey),
        body: JSON.stringify({ apiKey, taskId }),
      });
      const raw = await r.text();
      return { ok: r.ok, status: r.status, data: tryParse(raw), raw };
    } catch (err: any) {
      // CORS 或网络错误时返回失败状态，让调用方继续轮询
      console.warn('[RunningHub] doStatus 网络错误（CORS 或连接问题）:', err.message);
      return { ok: false, status: 0, data: null, raw: '', networkError: true };
    }
  };

  const extractFromResults = (d: any): string | undefined => {
    if (!d || typeof d !== 'object') return undefined;
    const results = d.results;
    if (results && Array.isArray(results) && results.length > 0) {
      const vids = results.filter(
        (x: any) => x.outputType === 'mp4' || x.url?.includes?.('.mp4') || x.fileUrl?.includes?.('.mp4')
      );
      const pick = vids.length > 0 ? vids[0] : results[0];
      return pick?.url || pick?.fileUrl || pick?.fileName;
    }
    return undefined;
  };

  const extractFromData = (d: any): string | undefined => {
    if (!d || typeof d !== 'object') return undefined;
    const files = d.files || d.outputs || [];
    const vid = files.find(
      (f: any) =>
        f.url?.includes?.('.mp4') ||
        f.fileName?.includes?.('.mp4') ||
        f.fileUrl?.includes?.('.mp4') ||
        f.outputType === 'mp4'
    );
    if (vid) return vid.url || vid.fileUrl || vid.fileName;
    if (files.length > 0) return files[0].url || files[0].fileUrl || files[0].fileName;
    return d.videoUrl || d.video_url || d.url || d.outputUrl;
  };

  /** 仅当业务 code===0 时从响应体解析视频 URL */
  const extractVideoUrlFromParsed = (parsed: any): string | undefined => {
    if (!parsed || parsed.code !== 0) return undefined;
    const payload = parsed.data ?? parsed;
    return (
      extractFromResults(payload) ||
      extractFromData(payload) ||
      extractFromResults(parsed) ||
      extractFromData(parsed)
    );
  };

  try {
    console.log('[RunningHub] 查询任务:', { taskId });

    const q = await fetchOpenApiV2Query(apiKey, taskId);
    if (q && typeof q === 'object') {
      const qStatusEarly = String(q.status || '').toUpperCase();
      const qErr = q.errorCode ?? q.error_code ?? '';
      const qMsg = q.errorMessage ?? q.error_message ?? '';
      // 关键：有业务错误码（errorCode 非空且非 "0"）即视为失败，不论 status 显示什么
      if (qErr && qErr !== '0' && qErr !== '200') {
        console.log('[RunningHub] openapi/v2/query:', { taskId, errorCode: qErr, errorMessage: qMsg });
        return {
          success: false,
          error: formatRunningHubQueryFailurePayload(q),
          taskId,
          status: 'FAILED',
          data: q,
        };
      }
      // 纯错误信息（无 errorCode 但有 errorMessage）也视为失败
      if (qMsg && !qErr) {
        const qStatus = String(q.status || '').toUpperCase();
        if (qStatus === 'FAILED' || qStatus === 'CANCEL' || qStatus === 'CANCELED' || qStatus === 'ERROR' || qStatus === '') {
          console.log('[RunningHub] openapi/v2/query:', { taskId, errorMessage: qMsg });
          return {
            success: false,
            error: formatRunningHubQueryFailurePayload(q),
            taskId,
            status: 'FAILED',
            data: q,
          };
        }
        // 即使 status=RUNNING/RUNNING，服务器也可能通过 errorMessage 报告失败（如 "cannot identify image file"）
        // 此时应立即返回失败，不继续轮询
        if (qStatus === 'RUNNING' || qStatus === 'QUEUED' || qStatus === 'CREATE') {
          console.log('[RunningHub] openapi/v2/query 状态为 RUNNING 但包含错误信息，标记为失败:', { taskId, errorMessage: qMsg });
          return {
            success: false,
            error: formatRunningHubQueryFailurePayload(q),
            taskId,
            status: 'FAILED',
            data: q,
          };
        }
      }

      const qStatus = qStatusEarly;
      const mediaUrls = extractUrlsFromOpenApiV2Results(q);
      const mediaUrl = mediaUrls[0];

      console.log('[RunningHub] openapi/v2/query:', {
        taskId,
        status: qStatus,
        hasUrl: !!mediaUrl,
      });

      if (qStatus === 'SUCCESS') {
        if (mediaUrl) {
          return {
            success: true,
            data: q,
            taskId,
            status: 'SUCCESS',
            progress: 100,
            url: resolveRunningHubOutputUrl(mediaUrl),
          };
        }
        // RunningHub 任务状态为 SUCCESS 但首次 query 未拿到 URL
        // 尝试 get-outputs 获取 URL
        const out = await doOutputs();
        let outUrl = extractFromResults(out.data) || extractFromData(out.data);
        // 尝试 extractUrlsFromOpenApiV2Results 提取（支持更多格式）
        if (!outUrl) {
          const urls = extractUrlsFromOpenApiV2Results(out.data || {});
          outUrl = urls[0];
        }
        if (outUrl) {
          return {
            success: true,
            data: out.data ?? q,
            taskId,
            status: 'SUCCESS',
            progress: 100,
            url: resolveRunningHubOutputUrl(outUrl),
          };
        }
        // 再次用 extractUrlsFromOpenApiV2Results 从原始 q 提取（兜底）
        const finalUrls = extractUrlsFromOpenApiV2Results(q);
        const finalUrl = finalUrls[0];
        if (finalUrl) {
          return {
            success: true,
            data: q,
            taskId,
            status: 'SUCCESS',
            progress: 100,
            url: resolveRunningHubOutputUrl(finalUrl),
          };
        }
        // 任务成功但 URL 提取失败，告知调用方继续轮询以获取完整结果
        return {
          success: true,
          data: q,
          taskId,
          status: 'SUCCESS',
          progress: 95,
        };
      }

      if (qStatus === 'FAILED') {
        return {
          success: false,
          error: formatRunningHubQueryFailurePayload(q),
          taskId,
          status: 'FAILED',
          data: q,
        };
      }

      if (
        qStatus === 'RUNNING' ||
        qStatus === 'QUEUED' ||
        qStatus === 'CREATE' ||
        qStatus === ''
      ) {
        const prog =
          qStatus === 'QUEUED' ? 20 : qStatus === 'RUNNING' ? 55 : qStatus === 'CREATE' ? 10 : 45;
        return {
          success: true,
          data: q,
          taskId,
          status: qStatus || 'RUNNING',
          progress: prog,
        };
      }
    }

    const out = await doOutputs();
    console.log('[RunningHub] get-outputs:', { status: out.status, code: out.data?.code, msg: out.data?.msg });

    let videoUrl = extractVideoUrlFromParsed(out.data);
    if (videoUrl) {
      return {
        success: true,
        data: out.data?.data ?? out.data,
        taskId,
        status: 'SUCCESS',
        progress: 100,
        url: resolveRunningHubOutputUrl(videoUrl),
      };
    }

    const st = await doStatus();
    console.log('[RunningHub] get-status:', {
      status: st.status,
      code: st.data?.code,
      taskStatus: st.data?.data?.taskStatus,
    });

    const stCode = st.data?.code;
    const taskInner = st.data?.data;
    const taskStatus = taskInner?.taskStatus ?? taskInner?.status;
    const failedReason = taskInner?.failedReason ?? taskInner?.failed_reason;

    if (stCode === 0 && taskStatus === 'FAILED') {
      const errMsg =
        typeof failedReason === 'string' && failedReason.trim()
          ? failedReason
          : formatRunningHubQueryFailurePayload(taskInner ?? {});
      return { success: false, error: errMsg || '任务执行失败', taskId, status: 'FAILED' };
    }

    if (stCode === 0 && taskStatus === 'SUCCESS') {
      // RunningHub 任务状态 SUCCESS 但首次 query 未拿到 URL，立即再次尝试获取
      const retry = await doOutputs();
      videoUrl = extractVideoUrlFromParsed(retry.data);
      if (videoUrl) {
        return {
          success: true,
          data: retry.data?.data ?? retry.data,
          taskId,
          status: 'SUCCESS',
          progress: 100,
          url: resolveRunningHubOutputUrl(videoUrl),
        };
      }
      return {
        success: true,
        data: taskInner,
        taskId,
        status: 'SUCCESS',
        progress: 95,
      };
    }

    if (stCode === 0 && (taskStatus === 'RUNNING' || taskStatus === 'QUEUED' || taskStatus == null)) {
      // 每次轮询 RUNNING 状态时也尝试获取 URL（避免任务完成但轮询结束才拿到结果）
      const runningUrl = extractFromResults(out.data) || extractFromData(out.data);
      if (runningUrl) {
        return {
          success: true,
          data: out.data ?? taskInner,
          taskId,
          status: 'SUCCESS',
          progress: 100,
          url: resolveRunningHubOutputUrl(runningUrl),
        };
      }
      const prog =
        typeof taskInner?.progress === 'number'
          ? taskInner.progress
          : taskStatus === 'QUEUED'
            ? 15
            : 50;
      return {
        success: true,
        data: taskInner,
        taskId,
        status: taskStatus || 'RUNNING',
        progress: prog,
      };
    }

    // 产出尚未就绪时 get-outputs 常为 404 NOT_FOUND；若 openapi query 不可用则继续轮询
    if (out.data?.code === 404 || stCode === 404) {
      return { success: true, taskId, status: 'RUNNING', progress: 55, data: out.data };
    }

    if (!st.ok && st.status >= 400) {
      return { success: false, error: st.data?.msg || `HTTP ${st.status}`, taskId };
    }

    return {
      success: false,
      error: st.data?.msg || out.data?.msg || '查询任务状态失败',
      taskId,
    };
  } catch (error: any) {
    // CORS 或网络错误时，返回 RUNNING 状态让调用方继续轮询
    const isNetworkError = error.message?.includes('Failed to fetch') ||
                           error.message?.includes('CORS') ||
                           error.message?.includes('NetworkError') ||
                           error.message?.includes('net::ERR');
    if (isNetworkError) {
      console.warn('[RunningHub] 查询任务状态网络错误，返回 RUNNING 状态让调用方继续轮询:', error.message);
      return { success: true, taskId, status: 'RUNNING', progress: 50, networkRetry: true };
    }
    console.error('[RunningHub] 查询任务状态失败:', error);
    return { success: false, error: error.message || '查询任务状态失败' };
  }
};
