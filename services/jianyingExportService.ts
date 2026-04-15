/**
 * 剪映草稿导出服务（前端调用层）
 * 本地开发：Vite proxy `/api/jianying` → 本机 18091，Python 直接写入剪映草稿目录。
 * 线上（Vercel）：`VITE_JIANYING_API_BASE` 指向 Railway，Linux 侧生成 ZIP 供下载。
 *
 * 优化：支持大批量导出（50+ 镜头），自动分批处理 + 合并 ZIP
 */

import JSZip from 'jszip';

// ============================================================
// 配置常量
// ============================================================

/** 单个批次最大请求体大小（MB）- 低于 Express 500MB 限制，留有安全余量 */
const BATCH_MAX_PAYLOAD_SIZE_MB = 300;

/** 预估每个镜头的平均大小（MB）- 用于批量决策 */
const AVG_SHOT_SIZE_MB = {
  withImage: 3,    // 有图片的镜头
  withAudio: 1.5,  // 有音频的镜头
  withVideo: 15,   // 有视频的镜头
};

/** 每批最大镜头数（保守估计，避免超限） */
const MAX_SHOTS_PER_BATCH = 20;

/**
 * 预估 shots 的总大小（MB）
 * 注意：base64 编码后数据会膨胀约 33%
 */
function estimatePayloadSizeMB(shots: JianyingShot[]): number {
  let totalMB = 0;
  for (const shot of shots) {
    let shotMB = 0;
    // 图片（假设 1-3 张，平均 2 张，每张约 1.5MB 原始大小 → base64 后 2MB）
    if (shot.imageUrl || (shot as any).imageUrls) {
      const imgCount = Math.max(1, ((shot as any).imageUrls?.length || 0) || (shot.imageUrl ? 1 : 0));
      shotMB += imgCount * AVG_SHOT_SIZE_MB.withImage;
    }
    // 音频（假设平均 1MB 原始大小 → base64 后 1.3MB）
    if (shot.audioUrl || shot.voiceoverAudioUrl) {
      shotMB += AVG_SHOT_SIZE_MB.withAudio;
    }
    // 视频（如果有的话，base64 后更大）
    if (shot.videoUrl || (shot as any).videoUrls) {
      shotMB += AVG_SHOT_SIZE_MB.withVideo;
    }
    // 其他元数据（少量）
    shotMB += 0.1;
    totalMB += shotMB;
  }
  // base64 编码膨胀系数（约 4/3 = 1.33）
  return totalMB * 1.33;
}

/**
 * 将 shots 数组分割成多个批次
 */
function splitShotsIntoBatches(shots: JianyingShot[], batchSize?: number): JianyingShot[][] {
  const size = batchSize || MAX_SHOTS_PER_BATCH;
  if (shots.length <= size) return [shots];
  const batches: JianyingShot[][] = [];
  for (let i = 0; i < shots.length; i += size) {
    batches.push(shots.slice(i, i + size));
  }
  return batches;
}

/**
 * 在浏览器端合并多个 ZIP 文件
 * 使用 JSZip 将多个 ZIP 包合并成一个大 ZIP
 */
