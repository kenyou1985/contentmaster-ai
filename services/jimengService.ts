/**
 * 即梦 API 服务（调用线上代理服务生成图片）
 * 默认固定走 Railway: https://jimeng-api-production-4fbf.up.railway.app
 * 默认请求即梦 5.0（通过 model 字段声明，后端若忽略也不影响）
 */

/** 生产环境即梦代理（Railway），勿带末尾斜杠 */
export const JIMENG_API_BASE_URL = 'https://jimeng-api-production-4fbf.up.railway.app';

function normalizeJimengBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

export interface JimengImageGenerationOptions {
  prompt: string;
  num_images?: number;
  width?: number;
  height?: number;
  model?: string; // 如 jimeng-5.0 / jimeng-4.0
  // 即梦API支持的参数
  ratio?: string; // 如 "9:16", "16:9", "1:1" 等
  resolution?: string; // 如 "1k", "2k", "4k"
  // 图生图参数
  images?: string[]; // 输入图片URL数组（用于图生图）
  sample_strength?: number; // 采样强度 (0.0-1.0)，默认0.7
}

export interface JimengGenerationResult {
  success: boolean;
  data?: Array<{ url: string }>;
  error?: string;
  message?: string;
}

export interface JimengVideoGenerationOptions {
  model: string;
  prompt: string;
  ratio?: string;
  resolution?: '480p' | '720p' | '1080p' | string;
  duration?: number;
  file_paths?: string[];
}

export interface JimengVideoTaskSubmitResult {
  success: boolean;
  taskId?: string;
  status?: string;
  message?: string;
  error?: string;
}

export interface JimengVideoTaskResult {
  success: boolean;
  status?: string;
  videoUrl?: string;
  taskId?: string;
  error?: string;
  message?: string;
  data?: any;
}

/**
 * 将宽高转换为即梦API支持的 ratio 和 resolution
 * @param width 宽度
 * @param height 高度
 * @returns { ratio: string, resolution: string }
 */
function convertToJimengParams(width: number, height: number): { ratio: string; resolution: string } {
  // 计算宽高比
  const aspectRatio = width / height;
  
  // 支持的 ratio 列表（按宽高比排序）
  const supportedRatios = [
    { ratio: "21:9", min: 2.2, max: 2.5 },
    { ratio: "16:9", min: 1.7, max: 1.8 },
    { ratio: "3:2", min: 1.4, max: 1.6 },
    { ratio: "4:3", min: 1.3, max: 1.35 },
    { ratio: "1:1", min: 0.95, max: 1.05 },
    { ratio: "3:4", min: 0.74, max: 0.77 },
    { ratio: "2:3", min: 0.65, max: 0.68 },
    { ratio: "9:16", min: 0.55, max: 0.57 },
  ];
  
  // 找到最接近的 ratio
  let selectedRatio = "9:16"; // 默认值
  for (const item of supportedRatios) {
    if (aspectRatio >= item.min && aspectRatio <= item.max) {
      selectedRatio = item.ratio;
      break;
    }
  }
  
  // 根据尺寸选择 resolution
  // 1k: 约 1024px, 2k: 约 2048px, 4k: 约 4096px
  const maxDimension = Math.max(width, height);
  let resolution = "2k"; // 默认值
  if (maxDimension <= 1200) {
    resolution = "1k";
  } else if (maxDimension <= 2600) {
    resolution = "2k";
  } else {
    resolution = "4k";
  }
  
  return { ratio: selectedRatio, resolution };
}

/**
 * 生成图片（默认请求 {@link JIMENG_API_BASE_URL}）
 * @param options 生成选项
 * @param overrides 可选：自定义 baseUrl / Bearer（线上服务一般无需 session）
 */
