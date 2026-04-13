/**
 * 剪映草稿导出服务（前端调用层）
 * 本地开发：Vite proxy `/api/jianying` → 本机 18091，Python 直接写入剪映草稿目录。
 * 线上（Vercel）：`VITE_JIANYING_API_BASE` 指向 Railway，Linux 侧生成 ZIP 供下载。
 */

/** 是否为本机/局域网访问（应走本机剪映服务，不强制 Railway ZIP） */
export function isJianyingLocalSiteOrigin(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(h)) return true;
  return false;
}

/**
 * 是否使用远程打包 ZIP 并展示下载链接（典型：Vercel 部署访问线上 API）。
 * 本地站点为 false：直接导出到本机剪映草稿目录，不经 Railway 中转。
 */
export function shouldUseJianyingZipDownload(): boolean {
  if (import.meta.env.VITE_JIANYING_FORCE_ZIP === 'true') return true;
  if (import.meta.env.VITE_JIANYING_FORCE_ZIP === 'false') return false;
  if (isJianyingLocalSiteOrigin()) return false;
  return true;
}

/**
 * 剪映 HTTP API 根路径。
 * 本地开发强制同源 `/api/jianying`，避免 `.env` 里 `VITE_JIANYING_API_BASE` 指向 Railway 时仍请求远程。
 */
export function getJianyingApiBase(): string {
  if (typeof window !== 'undefined' && isJianyingLocalSiteOrigin()) {
    return '/api/jianying';
  }
  return (import.meta.env.VITE_JIANYING_API_BASE || '/api/jianying').replace(/\/$/, '');
}

export interface JianyingShot {
  /** 镜头字幕文案 */
  caption?: string;
  /** 时长（秒），默认 5；视频镜头以实际文件时长为准；有配音时服务端以音频时长覆盖 */
  duration?: number;
  /** 图片 URL（http / data: / blob:）*/
  imageUrl?: string;
  /** 视频 URL（优先于图片写入时间线） */
  videoUrl?: string;
  /** 配音音频 URL（http / data: / blob:）*/
  audioUrl?: string;
  /** 与 Python 导出脚本字段一致（同 audioUrl，二选一即可） */
  voiceoverAudioUrl?: string;
  /** 浏览器探测的配音时长（秒），服务端 ffprobe 失败时用于对齐时间线 */
  audioDurationSec?: number;
}

export interface JianyingExportOptions {
  /** 草稿名称 */
  draftName: string;
  /** 镜头列表 */
  shots: JianyingShot[];
  /** 分辨率，如 "1920x1080" | "1080x1920" | "16:9" | "9:16" */
  resolution?: string;
  /** 帧率，默认 30 */
  fps?: number;
  /** 输出目录（不填则用剪映默认草稿目录） */
  outputPath?: string;
  /** 将服务端草稿绝对路径映射到本机路径根（用于跨机导入） */
  pathMapRoot?: string;
  /** 片段间随机转场（剪映内置资源 ID，与 pyJianYingDraft 一致） */
  randomTransitions?: boolean;
  /** 每段随机滤镜（强度适中，剪映版本差异时可能需手动调整） */
  randomVideoEffects?: boolean;
}

export interface JianyingDraftInfo {
  id: string;
  name: string;
  path: string;
  json_file: string;
  duration: number;
  modified: number;
  cover: string;
}

export interface JianyingExportResult {
  success: boolean;
  platform: string;
  draft_name: string;
  shots_count: number;
  resolution: string;
  fps: number;
  draft_folder?: string;
  total_duration?: number;
  zip_path?: string;
  zip_download_url?: string;
  /** 是否使用了 railway 远程服务（用于构建正确的下载链接） */
  usedRailway?: boolean;
  message: string;
  error?: string;
  download_issue_count?: number;
  download_issues?: Array<{
    shot: number;
    kind: 'audio' | 'video' | 'image' | string;
    url?: string;
    reason?: string;
  }>;
}

export interface JianyingHealth {
  status: string;
  script: string;
  exists: boolean;
}

/** 健康检查 */
export async function checkJianyingHealth(): Promise<JianyingHealth> {
  const res = await fetch(`${getJianyingApiBase()}/health`);
  if (!res.ok) throw new Error(`服务不可用 (${res.status})`);
  return res.json();
}

