/**
 * 一键成片 — 项目历史（分镜 + 脚本 + 可持久化媒体 URL），按项目 ID 锚定
 */

import { getCachedVideoUrl } from './videoCacheService';

const STORAGE_KEY = 'contentmaster_media_projects_v1';
const MAX_PROJECTS = 40;
const MAX_JSON_CHARS = 4_200_000;
const MAX_DATA_URL_CHARS = 180_000;

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
  selected?: boolean;
  selectedImageIndex?: number;
  selectedVideoIndex?: number;
}

function readAll(): MediaProjectRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeAll(list: MediaProjectRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    console.warn('[MediaProjectHistory] 写入失败（可能超出配额），尝试精简 data URL 后重试', e);
    const stripped = list.map((rec) => ({
      ...rec,
      shots: rec.shots.map((s) => ({
        ...s,
        imageUrls: s.imageUrls?.map((u) => (u.startsWith('data:') ? undefined : u)).filter(Boolean) as string[],
      })),
    }));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stripped));
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
  const t = u.trim();
  if (!t) return undefined;
  if (t.startsWith('blob:')) return undefined;
  if (t.startsWith('data:')) {
    if (t.length > MAX_DATA_URL_CHARS) return undefined;
    return t;
  }
  if (t.startsWith('http://') || t.startsWith('https://')) return t;
  // RunningHub 等返回的站点相对路径（此前被丢弃会导致历史恢复后无图/无音）
  if (t.startsWith('api/')) return t;
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
    selected: s.selected,
    selectedImageIndex: s.selectedImageIndex,
    selectedVideoIndex: s.selectedVideoIndex,
  };
}

/** 恢复镜头并尽量接上本地视频缓存（与 videoUrls 下标对齐） */
export function persistedShotToShot(s: PersistedShot): PersistedShot & {
  cachedVideoUrl?: string;
  cachedVideoUrls?: string[];
  imageGenerating?: boolean;
  videoGenerating?: boolean;
  voiceoverGenerating?: boolean;
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

  const json = JSON.stringify(next);
  if (json.length > MAX_JSON_CHARS) {
    const slim: MediaProjectRecord[] = next.map((r) => ({
      ...r,
      shots: r.shots.map((sh) => ({
        ...sh,
        imageUrls: sh.imageUrls?.map((u) => (u.startsWith('data:') ? undefined : u)).filter(Boolean) as string[],
      })),
    }));
    writeAll(slim);
    return;
  }
  writeAll(next);
}
