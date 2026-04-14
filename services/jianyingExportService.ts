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

    // 处理图片：Railway 环境转 base64（服务器无法访问大陆的即梦域名）
    // 需要处理 blob: 和 https: 两种 URL 格式
    if (returnZip) {
      const rawImage = shot.imageUrl?.trim() || (shot as any).imageUrls?.[0]?.trim();
      if (rawImage && !rawImage.startsWith('data:')) {
        try {
          let dataUrl = rawImage;
          // blob: URL 或 https: URL 都需要 fetch 并转换为 base64
          if (rawImage.startsWith('blob:') || rawImage.startsWith('https:')) {
            const r = await fetch(rawImage);
            if (r.ok) {
              const mime = r.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
              const data = await r.arrayBuffer();
              dataUrl = `data:${mime};base64,${arrayBufferToBase64(data)}`;
              // 释放 ArrayBuffer 内存
            }
          }
          shot.imageUrl = dataUrl;
          if ((shot as any).imageUrls) {
            (shot as any).imageUrls = [dataUrl];
          }
        } catch (e) {
          console.warn('[JianyingExport] 图片转 base64 失败，将使用原 URL:', e);
        }
      }
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
  timeoutMs: number = 900_000, // 增加超时到 15 分钟
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
  const hasRailwayConfig = railwayBase.includes('railway') && railwayBase.length > 0;
  const isRailway = hasRailwayConfig && base === railwayBase;
  const isLocal = isJianyingLocalSiteOrigin();

  // 调试信息
  console.log('[JianyingExport] base:', base);
  console.log('[JianyingExport] railwayBase:', railwayBase);
  console.log('[JianyingExport] hasRailwayConfig:', hasRailwayConfig);
  console.log('[JianyingExport] isRailway:', isRailway);
  console.log('[JianyingExport] isLocal:', isLocal);

  // 检测本地服务是否可用
  let localServiceAvailable = false;
  if (isLocal) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await fetch('/api/jianying/health', { signal: controller.signal });
      clearTimeout(timeoutId);
      localServiceAvailable = res.ok;
      console.log('[JianyingExport] 本地服务状态:', localServiceAvailable ? '可用' : '不可用');
    } catch {
      console.log('[JianyingExport] 本地服务状态: 不可用');
    }
  }

  // 决策：优先使用本地服务（如果可用），否则使用 Railway
  const useLocal = isLocal && localServiceAvailable;

  // Railway 预热（免费版睡眠后唤醒需要 30-60 秒）
  if (hasRailwayConfig && !useLocal) {
    console.log('[JianyingExport] 检测到 Railway，预热服务...');
    onProgress?.(2, 'Railway 服务唤醒中（首次约需 60 秒）...');
    await warmupJianyingService(90000);
    onProgress?.(5, '服务已唤醒，开始导出...');
  } else if (hasRailwayConfig && useLocal) {
    console.log('[JianyingExport] 本地服务可用，使用本地导出...');
    onProgress?.(5, '使用本地服务导出...');
  } else {
    onProgress?.(5, '准备导出...');
  }

  // Railway 用异步 /export/start 接口 + 轮询，实现实时进度显示
  if (hasRailwayConfig && !useLocal) {
    onProgress?.(10, '提交导出任务到 Railway（异步模式）...');
    const asyncEndpoint = `${railwayBase}/export/start`;
    console.log('[JianyingExport] 异步接口地址:', asyncEndpoint);

    try {
      // 1. 提交异步任务（railwayBase 已包含 /api/jianying）
      const startRes = await fetch(asyncEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, returnZip: true }),
        signal: AbortSignal.timeout(30000),
      });

      console.log('[JianyingExport] 异步接口响应状态:', startRes.status, startRes.statusText);

      // 修复：即使状态码不是 200/201，也要尝试解析响应体获取错误信息
      const responseText = await startRes.text().catch(() => '');
      const startObj = tryParseJsonObject(responseText) as any;

      if (!startRes.ok) {
        // 从响应中提取错误信息
        const errorDetail = startObj?.error || startObj?.message || responseText.slice(0, 400) || `HTTP ${startRes.status}`;
        console.warn('[JianyingExport] Railway 异步接口不可用，降级到同步模式... 响应:', errorDetail.slice(0, 200));
        onProgress?.(10, `Railway 异步接口不可用 (${startRes.status})，降级到同步模式...`);
        return legacyJianyingExportSync(railwayBase, { ...payload, returnZip: true }, options, 900_000);
      }

      const taskId = startObj?.taskId;
      console.log('[JianyingExport] 异步提交响应:', startObj);

      if (!taskId) {
        // 没有返回 taskId，降级到同步
        console.warn('[JianyingExport] Railway 异步任务 ID 无效，降级到同步模式...');
        onProgress?.(10, 'Railway 异步任务 ID 无效，降级到同步模式...');
        return legacyJianyingExportSync(railwayBase, { ...payload, returnZip: true }, options, 900_000);
      }

      console.log(`[JianyingExport] Railway 异步任务已提交，taskId: ${taskId}`);
      onProgress?.(10, 'Railway 任务已提交，等待处理...');

      // 2. 轮询获取任务结果（实时显示 Railway 日志）
      return await pollForResult(taskId, railwayBase, true, options, onProgress);
    } catch (e: any) {
      // 异步接口出错，降级到同步
      console.error('[JianyingExport] Railway 异步请求失败，错误:', e.message);
      // 修复：确保错误信息不为空
      const errorMsg = e.message || '网络请求失败';
      onProgress?.(10, `Railway 异步请求失败: ${errorMsg}，降级到同步模式...`);
      return legacyJianyingExportSync(railwayBase, { ...payload, returnZip: true }, options, 900_000);
    }
  }

  // 本地服务可用：使用本地接口
  if (useLocal) {
    console.log('[JianyingExport] 使用本地服务导出...');
    onProgress?.(5, '使用本地服务导出...');
    try {
      // 尝试本地异步接口
      const startRes = await fetch('/api/jianying/export/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      const startText = await startRes.text().catch(() => '');
      
      // 修复：处理各种错误状态码
      if (!startRes.ok) {
        const parsed = tryParseJsonObject(startText);
        const errMsg = parsed?.error || parsed?.message || startText.slice(0, 400) || `HTTP ${startRes.status}`;
        // 404 或其他客户端错误，降级到同步
        if (startRes.status === 404 || startRes.status === 400) {
          console.log('[JianyingExport] 本地服务不支持异步，降级到同步模式...');
          return legacyJianyingExportSync(base, payload, options);
        }
        throw new Error(errMsg);
      }

      const startObj = tryParseJsonObject(startText) as any;
      const taskId = startObj?.taskId;
      if (!taskId) {
        console.log('[JianyingExport] 本地异步接口未返回 taskId，降级到同步模式...');
        return legacyJianyingExportSync(base, payload, options);
      }

      console.log(`[JianyingExport] 本地任务已提交，taskId: ${taskId}`);
      onProgress?.(10, '本地任务已提交，等待处理...');
      return await pollForResult(taskId, base, false, options, onProgress);
    } catch (e: any) {
      console.error('[JianyingExport] 本地服务出错:', e.message);
      // 修复：确保错误信息不为空，并调用 onProgress 更新状态
      const errorMsg = e.message || '服务连接失败';
      onProgress?.(5, `本地服务出错: ${errorMsg}`);
      
      // 降级到 Railway
      if (hasRailwayConfig) {
        onProgress?.(10, '降级到 Railway 服务...');
        return legacyJianyingExportSync(railwayBase, { ...payload, returnZip: true }, options, 900_000);
      }
      throw e;
    }
  }

  // 无 Railway 配置：使用本地同步接口
  if (!hasRailwayConfig) {
    console.log('[JianyingExport] 无 Railway 配置，使用本地同步模式...');
    onProgress?.(5, '准备本地同步导出...');
    try {
      const startRes = await fetch(`${base}/export/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      const startText = await startRes.text().catch(() => '');
      
      if (!startRes.ok) {
        // 尝试同步接口
        const syncRes = await fetch(`${base}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(600000), // 10分钟超时
        });
        
        if (!syncRes.ok) {
          const errText = await syncRes.text().catch(() => '');
          const parsed = tryParseJsonObject(errText);
          throw new Error(parsed?.error || parsed?.message || errText.slice(0, 400) || `HTTP ${syncRes.status}`);
        }
        
        const syncText = await syncRes.text().catch(() => '');
        const parsed = tryParseJsonObject(syncText);
        if (parsed) return parsed as JianyingExportResult;
        return coerceExportResultFromText(syncText, options, true);
      }

      const startObj = tryParseJsonObject(startText) as any;
      const taskId = startObj?.taskId;
      if (!taskId) {
        return legacyJianyingExportSync(base, payload, options);
      }

      onProgress?.(10, '任务已提交，等待处理...');
      return await pollForResult(taskId, base, false, options, onProgress);
    } catch (e: any) {
      const errorMsg = e.message || '服务连接失败';
      onProgress?.(5, `错误: ${errorMsg}`);
      throw new Error(errorMsg);
    }
  }

  // 理论上不会走到这里
  throw new Error('未知的导出配置');
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

  // pollBase 已包含完整路径（如 railwayBase = xxx/api/jianying），直接拼接
  for (let i = 0; i < maxPoll; i++) {
    await sleep(2000);

    try {
      const statusRes = await fetch(`${pollBase}/export/status/${encodeURIComponent(taskId)}`);
      
      // 修复：处理非 200 响应
      if (!statusRes.ok) {
        const errText = await statusRes.text().catch(() => '');
        console.warn(`[JianyingExport] 轮询出错 (${i + 1}/${maxPoll}): HTTP ${statusRes.status}`);
        
        if (i < maxPoll - 3) {
          // 继续尝试
          await sleep(3000);
          continue;
        }
        throw new Error(`轮询失败: HTTP ${statusRes.status}`);
      }
      
      const statusText = await statusRes.text().catch(() => '');
      const statusObj = tryParseJsonObject(statusText) as any;
      const status = String(statusObj?.status || '').toLowerCase();

      // 显示新的日志（Railway 返回 logs 数组）
      if (statusObj?.logs && Array.isArray(statusObj.logs)) {
        const newLogs = statusObj.logs.slice(lastLogIndex);
        for (const log of newLogs) {
          if (log.message) {
            lastProgress = log.progress || lastProgress;
            onProgress?.(lastProgress, log.message);
          }
        }
        lastLogIndex = statusObj.logs.length;
      } else if (statusObj?.progress !== undefined && statusObj.progress > lastProgress) {
        // 非 Railway 模式：显示进度变化
        lastProgress = statusObj.progress;
        onProgress?.(statusObj.progress, statusObj.message || '处理中...');
      }

      // 如果后端返回了新的日志消息，也要显示
      if (statusObj?.message && statusObj?.progress !== undefined) {
        lastProgress = statusObj.progress;
        onProgress?.(statusObj.progress, statusObj.message);
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
      // 最后几次轮询失败，抛出错误
      throw e;
    }
  }

  throw new Error('导出超时（10分钟），请重试');
}
