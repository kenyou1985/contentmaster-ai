/**
 * RunningHub API 服务
 * 支持多模板调用：视频模板、音频TTS模板、图片模板
 * API文档: https://www.runninghub.cn/runninghub-api-doc-cn/
 */

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
}

export interface RunningHubAudioOptions {
  text: string;
  model: 'indextts2.0';
  voice?: string;
  speed?: number;
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

/** 通用请求头（官方文档要求） */
const makeHeaders = (apiKey: string) => ({
  'Content-Type': 'application/json',
  'Host': 'www.runninghub.cn',
  'Authorization': `Bearer ${apiKey}`,
});

/**
 * 生成图片（/v1/images/generations）
 */
export const generateImage = async (
  apiKey: string,
  options: RunningHubImageOptions
): Promise<RunningHubResult> => {
  try {
    const requestBody: any = {
      prompt: options.prompt,
      model: options.model,
    };
    if (options.width) requestBody.width = options.width;
    if (options.height) requestBody.height = options.height;
    if (options.num_images) requestBody.n = options.num_images;
    if (options.image_url) requestBody.image_url = options.image_url;

    const response = await fetch(`${BASE_URL}/v1/images/generations`, {
      method: 'POST',
      headers: makeHeaders(apiKey),
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const raw = await response.text();
      let data: any = {};
      try { data = JSON.parse(raw); } catch { /* ignore */ }
      throw new Error(data.error?.message || data.message || data.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    let urls: string[] = [];
    if (data.url) urls = [data.url];
    else if (data.data && Array.isArray(data.data)) urls = data.data.map((item: any) => item.url || item).filter(Boolean);
    else if (data.urls && Array.isArray(data.urls)) urls = data.urls;

    return { success: true, data, url: urls[0], urls: urls.length > 0 ? urls : undefined };
  } catch (error: any) {
    console.error('[RunningHub] 图片生成失败:', error);
    return { success: false, error: error.message || '图片生成失败' };
  }
};

/**
 * 上传图片到 RunningHub（/task/openapi/upload）
 */
const uploadImage = async (apiKey: string, imageUrl: string): Promise<string> => {
  if (imageUrl.includes('runninghub.cn') || imageUrl.includes('rh-images')) {
    return imageUrl;
  }

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) throw new Error(`无法获取图片: ${imageUrl}`);

  const imageBlob = await imageResponse.blob();
  const formData = new FormData();
  formData.append('file', imageBlob, 'image.jpg');
  formData.append('fileType', 'image');
  formData.append('apiKey', apiKey);

  const uploadResponse = await fetch(`${BASE_URL}/task/openapi/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
  });

  if (!uploadResponse.ok) {
    const raw = await uploadResponse.text();
    throw new Error(`图片上传失败: ${raw}`);
  }

  const data = await uploadResponse.json();
  if (data.code !== 0) throw new Error(`图片上传失败: ${data.msg || data.message}`);
  return data.data?.fileName || data.data?.filePath || imageUrl;
};

/**
 * 生成视频（/task/openapi/create 高级模式）
 * 官方文档: https://www.runninghub.cn/runninghub-api-doc-cn/api-425749013
 *
 * 关键要点：
 * - 端点: POST /task/openapi/create
 * - Header 必须包含: Host=www.runninghub.cn, Authorization=Bearer {apiKey}
 * - 请求体: { apiKey, workflowId, workflow?, nodeInfoList? }
 * - nodeInfoList 格式: { nodeId, fieldName, fieldValue }（不是 inputs 嵌套）
 * - 响应: { code, msg, data: { taskId, taskStatus, clientId, netWssUrl } }
 */
export const generateVideo = async (
  apiKey: string,
  options: RunningHubVideoOptions
): Promise<RunningHubResult> => {
  try {
    const workflowId = '2033053099966865410';

    // 官方要求固定 header
    const headers = makeHeaders(apiKey);

    // ── LTX-2 路径：完整 workflow JSON ────────────────────────────────────
    if (options.workflow || options.workflowTemplate) {
      let wf: Record<string, any>;
      if (options.workflow) {
        wf = JSON.parse(JSON.stringify(options.workflow));
      } else {
        wf = JSON.parse(options.workflowTemplate!);
      }

      let uploadedImagePath: string | undefined;
      if (options.image_url) {
        try {
          uploadedImagePath = await uploadImage(apiKey, options.image_url);
          console.log('[RunningHub] LTX-2 图片上传成功:', uploadedImagePath);
        } catch (e: any) {
          throw new Error(`图片上传失败: ${e.message}`);
        }
      }

      // 替换关键节点
      if (uploadedImagePath && wf['269']) wf['269'].inputs.image = uploadedImagePath;
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

    // ── Wan2.2 路径（nodeInfoList）───
    if (!options.image_url) throw new Error('图生视频模式需要提供图片URL');

    let uploadedImagePath: string | undefined;
    try {
      uploadedImagePath = await uploadImage(apiKey, options.image_url);
      console.log('[RunningHub] Wan2.2 图片上传成功:', uploadedImagePath);
    } catch (e: any) {
      throw new Error(`图片上传失败: ${e.message}. 图生视频需要先上传图片`);
    }

    // 官方 nodeInfoList 格式：{ nodeId, fieldName, fieldValue }
    const nodeInfoList: Array<{ nodeId: string; fieldName: string; fieldValue: any }> = [];
    if (uploadedImagePath) {
      nodeInfoList.push({ nodeId: '269', fieldName: 'image', fieldValue: uploadedImagePath });
    }
    if (options.prompt) {
      nodeInfoList.push({ nodeId: '325', fieldName: 'value', fieldValue: options.prompt });
    }

    const requestBody = {
      apiKey,
      workflowId,
      nodeInfoList,
      instanceType: 'plus',
      usePersonalQueue: false,
    };

    console.log('[RunningHub] Wan2.2 请求:', { endpoint: `${BASE_URL}/task/openapi/create`, workflowId, nodeInfoList });

    const response = await fetch(`${BASE_URL}/task/openapi/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    const raw = await response.text();
    console.log('[RunningHub] Wan2.2 响应:', { status: response.status, raw: raw.slice(0, 600) });

    if (!response.ok) {
      let data: any = {};
      try { data = JSON.parse(raw); } catch { /* ignore */ }
      throw new Error(data.msg || data.errorMessage || raw || `HTTP ${response.status}`);
    }

    const data = JSON.parse(raw);
    if (data.code !== 0 || !data.data?.taskId) {
      throw new Error(data.msg || data.errorMessage || 'Wan2.2 视频生成失败（无 taskId）');
    }

    return { success: true, data, taskId: String(data.data.taskId), status: data.data.taskStatus || 'QUEUED', progress: 0 };
  } catch (error: any) {
    console.error('[RunningHub] 视频生成失败:', error);
    return { success: false, error: error.message || '视频生成失败' };
  }
};

/**
 * 生成音频 TTS（/v1/audio/speech）
 */
export const generateAudio = async (
  apiKey: string,
  options: RunningHubAudioOptions
): Promise<RunningHubResult> => {
  try {
    const requestBody: any = { text: options.text, model: options.model || 'indextts2.0' };
    if (options.voice) requestBody.voice = options.voice;
    if (options.speed) requestBody.speed = options.speed;

    const response = await fetch(`${BASE_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: makeHeaders(apiKey),
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const raw = await response.text();
      let data: any = {};
      try { data = JSON.parse(raw); } catch { /* ignore */ }
      throw new Error(data.error?.message || data.message || data.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return { success: true, data, url: data.audio_url || data.url || data.audioUrl };
  } catch (error: any) {
    console.error('[RunningHub] 音频生成失败:', error);
    return { success: false, error: error.message || '音频生成失败' };
  }
};

/**
 * 查询任务状态和输出（/task/openapi/get-outputs + /task/openapi/get-status）
 */
export const checkTaskStatus = async (
  apiKey: string,
  taskId: string
): Promise<RunningHubResult> => {
  const tryParse = (raw: string): any => { try { return JSON.parse(raw); } catch { return {}; } };

  // 尝试 get-outputs（同时返回状态和结果）
  const doOutputs = async (): Promise<{ ok: boolean; status: number; data: any; raw: string }> => {
    const r = await fetch(`${BASE_URL}/task/openapi/get-outputs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, taskId }),
    });
    const raw = await r.text();
    return { ok: r.ok, status: r.status, data: tryParse(raw), raw };
  };

