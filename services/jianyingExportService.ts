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
  caption?: string;
  duration?: number;
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  voiceoverAudioUrl?: string;
  audioDurationSec?: number;
}

export interface JianyingExportOptions {
  draftName: string;
  shots: JianyingShot[];
  resolution?: string;
  fps?: number;
  outputPath?: string;
  pathMapRoot?: string;
  randomTransitions?: boolean;
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
  usedRailway?: boolean;
  message: string;
  error?: string;
  download_issue_count?: number;
  download_issues?: Array<{ shot: number; kind: string; url?: string; reason?: string }>;
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
 */
export async function warmupJianyingService(timeoutMs: number = 60000): Promise<boolean> {
  const base = getJianyingApiBase();
  const startTime = Date.now();
  const maxWait = timeoutMs;

  console.log(`[JianyingExport] 开始预热 Railway 服务: ${base}`);

  while (Date.now() - startTime < maxWait) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

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
  } catch { /* ignore */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as JianyingExportResult;
      if (o && typeof o === 'object') return o;
    } catch { /* ignore */ }
  }
  return null;
}

/** 服务端偶发返回纯文本 / 日志行而非 JSON；200 时尽量识别成功 */
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
  const looksLikeSuccess =
    (/success|完成|已生成|draft|草稿|contentmaster/i.test(text) && !/error|失败|fail|exception/i.test(low)) ||
    (text.trim().startsWith('[') && !/error|失败|fail|traceback|exception/i.test(low) && text.length < 4000) ||
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
    flac: 'audio/flac', wav: 'audio/wav', mp3: 'audio/mpeg',
    m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', webm: 'audio/webm',
  };
  return map[ext];
}

/**
 * 导出前在浏览器拉取配音字节并转为 data: URL，Python 端可直接落盘，保证音轨与时长对齐。
 * Railway 环境（returnZip=true）直接传 URL，由服务端下载，避免大文件 base64 传输开销。
 * 但图片需要转为 base64，因为 Railway 服务器（海外）无法访问大陆的即梦域名。
 */
export async function embedAudioDataUrlsForJianyingExport(
  shots: JianyingShot[],
  returnZip: boolean = false
): Promise<JianyingShot[]> {
  const out: JianyingShot[] = [];
  for (const s of shots) {
    let shot = { ...s };

    // 处理图片：Railway 环境也传 URL，让服务器下载
    // 注意：Railway 服务器在海外，可能无法访问某些大陆 CDN
    // 如果图片下载失败，服务器会使用占位符图片
    if (returnZip) {
      // Railway 环境：直接传 URL，由服务器下载
      // 不在浏览器端转换 base64，因为 base64 数据量太大（约增加 33%），
      // 会导致 Railway 内存不足而被 OOM Kill
      // 如果服务器无法下载图片，会自动使用占位符图片
      // 图片已经在前端是 blob: URL 或 https: URL，直接传递即可
    }

    // 处理音频
    const raw = (shot.audioUrl || shot.voiceoverAudioUrl)?.trim();
    if (!raw) { out.push(shot); continue; }
    if (raw.startsWith('data:')) { out.push(shot); continue; }
    if (!/^https?:\/\//i.test(raw)) {
      try {
        const r = await fetch(raw);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const mime = r.headers.get('content-type')?.split(';')[0]?.trim()
          || inferAudioMimeFromUrl(raw) || 'audio/mpeg';
        const data = await r.arrayBuffer();
        const dataUrl = `data:${mime};base64,${arrayBufferToBase64(data)}`;
        shot.audioUrl = dataUrl;
        shot.voiceoverAudioUrl = dataUrl;
        out.push(shot);
      } catch { out.push(shot); }
      continue;
    }
    // Railway 环境直接传 URL
    if (returnZip) { out.push(shot); continue; }
    // 本地环境转 base64
    try {
      let data: ArrayBuffer;
      let mime = '';
      try {
        const r = await fetch(raw);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        mime = r.headers.get('content-type')?.split(';')[0]?.trim() || '';
        data = await r.arrayBuffer();
      } catch {
        if (typeof window === 'undefined') throw new Error('fetch failed');
        const proxy = `/__image_proxy?url=${encodeURIComponent(raw)}`;
        const r2 = await fetch(proxy);
        if (!r2.ok) throw new Error(`proxy ${r2.status}`);
        mime = r2.headers.get('content-type')?.split(';')[0]?.trim() || '';
        data = await r2.arrayBuffer();
      }
      const ct = mime && mime !== 'application/octet-stream'
        ? mime : inferAudioMimeFromUrl(raw) || 'audio/mpeg';
      const dataUrl = `data:${ct};base64,${arrayBufferToBase64(data)}`;
      shot.audioUrl = dataUrl;
      shot.voiceoverAudioUrl = dataUrl;
      out.push(shot);
    } catch (e) {
      console.warn('[JianyingExport] 浏览器拉取配音失败，仍尝试服务端下载:', e);
      out.push(shot);
    }
  }
  return out;
}