/**
 * 预热 Railway 服务（解决免费版睡眠唤醒延迟问题）
 * Railway 免费版 15 分钟无请求后会睡眠，唤醒需要 30-60 秒
 * 此函数会 ping 健康检查端点，给服务时间启动
 */
export async function warmupJianyingService(timeoutMs: number = 60000): Promise<boolean> {
  const base = getJianyingApiBase();
  const startTime = Date.now();
  const maxWait = timeoutMs;

  console.log(`[JianyingExport] 开始预热 Railway 服务: ${base}`);

  while (Date.now() - startTime < maxWait) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒单次超时

      const res = await fetch(`${base}/health`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        console.log(`[JianyingExport] Railway 服务已唤醒，耗时: ${Date.now() - startTime}ms`);
        return true;
      }
    } catch {
      // 服务还在睡眠中，继续等待
    }
    // 等待 3 秒再试
    await new Promise(r => setTimeout(r, 3000));
  }

  console.warn(`[JianyingExport] Railway 服务预热超时 (${maxWait}ms)，继续尝试导出...`);
  return false;
}

/** 列出剪映所有草稿 */
export async function listJianyingDrafts(): Promise<JianyingDraftInfo[]> {
  const res = await fetch(`${getJianyingApiBase()}/list`);
  if (!res.ok) throw new Error(`列表查询失败 (${res.status})`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function tryParseJsonObject(raw: string): JianyingExportResult | null {
  const t = raw.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t) as JianyingExportResult;
    if (o && typeof o === 'object') return o;
  } catch {
    /* ignore */
  }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as JianyingExportResult;
      if (o && typeof o === 'object') return o;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 服务端偶发返回纯文本 / 日志行而非 JSON；200 时尽量识别成功，避免误报「导出异常」 */
function coerceExportResultFromText(
  text: string,
  options: JianyingExportOptions,
  httpOk: boolean
): JianyingExportResult {
  const parsed = tryParseJsonObject(text);
  if (parsed) return parsed;

  if (!httpOk) {
    return {
      success: false,
      platform: 'jianying',
      draft_name: options.draftName,
      shots_count: options.shots.length,
      resolution: options.resolution || '1920x1080',
      fps: options.fps || 30,
      message: text.slice(0, 300),
      error: text.slice(0, 500),
    };
  }

  const low = text.toLowerCase();
  const bracketLog = text.trim().startsWith('[');
  const looksLikeSuccess =
    (/success|完成|已生成|draft|草稿|contentmaster/i.test(text) && !/error|失败|fail|exception/i.test(low)) ||
    (bracketLog && !/error|失败|fail|traceback|exception/i.test(low) && text.length < 4000) ||
    (text.length > 0 && text.length < 8000 && !/error|traceback|exception|失败/i.test(low));

  if (looksLikeSuccess) {
    return {
      success: true,
      platform: 'jianying',
      draft_name: options.draftName,
      shots_count: options.shots.length,
      resolution: options.resolution || '1920x1080',
      fps: options.fps || 30,
      draft_folder: text.trim().slice(0, 240),
      message: text.trim().slice(0, 500) || '导出完成（非 JSON 响应，已按成功处理）',
    };
  }

  return {
    success: false,
    platform: 'jianying',
    draft_name: options.draftName,
    shots_count: options.shots.length,
    resolution: options.resolution || '1920x1080',
    fps: options.fps || 30,
    message: text.slice(0, 300),
    error: `无法解析导出响应: ${text.slice(0, 200)}`,
  };
}

/** Base64（大文件分块，避免栈溢出） */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(binary);
}

