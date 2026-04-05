/**
 * RunningHub API 服务
 * 支持多模板调用：视频模板、音频TTS模板、图片模板
 * API文档: https://www.runninghub.cn/runninghub-api-doc-cn/
 */

export interface RunningHubImageOptions {
  prompt: string;
  model: 'flux' | 'z-image' | 'qwen-image'; // 图片模型
  width?: number;
  height?: number;
  num_images?: number;
  image_url?: string; // 图生图时使用
}

export interface RunningHubVideoOptions {
  /** 完整 workflow JSON（模板）；不填则用 nodeInfoList 方式 */
  workflow?: Record<string, any>;
  /** workflow JSON 模板（JSON 字符串格式，优先级低于 workflow 对象） */
  workflowTemplate?: string;
  prompt: string;
  model: 'wan2.2' | 'ltx2';
  image_url?: string;
  duration?: number;
}

export interface RunningHubAudioOptions {
  text: string;
  model: 'indextts2.0'; // 音频模型固定为indextts2.0
  voice?: string; // 语音风格（可选）
  speed?: number; // 语速（可选）
}

export interface RunningHubResult {
  success: boolean;
  data?: any;
  error?: string;
  taskId?: string; // 异步任务ID
  status?: string; // 任务状态
  progress?: number; // 进度
  url?: string; // 结果URL（图片/视频/音频）
  urls?: string[]; // 多个结果URL（多张图片）
}

const BASE_URL = 'https://www.runninghub.cn';

/**
 * 生成图片
 * 支持模型：flux, z-image, qwen-image
 */
// 导出别名，保持向后兼容
export const generateImage = async (
  apiKey: string,
  options: RunningHubImageOptions
): Promise<RunningHubResult> => {
  try {
    const endpoint = '/v1/images/generations';
    
    const requestBody: any = {
      prompt: options.prompt,
      model: options.model,
    };
    
    if (options.width) {
      requestBody.width = options.width;
    }
    if (options.height) {
      requestBody.height = options.height;
    }
    if (options.num_images) {
      requestBody.n = options.num_images;
    }
    if (options.image_url) {
      requestBody.image_url = options.image_url; // 图生图
    }
    
    console.log('[RunningHub] 图片生成请求:', {
      endpoint: `${BASE_URL}${endpoint}`,
      model: options.model,
      prompt: options.prompt.substring(0, 50) + '...',
    });
    
    const response = await fetch(`${BASE_URL}${endpoint}`, {
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
    
    // 处理响应格式
    let urls: string[] = [];
    if (data.url) {
      urls = [data.url];
    } else if (data.data && Array.isArray(data.data)) {
      urls = data.data.map((item: any) => item.url || item).filter(Boolean);
    } else if (data.urls && Array.isArray(data.urls)) {
      urls = data.urls;
    }
    
    return {
      success: true,
      data,
      url: urls[0],
      urls: urls.length > 0 ? urls : undefined,
    };
  } catch (error: any) {
    console.error('[RunningHub] 图片生成失败:', error);
    return {
      success: false,
      error: error.message || '图片生成失败',
    };
  }
};

/**
 * 上传图片到RunningHub
 * API文档: https://www.runninghub.cn/runninghub-api-doc-cn/doc-7525194
 */
const uploadImage = async (apiKey: string, imageUrl: string): Promise<string> => {
  try {
    // 如果已经是RunningHub的URL，直接返回
    if (imageUrl.includes('runninghub.cn') || imageUrl.includes('rh-images')) {
      return imageUrl;
    }
    
    // 从URL获取图片
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`无法获取图片: ${imageUrl}`);
    }
    
    const imageBlob = await imageResponse.blob();
    const formData = new FormData();
    formData.append('file', imageBlob, 'image.jpg');
    formData.append('fileType', 'image'); // 根据API文档，需要指定文件类型
    formData.append('apiKey', apiKey); // 将apiKey放在FormData中
    
    const uploadResponse = await fetch(`${BASE_URL}/task/openapi/upload`, {
      method: 'POST',
      headers: {
        // 注意：使用FormData时不要设置Content-Type，浏览器会自动设置
        // 但可以尝试添加Authorization header作为备用
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    });
    
    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`图片上传失败: ${errorText}`);
    }
    
    const uploadData = await uploadResponse.json();
    
    if (uploadData.code !== 0) {
      throw new Error(`图片上传失败: ${uploadData.msg || uploadData.message}`);
    }
    
    // 返回上传后的文件路径
    return uploadData.data?.fileName || uploadData.data?.filePath || imageUrl;
  } catch (error: any) {
    console.error('[RunningHub] 图片上传失败:', error);
    // 如果上传失败，尝试直接使用原URL（某些情况下可能支持）
    return imageUrl;
  }
};

