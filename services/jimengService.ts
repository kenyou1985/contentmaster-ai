/**
 * 即梦API服务
 * 用于通过即梦逆向API生成图片
 */

export interface JimengImageGenerationOptions {
  prompt: string;
  num_images?: number;
  width?: number;
  height?: number;
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
 * 生成图片
 * @param apiBaseUrl API基础地址（默认：http://localhost:3000）
 * @param sessionId 即梦Web端sessionid（从浏览器Cookie获取）
 * @param options 生成选项
 * @returns 生成结果
 */
export async function generateJimengImages(
  apiBaseUrl: string,
  sessionId: string,
  options: JimengImageGenerationOptions
): Promise<JimengGenerationResult> {
  const { 
    prompt, 
    num_images = 1, 
    width = 1080, 
    height = 1920, 
    ratio, 
    resolution,
    images,
    sample_strength = 0.7
  } = options;

  if (!sessionId || sessionId.trim() === '') {
    return {
      success: false,
      error: '即梦 SESSION_ID 未设置，请先配置'
    };
  }

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

  // 图生图模式：使用 multipart/form-data
  if (isImageToImage) {
    const formData = new FormData();
    formData.append('prompt', prompt);
    if (finalRatio) formData.append('ratio', finalRatio);
    if (finalResolution) formData.append('resolution', finalResolution);
    formData.append('sample_strength', sample_strength.toString());
    
    // 添加图片（支持URL或File）
    for (const image of images) {
      // 如果是data URL，需要转换为Blob
      if (image.startsWith('data:')) {
        const response = await fetch(image);
        const blob = await response.blob();
        formData.append('images', blob);
      } else if (image.startsWith('blob:')) {
        // blob URL需要先fetch
        const response = await fetch(image);
        const blob = await response.blob();
        formData.append('images', blob);
      } else {
        // 普通URL，直接添加到images数组（JSON格式）或作为文件上传
        // 即梦API支持URL数组，但multipart模式下需要上传文件
        // 这里我们尝试将URL转换为文件
        try {
          const response = await fetch(image);
          const blob = await response.blob();
          formData.append('images', blob);
        } catch (error) {
          console.error('[JimengService] 无法加载图片URL:', error);
          return {
            success: false,
            error: `无法加载图片: ${image}`
          };
        }
      }
    }

    const headers = {
      'Authorization': `Bearer ${sessionId}`
      // 不设置Content-Type，让浏览器自动设置multipart/form-data边界
    };

    // 即梦API需要的参数格式（图生图）
    const data: any = {
      prompt,
    };
    
    if (finalRatio) {
      data.ratio = finalRatio;
    }
    if (finalResolution) {
      data.resolution = finalResolution;
    }
    data.sample_strength = sample_strength;
    
    // 图生图：使用compositions端点，需要发送multipart/form-data
    // 但由于前端限制，我们使用JSON格式发送图片URL数组
    const jsonUrl = `${apiBaseUrl}/v1/images/compositions`;
    const jsonHeaders = {
      'Authorization': `Bearer ${sessionId}`,
      'Content-Type': 'application/json'
    };
    
    const jsonData: any = {
      prompt,
      images: images, // 直接传递URL数组
    };
    
    if (finalRatio) {
      jsonData.ratio = finalRatio;
    }
    if (finalResolution) {
      jsonData.resolution = finalResolution;
    }
    jsonData.sample_strength = sample_strength;

    // 即梦API每次调用只生成一张图片，如果需要多张，需要多次调用
    const targetCount = num_images || 1;
    const imageResults: Array<{ url: string }> = [];
    const errors: string[] = [];

    for (let i = 0; i < targetCount; i++) {
      try {
        const response = await fetch(jsonUrl, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify(jsonData)
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
              if (errorJson.suggestion) {
                errorMessage = `${errorJson.error || errorMessage}\n\n${errorJson.suggestion}`;
              } else {
                errorMessage = errorJson.error || errorMessage;
              }
            } catch {
              errorMessage = '无法连接到即梦API服务，请确保服务正在运行';
            }
          } else if (response.status === 401) {
            errorMessage = 'SESSION_ID 无效，请检查配置';
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

  // 文生图模式：使用原有的逻辑
  const url = `${apiBaseUrl}/v1/images/generations`;
  
  const headers = {
    'Authorization': `Bearer ${sessionId}`,
    'Content-Type': 'application/json'
  };

  // 即梦API需要的参数格式
  const data: any = {
    prompt,
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
        headers,
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
          errorMessage = 'SESSION_ID 无效，请检查配置';
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

/**
 * 检查API服务健康状态
 * @param apiBaseUrl API基础地址
 * @returns 是否可用
 */
export async function checkJimengApiHealth(apiBaseUrl: string): Promise<boolean> {
  try {
    const healthUrl = `${apiBaseUrl}/health`;
    const response = await fetch(healthUrl, {
      method: 'GET',
      timeout: 5000
    } as any);
    
    return response.ok;
  } catch {
    return false;
  }
}