function inferAudioMimeFromUrl(url: string): string | undefined {
  const m = url.split(/[?#]/)[0].match(/\.(flac|wav|mp3|m4a|aac|ogg|webm)$/i);
  if (!m) return undefined;
  const ext = m[1].toLowerCase();
  const map: Record<string, string> = {
    flac: 'audio/flac',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    webm: 'audio/webm',
  };
  return map[ext];
}

/**
 * 剪映导出服务跑在本地，无法带浏览器 Cookie；RunningHub 等外链音频服务端 urllib 常下载失败。
 * 导出前在浏览器拉取配音字节并转为 data: URL，Python 端可直接落盘，保证音轨与时长对齐。
 *
 * 注意：当 returnZip=true（Railway 环境）时，改为直接传 URL，由 Railway 服务端下载，
 * 这样可以避免前端 base64 编码/上传的大文件传输开销，速度更快。
 */
export async function embedAudioDataUrlsForJianyingExport(
  shots: JianyingShot[],
  returnZip: boolean = false
): Promise<JianyingShot[]> {
  const out: JianyingShot[] = [];
  for (const s of shots) {
    const raw = (s.audioUrl || s.voiceoverAudioUrl)?.trim();
    if (!raw) {
      out.push(s);
      continue;
    }
    // 已经 base64 的直接用
    if (raw.startsWith('data:')) {
      out.push(s);
      continue;
    }
    // 非 HTTP URL（如 blob:）转 base64
    if (!/^https?:\/\//i.test(raw)) {
      try {
        const r = await fetch(raw);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const mime = r.headers.get('content-type')?.split(';')[0]?.trim() || inferAudioMimeFromUrl(raw) || 'audio/mpeg';
        const data = await r.arrayBuffer();
        const dataUrl = `data:${mime};base64,${arrayBufferToBase64(data)}`;
        out.push({ ...s, audioUrl: dataUrl, voiceoverAudioUrl: dataUrl });
      } catch {
        out.push(s);
      }
      continue;
    }

    // Railway 环境：直接传 URL，由服务端下载（更快）
    if (returnZip) {
      out.push(s);
      continue;
    }

    // 本地环境：转 base64 避免跨域问题
    try {
      let data: ArrayBuffer;
      let mime = '';
      try {
        const r = await fetch(raw);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        mime = r.headers.get('content-type')?.split(';')[0]?.trim() || '';
        data = await r.arrayBuffer();
      } catch {
        // 本地环境 fetch 失败时降级到代理
        if (typeof window === 'undefined') throw new Error('fetch failed');
        const proxy = `/__image_proxy?url=${encodeURIComponent(raw)}`;
        const r2 = await fetch(proxy);
        if (!r2.ok) {
          const t = await r2.text().catch(() => '');
          throw new Error(`proxy ${r2.status}: ${t.slice(0, 200)}`);
        }
        mime = r2.headers.get('content-type')?.split(';')[0]?.trim() || '';
        data = await r2.arrayBuffer();
      }
      const ct =
        mime && mime !== 'application/octet-stream' ? mime : inferAudioMimeFromUrl(raw) || 'audio/mpeg';
      const dataUrl = `data:${ct};base64,${arrayBufferToBase64(data)}`;
      out.push({ ...s, audioUrl: dataUrl, voiceoverAudioUrl: dataUrl });
    } catch (e) {
      console.warn('[JianyingExport] 浏览器拉取配音失败，仍尝试由服务端下载 URL:', e);
      out.push(s);
    }
  }
  return out;
}

/** Railway 打包下载：直接读取完整响应（Railway 代理会缓冲 chunked 数据） */
async function legacyJianyingExportSync(
  base: string,
  payload: Record<string, unknown>,
  options: JianyingExportOptions,
  timeoutMs: number = 600_000,
  onProgress?: (progress: number, message: string) => void
): Promise<JianyingExportResult> {
  onProgress?.(10, '上传数据到 Railway...');
  const legacyRes = await fetch(`${base}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!legacyRes.ok) {
    const legacyText = await legacyRes.text().catch(() => '');
    const parsed = tryParseJsonObject(legacyText);
    const detail = parsed?.error || parsed?.message || legacyText.slice(0, 400);
    throw new Error(`导出请求失败 (${legacyRes.status})${detail ? ': ' + detail : ''}`);
  }

  // Railway 代理缓冲导致无法流式读取，直接读完整响应
  onProgress?.(90, '读取响应...');
  const legacyText = await legacyRes.text().catch(() => '');
  const parsed = tryParseJsonObject(legacyText);
  if (parsed) return { ...parsed, usedRailway: base.includes('railway') } as JianyingExportResult;
  return { ...coerceExportResultFromText(legacyText, options, true), usedRailway: base.includes('railway') } as JianyingExportResult;
}

/** 批量导出剪映草稿（Railway 用异步 + SSE 进度订阅 + 结果轮询） */
export async function exportJianyingDraft(
  options: JianyingExportOptions,
  onProgress?: (progress: number, message: string) => void
): Promise<JianyingExportResult> {
  const returnZip = shouldUseJianyingZipDownload();
  const shots = await embedAudioDataUrlsForJianyingExport(options.shots, returnZip);

  const payload = {
    draftName: options.draftName,
    shots,
    resolution: options.resolution || '1920x1080',
    fps: options.fps || 30,
    outputPath: options.outputPath || null,
    pathMapRoot: options.pathMapRoot || null,
    randomTransitions: !!options.randomTransitions,
    randomVideoEffects: !!options.randomVideoEffects,
    returnZip,
  };

  const base = getJianyingApiBase();
  const railwayBase = (import.meta.env.VITE_JIANYING_API_BASE || '').replace(/\/$/, '');
  const isRailway = base === railwayBase && railwayBase.includes('railway');

  // Railway 预热
  if (isRailway && !isJianyingLocalSiteOrigin()) {
    console.log('[JianyingExport] 检测到 Railway，预热服务...');
    await warmupJianyingService(90000);
    onProgress?.(5, '服务已唤醒，准备导出...');
  } else {
    onProgress?.(5, '准备导出...');
  }

  // Railway 用异步接口（提交任务 + SSE 订阅进度 + 轮询结果）
  if (isRailway && !isJianyingLocalSiteOrigin()) {
    return await exportViaRailwayAsync(railwayBase, payload, onProgress);
  }

  // 本地开发：尝试异步接口，失败则降级同步
  try {
    const startRes = await fetch(`${base}/export/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });

    const startText = await startRes.text().catch(() => '');
    if (startRes.status === 404 || startRes.status === 0) {
      return legacyJianyingExportSync(base, payload, options);
    }

    if (!startRes.ok) {
      if (railwayBase && isJianyingLocalSiteOrigin()) {
        console.warn('[JianyingExport] 本地服务报错，切换 Railway...');
        onProgress?.(5, '切换 Railway...');
        return await exportViaRailwayAsync(railwayBase, { ...payload, returnZip: true }, onProgress);
      }
      const parsed = tryParseJsonObject(startText);
      throw new Error(parsed?.error || parsed?.message || startText.slice(0, 400));
    }

    const startObj = tryParseJsonObject(startText) as any;
    const taskId = startObj?.taskId;
    if (!taskId) {
      return legacyJianyingExportSync(base, payload, options);
    }

    onProgress?.(10, '任务已提交，等待处理...');
    return await pollForResult(taskId, base, false, options, onProgress);
  } catch {
    if (railwayBase) {
      console.warn('[JianyingExport] 异步请求失败，降级到 Railway...');
      onProgress?.(5, '降级到 Railway...');
      return await exportViaRailwayAsync(railwayBase, { ...payload, returnZip: true }, onProgress);
    }
    throw new Error('服务连接失败，请检查本地剪映服务是否运行');
  }
}

