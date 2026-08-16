/**
 * Remotion 视频合成导出服务（前端调用层）
 *
 * 路由策略（与 jianyingExportService 保持一致）：
 * - 本地访问（localhost / 局域网）→ /api/remotion（同源代理到 18093）
 * - 线上 Vercel 部署 → VITE_REMITION_API_BASE 指向 Railway
 * - 上传大文件 data URL 时自动提取到 server temp dir
 *
 * 输出策略：
 * - target: 'browser' → 写入 IndexedDB（videoCacheService），返回 Blob URL
 * - target: 'download' → 直接触发浏览器下载
 * - target: 'oss' / 'cos' → 上传云存储，返回签名 URL
 */

import {
  RemotionExportOptions,
  RemotionExportConfig,
  RemotionRenderResult,
  RemotionProgressInfo,
} from './remotionRenderTypes';
import { cacheVideo } from './videoCacheService';

const V8_MAX_SAFE_STRING = 480 * 1024 * 1024; // 与剪映一致

function isLocalSiteOrigin(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(h)) return true;
  return false;
}

export function getRemotionApiBase(): string {
  if (import.meta.env.VITE_REMITION_FORCE_LOCAL === 'true') {
    return '/api/remotion';
  }
  if (typeof window !== 'undefined' && isLocalSiteOrigin()) {
    return '/api/remotion';
  }
  return (import.meta.env.VITE_REMITION_API_BASE || '/api/remotion').replace(/\/$/, '');
}

/**
 * 拼接 Remotion 后端 URL。
 *
 * 修复历史：
 * - v1: 直接拼 base + path，download 输出 /api/remotion/download/... 导致双前缀
 * - v2: 剥掉 outputUrl 里的 /api/remotion 前缀后再拼 base
 *
 * 当前逻辑（v2）：
 * - Railway: base = https://<app>.up.railway.app，outputUrl = /download/123.mp4
 *            → 直接拼 base + /download/123.mp4
 * - 本地 proxy: base = /api/remotion，outputUrl = /download/123.mp4
 *            → 拼出 /api/remotion/download/123.mp4，Vite proxy strip 后正确转发
 */
export function buildRemotionUrl(outputUrl: string): string {
  if (!outputUrl) return '';
  if (/^https?:\/\//i.test(outputUrl)) return outputUrl;
  const base = getRemotionApiBase().replace(/\/$/, '');
  let path = outputUrl.startsWith('/') ? outputUrl : `/${outputUrl}`;
  // 剥掉第一个 /api/remotion 前缀（worker 输出的绝对路径已经包含这个前缀）
  if (path === '/api/remotion') path = '/';
  else if (path.startsWith('/api/remotion/')) path = path.slice('/api/remotion'.length);
  return `${base}${path}`;
}

/**
 * 健康检查
 */
export async function checkRemotionHealth(): Promise<any> {
  const base = getRemotionApiBase();
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`服务不可用 (${res.status})`);
  return res.json();
}

// ── Data URL → Temp File 转换（防止 V8 字符串溢出）────────────────────
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

interface MediaExtractItem {
  mime: string;
  data: string;
}