  // 尝试 get-status
  const doStatus = async (): Promise<{ ok: boolean; status: number; data: any; raw: string }> => {
    const r = await fetch(`${BASE_URL}/task/openapi/get-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, taskId }),
    });
    const raw = await r.text();
    return { ok: r.ok, status: r.status, data: tryParse(raw), raw };
  };

  try {
    console.log('[RunningHub] 查询任务:', { taskId });

    // Step 1: get-outputs
    let out = await doOutputs();
    console.log('[RunningHub] get-outputs:', { status: out.status, code: out.data.code, msg: out.data.msg });

    // 从 results 数组（新版格式）提取视频 URL
    const extractFromResults = (d: any): string | undefined => {
      if (d.results && Array.isArray(d.results) && d.results.length > 0) {
        const vids = d.results.filter((r: any) => r.outputType === 'mp4' || r.url?.includes('.mp4'));
        if (vids.length > 0) return vids[0].url;
        return d.results[0].url;
      }
      return undefined;
    };

    // 从 data.files（旧版格式）提取视频 URL
    const extractFromData = (d: any): string | undefined => {
      const files = d.files || d.outputs || [];
      const vid = files.find((f: any) => f.url?.includes('.mp4') || f.fileName?.includes('.mp4') || f.outputType === 'mp4');
      if (vid) return vid.url || vid.fileUrl || vid.fileName;
      if (files.length > 0) return files[0].url || files[0].fileUrl || files[0].fileName;
      return d.videoUrl || d.url;
    };

    let videoUrl = extractFromResults(out.data) || extractFromData(out.data);
    if (videoUrl) {
      return { success: true, data: out.data.data || out.data, taskId, status: out.data.status || 'SUCCESS', progress: 100, url: videoUrl };
    }

    // code=0 但无视频 → 任务还在进行中，尝试 get-status
    if (out.data.code === 0 || out.status === 200) {
      const st = await doStatus();
      console.log('[RunningHub] get-status:', { status: st.status, code: st.data.code, taskStatus: st.data.data?.taskStatus });

      if (st.data.code === 0 || st.ok) {
        const ts = st.data.data?.taskStatus;
        const fr = st.data.data?.failedReason;

        if (ts === 'FAILED') return { success: false, error: fr || '任务执行失败', taskId, status: ts };
        if (ts === 'SUCCESS') {
          const retry = await doOutputs();
          videoUrl = extractFromResults(retry.data) || extractFromData(retry.data);
          return { success: true, data: st.data.data, taskId, status: 'SUCCESS', progress: 100, url: videoUrl };
        }
        // QUEUED / RUNNING
        return { success: true, data: st.data.data, taskId, status: ts || 'RUNNING', progress: ts === 'QUEUED' ? 10 : 50 };
      }

      // get-status 也失败 → 抛出错误
      throw new Error(st.data.msg || `查询失败: code ${st.data.code || st.status}`);
    }

    // get-outputs 返回非 200（如 404）
    throw new Error(out.data.msg || out.data.errorMessage || `HTTP ${out.status}`);
  } catch (error: any) {
    console.error('[RunningHub] 查询任务状态失败:', error);
    return { success: false, error: error.message || '查询任务状态失败' };
  }
};
