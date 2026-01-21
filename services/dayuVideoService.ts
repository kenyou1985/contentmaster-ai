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
    
    const requestBody: any = {
      prompt: options.prompt,
      model: options.model,
      n: 1, // 限制只生成1个视频
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
    
    console.log('[DayuVideoService] 文生视频响应完整数据:', {
      hasId: !!data.id,
      id: data.id,
      status: data.status,
      progress: data.progress,
      allKeys: Object.keys(data),
    });
    
    // 支持多种可能的ID字段名
    const taskId = data.id || data.taskId || data.task_id || data.video_id;
    
    if (!taskId) {
      console.error('[DayuVideoService] 响应中未找到任务ID，完整响应:', JSON.stringify(data, null, 2));
      throw new Error('API响应中未找到任务ID，请检查API响应格式');
    }
    
    return {
      success: true,
      data,
      taskId: taskId,
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
 * 根据API文档：https://6ibmqmipvf.apifox.cn/396799529e0
 * 使用 /v1/videos 端点，POST 请求，JSON 格式，使用 image_url 参数
 */
export const generateImageToVideo = async (
  apiKey: string,
  options: DayuVideoGenerationOptions
): Promise<DayuVideoResult> => {
  try {
    const baseUrl = 'https://api.dyuapi.com';
    const endpoint = '/v1/videos';
    
    if (!options.input_reference) {
      throw new Error('图生视频模式需要提供图片');
    }
    
    // 根据API文档，图生视频使用 image_url 参数（字符串URL）
    // 如果 input_reference 是 File 对象，需要先上传或转换为URL
    let imageUrl: string | null = null;
    
    if (typeof options.input_reference === 'string') {
      // 直接使用URL
      imageUrl = options.input_reference;
    } else if (options.input_reference instanceof File) {
      // File对象需要转换为data URL或上传
      // 这里使用data URL（简单方案，但可能较大）
      imageUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            resolve(reader.result);
          } else {
            reject(new Error('无法读取图片文件'));
          }
        };
        reader.onerror = () => reject(new Error('读取图片文件失败'));
        reader.readAsDataURL(options.input_reference as File);
      });
    }
    
    if (!imageUrl) {
      throw new Error('无法获取图片URL');
    }
    
    // 根据API文档构建请求体
    // 支持参数：prompt, model, style, image_url, storyboard, trim, n
    const requestBody: any = {
      prompt: options.prompt,
      model: options.model,
      image_url: imageUrl, // 使用 image_url 参数
      n: 1, // 限制只生成1个视频
    };
    
    console.log('[DayuVideoService] 图生视频请求:', {
      endpoint: `${baseUrl}${endpoint}`,
      model: options.model,
      prompt: options.prompt.substring(0, 50) + '...',
      hasImageUrl: !!imageUrl,
      imageUrlLength: imageUrl.length,
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
    
    console.log('[DayuVideoService] 图生视频响应完整数据:', {
      hasId: !!data.id,
      id: data.id,
      status: data.status,
      progress: data.progress,
      allKeys: Object.keys(data),
    });
    
    // 支持多种可能的ID字段名
    const taskId = data.id || data.taskId || data.task_id || data.video_id;
    
    if (!taskId) {
      console.error('[DayuVideoService] 响应中未找到任务ID，完整响应:', JSON.stringify(data, null, 2));
      throw new Error('API响应中未找到任务ID，请检查API响应格式');
    }
    
    return {
      success: true,
      data,
      taskId: taskId,
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
 * API文档: https://6ibmqmipvf.apifox.cn/396799529e0
 * 响应格式: { id, status, progress, created_at, model, object, size, ... }
 */
export const checkVideoTaskStatus = async (
  apiKey: string,
  taskId: string
): Promise<DayuVideoResult> => {
  try {
    const baseUrl = 'https://api.dyuapi.com';
    const endpoint = `/v1/videos/${taskId}`;
    
    console.log(`[DayuVideoService] 查询任务状态: ${endpoint}, taskId: ${taskId}`);
    
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
    
    // 记录完整的响应数据用于调试
    console.log(`[DayuVideoService] 任务状态响应:`, {
      id: data.id,
      status: data.status,
      progress: data.progress,
      error: data.error,
      allKeys: Object.keys(data),
      fullData: data // 记录完整数据以便调试
    });
    
    // 检查任务是否失败
    if (data.status === 'failed' || data.status === 'error' || data.status === 'failure') {
      const errorMessage = data.error?.message || 
                          data.error?.detail ||
                          data.error ||
                          data.errorMessage ||
                          data.message ||
                          '视频生成失败';
      
      console.error(`[DayuVideoService] 任务失败:`, {
        status: data.status,
        error: errorMessage,
        fullError: data.error,
      });
      
      return {
        success: false,
        error: errorMessage,
        data,
        taskId: data.id,
        status: data.status,
        progress: data.progress || 0,
      };
    }
    
    // 根据API文档，状态可能是: pending, in_progress, completed, failed 等
    // 视频URL可能在多个字段中，需要检查所有可能的字段
    // 常见字段名：video_url, url, videoUrl, result.url, result.video_url, data.url, output.url 等
    // 如果API返回多个视频（数组），只取第一个
    let videoUrl: string | undefined;
    
    // 优先检查单个视频URL字段
    videoUrl = data.video_url || 
               data.url || 
               data.videoUrl ||
               data.video ||
               data.output?.url ||
               data.output?.video_url ||
               data.result?.url ||
               data.result?.video_url ||
               data.result?.video ||
               data.data?.url ||
               data.data?.video_url ||
               data.data?.video;
    
    // 如果还没有找到，检查数组字段（files, videos, outputs等）
    if (!videoUrl) {
      // 检查 files 数组
      if (Array.isArray(data.files) && data.files.length > 0) {
        videoUrl = data.files[0].url || data.files[0].video_url || data.files[0].video;
      }
      // 检查 videos 数组
      if (!videoUrl && Array.isArray(data.videos) && data.videos.length > 0) {
        videoUrl = data.videos[0].url || data.videos[0].video_url || data.videos[0].video;
      }
      // 检查 outputs 数组
      if (!videoUrl && Array.isArray(data.outputs) && data.outputs.length > 0) {
        videoUrl = data.outputs[0].url || data.outputs[0].video_url || data.outputs[0].video;
      }
      // 检查 data.data 数组（OpenAI格式）
      if (!videoUrl && Array.isArray(data.data) && data.data.length > 0) {
        videoUrl = data.data[0].url || data.data[0].video_url || data.data[0].video;
      }
    }
    
    if (videoUrl) {
      console.log(`[DayuVideoService] 找到视频URL: ${videoUrl.substring(0, 100)}...`);
      // 如果URL是相对路径，可能需要拼接base URL
      if (videoUrl.startsWith('/')) {
        videoUrl = `https://api.dyuapi.com${videoUrl}`;
        console.log(`[DayuVideoService] 拼接完整URL: ${videoUrl.substring(0, 100)}...`);
      }
    } else {
      console.warn(`[DayuVideoService] 未找到视频URL，状态: ${data.status}, 进度: ${data.progress}`);
      console.warn(`[DayuVideoService] 可用字段:`, Object.keys(data));
      console.warn(`[DayuVideoService] 完整响应数据:`, JSON.stringify(data, null, 2));
    }
    
    return {
      success: true,
      data,
      taskId: data.id,
      status: data.status,
      progress: data.progress || 0,
      videoUrl: videoUrl || undefined,
    };
  } catch (error: any) {
    console.error('[DayuVideoService] 查询任务状态失败:', error);
    return {
      success: false,
      error: error.message || '查询任务状态失败',
    };
  }
};
