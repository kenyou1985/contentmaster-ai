/**
 * 一键成片 — 项目历史（分镜 + 脚本 + 可持久化媒体 URL），按项目 ID 锚定
 * 底层存储：IndexedDB（storageService） + localStorage 兼容层
 */

import { lsGetItem, lsSetItem } from './storageService';
import { getCachedVideoUrl } from './videoCacheService';
import { resolveRunningHubOutputUrl } from './runninghubService';

const STORAGE_KEY = 'contentmaster_media_projects_v1';
const MAX_PROJECTS = 40;
const MAX_JSON_CHARS = 5_500_000;
/** 单条 data URL 上限；过小会导致 Gemini 等返回的大图整段被丢弃，历史/队列快照无缩略图 */
export const MEDIA_HISTORY_MAX_DATA_URL_CHARS = 720_000;
const MAX_DATA_URL_CHARS = MEDIA_HISTORY_MAX_DATA_URL_CHARS;

export interface MediaProjectRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  scriptText: string;
  shots: PersistedShot[];
  preview: string;
}

export interface PersistedShot {
  id: string;
  number: number;
  caption: string;
  imagePrompt: string;
  videoPrompt: string;
  shotType: string;
  voiceOver: string;
  soundEffect: string;
  imageUrls?: string[];
  videoUrl?: string;
  videoUrls?: string[];
  voiceoverAudioUrl?: string;
  /** TTS 音频时长（秒），导出剪映时用于音频下载失败的兜底时长 */
  audioDurationSec?: number;
  /** TTS 音频原始时长（秒，保留小数精度），优先用于剪映导出时长控制 */
  audioDurationExact?: number;
  selected?: boolean;
  selectedImageIndex?: number;
  selectedVideoIndex?: number;
}

function readAll(): MediaProjectRecord[] {
  const data = lsGetItem<MediaProjectRecord[]>(STORAGE_KEY, []);
  return Array.isArray(data) ? data : [];
}

function writeAll(list: MediaProjectRecord[]): void {
  try {
    lsSetItem(STORAGE_KEY, list);
  } catch (e) {
    console.warn('[MediaProjectHistory] 写入失败，尝试精简 data URL 后重试', e);
    const stripped = list.map((rec) => ({
      ...rec,
      shots: rec.shots.map((s) => ({
        ...s,
        imageUrls: s.imageUrls?.map((u) => (u.startsWith('data:') ? undefined : u)).filter(Boolean) as string[],
      })),
    }));
    try {
      lsSetItem(STORAGE_KEY, stripped);
    } catch (e2) {
      console.error('[MediaProjectHistory] 二次写入仍失败', e2);
    }
  }
}

/** 媒体历史 ID：YYYYMMDDHHmm-三位随机（例 202604070135-123），与已有 id 去重 */
function buildTimedMediaId(existing: Set<string>): string {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const prefix = `${y}${mo}${day}${hh}${mm}`;
  for (let k = 0; k < 100; k++) {
    const n = Math.floor(Math.random() * 1000);
    const id = `${prefix}-${String(n).padStart(3, '0')}`;
    if (!existing.has(id)) return id;
  }
  return `${prefix}-${String(Date.now() % 1000).padStart(3, '0')}`;
}

export function generateMediaProjectId(): string {
  const existing = new Set(readAll().map((r) => r.id));
  return buildTimedMediaId(existing);
}

export function generateMediaSnapshotId(): string {
  const existing = new Set(readAll().map((r) => r.id));
  return buildTimedMediaId(existing);
}

/** 分镜是否含有可持久化的生成媒体（图 / 配音 / 视频） */
export function shotsHaveGeneratedMedia(shots: Parameters<typeof shotToPersisted>[0][]): boolean {
  return shots.some((s) => {
    const ni = s.imageUrls?.length ?? 0;
    const nv = (s.videoUrls?.length ?? 0) + (s.videoUrl ? 1 : 0);
    const na = s.voiceoverAudioUrl ? 1 : 0;
    return ni > 0 || nv > 0 || na > 0;
  });
}

/** 用于去重：仅媒体数量指纹（内容变化但数量不变仍会合并为同一条，避免刷屏） */
export function mediaFingerprint(
  shots: { id: string; imageUrls?: string[]; videoUrl?: string; videoUrls?: string[]; voiceoverAudioUrl?: string }[]
): string {
  const clip = (u: string | undefined, n: number) => (u && typeof u === 'string' ? u.trim().slice(0, n) : '');
  return shots
    .map((s) => {
      const ni = s.imageUrls?.length ?? 0;
      const nv = (s.videoUrls?.length ?? 0) + (s.videoUrl ? 1 : 0);
      const na = s.voiceoverAudioUrl ? 1 : 0;
      const i0 = clip(s.imageUrls?.[0], 64);
      const v0 = clip(s.videoUrls?.[0] ?? s.videoUrl, 64);
      const a0 = clip(s.voiceoverAudioUrl, 64);
      return `${s.id}:${ni}:${nv}:${na}:${i0}:${v0}:${a0}`;
    })
    .join('|');
}

