/**
 * 剪映草稿导出服务（前端调用层）
 * 本地开发：Vite proxy `/api/jianying` → 本机 18091，Python 直接写入剪映草稿目录。
 * 线上（Vercel）：`VITE_JIANYING_API_BASE` 指向 Railway，Linux 侧生成 ZIP 供下载。
 *
 * 简化版：50 个镜头以下一次性导出，50+ 镜头分两批（每批最多 30 个），不合并 ZIP
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
 * 是否使用远程打包 ZIP 并展示下载链接（典型：Vercel ��署访问线上 API）。
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

  // 分批导出扩展字段（可选）
  _batched?: boolean;
  _batchCount?: number;
  _batchZipUrls?: string[];
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
    (/success|完成|已生成|draft|��稿|contentmaster/i.test(text) && !/error|失败|fail|exception/i.test(low)) ||
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
      console.warn('[JianyingExport] 浏览器拉取配音失败，仍尝试���务端下载:', e);
      out.push(shot);
    }
  }
  return out;
}

/**
 * 批量导出剪映草稿 - 简化版
 * 50 个镜头以下：一次性导出
 * 50+ 镜头：分两批导出，不合并 ZIP，直接返回两批的下载链接
 */
export async function exportJianyingDraft(
  options: JianyingExportOptions,
  onProgress?: (progress: number, message: string) => void
): Promise<JianyingExportResult> {
  const returnZip = shouldUseJianyingZipDownload();
  onProgress?.(5, '准备导出...');

  // 判断是否分批：Railway 模式且超过 50 个镜头（避免请求体过大）
  const BATCH_THRESHOLD_SHOTS = 50;
  if (returnZip && options.shots.length > BATCH_THRESHOLD_SHOTS) {
    console.log(`[JianyingExport] 镜头数 ${options.shots.length} > ${BATCH_THRESHOLD_SHOTS}，分批导出（每批最多12个镜头）`);
    return await exportJianyingDraftInMultipleBatches(options, onProgress);
  }

  // 单次导出（50 个镜头以下）
  onProgress?.(10, '转换媒体数据...');
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
  const isLocal = isJianyingLocalSiteOrigin();

  console.log('[JianyingExport] base:', base);
  console.log('[JianyingExport] railwayBase:', railwayBase);
  console.log('[JianyingExport] isLocal:', isLocal);

  // ── 优先：本地服务 ─────────────────────────────
  if (isLocal) {
    let localOk = false;
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 3000);
      const res = await fetch('/api/jianying/health', { signal: controller.signal });
      clearTimeout(tid);
      localOk = res.ok;
    } catch { /* 不可用 */ }

    if (localOk) {
      console.log('[JianyingExport] 本地服务可用，使用本地导出...');
      onProgress?.(15, '使用本地服务导出...');
      return await localExport(payload, base, options, onProgress);
    }
    console.log('[JianyingExport] 本地服务不可用，切换到 Railway...');
    onProgress?.(15, '本地服务不可用，切换到 Railway...');
  }

  // ── Railway 异步模式 ──────────────��───────────
  if (hasRailwayConfig) {
    console.log('[JianyingExport] 提交到 Railway（异步）...');
    onProgress?.(15, 'Railway 任务提交中...');
    const result = await railwayExportAsync(railwayBase, payload, options, onProgress);
    if (result._handled) return result._result as JianyingExportResult;
    // 异步失败，降级同步
    console.warn('[JianyingExport] Railway 异步失败，降级同步...');
    onProgress?.(20, 'Railway 异步失败，降级同步导出...');
  }

  // ── 本地同步兜底 ──────────────────────────────
  console.log('[JianyingExport] 使用本地同步导出...');
  onProgress?.(20, '本地同步导出中...');
  return await localExport(payload, base, options, onProgress);
}

