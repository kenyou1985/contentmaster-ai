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

  // 基础 headers
  const jsonHeadersBase: Record<string, string> = { 'Content-Type': 'application/json' };
  
  // 统一按 Bearer 透传 sessionId（Railway 上部署的 jimeng-api 也需要）
  const jsonHeaders: Record<string, string> = (sessionId && sessionId.length > 10)
    ? { ...jsonHeadersBase, Authorization: `Bearer ${sessionId}` }
    : jsonHeadersBase;

  // 判断是文生图还是图生图
  const isImageToImage = images && images.length > 0;
  const endpoint = isImageToImage 
    ? `${apiBaseUrl}/v1/images/compositions`  // 图生图端点
    : `${apiBaseUrl}/v1/images/generations`;  // 文生图端点
  
  // 如果提供了 ratio 和 resolution，直接使用；否则从 width/height 转换
  let finalRatio = ratio;
  let finalResolution = resolution;
  
  if (!finalRatio || !finalResolution) {
    const converted = convertToJimengParams(width, height);
    finalRatio = finalRatio || converted.ratio;
    finalResolution = finalResolution || converted.resolution;
  }

  // 图生图：jimeng-api 要求 HTTP(S) URL 用 JSON；本地/base64 必须用 multipart（data URL 放 JSON 不会生效）
  if (isImageToImage) {
    const compositionsUrl = `${apiBaseUrl}/v1/images/compositions`;

    const multipartHeaders: Record<string, string> = {};
    if (sessionId && sessionId.length > 10) {
      multipartHeaders.Authorization = `Bearer ${sessionId}`;
    }

    const needsMultipart = images!.some(
      (img) => img.startsWith('data:') || img.startsWith('blob:')
    );

    const buildFormData = async (): Promise<FormData> => {
      const formData = new FormData();
      formData.append('prompt', prompt);
      if (finalRatio) formData.append('ratio', finalRatio);
      if (finalResolution) formData.append('resolution', finalResolution);
      formData.append('sample_strength', String(sample_strength));

      for (const image of images!) {
        if (image.startsWith('data:') || image.startsWith('blob:')) {
          const res = await fetch(image);
          const blob = await res.blob();
          const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
          formData.append('images', blob, `reference.${ext}`);
        } else {
          const res = await fetch(image);
          if (!res.ok) throw new Error(`无法加载参考图: ${image.slice(0, 80)}`);
          const blob = await res.blob();
          const ext = blob.type.includes('png') ? 'png' : 'jpg';
          formData.append('images', blob, `reference.${ext}`);
        }
      }
      return formData;
    };

    const jsonData: Record<string, unknown> = {
      prompt,
      model,
      images: images!,
      sample_strength,
    };
    if (finalRatio) jsonData.ratio = finalRatio;
    if (finalResolution) jsonData.resolution = finalResolution;

    // 即梦API每次调用只生成一张图片，如果需要多张，需要多次调用
    const targetCount = num_images || 1;
    const imageResults: Array<{ url: string }> = [];
    const errors: string[] = [];

    for (let i = 0; i < targetCount; i++) {
      try {
        let response: Response;
        if (needsMultipart) {
          const formData = await buildFormData();
          response = await fetch(compositionsUrl, {
            method: 'POST',
            headers: multipartHeaders,
            body: formData,
          });
        } else {
          response = await fetch(compositionsUrl, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify(jsonData),
          });
        }

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
              if (errorJson.suggestion) {
                errorMessage = `${errorJson.error || errorMessage}\n\n${errorJson.suggestion}`;
              } else {
                errorMessage = errorJson.error || errorMessage;
              }
            } catch {
              errorMessage = '无法连接到即梦API服务，请确保服务正在运行';
            }
          } else if (response.status === 401) {
            errorMessage = '鉴权失败，请检查线上服务或 Token 配置';
          }

          errors.push(`第 ${i + 1} 张图片生成失败: ${errorMessage}`);
          continue;
        }

        const result = await response.json();

        if (result.data && Array.isArray(result.data) && result.data.length > 0) {
          imageResults.push(...result.data);
        } else {
          errors.push(`第 ${i + 1} 张图片: ${result.error || result.message || '响应无图片数据'}`);
        }
      } catch (error: any) {
        let errorMessage = '未知错误';
        if (error.message) {
          if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            errorMessage = `网络连接失败，无法连接到 ${apiBaseUrl}`;
          } else {
            errorMessage = error.message;
          }
        }
        errors.push(`第 ${i + 1} 张图片: ${errorMessage}`);
      }
    }

    if (imageResults.length > 0) {
      return {
        success: true,
        data: imageResults,
        message: errors.length > 0 
          ? `成功生成 ${imageResults.length} 张图片，${errors.length} 张失败` 
          : `成功生成 ${imageResults.length} 张图片`
      };
    } else {
      return {
        success: false,
        error: errors.length > 0 ? errors.join('\n') : '所有图片生成失败'
      };
    }
  }

  // 文生图模式
  const url = `${apiBaseUrl}/v1/images/generations`;

  // 即梦API需要的参数格式
  const data: any = {
    prompt,
    model,
  };
  
  // 即梦API只支持 ratio 和 resolution，不支持 width/height
  if (finalRatio) {
    data.ratio = finalRatio;
  }
  if (finalResolution) {
    data.resolution = finalResolution;
  }

  // 即梦API每次调用只生成一张图片，如果需要多张，需要多次调用
  const targetCount = num_images || 1;
  const imageResults: Array<{ url: string }> = [];
  const errors: string[] = [];

  for (let i = 0; i < targetCount; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(data)
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

        // 特殊错误处理
        if (response.status === 0 || response.status === 500) {
          try {
            const errorJson = JSON.parse(errorText);
            if (errorJson.suggestion) {
              errorMessage = `${errorJson.error || errorMessage}\n\n${errorJson.suggestion}`;
            } else {
              errorMessage = errorJson.error || errorMessage;
            }
          } catch {
            errorMessage = '无法连接到即梦API服务，请确保服务正在运行';
          }
        } else if (response.status === 401) {
          errorMessage = '鉴权失败，请检查线上服务或 Token 配置';
        }

        errors.push(`第 ${i + 1} 张图片生成失败: ${errorMessage}`);
        continue;
      }

      const result = await response.json();

      // 检查响应格式
      if (result.data && Array.isArray(result.data) && result.data.length > 0) {
        // 即梦API每次返回一张图片
        imageResults.push(...result.data);
      } else {
        errors.push(`第 ${i + 1} 张图片: ${result.error || result.message || '响应无图片数据'}`);
      }
    } catch (error: any) {
      let errorMessage = '未知错误';
      if (error.message) {
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
          errorMessage = `网络连接失败，无法连接到 ${apiBaseUrl}`;
        } else {
          errorMessage = error.message;
        }
      }
      errors.push(`第 ${i + 1} 张图片: ${errorMessage}`);
    }
  }

  // 返回结果
  if (imageResults.length > 0) {
    return {
      success: true,
      data: imageResults,
      message: errors.length > 0 
        ? `成功生成 ${imageResults.length} 张图片，${errors.length} 张失败` 
        : `成功生成 ${imageResults.length} 张图片`
    };
  } else {
    return {
      success: false,
      error: errors.length > 0 ? errors.join('\n') : '所有图片生成失败'
    };
  }
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
    const res = await fetch(`${apiBaseUrl}/v1/videos/generations/async`, {
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
        file_paths: options.file_paths || [],
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
