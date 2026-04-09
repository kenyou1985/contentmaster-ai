import React, { useState, useRef, useEffect, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { ApiProvider, ToolMode, NicheType } from '../types';
import {
  generateImage,
  ImageGenerationOptions,
  openAiImageDataItemToUrl,
  polishTextForTtsSpeech,
} from '../services/yunwuService';
import { cacheVideo, getCachedVideoUrl, downloadVideo } from '../services/videoCacheService';
import {
  generateImage as generateRunningHubImage,
  generateVideo as generateRunningHubVideo,
  checkTaskStatus as checkRunningHubTaskStatus,
  generateAudio,
  uploadAudioToRunningHub,
  resolveRunningHubOutputUrl,
  type RunningHubImageOptions,
  type RunningHubVideoOptions,
} from '../services/runninghubService';
import { getSelectedVoice, updateVoice } from '../services/voiceLibraryService';
import { LTX2_WORKFLOW_TEMPLATE } from '../services/ltx2WorkflowTemplate';
import { generateJimengImages, generateJimengVideoAsync, queryJimengVideoTask } from '../services/jimengService';
import { detectCharactersInPrompt, pickPrimaryCharacterForPrompt } from '../services/characterLibraryService';
import { CharacterLibrary } from './CharacterLibrary';
import { VoiceLibrary } from './VoiceLibrary';
import { Upload, FileText, Image as ImageIcon, Video, Play, Download, Edit2, Save, X, Loader2, Plus, Trash2, RefreshCw, Settings, FolderOpen, Rocket, Copy, Check, CheckSquare, Square, Users, HardDrive, ListOrdered, ArrowUp, Terminal } from 'lucide-react';
import JSZip from 'jszip';
import { HistorySelector } from './HistorySelector';
import {
  getHistory,
  HistoryRecord,
  deleteHistory,
  clearHistory,
  deleteScriptHistoryLegacyItem,
  clearScriptHistoryLegacy,
  removeLastGeneratedScriptIfContentEquals,
  clearLastGeneratedScript,
  LAST_GENERATED_SCRIPT_TIMELINE_TS,
} from '../services/historyService';
import { useToast } from './Toast';
import { ProgressBar } from './ProgressBar';
import { exportJianyingDraft, JianyingShot } from '../services/jianyingExportService';
import { loadOneClickQueue, saveOneClickQueue, newQueueTaskId, newOneshotTaskId, OneClickQueueTask, OneClickTaskSnapshot } from '../services/oneClickTaskQueue';
import { COVER_STYLE_PRESETS, MEDIA_IMAGE_STYLE_STORAGE_KEY } from '../services/coverStylePresets';
import {
  generateMediaSnapshotId,
  listMediaProjects,
  deleteMediaProject,
  clearAllMediaProjects,
  saveOrUpdateMediaProject,
  saveMediaProjectSnapshot,
  getMediaProject,
  shotsHaveGeneratedMedia,
  persistedShotToShot,
  MEDIA_HISTORY_MAX_DATA_URL_CHARS,
  type MediaProjectRecord,
} from '../services/mediaProjectHistoryService';

interface MediaGeneratorProps {
  apiKey: string;
  provider: ApiProvider;
  toast?: ReturnType<typeof useToast>;
  runningHubApiKey?: string;
  setRunningHubApiKey?: (key: string) => void;
}

// 镜头数据接口
interface Shot {
  id: string;
  number: number;
  caption: string;
  imagePrompt: string;
  videoPrompt: string;
  shotType: string;
  voiceOver: string;
  soundEffect: string;
  /** RunningHub TTS 生成的配音试听地址 */
  voiceAudioUrl?: string;
  /** 生成该音频时实际送入 TTS 的文案（用于导出字幕与音频严格一致） */
  voiceSourceText?: string;
  /** TTS 音频时长（秒），导出剪映时用于音频下载失败的兜底时长 */
  audioDurationSec?: number;
  voiceGenerating?: boolean;
  imageUrls?: string[]; // 支持多张图片
  videoUrl?: string; // 保留向后兼容（显示第一个视频）
  videoUrls?: string[]; // 支持多个视频（追加模式）
  cachedVideoUrl?: string; // 缓存的视频 Blob URL
  cachedVideoUrls?: string[]; // 缓存的视频 Blob URL 数组
  imageGenerating?: boolean;
  videoGenerating?: boolean;
  selected?: boolean;
  editing?: boolean;
  selectedImageIndex?: number; // 选中的图片索引（-1 表示未选中）
}

/** 镜头文案里「角色-语气：」或「角色：」后的口播正文（无前缀则整段即正文） */
function getCaptionSpeakBody(caption: string): string {
  const c = (caption || '').trim();
  if (!c) return '';
  const m = c.match(/^[^-:：]+-[^:：]+[:：]\s*([\s\S]*)$/);
  if (m) return stripOuterQuotes(m[1].trim());
  const m2 = c.match(/^[^:：]+[:：]\s*([\s\S]*)$/);
  if (m2) return stripOuterQuotes(m2[1].trim());
  return stripOuterQuotes(c);
}

function stripOuterQuotes(s: string): string {
  const t = s.trim();
  if (t.length < 2) return t;
  const a = t[0];
  const b = t[t.length - 1];
  if ((a === '"' && b === '"') || (a === '\u201c' && b === '\u201d') || (a === '「' && b === '」') || (a === '『' && b === '』')) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/** 从镜头文案前缀解析角色名 */
function getCaptionRolePrefix(caption: string): string {
  const c = (caption || '').trim();
  const m = c.match(/^([^-:：]+)-[^:：]+[:：]/);
  if (m) return m[1].trim();
  const m2 = c.match(/^([^:：]+)[:：]/);
  if (m2) return m2[1].trim();
  return '';
}

function looksLikeSpokenParagraph(s: string): boolean {
  const t = s.trim();
  if (t.length > 72) return true;
  if (/[.!?。！？]["」'']?\s/.test(t)) return true;
  if (t.includes('\n')) return true;
  return false;
}

/** 简单语言检测：超过 30% 非 ASCII 拉丁字符视为非英文（含中文、日文等） */
function isTextPrimarilyEnglish(text: string): boolean {
  if (!text || !text.trim()) return false;
  const latinChars = (text.match(/[A-Za-z]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;
  return totalChars > 0 && latinChars / totalChars > 0.3;
}

/**
 * 语音分镜应为短「角色名」；若误写入整段口播或与镜头文案重复，纠正为角色前缀或「讲述者」
 */
function normalizeShotVoiceOver(shot: Shot): Shot {
  const cap = (shot.caption || '').trim();
  const body = getCaptionSpeakBody(cap);
  const roleFromCaption = getCaptionRolePrefix(cap);
  let vo = (shot.voiceOver || '').trim();
  if (!vo) {
    return { ...shot, voiceOver: roleFromCaption || '讲述者' };
  }
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim();
  const voN = norm(vo);
  const capN = norm(cap);
  const bodyN = norm(body);
  if (voN === capN || (bodyN.length > 24 && voN === bodyN)) {
    return { ...shot, voiceOver: roleFromCaption || '讲述者' };
  }
  if (bodyN.length > 36 && voN.includes(bodyN.slice(0, Math.min(72, bodyN.length)))) {
    return { ...shot, voiceOver: roleFromCaption || '讲述者' };
  }
  if (looksLikeSpokenParagraph(vo)) {
    // 导入脚本常把整段口播误放在「语音分镜」而 caption 为空；合并到 caption 避免数据丢失
    if (!cap) {
      return { ...shot, caption: vo, voiceOver: '讲述者' };
    }
    return { ...shot, voiceOver: roleFromCaption || '讲述者' };
  }
  return { ...shot, voiceOver: vo };
}

/** TTS 朗读用：优先口播正文，不含「讲述者-平静：」等前缀 */
function getTtsSpeakText(shot: Shot): string {
  const cap = (shot.caption || '').trim();
  const body = getCaptionSpeakBody(cap);
  if (body) return body;
  const vo = (shot.voiceOver || '').trim();
  if (vo && looksLikeSpokenParagraph(vo)) return vo;
  if (vo && !looksLikeSpokenParagraph(vo)) return cap || vo;
  return vo || cap;
}

/** 队列任务快照中的 shots → 可预览的 Shot[]（URL 规范化 + 语音分镜字段纠正） */
function queueSnapshotRowsToShots(raw: unknown[] | undefined | null): Shot[] {
  if (!raw || !Array.isArray(raw)) return [];
  const mapped: Shot[] = raw.map((row) => {
    const p = persistedShotToShot(row as any);
    const rowAny = row as Record<string, unknown>;
    const rawVoice =
      p.voiceoverAudioUrl ||
      (typeof rowAny.voiceAudioUrl === 'string' ? rowAny.voiceAudioUrl : undefined);
    return normalizeShotVoiceOver({
      id: String(p.id ?? ''),
      number: Number(p.number) || 0,
      caption: String(p.caption ?? ''),
      imagePrompt: String(p.imagePrompt ?? ''),
      videoPrompt: String(p.videoPrompt ?? ''),
      shotType: String(p.shotType ?? ''),
      voiceOver: String(p.voiceOver ?? ''),
      soundEffect: String(p.soundEffect ?? ''),
      voiceAudioUrl: rawVoice,
      audioDurationSec: p.audioDurationSec,
      voiceSourceText: (p as any).voiceSourceText,
      imageUrls: p.imageUrls,
      videoUrl: p.videoUrl,
      videoUrls: p.videoUrls,
      cachedVideoUrl: p.cachedVideoUrl,
      cachedVideoUrls: p.cachedVideoUrls,
      selected: !!p.selected,
      selectedImageIndex: p.selectedImageIndex,
      imageGenerating: false,
      videoGenerating: false,
      voiceGenerating: false,
      editing: false,
    });
  });
  return normalizeRestoredShotsMediaUrls(mapped);
}

function shotsToPersistPayloadFromShots(list: Shot[]) {
  return list.map((s) => ({
    id: s.id,
    number: s.number,
    caption: s.caption,
    imagePrompt: s.imagePrompt,
    videoPrompt: s.videoPrompt,
    shotType: s.shotType,
    voiceOver: s.voiceOver,
    soundEffect: s.soundEffect,
    imageUrls: s.imageUrls,
    videoUrl: s.videoUrl,
    videoUrls: s.videoUrls,
    voiceoverAudioUrl: s.voiceAudioUrl,
    audioDurationSec: s.audioDurationSec,
    voiceSourceText: s.voiceSourceText,
    selected: s.selected,
    selectedImageIndex: s.selectedImageIndex,
  }));
}

/** 历史持久化前压缩超大 data:image，避免超过 MEDIA_HISTORY_MAX_DATA_URL_CHARS 被整段丢弃 */
async function compressOversizedImageDataUrlsForHistory(
  shots: Shot[],
  maxDataUrlChars: number
): Promise<Shot[]> {
  if (typeof document === 'undefined') return shots;
  const needShrink = (u: string) => u.startsWith('data:image') && u.length > maxDataUrlChars * 0.92;
  const shrinkOne = (dataUrl: string) =>
    new Promise<string>((resolve) => {
      if (!needShrink(dataUrl)) {
        resolve(dataUrl);
        return;
      }
      const img = new Image();
      img.onload = () => {
        try {
          let maxW = 960;
          const nw = img.naturalWidth || img.width || 1;
          const nh = img.naturalHeight || img.height || 1;
          let out = dataUrl;
          for (let attempt = 0; attempt < 5; attempt++) {
            const w = Math.min(maxW, nw);
            const h = Math.round((nh / nw) * w);
            const c = document.createElement('canvas');
            c.width = Math.max(1, w);
            c.height = Math.max(1, h);
            const ctx = c.getContext('2d');
            if (!ctx) break;
            ctx.drawImage(img, 0, 0, c.width, c.height);
            let q = 0.82;
            out = c.toDataURL('image/jpeg', q);
            for (let i = 0; i < 10 && out.length > maxDataUrlChars && q > 0.36; i++) {
              q -= 0.07;
              out = c.toDataURL('image/jpeg', q);
            }
            if (out.length <= maxDataUrlChars) break;
            maxW = Math.max(320, Math.floor(maxW * 0.72));
          }
          resolve(out.length < dataUrl.length ? out : dataUrl);
        } catch {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });

  const out: Shot[] = [];
  for (const s of shots) {
    const urls = s.imageUrls;
    if (!urls?.length) {
      out.push(s);
      continue;
    }
    const nextUrls: string[] = [];
    for (const u of urls) {
      nextUrls.push(await shrinkOne(u));
    }
    out.push({ ...s, imageUrls: nextUrls });
  }
  return out;
}

function normalizePersistedMediaUrl(u: string | undefined): string | undefined {
  if (!u || typeof u !== 'string') return undefined;
  const t = u.trim();
  if (!t) return undefined;
  if (/^(https?:|data:|blob:)/i.test(t)) return t;
  return resolveRunningHubOutputUrl(t);
}

function normalizeRestoredShotsMediaUrls(list: Shot[]): Shot[] {
  return list.map((shot) => {
    const imgs = shot.imageUrls
      ?.map((x) => normalizePersistedMediaUrl(x))
      .filter((x): x is string => !!x);
    const vids = shot.videoUrls
      ?.map((x) => normalizePersistedMediaUrl(x))
      .filter((x): x is string => !!x);
    return {
      ...shot,
      imageUrls: imgs?.length ? imgs : undefined,
      videoUrl: normalizePersistedMediaUrl(shot.videoUrl),
      videoUrls: vids?.length ? vids : undefined,
      voiceAudioUrl: normalizePersistedMediaUrl(shot.voiceAudioUrl),
    };
  });
}

function restoredShotsFromProject(shots: MediaProjectRecord['shots']): Shot[] {
  const raw = shots.map((row) => {
    const p = persistedShotToShot(row);
    return {
      id: p.id,
      number: p.number,
      caption: p.caption,
      imagePrompt: p.imagePrompt,
      videoPrompt: p.videoPrompt,
      shotType: p.shotType,
      voiceOver: p.voiceOver,
      soundEffect: p.soundEffect,
      voiceAudioUrl: p.voiceoverAudioUrl,
      audioDurationSec: p.audioDurationSec,
      voiceSourceText: (p as any).voiceSourceText,
      imageUrls: p.imageUrls,
      videoUrl: p.videoUrl,
      videoUrls: p.videoUrls,
      cachedVideoUrl: p.cachedVideoUrl,
      cachedVideoUrls: p.cachedVideoUrls,
      selected: p.selected,
      selectedImageIndex: p.selectedImageIndex,
      imageGenerating: false,
      videoGenerating: false,
      voiceGenerating: false,
      editing: false,
    };
  });
  return normalizeRestoredShotsMediaUrls(raw).map(normalizeShotVoiceOver);
}

function firstPersistedShotPreviewImageUrl(project: MediaProjectRecord): string | undefined {
  const sh0 = project.shots?.[0];
  if (!sh0?.imageUrls?.length) return undefined;
  const idx =
    sh0.selectedImageIndex != null &&
    sh0.selectedImageIndex >= 0 &&
    sh0.selectedImageIndex < sh0.imageUrls.length
      ? sh0.selectedImageIndex
      : 0;
  const u = sh0.imageUrls[idx] ?? sh0.imageUrls[0];
  return normalizePersistedMediaUrl(u);
}

/** 从队列/一键成片任务快照中取第一镜预览图（大于 60×60 缩略图的展示尺寸，供右侧预览用） */
function taskPreviewImageUrl(task: OneClickQueueTask): string | undefined {
  const rows = (task.resultSnapshot?.shots || task.snapshot?.shots || []) as unknown[];
  if (!rows?.length) return undefined;
  const first = rows[0] as Record<string, unknown>;
  const imageUrls = first?.imageUrls as string[] | undefined;
  if (!imageUrls?.length) return undefined;
  const idx =
    first.selectedImageIndex != null &&
    Number(first.selectedImageIndex) >= 0 &&
    Number(first.selectedImageIndex) < imageUrls.length
      ? Number(first.selectedImageIndex)
      : 0;
  const u = imageUrls[idx] ?? imageUrls[0];
  if (!u) return undefined;
  if (/^(https?:|data:|blob:)/i.test(u)) return u;
  const resolved = resolveRunningHubOutputUrl(String(u)).trim();
  return /^https?:\/\//i.test(resolved) ? resolved : undefined;
}

// 图片模型配置（仅保留指定模型）
const IMAGE_MODELS = [
  { id: 'sora-image', name: 'Sora Image', endpoint: '/v1/chat/completions', supportsImageToImage: false },
  { id: 'banana', name: 'Banana (Gemini 2.5 Flash)', endpoint: '/v1/images/generations', apiModelName: 'gemini-2.5-flash-image', supportsImageToImage: false },
  { id: 'banana-2', name: 'Banana 2 (Gemini 3 Pro)', endpoint: '/v1/images/generations', apiModelName: 'gemini-3-pro-image-preview', supportsImageToImage: false },
  { id: 'grok-3-image', name: 'Grok 3 Image', endpoint: '/v1/chat/completions', supportsImageToImage: false },
  { id: 'grok-4-image', name: 'Grok 4 Image', endpoint: '/v1/chat/completions', supportsImageToImage: false },
  { id: 'jimeng-5.0', name: '即梦 5.0 (Jimeng)', endpoint: 'jimeng', isJimeng: true, supportsImageToImage: true, jimengModel: 'jimeng-5.0' },
  { id: 'jimeng-4.0', name: '即梦 4.0 (Jimeng)', endpoint: 'jimeng', isJimeng: true, supportsImageToImage: true, jimengModel: 'jimeng-4.0' },
];

// 视频模型配置（仅 RunningHub）
const VIDEO_MODELS = [
  { id: 'runninghub-wan2.2', name: 'RunningHub - Wan2.2', duration: 5, supportedDurations: [5, 10, 15], defaultSize: '720P', supportedSizes: ['720P'], orientation: 'landscape', isRunningHub: true },
  { id: 'runninghub-ltx2', name: 'RunningHub - LTX-2 (10s)', duration: 10, supportedDurations: [10], defaultSize: '720P', supportedSizes: ['720P'], orientation: 'landscape', isRunningHub: true, isLtx2: true },
  { id: 'jimeng-video-3.5-pro', name: '即梦视频 3.5 Pro', duration: 5, supportedDurations: [5, 10], defaultSize: '720p', supportedSizes: ['480p', '720p', '1080p'], orientation: 'landscape', isJimengVideo: true },
  { id: 'jimeng-video-3.0', name: '即梦视频 3.0', duration: 5, supportedDurations: [5, 10], defaultSize: '720p', supportedSizes: ['480p', '720p', '1080p'], orientation: 'landscape', isJimengVideo: true },
  { id: 'jimeng-video-3.0-pro', name: '即梦视频 3.0 Pro', duration: 5, supportedDurations: [5, 10], defaultSize: '720p', supportedSizes: ['480p', '720p', '1080p'], orientation: 'landscape', isJimengVideo: true },
  { id: 'jimeng-video-seedance-2.0', name: '即梦 Seedance 2.0', duration: 4, supportedDurations: [4, 5, 6, 8, 10, 12, 15], defaultSize: '720p', supportedSizes: ['480p', '720p', '1080p'], orientation: 'landscape', isJimengVideo: true },
  { id: 'jimeng-video-seedance-2.0-fast', name: '即梦 Seedance 2.0 Fast', duration: 4, supportedDurations: [4, 5, 6, 8, 10, 12, 15], defaultSize: '720p', supportedSizes: ['480p', '720p', '1080p'], orientation: 'landscape', isJimengVideo: true },
  { id: 'jimeng-video-seedance-2.0-fast-vip', name: '即梦 Seedance 2.0 Fast VIP', duration: 4, supportedDurations: [4, 5, 6, 8, 10, 12, 15], defaultSize: '720p', supportedSizes: ['480p', '720p', '1080p'], orientation: 'landscape', isJimengVideo: true },
  { id: 'jimeng-video-seedance-2.0-vip', name: '即梦 Seedance 2.0 VIP', duration: 4, supportedDurations: [4, 5, 6, 8, 10, 12, 15], defaultSize: '720p', supportedSizes: ['480p', '720p', '1080p'], orientation: 'landscape', isJimengVideo: true },
];

// 图片比例配置
// 注意：DALL-E 3 只支持 1024x1024, 1024x1792, 1792x1024
// Sora Image 只支持三种比例：1:1, 2:3, 3:2
const IMAGE_RATIOS = [
  { id: '1:1', name: '1:1 (正方形)', width: 1024, height: 1024, dallE3Supported: true, soraImageSupported: true },
  { id: '2:3', name: '2:3 (竖屏)', width: 1024, height: 1536, dallE3Supported: false, soraImageSupported: true },
  { id: '3:2', name: '3:2 (横屏)', width: 1536, height: 1024, dallE3Supported: false, soraImageSupported: true },
  { id: '16:9', name: '16:9 (横屏)', width: 1920, height: 1080, dallE3Supported: false, soraImageSupported: false },
  { id: '9:16', name: '9:16 (竖屏)', width: 1080, height: 1920, dallE3Supported: false, soraImageSupported: false },
  { id: '4:3', name: '4:3 (标准)', width: 1024, height: 768, dallE3Supported: false, soraImageSupported: false },
  { id: '3:4', name: '3:4 (竖屏)', width: 768, height: 1024, dallE3Supported: false, soraImageSupported: false },
  // DALL-E 3 专用比例
  { id: 'dall-e-3-portrait', name: 'DALL-E 3 竖屏 (1024x1792)', width: 1024, height: 1792, dallE3Supported: true, soraImageSupported: false },
  { id: 'dall-e-3-landscape', name: 'DALL-E 3 横屏 (1792x1024)', width: 1792, height: 1024, dallE3Supported: true, soraImageSupported: false },
];

// 风格设置：与封面设计「画面风格」共用 COVER_STYLE_PRESETS（英文 prompt 追加到生图提示词）
const STYLE_LIBRARY = [
  { id: 'none', name: '无风格（使用原提示词）', prompt: '' },
  ...COVER_STYLE_PRESETS.map((s) => ({ id: s.id, name: s.label, prompt: s.promptEn })),
];

// 辅助函数：时间戳字符串
const tsStr = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
};

// 一键成片草稿名称
const buildPipelineDraftName = () => `OC_${tsStr()}`;
// 队列任务草稿名称
const buildQueueDraftName = () => `Q_${tsStr()}`;

export const MediaGenerator: React.FC<MediaGeneratorProps> = ({ 
  apiKey, 
  provider, 
  toast: externalToast,
  runningHubApiKey: externalRunningHubKey,
  setRunningHubApiKey: externalSetRunningHubKey,
}) => {
  const internalToast = useToast();
  const toast = externalToast || internalToast;

  // RunningHub API Key（独立持久化，配音/视频随时可用）
  const [runningHubApiKey, setRunningHubApiKey] = useState(() => {
    return localStorage.getItem('RUNNINGHUB_API_KEY') || externalRunningHubKey || '';
  });
  useEffect(() => {
    if (runningHubApiKey) localStorage.setItem('RUNNINGHUB_API_KEY', runningHubApiKey);
    if (externalSetRunningHubKey) externalSetRunningHubKey(runningHubApiKey);
  }, [runningHubApiKey, externalSetRunningHubKey]);

  // 即梦走固定线上代理地址（services/jimengService.ts 内嵌），前端仅保留 Session 配置
  const [jimengSessionId, setJimengSessionId] = useState(() => {
    return localStorage.getItem('JIMENG_SESSION_ID') || '';
  });
  
  // 角色库管理
  const [showCharacterLibrary, setShowCharacterLibrary] = useState(false);
  const [showVoiceLibrary, setShowVoiceLibrary] = useState(false);
  /** 语音库选中项变化时递增，驱动主界面显示当前音色名 */
  const [voiceLibraryEpoch, setVoiceLibraryEpoch] = useState(0);
  const selectedVoiceForUi = useMemo(() => getSelectedVoice(), [voiceLibraryEpoch]);
  
  
  useEffect(() => {
    if (jimengSessionId) {
      localStorage.setItem('JIMENG_SESSION_ID', jimengSessionId);
    }
  }, [jimengSessionId]);

  const [scriptText, setScriptText] = useState('');
  const [shots, setShots] = useState<Shot[]>([]);
  /** 避免一键成片/队列 pipeline 内 await 后仍读到旧的 shots 闭包（误判「未生成出图片」） */
  const shotsRef = useRef<Shot[]>(shots);
  shotsRef.current = shots;
  const [selectedImageModel, setSelectedImageModel] = useState('jimeng-5.0');
  const [selectedVideoModel, setSelectedVideoModel] = useState(VIDEO_MODELS[0].id);
  const [selectedImageRatio, setSelectedImageRatio] = useState('16:9'); // 默认横屏 16:9
  const [selectedStyle, setSelectedStyle] = useState(() => {
    try {
      const stored = localStorage.getItem(MEDIA_IMAGE_STYLE_STORAGE_KEY);
      if (stored && STYLE_LIBRARY.some((s) => s.id === stored)) return stored;
    } catch {
      /* ignore */
    }
    return STYLE_LIBRARY[0].id;
  });
  useEffect(() => {
    try {
      localStorage.setItem(MEDIA_IMAGE_STYLE_STORAGE_KEY, selectedStyle);
    } catch {
      /* ignore */
    }
  }, [selectedStyle]);
  // 视频参数设置
  const [selectedVideoSize, setSelectedVideoSize] = useState<string>(VIDEO_MODELS[0]?.defaultSize || '1080P');
  const [selectedVideoDuration, setSelectedVideoDuration] = useState<number>(VIDEO_MODELS[0]?.duration || 10);
  const [selectedVideoOrientation, setSelectedVideoOrientation] = useState<string>('landscape'); // 视频方向：landscape 或 portrait
  const [editingShotId, setEditingShotId] = useState<string | null>(null);
  const [expandedCaptions, setExpandedCaptions] = useState<Set<string>>(new Set()); // 展开的文案ID集合
  const [expandedImagePrompts, setExpandedImagePrompts] = useState<Set<string>>(new Set()); // 展开的图片提示词ID集合
  const [expandedVideoPrompts, setExpandedVideoPrompts] = useState<Set<string>>(new Set()); // 展开的视频提示词ID集合
  /** 文案列：编辑完整镜头字段（可含「角色-语气：」前缀 + 口播正文） */
  const [editingCaptionShotId, setEditingCaptionShotId] = useState<string | null>(null);
  const [editingShotType, setEditingShotType] = useState<{ shotId: string; shotType: string } | null>(null); // 编辑景别
  const [enlargedImageUrl, setEnlargedImageUrl] = useState<string | null>(null);
  const [enlargedVideoUrl, setEnlargedVideoUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showScriptInput, setShowScriptInput] = useState(false);
  const [generateImageCount, setGenerateImageCount] = useState(1); // 每次生成的图片数量
  const [showScriptHistorySelector, setShowScriptHistorySelector] = useState(false);
  const [scriptHistoryRecords, setScriptHistoryRecords] = useState<HistoryRecord[]>([]);
  /** 当前弹窗来源：脚本聚合列表 vs 媒体快照列表（删除/清空逻辑不同） */
  const [historySelectorKind, setHistorySelectorKind] = useState<'script' | 'media' | null>(null);
  
  // 批量操作进度
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; type: 'image' | 'video' | 'voice' } | null>(null);

  // ==================== 一键成片 & 队列相关 State ====================
  // 一键成片执行状态
  const [oneClickRunning, setOneClickRunning] = useState(false);
  const [oneClickPipelineProgress, setOneClickPipelineProgress] = useState<string>('');
  /** 一键成片：是否生成视频（导出剪映仍会执行，仅无视频轨道） */
  const [oneClickPipelineMode, setOneClickPipelineMode] = useState<'image_audio_video' | 'image_audio_only'>('image_audio_video');

  // Workspace Tab 系统
  // 'main' = 当前编辑器，'oc_<id>' = 一键成片任务，'q_<id>' = 队列任务
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState<string>('main');
  const [queueWorkspaceTabIds, setQueueWorkspaceTabIds] = useState<string[]>([]);
  // 队列任务预览用的本地 shots 快照（只读模式）
  const [queuePreviewLocalShots, setQueuePreviewLocalShots] = useState<Shot[] | null>(null);
  // tableShots: 根据当前 tab 决定使用 live shots 还是 queue preview shots
  const tableShots = activeWorkspaceTabId === 'main' ? shots : (queuePreviewLocalShots || []);

  // Workspace Tab 元数据
  const [queueTabMeta, setQueueTabMeta] = useState<
    Record<string, { name: string; taskType: 'oneshot' | 'queue' | 'media' }>
  >({});
  /** 媒体项目 localStorage 变更后刷新「media:」标签下的预览 */
  const [mediaProjectListVersion, setMediaProjectListVersion] = useState(0);
  const [queueTabIsLiveRun, setQueueTabIsLiveRun] = useState<Record<string, boolean>>({});

  // 终端日志
  const TERMINAL_LOG_STORAGE_KEY = 'ContentMaster_TerminalLogs';
  const [terminalLogs, setTerminalLogs] = useState<Array<{ id: string; time: string; tag: string; message: string }>>(() => {
    try {
      const stored = localStorage.getItem(TERMINAL_LOG_STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const terminalScrollRef = useRef<HTMLDivElement>(null);
  const appendTerminalLog = (tag: string, message: string) => {
    const entry = { id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, time: tsStr(), tag, message };
    setTerminalLogs(prev => {
      const next = [...prev, entry];
      try { localStorage.setItem(TERMINAL_LOG_STORAGE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
    setTimeout(() => {
      terminalScrollRef.current?.scrollTo({ top: terminalScrollRef.current.scrollHeight, behavior: 'smooth' });
    }, 50);
  };

  const scriptTextRef = useRef(scriptText);
  useEffect(() => {
    scriptTextRef.current = scriptText;
  }, [scriptText]);

  const activeWorkspaceTabIdRef = useRef(activeWorkspaceTabId);
  useEffect(() => {
    activeWorkspaceTabIdRef.current = activeWorkspaceTabId;
  }, [activeWorkspaceTabId]);

  /** 仅在有图/音/视频生成时写入历史；指纹相同则跳过（防抖合并短时间多次写入） */
  const lastMediaHistorySignatureRef = useRef('');
  const mediaHistoryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 最近一次写入的 record ID（用于区分「新建」与「更新已有」） */
  const lastMediaHistoryIdRef = useRef<string | null>(null);

  /** 计算持久化媒体指纹（与 buildMediaProjectFingerprint 保持一致：shot ID + 媒体数量） */
  const computeMediaHistoryFingerprint = (payload: ReturnType<typeof shotsToPersistPayloadFromShots>) => {
    return payload
      .map((s) => {
        const ni = s.imageUrls?.length ?? 0;
        const nv = (s.videoUrls?.length ?? 0) + (s.videoUrl ? 1 : 0);
        const na = s.voiceoverAudioUrl ? 1 : 0;
        return `${s.id}:${ni}:${nv}:${na}`;
      })
      .join('|');
  };

  const flushMediaHistoryCommitWithShots = (shotList: Shot[]) => {
    const payload = shotsToPersistPayloadFromShots(shotList);
    if (!shotsHaveGeneratedMedia(payload)) return;
    const sig = computeMediaHistoryFingerprint(payload);
    if (sig === lastMediaHistorySignatureRef.current) return;
    const { id, isUpdate } = saveOrUpdateMediaProject({
      scriptText: scriptTextRef.current,
      shots: payload,
      preferUpdateId: lastMediaHistoryIdRef.current,
    });
    lastMediaHistorySignatureRef.current = sig;
    lastMediaHistoryIdRef.current = id;
    setMediaProjectListVersion((v) => v + 1);
    appendTerminalLog('History', `已${isUpdate ? '更新' : '记录'}媒体快照 ${id}`);
  };
  const flushMediaHistoryCommit = () => {
    flushMediaHistoryCommitWithShots(shotsRef.current);
  };
  const scheduleMediaHistorySave = () => {
    if (mediaHistoryTimerRef.current) clearTimeout(mediaHistoryTimerRef.current);
    // pipeline 执行期间跳过自动保存：镜头的图/音/视频会在 pipeline 完成时统一写入完整快照
    if (activeQueueTaskIdRef.current != null) return;
    mediaHistoryTimerRef.current = setTimeout(() => {
      mediaHistoryTimerRef.current = null;
      flushMediaHistoryCommit();
    }, 2000);
  };

  /** 切换顶部工作区标签并立即载入该任务 / 媒体历史快照 */
  const activateQueueWorkspaceTab = (tabId: string) => {
    setActiveWorkspaceTabId(tabId);
    if (tabId === 'main') {
      setQueuePreviewLocalShots(null);
      return;
    }
    if (tabId.startsWith('media:')) {
      const pid = tabId.slice(6);
      const p = getMediaProject(pid);
      setQueuePreviewLocalShots(p ? restoredShotsFromProject(p.shots) : null);
      return;
    }
    const task = oneClickQueueTasksRef.current.find((t) => t.id === tabId);
    const rows = task?.resultSnapshot?.shots ?? task?.snapshot?.shots;
    setQueuePreviewLocalShots(queueSnapshotRowsToShots(rows as unknown[]));
  };

  /** 与队列「查看任务」相同：新标签预览媒体历史，不覆盖主编辑区 */
  const openMediaProjectWorkspaceTab = (projectId: string) => {
    const tabId = `media:${projectId.trim()}`;
    const labelShort = projectId.trim();
    setQueueTabMeta((prev) => ({
      ...prev,
      [tabId]: { name: `历史 ${labelShort}`, taskType: 'media' },
    }));
    setQueueWorkspaceTabIds((prev) => (prev.includes(tabId) ? prev : [...prev, tabId]));
    activateQueueWorkspaceTab(tabId);
  };

  // Workspace Tab 操作
  const openQueueTaskWorkspaceTab = (taskId: string, name: string, taskType: 'oneshot' | 'queue', isLiveRun = false) => {
    setQueueTabMeta((prev) => ({ ...prev, [taskId]: { name, taskType } }));
    setQueueTabIsLiveRun((prev) => ({ ...prev, [taskId]: isLiveRun }));
    setQueueWorkspaceTabIds((prev) => {
      if (!prev.includes(taskId)) return [...prev, taskId];
      return prev;
    });
    activateQueueWorkspaceTab(taskId);
  };
  const closeQueueTaskWorkspaceTab = (taskId: string) => {
    setQueueWorkspaceTabIds((prev) => prev.filter((id) => id !== taskId));
    setQueueTabMeta((prev) => {
      const n = { ...prev };
      delete n[taskId];
      return n;
    });
    setQueueTabIsLiveRun((prev) => {
      const n = { ...prev };
      delete n[taskId];
      return n;
    });
    if (activeWorkspaceTabId === taskId) {
      activateQueueWorkspaceTab('main');
    }
  };

  // 队列任务状态（持久化）
  const [oneClickQueueTasks, setOneClickQueueTasks] = useState<OneClickQueueTask[]>(() => loadOneClickQueue());
  const oneClickQueueTasksRef = useRef<OneClickQueueTask[]>(oneClickQueueTasks);
  useEffect(() => {
    oneClickQueueTasksRef.current = oneClickQueueTasks;
  }, [oneClickQueueTasks]);
  const queueStorageWarnedRef = useRef(false);
  /** 主工作区标签：与队列历史中最新一键成片 oc_ 任务 ID 一致（无则显示「分镜编辑」） */
  const mainWorkspaceTabTitle = useMemo(() => {
    for (let i = oneClickQueueTasks.length - 1; i >= 0; i--) {
      const t = oneClickQueueTasks[i];
      if (t.type === 'oneshot') return t.id;
    }
    return '分镜编辑';
  }, [oneClickQueueTasks]);
  const [queueGloballyPaused, setQueueGloballyPaused] = useState(false);
  const [queueProcessorRunning, setQueueProcessorRunning] = useState(false);
  const queueGloballyPausedRef = useRef(false);
  const queueRunnerBusyRef = useRef(false);
  const activeQueueTaskIdRef = useRef<string | null>(null);

  const saveQueueStateAfterMutation = (tasks: OneClickQueueTask[]) => {
    oneClickQueueTasksRef.current = tasks;
    const ok = saveOneClickQueue(tasks);
    if (!ok && !queueStorageWarnedRef.current) {
      queueStorageWarnedRef.current = true;
      toast.error(
        '一键成片队列无法写入浏览器本地存储（空间可能已满），列表进度可能与日志不一致，请清理站点数据或缩短分镜内容后重试。'
      );
    }
    if (ok) queueStorageWarnedRef.current = false;
  };

  // 持久化队列（必须用内存中的任务列表合并；flushSync 避免与 pipeline 完成更新的批处理竞态导致界面回退到旧进度）
  const persistQueue = (tasks: OneClickQueueTask[]) => {
    saveQueueStateAfterMutation(tasks);
    flushSync(() => setOneClickQueueTasks(tasks));
  };

  // 非主标签：队列任务 oc_/Q_ 或媒体历史 media:xxx 的预览与存储同步
  useEffect(() => {
    if (activeWorkspaceTabId === 'main') {
      setQueuePreviewLocalShots(null);
      return;
    }
    if (activeWorkspaceTabId.startsWith('media:')) {
      const pid = activeWorkspaceTabId.slice(6);
      const p = getMediaProject(pid);
      setQueuePreviewLocalShots(p ? restoredShotsFromProject(p.shots) : null);
      return;
    }
    const task = oneClickQueueTasks.find((t) => t.id === activeWorkspaceTabId);
    const rows = task?.resultSnapshot?.shots ?? task?.snapshot?.shots;
    setQueuePreviewLocalShots(queueSnapshotRowsToShots(rows as unknown[]));
  }, [activeWorkspaceTabId, oneClickQueueTasks, mediaProjectListVersion]);

  // ==================== 剪映导出相关 State ====================
  const [jianyingOutputDir, setJianyingOutputDir] = useState(() => localStorage.getItem('JIANYING_OUTPUT_DIR') || '');
  const onChangeJianyingOutputDir = (value: string) => {
    setJianyingOutputDir(value);
    const next = value.trim();
    if (next) localStorage.setItem('JIANYING_OUTPUT_DIR', next);
    else localStorage.removeItem('JIANYING_OUTPUT_DIR');
  };
  const [jyRandomEffectBundle, setJyRandomEffectBundle] = useState(false);
  const [jyRandomTransitions, setJyRandomTransitions] = useState(false);
  const [jyRandomFilters, setJyRandomFilters] = useState(false);
  const [isExportingToJianying, setIsExportingToJianying] = useState(false);
  const [lastJianyingDownloadUrl, setLastJianyingDownloadUrl] = useState<string>('');

  // shots 转 JianyingShot[]
  const shotsToJianying = (sList: Shot[]): JianyingShot[] =>
    sList.map((s) => {
      const rawAudio = s.voiceAudioUrl?.trim();
      const audioUrl =
        rawAudio && !/^https?:|^data:|^blob:/i.test(rawAudio)
          ? resolveRunningHubOutputUrl(rawAudio)
          : rawAudio;
      const exportCaption = (s.voiceSourceText || getTtsSpeakText(s) || s.caption || '').trim();
      return {
        caption: exportCaption,
        imagePrompt: s.imagePrompt,
        imageUrl: s.imageUrls?.[s.selectedImageIndex ?? 0] || s.imageUrls?.[0],
        videoPrompt: s.videoPrompt,
        videoUrl: s.videoUrls?.[0] || s.videoUrl,
        audioUrl,
        voiceoverAudioUrl: audioUrl,
        audioDurationSec: s.audioDurationSec,
      };
    });

  const performExportToJianying = async (exportShots: Shot[], exportDraftName: string, settings?: { randomEffectBundle?: boolean; randomTransitions?: boolean; randomFilters?: boolean }): Promise<boolean> => {
    setIsExportingToJianying(true);
    setLastJianyingDownloadUrl('');
    try {
      const result = await exportJianyingDraft({
        draftName: exportDraftName,
        shots: shotsToJianying(exportShots),
        outputPath: undefined,
        pathMapRoot: jianyingOutputDir || undefined,
        randomTransitions: settings?.randomTransitions ?? jyRandomTransitions,
        randomVideoEffects:
          (settings?.randomEffectBundle ?? jyRandomEffectBundle) ||
          (settings?.randomFilters ?? jyRandomFilters),
      });
      if (result.success) {
        const apiBase = (import.meta.env.VITE_JIANYING_API_BASE || '/api/jianying').replace(/\/$/, '');
        const rawZipUrl = (result.zip_download_url || '').trim();
        let downloadUrl = '';
        if (rawZipUrl) {
          if (/^https?:\/\//i.test(rawZipUrl)) {
            downloadUrl = rawZipUrl;
          } else {
            const baseOrigin = /^https?:\/\//i.test(apiBase)
              ? new URL(apiBase).origin
              : window.location.origin;
            const normalizedPath = rawZipUrl.startsWith('/') ? rawZipUrl : `/${rawZipUrl}`;
            downloadUrl = `${baseOrigin}${normalizedPath}`;
          }
        }
        if (downloadUrl) {
          setLastJianyingDownloadUrl(downloadUrl);
          appendTerminalLog('Jianying', `导出成功并生成下载链接: ${downloadUrl}`);
        }
        appendTerminalLog('Jianying', `导出成功: ${exportDraftName} → ${result.draft_folder || jianyingOutputDir}`);
        toast.success(`剪映草稿导出成功: ${result.draft_folder || exportDraftName}`);
        return true;
      } else {
        appendTerminalLog('Jianying', `导出失败: ${result.error}`);
        toast.error(`导出失败: ${result.error}`);
        return false;
      }
    } catch (err: any) {
      appendTerminalLog('Jianying', `导出异常: ${err.message}`);
      toast.error(`导出异常: ${err.message}`);
      return false;
    } finally {
      setIsExportingToJianying(false);
    }
  };

  const handleExportToJianying = async () => {
    if (tableShots.length === 0) { toast.error('没有可导出的镜头'); return; }
    await performExportToJianying(tableShots, buildPipelineDraftName());
  };

  // 补导出：针对已完成队列任务重新导出
  const handleReexportJianyingForTask = async (taskId: string) => {
    const task = oneClickQueueTasks.find(t => t.id === taskId);
    if (!task) return;
    const targetShots = task.resultSnapshot?.shots || task.snapshot?.shots || [];
    if (targetShots.length === 0) { toast.error('没有可导出的数据'); return; }
    const reexportName = task.type === 'oneshot'
      ? `OC_${task.completedAt || tsStr()}`
      : `Q_${task.completedAt || tsStr()}`;
    await performExportToJianying(targetShots, reexportName);
  };

  // ==================== 一键成片 Pipeline 函数 ====================
  const shotHasExportableVisual = (shot: Shot): boolean => {
    return !!(shot.videoUrl || shot.videoUrls?.length);
  };

  const getLiveShot = (shotId: string): Shot | undefined => shotsRef.current.find(s => s.id === shotId);

  // 核心 Pipeline：图片 → 配音 → 图生视频 → 导出剪映
  const executeOneClickPipelineForTargets = async (
    targetShotIds: string[],
    exportDraftName: string,
    taskId: string,
    taskType: 'oneshot' | 'queue'
  ) => {
    const targetShots = targetShotIds.map(id => getLiveShot(id)).filter(Boolean) as Shot[];
    if (targetShots.length === 0) {
      appendTerminalLog('Pipeline', '没有可处理的镜头（请确认已加载队列快照或镜头 ID 一致）');
      setOneClickQueueTasks((prev) => {
        const tasks = prev.map((t) =>
          t.id === taskId
            ? { ...t, status: 'failed' as const, completedAt: tsStr(), progressNote: '无可处理镜头' }
            : t
        );
        saveQueueStateAfterMutation(tasks);
        return tasks;
      });
      toast.error('没有可处理的镜头');
      return;
    }

    const prevActivePipelineTaskId = activeQueueTaskIdRef.current;
    activeQueueTaskIdRef.current = taskId;
    try {
    appendTerminalLog(
      'Pipeline',
      `[${taskType === 'oneshot' ? '一键成片' : '队列任务'}] 开始执行（每镜：图片与配音并行）…`
    );

    const N = Math.max(1, targetShots.length);
    const includeVideo = oneClickPipelineMode !== 'image_audio_only';
    let videoSlots = 0;
    if (includeVideo) {
      for (const sh of targetShots) {
        const c = getLiveShot(sh.id);
        if (c && !c.videoUrl && !c.videoUrls?.length && c.videoPrompt?.trim()) videoSlots++;
      }
    }

    const patchTaskProgress = (percent: number, note?: string) => {
      const p = Math.max(0, Math.min(100, Math.round(percent)));
      setOneClickQueueTasks((prev) => {
        const next = prev.map((t) =>
          t.id === taskId
            ? {
                ...t,
                progressPercent: p,
                ...(note !== undefined ? { progressNote: note } : {}),
              }
            : t
        );
        saveQueueStateAfterMutation(next);
        return next;
      });
    };

    patchTaskProgress(1, '启动…');

    // Step 1+2 合并：每个镜头内「图片生成」与「配音」Promise.all 并行，镜与镜仍顺序执行（控并发）
    let idx = 0;
    for (const shot of targetShots) {
      idx++;
      const snap = getLiveShot(shot.id);
      if (!snap) continue;

      const needImage = !shotHasExportableVisual(snap) && !!snap.imagePrompt?.trim();
      const voiceText = getTtsSpeakText(snap).trim();
      const needVoice = !!voiceText && !snap.voiceAudioUrl;

      if (shotHasExportableVisual(snap)) {
        appendTerminalLog('Pipeline', `镜头${snap.number}: 已有视频，跳过图片生成（强制重新生图）`);
      } else if (!snap.imagePrompt?.trim()) {
        appendTerminalLog('ImageGen', `镜头${snap.number}: 无图片提示词，跳过`);
      }
      if (!voiceText) {
        appendTerminalLog('Voice', `镜头${snap.number}: 无文案可配音，跳过`);
      } else if (snap.voiceAudioUrl) {
        appendTerminalLog('Voice', `镜头${snap.number}: 已有配音音频，跳过`);
      }

      if (!needImage && !needVoice) continue;

      appendTerminalLog(
        'Pipeline',
        `镜头${snap.number}: 并行 — ${needImage ? '生成图' : '图跳过'} · ${needVoice ? '生成音' : '音跳过'}`
      );

      const runImage = async () => {
        if (!needImage) return;
        const num = snap.number;
        setOneClickPipelineProgress(`并行图片 ${idx}/${targetShots.length} (镜头${num})`);
        appendTerminalLog('ImageGen', `镜头${num}: 开始生成图片`);
        let retries = 3;
        while (retries > 0) {
          try {
            // 使用返回布尔值判定成功，避免 React setState 闭包延迟导致误判
            const ok = await handleGenerateImage(snap, false);
            if (ok) {
              appendTerminalLog('ImageGen', `镜头${num}: 图片生成完成`);
              break;
            }
            throw new Error('图片生成失败');
          } catch (err: any) {
            retries--;
            appendTerminalLog('ImageGen', `镜头${num}: 生成失败 (${err.message}), 剩余${retries}次`);
            if (retries === 0) {
              updateShot(shot.id, { imageGenerating: false });
              toast.error(`镜头${num}图片生成失败`);
            } else {
              await new Promise(r => setTimeout(r, 3000));
            }
          }
        }
      };

      const runVoice = async () => {
        if (!needVoice) return;
        const live = getLiveShot(shot.id);
        if (!live) return;
        const num = live.number;
        setOneClickPipelineProgress(`并行配音 ${idx}/${targetShots.length} (镜头${num})`);
        appendTerminalLog('Voice', `镜头${num}: 生成配音中`);
        try {
          await synthesizeVoiceForShot(live, { playAfter: false });
          appendTerminalLog('Voice', `镜头${num}: 配音生成完成`);
        } catch (e: any) {
          appendTerminalLog('Voice', `镜头${num}: 配音失败 ${e.message || e}`);
        }
      };

      await Promise.all([runImage(), runVoice()]);
      patchTaskProgress(2 + (idx / N) * 38, `图/音 ${idx}/${N}`);
    }

    // Step 3: 视频（与单镜头相同逻辑 + RunningHub 轮询）
    if (oneClickPipelineMode === 'image_audio_only') {
      appendTerminalLog('Pipeline', '一键成片设置：仅图片+音频，已跳过视频生成');
      patchTaskProgress(88, '跳过视频…');
    } else {
      let vDone = 0;
      const vTotal = Math.max(1, videoSlots);
      for (const shot of targetShots) {
        const current = getLiveShot(shot.id);
        if (!current) continue;
        if (current.videoUrl || current.videoUrls?.length) {
          appendTerminalLog('VideoGen', `镜头${current.number}: 已有视频，跳过`);
          continue;
        }
        if (!current.videoPrompt?.trim()) {
          appendTerminalLog('VideoGen', `镜头${current.number}: 无视频提示词，跳过`);
          continue;
        }
        const slotIndex = vDone;
        setOneClickPipelineProgress(`生成视频 ${targetShots.indexOf(shot) + 1}/${targetShots.length} (镜头${shot.number})`);
        appendTerminalLog('VideoGen', `镜头${current.number}: 开始生成视频`);
        let retries = 3;
        while (retries > 0) {
          try {
            const c2 = getLiveShot(current.id);
            if (!c2) break;
            if (c2.videoUrl || c2.videoUrls?.length) {
              appendTerminalLog('VideoGen', `镜头${c2.number}: 已有视频，跳过`);
              break;
            }
            await handleGenerateVideo(c2, false, {
              onVideoHubProgress: (hub) => {
                const base = 40;
                const span = 48;
                const overall = base + ((slotIndex + hub / 100) / vTotal) * span;
                patchTaskProgress(Math.min(87, overall), `视频 ${slotIndex + 1}/${videoSlots || 1} · ${Math.round(hub)}%`);
              },
            });
            appendTerminalLog('VideoGen', `镜头${current.number}: 视频生成完成`);
            vDone++;
            patchTaskProgress(40 + (vDone / vTotal) * 48, `视频完成 ${vDone}/${videoSlots}`);
            break;
          } catch (err: any) {
            retries--;
            appendTerminalLog('VideoGen', `镜头${current.number}: 视频生成失败 (${err.message}), 剩余${retries}次`);
            if (retries === 0) {
              updateShot(current.id, { videoGenerating: false });
            } else {
              await new Promise(r => setTimeout(r, 5000));
            }
          }
        }
      }
      if (videoSlots === 0) {
        patchTaskProgress(88, '无待生成视频');
      }
    }

    // Step 4: 导出剪映（等视频真正生成完毕后才执行，不会提前）
    setOneClickPipelineProgress('导出剪映草稿...');
    patchTaskProgress(90, '导出剪映…');
    // 取当前最新镜头数据（含音频 URL）
    const finalShots = targetShotIds.map(id => getLiveShot(id)).filter(Boolean) as Shot[];
    appendTerminalLog('Pipeline', `开始导出剪映草稿: ${exportDraftName}（${finalShots.length} 镜）`);
    const jianyingResult = await performExportToJianying(finalShots, exportDraftName);
    appendTerminalLog('Pipeline', `[${taskType === 'oneshot' ? '一键成片' : '队列任务'}] 执行完成`);

    // 仅在剪映导出成功时才显示完成 toast（pipeline 可能中途失败，catch 会显示错误 toast）
    if (jianyingResult !== false) {
      setOneClickPipelineProgress('');
      toast.success(
        oneClickPipelineMode === 'image_audio_only'
          ? '一键成片执行完成（未生成视频）'
          : '一键成片执行完成！'
      );
    }
    const sanitized = buildSanitizedTaskSnapshot(captureEditorSnapshot());
    // 必须同步提交：否则 handleOneClickPipeline 里 queueMicrotask(processOneClickQueue) 会用 ref 里仍为「导出中」的快照调用 persistQueue，直接 setState 覆盖掉本次完成更新（OC 永远卡在 90% / 查看任务无 resultSnapshot）
    flushSync(() => {
      setOneClickQueueTasks((prev) => {
        const tasks = prev.map((t) =>
          t.id === taskId
            ? {
                ...t,
                status: 'completed' as const,
                completedAt: tsStr(),
                resultSnapshot: sanitized,
                progressPercent: 100,
                progressNote: '完成',
              }
            : t
        );
        saveQueueStateAfterMutation(tasks);
        return tasks;
      });
    });

    } finally {
      const pipelineShotsForHistory = shotsRef.current.map((s) => ({ ...s }));
      activeQueueTaskIdRef.current = prevActivePipelineTaskId;
      queueMicrotask(() => {
        void (async () => {
          const prepared = await compressOversizedImageDataUrlsForHistory(
            pipelineShotsForHistory,
            MEDIA_HISTORY_MAX_DATA_URL_CHARS
          );
          flushMediaHistoryCommitWithShots(prepared);
        })();
      });
    }
  };

  // 任务快照清理（移除生成中状态）
  const buildSanitizedTaskSnapshot = (snap: OneClickTaskSnapshot): OneClickTaskSnapshot => ({
    ...snap,
    shots: snap.shots.map(s => ({ ...s, imageGenerating: false, videoGenerating: false })),
  });

  // 捕获当前编辑器快照（必须用 shotsRef：异步 pipeline 完成后 React state `shots` 闭包仍可能是执行前的旧数据）
  const captureEditorSnapshot = (): OneClickTaskSnapshot => ({
    shots: shotsRef.current.map((s) => ({ ...s })) as unknown[],
  });

  // 一键成片 UI 触发
  const handleOneClickPipeline = async (skipExport = false) => {
    if (oneClickRunning) { toast.warning('正在执行中，请稍候'); return; }
    const selected = shots.filter(s => s.selected);
    if (selected.length === 0) { toast.error('请先选择要处理的镜头'); return; }
    const taskId = newOneshotTaskId();
    const draftName = buildPipelineDraftName();
    setOneClickRunning(true);
    setOneClickPipelineProgress('准备执行...');
    appendTerminalLog('Pipeline', `一键成片任务 ${taskId} 开始`);
    try {
      // 必须先 flushSync：否则 pipeline 内首个同步阶段的 patchTaskProgress/完成更新会读到「尚未包含本任务」的 prev，导致永远匹配不到 taskId（界面一直执行中、无进度）
      flushSync(() => {
        setOneClickQueueTasks((prev) => {
          const stomped = prev.map((t) =>
            t.type === 'oneshot' && t.status === 'running'
              ? {
                  ...t,
                  status: 'cancelled' as const,
                  completedAt: tsStr(),
                  progressNote: '已由新的一键成片取代',
                  progressPercent: 100,
                }
              : t
          );
          const task: OneClickQueueTask = {
            id: taskId,
            type: 'oneshot',
            status: 'running',
            snapshot: captureEditorSnapshot(),
            createdAt: tsStr(),
            progressPercent: 0,
            progressNote: '准备执行...',
          };
          const tasks = [...stomped, task];
          saveQueueStateAfterMutation(tasks);
          return tasks;
        });
      });
      await executeOneClickPipelineForTargets(selected.map(s => s.id), draftName, taskId, 'oneshot');
    } catch (err: any) {
      appendTerminalLog('Pipeline', `执行异常: ${err.message}`);
      toast.error(`执行异常: ${err.message}`);
    } finally {
      setOneClickRunning(false);
      // 一键成片结束后自动尝试处理挂机队列（无需再手动点「处理队列」）
      queueMicrotask(() => {
        if (!queueRunnerBusyRef.current) {
          void processOneClickQueue();
        }
      });
    }
  };

  // 记录已完成的一键成片任务（用于UI直接触发）
  const recordCompletedOneClickPipeline = (taskId: string, resultSnap: OneClickTaskSnapshot) => {
    setOneClickQueueTasks(prev => {
      const tasks = prev.map(t => t.id === taskId ? { ...t, status: 'completed' as const, completedAt: tsStr(), resultSnapshot: resultSnap } : t);
      saveQueueStateAfterMutation(tasks);
      return tasks;
    });
  };

  // 加入挂机队列
  const handleEnqueueOneClickTask = () => {
    if (queueProcessorRunning) { toast.warning('队列正在执行中，请先停止'); return; }
    const taskId = newQueueTaskId();
    const task: OneClickQueueTask = { id: taskId, type: 'queue', status: 'queued', snapshot: captureEditorSnapshot(), createdAt: tsStr(), progressPercent: 0, progressNote: '等待执行' };
    const tasks = [...oneClickQueueTasksRef.current, task];
    persistQueue(tasks);
    appendTerminalLog('Queue', `任务 ${taskId} 已加入队列`);
    toast.success('已加入挂机队列');
  };

  // 处理挂机队列（执行前将快照写入当前分镜，避免用错「当前编辑器」里的镜头 ID）
  const processOneClickQueue = async () => {
    if (queueRunnerBusyRef.current) return;
    queueRunnerBusyRef.current = true;
    setQueueProcessorRunning(true);
    appendTerminalLog('Queue', '队列处理器启动');
    let shotsBackup: Shot[] | null = null;
    while (true) {
      if (queueGloballyPausedRef.current) {
        appendTerminalLog('Queue', '队列已暂停');
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      const tasks = oneClickQueueTasksRef.current;
      const next = tasks.find(t => t.type === 'queue' && t.status === 'queued');
      if (!next) { appendTerminalLog('Queue', '队列已空，停止'); break; }
      const snapShots = ((next.snapshot?.shots || []) as Shot[]).map(s => ({ ...s }));
      if (snapShots.length === 0) {
        appendTerminalLog('Queue', `任务 ${next.id} 快照无镜头，已跳过`);
        const skipTasks = tasks.map(t =>
          t.id === next.id ? { ...t, status: 'failed' as const, completedAt: tsStr(), progressNote: '快照无镜头' } : t
        );
        persistQueue(skipTasks);
        continue;
      }

      activeQueueTaskIdRef.current = next.id;
      shotsBackup = shots.map(s => ({ ...s }));
      flushSync(() => {
        setShots(snapShots);
      });
      shotsRef.current = snapShots;

      const updatedTasks = tasks.map(t => t.id === next.id ? { ...t, status: 'running' as const, progressNote: '执行中...', progressPercent: 0 } : t);
      persistQueue(updatedTasks);
      appendTerminalLog('Queue', `开始执行任务 ${next.id}（已加载快照 ${snapShots.length} 镜）`);
      try {
        await executeOneClickPipelineForTargets(snapShots.map(s => s.id), buildQueueDraftName(), next.id, 'queue');
      } catch (err: any) {
        appendTerminalLog('Queue', `任务 ${next.id} 执行异常: ${err.message}`);
        const failedTasks = oneClickQueueTasksRef.current.map(t => t.id === next.id ? { ...t, status: 'failed' as const, completedAt: tsStr(), progressNote: `失败: ${err.message}` } : t);
        persistQueue(failedTasks);
      } finally {
        if (shotsBackup) {
          const restore = shotsBackup;
          shotsBackup = null;
          flushSync(() => setShots(restore));
          shotsRef.current = restore;
        }
      }
      activeQueueTaskIdRef.current = null;
    }
    queueRunnerBusyRef.current = false;
    setQueueProcessorRunning(false);
  };

  // 组件加载时不自动读取，避免读取旧数据
  // 用户需要手动点击"获取分镜脚本"按钮来加载最新脚本

  // 视频预览组件（支持缓存）
  const VideoPreview: React.FC<{
    videoUrl: string;
    cachedVideoUrl?: string;
    shotId: string;
  }> = ({ videoUrl, cachedVideoUrl, shotId }) => {
    const [currentVideoUrl, setCurrentVideoUrl] = useState<string>(cachedVideoUrl || videoUrl);
    const [isCaching, setIsCaching] = useState(false);
    const [isCached, setIsCached] = useState(!!cachedVideoUrl);
    
    // 检查并加载缓存
    useEffect(() => {
      const loadCache = async () => {
        // 如果已有缓存URL，直接使用
        if (cachedVideoUrl) {
          setCurrentVideoUrl(cachedVideoUrl);
          setIsCached(true);
          return;
        }
        
        // 检查是否有已缓存的视频
        const cached = getCachedVideoUrl(videoUrl);
        if (cached) {
          setCurrentVideoUrl(cached);
          setIsCached(true);
          updateShot(shotId, { cachedVideoUrl: cached });
          return;
        }
        
        // 自动缓存视频（后台进行，不阻塞UI）
        setIsCaching(true);
        try {
          const cachedUrl = await cacheVideo(videoUrl);
          setCurrentVideoUrl(cachedUrl);
          setIsCached(true);
          updateShot(shotId, { cachedVideoUrl: cachedUrl });
          toast.success('视频已缓存到本地，播放更流畅', 3000);
        } catch (error: any) {
          console.warn('[VideoPreview] 自动缓存失败:', error);
          // 缓存失败时使用原始URL
          setCurrentVideoUrl(videoUrl);
        } finally {
          setIsCaching(false);
        }
      };
      
      loadCache();
    }, [videoUrl, cachedVideoUrl, shotId]);
    
    const handleDownload = async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await downloadVideo(videoUrl, `video_${Date.now()}.mp4`);
        toast.success('视频下载成功', 3000);
      } catch (error: any) {
        toast.error(`下载失败: ${error.message}`, 5000);
      }
    };
    
    return (
      <div 
        className="relative cursor-pointer group"
        onClick={() => setEnlargedVideoUrl(currentVideoUrl)}
      >
        <video
          src={currentVideoUrl}
          className="w-full h-32 object-cover rounded border border-slate-700"
          controls={false}
          preload="auto"
          onMouseEnter={(e) => {
            const video = e.currentTarget;
            video.currentTime = 0;
            video.play().catch(() => {
              // 自动播放失败时静默处理
            });
          }}
          onMouseLeave={(e) => {
            const video = e.currentTarget;
            video.pause();
            video.currentTime = 0;
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-all rounded">
          <div className="bg-black/50 rounded-full p-2 group-hover:bg-black/70 transition-all">
            <Play size={24} className="text-white/90 group-hover:text-white" fill="white" />
          </div>
        </div>
        {/* 缓存状态指示器 */}
        <div className="absolute top-1 right-1 flex gap-1">
          {isCaching && (
            <div className="bg-blue-600/80 text-white text-[8px] px-1.5 py-0.5 rounded flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />
              缓存中
            </div>
          )}
          {isCached && !isCaching && (
            <div className="bg-emerald-600/80 text-white text-[8px] px-1.5 py-0.5 rounded flex items-center gap-1" title="已缓存到本地">
              <HardDrive size={10} />
              已缓存
            </div>
          )}
          <button
            onClick={handleDownload}
            className="bg-slate-800/80 hover:bg-slate-700/80 text-white p-1 rounded transition-all"
            title="下载视频"
          >
            <Download size={12} />
          </button>
        </div>
      </div>
    );
  };

  // 解析脚本文本，提取镜头信息
  const parseScript = (text: string): Shot[] => {
    const lines = text.split('\n');
    const parsedShots: Shot[] = [];
    let currentShot: Partial<Shot> | null = null;
    let currentField: string | null = null;
    let fieldContent: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      
      // 检测镜头开始（兼容：镜头1 / 镜头 1 / Shot 1 / shot-1）
      const shotMatch = trimmedLine.match(/^(?:[#>*\-\s]*)?(?:镜头|shot)\s*[-#:]?\s*(\d+)\b/i);
      if (shotMatch) {
        // 保存上一个镜头的当前字段
        if (currentShot && currentField && fieldContent.length > 0) {
          const content = fieldContent.join('\n').trim();
          if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
          else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
          else if (currentField === 'caption') currentShot.caption = content;
        }
        fieldContent = [];
        currentField = null;
        
        // 保存上一个镜头
        if (currentShot && currentShot.number) {
          parsedShots.push(currentShot as Shot);
        }
        
        // 创建新镜头
        currentShot = {
          id: `shot-${shotMatch[1]}`,
          number: parseInt(shotMatch[1]),
          caption: '',
          imagePrompt: '',
          videoPrompt: '',
          shotType: '',
          voiceOver: '',
          soundEffect: '',
          selected: false,
        };
        continue;
      }
      
      // 如果当前有镜头，解析字段
      if (currentShot) {
        if (/^镜头文案[：:]/.test(trimmedLine)) {
          if (currentField && fieldContent.length > 0) {
            const content = fieldContent.join('\n').trim();
            if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
            else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
            else if (currentField === 'caption') currentShot.caption = content;
          }
          fieldContent = [];
          currentField = 'caption';
          const match = trimmedLine.match(/^镜头文案[：:]\s*(.+)/);
          if (match && match[1]) {
            // 提取引号内的内容
            const captionMatch = match[1].match(/[""「"]([\s\S]*?)[""」"]/);
            if (captionMatch) {
              fieldContent.push(captionMatch[1]);
            } else {
              fieldContent.push(match[1]);
            }
          }
        } else if (/^(?:图片提示词|圖片提示詞)[：:]/.test(trimmedLine)) {
          if (currentField && fieldContent.length > 0) {
            const content = fieldContent.join('\n').trim();
            if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
            else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
            else if (currentField === 'caption') currentShot.caption = content;
          }
          fieldContent = [];
          currentField = 'imagePrompt';
          const match = trimmedLine.match(/^(?:图片提示词|圖片提示詞)[：:]\s*(.+)/);
          if (match && match[1]) fieldContent.push(match[1]);
        } else if (/^(?:视频提示词|视频提示詞)[：:]/.test(trimmedLine)) {
          if (currentField && fieldContent.length > 0) {
            const content = fieldContent.join('\n').trim();
            if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
            else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
            else if (currentField === 'caption') currentShot.caption = content;
          }
          fieldContent = [];
          currentField = 'videoPrompt';
          const match = trimmedLine.match(/^(?:视频提示词|视频提示詞)[：:]\s*(.+)/);
          if (match && match[1]) fieldContent.push(match[1]);
        } else if (/^景别[：:]/.test(trimmedLine) || /^景別[：:]/.test(trimmedLine)) {
          if (currentField && fieldContent.length > 0) {
            const content = fieldContent.join('\n').trim();
            if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
            else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
            else if (currentField === 'caption') currentShot.caption = content;
          }
          fieldContent = [];
          currentField = null;
          const match = trimmedLine.match(/^景别[：:]\s*(.+)/) || trimmedLine.match(/^景別[：:]\s*(.+)/);
          if (match) currentShot.shotType = match[1];
        } else if (/^(?:语音分镜|語音分鏡)[：:]/.test(trimmedLine)) {
          if (currentField && fieldContent.length > 0) {
            const content = fieldContent.join('\n').trim();
            if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
            else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
            else if (currentField === 'caption') currentShot.caption = content;
          }
          fieldContent = [];
          currentField = null;
          const match = trimmedLine.match(/^(?:语音分镜|語音分鏡)[：:]\s*(.+)/);
          if (match) currentShot.voiceOver = match[1];
        } else if (/^音效[：:]/.test(trimmedLine)) {
          if (currentField && fieldContent.length > 0) {
            const content = fieldContent.join('\n').trim();
            if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
            else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
            else if (currentField === 'caption') currentShot.caption = content;
          }
          fieldContent = [];
          currentField = null;
          const match = trimmedLine.match(/^音效[：:]\s*(.+)/);
          if (match) currentShot.soundEffect = match[1];
        } else if (currentField && trimmedLine) {
          fieldContent.push(trimmedLine);
        } else if (!trimmedLine) {
          if (currentField && fieldContent.length > 0) {
            const content = fieldContent.join('\n').trim();
            if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
            else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
            else if (currentField === 'caption') currentShot.caption = content;
          }
          currentField = null;
          fieldContent = [];
        }
      }
    }
    
    // 保存最后一个字段
    if (currentShot && currentField && fieldContent.length > 0) {
      const content = fieldContent.join('\n').trim();
      if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
      else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
      else if (currentField === 'caption') currentShot.caption = content;
    }
    
    // 保存最后一个镜头
    if (currentShot && currentShot.number) {
      parsedShots.push(currentShot as Shot);
    }
    
    return parsedShots.map(normalizeShotVoiceOver);
  };

  // 处理脚本输入
  const handleScriptInput = (text: string) => {
    setScriptText(text);
    lastMediaHistorySignatureRef.current = '';
    lastMediaHistoryIdRef.current = null;
    if (text.trim()) {
      const parsed = parseScript(text);
      setShots(parsed);
      shotsRef.current = parsed;
    } else {
      setShots([]);
      shotsRef.current = [];
    }
  };

  // 处理文件上传
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      appendTerminalLog('Script', `已上传脚本文件: ${file.name}`);
      handleScriptInput(content);
    };
    reader.readAsText(file);
  };

  // 读取「一键动画分镜历史」并显示选择器（与截图1同源）
  const loadScriptFromTools = () => {
    console.log('[MediaGenerator] ========== 打开一键动画分镜历史 ==========');

    const allRecords: HistoryRecord[] = [];

    try {
      const generatorStoryboardKeys = [
        `${NicheType.MINDFUL_PSYCHOLOGY}_mindful_mode2`,
        'mindful_mode2',
      ];
      generatorStoryboardKeys.forEach((key) => {
        const records = getHistory('generator', key);
        console.log(`[MediaGenerator] 从 generator/${key} 读取到 ${records.length} 条记录`);
        allRecords.push(
          ...records
            .filter((r) => typeof r.content === 'string' && r.content.trim())
            .map((r) => ({
              ...r,
              metadata: {
                ...r.metadata,
                topic: r.metadata?.topic || `一键动画分镜历史 · ${key}`,
                historyDelete: { module: 'generator' as const, key },
              },
            }))
        );
      });
    } catch (error) {
      console.error('[MediaGenerator] 读取一键动画分镜历史失败:', error);
    }

    allRecords.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const uniqueRecords: HistoryRecord[] = [];
    const seen = new Set<string>();
    allRecords.forEach((record) => {
      const raw = typeof record.content === 'string' ? record.content.trim() : '';
      if (!raw) return;
      const key = `${record.timestamp || 0}|${record.metadata?.topic || ''}|${raw}`;
      if (seen.has(key)) return;
      seen.add(key);
      uniqueRecords.push(record);
    });

    if (uniqueRecords.length > 0) {
      appendTerminalLog('Script', `打开一键动画分镜历史，共 ${uniqueRecords.length} 条候选`);
      setHistorySelectorKind('script');
      setScriptHistoryRecords(uniqueRecords);
      setShowScriptHistorySelector(true);
    } else {
      appendTerminalLog('Script', '未找到一键动画分镜历史');
      toast.warning('未找到一键动画分镜历史记录。');
    }
  };
  
  /** 媒体生成历史（仅含已生成图/音/视频的快照） */
  const handleMediaHistorySelect = (record: HistoryRecord) => {
    const pid = record.metadata?.mediaProjectId as string | undefined;
    if (!pid) {
      toast.error('无效的历史记录');
      return;
    }
    const project = getMediaProject(pid);
    if (!project) {
      toast.error('记录不存在或已删除');
      return;
    }
    const rows = Array.isArray(project.shots) ? project.shots : [];
    const restored = restoredShotsFromProject(rows);
    const st = typeof project.scriptText === 'string' ? project.scriptText : '';
    setScriptText(st);
    scriptTextRef.current = st;
    setShots(restored);
    shotsRef.current = restored;
    lastMediaHistorySignatureRef.current = computeMediaHistoryFingerprint(shotsToPersistPayloadFromShots(restored));
    lastMediaHistoryIdRef.current = pid;
    setShowScriptInput(true);
    setShowScriptHistorySelector(false);
    setHistorySelectorKind(null);
    appendTerminalLog('History', `已载入媒体历史 ${pid}（${restored.length} 镜），并展开脚本输入区`);
    toast.success(`已载入 ${pid}`, 3000);
  };

  /** 脚本历史与媒体历史共用弹窗：有 mediaProjectId 则恢复快照，否则按脚本正文解析分镜 */
  const handleHistorySelectorSelect = (record: HistoryRecord) => {
    const pid = record.metadata?.mediaProjectId as string | undefined;
    if (pid) {
      handleMediaHistorySelect(record);
      return;
    }
    const text = typeof record.content === 'string' ? record.content : '';
    if (!text.trim()) {
      toast.error('该条记录没有可载入的脚本内容');
      return;
    }
    lastMediaHistorySignatureRef.current = '';
    handleScriptInput(text);
    setShowScriptInput(true);
    setShowScriptHistorySelector(false);
    setHistorySelectorKind(null);
    appendTerminalLog('Script', '已从选择器载入改写工具脚本并展开脚本输入区');
    toast.success('已载入脚本', 3000);
  };

  const openMediaHistorySelector = () => {
    const projects = listMediaProjects();
    const records: HistoryRecord[] = projects.map((p) => {
      const preview = p.preview != null && String(p.preview).trim() !== '' ? String(p.preview) : '';
      const scriptExcerpt = String(p.scriptText ?? '').slice(0, 160);
      const thumbUrl = firstPersistedShotPreviewImageUrl(p);
      const isUpdated = p.updatedAt !== p.createdAt;
      const dateStr = new Date(p.updatedAt).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const topicLabel = isUpdated ? `${p.id} · ${dateStr}` : p.id;
      return {
        timestamp: typeof p.updatedAt === 'number' ? p.updatedAt : p.createdAt ?? Date.now(),
        content: preview || scriptExcerpt || '（无摘要）',
        metadata: { topic: topicLabel, mediaProjectId: p.id, thumbUrl, isUpdated },
      };
    });
    setHistorySelectorKind('media');
    setScriptHistoryRecords(records);
    setShowScriptHistorySelector(true);
    if (records.length === 0) {
      toast.info('暂无记录。生成图片、配音或视频后会自动记入历史。', 4500);
    }
  };

  const historyRecordRowMatch = (a: HistoryRecord, b: HistoryRecord) =>
    a.timestamp === b.timestamp && a.content === b.content;

  const persistDeleteHistoryRecord = (record: HistoryRecord) => {
    const pid = record.metadata?.mediaProjectId as string | undefined;
    if (pid) {
      deleteMediaProject(pid.trim());
      return;
    }
    const hd = record.metadata?.historyDelete as
      | { module: 'tools' | 'generator'; key: string }
      | { kind: 'legacyScriptHistory' }
      | { kind: 'lastGeneratedScript' }
      | undefined;
    if (hd && 'module' in hd && (hd.module === 'tools' || hd.module === 'generator') && hd.key) {
      deleteHistory(hd.module, hd.key, record.timestamp);
      return;
    }
    if (hd && 'kind' in hd && hd.kind === 'legacyScriptHistory') {
      deleteScriptHistoryLegacyItem(record.timestamp);
      return;
    }
    if (hd && 'kind' in hd && hd.kind === 'lastGeneratedScript') {
      removeLastGeneratedScriptIfContentEquals(record.content);
    }
  };

  const persistClearAllHistoryRecords = () => {
    if (historySelectorKind === 'media') {
      clearAllMediaProjects();
      return;
    }
    const historyKeys = new Set<string>([
      `${ToolMode.SCRIPT}_GLOBAL`,
      `${ToolMode.SCRIPT}_global`,
    ]);
    const niches = [
      NicheType.YI_JING_METAPHYSICS,
      NicheType.TCM_METAPHYSICS,
      NicheType.FINANCE_CRYPTO,
      NicheType.STORY_REVENGE,
      NicheType.GENERAL_VIRAL,
      NicheType.PSYCHOLOGY,
      NicheType.PHILOSOPHY_WISDOM,
      NicheType.EMOTION_TABOO,
      NicheType.RICH_MINDSET,
      NicheType.MINDFUL_PSYCHOLOGY,
    ];
    niches.forEach((niche) => historyKeys.add(`${ToolMode.SCRIPT}_${niche}`));
    historyKeys.forEach((key) => clearHistory('tools', key));
    clearScriptHistoryLegacy();
    clearLastGeneratedScript();
  };

  const MEDIA_HISTORY_TRIGGER_KEYS: (keyof Shot)[] = [
    'imageUrls',
    'videoUrl',
    'videoUrls',
    'voiceAudioUrl',
    'audioDurationSec',
    'cachedVideoUrl',
    'cachedVideoUrls',
  ];

  // 更新镜头数据：主工作区可改；一键成片/队列执行中（activeQueueTaskIdRef 已置位）也必须写入，否则闭包外 pipeline 无法落盘 resultSnapshot
  const updateShot = (shotId: string, updates: Partial<Shot>) => {
    // 仅在以下情况写入：主工作区，或一键成片/队列执行中（activeQueueTaskIdRef 非 null）
    const isOnMain = activeWorkspaceTabIdRef.current === 'main';
    const isPipelineActive = activeQueueTaskIdRef.current != null;
    if (isOnMain === false && isPipelineActive === false) return;
    // 必须先同步更新 shotsRef：每轮 render 会把 shotsRef.current = shots，若 setState 尚未提交，中间若发生重绘会回滚 ref（导出读到无配音）。
    const next = shotsRef.current.map((shot) => (shot.id === shotId ? { ...shot, ...updates } : shot));
    shotsRef.current = next;
    if (isPipelineActive) {
      flushSync(() => setShots(next));
    } else {
      setShots(next);
    }
    if (MEDIA_HISTORY_TRIGGER_KEYS.some((k) => k in updates)) {
      scheduleMediaHistorySave();
    }
  };

  // 添加新镜头
  const handleAddShot = () => {
    const newShot: Shot = {
      id: `shot-${Date.now()}`,
      number: shots.length + 1,
      caption: '',
      imagePrompt: '',
      videoPrompt: '',
      shotType: '',
      voiceOver: '',
      soundEffect: '',
      selected: false,
      editing: true,
    };
    const next = [...shots, newShot];
    setShots(next);
    shotsRef.current = next;
    setEditingShotId(newShot.id);
    appendTerminalLog('Shot', `添加镜头，当前共 ${next.length} 镜`);
  };

  // 删除选中镜头
  const handleDeleteSelected = () => {
    const selectedShots = shots.filter(s => s.selected);
    if (selectedShots.length === 0) {
      toast.warning('请先选择要删除的镜头');
      return;
    }
    if (confirm(`确定要删除 ${selectedShots.length} 个镜头吗？`)) {
      const next = shots.filter(s => !s.selected);
      setShots(next);
      shotsRef.current = next;
      appendTerminalLog('Shot', `已删除 ${selectedShots.length} 个镜头，剩余 ${next.length} 镜`);
    }
  };

  // 批量选择功能
  const handleSelectAll = () => {
    setShots(prev => {
      const next = prev.map(shot => ({ ...shot, selected: true }));
      shotsRef.current = next;
      return next;
    });
    appendTerminalLog('UI', '全选镜头');
  };

  const handleDeselectAll = () => {
    setShots(prev => {
      const next = prev.map(shot => ({ ...shot, selected: false }));
      shotsRef.current = next;
      return next;
    });
    appendTerminalLog('UI', '取消全选');
  };

  const handleToggleSelect = () => {
    setShots(prev => {
      const next = prev.map(shot => ({ ...shot, selected: !shot.selected }));
      shotsRef.current = next;
      return next;
    });
    appendTerminalLog('UI', '反选镜头');
  };

  // 批量导出图片为 ZIP
  const handleExportImagesAsZip = async () => {
    const selectedShots = shots.filter(s => s.selected && s.imageUrls && s.imageUrls.length > 0);
    
    if (selectedShots.length === 0) {
      toast.warning('请先选择包含图片的镜头');
      return;
    }
    
    try {
      const zip = new JSZip();
      let imageCount = 0;

      // 下载并添加每张图片到 ZIP
      for (const shot of selectedShots) {
        if (!shot.imageUrls || shot.imageUrls.length === 0) continue;

        for (let i = 0; i < shot.imageUrls.length; i++) {
          const imageUrl = shot.imageUrls[i];
          try {
            // 获取图片数据
            const response = await fetch(imageUrl);
            if (!response.ok) {
              console.warn(`无法下载图片: ${imageUrl}`);
              continue;
            }

            const blob = await response.blob();
            
            // 确定文件扩展名
            const contentType = response.headers.get('content-type') || 'image/png';
            let extension = 'png';
            if (contentType.includes('jpeg') || contentType.includes('jpg')) {
              extension = 'jpg';
            } else if (contentType.includes('webp')) {
              extension = 'webp';
            } else if (contentType.includes('gif')) {
              extension = 'gif';
            }

            // 如果是 data URL，需要特殊处理
            if (imageUrl.startsWith('data:')) {
              const base64Match = imageUrl.match(/data:([^;]+);base64,(.+)/);
              if (base64Match) {
                const mimeType = base64Match[1];
                const base64Data = base64Match[2];
                extension = mimeType.includes('jpeg') ? 'jpg' : 
                           mimeType.includes('png') ? 'png' : 
                           mimeType.includes('webp') ? 'webp' : 
                           mimeType.includes('gif') ? 'gif' : 'png';
                
                zip.file(`镜头${shot.number}_图片${i + 1}.${extension}`, base64Data, { base64: true });
              } else {
                // 如果 data URL 格式不正确，尝试直接使用 blob
                zip.file(`镜头${shot.number}_图片${i + 1}.${extension}`, blob);
              }
            } else {
              // 普通 URL，使用 blob
              const fileName = `镜头${shot.number}_图片${i + 1}.${extension}`;
              zip.file(fileName, blob);
            }

            imageCount++;
          } catch (error) {
            console.error(`下载图片失败 (镜头${shot.number}, 图片${i + 1}):`, error);
          }
        }
      }

      if (imageCount === 0) {
        toast.warning('没有可导出的图片');
        return;
      }

      // 生成 ZIP 文件并下载
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `镜头图片_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    URL.revokeObjectURL(url);

      toast.success(`成功导出 ${imageCount} 张图片到 ZIP 文件`);
    } catch (error: any) {
      console.error('导出 ZIP 失败:', error);
      toast.error(`导出失败: ${error.message || '未知错误'}`);
    }
  };

  // 保存编辑
  const handleSaveEdit = (shotId: string) => {
    setEditingShotId(null);
    updateShot(shotId, { editing: false });
  };

  // 获取适合模型的尺寸（DALL-E 3 和 Sora Image 有特殊限制）
  const getImageSize = (model: string, ratioId: string): string => {
    const selectedRatio = IMAGE_RATIOS.find(r => r.id === ratioId);
    if (!selectedRatio) return '1024x1024';
    
    // DALL-E 3 只支持特定尺寸
    if (model === 'dall-e-3') {
      if (selectedRatio.dallE3Supported) {
        return `${selectedRatio.width}x${selectedRatio.height}`;
      } else {
        // 如果不支持，根据比例选择最接近的 DALL-E 3 支持的尺寸
        const aspectRatio = selectedRatio.width / selectedRatio.height;
        if (aspectRatio > 1) {
          // 横屏，使用 1792x1024
          return '1792x1024';
        } else if (aspectRatio < 1) {
          // 竖屏，使用 1024x1792
          return '1024x1792';
        } else {
          // 正方形，使用 1024x1024
          return '1024x1024';
        }
      }
    }
    
    // Sora Image 支持任意比例，使用原始尺寸（比例会在提示词中添加）
    if (model === 'sora-image') {
      // 返回比例格式，用于在提示词中添加【比例】
      return `${selectedRatio.width}x${selectedRatio.height}`;
    }
    
    // 其他模型使用原始尺寸
    return `${selectedRatio.width}x${selectedRatio.height}`;
  };

  // 生成单个图片（支持生成多张）；返回是否成功（避免依赖 React setState 延迟闭包误判）
  const handleGenerateImage = async (shot: Shot, regenerate: boolean = false): Promise<boolean> => {
    // 检查选中的模型
    const selectedModel = IMAGE_MODELS.find(m => m.id === selectedImageModel);
    
    // 检查 API Key 配置
    if (selectedModel?.isJimeng) {
      if (!jimengSessionId || jimengSessionId.trim() === '') {
        appendTerminalLog('ImageGen', `镜头${shot.number}: 已中止 — 未配置即梦 SESSION_ID`);
        alert('请先配置即梦 SESSION_ID');
        return;
      }
    } else if (selectedModel?.isRunningHub) {
      if (provider !== 'runninghub' || !apiKey || apiKey.trim() === '') {
        appendTerminalLog('ImageGen', `镜头${shot.number}: 已中止 — 未配置 RunningHub（顶部需选 RunningHub 并填 Key）`);
        alert('请先在顶部配置 RunningHub API Key（选择 RunningHub 服务）');
        return;
      }
    } else {
      if (!apiKey) {
        appendTerminalLog('ImageGen', `镜头${shot.number}: 已中止 — 未配置 API Key`);
        alert('请先配置 API Key');
        return;
      }
    }
    
    if (!shot.imagePrompt) {
      appendTerminalLog('ImageGen', `镜头${shot.number}: 已跳过 — 无图片提示词`);
      toast.warning('该镜头没有图片提示词');
      return;
    }
    
    appendTerminalLog(
      'ImageGen',
      `镜头${shot.number}: ${regenerate ? '重新绘图' : '生成图片'} · 模型=${selectedImageModel} · 张数=${generateImageCount}`
    );
    updateShot(shot.id, { imageGenerating: true });
    
    const selectedRatio = IMAGE_RATIOS.find(r => r.id === selectedImageRatio);
    const selectedStyleObj = STYLE_LIBRARY.find(s => s.id === selectedStyle);
    
    // 组合提示词（添加风格）
    let finalPrompt = shot.imagePrompt;
    if (selectedStyleObj && selectedStyleObj.prompt) {
      finalPrompt = `${finalPrompt}, ${selectedStyleObj.prompt}`;
    }
    
    // 以「图片提示词」匹配角色名/别名；参考图随所有生图模型传递
    const matchedCharacters = detectCharactersInPrompt(shot.imagePrompt || '');
    const primaryChar =
      matchedCharacters.length > 0
        ? pickPrimaryCharacterForPrompt(finalPrompt, matchedCharacters)
        : null;
    const charRefYunwu: Partial<ImageGenerationOptions> = primaryChar
      ? { referenceDataUrls: [primaryChar.imageUrl], characterName: primaryChar.name }
      : {};

    if (primaryChar) {
      toast.info(`角色参考：${primaryChar.name}（已随当前模型参与生图）`, 5000);
    }
    
    // 获取适合模型的尺寸
    const imageSize = getImageSize(selectedImageModel, selectedImageRatio);
    
    try {
      let newImageUrls: string[] = [];
      
      // RunningHub 模型处理
      if (selectedModel?.isRunningHub) {
        const selectedRatio = IMAGE_RATIOS.find(r => r.id === selectedImageRatio);
        const width = selectedRatio?.width || 1024;
        const height = selectedRatio?.height || 1024;
        
        // 构建生成选项
        const generationOptions: RunningHubImageOptions = {
          prompt: finalPrompt,
          model: selectedModel.runningHubModel as 'flux' | 'z-image' | 'qwen-image',
          width,
          height,
          num_images: generateImageCount,
        };
        
        if (primaryChar) {
          generationOptions.image_url = primaryChar.imageUrl;
        }
        
        // 生成多张图片
        if (generateImageCount > 1) {
          for (let i = 0; i < generateImageCount; i++) {
            const result = await generateRunningHubImage(apiKey, {
              ...generationOptions,
              num_images: 1, // 每次生成1张
            });
            
            if (result.success) {
              if (result.url) {
                newImageUrls.push(result.url);
              } else if (result.urls && result.urls.length > 0) {
                newImageUrls.push(...result.urls);
              }
            } else {
              console.warn(`第 ${i + 1} 张图片生成失败:`, result.error);
            }
            
            // 延迟避免API限流
            if (i < generateImageCount - 1) {
              await new Promise(resolve => setTimeout(resolve, 1500));
            }
          }
        } else {
          const result = await generateRunningHubImage(apiKey, generationOptions);
          
          if (result.success) {
            if (result.url) {
              newImageUrls = [result.url];
            } else if (result.urls && result.urls.length > 0) {
              newImageUrls = result.urls;
            } else {
              appendTerminalLog('ImageGen', `镜头${shot.number}: RunningHub 返回成功但未解析到图片 URL`);
              toast.error('图片生成成功但未获取到图片URL');
              updateShot(shot.id, { imageGenerating: false });
              return;
            }
            toast.success(`成功生成 ${newImageUrls.length} 张图片！`, 8000);
          } else {
            const errorMsg = result.error || 'RunningHub 图片生成失败';
            appendTerminalLog('ImageGen', `镜头${shot.number}: RunningHub 失败 — ${errorMsg}`);
            updateShot(shot.id, { imageGenerating: false });
            throw new Error(errorMsg);
          }
        }
      }
      // 即梦模型特殊处理
      else if (selectedModel?.isJimeng) {
        // 使用即梦API生成图片
        const selectedRatio = IMAGE_RATIOS.find(r => r.id === selectedImageRatio);
        const width = selectedRatio?.width || 1080;
        const height = selectedRatio?.height || 1920;
        
        // 构建生成选项
        const generationOptions: any = {
          prompt: finalPrompt,
          num_images: generateImageCount,
          width,
          height,
          model: selectedModel.jimengModel || 'jimeng-5.0'
        };
        
        if (primaryChar) {
          generationOptions.images = [primaryChar.imageUrl];
          generationOptions.sample_strength = 0.7;
        }
        
        const result = await generateJimengImages(
          generationOptions,
          { sessionId: jimengSessionId }
        );
        
        if (result.success && result.data) {
          newImageUrls = result.data.map(item => item.url);
          appendTerminalLog('ImageGen', `镜头${shot.number}: 即梦完成，${newImageUrls.length} 张`);
          toast.success(`成功生成 ${newImageUrls.length} 张图片！`, 8000);
        } else {
          const errorMsg = result.error || '即梦图片生成失败';
          appendTerminalLog('ImageGen', `镜头${shot.number}: 即梦失败 — ${errorMsg}`);
          updateShot(shot.id, { imageGenerating: false });
          throw new Error(errorMsg);
        }
      } else {
        // 原有的yunwu.ai模型处理逻辑
        // sora-image、grok-3-image、grok-4-image 使用 chat/completions，不支持 n 参数，需要多次调用来生成多张图片
        const chatCompletionsModels = ['sora-image', 'grok-3-image', 'grok-4-image'];
      if (chatCompletionsModels.includes(selectedImageModel) && generateImageCount > 1) {
        // 多次调用生成多张图片（这些模型不支持 n 参数）
        for (let i = 0; i < generateImageCount; i++) {
    const options: ImageGenerationOptions = {
      model: selectedImageModel,
      prompt: finalPrompt,
            size: imageSize,
      quality: 'standard',
            ...charRefYunwu,
            // 注意：这些模型不支持 n 参数，所以不传
    };
    
    const result = await generateImage(apiKey, options);
    
    if (result.success && result.url) {
            newImageUrls.push(result.url);
          } else if (result.success && result.data?.data && Array.isArray(result.data.data)) {
            // 处理多张图片的情况（grok 可能一次返回多张）
            const urls = result.data.data.map((item: any) => item.url || item).filter(Boolean);
            newImageUrls.push(...urls);
    } else {
            console.warn(`第 ${i + 1} 张图片生成失败:`, result.error);
          }
          
          // 延迟避免API限流
          if (i < generateImageCount - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // 增加到2秒延迟
          }
        }
      } else if (chatCompletionsModels.includes(selectedImageModel)) {
        // 单张图片，也不传 n 参数
        const options: ImageGenerationOptions = {
          model: selectedImageModel,
          prompt: finalPrompt,
          size: imageSize,
          quality: 'standard',
          ...charRefYunwu,
          // 注意：这些模型不支持 n 参数
        };
        
        const result = await generateImage(apiKey, options);
        
        if (result.success) {
          if (result.url) {
            newImageUrls = [result.url];
          } else if (result.data?.data && Array.isArray(result.data.data)) {
            newImageUrls = result.data.data.map((item: any) => openAiImageDataItemToUrl(item)).filter(Boolean) as string[];
          }
        } else {
          const errorMsg = `图片生成失败: ${result.error || '未知错误'}`;
          updateShot(shot.id, { imageGenerating: false });
          throw new Error(errorMsg);
        }
      } else {
        // 其他模型：如果生成多张，需要多次调用（因为某些模型可能不支持 n 参数或支持有限）
        if (generateImageCount > 1) {
          // 多次调用生成多张图片
          for (let i = 0; i < generateImageCount; i++) {
            const options: ImageGenerationOptions = {
              model: selectedImageModel,
              prompt: finalPrompt,
              size: imageSize,
              quality: 'standard',
              n: 1, // 每次只生成1张，通过多次调用来生成多张
              ...charRefYunwu,
            };
            
            const result = await generateImage(apiKey, options);
            
            if (result.success) {
              // 处理单张图片的情况
              if (result.url) {
                newImageUrls.push(result.url);
              } else if (result.data?.data && Array.isArray(result.data.data) && result.data.data.length > 0) {
                // OpenAI 格式：data.data 是数组
                const urls = result.data.data.map((item: any) => openAiImageDataItemToUrl(item)).filter(Boolean) as string[];
                newImageUrls.push(...urls);
              } else if (result.data?.images && Array.isArray(result.data.images) && result.data.images.length > 0) {
                // 其他格式：images 数组
                const urls = result.data.images.map((item: any) => item.url || item).filter(Boolean);
                newImageUrls.push(...urls);
              }
            } else {
              console.warn(`第 ${i + 1} 张图片生成失败:`, result.error);
            }
            
            // 延迟避免API限流
            if (i < generateImageCount - 1) {
              await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5秒延迟
            }
          }
        } else {
          // 单张图片，正常调用
          const options: ImageGenerationOptions = {
            model: selectedImageModel,
            prompt: finalPrompt,
            size: imageSize,
            quality: 'standard',
            n: 1,
            ...charRefYunwu,
          };
          
          const result = await generateImage(apiKey, options);
          
          if (result.success) {
            // 处理单张图片的情况
            if (result.url) {
              newImageUrls = [result.url];
            } else if (result.data?.data && Array.isArray(result.data.data) && result.data.data.length > 0) {
              // OpenAI 格式：data.data 是数组
              newImageUrls = result.data.data.map((item: any) => openAiImageDataItemToUrl(item)).filter(Boolean) as string[];
            } else if (result.data?.images && Array.isArray(result.data.images) && result.data.images.length > 0) {
              // 其他格式：images 数组
              newImageUrls = result.data.images.map((item: any) => item.url || item).filter(Boolean);
            }
          } else {
            const errorMsg = `图片生成失败: ${result.error || '未知错误'}`;
            updateShot(shot.id, { imageGenerating: false });
            throw new Error(errorMsg);
          }
        }
      }
      } // 结束 else 块（即梦模型处理）
      
      if (newImageUrls.length > 0) {
        // 重新绘图时也追加图片，不覆盖原有图片
        const currentUrls = shot.imageUrls || [];
        const updatedUrls = [...currentUrls, ...newImageUrls]; // 始终追加，不替换

        // 自动选中新生成的第一张图片
        let selectedIndex: number;
        if (currentUrls.length === 0) {
          // 之前没有图片，选中新生成的第一张（索引0）
          selectedIndex = 0;
        } else {
          // 之前有图片，选中新生成的第一张（即 currentUrls.length，因为新图片是追加的）
          selectedIndex = currentUrls.length;
        }

        updateShot(shot.id, {
          imageUrls: updatedUrls,
          selectedImageIndex: selectedIndex,
          imageGenerating: false
        });
        appendTerminalLog('ImageGen', `镜头${shot.number}: 完成，当前共 ${updatedUrls.length} 张图`);
        return true;
      } else {
        const errorMsg = '图片生成成功但未获取到图片URL';
        appendTerminalLog('ImageGen', `镜头${shot.number}: 失败 — ${errorMsg}`);
        updateShot(shot.id, { imageGenerating: false });
        return false;
      }
    } catch (error: any) {
      // 确保 imageGenerating 状态被清除
      updateShot(shot.id, { imageGenerating: false });
      appendTerminalLog('ImageGen', `镜头${shot.number}: 异常 — ${error?.message || error}`);
      return false;
    }
  };

  // 辅助函数：追加视频URL到镜头（支持追加模式）
  const appendVideoToShot = (shotId: string, videoUrl: string, cachedUrl?: string) => {
    const shot = shotsRef.current.find(s => s.id === shotId);
    if (!shot) return;
    
    // 追加模式：保留原有视频，添加新视频
    const currentVideoUrls = shot.videoUrls || (shot.videoUrl ? [shot.videoUrl] : []);
    const currentCachedUrls = shot.cachedVideoUrls || (shot.cachedVideoUrl ? [shot.cachedVideoUrl] : []);
    const updatedVideoUrls = [...currentVideoUrls, videoUrl];
    const updatedCachedUrls = cachedUrl ? [...currentCachedUrls, cachedUrl] : currentCachedUrls;
    
    updateShot(shotId, {
      videoUrl: videoUrl, // 保留向后兼容，显示最新的视频
      videoUrls: updatedVideoUrls, // 追加到数组
      cachedVideoUrl: cachedUrl || shot.cachedVideoUrl, // 保留向后兼容
      cachedVideoUrls: updatedCachedUrls, // 追加到数组
      videoGenerating: false
    });
    appendTerminalLog('VideoGen', `镜头${shot.number}: 已写入视频（共 ${updatedVideoUrls.length} 段）`);
    return updatedVideoUrls.length;
  };

  // RunningHub 任务状态轮询（返回 Promise，await 可等待视频真正生成完毕）
  const pollRunningHubTaskStatus = async (
    taskId: string,
    shotId: string,
    maxAttempts: number = 180,
    onHubProgress?: (percent: number) => void
  ): Promise<void> => {
    let attempts = 0;
    let lastProgress = 0;
    let lastStatus = '';
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5;
    const shotLabel = () => {
      const n = shotsRef.current.find(s => s.id === shotId)?.number;
      return n != null ? `镜头${n}` : `shotId=${shotId.slice(0, 8)}…`;
    };

    appendTerminalLog('VideoGen', `${shotLabel()}: 轮询任务 ${taskId}（最多 ${maxAttempts} 次）`);

    while (attempts < maxAttempts) {
      attempts++;

      if (attempts > maxAttempts) {
        // 超时前最后一次查询
        console.log(`[MediaGenerator] RunningHub 轮询超时，进行最后一次查询: taskId=${taskId}`);
        try {
          const finalResult = await checkRunningHubTaskStatus(runningHubApiKey, taskId);
          if (finalResult.success && finalResult.url) {
            try {
              toast.info('视频生成成功，正在缓存视频...', 3000);
              const cachedUrl = await cacheVideo(finalResult.url);
              const totalCount = appendVideoToShot(shotId, finalResult.url, cachedUrl);
              toast.success(`视频生成成功并已缓存！（共 ${totalCount} 个视频）`, 8000);
            } catch (cacheError: any) {
              console.warn('[MediaGenerator] 视频缓存失败:', cacheError);
              const totalCount = appendVideoToShot(shotId, finalResult.url);
              toast.success(`视频生成成功！（共 ${totalCount} 个视频）`, 8000);
            }
            appendTerminalLog('VideoGen', `${shotLabel()}: 超时前最后一次查询成功，已落盘`);
            onHubProgress?.(100);
            return;
          }
        } catch (error) {
          console.error('[MediaGenerator] 最后一次查询失败:', error);
        }

        appendTerminalLog('VideoGen', `${shotLabel()}: 轮询超时（${maxAttempts} 次）taskId=${taskId} 状态=${lastStatus || '未知'}`);
        toast.warning(
          `视频生成超时（已轮询 ${maxAttempts} 次），但任务可能仍在后台处理中。\n\n` +
          `任务ID: ${taskId}\n` +
          `最后状态: ${lastStatus || '未知'}\n` +
          `最后进度: ${lastProgress}%\n\n` +
          `请稍后手动刷新或重新查询任务状态。`,
          12000
        );
        updateShot(shotId, { videoGenerating: false });
        return;
      }

      try {
        const result = await checkRunningHubTaskStatus(runningHubApiKey, taskId);
        consecutiveErrors = 0;

        if (result.success) {
          lastStatus = result.status || '';
          lastProgress = result.progress || 0;
          onHubProgress?.(lastProgress);
          if (attempts === 1 || attempts % 12 === 0) {
            appendTerminalLog('VideoGen', `${shotLabel()}: 查询 #${attempts} · ${lastStatus || '进行中'} · 进度 ${lastProgress}%`);
          }

          console.log(`[MediaGenerator] RunningHub 任务 ${taskId} 状态: ${result.status}, 进度: ${result.progress}%`);

          // 检查是否有视频URL
          let videoUrl = result.url || (result as any).videoUrl;

          if (!videoUrl && result.data) {
            const data = result.data;
            const files = data.files || data.outputs || [];

            const videoFiles = files.filter((f: any) =>
              f.url?.includes('.mp4') ||
              f.fileName?.includes('.mp4') ||
              f.outputType === 'mp4' ||
              f.type === 'video/mp4'
            );

            if (videoFiles.length > 0) {
              videoUrl = videoFiles[0].url || videoFiles[0].fileUrl || videoFiles[0].fileName;
              if (videoFiles.length > 1) {
                console.warn(`[MediaGenerator] RunningHub 返回了 ${videoFiles.length} 个视频，但只使用第一个:`, videoUrl);
              }
            } else if (files.length > 0) {
              videoUrl = files[0].url || files[0].fileUrl || files[0].fileName;
            }

            if (!videoUrl) {
              videoUrl = data.videoUrl || data.video_url || data.url || data.outputUrl;
            }
          }

          if (videoUrl) {
            try {
              toast.info('视频生成成功，正在缓存视频...', 3000);
              const cachedUrl = await cacheVideo(videoUrl);
              const totalCount = appendVideoToShot(shotId, videoUrl, cachedUrl);
              toast.success(`视频生成成功并已缓存！（共 ${totalCount} 个视频）`, 8000);
            } catch (cacheError: any) {
              console.warn('[MediaGenerator] 视频缓存失败:', cacheError);
              const totalCount = appendVideoToShot(shotId, videoUrl);
              toast.success(`视频生成成功！（共 ${totalCount} 个视频）`, 8000);
            }
            onHubProgress?.(100);
            return;
          } else if (result.status === 'SUCCESS' || result.status === 'completed' || result.status === 'success') {
            // 状态完成但无URL，尝试从data中提取
            if (result.data) {
              const data = result.data;
              const files = data.files || data.outputs || [];

              const videoFiles = files.filter((f: any) =>
                f.url?.includes('.mp4') ||
                f.fileName?.includes('.mp4') ||
                f.outputType === 'mp4'
              );

              let extractedUrl: string | undefined;
              if (videoFiles.length > 0) {
                extractedUrl = videoFiles[0].url || videoFiles[0].fileUrl || videoFiles[0].fileName;
                if (videoFiles.length > 1) {
                  console.warn(`[MediaGenerator] RunningHub 返回了 ${videoFiles.length} 个视频，但只使用第一个`);
                }
              } else if (files.length > 0) {
                extractedUrl = files[0].url || files[0].fileUrl || files[0].fileName;
              }

              if (!extractedUrl) {
                extractedUrl = data.videoUrl || data.video_url || data.url;
              }

              if (extractedUrl) {
                console.log('[MediaGenerator] 从data中提取到视频URL:', extractedUrl);
                try {
                  toast.info('视频生成成功，正在缓存视频...', 3000);
                  const cachedUrl = await cacheVideo(extractedUrl);
                  const totalCount = appendVideoToShot(shotId, extractedUrl, cachedUrl);
                  toast.success(`视频生成成功并已缓存！（共 ${totalCount} 个视频）`, 8000);
                } catch (cacheError: any) {
                  console.warn('[MediaGenerator] 视频缓存失败:', cacheError);
                  const totalCount = appendVideoToShot(shotId, extractedUrl);
                  toast.success(`视频生成成功！（共 ${totalCount} 个视频）`, 8000);
                }
                onHubProgress?.(100);
                return;
              }
            }
            // 状态完成但无URL，继续轮询（可能URL还在生成中）
            console.log('[MediaGenerator] 任务状态为SUCCESS但无URL，继续轮询获取URL');
            await new Promise(r => setTimeout(r, 5000));
          } else if (result.status === 'FAILED' || result.status === 'failed' || result.status === 'error') {
            appendTerminalLog('VideoGen', `${shotLabel()}: 任务失败 — ${result.error || '未知错误'}`);
            toast.error(`视频生成失败: ${result.error || '未知错误'}`, 6000);
            updateShot(shotId, { videoGenerating: false });
            return;
          } else {
            const progress = result.progress || 0;
            let pollInterval = 5000;

            if (progress >= 90) {
              pollInterval = 3000;
            } else if (progress >= 50) {
              pollInterval = 4000;
            }

            await new Promise(r => setTimeout(r, pollInterval));
          }
        } else {
          consecutiveErrors++;
          if (consecutiveErrors >= maxConsecutiveErrors) {
            appendTerminalLog('VideoGen', `${shotLabel()}: 连续 ${maxConsecutiveErrors} 次查询失败 — ${result.error || ''}`);
            toast.error(`连续 ${maxConsecutiveErrors} 次查询失败，请检查网络连接或API配置`, 8000);
            updateShot(shotId, { videoGenerating: false });
            return;
          }
          console.warn(`[MediaGenerator] RunningHub 查询任务状态失败 (${consecutiveErrors}/${maxConsecutiveErrors}):`, result.error);
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch (error: any) {
        consecutiveErrors++;
        console.error(`[MediaGenerator] RunningHub 轮询任务状态异常 (${consecutiveErrors}/${maxConsecutiveErrors}):`, error);

        if (consecutiveErrors >= maxConsecutiveErrors) {
          appendTerminalLog('VideoGen', `${shotLabel()}: 轮询异常终止 — ${error?.message || error}`);
          toast.error(`连续 ${maxConsecutiveErrors} 次异常，请检查网络连接`, 8000);
          updateShot(shotId, { videoGenerating: false });
          return;
        }

        await new Promise(r => setTimeout(r, 5000));
      }
    }
  };

  /** 轮询 RunningHub 任务直至拿到产出 URL（视频/音频） */
  const pollRunningHubForMediaUrl = async (taskId: string, maxAttempts = 120): Promise<string> => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2500));
      const result = await checkRunningHubTaskStatus(runningHubApiKey, taskId);
      if (result.success === false && String(result.status).toUpperCase() === 'FAILED') {
        throw new Error(result.error || '任务失败');
      }
      if (result.url) return result.url;
    }
    throw new Error('轮询超时，未获取到媒体 URL');
  };

  /** 浏览器侧读取音频真实时长（秒）；跨域无 CORS 时常失败，此时由 Python ffprobe 兜底 */
  const probeAudioDurationSec = (url: string): Promise<number | undefined> =>
    new Promise((resolve) => {
      try {
        if (typeof Audio === 'undefined') {
          resolve(undefined);
          return;
        }
        const a = new Audio();
        a.preload = 'metadata';
        const done = (sec: number | undefined) => {
          a.removeAttribute('src');
          a.load();
          resolve(sec);
        };
        a.addEventListener('loadedmetadata', () => {
          const t = a.duration;
          done(Number.isFinite(t) && t > 0 ? t : undefined);
        });
        a.addEventListener('error', () => done(undefined));
        a.src = url;
      } catch {
        resolve(undefined);
      }
    });

  /**
   * 输入/输出：镜头文案/语音分镜 → 写入 voiceAudioUrl；仅 opts.playAfter===true 时自动播放（默认不播）
   */
  const synthesizeVoiceForShot = async (
    shot: Shot,
    opts?: { playAfter?: boolean }
  ): Promise<string> => {
    const playAfter = opts?.playAfter === true;
    let text = getTtsSpeakText(shot).trim();
    if (!text) throw new Error('没有可朗读的文案');
    const rawTextForTts = text;
    if (!runningHubApiKey?.trim()) {
      appendTerminalLog('Voice', `镜头${shot.number}: 已中止 — 未配置 RunningHub API Key`);
      throw new Error('请先配置 RunningHub API Key（上方输入框）');
    }

    const selected = getSelectedVoice();
    const usingDefaultRef = !selected?.runningHubAudioPath?.trim() && !selected?.audioDataUrl?.trim();
    const textIsEnglish = isTextPrimarilyEnglish(text);
    if (usingDefaultRef && textIsEnglish) {
      appendTerminalLog(
        'Voice',
        `镜头${shot.number}: ⚠️ 文案为英文，系统默认参考音为中文音色，生成的配音会是中文！请先在语音库里上传英文参考音频，或切换到中文文案。`
      );
      toast.warning(
        '文案为英文但未配置英文参考音，生成的配音会是中文。请先在语音库上传英文参考音。',
        5000
      );
    }
    if (apiKey?.trim()) {
      appendTerminalLog('Voice', `镜头${shot.number}: 已禁用口播重写，直接使用当前文案生成配音`);
    } else {
      appendTerminalLog('Voice', `镜头${shot.number}: 未配置云雾 API Key，直接使用当前文案生成配音`);
    }

    // 严格保持原文：提交给 TTS 的文本必须与镜头文案一字不差
    appendTerminalLog('Voice', `镜头${shot.number}: 已锁定原文直送 TTS（不改字），并启用韵律/呼吸/停顿优化参数`);
    appendTerminalLog('Voice', `镜头${shot.number}: 开始生成配音（${rawTextForTts.slice(0, 40)}${rawTextForTts.length > 40 ? '…' : ''}）`);
    updateShot(shot.id, { voiceGenerating: true });
    const originalText = rawTextForTts;
    try {
      let refPath: string | undefined = selected?.runningHubAudioPath?.trim();
      if (selected && !refPath && selected.audioDataUrl?.trim()) {
        appendTerminalLog('Voice', `镜头${shot.number}: 正在上传参考音频到 RunningHub…`);
        refPath = await uploadAudioToRunningHub(runningHubApiKey, selected.audioDataUrl);
        updateVoice(selected.id, { runningHubAudioPath: refPath });
      }
      if (!refPath) {
        appendTerminalLog('Voice', `镜头${shot.number}: 未使用语音库参考音，使用系统默认参考音色`);
      } else {
        appendTerminalLog('Voice', `镜头${shot.number}: TTS ai-app（参考音 ${refPath.slice(0, 28)}…）`);
      }
      const r = await generateAudio(runningHubApiKey, {
        text: rawTextForTts,
        referenceAudioPath: refPath,
        speed: 1.0,
        prosodyEnhance: true,
        breath: true,
        autoPause: true,
        pauseStrength: 0.7,
        emphasisStrength: 0.5,
        pitch: 0,
        volume: 1.0,
      });
      if (!r.success) throw new Error(r.error || 'TTS 请求失败');
      const audioUrl = r.url;

      if (!audioUrl) throw new Error('未获取到音频地址');
      const playableUrl = resolveRunningHubOutputUrl(audioUrl);
      const probedSec = await probeAudioDurationSec(playableUrl);
      // 估算仅作兜底：文案节奏与 TTS 实测差很多时，勿让大估算再与 ffprobe 取 max（已在 Python 侧改为以文件为准）
      const estimatedSec = Math.max(
        3,
        Math.round(originalText.length / 5 + (originalText.split(/\s+/).length - 1) / 2.5)
      );
      const audioDurationSec =
        probedSec != null && Number.isFinite(probedSec) && probedSec > 0
          ? Math.max(1, Math.round(probedSec))
          : estimatedSec;
      updateShot(shot.id, {
        voiceAudioUrl: playableUrl,
        audioDurationSec,
        voiceSourceText: rawTextForTts,
        voiceGenerating: false,
      });
      appendTerminalLog(
        'Voice',
        `镜头${shot.number}: 配音完成（${probedSec != null ? `实测约 ${audioDurationSec}s` : `估算 ${audioDurationSec}s`}）`
      );
      if (playAfter) {
        try {
          await new Audio(playableUrl).play();
        } catch {
          toast.info('配音已生成，若未自动播放请检查浏览器静音策略', 4000);
        }
      }
      return playableUrl;
    } catch (e: any) {
      updateShot(shot.id, { voiceGenerating: false });
      appendTerminalLog('Voice', `镜头${shot.number}: 配音失败 — ${e?.message || e}`);
      throw e;
    }
  };

  // 生成单个视频（仅 RunningHub Wan2.2 / LTX-2）
  const handleGenerateVideo = async (
    shot: Shot,
    regenerate: boolean = false,
    opts?: { onVideoHubProgress?: (percent: number) => void }
  ) => {
    const selectedModel = VIDEO_MODELS.find(m => m.id === selectedVideoModel);
    const isRunningHubModel = !!selectedModel?.isRunningHub;
    const isJimengVideoModel = !!selectedModel?.isJimengVideo;

    if (!isRunningHubModel && !isJimengVideoModel) {
      appendTerminalLog('VideoGen', `镜头${shot.number}: 已中止 — 不支持的视频模型`);
      toast.error('当前视频模型暂不支持');
      throw new Error('不支持的视频模型');
    }
    if (isRunningHubModel && !runningHubApiKey?.trim()) {
      appendTerminalLog('VideoGen', `镜头${shot.number}: 已中止 — 未配置 RunningHub API Key`);
      toast.error('请先配置 RunningHub API Key（上方输入框）');
      throw new Error('缺少 RunningHub API Key');
    }
    if (isJimengVideoModel && !jimengSessionId?.trim()) {
      appendTerminalLog('VideoGen', `镜头${shot.number}: 已中止 — 未配置即梦 SESSION_ID`);
      toast.error('请先配置即梦 SESSION_ID');
      throw new Error('缺少即梦 SESSION_ID');
    }
    
    if (!shot.videoPrompt) {
      appendTerminalLog('VideoGen', `镜头${shot.number}: 已跳过 — 无视频提示词`);
      toast.error('该镜头没有视频提示词');
      throw new Error('无视频提示词');
    }
    
    appendTerminalLog(
      'VideoGen',
      `镜头${shot.number}: ${regenerate ? '重新' : ''}生成视频 · 模型=${selectedVideoModel} · 时长=${selectedVideoDuration}s`
    );
    updateShot(shot.id, { videoGenerating: true });
    
    if (!selectedModel) {
      appendTerminalLog('VideoGen', `镜头${shot.number}: 已中止 — 未选择视频模型`);
      toast.error('请选择视频模型');
      updateShot(shot.id, { videoGenerating: false });
      throw new Error('未选择视频模型');
    }
    
    // 获取当前镜头的图片 URL（如果有）
    const shotImages = shot.imageUrls && shot.imageUrls.length > 0 ? shot.imageUrls : [];
    
    // 判断模式：如果有图片，则为图生视频；否则为文生视频
    const hasImages = shotImages.length > 0;
    
    // 如果有图片，必须使用选中的图片
    if (hasImages) {
      // 检查是否有选中的图片
      if (shot.selectedImageIndex === undefined || shot.selectedImageIndex < 0) {
        appendTerminalLog('VideoGen', `镜头${shot.number}: 已中止 — 有图但未选中用于视频的图`);
        toast.error('请先选择要用于生成视频的图片（点击图片即可选择）', 6000);
        updateShot(shot.id, { videoGenerating: false });
        throw new Error('未选择图片');
      }
      
      // 验证选中的图片索引是否有效
      if (shot.selectedImageIndex >= shotImages.length) {
        appendTerminalLog('VideoGen', `镜头${shot.number}: 已中止 — 图片索引无效`);
        toast.error('选中的图片索引无效，请重新选择图片', 6000);
        updateShot(shot.id, { videoGenerating: false });
        throw new Error('图片索引无效');
      }
    }
    
    const mode = hasImages ? '图生视频 (Image-to-Video)' : '文生视频 (Text-to-Video)';
    console.log(`[MediaGenerator] 视频生成模式: ${mode}, 图片数量: ${shotImages.length}, 选中图片索引: ${shot.selectedImageIndex}`);
    
    if (hasImages) {
      const selectedImageIndex = shot.selectedImageIndex!;
      toast.info(`使用图生视频模式，基于选中的图片（第 ${selectedImageIndex + 1} 张）生成视频`, 5000);
    } else {
      toast.info('使用文生视频模式，直接根据提示词生成视频');
    }
    
    try {
      if (isJimengVideoModel) {
        const ratio = selectedVideoOrientation === 'portrait' ? '9:16' : '16:9';
        const selectedImageUrl = hasImages ? shotImages[shot.selectedImageIndex!] : undefined;
        const submit = await generateJimengVideoAsync(
          {
            model: selectedVideoModel,
            prompt: shot.videoPrompt,
            ratio,
            resolution: (selectedVideoSize || '720p').toLowerCase(),
            duration: selectedVideoDuration || selectedModel?.duration || 5,
            file_paths: selectedImageUrl ? [selectedImageUrl] : [],
          },
          { sessionId: jimengSessionId }
        );

        if (!submit.success || !submit.taskId) {
          appendTerminalLog('VideoGen', `镜头${shot.number}: 即梦任务提交失败 — ${submit.error || '未知错误'}`);
          updateShot(shot.id, { videoGenerating: false });
          throw new Error(submit.error || '即梦任务提交失败');
        }

        appendTerminalLog('VideoGen', `镜头${shot.number}: 即梦任务已提交 taskId=${submit.taskId}`);
        toast.info(`即梦视频任务已提交，正在等待结果…\n任务ID: ${submit.taskId}`, 6000);

        let finalUrl = '';
        let finalStatus = '';
        const maxAttempts = 120;
        for (let i = 0; i < maxAttempts; i++) {
          const polled = await queryJimengVideoTask(submit.taskId, { sessionId: jimengSessionId });
          finalStatus = polled.status || '';
          if (!polled.success && finalStatus === 'failed') {
            appendTerminalLog('VideoGen', `镜头${shot.number}: 即梦任务失败 — ${polled.error || '未知错误'}`);
            updateShot(shot.id, { videoGenerating: false });
            throw new Error(polled.error || '即梦视频生成失败');
          }
          if (polled.success && polled.videoUrl) {
            finalUrl = polled.videoUrl;
            break;
          }
          await new Promise((r) => setTimeout(r, 5000));
          if (opts?.onVideoHubProgress) {
            const p = Math.min(95, Math.round(((i + 1) / maxAttempts) * 100));
            opts.onVideoHubProgress(p);
          }
        }

        if (!finalUrl) {
          appendTerminalLog('VideoGen', `镜头${shot.number}: 即梦轮询超时 — status=${finalStatus || 'unknown'}`);
          updateShot(shot.id, { videoGenerating: false });
          throw new Error('即梦视频生成超时，请稍后重试');
        }

        try {
          toast.info('即梦视频生成成功，正在缓存视频...', 2500);
          const cachedUrl = await cacheVideo(finalUrl);
          const currentVideoUrls = shot.videoUrls || (shot.videoUrl ? [shot.videoUrl] : []);
          const currentCachedUrls = shot.cachedVideoUrls || (shot.cachedVideoUrl ? [shot.cachedVideoUrl] : []);
          const updatedVideoUrls = [...currentVideoUrls, finalUrl];
          const updatedCachedUrls = [...currentCachedUrls, cachedUrl];
          updateShot(shot.id, {
            videoUrl: finalUrl,
            videoUrls: updatedVideoUrls,
            cachedVideoUrl: cachedUrl,
            cachedVideoUrls: updatedCachedUrls,
            videoGenerating: false,
          });
          opts?.onVideoHubProgress?.(100);
          toast.success(`即梦视频生成成功！（共 ${updatedVideoUrls.length} 个视频）`, 8000);
          appendTerminalLog('VideoGen', `镜头${shot.number}: 即梦视频生成完成并已缓存`);
        } catch (cacheError: any) {
          const currentVideoUrls = shot.videoUrls || (shot.videoUrl ? [shot.videoUrl] : []);
          const updatedVideoUrls = [...currentVideoUrls, finalUrl];
          updateShot(shot.id, {
            videoUrl: finalUrl,
            videoUrls: updatedVideoUrls,
            videoGenerating: false,
          });
          opts?.onVideoHubProgress?.(100);
          toast.success(`即梦视频生成成功！（共 ${updatedVideoUrls.length} 个视频）`, 8000);
          appendTerminalLog('VideoGen', `镜头${shot.number}: 即梦视频生成完成（缓存失败）`);
          console.warn('[MediaGenerator] 即梦视频缓存失败:', cacheError);
        }
        return;
      }

      let result: Awaited<ReturnType<typeof generateRunningHubVideo>>;
      const isLtx2Model = selectedModel?.isLtx2;

      if (isLtx2Model) {
        const selectedImageUrl = shotImages[shot.selectedImageIndex!];
        if (!selectedImageUrl) {
          appendTerminalLog('VideoGen', `镜头${shot.number}: LTX-2 需要选中图片`);
          toast.error('请先选中一张图片，再生成 LTX-2 视频', 6000);
          updateShot(shot.id, { videoGenerating: false });
          throw new Error('LTX-2 需要选中图片');
        }
        result = await generateRunningHubVideo(runningHubApiKey, {
          workflow: LTX2_WORKFLOW_TEMPLATE,
          prompt: shot.videoPrompt,
          model: 'ltx2',
          image_url: selectedImageUrl,
          duration: selectedVideoDuration || selectedModel.duration || 10,
        });
      } else if (hasImages) {
        const selectedImageUrl = shotImages[shot.selectedImageIndex!];
        if (!selectedImageUrl) {
          appendTerminalLog('VideoGen', `镜头${shot.number}: 选中图片 URL 无效`);
          toast.error('选中的图片URL无效，请重新选择图片', 6000);
          updateShot(shot.id, { videoGenerating: false });
          throw new Error('图片 URL 无效');
        }
        result = await generateRunningHubVideo(runningHubApiKey, {
          prompt: shot.videoPrompt,
          model: 'wan2.2',
          image_url: selectedImageUrl,
          duration: selectedVideoDuration || selectedModel.duration || 5,
        });
      } else {
        result = await generateRunningHubVideo(runningHubApiKey, {
          prompt: shot.videoPrompt,
          model: 'wan2.2',
          duration: selectedVideoDuration || selectedModel.duration || 5,
        });
      }

      if (result.success) {
        // 记录完整的响应数据用于调试
        console.log('[MediaGenerator] 视频生成响应:', {
          hasTaskId: !!result.taskId,
          taskId: result.taskId,
          hasVideoUrl: !!result.videoUrl,
          videoUrl: result.videoUrl,
          status: result.status,
          progress: result.progress,
          dataKeys: result.data ? Object.keys(result.data) : [],
          fullData: result.data,
        });
        
        // 如果result中没有taskId，尝试从result.data中提取
        if (!result.taskId && result.data) {
          const extractedTaskId = result.data.id || result.data.taskId || result.data.task_id || result.data.video_id;
          if (extractedTaskId) {
            console.log('[MediaGenerator] 从data中提取taskId:', extractedTaskId);
            result.taskId = extractedTaskId;
          }
        }
        
        // 检查是否直接返回了视频URL（同步完成，较少见）
        if (result.videoUrl) {
          // 自动缓存视频，并追加到 videoUrls 数组
          try {
            toast.info('视频生成成功，正在缓存视频...', 3000);
            const cachedUrl = await cacheVideo(result.videoUrl);
            
            // 追加模式：保留原有视频，添加新视频
            const currentVideoUrls = shot.videoUrls || (shot.videoUrl ? [shot.videoUrl] : []);
            const currentCachedUrls = shot.cachedVideoUrls || (shot.cachedVideoUrl ? [shot.cachedVideoUrl] : []);
            const updatedVideoUrls = [...currentVideoUrls, result.videoUrl];
            const updatedCachedUrls = [...currentCachedUrls, cachedUrl];
            
            updateShot(shot.id, { 
              videoUrl: result.videoUrl, // 保留向后兼容，显示最新的视频
              videoUrls: updatedVideoUrls, // 追加到数组
              cachedVideoUrl: cachedUrl, // 保留向后兼容
              cachedVideoUrls: updatedCachedUrls, // 追加到数组
              videoGenerating: false 
            });
            toast.success(`视频生成成功并已缓存！（共 ${updatedVideoUrls.length} 个视频）`, 8000);
            appendTerminalLog('VideoGen', `镜头${shot.number}: 同步返回视频 URL，已缓存并写入`);
            opts?.onVideoHubProgress?.(100);
          } catch (cacheError: any) {
            console.warn('[MediaGenerator] 视频缓存失败，使用原始URL:', cacheError);
            
            // 追加模式：即使缓存失败也追加视频URL
            const currentVideoUrls = shot.videoUrls || (shot.videoUrl ? [shot.videoUrl] : []);
            const updatedVideoUrls = [...currentVideoUrls, result.videoUrl];
            
            updateShot(shot.id, { 
              videoUrl: result.videoUrl,
              videoUrls: updatedVideoUrls,
              videoGenerating: false 
            });
            toast.success(`视频生成成功！（共 ${updatedVideoUrls.length} 个视频）`, 8000);
            appendTerminalLog('VideoGen', `镜头${shot.number}: 同步返回视频 URL（未缓存）`);
            opts?.onVideoHubProgress?.(100);
          }
        } else if (result.taskId) {
          // 异步任务，开始轮询
          appendTerminalLog('VideoGen', `镜头${shot.number}: 任务已提交 taskId=${result.taskId}`);
          console.log(`[MediaGenerator] 视频生成任务已提交: taskId=${result.taskId}, status=${result.status}, progress=${result.progress}`);
          const estimatedTime = '3-10分钟';
          
          toast.info(
            `视频生成任务已提交\n` +
            `任务ID: ${result.taskId}\n` +
            `预计耗时: ${estimatedTime}\n` +
            `系统会自动获取结果，请耐心等待...`,
            8000
          );
          
          await pollRunningHubTaskStatus(result.taskId, shot.id, 180, opts?.onVideoHubProgress);
        } else {
          // 成功但没有taskId和videoUrl，可能是响应格式问题
          appendTerminalLog('VideoGen', `镜头${shot.number}: 响应异常 — 无 taskId 与 videoUrl`);
          console.warn('[MediaGenerator] 视频生成响应异常:', result);
          toast.warning('视频生成任务已提交，但未获取到任务ID，请稍后手动检查', 8000);
          updateShot(shot.id, { videoGenerating: false });
          throw new Error('未获取到任务 ID');
        }
      } else {
        appendTerminalLog('VideoGen', `镜头${shot.number}: API 返回失败 — ${result.error || '未知'}`);
        updateShot(shot.id, { videoGenerating: false });
        throw new Error(result.error || '视频生成失败');
      }
    } catch (error: any) {
      const errorMsg = error.message || '未知错误';
      appendTerminalLog('VideoGen', `镜头${shot.number}: 异常 — ${errorMsg}`);
      if (errorMsg.includes('负载已饱和') || errorMsg.includes('saturated') || errorMsg.includes('负载')) {
        toast.error('服务器暂时繁忙，请稍后重试', 8000);
      } else {
        toast.error(`视频生成失败: ${errorMsg}`, 6000);
      }
      updateShot(shot.id, { videoGenerating: false });
      throw error;
    }
  };

  // 并发控制辅助函数：限制同时执行的任务数量
  const runConcurrentTasks = async <T,>(
    tasks: (() => Promise<T>)[],
    concurrency: number,
    onProgress?: (completed: number, total: number) => void
  ): Promise<{ success: T[]; failed: { error: any; index: number }[] }> => {
    const results: { success: T[]; failed: { error: any; index: number }[] } = {
      success: [],
      failed: []
    };
    
    let completed = 0;
    let currentIndex = 0;
    
    // 创建并发池
    const workers: Promise<void>[] = [];
    
    const runNext = async (): Promise<void> => {
      while (currentIndex < tasks.length) {
        const index = currentIndex++;
        const task = tasks[index];
        
        try {
          const result = await task();
          results.success.push(result);
          completed++;
          if (onProgress) {
            onProgress(completed, tasks.length);
          }
        } catch (error: any) {
          results.failed.push({ error, index });
          completed++;
          if (onProgress) {
            onProgress(completed, tasks.length);
          }
        }
      }
    };
    
    // 启动并发工作池
    for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
      workers.push(runNext());
    }
    
    // 等待所有任务完成
    await Promise.all(workers);
    
    return results;
  };

  // 批量生成图片（选中的镜头，支持追加模式）- 并发执行
  const handleBatchGenerateImages = async () => {
    // 只处理选中的镜头
    const selectedShots = shots.filter(s => s.selected);
    if (selectedShots.length === 0) {
      toast.warning('请先选择需要生成图片的镜头', 4000);
      return;
    }
    
    // 从选中的镜头中过滤出有图片提示词且不在生成中的
    // 注意：不再过滤已有图片的镜头，允许继续追加生成
    const shotsToGenerate = selectedShots.filter(s => 
      s.imagePrompt && 
      !s.imageGenerating
    );
    
    if (shotsToGenerate.length === 0) {
      // 检查是否有正在生成中的镜头
      const generatingShots = selectedShots.filter(s => s.imageGenerating);
      if (generatingShots.length > 0) {
        toast.info(`选中的镜头中有 ${generatingShots.length} 个正在生成图片，请等待完成`, 4000);
      } else {
        toast.info('选中的镜头都没有图片提示词，请先添加提示词', 4000);
      }
      return;
    }
    
    // 统计已有图片的镜头数量
    const shotsWithImages = shotsToGenerate.filter(s => s.imageUrls && s.imageUrls.length > 0);
    const shotsWithoutImages = shotsToGenerate.filter(s => !s.imageUrls || s.imageUrls.length === 0);
    
    const confirmMessage = shotsWithImages.length > 0
      ? `确定要为选中的 ${shotsToGenerate.length} 个镜头批量生成图片吗？\n\n` +
        `- ${shotsWithoutImages.length} 个镜头将生成第一张图片\n` +
        `- ${shotsWithImages.length} 个镜头将追加生成新图片（保留原有图片）\n\n` +
        `将并发生成，提高效率。`
      : `确定要为选中的 ${shotsToGenerate.length} 个镜头批量生成图片吗？\n\n将并发生成，提高效率。`;
    
    if (!confirm(confirmMessage)) {
      return;
    }
    
    // 初始化进度
    setBatchProgress({ current: 0, total: shotsToGenerate.length, type: 'image' });
    
    try {
      // 创建任务数组（每个镜头一个任务）
      const tasks = shotsToGenerate.map((shot, index) => 
        async () => {
          const existingCount = shot.imageUrls?.length || 0;
          console.log(`[MediaGenerator] 开始并发生成图片: 镜头 ${shot.number} (${index + 1}/${shotsToGenerate.length})，已有 ${existingCount} 张图片，将追加生成`);
          await handleGenerateImage(shot);
          return { shot, index };
        }
      );
      
      // 并发执行，最多同时5个请求（图片生成相对快速，可以设置更高的并发数）
      const concurrency = 5;
      const results = await runConcurrentTasks(
        tasks,
        concurrency,
        (completed, total) => {
          setBatchProgress(prev => prev ? { ...prev, current: completed } : null);
        }
      );
      
      const successCount = results.success.length;
      const failCount = results.failed.length;
      
      if (failCount === 0) {
        toast.success(`成功为 ${successCount} 个镜头生成图片！（并发执行，已追加到原有图片）`, 8000);
      } else {
        toast.warning(`完成：成功 ${successCount} 个，失败 ${failCount} 个`, 8000);
        // 记录失败的镜头
        results.failed.forEach(({ error, index }) => {
          console.error(`[MediaGenerator] 图片生成失败: 镜头 ${shotsToGenerate[index].number}`, error);
        });
      }
    } catch (error: any) {
      toast.error(`批量生成图片失败: ${error.message || '未知错误'}`, 6000);
    } finally {
      setBatchProgress(null);
    }
  };

  // 批量生成视频（选中的镜头，支持追加模式）- 并发执行
  const handleBatchGenerateVideos = async () => {
    // 只处理选中的镜头
    const selectedShots = shots.filter(s => s.selected);
    if (selectedShots.length === 0) {
      toast.warning('请先选择需要生成视频的镜头', 4000);
      return;
    }
    
    // 从选中的镜头中过滤出有视频提示词且不在生成中的
    // 注意：不再过滤已有视频的镜头，允许继续追加生成
    const shotsToGenerate = selectedShots.filter(s => {
      if (!s.videoPrompt || s.videoGenerating) {
        return false;
      }
      // 如果有图片，必须已选中图片
      if (s.imageUrls && s.imageUrls.length > 0) {
        return s.selectedImageIndex !== undefined && s.selectedImageIndex >= 0 && s.selectedImageIndex < s.imageUrls.length;
      }
      // 没有图片也可以生成（文生视频）
      return true;
    });
    
    if (shotsToGenerate.length === 0) {
      const shotsWithImagesButNoSelection = selectedShots.filter(s => 
        s.videoPrompt && 
        !s.videoGenerating &&
        s.imageUrls && 
        s.imageUrls.length > 0 &&
        (s.selectedImageIndex === undefined || s.selectedImageIndex < 0)
      );
      
      if (shotsWithImagesButNoSelection.length > 0) {
        toast.error(`有 ${shotsWithImagesButNoSelection.length} 个镜头有图片但未选择图片，请先选择图片后再批量生成视频`, 8000);
      } else {
        const generatingShots = selectedShots.filter(s => s.videoGenerating);
        if (generatingShots.length > 0) {
          toast.info(`选中的镜头中有 ${generatingShots.length} 个正在生成视频，请等待完成`, 4000);
        } else {
          toast.info('选中的镜头都没有视频提示词，请先添加提示词', 4000);
        }
      }
      return;
    }
    
    // 统计已有视频的镜头数量
    const shotsWithVideos = shotsToGenerate.filter(s => s.videoUrl);
    const shotsWithoutVideos = shotsToGenerate.filter(s => !s.videoUrl);
    
    const confirmMessage = shotsWithVideos.length > 0
      ? `确定要为选中的 ${shotsToGenerate.length} 个镜头批量生成视频吗？\n\n` +
        `- ${shotsWithoutVideos.length} 个镜头将生成第一个视频\n` +
        `- ${shotsWithVideos.length} 个镜头将追加生成新视频（保留原有视频）\n\n` +
        `注意：将使用每个镜头选中的图片生成视频。\n\n将并发生成，提高效率。`
      : `确定要批量生成 ${shotsToGenerate.length} 个镜头的视频吗？\n\n注意：将使用每个镜头选中的图片生成视频。\n\n将并发生成，提高效率。`;
    
    if (!confirm(confirmMessage)) {
      return;
    }
    
    // 初始化进度
    setBatchProgress({ current: 0, total: shotsToGenerate.length, type: 'video' });
    
    try {
      // 创建任务数组（每个镜头一个任务）
      const tasks = shotsToGenerate.map((shot, index) => 
        async () => {
          const hasExistingVideo = !!shot.videoUrl;
          console.log(`[MediaGenerator] 开始并发生成视频: 镜头 ${shot.number} (${index + 1}/${shotsToGenerate.length})，${hasExistingVideo ? '已有视频，将追加生成' : '将生成第一个视频'}`);
          await handleGenerateVideo(shot);
          return { shot, index };
        }
      );
      
      // 并发执行：即梦视频并发更保守，降低被限流概率
      const selectedVideoModelCfg = VIDEO_MODELS.find(m => m.id === selectedVideoModel);
      const concurrency = selectedVideoModelCfg?.isJimengVideo ? 2 : 3;
      const results = await runConcurrentTasks(
        tasks,
        concurrency,
        (completed, total) => {
          setBatchProgress(prev => prev ? { ...prev, current: completed } : null);
        }
      );
      
      const successCount = results.success.length;
      const failCount = results.failed.length;
      
      if (failCount === 0) {
        toast.success(`成功为 ${successCount} 个镜头生成视频！（并发执行，已追加到原有视频）`, 8000);
      } else {
        toast.warning(`完成：成功 ${successCount} 个，失败 ${failCount} 个`, 8000);
        // 记录失败的镜头
        results.failed.forEach(({ error, index }) => {
          console.error(`[MediaGenerator] 视频生成失败: 镜头 ${shotsToGenerate[index].number}`, error);
        });
      }
    } catch (error: any) {
      toast.error(`批量生成视频失败: ${error.message || '未知错误'}`, 6000);
    } finally {
      setBatchProgress(null);
    }
  };

  // 批量生成语音（RunningHub TTS / 语音库 IndexTTS2）
  const handleBatchGenerateVoice = async () => {
    const selectedShots = shots.filter(s => s.selected && getTtsSpeakText(s).trim());
    if (selectedShots.length === 0) {
      toast.warning('请先选择有文案或语音分镜内容的镜头');
      return;
    }
    if (!runningHubApiKey?.trim()) {
      toast.error('请先配置 RunningHub API Key（上方输入框）');
      return;
    }
    if (!confirm(`确定要为 ${selectedShots.length} 个镜头批量生成配音吗？（语音库有参考音则用之，否则系统默认）`)) {
      return;
    }
    setBatchProgress({ current: 0, total: selectedShots.length, type: 'voice' });
    try {
      const tasks = selectedShots.map((shot) => async () => {
        await synthesizeVoiceForShot(shot, { playAfter: false });
        return { shot };
      });
      const concurrency = 2;
      const results = await runConcurrentTasks(tasks, concurrency, (done, total) => {
        setBatchProgress(prev => (prev ? { ...prev, current: done } : null));
      });
      const ok = results.success.length;
      const bad = results.failed.length;
      if (bad === 0) toast.success(`批量配音完成：${ok} 个镜头`, 6000);
      else toast.warning(`配音结束：成功 ${ok}，失败 ${bad}`, 8000);
    } catch (e: any) {
      toast.error(`批量配音异常: ${e.message || e}`, 6000);
    } finally {
      setBatchProgress(null);
    }
  };

  const isMainWorkspace = activeWorkspaceTabId === 'main';
  const selectedCount = tableShots.filter((s) => s.selected).length;
  const generatingCount = tableShots.filter((s) => s.imageGenerating || s.videoGenerating || s.voiceGenerating).length;
  const selectedVideoModelConfig = VIDEO_MODELS.find((m) => m.id === selectedVideoModel);
  const isSelectedJimengVideoModel = !!selectedVideoModelConfig?.isJimengVideo;
  const videoModelDurationHint = (selectedVideoModelConfig?.supportedDurations || [])
    .map((d) => `${d}s`)
    .join(' / ');
  const videoModelConstraintHint = isSelectedJimengVideoModel
    ? '即梦视频：普通模型仅 5/10 秒，Seedance 支持 4-15 秒；SESSION_ID 必填。'
    : 'RunningHub：按所选模型支持时长生成。';

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* 顶部操作栏 */}
      <div className="flex flex-col gap-4 bg-slate-800/50 p-4 rounded-xl border border-slate-800">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-emerald-400 flex items-center gap-2">
            <Video size={24} />
            媒体生成
          </h2>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <div className="flex items-end gap-1.5 mr-1 border-r border-slate-700 pr-2">
              <div>
                <label className="text-[10px] text-emerald-300 font-bold mb-0.5 block whitespace-nowrap">角色库</label>
                <button
                  type="button"
                  onClick={() => setShowCharacterLibrary(true)}
                  className="px-2.5 py-1 bg-indigo-600/80 hover:bg-indigo-500 text-white text-[11px] font-semibold rounded flex items-center gap-1 shadow-sm"
                  title="管理角色（图生图锚定）"
                >
                  <Users size={14} />
                  打开
                </button>
              </div>
              <div className="min-w-0 max-w-[140px]">
                <label className="text-[10px] text-emerald-300 font-bold mb-0.5 block whitespace-nowrap">语音库</label>
                {selectedVoiceForUi?.name && (
                  <div
                    className="text-[10px] text-amber-400/90 font-medium truncate mb-0.5"
                    title={`当前参考音色（RunningHub 配音）: ${selectedVoiceForUi.name}`}
                  >
                    {selectedVoiceForUi.name}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setShowVoiceLibrary(true)}
                  className="px-2.5 py-1 bg-teal-600/80 hover:bg-teal-500 text-white text-[11px] font-semibold rounded flex items-center gap-1 shadow-sm"
                  title="管理参考音色：可选。上传后作为 RunningHub 配音参考音；未上传或未选条目时使用系统默认参考音（与 IndexTTS2 模板一致）。需配置 RunningHub API Key。"
                >
                  <HardDrive size={14} />
                  打开
                </button>
              </div>
            </div>
            <button
              onClick={loadScriptFromTools}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-all"
            >
              <FolderOpen size={16} />
              读取分镜脚本
            </button>
            <button
              type="button"
              onClick={openMediaHistorySelector}
              className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium rounded-lg transition-all"
              title="仅列出已生成图片/配音/视频的快照（YYYYMMDD + 三位随机数）"
            >
              <HardDrive size={16} />
              历史记录
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium rounded-lg transition-all"
            >
              <Upload size={16} />
              上傳脚本文件
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.csv"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              onClick={() => setShowScriptInput(!showScriptInput)}
              className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium rounded-lg transition-all"
            >
              <FileText size={16} />
              {showScriptInput ? '隐藏' : '手动输入'}
            </button>
          </div>
        </div>

        {/* 设置选项 - 一排显示 */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-2 pt-3 border-t border-slate-700 [&_label]:text-[11px] [&_label]:font-bold [&_label]:text-emerald-300 [&_select]:font-semibold [&_select]:text-slate-100 [&_select]:bg-slate-900 [&_select]:border-slate-600 [&_select]:rounded [&_select]:px-1.5 [&_select]:py-1 [&_input]:font-medium [&_input]:text-slate-100 [&_input]:border-slate-600 [&_button]:font-semibold">
          {/* RunningHub API Key（始终显示，配音/视频共用） */}
          <div className="w-full min-w-0">
            <label className="text-[10px] text-slate-500 mb-0.5 block flex items-center gap-1">
              <Rocket size={10} className="text-orange-400" />
              RunningHub API Key
              <span className="text-amber-400 text-[9px]">(视频+配音)</span>
            </label>
            <input
              type="password"
              value={runningHubApiKey}
              onChange={(e) => setRunningHubApiKey(e.target.value)}
              placeholder="填写后生成视频/配音"
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            />
          </div>


          {selectedImageModel.startsWith('jimeng') && (
            <div className="w-full min-w-0">
              <label className="text-[10px] text-slate-500 mb-0.5 block flex items-center gap-1">
                即梦 SESSION_ID
                <span className="text-blue-400 text-[9px]">(图片)</span>
              </label>
              <input
                type="text"
                value={jimengSessionId}
                onChange={(e) => setJimengSessionId(e.target.value)}
                placeholder="输入 SESSION_ID"
                className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
              />
            </div>
          )}

          <div className="flex-shrink-0 w-[120px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block">圖片模型</label>
            <select
              value={selectedImageModel}
              onChange={(e) => {
                const newModel = e.target.value;
                setSelectedImageModel(newModel);
                
                // 如果切换到 DALL-E 3，检查当前比例是否支持
                if (newModel === 'dall-e-3') {
                  const currentRatio = IMAGE_RATIOS.find(r => r.id === selectedImageRatio);
                  if (currentRatio && !currentRatio.dallE3Supported) {
                    // 自动切换到第一个支持的比例（1:1）
                    setSelectedImageRatio('1:1');
                  }
                }
                // 如果切换到 sora-image，检查当前比例是否支持
                if (newModel === 'sora-image') {
                  const currentRatio = IMAGE_RATIOS.find(r => r.id === selectedImageRatio);
                  if (currentRatio && !currentRatio.soraImageSupported) {
                    // 自动切换到第一个支持的比例（1:1）
                    setSelectedImageRatio('1:1');
                  }
                }
              }}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {IMAGE_MODELS.map(model => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </select>
          </div>
          
          <div className="flex-shrink-0 w-[120px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block">视频模型</label>
            <select
              value={selectedVideoModel}
              onChange={(e) => {
                const newModel = e.target.value;
                setSelectedVideoModel(newModel);
                
                // 切换模型时，自动更新 size 和 duration 的默认值
                const model = VIDEO_MODELS.find(m => m.id === newModel);
                if (model) {
                  if (model.defaultSize) {
                    setSelectedVideoSize(model.defaultSize);
                  }
                  if (model.duration) {
                    setSelectedVideoDuration(model.duration);
                  }
                }
              }}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {VIDEO_MODELS.map(model => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </select>
          </div>

          <div className="flex-shrink-0 w-[152px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block">风格设置</label>
            <select
              value={STYLE_LIBRARY.some((s) => s.id === selectedStyle) ? selectedStyle : 'none'}
              onChange={(e) => setSelectedStyle(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {STYLE_LIBRARY.map((style) => (
                <option key={style.id} value={style.id}>{style.name}</option>
              ))}
            </select>
          </div>
          
          {/* 视频分辨率设置 */}
          <div className="col-span-2 md:col-span-4 lg:col-span-6 xl:col-span-8">
            <div className="text-[10px] leading-4 text-amber-300/90 bg-slate-900/60 border border-slate-700 rounded px-2 py-1">
              {videoModelConstraintHint}
              {videoModelDurationHint ? ` 当前可选时长：${videoModelDurationHint}` : ''}
            </div>
          </div>

          <div className="flex-shrink-0 w-[90px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block">视频分辨率</label>
            <select
              value={selectedVideoSize}
              onChange={(e) => setSelectedVideoSize(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {(() => {
                const model = VIDEO_MODELS.find(m => m.id === selectedVideoModel);
                const sizes = model?.supportedSizes || ['720P', '1080P'];
                return sizes.map(size => (
                  <option key={size} value={size}>{size}</option>
                ));
              })()}
            </select>
          </div>
          
          {/* 视频时长设置 */}
          <div className="flex-shrink-0 w-[90px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block">视频時長（秒）</label>
            <select
              value={selectedVideoDuration}
              onChange={(e) => setSelectedVideoDuration(Number(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {(() => {
                const model = VIDEO_MODELS.find(m => m.id === selectedVideoModel);
                const durations = model?.supportedDurations || [10];
                return durations.map(duration => (
                  <option key={duration} value={duration}>{duration}秒</option>
                ));
              })()}
            </select>
          </div>

          {/* 一键成片：生成范围（默认含视频） */}
          <div className="flex-shrink-0 w-[148px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block whitespace-nowrap">一键成片设置</label>
            <select
              value={oneClickPipelineMode}
              onChange={(e) => setOneClickPipelineMode(e.target.value as 'image_audio_video' | 'image_audio_only')}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
              title="一键成片 / 挂机队列处理时均按此项决定是否生成视频"
            >
              <option value="image_audio_video">图片+音频+视频</option>
              <option value="image_audio_only">仅图片+音频</option>
            </select>
          </div>
          
          {/* 视频方向选择 */}
          <div className="flex-shrink-0 w-[90px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block">视频方向</label>
            <select
              value={selectedVideoOrientation}
              onChange={(e) => setSelectedVideoOrientation(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              <option value="landscape">横屏</option>
              <option value="portrait">竖屏</option>
            </select>
          </div>
          
          <div className="flex-shrink-0 w-[90px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block">
              圖片比例
              {selectedImageModel === 'dall-e-3' && (
                <span className="text-amber-400 ml-1" title="DALL-E 3 只支持 1024x1024, 1024x1792, 1792x1024">⚠️</span>
              )}
              {selectedImageModel === 'sora-image' && (
                <span className="text-blue-400 ml-1" title="Sora Image 只支持 1:1, 2:3, 3:2 三种比例">⚠️</span>
              )}
            </label>
            <select
              value={selectedImageRatio}
              onChange={(e) => {
                const newRatio = e.target.value;
                setSelectedImageRatio(newRatio);
                
                // 当图片比例改变时，自动更新视频方向（但用户可以手动覆盖）
                const currentRatio = IMAGE_RATIOS.find(r => r.id === newRatio);
                if (currentRatio) {
                  if (currentRatio.width > currentRatio.height) {
                    setSelectedVideoOrientation('landscape'); // 横屏
                  } else if (currentRatio.width < currentRatio.height) {
                    setSelectedVideoOrientation('portrait'); // 竖屏
                  } else {
                    // 正方形默认使用 landscape
                    setSelectedVideoOrientation('landscape');
                  }
                }
              }}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {IMAGE_RATIOS.map(ratio => {
                // DALL-E 3 只显示支持的比例
                if (selectedImageModel === 'dall-e-3' && !ratio.dallE3Supported) {
                  return null;
                }
                // sora-image 只显示支持的比例
                if (selectedImageModel === 'sora-image' && !ratio.soraImageSupported) {
                  return null;
                }
                
                let label = ratio.name;
                if (selectedImageModel === 'dall-e-3' && !ratio.dallE3Supported) {
                  label += ' (不支持)';
                }
                return (
                  <option key={ratio.id} value={ratio.id}>
                    {label}
                  </option>
                );
              }).filter(Boolean)}
            </select>
          </div>

          <div className="flex-1 min-w-[100px]">
            <label className="text-xs text-slate-500 mb-1 block">生成數量</label>
            <select
              value={generateImageCount}
              onChange={(e) => setGenerateImageCount(parseInt(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {[1, 2, 3, 4].map(count => (
                <option key={count} value={count}>{count} 張</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* 脚本输入区域 */}
      {showScriptInput && (
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
          <label className="text-sm font-medium text-slate-400 mb-2 block">脚本內容</label>
          <textarea
            value={scriptText}
            onChange={(e) => handleScriptInput(e.target.value)}
            placeholder="请粘贴脚本內容或从改写工具读取..."
            className="w-full h-40 bg-slate-900/50 border border-slate-700 rounded-lg p-4 text-slate-200 resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
      )}

      {/* 主内容区域 */}
      <div className="flex flex-col gap-4">
        {/* 工作区标签栏 */}
        <div className="flex items-center gap-1 bg-slate-800/70 border border-slate-700 rounded-lg p-1.5 overflow-x-auto">
          {/* 当前编辑标签 */}
          <button
            type="button"
            onClick={() => activateQueueWorkspaceTab('main')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
              activeWorkspaceTabId === 'main'
                ? 'bg-emerald-600 text-white shadow-lg'
                : 'bg-slate-700/50 text-slate-300 hover:bg-slate-600'
            }`}
          >
            <Rocket size={13} />
            <span className="font-mono text-[11px] max-w-[200px] truncate" title={mainWorkspaceTabTitle}>
              {mainWorkspaceTabTitle}
            </span>
            {oneClickRunning && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
              </span>
            )}
          </button>
          {/* 队列任务标签 */}
          {queueWorkspaceTabIds.map(tabId => {
            const task = oneClickQueueTasks.find(t => t.id === tabId);
            const meta = queueTabMeta[tabId];
            const isRunning = task?.status === 'running';
            const isMediaTab = tabId.startsWith('media:');
            return (
              <button
                type="button"
                key={tabId}
                onClick={() => activateQueueWorkspaceTab(tabId)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all group ${
                  activeWorkspaceTabId === tabId
                    ? 'bg-indigo-600 text-white shadow-lg'
                    : 'bg-slate-700/50 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {isMediaTab || meta?.taskType === 'media' ? <HardDrive size={13} /> : <ListOrdered size={13} />}
                {meta?.name || tabId}
                {isRunning && (
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                  </span>
                )}
                <span
                  onClick={(e) => { e.stopPropagation(); closeQueueTaskWorkspaceTab(tabId); }}
                  className="ml-0.5 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={11} />
                </span>
              </button>
            );
          })}
          {/* 一键成片状态指示 */}
          {oneClickRunning && oneClickPipelineProgress && (
            <span className="text-[11px] text-amber-400 ml-2 animate-pulse">{oneClickPipelineProgress}</span>
          )}
        </div>

        {/* 操作栏 */}
        <div className="flex items-center justify-between bg-slate-800/50 border border-slate-700 rounded-xl p-3">
          <div className="flex items-center gap-2 flex-wrap">
            {/* 批量选择按钮 */}
            <div className="flex items-center gap-1 border-r border-slate-700 pr-2 mr-1">
              <button
                onClick={handleSelectAll}
                className="flex items-center gap-1 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium rounded transition-all"
                title="全选"
              >
                <CheckSquare size={14} />
              </button>
              <button
                onClick={handleDeselectAll}
                className="flex items-center gap-1 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium rounded transition-all"
                title="取消全选"
              >
                <Square size={14} />
              </button>
              <button
                onClick={handleToggleSelect}
                className="flex items-center gap-1 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium rounded transition-all"
                title="反选"
              >
                <RefreshCw size={14} />
              </button>
            </div>

            <button onClick={handleAddShot} className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded transition-all">
              <Plus size={14} />
              添加镜头
            </button>
            <button
              onClick={handleDeleteSelected}
              disabled={selectedCount === 0}
              className="flex items-center gap-1 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded transition-all disabled:opacity-50"
            >
              <Trash2 size={14} />
              刪除 ({selectedCount})
            </button>
            <button
              onClick={handleExportImagesAsZip}
              disabled={selectedCount === 0 || shots.filter(s => s.selected && s.imageUrls?.length).length === 0}
              className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded transition-all disabled:opacity-50"
              title="导出选中镜头的所有图片为 ZIP 文件"
            >
              <Download size={14} />
              图片ZIP
            </button>

            {/* 批量操作 */}
            <div className="flex items-center gap-1 border-l border-slate-700 pl-2 ml-1">
              <button
                onClick={handleBatchGenerateImages}
                disabled={generatingCount > 0}
                className="flex items-center gap-1 px-2 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded transition-all disabled:opacity-50"
                title="批量生成图片"
              >
                <Rocket size={13} />
                批量圖片
              </button>
              <button
                onClick={handleBatchGenerateVideos}
                disabled={generatingCount > 0}
                className="flex items-center gap-1 px-2 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded transition-all disabled:opacity-50"
                title="批量生成视频"
              >
                <Rocket size={13} />
                批量视频
              </button>
              <button
                onClick={handleBatchGenerateVoice}
                disabled={generatingCount > 0}
                className="flex items-center gap-1 px-2 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium rounded transition-all disabled:opacity-50"
                title="批量生成语音"
              >
                <Rocket size={13} />
                批量語音
              </button>
            </div>

            <span className="text-xs text-slate-500 ml-1">
              {generatingCount > 0 ? `生成中: ${generatingCount} 個任務...` : '就緒'}
            </span>
          </div>

          {/* 一键成片 & 队列按钮 */}
          <div className="flex items-center gap-2 ml-4 flex-shrink-0">
            <input
              type="text"
              value={jianyingOutputDir}
              onChange={(e) => onChangeJianyingOutputDir(e.target.value)}
              placeholder="本机剪映草稿根目录（路径映射），例如 /Users/kenyou/Downloads/JianyingPro Drafts"
              className="w-[360px] px-3 py-1.5 bg-slate-900/70 border border-slate-600 focus:border-purple-500 outline-none text-slate-100 text-xs rounded-lg"
              title="用于把 Railway 容器路径映射为你本机绝对路径；请填你的剪映草稿根目录"
            />
            <button
              onClick={() => handleOneClickPipeline()}
              disabled={oneClickRunning || generatingCount > 0}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white text-xs font-semibold rounded-lg shadow-lg transition-all disabled:opacity-50"
            >
              {oneClickRunning ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
              {oneClickRunning ? '成片中...' : '一键成片'}
            </button>
            <button
              onClick={handleEnqueueOneClickTask}
              disabled={queueProcessorRunning}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium rounded-lg transition-all disabled:opacity-50"
            >
              <ArrowUp size={14} />
              加入挂机队列
            </button>
            <button
              onClick={() => { if (!queueProcessorRunning) processOneClickQueue(); }}
              disabled={queueProcessorRunning}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold rounded-lg shadow transition-all disabled:opacity-50"
            >
              {queueProcessorRunning ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
              {queueProcessorRunning ? '队列执行中...' : '处理队列'}
            </button>
            <button
              onClick={handleExportToJianying}
              disabled={isExportingToJianying || tableShots.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded-lg transition-all disabled:opacity-50"
            >
              {isExportingToJianying ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              导出剪映
            </button>
            {lastJianyingDownloadUrl && (
              <a
                href={lastJianyingDownloadUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-all"
                title="下载导出的剪映草稿 ZIP"
              >
                <Download size={14} />
                下载草稿ZIP
              </a>
            )}
          </div>
        </div>

        {/* 队列任务历史 */}
        {oneClickQueueTasks.length > 0 && (
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <ListOrdered size={14} />
                队列任务历史
                <span className="text-[10px] text-slate-500 font-normal">({oneClickQueueTasks.length})</span>
              </h3>
            </div>
            <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto">
              {oneClickQueueTasks.map(t => {
                const statusColors: Record<string, string> = {
                  pending: 'bg-slate-600',
                  queued: 'bg-slate-600',
                  running: 'bg-amber-600 animate-pulse',
                  completed: 'bg-emerald-600',
                  failed: 'bg-red-600',
                  cancelled: 'bg-slate-500',
                };
                const statusLabels: Record<string, string> = {
                  pending: '待处理',
                  queued: '等待',
                  running: '执行中',
                  completed: '已完成',
                  failed: '失败',
                  cancelled: '已取消',
                };
                const pctRaw = t.progressPercent;
                const pct = Math.max(
                  0,
                  Math.min(100, typeof pctRaw === 'number' ? Math.round(pctRaw) : Number(pctRaw) || 0)
                );
                return (
                  <div key={t.id} className="flex items-start gap-3 bg-slate-700/50 rounded-lg px-3 py-2 group">
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium text-white shrink-0 ${statusColors[t.status] || 'bg-slate-600'}`}>
                          {statusLabels[t.status] || t.status}
                        </span>
                        <span className={`text-[10px] font-mono shrink-0 ${t.type === 'oneshot' ? 'text-indigo-400' : 'text-orange-400'}`}>
                          [{t.type === 'oneshot' ? 'OC' : 'Q'}]
                        </span>
                        <span className="text-[11px] text-slate-300 truncate flex-1 min-w-0">{t.id}</span>
                        <span className="text-[10px] text-slate-500 shrink-0">{t.completedAt || t.createdAt}</span>
                        {t.status === 'completed' && (
                          <button
                            type="button"
                            onClick={() => handleReexportJianyingForTask(t.id)}
                            className="text-[10px] px-2 py-0.5 bg-purple-600 hover:bg-purple-500 text-white rounded transition-all shrink-0"
                          >
                            导出剪映草稿
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openQueueTaskWorkspaceTab(t.id, t.id, t.type as 'oneshot' | 'queue', t.status === 'running')}
                          className="text-[10px] px-2 py-0.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-all shrink-0"
                        >
                          查看任务
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const tasks = oneClickQueueTasks.filter(x => x.id !== t.id);
                            persistQueue(tasks);
                            appendTerminalLog('Queue', `删除任务 ${t.id}`);
                          }}
                          className="text-[10px] px-1.5 py-0.5 bg-red-600/50 hover:bg-red-600 text-white rounded transition-all shrink-0"
                        >
                          <X size={10} />
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-0 h-1.5 bg-slate-900 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-[width] duration-300 ${
                              t.status === 'failed' ? 'bg-red-500' : t.status === 'completed' ? 'bg-emerald-500' : 'bg-amber-500/90'
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-[9px] text-slate-400 w-9 text-right tabular-nums shrink-0">{pct}</span>
                      </div>
                      {t.status === 'running' && t.progressNote && (
                        <div className="text-[9px] text-slate-500 truncate">{t.progressNote}</div>
                      )}
                    </div>
                    {/* 右侧预览图（大尺寸） */}
                    {(() => {
                      const previewUrl = taskPreviewImageUrl(t);
                      return previewUrl ? (
                        <img
                          src={previewUrl}
                          alt="预览"
                          className="w-20 h-20 rounded object-cover flex-shrink-0 border border-slate-600 group-hover:border-indigo-500 transition-all"
                          title={`预览图 · ${t.id}`}
                        />
                      ) : (
                        <div className="w-20 h-20 rounded border border-slate-600 flex-shrink-0 flex items-center justify-center bg-slate-800">
                          <ImageIcon size={20} className="text-slate-600" />
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 终端日志 */}
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <Terminal size={14} />
              终端日志
              <span className="text-[10px] text-slate-500 font-normal">({terminalLogs.length})</span>
            </h3>
            <button
              type="button"
              onClick={() => { setTerminalLogs([]); try { localStorage.removeItem(TERMINAL_LOG_STORAGE_KEY); } catch {} }}
              className="text-[10px] text-slate-500 hover:text-slate-300 px-2 py-0.5 rounded border border-slate-600"
            >
              清空
            </button>
          </div>
          <div
            ref={terminalScrollRef}
            className="h-32 overflow-y-auto rounded-lg border border-slate-600 bg-black px-3 py-2 font-mono text-[11px] leading-relaxed shadow-inner"
          >
            {terminalLogs.length === 0 ? (
              <span className="text-slate-600">等待操作…</span>
            ) : (
              terminalLogs.map(row => (
                <div key={row.id} className="whitespace-pre-wrap break-all">
                  <span className="text-emerald-400">[{row.time}]</span>
                  <span className="text-slate-400 ml-1">[{row.tag}]</span>
                  <span className="text-slate-200 ml-1">{row.message}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 镜头列表 - 表格式布局（主工作区用 shots；历史任务标签用 queuePreviewLocalShots） */}
        {!isMainWorkspace && (
          <div className="text-xs text-amber-200/90 bg-amber-950/25 border border-amber-700/40 rounded-lg px-3 py-2">
            {activeWorkspaceTabId.startsWith('media:') ? (
              <>
                正在预览<strong className="text-amber-100"> 媒体历史 </strong>快照{' '}
                <span className="font-mono text-amber-100">{activeWorkspaceTabId.slice(6)}</span>
                （与队列「查看任务」相同，只读预览）。请点顶部左侧主标签（
                <span className="font-mono">{mainWorkspaceTabTitle}</span>）返回当前编辑分镜后再生成/导出。
              </>
            ) : (
              <>
                正在预览队列任务 <span className="font-mono text-amber-100">{activeWorkspaceTabId}</span>
                的快照。请点顶部左侧主标签（<span className="font-mono">{mainWorkspaceTabTitle}</span>
                ）返回当前编辑分镜后再生成/导出。
              </>
            )}
          </div>
        )}
        <div className="flex-1 overflow-x-auto custom-scrollbar">
          {tableShots.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <FileText size={48} className="mx-auto mb-4 opacity-50" />
              <p>暂无镜头數據</p>
              <p className="text-xs mt-2">请从改写工具读取脚本或手动添加镜头</p>
            </div>
          ) : (
            <div className="min-w-full">
              {/* 表头 */}
              <div className="grid grid-cols-[60px_200px_160px_220px_160px_220px_140px] gap-1.5 bg-slate-800/70 border-b border-slate-700 p-2 text-xs font-semibold text-slate-300 sticky top-0 z-10">
                <div className="flex items-center justify-center">編號</div>
                <div className="flex items-center">文案</div>
                <div className="flex items-center">提示詞</div>
                <div className="flex items-center">新圖</div>
                <div className="flex items-center">视频提示詞</div>
                <div className="flex items-center">视频</div>
                <div className="flex items-center justify-end pr-2">操作</div>
              </div>
              
              {/* 表格内容 */}
              {tableShots.map((shot) => (
                <div
                  key={shot.id}
                  className={`grid grid-cols-[60px_200px_160px_220px_160px_220px_140px] gap-1.5 border-b border-slate-700/50 p-2 hover:bg-slate-800/30 transition-colors ${
                    shot.selected ? 'bg-emerald-500/10' : ''
                  }`}
                >
                  {/* 编号列 */}
                  <div className="flex items-center justify-center">
                    <input
                      type="checkbox"
                      disabled={!isMainWorkspace}
                      checked={shot.selected || false}
                      onChange={(e) => updateShot(shot.id, { selected: e.target.checked })}
                      className="rounded mr-2 disabled:opacity-40"
                    />
                    <span className="text-xs font-semibold text-emerald-400">{shot.number}</span>
                  </div>

                  {/* 文案列：仅展示与 TTS 一致的配音正文；编辑时改完整 caption（可含「角色-语气：」前缀） */}
                  <div className="flex flex-col gap-1">
                    {editingCaptionShotId === shot.id && isMainWorkspace ? (
                      <textarea
                        value={shot.caption}
                        onChange={(e) => updateShot(shot.id, { caption: e.target.value })}
                        className="w-full bg-slate-800 border border-slate-600 rounded px-1.5 py-1 text-[10px] text-slate-200 resize-y min-h-[72px] max-h-48"
                        placeholder="完整镜头文案。需要角色前缀时可写：讲述者-平静：口播正文…"
                      />
                    ) : (
                      <>
                        {(() => {
                          const dub = getTtsSpeakText(shot).trim() || '無文案';
                          const longForClamp = dub.length;
                          return (
                            <>
                              <div
                                className={`text-[11px] text-slate-300 leading-relaxed ${
                                  expandedCaptions.has(shot.id) ? '' : 'line-clamp-4'
                                }`}
                              >
                                {dub}
                              </div>
                              {longForClamp > 100 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setExpandedCaptions((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(shot.id)) next.delete(shot.id);
                                      else next.add(shot.id);
                                      return next;
                                    });
                                  }}
                                  className="text-[9px] text-slate-400 hover:text-slate-300 self-start"
                                >
                                  {expandedCaptions.has(shot.id) ? '收起' : '展开'}
                                </button>
                              )}
                            </>
                          );
                        })()}
                      </>
                    )}
                    {isMainWorkspace && (
                      <button
                        type="button"
                        onClick={() =>
                          setEditingCaptionShotId((id) => (id === shot.id ? null : shot.id))
                        }
                        className="text-[10px] px-1.5 py-0.5 bg-slate-700/90 hover:bg-slate-600 text-slate-200 rounded self-start flex items-center gap-1"
                        title="编辑完整镜头文案（含可选的角色-语气前缀）"
                      >
                        <Edit2 size={10} />
                        {editingCaptionShotId === shot.id ? '完成编辑' : '编辑全文'}
                      </button>
                    )}
                  </div>

                  {/* 提示词列（图片提示词） */}
                  <div className="flex flex-col gap-1">
                    {shot.editing ? (
                      <textarea
                        value={shot.imagePrompt}
                        onChange={(e) => updateShot(shot.id, { imagePrompt: e.target.value })}
                        className="w-full bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-slate-200 resize-none h-16"
                        placeholder="圖片提示詞"
                      />
                    ) : (
                      <>
                        <div className={`text-[10px] text-slate-300 leading-relaxed ${
                          expandedImagePrompts.has(shot.id) ? '' : 'line-clamp-3'
                        }`}>
                          {shot.imagePrompt || '無'}
                        </div>
                        {(() => {
                          const m = detectCharactersInPrompt(shot.imagePrompt || '');
                          if (!m.length) return null;
                          return (
                            <div className="mt-1 flex flex-wrap gap-1.5 items-center">
                              {m.map((c) => (
                                <div
                                  key={c.id}
                                  className="flex items-center gap-1 rounded border border-amber-500/40 bg-slate-800/90 px-1 py-0.5"
                                  title={`角色：${c.name}`}
                                >
                                  <img src={c.imageUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                                  <span className="max-w-[64px] truncate text-[9px] text-amber-200/95">{c.name}</span>
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                        {shot.imagePrompt && shot.imagePrompt.length > 60 && (
                          <button
                            onClick={() => {
                              setExpandedImagePrompts(prev => {
                                const newSet = new Set(prev);
                                if (newSet.has(shot.id)) {
                                  newSet.delete(shot.id);
                                } else {
                                  newSet.add(shot.id);
                                }
                                return newSet;
                              });
                            }}
                            className="text-[9px] text-blue-400 hover:text-blue-300 self-start"
                          >
                            {expandedImagePrompts.has(shot.id) ? '收起' : '展开'}
                          </button>
                        )}
                        <button
                          onClick={() => {
                            // 提取提示词开头的景别（如"中景,"、"近景,"等）
                            const shotTypeMatch = shot.imagePrompt?.match(/^([^,，]+)[,，]/);
                            const extractedShotType = shotTypeMatch ? shotTypeMatch[1].trim() : '中景';
                            setEditingShotType({ shotId: shot.id, shotType: extractedShotType });
                          }}
                          className="text-[10px] px-1.5 py-0.5 bg-blue-600 hover:bg-blue-500 text-white rounded self-start"
                          title="景别（可编辑）"
                        >
                          {editingShotType?.shotId === shot.id ? (
                            <input
                              type="text"
                              value={editingShotType.shotType}
                              onChange={(e) => setEditingShotType({ ...editingShotType, shotType: e.target.value })}
                              onBlur={() => {
                                // 更新提示词，替换开头的景别
                                if (shot.imagePrompt) {
                                  const newPrompt = shot.imagePrompt.replace(/^[^,，]+[,，]\s*/, `${editingShotType.shotType}, `);
                                  updateShot(shot.id, { imagePrompt: newPrompt, shotType: editingShotType.shotType });
                                } else {
                                  updateShot(shot.id, { imagePrompt: `${editingShotType.shotType}, `, shotType: editingShotType.shotType });
                                }
                                setEditingShotType(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.currentTarget.blur();
                                }
                              }}
                              className="w-12 bg-slate-800 border border-slate-600 rounded px-1 text-[10px] text-slate-200"
                              autoFocus
                            />
                          ) : (
                            shot.shotType || (shot.imagePrompt?.match(/^([^,，]+)[,，]/)?.[1]?.trim()) || '中景'
                          )}
                        </button>
                      </>
                    )}
                  </div>

                  {/* 新图列（图片预览） */}
                  <div className="flex flex-col gap-1">
                    {shot.imageUrls && shot.imageUrls.length > 0 ? (
                      <>
                        {shot.imageUrls.length <= 2 ? (
                          <>
                            {/* 主图 */}
                            <div className="relative">
                              <img
                                src={shot.imageUrls[shot.selectedImageIndex !== undefined && shot.selectedImageIndex >= 0 ? shot.selectedImageIndex : 0]}
                                alt={`镜头${shot.number}-主图`}
                                className="w-full h-32 object-cover rounded border border-slate-700 cursor-pointer"
                                onDoubleClick={() => {
                                  const currentIndex = shot.selectedImageIndex !== undefined && shot.selectedImageIndex >= 0 ? shot.selectedImageIndex : 0;
                                  setEnlargedImageUrl(shot.imageUrls![currentIndex]);
                                }}
                                onClick={() => {
                                  const currentIndex = shot.selectedImageIndex !== undefined && shot.selectedImageIndex >= 0 ? shot.selectedImageIndex : 0;
                                  const nextIndex = (currentIndex + 1) % shot.imageUrls!.length;
                                  updateShot(shot.id, { selectedImageIndex: nextIndex });
                                }}
                              />
                              {shot.imageGenerating && (
                                <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded">
                                  <Loader2 size={16} className="animate-spin text-emerald-400" />
                                </div>
                              )}
                            </div>
                            {/* 缩略图（只有1-2张时显示） */}
                            {shot.imageUrls.length > 1 && (
                              <div className="flex gap-1">
                                {shot.imageUrls.slice(0, 2).map((url, index) => {
                                  const isSelected = (shot.selectedImageIndex !== undefined && shot.selectedImageIndex >= 0 ? shot.selectedImageIndex : 0) === index;
                                  return (
                                    <img
                                      key={index}
                                      src={url}
                                      alt={`缩略图${index + 1}`}
                                      className={`w-12 h-12 object-cover rounded border-2 cursor-pointer ${
                                        isSelected ? 'border-orange-500' : 'border-slate-700'
                                      }`}
                                      onClick={() => updateShot(shot.id, { selectedImageIndex: index })}
                                    />
                                  );
                                })}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            {/* 超过2张时，缩小预览，网格排列 */}
                            <div className="grid grid-cols-2 gap-1">
                              {shot.imageUrls.map((url, index) => {
                                const isSelected = (shot.selectedImageIndex !== undefined && shot.selectedImageIndex >= 0 ? shot.selectedImageIndex : 0) === index;
                                return (
                                  <div key={index} className="relative">
                                    <img
                                      src={url}
                                      alt={`图片${index + 1}`}
                                      className={`w-full h-16 object-cover rounded border-2 cursor-pointer ${
                                        isSelected ? 'border-orange-500' : 'border-slate-700'
                                      }`}
                                      onClick={() => updateShot(shot.id, { selectedImageIndex: index })}
                                      onDoubleClick={() => setEnlargedImageUrl(url)}
                                    />
                                    {isSelected && (
                                      <div className="absolute top-0.5 left-0.5 bg-orange-500 text-white text-[8px] px-1 rounded">
                                        {index + 1}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                            {shot.imageGenerating && (
                              <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded">
                                <Loader2 size={16} className="animate-spin text-emerald-400" />
                              </div>
                            )}
                          </>
                        )}
                      </>
                    ) : (
                      <div className="flex items-center justify-center h-32 bg-slate-800/50 rounded border border-slate-700 text-slate-500 text-[10px]">
                        {shot.imageGenerating ? (
                          <Loader2 size={16} className="animate-spin text-emerald-400" />
                        ) : (
                          '暂无圖片'
                        )}
                      </div>
                    )}
                  </div>

                  {/* 视频提示词列 */}
                  <div className="flex flex-col gap-1">
                    {shot.editing ? (
                      <textarea
                        value={shot.videoPrompt}
                        onChange={(e) => updateShot(shot.id, { videoPrompt: e.target.value })}
                        className="w-full bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-slate-200 resize-none h-16"
                        placeholder="视频提示詞"
                      />
                    ) : (
                      <>
                        <div className={`text-[10px] text-slate-300 leading-relaxed ${
                          expandedVideoPrompts.has(shot.id) ? '' : 'line-clamp-3'
                        }`}>
                          {shot.videoPrompt || '無'}
                        </div>
                        {shot.videoPrompt && shot.videoPrompt.length > 60 && (
                          <button
                            onClick={() => {
                              setExpandedVideoPrompts(prev => {
                                const newSet = new Set(prev);
                                if (newSet.has(shot.id)) {
                                  newSet.delete(shot.id);
                                } else {
                                  newSet.add(shot.id);
                                }
                                return newSet;
                              });
                            }}
                            className="text-[9px] text-blue-400 hover:text-blue-300 self-start"
                          >
                            {expandedVideoPrompts.has(shot.id) ? '收起' : '展开'}
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  {/* 视频列（视频预览，支持多个视频） */}
                  <div className="flex flex-col gap-1">
                    {(() => {
                      // 获取所有视频URL（优先使用 videoUrls 数组，兼容 videoUrl）
                      const videoUrls = shot.videoUrls || (shot.videoUrl ? [shot.videoUrl] : []);
                      const cachedVideoUrls = shot.cachedVideoUrls || (shot.cachedVideoUrl ? [shot.cachedVideoUrl] : []);
                      
                      if (videoUrls.length > 0) {
                        // 显示所有视频（最新的在顶部）
                        return (
                          <div className="flex flex-col gap-1">
                            {videoUrls.map((videoUrl, index) => {
                              const cachedUrl = cachedVideoUrls[index];
                              const isLatest = index === videoUrls.length - 1;
                              return (
                                <div key={index} className="relative">
                                  <VideoPreview 
                                    videoUrl={videoUrl}
                                    cachedVideoUrl={cachedUrl}
                                    shotId={shot.id}
                                  />
                                  {videoUrls.length > 1 && (
                                    <div className="absolute top-1 left-1 bg-slate-900/80 text-[9px] text-slate-300 px-1 py-0.5 rounded">
                                      {isLatest ? '最新' : `视频 ${index + 1}`}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        );
                      } else {
                        // 没有视频
                        return (
                          <div className="flex items-center justify-center h-32 bg-slate-800/50 rounded border border-slate-700 text-slate-500 text-[10px]">
                            {shot.videoGenerating ? (
                              <Loader2 size={16} className="animate-spin text-purple-400" />
                            ) : (
                              '暂无视频'
                            )}
                          </div>
                        );
                      }
                    })()}
                  </div>

                  {/* 操作列 */}
                  <div className="flex flex-col gap-1 items-end pr-2">
                    <button
                      onClick={async () => {
                        try {
                          await handleGenerateImage(shot, true);
                        } catch (error: any) {
                          toast.error(`图片生成失败: ${error.message || '未知错误'}`, 6000);
                        }
                      }}
                      disabled={shot.imageGenerating}
                      className="text-[10px] px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50 whitespace-nowrap"
                      title="重新绘图"
                    >
                      重新繪圖
                    </button>
                    <button
                      type="button"
                      disabled={shot.voiceGenerating}
                      onClick={async () => {
                        if (shot.voiceAudioUrl) {
                          // 已有音频 → 直接试听（兼容历史相对路径 api/xxx.wav）
                          const u = shot.voiceAudioUrl.trim();
                          const src =
                            /^https?:|^data:|^blob:/i.test(u) ? u : resolveRunningHubOutputUrl(u);
                          try {
                            await new Audio(src).play();
                            toast.success('试听播放中', 2500);
                          } catch {
                            toast.error('音频播放失败，可能是浏览器静音或 URL 无效', 4000);
                          }
                          return;
                        }
                        // 无音频 → 先生成再试听
                        try {
                          await synthesizeVoiceForShot(shot, { playAfter: true });
                          toast.success('试听播放中', 2500);
                        } catch (e: any) {
                          toast.error(e?.message || '配音生成失败', 6000);
                        }
                      }}
                      className="text-[10px] px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded whitespace-nowrap disabled:opacity-50"
                      title={shot.voiceAudioUrl ? '点击试听已有配音' : '使用 RunningHub 生成配音（语音库可选；未配置则用系统默认参考音）'}
                    >
                      {shot.voiceGenerating ? '生成中…' : shot.voiceAudioUrl ? '音频试听' : '生成音频'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void handleGenerateVideo(shot).catch(() => {});
                      }}
                      disabled={shot.videoGenerating || !shot.videoPrompt}
                      className="text-[10px] px-2 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded disabled:opacity-50 whitespace-nowrap"
                      title="制作动画（RunningHub Wan2.2 / LTX-2）"
                    >
                      製作動畫
                    </button>
                    <button
                      onClick={() => {
                        setEditingShotId(shot.id);
                        updateShot(shot.id, { editing: !shot.editing });
                      }}
                      className={`text-[10px] px-2 py-1 rounded whitespace-nowrap ${
                        shot.editing 
                          ? 'bg-orange-600 hover:bg-orange-500 text-white border-2 border-orange-400' 
                          : 'bg-slate-700 hover:bg-slate-600 text-white'
                      }`}
                      title="镜头设置"
                    >
                      镜头设置
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>

      {/* 图片放大模态框 */}
      {enlargedImageUrl && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setEnlargedImageUrl(null)}
        >
          <div className="relative max-w-7xl max-h-[90vh]">
            <button
              onClick={() => setEnlargedImageUrl(null)}
              className="absolute top-4 right-4 bg-slate-800 hover:bg-slate-700 text-white rounded-full p-2 z-10"
            >
              <X size={24} />
            </button>
            <img
              src={enlargedImageUrl}
              alt="放大預覽"
              className="max-w-full max-h-[90vh] rounded-lg border-2 border-slate-700"
              onClick={(e) => e.stopPropagation()}
            />
            <a
              href={enlargedImageUrl}
                download
              className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-all"
              onClick={(e) => e.stopPropagation()}
              >
                <Download size={16} />
              下載圖片
              </a>
          </div>
        </div>
      )}

      {/* 视频播放模态框 */}
      {enlargedVideoUrl && (
        <div
          className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4"
          onClick={() => setEnlargedVideoUrl(null)}
        >
          <div className="relative max-w-7xl max-h-[90vh] w-full">
            <button
              onClick={() => setEnlargedVideoUrl(null)}
              className="absolute top-4 right-4 bg-slate-800 hover:bg-slate-700 text-white rounded-full p-2 z-10"
            >
              <X size={24} />
            </button>
            <video
              src={enlargedVideoUrl}
              controls
              autoPlay
              className="max-w-full max-h-[90vh] rounded-lg border-2 border-slate-700"
              onClick={(e) => e.stopPropagation()}
            />
            <a
              href={enlargedVideoUrl}
              download
              className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium rounded transition-all"
              onClick={(e) => e.stopPropagation()}
            >
              <Download size={16} />
              下载视频
            </a>
          </div>
        </div>
      )}
      
      {/* 脚本历史记录选择器 */}
      {showScriptHistorySelector && (
        <HistorySelector
          records={scriptHistoryRecords}
          onSelect={handleHistorySelectorSelect}
          primarySelectLabel={historySelectorKind === 'media' ? '载入主工作区' : undefined}
          onViewSnapshot={
            historySelectorKind === 'media'
              ? (record) => {
                  const pid = record.metadata?.mediaProjectId as string | undefined;
                  if (!pid?.trim()) return;
                  openMediaProjectWorkspaceTab(pid.trim());
                  setShowScriptHistorySelector(false);
                  setHistorySelectorKind(null);
                }
              : undefined
          }
          onClose={() => {
            setShowScriptHistorySelector(false);
            setHistorySelectorKind(null);
          }}
          onDelete={(record) => {
            persistDeleteHistoryRecord(record);
            setScriptHistoryRecords((prev) => {
              const next = prev.filter((r) => !historyRecordRowMatch(r, record));
              if (next.length === 0) {
                setShowScriptHistorySelector(false);
                setHistorySelectorKind(null);
              }
              return next;
            });
            toast.success('已删除该条记录', 2500);
          }}
          onClearAll={() => {
            persistClearAllHistoryRecords();
            setScriptHistoryRecords([]);
            setShowScriptHistorySelector(false);
            setHistorySelectorKind(null);
            toast.success('已清空全部历史记录', 3000);
          }}
          title={
            historySelectorKind === 'media' ? '媒体生成历史记录' : '选择脚本历史记录'
          }
        />
      )}

      {/* 角色库管理 */}
      {showCharacterLibrary && (
        <CharacterLibrary
          onClose={() => setShowCharacterLibrary(false)}
        />
      )}

      {/* 语音库管理 */}
      {showVoiceLibrary && (
        <VoiceLibrary
          onClose={() => setShowVoiceLibrary(false)}
          onVoicesChange={() => setVoiceLibraryEpoch((e) => e + 1)}
        />
      )}
    </div>
  );
};
