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
}

export interface VideoGenerationOptions {
  model: string;
  prompt: string;
  duration?: number;
  aspect_ratio?: string;
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
    
    // sora_image 使用 chat/completions 端点
    // 注意：模型名称是 sora_image（下划线），不是 sora-image
    if (options.model === 'sora-image' || options.model === 'sora_image') {
      // 构建提示词：原提示词 + 【比例】
      // sora_image 只支持三种比例：1:1, 2:3, 3:2
      let finalPrompt = options.prompt;
      
      // 从 size 中提取比例（格式：widthxheight）
      let ratio = '1:1'; // 默认比例
      if (options.size) {
        const [width, height] = options.size.split('x').map(Number);
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
            content: finalPrompt
          }
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
          throw new Error(`模型 "${options.model}" 在当前账户中不可用。\n\n可能原因：\n1. 该模型需要特殊权限或白名单\n2. 该模型暂未在您的账户中启用\n3. 当前账户余额不足或配额已用完\n\n建议：\n- 联系 yunwu.ai 客服确认模型可用性和账户权限\n- 或尝试使用其他视频生成模型`);
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
    
    // banana 和 banana-2 使用 Gemini 图片生成模型，需要使用 Google Gemini 原生端点
    // banana -> gemini-2.5-flash-image
    // banana-2 -> gemini-3-pro-image-preview
    if (options.model === 'banana' || options.model === 'banana-2') {
      const modelName = options.model === 'banana' 
        ? 'gemini-2.5-flash-image' 
        : 'gemini-3-pro-image-preview';
      
      // 使用 Google Gemini 原生格式端点
      const endpoint = `/v1beta/models/${modelName}:generateContent`;
      
      // 构建 Gemini 格式的请求体
      let body: any = {
        contents: [
          {
            parts: [
              {
                text: options.prompt
              }
            ]
          }
        ]
      };
      
      // 添加生成配置（支持宽高比和清晰度）
      const generationConfig: any = {};
      
      // 处理宽高比（从 size 中提取）
      if (options.size) {
        const [width, height] = options.size.split('x').map(Number);
        if (width && height) {
          // Gemini 使用 aspectRatio 字段，格式为 "1:1", "16:9" 等
          const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
          const divisor = gcd(width, height);
          const aspectRatio = `${width / divisor}:${height / divisor}`;
          generationConfig.aspectRatio = aspectRatio;
        }
      }
      
      // 处理清晰度（quality）
      if (options.quality) {
        generationConfig.quality = options.quality;
      }
      
      if (Object.keys(generationConfig).length > 0) {
        body.generationConfig = generationConfig;
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
        const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
        const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
        throw new Error(errorMessage);
      }
      
      const data = await response.json();
      
      // 解析 Gemini 格式的响应
      // Gemini 返回格式：{ candidates: [{ content: { parts: [{ inlineData: { data, mimeType } }] } }] }
      let imageUrls: string[] = [];
      
      if (data.candidates && Array.isArray(data.candidates)) {
        for (const candidate of data.candidates) {
          if (candidate.content?.parts) {
            for (const part of candidate.content.parts) {
              // 检查是否有 inlineData（base64 图片）
              if (part.inlineData?.data) {
                // 如果是 base64，需要转换为 data URL 或上传到图床
                // 这里先尝试查找 URL
                const base64Data = part.inlineData.data;
                const mimeType = part.inlineData.mimeType || 'image/png';
                // 创建 data URL（注意：可能很大，建议上传到图床）
                imageUrls.push(`data:${mimeType};base64,${base64Data}`);
              }
              // 检查是否有 URL
              if (part.url) {
                imageUrls.push(part.url);
              }
            }
          }
        }
      }
      
      // 如果没找到，尝试从其他字段提取
      if (imageUrls.length === 0) {
        if (data.data && Array.isArray(data.data)) {
          imageUrls = data.data.map((item: any) => item.url || item).filter(Boolean);
        } else if (data.url) {
          imageUrls = [data.url];
        }
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
      
      console.error('[YunwuService] Gemini 图片生成响应数据:', data);
      throw new Error('无法从响应中提取图片URL，请检查响应格式');
    }
    
    // grok-3-image 和 grok-4-image 使用 chat/completions 端点（类似 sora-image）
    if (options.model === 'grok-3-image' || options.model === 'grok-4-image') {
      const modelName = options.model === 'grok-3-image' ? 'grok-3-image' : 'grok-4-image';
      
      // 使用 chat/completions 端点
      const endpoint = '/v1/chat/completions';
      const body = {
        model: modelName,
        messages: [
          {
            role: 'user',
            content: options.prompt
          }
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
        const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
        throw new Error(errorMessage);
      }
      
      const data = await response.json();
      
      // 解析 chat/completions 响应格式
      // grok 系列返回的可能是 Markdown 格式的图片链接或 JSON
      let imageUrls: string[] = [];
      
      if (data.choices && Array.isArray(data.choices)) {
        for (const choice of data.choices) {
          if (choice.message?.content) {
            const content = choice.message.content;
            
            // 提取 Markdown 格式的图片链接：![图片](url)
            const markdownImagePattern = /!\[.*?\]\((https?:\/\/[^\s\)]+)\)/g;
            let match;
            while ((match = markdownImagePattern.exec(content)) !== null) {
              if (match[1]) {
                imageUrls.push(match[1]);
              }
            }
            
            // 如果没有找到 Markdown 格式，尝试解析 JSON
            if (imageUrls.length === 0) {
              try {
                const parsed = typeof content === 'string' ? JSON.parse(content) : content;
                if (parsed.url) {
                  imageUrls.push(parsed.url);
                } else if (parsed.urls && Array.isArray(parsed.urls)) {
                  imageUrls.push(...parsed.urls.filter(Boolean));
                } else if (parsed.images && Array.isArray(parsed.images)) {
                  imageUrls.push(...parsed.images.map((img: any) => img.url || img).filter(Boolean));
                }
              } catch {
                // 如果不是 JSON，尝试直接提取 URL
                const urlPattern = /https?:\/\/[^\s\)"']+\.(jpg|jpeg|png|gif|webp)/gi;
                const matches = content.match(urlPattern);
                if (matches) {
                  imageUrls.push(...matches);
                }
              }
            }
          }
        }
      }
      
      // 如果从 choices 中提取到了图片，返回
      if (imageUrls.length > 0) {
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
      
      console.error('[YunwuService] grok 图片生成响应数据:', data);
      throw new Error('无法从响应中提取图片URL，请检查响应格式');
    }
    
    // flux-1-kontext-dev 使用正确的模型名称 flux.1-kontext-dev
    if (options.model === 'flux-1-kontext-dev') {
      // 使用正确的模型名称（点号格式）
      const modelName = 'flux.1-kontext-dev';
      
      // 使用 images/generations 端点
      const endpoint = '/v1/images/generations';
      let body: any = {
        model: modelName,
        prompt: options.prompt,
      };
      
      // 添加可选参数
      if (options.size) body.size = options.size;
      if (options.quality) body.quality = options.quality;
      if (options.n) body.n = options.n;
      
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
      
      return {
        success: true,
        data,
        url: data.data?.[0]?.url || data.url,
      };
    }
    
    // 其他模型使用 images/generations 端点
    let endpoint = '/v1/images/generations';
    let body: any = {
      model: options.model,
      prompt: options.prompt,
    };
    
    // 添加可选参数
    if (options.size) body.size = options.size;
    if (options.quality) body.quality = options.quality;
    if (options.n) body.n = options.n;
    
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
    
    return {
      success: true,
      data,
      url: data.data?.[0]?.url || data.url,
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
export const generateVideo = async (
  apiKey: string,
  options: VideoGenerationOptions
): Promise<GenerationResult> => {
  try {
    const baseUrl = 'https://yunwu.ai';
    
    // sora-2-all 支持多个端点，优先尝试 /v1/videos，失败则尝试 /v1/video/create
    if (options.model === 'sora-2-all') {
      const endpoints = ['/v1/videos', '/v1/video/create'];
      
      for (const endpoint of endpoints) {
        try {
          let body: any = {
            model: options.model,
            prompt: options.prompt,
          };
          
          // 添加可选参数
          if (options.duration) body.duration = options.duration;
          if (options.aspect_ratio) {
            body.aspect_ratio = options.aspect_ratio;
          }
          
          const response = await fetch(`${baseUrl}${endpoint}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
          });
          
          if (response.ok) {
            const data = await response.json();
            return {
              success: true,
              data,
              url: data.url || data.data?.[0]?.url,
              taskId: data.task_id || data.id || data.taskId,
            };
          } else {
            // 如果这个端点失败，尝试下一个
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.error?.message || errorData.message || `HTTP ${response.status}: ${response.statusText}`;
            console.warn(`[YunwuService] sora-2-all 端点 ${endpoint} 失败:`, errorData);
            
            // 如果是"模型不可用"错误，直接抛出，不尝试下一个端点
            if (errorMessage.includes('No available channels') || errorMessage.includes('not available')) {
              throw new Error(`模型 "${options.model}" 在当前账户中不可用。\n\n可能原因：\n1. 该模型需要特殊权限或白名单\n2. 该模型暂未在您的账户中启用\n3. 当前账户余额不足或配额已用完\n\n建议：\n- 联系 yunwu.ai 客服确认模型可用性和账户权限\n- 或尝试使用其他视频生成模型`);
            }
            
            // 检查是否是服务器负载饱和的错误
            if (errorMessage.includes('负载已饱和') || errorMessage.includes('saturated') || errorMessage.includes('负载') || response.status === 500) {
              throw new Error(`服务器暂时繁忙，请稍后重试。\n\n错误详情：${errorMessage}\n\n建议：\n1. 等待 30 秒 - 2 分钟后重试\n2. 尝试使用其他视频生成模型\n3. 如果是高峰期，建议错峰使用`);
            }
            
            if (endpoint === endpoints[endpoints.length - 1]) {
              // 最后一个端点也失败，抛出错误
              throw new Error(errorMessage);
            }
            continue;
          }
        } catch (error: any) {
          if (endpoint === endpoints[endpoints.length - 1]) {
            throw error;
          }
          continue;
        }
      }
    }
    
    // grok-video-3 使用 /v1/video/create 端点
    if (options.model === 'grok-video-3') {
      const endpoint = '/v1/video/create';
      let body: any = {
        model: options.model,
        prompt: options.prompt,
      };
      
      // 添加可选参数
      if (options.duration) body.duration = options.duration;
      if (options.aspect_ratio) {
        body.aspect_ratio = options.aspect_ratio;
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
        const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
        const errorMessage = errorData.error?.message || errorData.message || `HTTP ${response.status}: ${response.statusText}`;
        
        // 检查是否是"模型不可用"的错误
        if (errorMessage.includes('No available channels') || errorMessage.includes('not available')) {
          throw new Error(`模型 "${options.model}" 在当前账户中不可用。\n\n可能原因：\n1. 该模型需要特殊权限或白名单\n2. 该模型暂未在您的账户中启用\n3. 当前账户余额不足或配额已用完\n\n建议：\n- 联系 yunwu.ai 客服确认模型可用性和账户权限\n- 或尝试使用其他视频生成模型`);
        }
        
        throw new Error(errorMessage);
      }
      
      const data = await response.json();
      
      // 异步任务，返回 task_id
      return {
        success: true,
        data,
        url: data.url || data.data?.[0]?.url,
        taskId: data.task_id || data.id || data.taskId,
      };
    }
    
    // veo_3_1-fast 和 veo_3_1-fast-4K 使用 /v1/videos 端点
    if (options.model === 'veo_3_1-fast' || options.model === 'veo_3_1-fast-4K') {
      const endpoint = '/v1/videos';
      let body: any = {
        model: options.model,
        prompt: options.prompt,
      };
      
      // 添加可选参数
      if (options.duration) body.duration = options.duration;
      if (options.aspect_ratio) body.aspect_ratio = options.aspect_ratio;
      
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
          throw new Error(`模型 "${options.model}" 在当前账户中不可用。\n\n可能原因：\n1. 该模型需要特殊权限或白名单\n2. 该模型暂未在您的账户中启用\n3. 当前账户余额不足或配额已用完\n\n建议：\n- 联系 yunwu.ai 客服确认模型可用性和账户权限\n- 或尝试使用其他视频生成模型`);
        }
        
        throw new Error(errorMessage);
      }
      
      const data = await response.json();
      
      // veo_3_1 系列可能是异步任务，返回 task_id
      return {
        success: true,
        data,
        url: data.url || data.data?.[0]?.url,
        taskId: data.task_id || data.id || data.taskId,
      };
    }
    
    // 其他模型使用 /v1/videos 端点（/v1/videos/generations 不存在，改为 /v1/videos）
    let endpoint = '/v1/videos';
    let body: any = {
      model: options.model,
      prompt: options.prompt,
    };
    
    // 添加可选参数
    if (options.duration) body.duration = options.duration;
    if (options.aspect_ratio) body.aspect_ratio = options.aspect_ratio;
    
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
        throw new Error(`模型 "${options.model}" 在当前账户中不可用。\n\n可能原因：\n1. 该模型需要特殊权限或白名单\n2. 该模型暂未在您的账户中启用\n3. 当前账户余额不足或配额已用完\n\n建议：\n- 联系 yunwu.ai 客服确认模型可用性和账户权限\n- 或尝试使用其他视频生成模型`);
      }
      
      // 检查是否是服务器负载饱和的错误
      if (errorMessage.includes('负载已饱和') || errorMessage.includes('saturated') || errorMessage.includes('负载') || response.status === 500) {
        throw new Error(`服务器暂时繁忙，请稍后重试。\n\n错误详情：${errorMessage}\n\n建议：\n1. 等待 30 秒 - 2 分钟后重试\n2. 尝试使用其他视频生成模型\n3. 如果是高峰期，建议错峰使用`);
      }
      
      throw new Error(errorMessage);
    }
    
    const data = await response.json();
    
    return {
      success: true,
      data,
      url: data.data?.[0]?.url || data.url,
      taskId: data.task_id || data.id,
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