// 单次调用即梦生成一张图片的内部实现（不含兜底）
// 返回 { success: true, url } | { success: false, error }
async function _callJimengApiOnce(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  imageIndex: number,
): Promise<{ success: true; url: string } | { success: false; error: string }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;

      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorJson.message || errorMessage;
      } catch {
        errorMessage = errorText || errorMessage;
      }

      if (response.status === 0 || response.status === 500) {
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.suggestion
            ? `${errorJson.error || errorMessage}\n\n${errorJson.suggestion}`
            : (errorJson.error || errorMessage);
        } catch {
          errorMessage = '无法连接到即梦API服务，请确保服务正在运行';
        }
      } else if (response.status === 401) {
        errorMessage = '鉴权失败，请检查线上服务或 Token 配置';
      }

      return { success: false, error: `第 ${imageIndex} 张图片生成失败: ${errorMessage}` };
    }

    const result = await response.json();

    if (result.data && Array.isArray(result.data) && result.data.length > 0) {
      return { success: true, url: result.data[0].url };
    } else {
      return { success: false, error: `第 ${imageIndex} 张图片: ${result.error || result.message || '响应无图片数据'}` };
    }
  } catch (error: unknown) {
    const err = error as Error;
    let errorMessage = err.message || '未知错误';
    if (errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError')) {
      errorMessage = `网络连接失败，无法连接到 ${url}`;
    }
    return { success: false, error: `第 ${imageIndex} 张图片: ${errorMessage}` };
  }
}

// 图生图单次调用（只取第一张，与 _callJimengApiOnce 一致，保留供其他场景使用）
async function _callJimengCompositionOnce(
  url: string,
  formData: FormData,
  headers: Record<string, string>,
  imageIndex: number,
): Promise<{ success: true; url: string } | { success: false; error: string }> {
  try {
    const response = await fetch(url, { method: 'POST', headers, body: formData });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;

      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorJson.message || errorMessage;
      } catch {
        errorMessage = errorText || errorMessage;
      }

      if (response.status === 0 || response.status === 500) {
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.suggestion
            ? `${errorJson.error || errorMessage}\n\n${errorJson.suggestion}`
            : (errorJson.error || errorMessage);
        } catch {
          errorMessage = '无法连接到即梦API服务，请确保服务正在运行';
        }
      } else if (response.status === 401) {
        errorMessage = '鉴权失败，请检查线上服务或 Token 配置';
      }

      return { success: false, error: `第 ${imageIndex} 张图片生成失败: ${errorMessage}` };
    }

    const result = await response.json();

    if (result.data && Array.isArray(result.data) && result.data.length > 0) {
      return { success: true, url: result.data[0].url };
    } else {
      return { success: false, error: `第 ${imageIndex} 张图片: ${result.error || result.message || '响应无图片数据'}` };
    }
  } catch (error: unknown) {
    const err = error as Error;
    let errorMessage = err.message || '未知错误';
    if (errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError')) {
      errorMessage = `网络连接失败，无法连接到 ${url}`;
    }
    return { success: false, error: `第 ${imageIndex} 张图片: ${errorMessage}` };
  }
}

// 图生图一次调用取所有图片 URL（与 _callJimengApiAll 对应）
async function _callJimengCompositionAll(
  url: string,
  formData: FormData,
  headers: Record<string, string>,
): Promise<{ success: true; urls: string[] } | { success: false; error: string }> {
  try {
    const response = await fetch(url, { method: 'POST', headers, body: formData });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;

      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorJson.message || errorMessage;
      } catch {
        errorMessage = errorText || errorMessage;
      }

      if (response.status === 0 || response.status === 500) {
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.suggestion
            ? `${errorJson.error || errorMessage}\n\n${errorJson.suggestion}`
            : (errorJson.error || errorMessage);
        } catch {
          errorMessage = '无法连接到即梦API服务，请确保服务正在运行';
        }
      } else if (response.status === 401) {
        errorMessage = '鉴权失败，请检查线上服务或 Token 配置';
      }

      return { success: false, error: errorMessage };
    }

    const result = await response.json();

    if (result.data && Array.isArray(result.data) && result.data.length > 0) {
      const urls = result.data
        .map((item: { url?: string }) => item.url)
        .filter((u: string) => !!u);
      return { success: true, urls };
    } else {
      return { success: false, error: result.error || result.message || '响应无图片数据' };
    }
  } catch (error: unknown) {
    const err = error as Error;
    let errorMessage = err.message || '未知错误';
    if (errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError')) {
      errorMessage = `网络连接失败，无法连接到 ${url}`;
    }
    return { success: false, error: errorMessage };
  }
}