async function uploadInlineDataUrlsToServer(
  payload: Record<string, unknown>,
  apiBase: string,
): Promise<Record<string, unknown>> {
  const shots = Array.isArray(payload.shots) ? (payload.shots as any[]) : [];
  if (shots.length === 0) return payload;

  const dataUrlToIdx = new Map<string, number>();
  const items: MediaExtractItem[] = [];

  const collect = (val: any) => {
    if (typeof val !== 'string') return;
    if (!val.startsWith('data:')) return;
    if (dataUrlToIdx.has(val)) return;
    const headerEnd = val.indexOf(',');
    if (headerEnd < 0) return;
    const header = val.slice(0, headerEnd);
    const m = /^data:([^;]+)(?:;base64)?$/i.exec(header);
    if (!m) return;
    const mime = m[1].trim().toLowerCase();
    const b64 = val.slice(headerEnd + 1);
    dataUrlToIdx.set(val, items.length);
    items.push({ mime, data: b64 });
  };

  for (const shot of shots) {
    collect(shot?.imageUrl);
    if (Array.isArray(shot?.imageUrls)) {
      for (const u of shot.imageUrls) collect(u);
    }
    collect(shot?.audioUrl);
    collect(shot?.voiceoverAudioUrl);
    collect(shot?.videoUrl);
  }

  if (items.length === 0) return payload;

  const res = await fetch(`${apiBase}/upload-media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`upload-media 失败 (${res.status}): ${txt.slice(0, 300)}`);
  }
  const result = await res.json();
  if (!result?.success || !Array.isArray(result.paths)) {
    throw new Error(`upload-media 响应异常: ${JSON.stringify(result).slice(0, 300)}`);
  }
  const paths: string[] = result.paths;
  if (paths.length !== items.length) {
    throw new Error(`路径数不匹配: ${paths.length} vs ${items.length}`);
  }

  const replace = (val: any): any => {
    if (typeof val !== 'string') return val;
    if (!val.startsWith('data:')) return val;
    const idx = dataUrlToIdx.get(val);
    if (idx === undefined) return val;
    return paths[idx];
  };

  const newShots = shots.map((shot) => {
    if (!shot || typeof shot !== 'object') return shot;
    const out: any = { ...shot };
    out.imageUrl = replace(shot.imageUrl);
    if (Array.isArray(shot.imageUrls)) {
      out.imageUrls = shot.imageUrls.map((u: any) => replace(u));
    }
    out.audioUrl = replace(shot.audioUrl);
    out.voiceoverAudioUrl = replace(shot.voiceoverAudioUrl);
    out.videoUrl = replace(shot.videoUrl);
    return out;
  });

  return { ...payload, shots: newShots };
}

async function ensurePayloadSerializable(
  payload: Record<string, unknown>,
  apiBase: string,
  onProgress?: (p: number, m: string) => void,
): Promise<Record<string, unknown>> {
  let size = 0;
  try {
    size = JSON.stringify(payload).length;
  } catch (e: any) {
    console.warn('[RemotionExport] payload 初次序列化失败', e?.message);
  }
  if (size <= V8_MAX_SAFE_STRING) return payload;
  console.warn(`[RemotionExport] payload 过大 (${(size / 1024 / 1024).toFixed(1)}MB)，提取 data URL`);
  onProgress?.(8, 'Payload 过大，提取内嵌媒体到本地临时文件...');
  return await uploadInlineDataUrlsToServer(payload, apiBase);
}

// ── 媒体预处理：blob: → data URL（仅当需要）────────────────────
async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('FileReader 失败'));
    reader.readAsDataURL(blob);
  });
}

async function fetchBlobAsDataUrl(url: string, fallbackMime: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const mime = r.headers.get('content-type')?.split(';')[0]?.trim() || fallbackMime;
    const blob = await r.blob();
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}

/**
 * 媒体预处理：把 blob: URL 转换为 data URL（仅本地 + 镜头数少时启用，避免大视频 base64 膨胀）
 */
async function prepareShotsForRender(shots: RemotionExportOptions['shots']): Promise<RemotionExportOptions['shots']> {
  const out: RemotionExportOptions['shots'] = [];
  for (const s of shots) {
    const shot = { ...s };
    // 图片
    if (shot.imageUrl?.startsWith('blob:')) {
      const data = await fetchBlobAsDataUrl(shot.imageUrl, 'image/png');
      if (data) shot.imageUrl = data;
    }
    if (Array.isArray(shot.imageUrls)) {
      const newUrls: string[] = [];
      for (const u of shot.imageUrls) {
        if (u.startsWith('blob:')) {
          const data = await fetchBlobAsDataUrl(u, 'image/png');
          newUrls.push(data || u);
        } else {
          newUrls.push(u);
        }
      }
      shot.imageUrls = newUrls;
    }
    // 音频
    if (shot.audioUrl?.startsWith('blob:')) {
      const data = await fetchBlobAsDataUrl(shot.audioUrl, 'audio/mpeg');
      if (data) shot.audioUrl = data;
    }
    if (shot.voiceoverAudioUrl?.startsWith('blob:')) {
      const data = await fetchBlobAsDataUrl(shot.voiceoverAudioUrl, 'audio/mpeg');
      if (data) shot.voiceoverAudioUrl = data;
    }
    // 视频：blob 不转（太大），保留原 URL；服务器会下载
    out.push(shot);
  }
  return out;
}

// ── 主渲染入口 ─────────────────────
export interface RenderRemotionOptions extends RemotionExportOptions {
  config: RemotionExportConfig;
}

export async function renderRemotionVideo(
  options: RenderRemotionOptions,
  onProgress?: (progress: number, message: string) => void,
): Promise<RemotionRenderResult> {
  const apiBase = getRemotionApiBase();
  onProgress?.(5, '准备渲染...');

  // 媒体预处理
  onProgress?.(8, '预处理媒体文件...');
  const preparedShots = await prepareShotsForRender(options.shots);

  const payload = {
    draftName: options.draftName,
    shots: preparedShots,
    config: options.config,
    localMediaPaths: options.localMediaPaths || null,
  };

  // 大文件提取
  const safePayload = await ensurePayloadSerializable(payload, apiBase, onProgress);

  // 提交任务
  onProgress?.(15, '提交渲染任务...');
  // M2 #12：根据预估时长自动选择普通 / 长视频分批 渲染
  const totalDuration = (options.shots || []).reduce(
    (s: number, x: any) => s + (x?.audioDurationExact ?? x?.audioDurationSec ?? x?.duration ?? 4),
    0
  );
  const useLongBatch = totalDuration > 1800; // >30 分钟走分批
  const renderStartUrl = useLongBatch ? `${apiBase}/render/long` : `${apiBase}/render/start`;
  onProgress?.(
    16,
    useLongBatch ? `长视频：${(totalDuration / 60).toFixed(1)} 分钟，将分批渲染` : '提交渲染任务...'
  );
  const startRes = await fetch(renderStartUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(safePayload),
    signal: AbortSignal.timeout(300_000),
  });
  if (!startRes.ok) {
    const txt = await startRes.text().catch(() => '');
    throw new Error(`提交失败 (${startRes.status}): ${txt.slice(0, 300)}`);
  }
  const startObj = await startRes.json();
  if (!startObj?.success || !startObj.taskId) {
    throw new Error(`提交响应异常: ${JSON.stringify(startObj).slice(0, 300)}`);
  }
  const taskId = startObj.taskId;
  if (startObj.mode === 'batch') {
    console.log(`[RemotionExport] 长视频分批: ${startObj.segmentCount} 段（childTaskIds: ${startObj.childTaskIds?.join(',')}）`);
    onProgress?.(
      20,
      `📦 长视频检测（共 ${(totalDuration / 60).toFixed(1)} 分钟），将分 ${startObj.segmentCount} 段渲染`
    );
  }
  onProgress?.(20, '任务已提交，等待渲染...');

  // M2 #13：SSE 实时帧进度订阅（优先；若 SSE 失败则回退到轮询）
  let sseUnsubscribe: (() => void) | null = null;
  try {
    sseUnsubscribe = subscribeRemotionProgress(taskId, (info) => {
      if (info.frame !== undefined && info.totalFrames !== undefined) {
        // 帧级进度消息，比轮询更细
        const eta = info.etaSec !== undefined ? ` · 剩余 ${formatEta(info.etaSec)}` : '';
        onProgress?.(
          info.progress ?? lastProgress,
          `渲染中: 帧 ${info.frame}/${info.totalFrames}${eta}`
        );
      } else if (info.message) {
        onProgress?.(info.progress ?? lastProgress, info.message);
      }
    });
  } catch (e) {
    console.warn('[RemotionExport] SSE 订阅失败，回退到轮询:', e);
  }

  let lastProgress = 0; // hoisted

  // 轮询结果（兜底，兼容 SSE 不可用场景）
  try {
    const result = await pollForRemotionResult(taskId, apiBase, options.config, onProgress);
    return result;
  } finally {
    sseUnsubscribe?.();
  }
}

// ── 轮询 ─────────────────────
async function pollForRemotionResult(
  taskId: string,
  apiBase: string,
  config: RemotionExportConfig,
  onProgress?: (p: number, m: string) => void,
): Promise<RemotionRenderResult> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const MAX_POLL = 600; // 20 分钟（长视频）
  const POLL_INTERVAL = 3000;

  let lastProgress = 0;
  let lastSignature = ''; // v1.7：用于 (progress, message) dedup，避免日志重复
  for (let i = 0; i < MAX_POLL; i++) {
    await sleep(POLL_INTERVAL);

    // 心跳：每 30s 一次
    if (i > 0 && i % 10 === 0) {
      try {
        await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(5000) });
      } catch {
        /* ignore */
      }
    }

    try {
      const statusRes = await fetch(`${apiBase}/render/status/${encodeURIComponent(taskId)}`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!statusRes.ok) {
        if (i < MAX_POLL - 3) {
          await sleep(3000);
          continue;
        }
        throw new Error(`轮询失败: HTTP ${statusRes.status}`);
      }
      const status = await statusRes.json();
      // 去重：同一 progress + message 在轮询里只触发一次 onProgress，避免日志无限重复
      const incomingMessage = status.message || '渲染中...';
      const sig = `${status.progress ?? lastProgress}|${incomingMessage}`;
      if (sig === lastSignature) {
        // 同状态跳过；保持心跳（不调 onProgress）
      } else if (status.progress !== undefined && status.progress > lastProgress) {
        lastProgress = status.progress;
        lastSignature = sig;
        onProgress?.(status.progress, incomingMessage);
      } else if (status.message) {
        lastSignature = sig;
        onProgress?.(lastProgress, incomingMessage);
      }

      if (status.status === 'success') {
        const resultRes = await fetch(`${apiBase}/render/result/${encodeURIComponent(taskId)}`, {
          signal: AbortSignal.timeout(120_000),
        });
        if (!resultRes.ok) {
          const txt = await resultRes.text().catch(() => '');
          throw new Error(`获取结果失败 (${resultRes.status}): ${txt.slice(0, 300)}`);
        }
        const result = await resultRes.json();
        return {
          success: true,
          taskId,
          durationSec: result.durationSec || 0,
          videoDurationSec: result.durationSec || 0,
          videoSizeBytes: result.videoSizeBytes || 0,
          resolution: result.resolution || '',
          fps: result.fps || 0,
          outputUrl: result.outputUrl || '',
          outputTarget: config.output?.target || 'browser',
          format: 'mp4',
          message: '渲染完成',
        };
      }

      if (status.status === 'failed') {
        throw new Error(status.error || status.message || '渲染失败');
      }
    } catch (e: any) {
      if (i < MAX_POLL - 3) {
        console.warn(`[RemotionExport] 轮询出错 (${i + 1}/${MAX_POLL}):`, e.message);
        await sleep(3000);
        continue;
      }
      throw e;
    }
  }
  throw new Error('渲染超时（20分钟），请重试');
}

// ── 下载/缓存产出 MP4 ─────────────────────
export async function downloadOrCacheRenderedVideo(
  result: RemotionRenderResult,
  options: {
    draftName: string;
    target: 'browser' | 'download' | 'oss' | 'cos';
    onCached?: (blobUrl: string) => void;
    onDownloaded?: () => void;
  },
): Promise<{ blobUrl?: string; downloaded: boolean }> {
  if (!result.success || !result.outputUrl) {
    throw new Error('渲染结果无效');
  }

  const apiBase = getRemotionApiBase();
  const url = buildRemotionUrl(result.outputUrl);

  // 拉取 MP4
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`下载 MP4 失败 (${res.status})`);
  const blob = await res.blob();

  const filename = `${options.draftName}.mp4`;

  // 浏览器缓存：将 MP4 写入 IndexedDB（使用 videoCacheService.cacheVideo）
  if (options.target === 'browser') {
    const id = `remotion_${result.taskId}`;
    const blobUrl = URL.createObjectURL(blob);
    // 通过虚拟 URL 缓存（实际返回 blob URL，由 IndexedDB 元数据管理）
    try {
      // 把 blob URL 直接交给 cacheVideo（它会 fetch + 自动管理）
      const cacheKey = `remotion://${result.taskId}`;
      // 直接保存 blob 到 videoCacheService 的元数据
      const meta = {
        url: cacheKey,
        blobUrl,
        cachedAt: Date.now(),
        size: blob.size,
        filename: options.draftName + '.mp4',
        pageBootId: (window as any).__CM_PAGE_BOOT_ID__ || `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      };
      localStorage.setItem(`VIDEO_CACHE_${btoa(cacheKey).replace(/[+/=]/g, '')}`, JSON.stringify(meta));
    } catch (e) {
      console.warn('[RemotionExport] 写入缓存元数据失败:', e);
    }
    options.onCached?.(blobUrl);
    return { blobUrl, downloaded: false };
  }

  // 直接下载
  if (options.target === 'download') {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    options.onDownloaded?.();
    return { blobUrl, downloaded: true };
  }

  // 云存储：todo M4
  return { blobUrl: URL.createObjectURL(blob), downloaded: false };
}

// ── SSE 实时进度（M2 #13：按帧推送）────────────────────
export function subscribeRemotionProgress(
  taskId: string,
  onUpdate: (info: RemotionProgressInfo) => void,
): () => void {
  const apiBase = getRemotionApiBase();
  const url = `${apiBase}/render/sse/${encodeURIComponent(taskId)}`;
  let es: EventSource | null = null;
  let closed = false;
  try {
    es = new EventSource(url);
  } catch (e) {
    console.warn('[RemotionExport] EventSource 创建失败:', e);
    return () => undefined;
  }
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      onUpdate({
        progress: data.progress ?? 0,
        message: data.message ?? '',
        frame: data.frame,
        totalFrames: data.totalFrames,
        fps: data.fps,
        etaSec: data.etaSec,
      });
      // 终态时自动关闭（避免长连接占用）
      if (data.status === 'success' || data.status === 'failed') {
        closed = true;
        es?.close();
      }
    } catch {
      /* ignore */
    }
  };
  es.onerror = () => {
    if (!closed) {
      // 浏览器会自动重连，这里仅记录
      console.debug('[RemotionExport] SSE 临时连接异常，浏览器将自动重连');
    }
  };
  return () => {
    closed = true;
    try {
      es?.close();
    } catch {
      /* ignore */
    }
  };
}

/**
 * 把秒数格式化为 ETA 字符串（"剩余 2 分 30 秒"）
 */
function formatEta(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const s = Math.round(sec);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m} 分 ${rest} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}