/**
 * 生成视频
 * LTX-2：传入完整 workflow JSON（模板），自动替换图片路径和提示词节点。
 * Wan2.2：使用 nodeInfoList 节点参数映射（兼容旧逻辑）。
 * API文档: https://www.runninghub.cn/call-api/api-detail/2033053099966865410?apiType=5
 */
export const generateVideo = async (
  apiKey: string,
  options: RunningHubVideoOptions
): Promise<RunningHubResult> => {
  try {
    const workflowId = '2033053099966865410';
    const endpoint = `/run/workflow/${workflowId}`;

    // ── LTX-2 路径：传入完整 workflow JSON ─────────────────────────────────
    if (options.workflow || options.workflowTemplate) {
      // 1. 解析/克隆 workflow
      let wf: Record<string, any>;
      if (options.workflow) {
        wf = JSON.parse(JSON.stringify(options.workflow));
      } else {
        wf = JSON.parse(options.workflowTemplate!);
      }

      // 2. 若有图片，先上传得到 RunningHub 路径
      let uploadedImagePath: string | undefined;
      if (options.image_url) {
        try {
          uploadedImagePath = await uploadImage(apiKey, options.image_url);
          console.log('[RunningHub] LTX-2 图片上传成功:', uploadedImagePath);
        } catch (uploadError: any) {
          throw new Error(`图片上传失败: ${uploadError.message}`);
        }
      }

      // 3. 替换关键节点
      //    LoadImage 节点（269）：替换图片路径
      if (uploadedImagePath && wf['269']) {
        wf['269'].inputs.image = uploadedImagePath;
      }
      //    PrimitiveStringMultiline 节点（325）：替换提示词
      if (options.prompt && wf['325']) {
        wf['325'].inputs.value = options.prompt;
      }
      //    PrimitiveInt 节点（301）：视频帧数 ≈ duration × fps（默认 24fps）
      if (options.duration && wf['301']) {
        wf['301'].inputs.value = Math.round(options.duration * 24);
      }

      // 4. 发送请求
      //    注意：workflowId + apiKey 都在请求体，URL 固定为 /run/workflow/
      const requestBody: Record<string, any> = {
        apiKey,
        workflow: JSON.stringify(wf),
        workflowId,
        randomSeed: true,
        retainSeconds: 0,
        usePersonalQueue: false,
      };

      console.log('[RunningHub] LTX-2 视频生成请求:', {
        endpoint: `${BASE_URL}/run/workflow/`,
        workflowId,
        prompt: options.prompt?.slice(0, 80),
        uploadedImagePath,
      });

      const response = await fetch(`${BASE_URL}/run/workflow/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const responseText = await response.text();
      console.log('[RunningHub] LTX-2 响应原始数据:', {
        status: response.status,
        responseText: responseText.slice(0, 600),
      });

      if (!response.ok) {
        let errorData: any = {};
        try { errorData = JSON.parse(responseText); } catch { /* ignore */ }
        const msg =
          errorData.errorMessage ||
          errorData.msg ||
          errorData.error ||
          responseText ||
          `HTTP ${response.status}`;
        throw new Error(msg);
      }

      const data = JSON.parse(responseText);
      if (!data.taskId) {
        throw new Error(data.errorMessage || 'LTX-2 视频生成失败（无 taskId）');
      }

      return {
        success: true,
        data,
        taskId: data.taskId,
        status: data.status || 'QUEUED',
        progress: 0,
      };
    }

    // ── Wan2.2 兼容路径（nodeInfoList）───
    let uploadedImagePath: string | undefined;
    if (options.image_url) {
      try {
        uploadedImagePath = await uploadImage(apiKey, options.image_url);
        console.log('[RunningHub] Wan2.2 图片上传成功:', uploadedImagePath);
      } catch (uploadError: any) {
        throw new Error(`图片上传失败: ${uploadError.message}. 图生视频需要先上传图片`);
      }
    } else {
      throw new Error('图生视频模式需要提供图片URL');
    }

    const nodeInfoList: any[] = [];
    if (uploadedImagePath) {
      nodeInfoList.push({ nodeId: '52', inputs: { image: uploadedImagePath } });
    }
    if (options.prompt) {
      nodeInfoList.push({ nodeId: '88', inputs: { value: options.prompt } });
    }
    nodeInfoList.push({ nodeId: '50', inputs: { batch_size: 1 } });
    nodeInfoList.push({ nodeId: '78', inputs: { count: 1 } });

    const requestBody: any = {
      apiKey,
      nodeInfoList,
      instanceType: 'plus',
      usePersonalQueue: false,
      addMetadata: false,
    };

    console.log('[RunningHub] Wan2.2 视频生成请求:', {
      endpoint: `${BASE_URL}${endpoint}`,
      workflowId,
      prompt: options.prompt.slice(0, 50),
      imagePath: uploadedImagePath,
    });

    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const responseText = await response.text();
    if (!response.ok) {
      let errorData: any = {};
      try { errorData = JSON.parse(responseText); } catch { /* ignore */ }
      const msg =
        errorData.msg ||
        errorData.errorMessage ||
        errorData.message ||
        errorData.error ||
        responseText ||
        `HTTP ${response.status}`;
      throw new Error(msg);
    }

    const data = JSON.parse(responseText);
    if (!data.taskId) {
      throw new Error(data.errorMessage || 'Wan2.2 视频生成失败（无 taskId）');
    }

    return {
      success: true,
      data,
      taskId: data.taskId,
      status: data.status || 'QUEUED',
      progress: 0,
    };
  } catch (error: any) {
    console.error('[RunningHub] 视频生成失败:', error);
    return {
      success: false,
      error: error.message || '视频生成失败',
    };
  }
};

/**
 * 生成音频（TTS）
 * 模型：indextts2.0
 */
export const generateAudio = async (
  apiKey: string,
  options: RunningHubAudioOptions
): Promise<RunningHubResult> => {
  try {
    const endpoint = '/v1/audio/speech';
    
    const requestBody: any = {
      text: options.text,
      model: options.model || 'indextts2.0',
    };
    
    if (options.voice) {
      requestBody.voice = options.voice;
    }
    if (options.speed) {
      requestBody.speed = options.speed;
    }
    
    console.log('[RunningHub] 音频生成请求:', {
      endpoint: `${BASE_URL}${endpoint}`,
      model: options.model,
      textLength: options.text.length,
    });
    
    const response = await fetch(`${BASE_URL}${endpoint}`, {
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
      url: data.audio_url || data.url || data.audioUrl,
    };
  } catch (error: any) {
    console.error('[RunningHub] 音频生成失败:', error);
    return {
      success: false,
      error: error.message || '音频生成失败',
    };
  }
};

/**
 * 查询任务状态（用于视频生成等异步任务）
 * API文档: https://www.runninghub.cn/runninghub-api-doc/api-276613249
 */
// 导出别名
export const checkTaskStatus = async (
  apiKey: string,
  taskId: string
): Promise<RunningHubResult> => {
  try {
    // 优先使用get-outputs接口查询，因为它可以同时返回状态和结果
    // 如果get-outputs返回404，再尝试get-status
    const outputsEndpoint = '/task/openapi/get-outputs';
    
    console.log('[RunningHub] 查询任务状态和输出:', {
      endpoint: `${BASE_URL}${outputsEndpoint}`,
      taskId,
    });
    
    // 先尝试get-outputs接口（可以同时获取状态和结果）
    const outputsResponse = await fetch(`${BASE_URL}${outputsEndpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        apiKey: apiKey,
        taskId: taskId,
      }),
    });
    
    const outputsResponseText = await outputsResponse.text();
    console.log('[RunningHub] get-outputs响应原始数据:', {
      status: outputsResponse.status,
      responseText: outputsResponseText.substring(0, 500),
    });
    
    // 如果get-outputs成功，直接处理结果
    if (outputsResponse.ok) {
      try {
        const outputsData = JSON.parse(outputsResponseText);
        
        console.log('[RunningHub] get-outputs响应:', {
          code: outputsData.code,
          msg: outputsData.msg,
          hasData: !!outputsData.data,
        });
        
        // 检查响应码（新API格式可能不同，需要兼容处理）
        // 新API格式：results 数组直接包含在响应中
        let videoUrl: string | undefined;
        let taskStatus: string = 'RUNNING';
        
        // 尝试从新API格式的 results 数组中提取（根据文档：results: [{ url, outputType, text }]）
        if (outputsData.results && Array.isArray(outputsData.results) && outputsData.results.length > 0) {
          // 查找视频文件（mp4格式），只取第一个
          const videoResults = outputsData.results.filter((r: any) => 
            r.outputType === 'mp4' || 
            r.url?.includes('.mp4')
          );
          
          if (videoResults.length > 0) {
            videoUrl = videoResults[0].url;
            taskStatus = outputsData.status || 'SUCCESS';
            console.log(`[RunningHub] 从 results 数组找到 ${videoResults.length} 个视频，使用第一个:`, videoUrl);
            if (videoResults.length > 1) {
              console.warn(`[RunningHub] 警告：返回了 ${videoResults.length} 个视频，但只使用第一个。`);
            }
          } else if (outputsData.results.length > 0) {
            // 如果没有找到mp4，使用第一个结果
            videoUrl = outputsData.results[0].url;
            taskStatus = outputsData.status || 'SUCCESS';
            console.log('[RunningHub] 使用第一个结果作为视频URL:', videoUrl);
          }
        }
        
        // 兼容旧格式：从 data 字段提取
        if (!videoUrl && outputsData.code === 0 && outputsData.data) {
          const data = outputsData.data;
          const files = data.files || data.outputs || data.result?.files || [];
          
          // 查找视频文件（mp4格式）
          const videoFiles = files.filter((f: any) => 
            f.url?.includes('.mp4') || 
            f.fileName?.includes('.mp4') ||
            f.outputType === 'mp4' ||
            f.type === 'video/mp4' ||
            f.name?.includes('.mp4')
          );
          
          if (videoFiles.length > 0) {
            videoUrl = videoFiles[0].url || videoFiles[0].fileUrl || videoFiles[0].fileName || videoFiles[0].name;
            taskStatus = data.taskStatus || (videoUrl ? 'SUCCESS' : 'RUNNING');
            console.log(`[RunningHub] 从 data.files 找到 ${videoFiles.length} 个视频文件，使用第一个:`, videoUrl);
            if (videoFiles.length > 1) {
              console.warn(`[RunningHub] 警告：返回了 ${videoFiles.length} 个视频，但只使用第一个。`);
            }
          } else if (files.length > 0) {
            videoUrl = files[0].url || files[0].fileUrl || files[0].fileName || files[0].name;
            taskStatus = data.taskStatus || (videoUrl ? 'SUCCESS' : 'RUNNING');
            console.log('[RunningHub] 未找到mp4文件，使用第一个输出文件:', videoUrl);
          }
          
          // 也尝试从data的顶层字段查找视频URL
          if (!videoUrl) {
            videoUrl = data.videoUrl || data.video_url || data.url || data.outputUrl || data.output_url;
            if (videoUrl) {
              taskStatus = data.taskStatus || 'SUCCESS';
              console.log('[RunningHub] 从顶层字段找到视频URL:', videoUrl);
            }
          }
        }
        
        // 如果找到了视频URL，返回成功
        if (videoUrl) {
          return {
            success: true,
            data: outputsData.data || outputsData, // 兼容新旧格式
            taskId,
            status: taskStatus,
            progress: 100,
            url: videoUrl,
            videoUrl: videoUrl, // 同时设置videoUrl字段
          };
        }
        
        // 如果状态是SUCCESS但没有视频URL，可能是格式问题
        if (outputsData.status === 'SUCCESS' || (outputsData.code === 0 && !videoUrl)) {
          // 继续执行下面的逻辑，尝试从其他字段获取
        } else if (outputsData.code === 404 || outputsData.msg?.includes('NOT_FOUND') || outputsData.status === 'NOT_FOUND') {
          // 如果返回404，任务可能不存在或还未完成，尝试get-status
          console.log('[RunningHub] get-outputs返回404，尝试get-status');
          // 注意：如果视频已生成但查询返回404，可能是taskId格式问题或任务已过期
          // 继续执行下面的get-status逻辑
        } else {
          // 其他错误，但如果是807（APIKEY_TASK_NOT_FOUND），说明任务不存在
          if (outputsData.code === 807) {
            return {
              success: false,
              error: `任务不存在（807）。请确认taskId是否正确: ${taskId}`,
              taskId,
            };
          }
          throw new Error(outputsData.msg || `查询失败: code ${outputsData.code}`);
        }
      } catch (parseError: any) {
        console.warn('[RunningHub] 解析get-outputs响应失败:', parseError);
      }
    }
    
    // 如果get-outputs失败或返回404，尝试get-status接口
    const statusEndpoint = '/task/openapi/get-status';
    console.log('[RunningHub] 尝试查询任务状态:', {
      endpoint: `${BASE_URL}${statusEndpoint}`,
      taskId,
    });
    
    const statusResponse = await fetch(`${BASE_URL}${statusEndpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        apiKey: apiKey,
        taskId: taskId,
      }),
    });
    
    const statusResponseText = await statusResponse.text();
    console.log('[RunningHub] get-status响应原始数据:', {
      status: statusResponse.status,
      responseText: statusResponseText.substring(0, 500),
    });
    
    if (!statusResponse.ok) {
      let errorData: any = {};
      let errorMessage = '';
      
      try {
        errorData = JSON.parse(statusResponseText);
      } catch {
        errorMessage = statusResponseText;
      }
      
      errorMessage = errorMessage || 
        errorData.msg ||
        errorData.error?.message || 
        errorData.errorMessage ||
        errorData.message || 
        errorData.error || 
        `HTTP ${statusResponse.status}: ${statusResponse.statusText}`;
      
      throw new Error(errorMessage);
    }
    
    const statusData = JSON.parse(statusResponseText);
    
    console.log('[RunningHub] 任务状态查询响应:', {
      code: statusData.code,
      taskStatus: statusData.data?.taskStatus,
      failedReason: statusData.data?.failedReason,
    });
    
    // 检查响应码
    if (statusData.code !== 0) {
      // 如果是404，可能是任务已完成但已过期，或者taskId不正确
      if (statusData.code === 404 || statusData.msg?.includes('NOT_FOUND')) {
        console.warn('[RunningHub] 任务状态查询返回404，可能原因：1) 任务已完成但已过期 2) taskId不正确 3) 任务不存在');
        // 即使返回404，也尝试再次查询get-outputs，因为有时任务已完成但get-status返回404
        console.log('[RunningHub] 404错误，尝试再次查询get-outputs以获取视频URL');
        try {
          const retryOutputsResponse = await fetch(`${BASE_URL}/task/openapi/get-outputs`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              apiKey: apiKey,
              taskId: taskId,
            }),
          });
          
          if (retryOutputsResponse.ok) {
            const retryData = await retryOutputsResponse.json();
            let videoUrl: string | undefined;
            
            // 优先从新API格式的 results 数组中提取
            if (retryData.results && Array.isArray(retryData.results) && retryData.results.length > 0) {
              const videoResults = retryData.results.filter((r: any) => 
                r.outputType === 'mp4' || r.url?.includes('.mp4')
              );
              if (videoResults.length > 0) {
                videoUrl = videoResults[0].url;
              } else {
                videoUrl = retryData.results[0].url;
              }
            }
            
            // 兼容旧格式：从 data 字段提取
            if (!videoUrl && retryData.code === 0 && retryData.data) {
              const data = retryData.data;
              const files = data.files || data.outputs || [];
              const videoFile = files.find((f: any) => 
                f.url?.includes('.mp4') || f.fileName?.includes('.mp4')
              );
              if (videoFile) {
                videoUrl = videoFile.url || videoFile.fileUrl || videoFile.fileName;
              } else if (files.length > 0) {
                videoUrl = files[0].url || files[0].fileUrl || files[0].fileName;
              }
            }
            
            if (videoUrl) {
              console.log('[RunningHub] 重试后成功获取视频URL:', videoUrl);
              return {
                success: true,
                data: retryData.data || retryData,
                taskId,
                status: 'SUCCESS',
                progress: 100,
                url: videoUrl,
                videoUrl: videoUrl,
              };
            }
          }
        } catch (retryError) {
          console.warn('[RunningHub] 重试查询get-outputs失败:', retryError);
        }
        
        // 即使返回404，如果视频已生成，用户应该能在RunningHub控制台看到
        return {
          success: false,
          error: `任务查询失败（404）。可能原因：任务已完成但已过期，或taskId不正确。\n\n如果视频已生成，请前往RunningHub控制台查看。\nTaskId: ${taskId}\n\n提示：可以尝试手动刷新或稍后重试查询。`,
          taskId,
        };
      }
      // 如果是807（APIKEY_TASK_NOT_FOUND），说明任务不存在
      if (statusData.code === 807) {
        return {
          success: false,
          error: `任务不存在（807）。请确认taskId是否正确: ${taskId}`,
          taskId,
        };
      }
      throw new Error(statusData.msg || statusData.message || '查询任务状态失败');
    }
    
    const taskStatus = statusData.data?.taskStatus;
    const failedReason = statusData.data?.failedReason;
    
    // 如果任务失败，返回错误
    if (taskStatus === 'FAILED') {
      return {
        success: false,
        error: failedReason || '任务执行失败',
        taskId,
        status: taskStatus,
      };
    }
    
    // 如果任务成功，再次尝试获取输出结果
    let videoUrl: string | undefined;
    if (taskStatus === 'SUCCESS') {
      try {
        const finalOutputsResponse = await fetch(`${BASE_URL}${outputsEndpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            apiKey: apiKey,
            taskId: taskId,
          }),
        });
        
        if (finalOutputsResponse.ok) {
          const finalOutputsData = await finalOutputsResponse.json();
          
          // 优先从新API格式的 results 数组中提取
          if (finalOutputsData.results && Array.isArray(finalOutputsData.results) && finalOutputsData.results.length > 0) {
            const videoResults = finalOutputsData.results.filter((r: any) => 
              r.outputType === 'mp4' || r.url?.includes('.mp4')
            );
            if (videoResults.length > 0) {
              videoUrl = videoResults[0].url;
              if (videoResults.length > 1) {
                console.warn(`[RunningHub] 警告：返回了 ${videoResults.length} 个视频，但只使用第一个`);
              }
            } else {
              videoUrl = finalOutputsData.results[0].url;
            }
          }
          
          // 兼容旧格式：从 data 字段提取
          if (!videoUrl && finalOutputsData.code === 0 && finalOutputsData.data) {
            const files = finalOutputsData.data.files || finalOutputsData.data.outputs || [];
            const videoFiles = files.filter((f: any) => 
              f.url?.includes('.mp4') || 
              f.fileName?.includes('.mp4') ||
              f.outputType === 'mp4'
            );
            if (videoFiles.length > 0) {
              videoUrl = videoFiles[0].url || videoFiles[0].fileUrl || videoFiles[0].fileName;
              if (videoFiles.length > 1) {
                console.warn(`[RunningHub] 警告：返回了 ${videoFiles.length} 个视频，但只使用第一个`);
              }
            } else if (files.length > 0 && files[0].url) {
              videoUrl = files[0].url;
            }
          }
        }
      } catch (outputError: any) {
        console.warn('[RunningHub] 获取输出结果失败:', outputError);
      }
    }
    
    // 计算进度（根据状态估算）
    let progress = 0;
    if (taskStatus === 'SUCCESS') {
      progress = 100;
    } else if (taskStatus === 'RUNNING') {
      progress = 50;
    } else if (taskStatus === 'QUEUED') {
      progress = 10;
    }
    
    return {
      success: true,
      data: statusData.data,
      taskId,
      status: taskStatus,
      progress,
      url: videoUrl,
    };
  } catch (error: any) {
    console.error('[RunningHub] 查询任务状态失败:', error);
    return {
      success: false,
      error: error.message || '查询任务状态失败',
    };
  }
};