/**
 * 即梦图片生成（内部统一兜底逻辑）
 * 优先使用传入的 model（如 jimeng-5.0），失败后自动以 jimeng-4.0 重试
 */
export async function generateJimengImages(
  options: JimengImageGenerationOptions,
  overrides?: { apiBaseUrl?: string; sessionId?: string }
): Promise<JimengGenerationResult> {
  const {
    prompt,
    num_images = 1,
    width = 1080,
    height = 1920,
    model = 'jimeng-5.0',
    ratio,
    resolution,
    images,
    sample_strength = 0.7
  } = options;

  const apiBaseUrl = normalizeJimengBaseUrl(overrides?.apiBaseUrl ?? JIMENG_API_BASE_URL);
  const sessionId = (overrides?.sessionId ?? '').trim();

  const jsonHeadersBase: Record<string, string> = { 'Content-Type': 'application/json' };
  const jsonHeaders: Record<string, string> = (sessionId && sessionId.length > 10)
    ? { ...jsonHeadersBase, Authorization: `Bearer ${sessionId}` }
    : jsonHeadersBase;

  const isImageToImage = images && images.length > 0;

  let finalRatio = ratio;
  let finalResolution = resolution;
  if (!finalRatio || !finalResolution) {
    const converted = convertToJimengParams(width, height);
    finalRatio = finalRatio || converted.ratio;
    finalResolution = finalResolution || converted.resolution;
  }

  const buildBaseBody = (m: string) => {
    const base: Record<string, unknown> = { prompt, model: m };
    if (finalRatio) base.ratio = finalRatio;
    if (finalResolution) base.resolution = finalResolution;
    return base;
  };

  const imageResults: Array<{ url: string }> = [];
  const errors: string[] = [];

  // ── 图生图分支（单次调用取所有图片） ──
  if (isImageToImage) {
    const compositionsUrl = `${apiBaseUrl}/v1/images/compositions`;
    const multipartHeaders: Record<string, string> = {};
    if (sessionId && sessionId.length > 10) {
      multipartHeaders.Authorization = `Bearer ${sessionId}`;
    }

    const needsMultipart = images!.some(
      (img) => img.startsWith('data:') || img.startsWith('blob:'),
    );

    const formData = _buildCompositionFormData(
      prompt, finalRatio, finalResolution, sample_strength, images!, model, needsMultipart,
    );

    let r = await _callJimengCompositionAll(compositionsUrl, formData, multipartHeaders);

    // 5.0 失败则用 4.0 重试
    if (!r.success && model === 'jimeng-5.0') {
      const fallbackFormData = _buildCompositionFormData(
        prompt, finalRatio, finalResolution, sample_strength, images!, 'jimeng-4.0', needsMultipart,
      );
      r = await _callJimengCompositionAll(compositionsUrl, fallbackFormData, multipartHeaders);
    }

    if (r.success) {
      imageResults.push(...r.urls.map((u) => ({ url: u })));
    } else {
      errors.push(r.error);
    }
  } else {
    // ── 文生图分支（一次 API 调用取所有图片） ──
    const url = `${apiBaseUrl}/v1/images/generations`;

    let r = await _callJimengApiAll(url, buildBaseBody(model), jsonHeaders, num_images);

    // 5.0 失败则用 4.0 重试
    if (!r.success && model === 'jimeng-5.0') {
      r = await _callJimengApiAll(url, buildBaseBody('jimeng-4.0'), jsonHeaders, num_images);
    }

    if (r.success) {
      imageResults.push(...r.urls.map((u) => ({ url: u })));
    } else {
      errors.push(r.error);
    }
  }

  if (imageResults.length > 0) {
    return {
      success: true,
      data: imageResults,
      message: errors.length > 0
        ? `成功生成 ${imageResults.length} 张图片，${errors.length} 张失败`
        : `成功生成 ${imageResults.length} 张图片`,
    };
  } else {
    return {
      success: false,
      error: errors.length > 0 ? errors.join('\n') : '所有图片生成失败',
    };
  }
}