/** Railway 同步导出：预热后 POST /export，等待完整结果返回（Railway 代理会自动等待） */
async function legacyJianyingExportSync(
  base: string,
  payload: Record<string, unknown>,
  options: JianyingExportOptions,
  timeoutMs: number = 600_000,
): Promise<JianyingExportResult> {
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

  const legacyText = await legacyRes.text().catch(() => '');
  const parsed = tryParseJsonObject(legacyText);
  if (parsed) return { ...parsed, usedRailway: base.includes('railway') } as JianyingExportResult;
  return { ...coerceExportResultFromText(legacyText, options, true), usedRailway: base.includes('railway') } as JianyingExportResult;
}

/** 批量导出剪映草稿 */
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

  // Railway 预热（免费版睡眠后唤醒需要 30-60 秒）
  if (isRailway && !isJianyingLocalSiteOrigin()) {
    console.log('[JianyingExport] 检测到 Railway，预热服务...');
    onProgress?.(2, 'Railway 服务唤醒中（首次约需 60 秒）...');
    await warmupJianyingService(90000);
    onProgress?.(5, '服务已唤醒，开始导出...');
  } else {
    onProgress?.(5, '准备导出...');
  }

  // Railway 用异步 /export/start 接口 + 轮询，实现实时进度显示
  if (isRailway && !isJianyingLocalSiteOrigin()) {
    onProgress?.(10, '提交导出任务到 Railway...');

    try {
      // 1. 提交异步任务
      const startRes = await fetch(`${railwayBase}/export/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, returnZip: true }),
        signal: AbortSignal.timeout(30000),
      });

      if (!startRes.ok) {
        // 如果异步接口不可用，降级到同步
        console.warn('[JianyingExport] Railway 异步接口不可用，降级到同步模式...');
        onProgress?.(10, 'Railway 异步接口不可用，降级到同步模式...');
        return legacyJianyingExportSync(railwayBase, { ...payload, returnZip: true }, options, 600_000);
      }

      const startText = await startRes.text().catch(() => '');
      const startObj = tryParseJsonObject(startText) as any;
      const taskId = startObj?.taskId;

      if (!taskId) {
        // 没有返回 taskId，降级到同步
        console.warn('[JianyingExport] Railway 异步任务 ID 无效，降级到同步模式...');
        onProgress?.(10, 'Railway 异步任务 ID 无效，降级到同步模式...');
        return legacyJianyingExportSync(railwayBase, { ...payload, returnZip: true }, options, 600_000);
      }

      console.log(`[JianyingExport] Railway 异步任务已提交，taskId: ${taskId}`);
      onProgress?.(10, 'Railway 任务已提交，等待处理...');

      // 2. 轮询获取任务结果（实时显示 Railway 日志）
      return await pollForResult(taskId, railwayBase, true, options, onProgress);
    } catch (e) {
      // 异步接口出错，降级到同步
      console.warn('[JianyingExport] Railway 异步请求失败，降级到同步模式...', e);
      onProgress?.(10, 'Railway 异步请求失败，降级到同步模式...');
      return legacyJianyingExportSync(railwayBase, { ...payload, returnZip: true }, options, 600_000);
    }
  }

  // 本地开发：尝试 /export/start 异步接口，失败则降级同步
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
        return legacyJianyingExportSync(railwayBase, { ...payload, returnZip: true }, options);
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
      return legacyJianyingExportSync(railwayBase, { ...payload, returnZip: true }, options);
    }
    throw new Error('服务连接失败，请检查本地剪映服务是否运行');
  }
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
  let lastLogIndex = 0; // 跟踪已显示的日志数量

  for (let i = 0; i < maxPoll; i++) {
    await sleep(2000);

    try {
      const statusRes = await fetch(`${pollBase}/export/status/${encodeURIComponent(taskId)}`);
      const statusText = await statusRes.text().catch(() => '');
      const statusObj = tryParseJsonObject(statusText) as any;
      const status = String(statusObj?.status || '').toLowerCase();

      // 显示新的日志（Railway 返回 logs 数组）
      if (statusObj?.logs && Array.isArray(statusObj.logs)) {
        const newLogs = statusObj.logs.slice(lastLogIndex);
        for (const log of newLogs) {
          if (log.message) {
            onProgress?.(log.progress || lastProgress, log.message);
          }
        }
        lastLogIndex = statusObj.logs.length;
      } else if (statusObj?.progress !== undefined && statusObj.progress > lastProgress) {
        // 非 Railway 模式：只显示进度变化
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
      if (i < maxPoll - 3) {
        console.warn(`[JianyingExport] 轮询出错 (${i + 1}/${maxPoll}):`, e);
        await sleep(3000);
        continue;
      }
      throw e;
    }
  }

  throw new Error('导出超时（10分钟），请重试');
}