/** Railway 异步导出：提交任务 + SSE 进度订阅 + 结果轮询 */
async function exportViaRailwayAsync(
  railwayBase: string,
  payload: Record<string, unknown>,
  onProgress?: (progress: number, message: string) => void
): Promise<JianyingExportResult> {
  onProgress?.(10, '提交导出任务...');

  // 1. 提交任务，获取 taskId
  const startRes = await fetch(`${railwayBase}/export/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });

  if (!startRes.ok) {
    const text = await startRes.text().catch(() => '');
    // 如果 /export/start 不可用，降级到同步接口
    if (startRes.status === 404) {
      console.warn('[JianyingExport] Railway /export/start 不可用，降级到同步...');
      onProgress?.(10, '同步处理中...');
      return legacyJianyingExportSync(railwayBase, payload, {} as JianyingExportOptions, 600_000, onProgress);
    }
    const parsed = tryParseJsonObject(text);
    throw new Error(parsed?.error || `提交失败 (${startRes.status}): ${text.slice(0, 200)}`);
  }

  const startObj = tryParseJsonObject(await startRes.text()) as any;
  const taskId = startObj?.taskId;
  if (!taskId) {
    console.warn('[JianyingExport] 无 taskId，降级到同步...');
    return legacyJianyingExportSync(railwayBase, payload, {} as JianyingExportOptions, 600_000, onProgress);
  }

  onProgress?.(15, `任务已提交 (${taskId.slice(0, 8)}...)，等待处理...`);

  // 2. SSE 订阅进度（Railway 代理对 SSE 支持比 chunked encoding 好）
  const sseDone = await new Promise<void>((resolve) => {
    const sseUrl = `${railwayBase}/export/sse/${encodeURIComponent(taskId)}`;
    const es = new EventSource(sseUrl);
    let settled = false;

    const settle = () => {
      if (settled) return;
      settled = true;
      es.close();
      resolve();
    };

    // 30 秒超时自动切换轮询
    const timeout = setTimeout(() => {
      console.warn('[JianyingExport] SSE 超时，切换轮询...');
      settle();
    }, 30000);

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'error' || data.status === 'failed') {
          console.error('[JianyingExport] 任务失败:', data.error);
          settle();
          return;
        }
        if (data.progress !== undefined && data.progress > 0) {
          onProgress?.(Math.min(data.progress, 95), data.message || '处理中...');
        }
        if (data.status === 'success') {
          clearTimeout(timeout);
          settle();
        }
      } catch { /* ignore */ }
    };

    es.onerror = () => {
      console.warn('[JianyingExport] SSE 连接断开，切换轮询...');
      clearTimeout(timeout);
      settle();
    };
  });

  // 3. 轮询结果（最多 10 分钟）
  const maxPolls = 120; // 5 秒一次，共 10 分钟
  for (let i = 0; i < maxPolls; i++) {
    try {
      const statusRes = await fetch(`${railwayBase}/export/status/${taskId}`, {
        signal: AbortSignal.timeout(10000),
      });

      if (statusRes.ok) {
        const status = tryParseJsonObject(await statusRes.text()) as any;
        if (status?.status === 'success') {
          onProgress?.(100, '导出完成！');
          // 获取结果
          const resultRes = await fetch(`${railwayBase}/export/result/${taskId}`, {
            signal: AbortSignal.timeout(30000),
          });
          if (resultRes.ok) {
            const result = tryParseJsonObject(await resultRes.text());
            if (result) return { ...result, usedRailway: true } as JianyingExportResult;
          }
          return { ...status, usedRailway: true } as JianyingExportResult;
        }
        if (status?.status === 'failed') {
          throw new Error(status.error || '导出任务失败');
        }
        if (status?.progress !== undefined) {
          onProgress?.(Math.min(status.progress, 95), status.message || '处理中...');
        }
      }
    } catch { /* 忽略单次轮询错误 */ }

    await new Promise(r => setTimeout(r, 5000));
  }

  throw new Error('导出超时（10分钟），请重试');
}

/** 轮询获取任务结果 */
async function pollForResult(
  taskId: string,
  pollBase: string,
  usedRailway: boolean,
  options: JianyingExportOptions,
  onProgress?: (progress: number, message: string) => void
): Promise<JianyingExportResult> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const maxPoll = 300; // 最多约 10 分钟（轮询间隔 2 秒）
  let lastProgress = 0;

  for (let i = 0; i < maxPoll; i++) {
    await sleep(2000);

    try {
      const statusRes = await fetch(`${pollBase}/export/status/${encodeURIComponent(taskId)}`);
      const statusText = await statusRes.text().catch(() => '');
      const statusObj = tryParseJsonObject(statusText) as any;
      const status = String(statusObj?.status || '').toLowerCase();

      // 更新进度
      if (statusObj?.progress !== undefined && statusObj.progress > lastProgress) {
        lastProgress = statusObj.progress;
        onProgress?.(statusObj.progress, statusObj.message || '处理中...');
      }

      if (status === 'success') {
        const resultRes = await fetch(`${pollBase}/export/result/${encodeURIComponent(taskId)}`);
        const resultText = await resultRes.text().catch(() => '');
        if (!resultRes.ok) {
          const parsed = tryParseJsonObject(resultText);
          const detail = parsed?.error || parsed?.message || resultText.slice(0, 400);
          throw new Error(`导出结果获取失败 (${resultRes.status})${detail ? ': ' + detail : ''}`);
        }
        const parsed = tryParseJsonObject(resultText);
        if (parsed) return { ...parsed, usedRailway };
        return { ...coerceExportResultFromText(resultText, options, true), usedRailway };
      }

      if (status === 'failed') {
        const detail = statusObj?.error || statusObj?.message || '导出任务失败';
        throw new Error(String(detail));
      }
    } catch (e) {
      // 网络错误时短暂等待后重试（最多 3 次）
      if (i < maxPoll - 3) {
        console.warn(`[JianyingExport] 轮询出错 (${i + 1}/${maxPoll}):`, e);
        await sleep(3000);
        continue;
      }
      throw e;
    }
  }

  throw new Error('导出任务超时（轮询超过 10 分钟）');
}