// 单次调用即梦生成多张图片（文生图专用，一次请求取全部图片）
async function _callJimengApiAll(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  expectedCount: number,
): Promise<{ success: true; urls: string[] } | { success: false; error: string }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;

      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorJson.message || errorMessage;
      } catch {
        errorMessage = errorText || errorMessage;
      }

      if (response.status === 0 || response.status === 500) {
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.suggestion
            ? `${errorJson.error || errorMessage}\n\n${errorJson.suggestion}`
            : (errorJson.error || errorMessage);
        } catch {
          errorMessage = '无法连接到即梦API服务，请确保服务正在运行';
        }
      } else if (response.status === 401) {
        errorMessage = '鉴权失败，请检查线上服务或 Token 配置';
      }

      return { success: false, error: errorMessage };
    }

    const result = await response.json();

    if (result.data && Array.isArray(result.data) && result.data.length > 0) {
      // 返回所有图片 URL，而非只取第一张
      const urls = result.data
        .map((item: { url?: string }) => item.url)
        .filter((u: string) => !!u);
      return { success: true, urls };
    } else {
      return { success: false, error: result.error || result.message || '响应无图片数据' };
    }
  } catch (error: unknown) {
    const err = error as Error;
    let errorMessage = err.message || '未知错误';
    if (errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError')) {
      errorMessage = `网络连接失败，无法连接到 ${url}`;
    }
    return { success: false, error: errorMessage };
  }
}

// 构建图生图 FormData 的辅助函数（供 _callJimengCompositionOnce 调用）
function _buildCompositionFormData(
  prompt: string,
  finalRatio: string | undefined,
  finalResolution: string | undefined,
  sample_strength: number,
  images: string[],
  model: string,
  needsMultipart: boolean,
): FormData {
  const formData = new FormData();
  formData.append('prompt', prompt);
  formData.append('model', model);
  formData.append('sample_strength', String(sample_strength));
  if (finalRatio) formData.append('ratio', finalRatio);
  if (finalResolution) formData.append('resolution', finalResolution);

  for (const image of images) {
    if (image.startsWith('data:') || image.startsWith('blob:')) {
      const ext = image.includes('image/png') ? 'png' : image.includes('image/webp') ? 'webp' : 'jpg';
      formData.append('images', dataUrlToBlob(image), `ref.${ext}`);
    } else {
      formData.append('images', image);
    }
  }
  return formData;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(',');
  const mimeMatch = parts[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const bstr = atob(parts[1]);
  const n = bstr.length;
  const u8arr = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    u8arr[i] = bstr.charCodeAt(i);
  }
  return new Blob([u8arr], { type: mime });
}

