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
 */
export async function embedAudioDataUrlsForJianyingExport(shots: JianyingShot[]): Promise<JianyingShot[]> {
  const out: JianyingShot[] = [];
  for (const s of shots) {
    const raw = (s.audioUrl || s.voiceoverAudioUrl)?.trim();
    if (!raw) {
      out.push(s);
      continue;
    }
    if (raw.startsWith('data:')) {
      out.push(s);
      continue;
    }
    if (!/^https?:\/\//i.test(raw)) {
      out.push(s);
      continue;
    }
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

/** 仅同步 `POST .../export` 的旧版本机服务（如 `server/server.mjs`），无异步 `/export/start` */
async function legacyJianyingExportSync(
  base: string,
  payload: Record<string, unknown>,
  options: JianyingExportOptions
): Promise<JianyingExportResult> {
  const legacyRes = await fetch(`${base}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const legacyText = await legacyRes.text().catch(() => '');
  if (!legacyRes.ok) {
    const parsed = tryParseJsonObject(legacyText);
    const detail = parsed?.error || parsed?.message || legacyText.slice(0, 400);
    throw new Error(`导出请求失败 (${legacyRes.status})${detail ? ': ' + detail : ''}`);
  }
  const parsed = tryParseJsonObject(legacyText);
  if (parsed) return parsed;
  return coerceExportResultFromText(legacyText, options, true);
}

/** 批量导出剪映草稿（异步任务轮询，避免长连接超时） */
export async function exportJianyingDraft(
  options: JianyingExportOptions
): Promise<JianyingExportResult> {
  const shots = await embedAudioDataUrlsForJianyingExport(options.shots);
  if (typeof console !== 'undefined' && console.debug) {
    console.debug(
      '[JianyingExport] 镜头音频摘要',
      shots.map((s, i) => ({
        i,
        hasAudio: !!((s.audioUrl || s.voiceoverAudioUrl || '').trim()),
        audioDurationSec: s.audioDurationSec,
      }))
    );
  }

  const payload = {
    draftName: options.draftName,
    shots,
    resolution: options.resolution || '1920x1080',
    fps: options.fps || 30,
    outputPath: options.outputPath || null,
    pathMapRoot: options.pathMapRoot || null,
    randomTransitions: !!options.randomTransitions,
    randomVideoEffects: !!options.randomVideoEffects,
    returnZip: shouldUseJianyingZipDownload(),
  };

  const base = getJianyingApiBase();
  const startRes = await fetch(`${base}/export/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const startText = await startRes.text().catch(() => '');
  // 本仓库 `server/server.mjs` 仅实现同步 POST /api/jianying/export，无 /export/start → 404
  if (startRes.status === 404) {
    return legacyJianyingExportSync(base, payload, options);
  }
  if (!startRes.ok) {
    const parsed = tryParseJsonObject(startText);
    const detail = parsed?.error || parsed?.message || startText.slice(0, 400);
    throw new Error(`导出任务提交失败 (${startRes.status})${detail ? ': ' + detail : ''}`);
  }

  const startObj = tryParseJsonObject(startText) as any;
  const taskId = startObj?.taskId;
  if (!taskId) {
    // 兼容旧服务：若未返回 taskId，尝试同步接口
    return legacyJianyingExportSync(base, payload, options);
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const maxPoll = 240; // 最多约 8 分钟
  for (let i = 0; i < maxPoll; i++) {
    await sleep(2000);
    const statusRes = await fetch(`${base}/export/status/${encodeURIComponent(taskId)}`);
    const statusText = await statusRes.text().catch(() => '');
    const statusObj = tryParseJsonObject(statusText) as any;
    const status = String(statusObj?.status || '').toLowerCase();

    if (status === 'success') {
      const resultRes = await fetch(`${base}/export/result/${encodeURIComponent(taskId)}`);
      const resultText = await resultRes.text().catch(() => '');
      if (!resultRes.ok) {
        const parsed = tryParseJsonObject(resultText);
        const detail = parsed?.error || parsed?.message || resultText.slice(0, 400);
        throw new Error(`导出结果获取失败 (${resultRes.status})${detail ? ': ' + detail : ''}`);
      }
      const parsed = tryParseJsonObject(resultText);
      if (parsed) return parsed;
      return coerceExportResultFromText(resultText, options, true);
    }

    if (status === 'failed') {
      const detail = statusObj?.error || statusObj?.message || '导出任务失败';
      throw new Error(String(detail));
    }
  }

  throw new Error('导出任务超时（轮询超过 8 分钟）');
}