// ── 本地导出（优先异步，降级同步）──────────────────────────────────
async function localExport(
  payload: Record<string, unknown>,
  base: string,
  options: JianyingExportOptions,
  onProgress?: (progress: number, message: string) => void,
): Promise<JianyingExportResult> {
  onProgress?.(10, '提交本地任务...');

  // 尝试本地异步接口
  try {
    const startRes = await fetch('/api/jianying/export/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000), // 2 分钟
    });

    const startText = await startRes.text().catch(() => '');

    if (startRes.ok) {
      const startObj = tryParseJsonObject(startText) as any;
      const taskId = startObj?.taskId;
      if (taskId) {
        console.log(`[JianyingExport] 本地任务已提交，taskId: ${taskId}`);
        onProgress?.(15, '任务提交成功，等待处理...');
        return await pollForResult(taskId, base, false, options, onProgress);
      }
    }

    // 异步失败，降级同步
    console.log('[JianyingExport] 本地异步不可用，降级同步...');
    onProgress?.(10, '本地服务降级到同步导出...');
  } catch (e: any) {
    console.warn('[JianyingExport] 本地异步失败:', e.message);
    onProgress?.(10, '本地服务降级到同步导出...');
  }

  // 同步兜底
  return await localExportSync(base, payload, options, 600_000);
}

async function localExportSync(
  base: string,
  payload: Record<string, unknown>,
  options: JianyingExportOptions,
  timeoutMs: number,
): Promise<JianyingExportResult> {
  try {
    const res = await fetch(`${base}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const parsed = tryParseJsonObject(text);
      const detail = parsed?.error || parsed?.message || text.slice(0, 400);
      throw new Error(`本地同步导出失败 (${res.status})${detail ? ': ' + detail : ''}`);
    }

    const parsed = tryParseJsonObject(text);
    if (parsed) return parsed as JianyingExportResult;
    return coerceExportResultFromText(text, options, true);
  } catch (e: any) {
    throw new Error(`本地同步导出失败: ${e.message}`);
  }
}

// ── Railway 异步导出（立即提交，不等待）───────────────────────────
async function railwayExportAsync(
  railwayBase: string,
  payload: Record<string, unknown>,
  options: JianyingExportOptions,
  onProgress?: (progress: number, message: string) => void,
): Promise<{ _handled: true; _result: JianyingExportResult } | { _handled: false }> {
  const MAX_RETRIES = 2;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      onProgress?.(attempt === 1 ? 5 : 5 + (attempt - 1) * 2, `Railway 导出尝试 ${attempt}/${MAX_RETRIES}...`);

      const startRes = await fetch(`${railwayBase}/export/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, returnZip: true }),
        signal: AbortSignal.timeout(120000), // 2 分钟，大数据上传需要更长时间
      });

      const responseText = await startRes.text().catch(() => '');
      const startObj = tryParseJsonObject(responseText) as any;

      if (!startRes.ok || !startObj?.taskId) {
        const errDetail = startObj?.error || startObj?.message || responseText.slice(0, 300);
        console.warn(`[JianyingExport] Railway 异步失败 (尝试 ${attempt}):`, errDetail);

        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 3000 * attempt));
          continue;
        }
        onProgress?.(10, `Railway 异步失败: ${errDetail}，降级同步...`);
        return { _handled: false };
      }

      const taskId = startObj.taskId;
      console.log(`[JianyingExport] Railway 任务已提交，taskId: ${taskId}`);
      onProgress?.(15, 'Railway 任务提交成功，等待处理...');

      const result = await pollForResult(taskId, railwayBase, true, options, onProgress);
      return { _handled: true, _result: result };

    } catch (e: any) {
      console.warn(`[JianyingExport] Railway 异步异常 (尝试 ${attempt}):`, e.message);

      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 3000 * attempt));
        continue;
      }

      return { _handled: false };
    }
  }

  return { _handled: false };
}

