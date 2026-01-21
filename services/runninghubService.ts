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
  prompt: string;
  model: 'wan2.2'; // 视频模型固定为wan2.2
  image_url?: string; // 图生视频时使用
  duration?: number; // 视频时长（秒）
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
 * 模型：wan2.2
 * API文档: https://www.runninghub.cn/call-api/api-detail/1930910447648571394?apiType=5
 */
// 导出别名
export const generateVideo = async (
  apiKey: string,
  options: RunningHubVideoOptions
): Promise<RunningHubResult> => {
  try {
    // 使用新的API端点：/run/workflow/{workflowId}
    // Wan2.2图生视频的工作流ID
    const workflowId = '1930910447648571394';
    const endpoint = `/run/workflow/${workflowId}`;
    
    // 根据新API文档，使用 nodeInfoList 参数（节点参数映射列表）
    // 而不是完整的 workflow JSON字符串
    
    // 如果有图片，先上传图片
    let uploadedImagePath: string | undefined;
    if (options.image_url) {
      try {
        uploadedImagePath = await uploadImage(apiKey, options.image_url);
        console.log('[RunningHub] 图片上传成功:', uploadedImagePath);
      } catch (uploadError: any) {
        console.error('[RunningHub] 图片上传失败，无法继续:', uploadError);
        throw new Error(`图片上传失败: ${uploadError.message || uploadError}. 图生视频需要先上传图片到RunningHub服务器`);
      }
    } else {
      throw new Error('图生视频模式需要提供图片URL');
    }
    
    // 构建 nodeInfoList（节点参数映射列表）
    // 根据工作流节点，设置关键参数：
    // - 节点52 (LoadImage): 设置图片路径
    // - 节点88 (PrimitiveStringMultiline): 设置提示词
    // - 节点50 (WanImageToVideo): 设置 batch_size = 1（确保只生成1个视频）
    const nodeInfoList: any[] = [];
    
    // 设置图片输入节点（节点52）
    if (uploadedImagePath) {
      nodeInfoList.push({
        nodeId: '52',
        inputs: {
          image: uploadedImagePath
        }
      });
    }
    
    // 设置提示词节点（节点88）
    if (options.prompt) {
      nodeInfoList.push({
        nodeId: '88',
        inputs: {
          value: options.prompt
        }
      });
    }
    
    // 确保只生成1个视频：设置 batch_size = 1（节点50）
    nodeInfoList.push({
      nodeId: '50',
      inputs: {
        batch_size: 1
      }
    });
    
    // 确保 Pick From Batch 节点也只选择1个（节点78）
    nodeInfoList.push({
      nodeId: '78',
      inputs: {
        count: 1
      }
    });
    
    console.log('[RunningHub] 节点参数列表:', nodeInfoList);
    
    // 构建请求体（使用 nodeInfoList 参数，符合新API文档）
    // 注意：根据 RunningHub API 文档，apiKey 应该放在请求体中，而不是 header
    const requestBody: any = {
      apiKey: apiKey, // API Key 放在请求体中
      nodeInfoList: nodeInfoList,
      instanceType: 'plus', // 视频生成需要更高显存，使用plus类型
      usePersonalQueue: false,
      addMetadata: false, // 可选：是否在输出中添加工作流元数据
    };
    
    console.log('[RunningHub] 视频生成请求:', {
      endpoint: `${BASE_URL}${endpoint}`,
      workflowId,
      prompt: options.prompt.substring(0, 50) + '...',
      hasImage: !!options.image_url,
      imagePath: uploadedImagePath,
      nodeInfoListCount: nodeInfoList.length,
      hasApiKey: !!apiKey,
    });
    
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 注意：RunningHub API 可能不需要 Authorization header，apiKey 在请求体中
      },
      body: JSON.stringify(requestBody),
    });
    
    const responseText = await response.text();
    console.log('[RunningHub] 视频生成响应原始数据:', {
      status: response.status,
      statusText: response.statusText,
      responseText: responseText.substring(0, 500),
    });
    
    if (!response.ok) {
      let errorData: any = {};
      let errorMessage = '';
      
      try {
        errorData = JSON.parse(responseText);
      } catch {
        errorMessage = responseText;
      }
      
      errorMessage = errorMessage || 
        errorData.msg ||
        errorData.error?.message || 
        errorData.errorMessage ||
        errorData.message || 
        errorData.error || 
        `HTTP ${response.status}: ${response.statusText}`;
      
      throw new Error(errorMessage);
    }
    
    const data = JSON.parse(responseText);
    
    console.log('[RunningHub] 视频生成响应:', {
      taskId: data.taskId,
      status: data.status,
      errorCode: data.errorCode,
      errorMessage: data.errorMessage,
      hasResults: !!data.results,
      resultsCount: data.results?.length || 0,
    });
    
    // 检查响应状态（新API格式：直接返回 taskId 和 status，没有 code 字段）
    if (!data.taskId) {
      // 新API格式：错误信息在 errorMessage 字段
      let errorMessage = data.errorMessage || data.errorCode || '视频生成请求失败';
      
      // 常见错误码的中文提示
      const errorMessages: Record<string, string> = {
        'CORPAPIKEY_INSUFFICIENT_FUNDS': '账户余额不足，请前往RunningHub充值',
        'INSUFFICIENT_FUNDS': '账户余额不足，请前往RunningHub充值',
        'APIKEY_INVALID': 'API Key无效，请检查配置',
        'APIKEY_INVALID_NODE_INFO': '节点参数错误，请检查工作流配置',
        'WORKFLOW_NOT_FOUND': '工作流不存在，请检查工作流ID配置',
        'WORKFLOW_NOT_EXISTS': '工作流不存在，请检查工作流ID是否正确',
        'WORKFLOW_NOT_SAVED_OR_NOT_RUNNING': '工作流未保存或未运行过。请在RunningHub网站上打开工作流并保存，然后才能通过API调用',
        'WORKFLOW_ERROR': '工作流执行错误',
      };
      
      // 如果错误码在映射表中，使用友好的中文提示
      if (errorMessages[errorMessage]) {
        errorMessage = errorMessages[errorMessage];
      } else if (errorMessage.includes('INSUFFICIENT_FUNDS')) {
        errorMessage = '账户余额不足，请前往RunningHub充值';
      } else if (errorMessage.includes('APIKEY')) {
        errorMessage = `API配置错误: ${errorMessage}`;
      }
      
      throw new Error(errorMessage);
    }
    
    // 新API格式：直接返回 taskId 和 status
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