function filterPersistableUrl(u: string | undefined): string | undefined {
  if (!u || typeof u !== 'string') return undefined;
  let t = u.trim();
  if (!t) return undefined;
  // 与前端 normalizePersistedMediaUrl 一致：相对路径先拼成可下载的绝对 URL，否则会被误判为不可持久化而丢图/丢音
  if (!/^(https?:|data:|blob:)/i.test(t)) {
    const resolved = resolveRunningHubOutputUrl(t).trim();
    if (/^https?:\/\//i.test(resolved)) t = resolved;
  }
  if (t.startsWith('blob:')) return undefined;
  if (t.startsWith('data:')) {
    if (t.length > MAX_DATA_URL_CHARS) return undefined;
    return t;
  }
  if (t.startsWith('http://') || t.startsWith('https://')) return t;
  // 协议相对 URL
  if (t.startsWith('//')) {
    t = `https:${t}`;
    if (t.length > MAX_DATA_URL_CHARS) return undefined;
    return t;
  }
  // 本站路径（开发环境 __image_proxy、/api 等）
  if (t.startsWith('/api/') || t.startsWith('/__image_proxy')) return t;
  // RunningHub 等返回的站点相对路径（此前被丢弃会导致历史恢复后无图/无音）
  if (t.startsWith('api/')) return t;
  // OpenAI b64_json 等纯 base64 无前缀 — 此前写入镜头后历史快照无缩略图
  const compact = t.replace(/\s/g, '');
  if (/^[A-Za-z0-9+/=_-]+$/.test(compact) && compact.length >= 80) {
    const dataUrl = `data:image/png;base64,${compact}`;
    if (dataUrl.length > MAX_DATA_URL_CHARS) return undefined;
    return dataUrl;
  }
  return undefined;
}

export function shotToPersisted(s: {
  id: string;
  number: number;
  caption: string;
  imagePrompt: string;
  videoPrompt: string;
  shotType: string;
  voiceOver: string;
  soundEffect: string;
  imageUrls?: string[];
  videoUrl?: string;
  videoUrls?: string[];
  voiceoverAudioUrl?: string;
  audioDurationSec?: number;
  audioDurationExact?: number;
  selected?: boolean;
  selectedImageIndex?: number;
  selectedVideoIndex?: number;
}): PersistedShot {
  const imageUrls = s.imageUrls?.map((u) => filterPersistableUrl(u)).filter(Boolean) as string[];
  const videoUrls = s.videoUrls?.map((u) => filterPersistableUrl(u)).filter(Boolean) as string[];
  const videoUrl = filterPersistableUrl(s.videoUrl);
  return {
    id: s.id,
    number: s.number,
    caption: s.caption,
    imagePrompt: s.imagePrompt,
    videoPrompt: s.videoPrompt,
    shotType: s.shotType,
    voiceOver: s.voiceOver,
    soundEffect: s.soundEffect,
    imageUrls: imageUrls?.length ? imageUrls : undefined,
    videoUrl,
    videoUrls: videoUrls?.length ? videoUrls : undefined,
    voiceoverAudioUrl: filterPersistableUrl(s.voiceoverAudioUrl),
    audioDurationSec: s.audioDurationSec,
    audioDurationExact: s.audioDurationExact,
    selected: s.selected,
    selectedImageIndex: s.selectedImageIndex,
    selectedVideoIndex: s.selectedVideoIndex,
  };
}

/**
 * 媒体指纹：包含 shot ID + 各镜媒体数量。
 * shot ID 决定了「同一组分镜」的语义，因此同一脚本始终复用同一 record ID；
 * 后续增删媒体只改变数量，不影响 shot ID → 触发更新而非重复创建。
 */
export function buildMediaProjectFingerprint(shots: PersistedShot[]): string {
  return shots
    .map((s) => {
      const ni = s.imageUrls?.length ?? 0;
      const nv = (s.videoUrls?.length ?? 0) + (s.videoUrl ? 1 : 0);
      const na = s.voiceoverAudioUrl ? 1 : 0;
      return `${s.id}:${ni}:${nv}:${na}`;
    })
    .join('|');
}

/**
 * 根据媒体指纹查找已有记录。
 * 指纹相同 → 内容实质相同（镜头数量+各镜媒体数量一致），应复用同一 record ID 在原地更新。
 */
export function findMediaProjectByFingerprint(fingerprint: string, shots: PersistedShot[]): MediaProjectRecord | undefined {
  const all = readAll();
  for (const rec of all) {
    const recFp = buildMediaProjectFingerprint(rec.shots);
    if (recFp === fingerprint) return rec;
  }
  return undefined;
}

/** 返回稳定且唯一的媒体项目 ID（同一分镜指纹复用已有 ID） */
export function resolveMediaProjectId(shots: PersistedShot[], existingId?: string): { id: string; isUpdate: boolean; updatedAt: number } {
  const fp = buildMediaProjectFingerprint(shots);
  const existing = findMediaProjectByFingerprint(fp, shots);
  if (existing) {
    return { id: existing.id, isUpdate: true, updatedAt: Date.now() };
  }
  // 从全部列表去重生成新 ID
  const allIds = readAll().map((r) => r.id);
  const newId = generateMediaSnapshotIdFromList(allIds);
  return { id: newId, isUpdate: false, updatedAt: Date.now() };
}

function generateMediaSnapshotIdFromList(existing: string[]): string {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const prefix = `${y}${mo}${day}${hh}${mm}`;
  const set = new Set(existing);
  for (let k = 0; k < 100; k++) {
    const n = Math.floor(Math.random() * 1000);
    const id = `${prefix}-${String(n).padStart(3, '0')}`;
    if (!set.has(id)) return id;
  }
  return `${prefix}-${String(Date.now() % 1000).padStart(3, '0')}`;
}

/** 恢复镜头并尽量接上本地视频缓存（与 videoUrls 下标对齐） */
export function persistedShotToShot(s: PersistedShot): PersistedShot & {
  cachedVideoUrl?: string;
  cachedVideoUrls?: string[];
  imageGenerating?: boolean;
  videoGenerating?: boolean;
  voiceoverGenerating?: boolean;
  audioDurationSec?: number;
} {
  const imageUrls =
    s.imageUrls && s.imageUrls.length > 0 ? [...s.imageUrls] : [];
  const imageCount = imageUrls.length;
  // selectedImageIndex 未存/越界时：有图则默认第 0 张（与 UI 行为一致）
  let selImg = s.selectedImageIndex;
  if (selImg === undefined || selImg < 0 || selImg >= imageCount) selImg = imageCount > 0 ? 0 : undefined;

  const videoUrls =
    s.videoUrls && s.videoUrls.length > 0 ? [...s.videoUrls] : s.videoUrl ? [s.videoUrl] : [];
  const cachedVideoUrls =
    videoUrls.length > 0
      ? videoUrls.map((u) => {
          if (u.startsWith('http://') || u.startsWith('https://')) {
            return getCachedVideoUrl(u) || undefined;
          }
          return undefined;
        })
      : undefined;
  const hasBlob = cachedVideoUrls?.some(Boolean);
  const last = videoUrls.length - 1;
  let selV = s.selectedVideoIndex;
  if (selV !== undefined && (selV < 0 || selV > last)) selV = last >= 0 ? last : undefined;
  if (selV === undefined && last >= 0) selV = last;
  return {
    ...s,
    selectedImageIndex: selImg,
    selectedVideoIndex: selV,
    imageUrls: imageCount > 0 ? imageUrls : undefined,
    videoUrls: videoUrls.length > 0 ? videoUrls : undefined,
    videoUrl: last >= 0 ? videoUrls[last] : s.videoUrl,
    cachedVideoUrls: hasBlob ? cachedVideoUrls : undefined,
    cachedVideoUrl: hasBlob ? [...(cachedVideoUrls || [])].reverse().find(Boolean) : undefined,
    imageGenerating: false,
    videoGenerating: false,
    voiceoverGenerating: false,
  };
}

export function listMediaProjects(): MediaProjectRecord[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMediaProject(id: string): MediaProjectRecord | undefined {
  return readAll().find((r) => r.id === id.trim());
}

export function deleteMediaProject(id: string): void {
  const list = readAll().filter((r) => r.id !== id.trim());
  writeAll(list);
}

export function clearAllMediaProjects(): void {
  writeAll([]);
}

/**
 * 合并 resolve + save：自动判断是新记录还是更新已有记录。
 * 媒体指纹（shot ID + 各镜媒体数量）相同 → 复用同一 record ID 在原地更新，避免重复记录。
 * isUpdate=true 时保留 createdAt（不改变）。
 */
/** 超限精简时去掉 data: 大图；若某镜因此无图，则回退沿用该条旧记录里同 id 镜头的可展示 URL，避免历史列表缩略图被「写空」 */
function slimShotsStripLargeData(
  shots: PersistedShot[],
  fallbackPrevious?: PersistedShot[]
): PersistedShot[] {
  return shots.map((sh) => {
    const httpOnly = sh.imageUrls
      ?.map((u) => (u.startsWith('data:') ? undefined : u))
      .filter(Boolean) as string[] | undefined;
    let imageUrls = httpOnly?.length ? httpOnly : undefined;
    if (!imageUrls?.length && fallbackPrevious?.length) {
      const old = fallbackPrevious.find((o) => o.id === sh.id);
      if (old?.imageUrls?.length) {
        const fromOldHttp = old.imageUrls.filter((u) => u && !u.startsWith('data:'));
        if (fromOldHttp.length) imageUrls = fromOldHttp;
        else {
          const oneSmallData = old.imageUrls.find(
            (u) => u.startsWith('data:') && u.length <= MAX_DATA_URL_CHARS
          );
          if (oneSmallData) imageUrls = [oneSmallData];
        }
      }
    }
    return { ...sh, imageUrls };
  });
}

export function saveOrUpdateMediaProject(params: {
  scriptText: string;
  shots: Parameters<typeof shotToPersisted>[0][];
  /** 若存在则优先更新该条（同一编辑会话 / 从媒体历史载入后），避免仅因媒体数量从 0→1 指纹变化而新增一条空记录 */
  preferUpdateId?: string | null;
}): { id: string; isUpdate: boolean } {
  const persisted = params.shots.map(shotToPersisted);
  const all = readAll();
  const now = Date.now();

  let idx = -1;
  const pref = params.preferUpdateId?.trim();
  if (pref) {
    idx = all.findIndex((x) => x.id === pref);
  }
  if (idx < 0) {
    const fp = buildMediaProjectFingerprint(persisted);
    idx = all.findIndex((x) => buildMediaProjectFingerprint(x.shots) === fp);
  }

  const preview =
    persisted[0]?.caption?.trim().slice(0, 100) ||
    persisted[0]?.imagePrompt?.trim().slice(0, 80) ||
    '';

  const record: MediaProjectRecord = {
    id: idx >= 0 ? all[idx].id : generateMediaSnapshotId(),
    createdAt: idx >= 0 ? all[idx].createdAt : now,
    updatedAt: now,
    scriptText: params.scriptText,
    shots: persisted,
    preview,
  };

  let next: MediaProjectRecord[];
  if (idx >= 0) {
    next = [...all];
    next[idx] = record;
  } else {
    next = [record, ...all];
  }
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  if (next.length > MAX_PROJECTS) {
    next = next.slice(0, MAX_PROJECTS);
  }

  const prevShotsForSlim = idx >= 0 ? all[idx]?.shots : undefined;
  const json = JSON.stringify(next);
  if (json.length > MAX_JSON_CHARS) {
    const slim: MediaProjectRecord[] = next.map((r) => ({
      ...r,
      shots: slimShotsStripLargeData(r.shots, r.id === record.id ? prevShotsForSlim : undefined),
    }));
    writeAll(slim);
    return { id: record.id, isUpdate: idx >= 0 };
  }
  writeAll(next);
  return { id: record.id, isUpdate: idx >= 0 };
}

export function saveMediaProjectSnapshot(params: {
  id: string;
  scriptText: string;
  shots: Parameters<typeof shotToPersisted>[0][];
}): void {
  const list = readAll();
  const idx = list.findIndex((x) => x.id === params.id);
  const now = Date.now();
  const shots = params.shots.map(shotToPersisted);
  const preview =
    shots[0]?.caption?.trim().slice(0, 100) ||
    shots[0]?.imagePrompt?.trim().slice(0, 80) ||
    '';

  const record: MediaProjectRecord = {
    id: params.id,
    createdAt: idx >= 0 ? list[idx].createdAt : now,
    updatedAt: now,
    scriptText: params.scriptText,
    shots,
    preview,
  };

  let next: MediaProjectRecord[];
  if (idx >= 0) {
    next = [...list];
    next[idx] = record;
  } else {
    next = [record, ...list];
  }
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  if (next.length > MAX_PROJECTS) {
    next = next.slice(0, MAX_PROJECTS);
  }

  const prevShotsForSlim = idx >= 0 ? list[idx]?.shots : undefined;
  const json = JSON.stringify(next);
  if (json.length > MAX_JSON_CHARS) {
    const slim: MediaProjectRecord[] = next.map((r) => ({
      ...r,
      shots: slimShotsStripLargeData(r.shots, r.id === params.id ? prevShotsForSlim : undefined),
    }));
    writeAll(slim);
    return;
  }
  writeAll(next);
}