export async function generateJimengVideoAsync(
  options: JimengVideoGenerationOptions,
  overrides?: { apiBaseUrl?: string; sessionId?: string }
): Promise<JimengVideoTaskSubmitResult> {
  const apiBaseUrl = normalizeJimengBaseUrl(overrides?.apiBaseUrl ?? JIMENG_API_BASE_URL);
  const sessionId = (overrides?.sessionId ?? '').trim();
  if (!sessionId) {
    return { success: false, error: '缺少 SESSION_ID' };
  }

  try {
    const endpoint = `${apiBaseUrl}/v1/videos/generations/async`;

    // 如果有图片 URL，需要先下载并作为文件上传
    const hasImages = options.file_paths && options.file_paths.length > 0;

    if (hasImages) {
      // 使用 multipart/form-data 上传图片文件
      const formData = new FormData();
      formData.append('model', options.model);
      formData.append('prompt', options.prompt || '');
      formData.append('ratio', options.ratio || '16:9');
      formData.append('resolution', options.resolution || '720p');
      formData.append('duration', String(options.duration || 5));

      // 下载图片并添加到 formData
      for (let i = 0; i < options.file_paths!.length; i++) {
        const imageUrl = options.file_paths![i];
        try {
          const response = await fetch(imageUrl);
          if (!response.ok) {
            console.warn(`[Jimeng] 下载图片失败 (${response.status}): ${imageUrl.slice(0, 80)}`);
            continue;
          }
          const blob = await response.blob();
          const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
          const fieldName = i === 0 ? 'image_file' : `image_file_${i + 1}`;
          formData.append(fieldName, blob, `image_${i + 1}.${ext}`);
          console.log(`[Jimeng] 图片 ${i + 1} 已添加到 formData`);
        } catch (e: any) {
          console.warn(`[Jimeng] 下载图片 ${i + 1} 失败: ${e.message}`);
        }
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionId}`,
        },
        body: formData,
      });

      const text = await res.text().catch(() => '');
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }

      if (!res.ok) {
        return {
          success: false,
          error: json?.error || json?.message || `HTTP ${res.status}`,
        };
      }

      const taskId = json?.task_id || json?.taskId;
      if (!taskId) {
        return {
          success: false,
          error: json?.message || '未返回 task_id',
        };
      }

      return {
        success: true,
        taskId,
        status: json?.status || 'processing',
        message: json?.message,
      };
    } else {
      // 无图片，使用纯 JSON
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({
          model: options.model,
          prompt: options.prompt,
          ratio: options.ratio || '16:9',
          resolution: options.resolution || '720p',
          duration: options.duration || 5,
          file_paths: [],
        }),
      });

      const text = await res.text().catch(() => '');
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }

      if (!res.ok) {
        return {
          success: false,
          error: json?.error || json?.message || `HTTP ${res.status}`,
        };
      }

      const taskId = json?.task_id || json?.taskId;
      if (!taskId) {
        return {
          success: false,
          error: json?.message || '未返回 task_id',
        };
      }

      return {
        success: true,
        taskId,
        status: json?.status || 'processing',
        message: json?.message,
      };
    }
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

export async function queryJimengVideoTask(
  taskId: string,
  overrides?: { apiBaseUrl?: string; sessionId?: string }
): Promise<JimengVideoTaskResult> {
  const apiBaseUrl = normalizeJimengBaseUrl(overrides?.apiBaseUrl ?? JIMENG_API_BASE_URL);
  const sessionId = (overrides?.sessionId ?? '').trim();
  if (!sessionId) {
    return { success: false, error: '缺少 SESSION_ID' };
  }

  try {
    const res = await fetch(`${apiBaseUrl}/v1/videos/generations/async/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sessionId}`,
      },
    });

    const text = await res.text().catch(() => '');
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }

    if (!res.ok) {
      return {
        success: false,
        taskId,
        error: json?.error || json?.message || `HTTP ${res.status}`,
        data: json,
      };
    }

    const status = (json?.status || '').toLowerCase();
    const first = Array.isArray(json?.data) ? json.data[0] : null;
    const videoUrl = first?.url || first?.video_url || json?.video_url;

    if (status === 'failed') {
      return {
        success: false,
        taskId,
        status,
        error: json?.error || json?.message || '视频生成失败',
        data: json,
      };
    }

    if (status === 'succeeded' && videoUrl) {
      return {
        success: true,
        taskId,
        status,
        videoUrl,
        message: json?.message,
        data: json,
      };
    }

    return {
      success: true,
      taskId,
      status: status || 'processing',
      message: json?.message || '任务处理中',
      data: json,
    };
  } catch (e: any) {
    return { success: false, taskId, error: e?.message || String(e) };
  }
}

/**
 * 检查API服务健康状态
 * @param apiBaseUrl API基础地址
 * @returns 是否可用
 */
export async function checkJimengApiHealth(
  apiBaseUrl: string = JIMENG_API_BASE_URL
): Promise<boolean> {
  try {
    const healthUrl = `${normalizeJimengBaseUrl(apiBaseUrl)}/health`;
    const response = await fetch(healthUrl, {
      method: 'GET',
      timeout: 5000
    } as any);
    
    return response.ok;
  } catch {
    return false;
  }
}
