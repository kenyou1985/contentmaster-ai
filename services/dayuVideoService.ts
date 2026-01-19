/**
 * 大洋芋 API 视频生成服务
 * 根据 API 文档：https://6ibmqmipvf.apifox.cn/
 */

export interface DayuVideoGenerationOptions {
  prompt: string; // 视频提示词
  model: string; // 模型名称
  input_reference?: File | string; // 图片文件（图生视频模式）
  size?: string; // 视频尺寸（可选，如 "1280x720"）
  seconds?: number; // 视频时长（可选，如 4）
}

export interface DayuVideoResult {
  success: boolean;
  data?: any;
  error?: string;
  taskId?: string; // 任务 ID（异步任务）
  status?: string; // 任务状态：pending, in_progress, completed, failed
  progress?: number; // 进度（0-100）
  videoUrl?: string; // 视频 URL（完成时）
}

/**
 * 文生视频（Text-to-Video）
 * 使用 /v1/videos 端点，POST 请求，JSON 格式
 */
export const generateTextToVideo = async (
  apiKey: string,
  options: DayuVideoGenerationOptions
): Promise<DayuVideoResult> => {
  try {
    const baseUrl = 'https://api.dyuapi.com';
    const endpoint = '/v1/videos';
    
    const requestBody = {
      prompt: options.prompt,
      model: options.model,
    };
    
    console.log('[DayuVideoService] 文生视频请求:', {
      endpoint: `${baseUrl}${endpoint}`,
      model: options.model,
      prompt: options.prompt.substring(0, 50) + '...',
    });
    
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
    
    if (!response.ok) {
      const responseText = await response.text();
      let errorData: any = {};
      let errorMessage = '';
      
      try {
        errorData = JSON.parse(responseText);
      } catch {
        errorMessage = responseText;
      }
      
      errorMessage = errorMessage || 
        errorData.error?.message || 
        errorData.message || 
        errorData.error || 
        `HTTP ${response.status}: ${response.statusText}`;
      
      throw new Error(errorMessage);
    }
    
    const data = await response.json();
    
    return {
      success: true,
      data,
      taskId: data.id,
      status: data.status || 'pending',
      progress: data.progress || 0,
    };
  } catch (error: any) {
    console.error('[DayuVideoService] 文生视频失败:', error);
    return {
      success: false,
      error: error.message || '文生视频失败',
    };
  }
};

/**
 * 图生视频（Image-to-Video）
 * 使用 /v1/videos 端点，POST 请求，multipart/form-data 格式
 */
export const generateImageToVideo = async (
  apiKey: string,
  options: DayuVideoGenerationOptions
): Promise<DayuVideoResult> => {
  try {
    const baseUrl = 'https://api.dyuapi.com';
    const endpoint = '/v1/videos';
    
    if (!options.input_reference) {
      throw new Error('图生视频模式需要提供图片文件');
    }
    
    const formData = new FormData();
    formData.append('prompt', options.prompt);
    formData.append('model', options.model);
    
    // 处理图片：如果是 File 对象，直接添加；如果是 URL，需要先下载
    if (options.input_reference instanceof File) {
      formData.append('input_reference', options.input_reference);
    } else if (typeof options.input_reference === 'string') {
      // 如果是 URL，需要先下载为 Blob
      try {
        const imageResponse = await fetch(options.input_reference);
        if (!imageResponse.ok) {
          throw new Error(`无法下载图片: ${options.input_reference}`);
        }
        const blob = await imageResponse.blob();
        const fileName = options.input_reference.split('/').pop() || 'image.jpg';
        const file = new File([blob], fileName, { type: blob.type });
        formData.append('input_reference', file);
      } catch (error: any) {
        throw new Error(`图片下载失败: ${error.message}`);
      }
    }
    
    if (options.size) {
      formData.append('size', options.size);
    }
    
    if (options.seconds) {
      formData.append('seconds', options.seconds.toString());
    }
    
    console.log('[DayuVideoService] 图生视频请求:', {
      endpoint: `${baseUrl}${endpoint}`,
      model: options.model,
      prompt: options.prompt.substring(0, 50) + '...',
      hasImage: !!options.input_reference,
    });
    
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        // 注意：不要手动设置 Content-Type，浏览器会自动设置 multipart/form-data 的边界
      },
      body: formData,
    });
    
    if (!response.ok) {
      const responseText = await response.text();
      let errorData: any = {};
      let errorMessage = '';
      
      try {
        errorData = JSON.parse(responseText);
      } catch {
        errorMessage = responseText;
      }
      
      errorMessage = errorMessage || 
        errorData.error?.message || 
        errorData.message || 
        errorData.error || 
        `HTTP ${response.status}: ${response.statusText}`;
      
      throw new Error(errorMessage);
    }
    
    const data = await response.json();
    
    return {
      success: true,
      data,
      taskId: data.id,
      status: data.status || 'pending',
      progress: data.progress || 0,
    };
  } catch (error: any) {
    console.error('[DayuVideoService] 图生视频失败:', error);
    return {
      success: false,
      error: error.message || '图生视频失败',
    };
  }
};

/**
 * 查询任务状态
 * 根据任务 ID 查询视频生成进度
 */
export const checkVideoTaskStatus = async (
  apiKey: string,
  taskId: string
): Promise<DayuVideoResult> => {
  try {
    const baseUrl = 'https://api.dyuapi.com';
    const endpoint = `/v1/videos/${taskId}`;
    
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });
    
    if (!response.ok) {
      const responseText = await response.text();
      let errorData: any = {};
      let errorMessage = '';
      
      try {
        errorData = JSON.parse(responseText);
      } catch {
        errorMessage = responseText;
      }
      
      errorMessage = errorMessage || 
        errorData.error?.message || 
        errorData.message || 
        errorData.error || 
        `HTTP ${response.status}: ${response.statusText}`;
      
      throw new Error(errorMessage);
    }
    
    const data = await response.json();
    
    return {
      success: true,
      data,
      taskId: data.id,
      status: data.status,
      progress: data.progress,
      videoUrl: data.video_url || data.url || data.result?.url,
    };
  } catch (error: any) {
    console.error('[DayuVideoService] 查询任务状态失败:', error);
    return {
      success: false,
      error: error.message || '查询任务状态失败',
    };
  }
};