// ── Railway 同步导出（降级用）────────────────────────────────
async function railwayExportSync(
  railwayBase: string,
  payload: Record<string, unknown>,
  options: JianyingExportOptions,
  timeoutMs: number,
): Promise<JianyingExportResult> {
  onProgress?.(20, 'Railway 同步导出中...');
  const res = await fetch(`${railwayBase}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, returnZip: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const parsed = tryParseJsonObject(text);
    const detail = parsed?.error || parsed?.message || text.slice(0, 400);
    throw new Error(`Railway 同步导出失败 (${res.status})${detail ? ': ' + detail : ''}`);
  }

  const parsed = tryParseJsonObject(text);
  if (parsed) return { ...parsed, usedRailway: true } as JianyingExportResult;
  return { ...coerceExportResultFromText(text, options, true), usedRailway: true } as JianyingExportResult;
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
  let lastLogIndex = 0;

  for (let i = 0; i < maxPoll; i++) {
    await sleep(2000);

    // Railway 代理 60 秒无活动会断连，每 30 秒发送一次心跳
    if (i > 0 && i % 15 === 0) {
      try {
        await fetch(`${pollBase}/health`, {
          signal: AbortSignal.timeout(5000),
        });
      } catch { /* 心跳失败不影响主流程 */ }
    }

    try {
      // Railway 代理约 30-60 秒强制断连，超时设 25 秒让它在断连前完成
      const statusRes = await fetch(`${pollBase}/export/status/${encodeURIComponent(taskId)}`, {
        signal: AbortSignal.timeout(25000),
      });

      if (!statusRes.ok) {
        const errText = await statusRes.text().catch(() => '');
        console.warn(`[JianyingExport] 轮询出错 (${i + 1}/${maxPoll}): HTTP ${statusRes.status}`);

        if (i < maxPoll - 3) {
          await sleep(3000);
          continue;
        }
        throw new Error(`轮询失败: HTTP ${statusRes.status}`);
      }

      const statusText = await statusRes.text().catch(() => '');
      const statusObj = tryParseJsonObject(statusText) as any;
      const status = String(statusObj?.status || '').toLowerCase();

      // 显示新的日志
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
        lastProgress = statusObj.progress;
        onProgress?.(statusObj.progress, statusObj.message || '处理中...');
      }

      if (statusObj?.message && statusObj?.progress !== undefined) {
        lastProgress = statusObj.progress;
        onProgress?.(statusObj.progress, statusObj.message);
      }

      if (status === 'success') {
        const resultRes = await fetch(`${pollBase}/export/result/${encodeURIComponent(taskId)}`, {
          signal: AbortSignal.timeout(60000), // 1 分钟超时
        });
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

// ============================================================
// 简化分批导出（仅 >50 镜头时使用）
// ============================================================

/**
 * 分多批导出（大批量镜头场景）
 * 按每批最多 12 个镜头拆分，避免请求体超过 Railway 100MB 限制
 */
async function exportJianyingDraftInMultipleBatches(
  options: JianyingExportOptions,
  onProgress?: (progress: number, message: string) => void
): Promise<JianyingExportResult> {
  const totalShots = options.shots.length;
  const BATCH_SIZE = 12; // 每批最多 12 个镜头
  const batchCount = Math.ceil(totalShots / BATCH_SIZE);
  const batches: JianyingShot[][] = [];

  for (let i = 0; i < totalShots; i += BATCH_SIZE) {
    batches.push(options.shots.slice(i, i + BATCH_SIZE));
  }

  const railwayBase = (import.meta.env.VITE_JIANYING_API_BASE || '').replace(/\/$/, '');
  if (!railwayBase.includes('railway')) {
    throw new Error('分批导出仅支持 Railway 模式');
  }

  const batchResults: JianyingExportResult[] = [];
  const batchZipUrls: string[] = [];

  // 依次导出每批
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const progressStart = 5 + (i / batchCount) * 90;
    const progressEnd = 5 + ((i + 1) / batchCount) * 90;

    onProgress?.(Math.round(progressStart), `分批导出: 第 ${i + 1}/${batchCount} 批 (${batch.length} 个镜头)...`);

    const batchResult = await submitAndWait(
      railwayBase,
      `${options.draftName}_part${i + 1}`,
      batch,
      options,
      progressStart,
      progressEnd,
      onProgress
    );

    if (!batchResult.success) {
      throw new Error(`第 ${i + 1} 批导出失败: ${batchResult.error || batchResult.message}`);
    }

    batchResults.push(batchResult);

    // 构建 ZIP 下载 URL
    const zipUrl = buildZipDownloadUrl(batchResult, railwayBase);
    if (zipUrl) {
      batchZipUrls.push(zipUrl);
      // 触发下载
      triggerDownload(zipUrl, `${options.draftName}_part${i + 1}.zip`);
    }
  }

  onProgress?.(100, '分批导出完成！已触发所有 ZIP 下载');

  return {
    success: true,
    platform: 'jianying',
    draft_name: options.draftName,
    shots_count: totalShots,
    resolution: options.resolution || '1920x1080',
    fps: options.fps || 30,
    message: `分批导出完成：共 ${totalShots} 个镜头，分为 ${batchCount} 批独立 ZIP（已触发下载）`,
    usedRailway: true,
    _batched: true,
    _batchCount: batchCount,
    _batchZipUrls: batchZipUrls,
  };
}

/**
 * 提交单个批次并轮询等待完成
 * @param progressStart 进度起始（0-100）
 * @param progressEnd 进度结束（0-100）
 */
async function submitAndWait(
  railwayBase: string,
  draftName: string,
  shots: JianyingShot[],
  options: JianyingExportOptions,
  progressStart: number,
  progressEnd: number,
  onProgress?: (progress: number, message: string) => void
): Promise<JianyingExportResult> {
  const shotsProcessed = await embedAudioDataUrlsForJianyingExport(shots, true);

  const payload = {
    draftName,
    shots: shotsProcessed,
    resolution: options.resolution || '1920x1080',
    fps: options.fps || 30,
    returnZip: true,
  };

  // 提交任务（44 个镜头 base64 数据较大，需要更长上传时间）
  const startRes = await fetch(`${railwayBase}/export/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000), // 2 分钟，避免上传超时
  });

  const startText = await startRes.text().catch(() => '');
  const startObj = tryParseJsonObject(startText) as any;

  if (!startRes.ok || !startObj?.taskId) {
    const errDetail = startObj?.error || startObj?.message || startText.slice(0, 300);
    throw new Error(`任务提交失败: ${errDetail}`);
  }

  const taskId = startObj.taskId;
  console.log(`[JianyingExport] 批次任务已提交，taskId: ${taskId}`);

  // 轮询结果（映射进度区间）
  const result = await pollForResult(taskId, railwayBase, true, options, (p, m) => {
    const scaled = Math.round(progressStart + (p / 100) * (progressEnd - progressStart));
    onProgress?.(scaled, m);
  });

  if (!result.success) {
    throw new Error(result.error || result.message);
  }

  return result;
}

/**
 * 构建 ZIP 下载 URL
 */
function buildZipDownloadUrl(result: JianyingExportResult, railwayBase: string): string | null {
  const rawUrl = result.zip_download_url;
  if (!rawUrl) return null;

  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;

  const baseOrigin = new URL(railwayBase).origin;
  return rawUrl.startsWith('/') ? `${baseOrigin}${rawUrl}` : `${baseOrigin}/${rawUrl}`;
}

/**
 * 触发浏览器下载
 */
function triggerDownload(url: string, filename: string) {
  setTimeout(() => {
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
    } catch (e) {
      console.warn('[JianyingExport] 自动下载失败，请手动下载:', e);
    }
  }, 100);
}