async function mergeZipFiles(
  zipUrls: string[],
  onProgress?: (progress: number, message: string) => void
): Promise<Blob> {
  const zip = new JSZip();
  onProgress?.(0, '准备合并 ZIP 文件...');

  for (let i = 0; i < zipUrls.length; i++) {
    onProgress?.(
      Math.round(((i + 0.5) / zipUrls.length) * 80),
      `正在处理 ZIP ${i + 1}/${zipUrls.length}...`
    );

    try {
      const response = await fetch(zipUrls[i]);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();

      // 解压当前 ZIP
      const currentZip = await JSZip.loadAsync(arrayBuffer);

      // 将所有文件合并到主 ZIP
      const fileCount = Object.keys(currentZip.files).length;
      let processedFiles = 0;

      for (const [path, file] of Object.entries(currentZip.files)) {
        if (file.dir) {
          // 目录，检查是否已存在
          if (!zip.folder(path)) {
            zip.folder(path);
          }
        } else {
          // 文件，直接添加到 ZIP（相同路径会覆盖）
          zip.file(path, await file.async('uint8array'), { compression: 'DEFLATE' });
        }
        processedFiles++;

        // 定期报告进度
        if (processedFiles % 10 === 0 || processedFiles === fileCount) {
          const overallProgress = 80 + Math.round(((i + processedFiles / fileCount) / zipUrls.length) * 20);
          onProgress?.(overallProgress, `合并 ZIP ${i + 1}/${zipUrls.length}: ${processedFiles}/${fileCount} 个文件`);
        }
      }
    } catch (e) {
      console.error(`[JianyingExport] ZIP 合并失败 (${i + 1}/${zipUrls.length}):`, e);
      throw new Error(`ZIP ${i + 1} 合并失败: ${e}`);
    }
  }

  onProgress?.(95, '生成最终 ZIP...');
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

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

  // 分批导出扩展字段（可选）
  _batched?: boolean;
  _batchCount?: number;
  _completedBatches?: number;
  _batchZipUrls?: string[];
  _mergedBlob?: Blob;
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
 * 检查磁盘空间并清理缓存（Railway 环境）
 * 返回: { ok: boolean, freeMB: number, message: string }
 */
export async function checkDiskSpace(railwayBase: string): Promise<{ ok: boolean; freeMB: number; message: string }> {
  try {
    const res = await fetch(`${railwayBase}/disk-space`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      ok: data.free_mb > 100, // 至少保留 100MB
      freeMB: data.free_mb || 0,
      message: data.message || `剩余空间: ${data.free_mb}MB`,
    };
  } catch (e: any) {
    return { ok: true, freeMB: -1, message: `无法检查空间: ${e.message}` };
  }
}

/**
 * 清理 Railway 缓存（旧草稿、临时文件）
 * 返回清理结果
 */
export async function cleanupCache(railwayBase: string): Promise<{ success: boolean; freedMB: number; message: string }> {
  try {
    const res = await fetch(`${railwayBase}/cleanup`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    return {
      success: res.ok,
      freedMB: data.freed_mb || 0,
      message: data.message || (res.ok ? '清理完成' : `清理失败 (${res.status})`),
    };
  } catch (e: any) {
    return { success: false, freedMB: 0, message: `清理异常: ${e.message}` };
  }
}

/**
 * 预热 Railway 服务（解决免费版睡眠唤醒延迟问题）
 * Railway 免费版 15 分钟无请求后会睡眠，唤醒需要 30-60 秒
 *
 * ⚠️ 注意：对于异步接口 /export/start 不需要预热，因为它是立即返回 taskId 的。
 * 预热只用于同步接口 /export（需要等待完整处理）。
 */
export async function warmupJianyingService(railwayBase: string, timeoutMs: number = 90000): Promise<boolean> {
  const startTime = Date.now();
  const maxWait = timeoutMs;

  console.log(`[JianyingExport] 开始预热 Railway 服务: ${railwayBase}`);

  while (Date.now() - startTime < maxWait) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`${railwayBase}/health`, {
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

/**
 * 批量导出剪映草稿 - 智能分批处理
 * 自动检测请求体大小，超过阈值时自动分批次处理并合并
 */
export async function exportJianyingDraft(
  options: JianyingExportOptions,
  onProgress?: (progress: number, message: string) => void
): Promise<JianyingExportResult> {
  const returnZip = shouldUseJianyingZipDownload();

  // 估算 payload 大小
  const estimatedSizeMB = estimatePayloadSizeMB(options.shots);
  console.log(`[JianyingExport] 预估数据大小: ${estimatedSizeMB.toFixed(1)}MB (镜头数: ${options.shots.length})`);

  // 如果使用 Railway ZIP 模式且大小超过阈值，启用分批导出
  const BATCH_THRESHOLD_MB = 200; // 超过 200MB 启用分批
  if (returnZip && estimatedSizeMB > BATCH_THRESHOLD_MB) {
    console.log(`[JianyingExport] 检测到大体积导出 (${estimatedSizeMB.toFixed(1)}MB > ${BATCH_THRESHOLD_MB}MB)，启用分批处理...`);
    return await exportJianyingDraftInBatches(options, onProgress);
  }

  // 否则使用原来的单次导出逻辑
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

  console.log('[JianyingExport] base:', base);
  console.log('[JianyingExport] railwayBase:', railwayBase);
  console.log('[JianyingExport] hasRailwayConfig:', hasRailwayConfig);
  console.log('[JianyingExport] isLocal:', isLocal);

  // ── 优先：本地服务（本地开发 + 服务可用）────────────────────────
  if (isLocal) {
    let localOk = false;
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 3000);
      const res = await fetch('/api/jianying/health', { signal: controller.signal });
      clearTimeout(tid);
      localOk = res.ok;
    } catch {
      /* 不可用 */
    }

    if (localOk) {
      console.log('[JianyingExport] 本地服务可用，使用本地导出...');
      onProgress?.(5, '使用本地服务导出...');
      return await localExport(payload, base, options, onProgress);
    } else {
      console.log('[JianyingExport] 本地服务不可用，切换到 Railway...');
      onProgress?.(5, '本地服务不可用，切换到 Railway...');
    }
  }

  // ── 回退：Railway 异步接口（立即提交，不预热）─────────────────
  if (hasRailwayConfig) {
    console.log('[JianyingExport] 提交导出任务到 Railway（异步模式）...');
    onProgress?.(5, 'Railway 异步任务提交中...');
    const result = await railwayExportAsync(railwayBase, payload, options, onProgress);
    if (result._handled) return result._result as JianyingExportResult;

    // 异步失败，降级到同步
    console.warn('[JianyingExport] Railway 异步失败，降级到同步模式...');
    onProgress?.(10, 'Railway 异步失败，降级到同步导出...');
    return await railwayExportSync(railwayBase, payload, options, 900_000);
  }

  // ── 无 Railway：本地同步兜底 ────────────────────────────────
  console.log('[JianyingExport] 无 Railway 配置，使用本地同步模式...');
  onProgress?.(5, '准备本地同步导出...');
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
      signal: AbortSignal.timeout(10000),
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

    // 异步失败（404/非 200/无 taskId），降级同步
    console.log('[JianyingExport] 本地异步不可用，降级到同步模式...');
    onProgress?.(10, '本地服务降级到同步导出...');
  } catch (e: any) {
    console.warn('[JianyingExport] 本地异步请求失败:', e.message);
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

// ── Railway 异步导出（核心：立即提交，不预热）─────────────────────
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
        signal: AbortSignal.timeout(30000),
      });

      const responseText = await startRes.text().catch(() => '');
      const startObj = tryParseJsonObject(responseText) as any;

      if (!startRes.ok || !startObj?.taskId) {
        const errDetail = startObj?.error || startObj?.message || responseText.slice(0, 300);
        console.warn(`[JianyingExport] Railway 异步失败 (尝试 ${attempt}):`, errDetail);

        if (attempt < MAX_RETRIES) {
          // 等待后重试
          await new Promise(r => setTimeout(r, 3000 * attempt));
          continue;
        }
        onProgress?.(10, `Railway 异步失败: ${errDetail}，降级同步...`);
        return { _handled: false };
      }

      const taskId = startObj.taskId;
      console.log(`[JianyingExport] Railway 任务已提交，taskId: ${taskId} (尝试 ${attempt})`);
      onProgress?.(15, 'Railway 任务提交成功，等待处理...');

      const result = await pollForResult(taskId, railwayBase, true, options, onProgress);
      return { _handled: true, _result: result };

    } catch (e: any) {
      console.warn(`[JianyingExport] Railway 异步异常 (尝试 ${attempt}):`, e.message);

      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 3000 * attempt));
        continue;
      }

      // 最后一次失败，检查是否是空间问题
      const errMsg = e.message.toLowerCase();
      if (errMsg.includes('space') || errMsg.includes('disk') || errMsg.includes('quota') || errMsg.includes('no space')) {
        onProgress?.(5, '检测到空间不足，尝试清理缓存...');
        try {
          const cleanup = await cleanupCache(railwayBase);
          if (cleanup.success && cleanup.freedMB > 0) {
            onProgress?.(8, `清理完成，释放 ${cleanup.freedMB}MB，重新尝试...`);
            // 清理后最后一次重试（不计数，作为额外机会）
            try {
              const retryRes = await fetch(`${railwayBase}/export/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, returnZip: true }),
                signal: AbortSignal.timeout(30000),
              });
              const retryText = await retryRes.text().catch(() => '');
              const retryObj = tryParseJsonObject(retryText) as any;

              if (retryRes.ok && retryObj?.taskId) {
                const result = await pollForResult(retryObj.taskId, railwayBase, true, options, onProgress);
                return { _handled: true, _result: { ...result, message: `${result.message}\n[空间清理后重试成功]` } };
              }
            } catch (retryErr) {
              console.warn('[JianyingExport] 清理后重试失败:', retryErr);
            }
          }
        } catch (cleanupErr) {
          console.warn('[JianyingExport] 清理缓存失败:', cleanupErr);
        }
      }

      return { _handled: false };
    }
  }

  return { _handled: false };
}

// ── Railway 同步导出（降级用，需要预热）──────────────────────────
async function railwayExportSync(
  railwayBase: string,
  payload: Record<string, unknown>,
  options: JianyingExportOptions,
  timeoutMs: number,
): Promise<JianyingExportResult> {
  // 同步接口需要预热（Railway 睡眠后唤醒需要时间）
  onProgress?.(5, 'Railway 同步预热中（首次约需 60 秒）...');
  await warmupJianyingService(railwayBase, 90000);

  onProgress?.(20, 'Railway 预热完成，开始同步导出...');
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

// ============================================================
// 分批导出 + ZIP 合并（解决 50+ 镜头大文件导出问题）
// ============================================================

/**
 * 分批导出剪映草稿并合并 ZIP
 *
 * 工作原理：
 * 1. 将镜头分成多个批次（每批 ≤ 20 个镜头）
 * 2. 依次提交每个批次到 Railway 导出
 * 3. 下载每个批次的 ZIP 文件
 * 4. 在浏览器端合并所有 ZIP
 * 5. 提供合并后的大 ZIP 下载
 */
async function exportJianyingDraftInBatches(
  options: JianyingExportOptions,
  onProgress?: (progress: number, message: string) => void
): Promise<JianyingExportResult> {
  const batches = splitShotsIntoBatches(options.shots);
  const totalBatches = batches.length;

  console.log(`[JianyingExport] 分批导出: ${totalBatches} 批次, 共 ${options.shots.length} 个镜头`);

  if (totalBatches === 1) {
    // 只有一批，直接导出
    return exportJianyingDraft(options, onProgress);
  }

  onProgress?.(0, `准备分批导出: ${totalBatches} 批次，共 ${options.shots.length} 个镜头...`);

  const railwayBase = (import.meta.env.VITE_JIANYING_API_BASE || '').replace(/\/$/, '');
  if (!railwayBase.includes('railway')) {
    throw new Error('分批导出仅支持 Railway 模式');
  }

  // 收集所有批次的 ZIP URL
  const batchZipUrls: string[] = [];
  const batchResults: JianyingExportResult[] = [];
  let totalShots = 0;

  // 依次导出每个批次
  for (let i = 0; i < totalBatches; i++) {
    const batchShots = batches[i];
    const batchNum = i + 1;

    // 计算当前批次的大致进度（0-60% 用于导出阶段）
    const batchStartProgress = Math.round((i / totalBatches) * 60);

    onProgress?.(
      batchStartProgress,
      `正在导出批次 ${batchNum}/${totalBatches}: ${batchShots.length} 个镜头...`
    );

    try {
      // 导出当前批次
      const batchPayload = {
        draftName: `${options.draftName}_batch${batchNum}`,
        shots: batchShots,
        resolution: options.resolution || '1920x1080',
        fps: options.fps || 30,
        outputPath: null,
        pathMapRoot: options.pathMapRoot || null,
        randomTransitions: !!options.randomTransitions,
        randomVideoEffects: !!options.randomVideoEffects,
        returnZip: true,
      };

      // 提交批次导出任务
      const startRes = await fetch(`${railwayBase}/export/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchPayload),
        signal: AbortSignal.timeout(30000),
      });

      const startText = await startRes.text().catch(() => '');
      const startObj = tryParseJsonObject(startText) as any;

      if (!startRes.ok || !startObj?.taskId) {
        const errDetail = startObj?.error || startObj?.message || startText.slice(0, 300);
        throw new Error(`批次 ${batchNum} 任务提交失败: ${errDetail}`);
      }

      const taskId = startObj.taskId;
      console.log(`[JianyingExport] 批次 ${batchNum} 任务已提交, taskId: ${taskId}`);

      // 轮询获取结果
      const result = await pollForResult(taskId, railwayBase, true, { ...options, shots: batchShots }, (p, m) => {
        // 将轮询进度映射到批次进度区间
        const scaledProgress = batchStartProgress + Math.round((p / 100) * (60 / totalBatches));
        onProgress?.(scaledProgress, `批次 ${batchNum}/${totalBatches}: ${m}`);
      });

      if (!result.success) {
        throw new Error(`批次 ${batchNum} 导出失败: ${result.error || result.message}`);
      }

      batchResults.push(result);
      totalShots += batchShots.length;

      // 获取 ZIP 下载 URL
      const zipUrl = buildZipDownloadUrl(result, railwayBase);
      if (zipUrl) {
        batchZipUrls.push(zipUrl);
      }

      console.log(`[JianyingExport] 批次 ${batchNum} 导出成功，ZIP: ${zipUrl}`);

      // 更新进度
      const batchEndProgress = Math.round(((i + 1) / totalBatches) * 60);
      onProgress?.(batchEndProgress, `批次 ${batchNum}/${totalBatches} 完成 (${batchZipUrls.length}/${batchBatches})...`);

    } catch (e: any) {
      console.error(`[JianyingExport] 批次 ${batchNum} 导出失败:`, e);
      throw new Error(`批次 ${batchNum} 导出失败: ${e.message}`);
    }
  }

  // 下载并合并所有 ZIP
  onProgress?.(65, `正在下载并合并 ${batchZipUrls.length} 个 ZIP 文件...`);

  try {
    // 构建完整的 ZIP 下载 URL 列表
    const fullZipUrls = batchZipUrls.map((url, idx) => {
      if (/^https?:\/\//i.test(url)) return url;
      const baseOrigin = new URL(railwayBase).origin;
      return url.startsWith('/') ? `${baseOrigin}${url}` : `${baseOrigin}/${url}`;
    });

    // 合并 ZIP 文件
    const mergedZipBlob = await mergeZipFiles(fullZipUrls, (p, m) => {
      // 映射到 70-95% 区间
      const scaledProgress = 70 + Math.round((p / 100) * 25);
      onProgress?.(scaledProgress, m);
    });

    // 生成下载链接
    onProgress?.(95, '生成最终下载链接...');

    const mergedFileName = `${options.draftName}_merged_${Date.now()}.zip`;
    const mergedZipUrl = URL.createObjectURL(mergedZipBlob);

    // 创建下载链接
    const downloadLink = document.createElement('a');
    downloadLink.href = mergedZipUrl;
    downloadLink.download = mergedFileName;

    // 触发下载（异步，不阻塞）
    // 注意：前端需要监听这个事件并显示下载链接给用户
    console.log(`[JianyingExport] 合并完成，文件: ${mergedFileName} (${(mergedZipBlob.size / 1024 / 1024).toFixed(2)}MB)`);

    onProgress?.(100, '分批导出完成！');

    return {
      success: true,
      platform: 'jianying',
      draft_name: options.draftName,
      shots_count: totalShots,
      resolution: options.resolution || '1920x1080',
      fps: options.fps || 30,
      message: `分批导出完成: ${totalBatches} 批次, ${totalShots} 个镜头。ZIP 已合并。`,
      // 返回合并后的下载信息
      zip_path: mergedFileName,
      zip_download_url: mergedZipUrl,
      zip_size_mb: mergedZipBlob.size / 1024 / 1024,
      usedRailway: true,
      // 额外信息
      _batched: true,
      _batchCount: totalBatches,
      _mergedBlob: mergedZipBlob, // 保留引用，防止被 GC
    };

  } catch (e: any) {
    console.error('[JianyingExport] ZIP 合并失败:', e);
    // 即使合并失败，也返回已完成的批次结果
    const firstResult = batchResults[0];
    return {
      success: false,
      platform: 'jianying',
      draft_name: options.draftName,
      shots_count: totalShots,
      resolution: options.resolution || '1920x1080',
      fps: options.fps || 30,
      message: `ZIP 合并失败，但已完成 ${batchResults.length}/${totalBatches} 批次`,
      error: `ZIP 合并失败: ${e.message}`,
      usedRailway: true,
      _batched: true,
      _batchCount: totalBatches,
      _completedBatches: batchResults.length,
      _batchZipUrls: batchZipUrls, // 保留单独的下载链接供用户使用
    };
  }
}

/**
 * 构建 ZIP 下载 URL
 */
function buildZipDownloadUrl(result: JianyingExportResult, railwayBase: string): string | null {
  const rawUrl = result.zip_download_url;
  if (!rawUrl) return null;

  // 如果是完整 URL，直接返回
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;

  // 否则拼接基础地址
  const baseOrigin = new URL(railwayBase).origin;
  return rawUrl.startsWith('/') ? `${baseOrigin}${rawUrl}` : `${baseOrigin}/${rawUrl}`;
}
