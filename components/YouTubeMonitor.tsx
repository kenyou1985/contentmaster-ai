import React, { useState, useEffect } from 'react';
import { 
  Search, 
  Video, 
  Monitor, 
  Download, 
  ExternalLink, 
  Loader2, 
  Settings, 
  Eye, 
  Clock, 
  RefreshCw,
  Rss,
  Trash2,
  Plus,
  Copy,
  Check,
  CheckCircle,
  AlertCircle,
  Youtube,
  ThumbsUp,
  Tag,
  Link2,
  ChevronDown,
  ChevronUp,
  FileText,
  Music,
  Image,
  Subtitles,
  MessageCircle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

// ============================================================
// API配置
// ============================================================
// YouTube Data API v3 - 从环境变量获取（Vercel部署时配置）
const YOUTUBE_API_KEY = (import.meta as any).env?.VITE_YOUTUBE_API_KEY || '';
/** 可选：Railway MeTube 公网根地址，用于设置里「打开 MeTube」链接（勿与 METUBE_URL 混用：后者在服务端） */
const VITE_METUBE_PUBLIC_URL = ((import.meta as any).env?.VITE_METUBE_PUBLIC_URL as string | undefined)?.trim() || '';

type MetubeDownloadKind = 'video' | 'audio' | 'captions' | 'thumbnail';

function metubeHistoryEntryRelPath(item: Record<string, unknown>): string | null {
  const e = item.entry;
  if (typeof e === 'string' && e.trim()) return e.trim();
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o.filename === 'string') return o.filename;
    if (typeof o.filepath === 'string') return o.filepath;
    if (typeof o._filename === 'string') return o._filename;
  }
  if (typeof item.filename === 'string') return item.filename;
  const ch = item.chapter_files;
  if (Array.isArray(ch) && ch.length && typeof ch[0] === 'string') return ch[0];
  return null;
}

/** 已完成任务直链（需配置 VITE_METUBE_PUBLIC_URL 为 MeTube 公网根地址，与 Railway 域名一致） */
function metubePublicFileHref(publicBase: string, item: Record<string, unknown>): string | null {
  const rel = metubeHistoryEntryRelPath(item);
  if (!rel || !publicBase.trim()) return null;
  const base = publicBase.trim().replace(/\/$/, '');
  return `${base}/download/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

async function metubePostAdd(body: Record<string, unknown>): Promise<void> {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const res = await fetch(`${origin}/api/metube/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* keep */
    }
    throw new Error(msg || `MeTube ${res.status}`);
  }
}

  /** 同源 Invidious 代理（Vercel: api/invidious；开发: vite 中间件）。勿把 MeTube 当作 Invidious。 */
function invidiousProxyUrl(path: string, query: Record<string, string> = {}): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const params = new URLSearchParams({ path, ...query });
  return `${origin}/api/invidious?${params.toString()}`;
}

/**
 * 触发文件下载：优先在用户点击瞬间同步打开新标签（即时反馈，避免误以为无响应）；
 * 若弹窗被拦截或新窗口失败，再回退 fetch+Blob 以尽量指定文件名。
 */
async function forceDownloadFile(url: string, filename?: string) {
  let opened = false;
  try {
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    opened = !!w;
  } catch {
    opened = false;
  }

  if (opened) {
    return;
  }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`下载失败: ${res.status} ${res.statusText}`);
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || getFilenameFromUrl(url) || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  } catch (e) {
    console.error('下载失败:', e);
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      /* ignore */
    }
  }
}

/** 从 URL 中提取文件名 */
function getFilenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const pathname = u.pathname;
    const parts = pathname.split('/');
    const last = parts[parts.length - 1];
    if (last && last.includes('.')) {
      return decodeURIComponent(last);
    }
  } catch { /* ignore */ }
  return null;
}

async function fetchInvidiousJson<T>(path: string, query: Record<string, string> = {}): Promise<T> {
  const res = await fetch(invidiousProxyUrl(path, query));
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new Error(text.slice(0, 240) || `HTTP ${res.status}`);
  }
  const errObj = data as { error?: string; detail?: string };
  if (!res.ok) {
    const err = errObj?.error;
    const detail = errObj?.detail;
    throw new Error(
      [err || `HTTP ${res.status}`, detail].filter(Boolean).join(' — ')
    );
  }
  if (
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    typeof errObj.error === 'string' &&
    errObj.error.trim()
  ) {
    throw new Error([errObj.error.trim(), errObj.detail].filter(Boolean).join(' — '));
  }
  return data as T;
}

function normalizeMetubeHistoryPayload(data: unknown): any[] {
  if (!data || typeof data !== 'object') return [];
  const o = data as Record<string, unknown>;
  if (Array.isArray(data)) return data;
  const done = Array.isArray(o.done) ? o.done : [];
  const queue = Array.isArray(o.queue) ? o.queue : [];
  const pending = Array.isArray(o.pending) ? o.pending : [];
  const merged = [...done, ...queue, ...pending];
  merged.sort((a: any, b: any) => {
    const ta = Number(a?.added ?? a?.timestamp ?? a?.created ?? 0);
    const tb = Number(b?.added ?? b?.timestamp ?? b?.created ?? 0);
    return tb - ta;
  });
  return merged;
}

async function fetchMetubeHistory(): Promise<any[]> {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const res = await fetch(`${origin}/api/metube/history`);
  if (!res.ok) return [];
  try {
    const text = await res.text();
    const data = JSON.parse(text);
    let list = normalizeMetubeHistoryPayload(data);
    if (!list.length && (data as any)?.history != null) {
      list = normalizeMetubeHistoryPayload((data as any).history);
    }
    return list;
  } catch {
    return [];
  }
}

// ============================================================
// 类型定义
// ============================================================
interface YouTubeVideo {
  id: string;
  snippet: {
    title: string;
    description: string;
    thumbnails: { high: { url: string }, medium: { url: string }, default: { url: string } };
    publishedAt: string;
    channelId: string;
    channelTitle: string;
  };
  statistics?: {
    viewCount: string;
    likeCount?: string;
  };
  contentDetails?: {
    duration: string;
  };
}

interface YouTubeChannel {
  id: string;
  snippet: {
    title: string;
    description: string;
    thumbnails: { high: { url: string }, medium: { url: string }, default: { url: string } };
  };
  statistics: {
    subscriberCount: string;
    videoCount: string;
    viewCount: string;
  };
}

interface InvidiousVideo {
  videoId: string;
  title: string;
  videoThumbnails: { url: string; width: number; height: number }[];
  publishedText: string;
  published: number;
  viewCountText: string;
  viewCount: number;
  lengthSeconds: number;
  liveNow: boolean;
  url: string;
}

interface InvidiousChannel {
  author: string;
  authorId: string;
  authorUrl: string;
  authorThumbnails: { url: string; width: number; height: number }[];
  subscriberCount: number;
  videoCount: number;
}

interface MonitoredChannel {
  id: string;
  channelId: string;
  name: string;
  lastChecked: string;
  lastVideoDate: string | null;
  lastVideoTitle: string | null;
}

// ============================================================
// 工具函数
// ============================================================
const extractVideoId = (url: string): string => {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return '';
};

const extractChannelId = (url: string): string => {
  const patterns = [
    /youtube\.com\/channel\/([^/\n?#]+)/,
    /youtube\.com\/@([^/\n?#]+)/,
    /youtube\.com\/c\/([^/\n?#]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return '';
};

const formatDuration = (isoDuration: string): string => {
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '0:00';
  const h = parseInt(match[1] || '0');
  const m = parseInt(match[2] || '0');
  const s = parseInt(match[3] || '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const formatNumber = (num: number): string => {
  if (num >= 100000000) return (num / 100000000).toFixed(1) + '亿';
  if (num >= 10000) return (num / 10000).toFixed(1) + '万';
  return num.toLocaleString();
};

const parseViewCount = (text: string): number => {
  const match = text.match(/[\d,]+/);
  if (!match) return 0;
  return parseInt(match[0].replace(/,/g, ''));
};

/** Invidious 字幕经同源代理下载（WebVTT） */
function invidiousCaptionHref(videoId: string, label: string, lang?: string): string {
  const q: Record<string, string> = { label };
  if (lang) q.lang = lang;
  return invidiousProxyUrl(`captions/${videoId}`, q);
}

function normalizeInvidiousKeywords(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/** 官方 API 返回的频道/视频条目带 snippet；Invidious 无 snippet */
function isOfficialYoutubeSnippetPayload(obj: unknown): boolean {
  return !!obj && typeof obj === 'object' && (obj as { snippet?: unknown }).snippet != null;
}

/** 官方配额/限流类错误时可尝试 Invidious（需服务端配置 INVIDIOUS_UPSTREAM_URL） */
function isYoutubeQuotaOrLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('quota')) return true;
  if (msg.includes('ratelimit') || msg.includes('rate limit')) return true;
  if (msg.includes('exceeded your')) return true;
  if (msg.includes('usage limit') || msg.includes('daily limit')) return true;
  return false;
}

function sanitizeDownloadBasename(name: string): string {
  const s = String(name || 'download').replace(/[/\\?%*:|"<>]/g, '_').trim() || 'download';
  return s.slice(0, 180);
}

/** 本地保存文件名扩展名（需与 MeTube download_type / format 一致） */
function extensionForMetubeDownload(
  kind: MetubeDownloadKind,
  captionFormat: string,
  audioFormat: string
): string {
  switch (kind) {
    case 'thumbnail':
      return 'jpg';
    case 'captions': {
      const f = (captionFormat || 'srt').toLowerCase();
      if (f === 'vtt') return 'vtt';
      if (f === 'txt') return 'txt';
      if (f === 'ttml') return 'ttml';
      return 'srt';
    }
    case 'audio':
      return (audioFormat || 'm4a').toLowerCase();
    case 'video':
    default:
      return 'mp4';
  }
}

/** MeTube 历史记录项 → 建议本地文件名（避免封面/字幕被误标成 .mp4） */
function metubeHistoryItemDownloadName(item: Record<string, unknown>): string {
  const title = sanitizeDownloadBasename(
    String(
      item.title ??
        item.name ??
        (typeof item.video === 'object' && item.video && (item.video as { title?: string }).title) ??
        'download'
    )
  );
  const rawType = String(item.type ?? item.download_type ?? '').toLowerCase();
  const fmt = String(item.format ?? item.codec ?? '').toLowerCase();
  if (rawType.includes('thumb') || fmt === 'jpg' || fmt === 'jpeg' || fmt === 'png') {
    return `${title}.${fmt === 'png' ? 'png' : 'jpg'}`;
  }
  if (rawType.includes('caption') || rawType.includes('captions') || ['srt', 'vtt', 'txt', 'ttml'].includes(fmt)) {
    const ext = fmt === 'vtt' ? 'vtt' : fmt === 'txt' ? 'txt' : fmt === 'ttml' ? 'ttml' : 'srt';
    return `${title}.${ext}`;
  }
  if (rawType.includes('audio') || ['m4a', 'mp3', 'opus', 'wav', 'flac'].includes(fmt)) {
    return `${title}.${fmt || 'm4a'}`;
  }
  return `${title}.mp4`;
}

function metubeHistoryItemMatchesKind(item: Record<string, unknown>, kind: MetubeDownloadKind): boolean {
  const rawType = String(item.type ?? item.download_type ?? '').toLowerCase();
  const fmt = String(item.format ?? item.codec ?? '').toLowerCase();
  if (kind === 'thumbnail') {
    return rawType.includes('thumb') || fmt === 'jpg' || fmt === 'jpeg' || fmt === 'png';
  }
  if (kind === 'captions') {
    return rawType.includes('caption') || ['srt', 'vtt', 'txt', 'ttml'].includes(fmt);
  }
  if (kind === 'audio') {
    return rawType.includes('audio') || ['m4a', 'mp3', 'opus', 'wav', 'flac'].includes(fmt);
  }
  if (kind === 'video') {
    if (!rawType && !fmt) return true;
    if (rawType.includes('thumb') || fmt === 'jpg' || fmt === 'jpeg') return false;
    if (rawType.includes('caption') || ['srt', 'vtt'].includes(fmt)) return false;
    if (rawType.includes('audio')) return false;
    return rawType.includes('video') || fmt === 'mp4' || fmt === 'webm' || fmt === 'mkv' || !rawType;
  }
  return true;
}

// ============================================================
// API调用函数
// ============================================================

// YouTube Data API v3 调用
const youtubeApi = {
  searchChannels: async (query: string, apiKey: string): Promise<YouTubeChannel[]> => {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(query)}&maxResults=10&key=${apiKey}`
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    
    if (!data.items?.length) return [];
    
    const channelIds = data.items.map((i: any) => i.id.channelId).join(',');
    const detailsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${channelIds}&key=${apiKey}`
    );
    const details = await detailsRes.json();
    return details.items || [];
  },

  getChannelVideos: async (channelId: string, apiKey: string, maxResults: number = 10): Promise<YouTubeVideo[]> => {
    const searchRes = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=${maxResults}&order=date&type=video&key=${apiKey}`
    );
    const searchData = await searchRes.json();
    if (searchData.error) throw new Error(searchData.error.message);
    
    if (!searchData.items?.length) return [];
    
    const videoIds = searchData.items.map((i: any) => i.id.videoId).join(',');
    const detailsRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${videoIds}&key=${apiKey}`
    );
    const details = await detailsRes.json();
    
    return searchData.items.map((item: any, idx: number) => ({
      ...item,
      statistics: details.items[idx]?.statistics,
      contentDetails: details.items[idx]?.contentDetails,
    }));
  },

  getVideoDetails: async (videoId: string, apiKey: string): Promise<YouTubeVideo> => {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoId}&key=${apiKey}`
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.items[0];
  },

  getChannelById: async (channelId: string, apiKey: string): Promise<YouTubeChannel | null> => {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${apiKey}`
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.items?.[0] ?? null;
  },
};

// Invidious API（经本站代理，避免第三方实例 CORS）
const invidiousApi = {
  searchChannels: async (query: string): Promise<InvidiousChannel[]> => {
    const data = await fetchInvidiousJson<unknown[]>('search', {
      q: query,
      type: 'channel',
    });
    if (!Array.isArray(data)) return [];
    return data.slice(0, 10).filter((i: any) => i.type === 'channel');
  },

  getChannelVideos: async (channelId: string, page: number = 1, pageSize: number = 10): Promise<InvidiousVideo[]> => {
    // Invidious API 支持 page 参数
    const data = await fetchInvidiousJson<{ videos?: InvidiousVideo[] }>(
      `channels/${channelId}/videos`,
      { page: String(page) }
    );
    const videos = data.videos || [];
    return videos.slice(0, pageSize);
  },

  getVideoDetails: async (videoId: string): Promise<any> => {
    return fetchInvidiousJson(`videos/${videoId}`, {});
  },

  /** 频道详情（用于 UC ID / 监控列表打开） */
  getChannel: async (channelId: string): Promise<any> => {
    return fetchInvidiousJson(`channels/${channelId}`, {});
  },
};

// ============================================================
// 主组件
// ============================================================
export const YouTubeMonitor: React.FC = () => {
  // 状态
  const [userYoutubeApiKey, setUserYoutubeApiKey] = useState(() => localStorage.getItem('YOUTUBE_API_KEY') || '');
  const [showSettings, setShowSettings] = useState(false);
  
  // 搜索
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [cookiesPaste, setCookiesPaste] = useState('');
  const [cookiesUploading, setCookiesUploading] = useState(false);
  const [cookiesHint, setCookiesHint] = useState<string | null>(null);
  const [cookieStatusText, setCookieStatusText] = useState<string | null>(null);
  /** MeTube 下载历史（轮询展示） */
  const [metubeHistory, setMetubeHistory] = useState<any[]>([]);
  const [metubeHistoryLoading, setMetubeHistoryLoading] = useState(false);
  
  // 下载进度跟踪：key = url+kind, value = 状态
  type DownloadStatus = 'queued' | 'downloading' | 'completed' | 'error';
  const [activeDownloads, setActiveDownloads] = useState<Record<string, { status: DownloadStatus; progress?: number; error?: string; uid?: string; fileHref?: string }>>({});
  
  // 频道详情
  const [selectedChannel, setSelectedChannel] = useState<any>(null);
  const [channelVideos, setChannelVideos] = useState<any[]>([]);
  const [isLoadingVideos, setIsLoadingVideos] = useState(false);
  
  // 分页
  const [videoPage, setVideoPage] = useState(1);
  const [videoPageSize, setVideoPageSize] = useState(10);
  const [hasMoreVideos, setHasMoreVideos] = useState(false);
  
  // 视频解析
  const [videoUrl, setVideoUrl] = useState('');
  const [parsedVideo, setParsedVideo] = useState<any>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  
  // 监控列表
  const [monitoredChannels, setMonitoredChannels] = useState<MonitoredChannel[]>(() => {
    const saved = localStorage.getItem('YOUTUBE_MONITORED_CHANNELS');
    return saved ? JSON.parse(saved) : [];
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  // 复制状态
  const [copiedId, setCopiedId] = useState<string | null>(null);

  /** 按链接 / UC / @ 打开频道 */
  const [channelLinkInput, setChannelLinkInput] = useState('');
  const [resolvingChannel, setResolvingChannel] = useState(false);
  /** MeTube 下载类型与参数（与 alexta69/metube POST /add 一致） */
  const [metubeKind, setMetubeKind] = useState<MetubeDownloadKind>('video');
  const [metubeVideoQuality, setMetubeVideoQuality] = useState('best');
  const [metubeAudioFormat, setMetubeAudioFormat] = useState('m4a');
  const [metubeAudioQuality, setMetubeAudioQuality] = useState('best');
  const [metubeCaptionFormat, setMetubeCaptionFormat] = useState('srt');
  /** 字幕语言：auto 时不传 subtitle_language，交给 MeTube/yt-dlp 自动选轨 */
  const [metubeSubtitleLanguage, setMetubeSubtitleLanguage] = useState<
    'auto' | 'en' | 'zh-Hans' | 'zh-Hant' | 'ja' | 'ko'
  >('auto');
  const [descExpanded, setDescExpanded] = useState(false);

  // 使用的API
  const activeApiKey = YOUTUBE_API_KEY || userYoutubeApiKey;
  const isUsingOfficialApi = !!activeApiKey;
  /** 配置了官方 Key，但当前会话因配额/限流已改用 Invidious 拉取元数据 */
  const [quotaFallbackActive, setQuotaFallbackActive] = useState(false);

  useEffect(() => {
    if (!isUsingOfficialApi) setQuotaFallbackActive(false);
  }, [isUsingOfficialApi]);

  // 保存用户输入的API Key
  useEffect(() => {
    if (userYoutubeApiKey) {
      localStorage.setItem('YOUTUBE_API_KEY', userYoutubeApiKey);
    }
  }, [userYoutubeApiKey]);

  // 保存监控列表
  useEffect(() => {
    localStorage.setItem('YOUTUBE_MONITORED_CHANNELS', JSON.stringify(monitoredChannels));
  }, [monitoredChannels]);

  /** 获取下载唯一标识（url + kind） */
  const getDownloadKey = (url: string, kind?: MetubeDownloadKind) => {
    const k = kind || metubeKind;
    return `${url}::${k}`;
  };

  /** 轮询下载状态的轮询器引用 */
  let historyPoller: ReturnType<typeof setTimeout> | null = null;

  /** 清理历史轮询器 */
  const clearHistoryPoller = () => {
    if (historyPoller) {
      clearTimeout(historyPoller);
      historyPoller = null;
    }
  };

  /** 轮询下载历史并更新状态 */
  const pollDownloadStatus = async (url: string, kind: MetubeDownloadKind, maxAttempts = 60) => {
    const dlKey = getDownloadKey(url, kind);
    let attempts = 0;

    const poll = async () => {
      attempts++;
      const hist = await fetchMetubeHistory();
      setMetubeHistory(hist.slice(0, 20));

      const vid = url.split('v=')[1]?.split('&')[0] || '';
      const urlMatches = (h: Record<string, unknown>) => {
        const hUrl = String(h.url || '');
        const normalizedUrl = hUrl.replace(/^https?:\/\/(www\.)?youtu\.be\//, 'https://youtube.com/watch?v=');
        return normalizedUrl === url || (vid.length > 0 && hUrl.includes(vid));
      };
      const candidates = (hist as Record<string, unknown>[])
        .filter(urlMatches)
        .filter((h) => metubeHistoryItemMatchesKind(h, kind))
        .sort((a, b) => {
          const ta = Number(a.added ?? a.timestamp ?? a.created ?? 0);
          const tb = Number(b.added ?? b.timestamp ?? b.created ?? 0);
          return tb - ta;
        });
      const item = candidates[0] as Record<string, unknown> | undefined;

      if (item) {
        const status = String(item.status || item.state || '').toLowerCase();
        if (['completed', 'done', 'finished'].includes(status)) {
          // 下载完成，获取文件链接
          const fileHref = VITE_METUBE_PUBLIC_URL
            ? metubePublicFileHref(VITE_METUBE_PUBLIC_URL, item)
            : null;
          setActiveDownloads(prev => ({
            ...prev,
            [dlKey]: { status: 'completed', progress: 100, uid: item.uid, fileHref }
          }));
          clearHistoryPoller();
          return;
        } else if (['error', 'failed'].includes(status) || item.error) {
          setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: item.error || '下载失败' } }));
          clearHistoryPoller();
          return;
        } else {
          // 下载中，根据进度估算
          const progress = Math.min(95, Math.round((attempts / maxAttempts) * 100));
          setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'downloading', progress, uid: item.uid } }));
        }
      } else {
        // 未找到（可能还在队列中）
        setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'queued', progress: Math.min(20, attempts * 2) } }));
      }

      if (attempts < maxAttempts) {
        historyPoller = setTimeout(poll, 3000);
      } else {
        // 超时，假设已完成或需要手动检查
        setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: '下载超时，请到 MeTube 检查' } }));
        clearHistoryPoller();
      }
    };

    clearHistoryPoller();
    poll();
  };

  /** 提交到 MeTube 下载队列（支持指定类型） */
  const queueMetubeDownload = async (url: string, kind?: MetubeDownloadKind) => {
    const dlKind = kind || metubeKind;
    const dlKey = getDownloadKey(url, dlKind);

    // 设置初始状态
    setActiveDownloads(prev => ({
      ...prev,
      [dlKey]: { status: 'downloading', progress: 5 }
    }));

    setInfoMsg(null);
    setSearchError(null);

    try {
      // 根据类型构建不同的 payload
      const payload = buildMetubePayloadWithKind(url, dlKind);
      await metubePostAdd(payload);

      setInfoMsg(`已提交「${getKindLabel(dlKind)}」到 MeTube 队列，正在等待完成…`);

      // 开始轮询下载状态
      pollDownloadStatus(url, dlKind);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : 'MeTube 提交失败';
      setSearchError(errMsg);
      setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: errMsg } }));
    }
  };

  /** 获取下载类型标签 */
  const getKindLabel = (kind: MetubeDownloadKind): string => {
    switch (kind) {
      case 'video': return '视频';
      case 'audio': return '音频';
      case 'captions': return '字幕';
      case 'thumbnail': return '封面图';
      default: return '文件';
    }
  };

  /** 根据类型构建 MeTube payload */
  const buildMetubePayloadWithKind = (url: string, kind: MetubeDownloadKind): Record<string, unknown> => {
    const u = url.trim();
    const base: Record<string, unknown> = { url: u, auto_start: true };
    switch (kind) {
      case 'video':
        return {
          ...base,
          download_type: 'video',
          quality: metubeVideoQuality,
          format: 'any',
          codec: 'auto',
        };
      case 'audio':
        return {
          ...base,
          download_type: 'audio',
          format: metubeAudioFormat,
          quality: metubeAudioQuality,
        };
      case 'captions': {
        const cap: Record<string, unknown> = {
          ...base,
          download_type: 'captions',
          format: metubeCaptionFormat,
          quality: 'best',
          codec: 'auto',
          subtitle_mode: 'prefer_manual',
        };
        if (metubeSubtitleLanguage !== 'auto') {
          cap.subtitle_language = metubeSubtitleLanguage;
        }
        return cap;
      }
      case 'thumbnail':
        return {
          ...base,
          download_type: 'thumbnail',
          format: 'jpg',
          quality: 'best',
          codec: 'auto',
        };
      default:
        return { ...base, download_type: 'video', quality: 'best', format: 'any', codec: 'auto' };
    }
  };

  const uploadCookiesToMetube = async () => {
    const text = cookiesPaste.trim();
    if (!text) {
      setCookiesHint('请先粘贴 Netscape 格式的 cookies.txt 内容');
      return;
    }
    setCookiesUploading(true);
    setCookiesHint(null);
    try {
      const origin = window.location.origin;
      const res = await fetch(`${origin}/api/metube/upload-cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookiesText: text }),
      });
      const t = await res.text();
      if (!res.ok) {
        setCookiesHint(t.slice(0, 400) || `上传失败 HTTP ${res.status}`);
        return;
      }
      setCookiesHint('已上传到 MeTube（若仍失败请检查 Railway Volume 与 MeTube 版本是否支持 /upload-cookies）。');
    } catch (e) {
      setCookiesHint(e instanceof Error ? e.message : '上传失败');
    } finally {
      setCookiesUploading(false);
    }
  };

  const refreshCookieStatus = async () => {
    setCookieStatusText(null);
    try {
      const origin = window.location.origin;
      const res = await fetch(`${origin}/api/metube/cookie-status`);
      const t = await res.text();
      setCookieStatusText(t.slice(0, 2000));
    } catch (e) {
      setCookieStatusText(e instanceof Error ? e.message : String(e));
    }
  };

  const refreshMetubeHistory = async () => {
    setMetubeHistoryLoading(true);
    const hist = await fetchMetubeHistory();
    setMetubeHistory(hist.slice(0, 10));
    setMetubeHistoryLoading(false);
  };

  const selectChannel = (channel: any) => {
    setSelectedChannel(channel);
    setVideoPage(1);
    fetchChannelVideos(channel, 1, videoPageSize);
  };

  /** 加载更多视频（下一页） */
  const loadMoreVideos = () => {
    const nextPage = videoPage + 1;
    setVideoPage(nextPage);
    fetchChannelVideos(selectedChannel, nextPage, videoPageSize, true);
  };

  /** 切换每页显示数量 */
  const changePageSize = (size: number) => {
    setVideoPageSize(size);
    setVideoPage(1);
    fetchChannelVideos(selectedChannel, 1, size);
  };

  /** 用频道 ID 拉取元数据并打开视频列表（监控列表 / 直链解析共用） */
  const openChannelByChannelId = async (channelId: string) => {
    setSearchError(null);
    setInfoMsg(null);
    try {
      if (isUsingOfficialApi) {
        try {
          const ch = await youtubeApi.getChannelById(channelId, activeApiKey);
          if (!ch) {
            setSearchError('频道不存在或 ID 无效');
            return;
          }
          setQuotaFallbackActive(false);
          selectChannel(ch);
        } catch (e: unknown) {
          if (!isYoutubeQuotaOrLimitError(e)) throw e;
          setQuotaFallbackActive(true);
          setInfoMsg(
            'YouTube 官方 API 配额已满或受限，已通过 Invidious 打开频道。建议在 Google Cloud 提升配额，或保留 Vercel 的 INVIDIOUS_UPSTREAM_URL 作为备用。'
          );
          const raw = await invidiousApi.getChannel(channelId);
          const normalized = {
            type: 'channel',
            authorId: raw.authorId || channelId,
            author: raw.author || raw.title || channelId,
            authorUrl: raw.authorUrl || '',
            authorThumbnails: raw.authorThumbnails || [],
            subscriberCount: raw.subscriberCount ?? 0,
            videoCount: raw.videoCount ?? 0,
          };
          selectChannel(normalized);
        }
      } else {
        const raw = await invidiousApi.getChannel(channelId);
        const normalized = {
          type: 'channel',
          authorId: raw.authorId || channelId,
          author: raw.author || raw.title || channelId,
          authorUrl: raw.authorUrl || '',
          authorThumbnails: raw.authorThumbnails || [],
          subscriberCount: raw.subscriberCount ?? 0,
          videoCount: raw.videoCount ?? 0,
        };
        selectChannel(normalized);
      }
    } catch (e: unknown) {
      setSearchError(e instanceof Error ? e.message : '打开频道失败');
      setChannelVideos([]);
      setSelectedChannel(null);
    }
  };

  const openMonitoredChannel = (c: MonitoredChannel) => {
    void openChannelByChannelId(c.channelId);
  };

  /** 粘贴频道页链接、UC…、或 @用户名 搜索 */
  const resolveChannelFromInput = async () => {
    const raw = channelLinkInput.trim();
    if (!raw) return;
    setResolvingChannel(true);
    setSearchError(null);
    setInfoMsg(null);
    try {
      const ucMatch = raw.match(/UC[\w-]{22}/);
      if (ucMatch) {
        await openChannelByChannelId(ucMatch[0]);
        return;
      }
      const chUrl = raw.match(/youtube\.com\/channel\/([^/?#]+)/i);
      if (chUrl?.[1]?.startsWith('UC')) {
        await openChannelByChannelId(chUrl[1]);
        return;
      }
      const handleMatch = raw.match(/youtube\.com\/@([^/?#]+)/i);
      const handle = handleMatch ? handleMatch[1] : raw.startsWith('@') ? raw.slice(1) : null;
      const searchTerm = handle || raw;
      let results: any[] = [];
      if (isUsingOfficialApi) {
        try {
          results = await youtubeApi.searchChannels(searchTerm, activeApiKey);
          setQuotaFallbackActive(false);
        } catch (e: unknown) {
          if (!isYoutubeQuotaOrLimitError(e)) throw e;
          setQuotaFallbackActive(true);
          setInfoMsg(
            'YouTube 官方 API 配额已满或受限，已通过 Invidious 搜索频道。'
          );
          results = await invidiousApi.searchChannels(searchTerm);
        }
      } else {
        results = await invidiousApi.searchChannels(searchTerm);
      }
      setSearchResults(results);
      if (results[0]) {
        selectChannel(results[0]);
      } else {
        setSearchError('未找到频道，请换关键词或粘贴完整频道链接 / UC ID');
      }
    } catch (e: unknown) {
      setSearchError(e instanceof Error ? e.message : '解析频道失败');
    } finally {
      setResolvingChannel(false);
    }
  };

  // 搜索频道
  const searchChannels = async (overrideQuery?: string) => {
    const q = (overrideQuery ?? searchQuery).trim();
    if (!q) return;
    
    setIsSearching(true);
    setSearchError(null);
    setInfoMsg(null);
    try {
      let results: any[] = [];
      
      if (isUsingOfficialApi) {
        try {
          results = await youtubeApi.searchChannels(q, activeApiKey);
          setQuotaFallbackActive(false);
        } catch (e: unknown) {
          if (!isYoutubeQuotaOrLimitError(e)) throw e;
          setQuotaFallbackActive(true);
          setInfoMsg(
            'YouTube 官方 API 配额已满或受限，已通过 Invidious 完成搜索。'
          );
          results = await invidiousApi.searchChannels(q);
        }
      } else {
        results = await invidiousApi.searchChannels(q);
      }
      
      setSearchResults(results);
      if (results.length === 0) {
        setSearchError('未找到相关频道');
      }
    } catch (error: any) {
      console.error('搜索失败:', error);
      setSearchError(`搜索失败: ${error.message}`);
    } finally {
      setIsSearching(false);
    }
  };

  // 获取频道视频
  const fetchChannelVideos = async (channel: any, page: number = 1, pageSize: number = 10, append: boolean = false) => {
    setIsLoadingVideos(true);
    try {
      let videos: any[] = [];
      const cid = channel.id || channel.authorId;

      if (isUsingOfficialApi) {
        try {
          videos = await youtubeApi.getChannelVideos(cid, activeApiKey, pageSize);
          setQuotaFallbackActive(false);
        } catch (e: unknown) {
          if (!isYoutubeQuotaOrLimitError(e)) throw e;
          setQuotaFallbackActive(true);
          setInfoMsg(
            'YouTube 官方 API 配额已满或受限，已通过 Invidious 加载视频列表。'
          );
          videos = await invidiousApi.getChannelVideos(cid, page, pageSize);
        }
      } else {
        videos = await invidiousApi.getChannelVideos(channel.authorId || channel.id, page, pageSize);
      }
      
      if (append) {
        setChannelVideos(prev => [...prev, ...videos]);
      } else {
        setChannelVideos(videos);
      }
      
      setHasMoreVideos(videos.length >= pageSize);
    } catch (error: any) {
      console.error('获取视频失败:', error);
      setSearchError(`获取视频失败: ${error.message}`);
    } finally {
      setIsLoadingVideos(false);
    }
  };

  // 解析视频
  const parseVideo = async () => {
    if (!videoUrl.trim()) return;
    
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      setParseError('无效的YouTube链接');
      return;
    }
    
    setIsParsing(true);
    setParseError(null);
    setInfoMsg(null);
    setParsedVideo(null);
    setDescExpanded(false);
    
    try {
      let result: any = {};
      
      if (isUsingOfficialApi) {
        let useInvidiousForParse = false;
        let video: YouTubeVideo | null = null;
        try {
          video = await youtubeApi.getVideoDetails(videoId, activeApiKey);
          setQuotaFallbackActive(false);
        } catch (e: unknown) {
          if (!isYoutubeQuotaOrLimitError(e)) throw e;
          setQuotaFallbackActive(true);
          setInfoMsg('YouTube 官方 API 配额已满或受限，已通过 Invidious 解析视频。');
          useInvidiousForParse = true;
        }

        if (!useInvidiousForParse && video) {
          const tags = video.snippet?.tags;
          result = {
            title: video.snippet.title,
            thumbnail: video.snippet.thumbnails.high?.url || video.snippet.thumbnails.medium?.url,
            viewCount: parseViewCount(video.statistics?.viewCount || '0'),
            likeCount: video.statistics?.likeCount
              ? parseViewCount(String(video.statistics.likeCount))
              : undefined,
            commentCount: video.statistics?.commentCount
              ? parseViewCount(String(video.statistics.commentCount))
              : undefined,
            duration: formatDuration(video.contentDetails?.duration || 'PT0S'),
            channelTitle: video.snippet.channelTitle,
            description: video.snippet.description || '',
            tags: Array.isArray(tags) ? tags : [],
            keywords: [] as string[],
            captions: [] as { label: string; lang?: string }[],
            videoId: videoId,
            url: `https://youtube.com/watch?v=${videoId}`,
            dataSource: 'youtube' as const,
          };
        } else {
          const ivideo = await invidiousApi.getVideoDetails(videoId);
          let caps: { label: string; lang?: string; src?: string }[] = [];

          if (Array.isArray(ivideo.captions)) {
            caps = ivideo.captions.map((c: any) => ({
              label: c.label || c.name || c.languageCode || 'caption',
              lang: c.language_code || c.languageCode,
              src: c.src || c.url,
            }));
          } else if (ivideo.subtitles && typeof ivideo.subtitles === 'object' && !Array.isArray(ivideo.subtitles)) {
            const subs = ivideo.subtitles as Record<string, any>;
            caps = Object.entries(subs).map(([lang, info]: [string, any]) => ({
              label: info?.name || info?.label || lang,
              lang: lang,
              src: info?.src || info?.url,
            }));
          } else if (Array.isArray(ivideo.subtitles)) {
            caps = ivideo.subtitles.map((c: any) => ({
              label: c.label || c.name || c.lang || 'caption',
              lang: c.lang || c.language_code,
              src: c.src || c.url,
            }));
          }

          result = {
            title: ivideo.title,
            thumbnail: ivideo.videoThumbnails?.[0]?.url,
            viewCount: ivideo.viewCount || 0,
            likeCount: typeof ivideo.likeCount === 'number' ? ivideo.likeCount : undefined,
            duration: ivideo.lengthSeconds ? formatDuration(`PT${ivideo.lengthSeconds}S`) : '未知',
            channelTitle: ivideo.author,
            description: ivideo.description || '',
            tags: [] as string[],
            keywords: normalizeInvidiousKeywords(ivideo.keywords),
            captions: caps.filter(c => c.label),
            videoId: videoId,
            url: `https://youtube.com/watch?v=${videoId}`,
            dataSource: 'invidious' as const,
          };
        }
      } else {
        const video = await invidiousApi.getVideoDetails(videoId);
        let caps: { label: string; lang?: string; src?: string }[] = [];

        if (Array.isArray(video.captions)) {
          caps = video.captions.map((c: any) => ({
            label: c.label || c.name || c.languageCode || 'caption',
            lang: c.language_code || c.languageCode,
            src: c.src || c.url,
          }));
        } else if (video.subtitles && typeof video.subtitles === 'object' && !Array.isArray(video.subtitles)) {
          const subs = video.subtitles as Record<string, any>;
          caps = Object.entries(subs).map(([lang, info]: [string, any]) => ({
            label: info?.name || info?.label || lang,
            lang: lang,
            src: info?.src || info?.url,
          }));
        } else if (Array.isArray(video.subtitles)) {
          caps = video.subtitles.map((c: any) => ({
            label: c.label || c.name || c.lang || 'caption',
            lang: c.lang || c.language_code,
            src: c.src || c.url,
          }));
        }

        result = {
          title: video.title,
          thumbnail: video.videoThumbnails?.[0]?.url,
          viewCount: video.viewCount || 0,
          likeCount: typeof video.likeCount === 'number' ? video.likeCount : undefined,
          duration: video.lengthSeconds ? formatDuration(`PT${video.lengthSeconds}S`) : '未知',
          channelTitle: video.author,
          description: video.description || '',
          tags: [] as string[],
          keywords: normalizeInvidiousKeywords(video.keywords),
          captions: caps.filter(c => c.label),
          videoId: videoId,
          url: `https://youtube.com/watch?v=${videoId}`,
          dataSource: 'invidious' as const,
        };
      }
      
      setParsedVideo(result);
    } catch (error: any) {
      console.error('解析失败:', error);
      setParseError(`解析失败: ${error.message}`);
    } finally {
      setIsParsing(false);
    }
  };

  // 添加到监控列表
  const addToMonitor = (channel: any) => {
    const channelId = channel.id || channel.authorId;
    const name = channel.snippet?.title || channel.author;
    
    if (monitoredChannels.find(c => c.channelId === channelId)) {
      setSearchError('该频道已在监控列表中');
      return;
    }
    
    const newChannel: MonitoredChannel = {
      id: Date.now().toString(),
      channelId,
      name,
      lastChecked: new Date().toISOString(),
      lastVideoDate: null,
      lastVideoTitle: null,
    };
    
    setMonitoredChannels([...monitoredChannels, newChannel]);
    setSearchError(null);
  };

  // 移除监控
  const removeFromMonitor = (id: string) => {
    setMonitoredChannels(monitoredChannels.filter(c => c.id !== id));
  };

  // 刷新单个频道
  const refreshChannel = async (channel: MonitoredChannel) => {
    try {
      let videos: any[] = [];
      
      if (isUsingOfficialApi) {
        try {
          videos = await youtubeApi.getChannelVideos(channel.channelId, activeApiKey);
          setQuotaFallbackActive(false);
        } catch (e: unknown) {
          if (!isYoutubeQuotaOrLimitError(e)) throw e;
          setQuotaFallbackActive(true);
          videos = await invidiousApi.getChannelVideos(channel.channelId, 1, 10);
        }
      } else {
        videos = await invidiousApi.getChannelVideos(channel.channelId);
      }
      
      if (videos.length > 0) {
        const latest = videos[0];
        setMonitoredChannels(prev => prev.map(c => 
          c.id === channel.id 
            ? { 
                ...c, 
                lastChecked: new Date().toISOString(),
                lastVideoDate: new Date(latest.snippet?.publishedAt || latest.published * 1000).toLocaleString('zh-CN'),
                lastVideoTitle: latest.snippet?.title || latest.title,
              }
            : c
        ));
      }
    } catch (error) {
      console.error('刷新失败:', error);
    }
  };

  // 刷新所有
  const refreshAllChannels = async () => {
    if (monitoredChannels.length === 0) return;
    
    setIsRefreshing(true);
    for (const channel of monitoredChannels) {
      await refreshChannel(channel);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    setIsRefreshing(false);
  };

  // 复制
  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  /** 渲染下载按钮（用于解析结果区域） */
  const renderDownloadButton = (
    videoUrl: string,
    kind: MetubeDownloadKind,
    label: string,
    icon: React.ReactNode,
    opts?: { className?: string }
  ) => {
    const dlKey = getDownloadKey(videoUrl, kind);
    const dlState = activeDownloads[dlKey];
    const isActive = dlState?.status === 'downloading' || dlState?.status === 'queued';
    const isDone = dlState?.status === 'completed';
    const isError = dlState?.status === 'error';
    const ext = extensionForMetubeDownload(kind, metubeCaptionFormat, metubeAudioFormat);
    const baseName = sanitizeDownloadBasename(`${label}_${videoUrl.split('v=')[1] || 'video'}`);
    const doneLabel =
      kind === 'video'
        ? '下载视频'
        : kind === 'thumbnail'
          ? '下载封面'
          : kind === 'captions'
            ? '下载字幕'
            : kind === 'audio'
              ? '下载音频'
              : '下载文件';

    const handleClick = () => {
      if (isDone && dlState?.fileHref) {
        setInfoMsg(
          '正在打开下载：已尝试在新标签页打开；若浏览器询问弹出窗口请点「允许」。若弹窗被拦截，将自动改为本页保存（大文件可能需等待片刻），请勿重复点击。'
        );
        void forceDownloadFile(dlState.fileHref, `${baseName}.${ext}`);
      } else if (!isActive && !isDone) {
        queueMetubeDownload(videoUrl, kind);
      }
    };

    return (
      <button
        key={kind}
        type="button"
        disabled={isActive}
        onClick={handleClick}
        className={`${opts?.className ?? 'px-2 py-1.5'} rounded-md text-xs flex items-center justify-center gap-1 transition-colors disabled:opacity-50 ${
          isDone
            ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
            : isError
            ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
            : 'bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
        }`}
        title={isError ? dlState?.error : undefined}
      >
        {isActive ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : isDone ? (
          <Download className="w-3 h-3" />
        ) : (
          icon
        )}
        {isDone ? doneLabel : isError ? '失败' : isActive ? '下载中…' : label}
      </button>
    );
  };

  /** 渲染下载进度条 */
  const renderDownloadProgress = (videoUrl: string, displayUrl: string) => {
    // 收集所有类型的下载状态
    const kinds: MetubeDownloadKind[] = ['video', 'audio', 'captions', 'thumbnail'];
    const activeStates = kinds
      .map(kind => ({ kind, state: activeDownloads[getDownloadKey(videoUrl, kind)] }))
      .filter(s => s.state && s.state.status !== 'error' && s.state.status !== 'completed');

    if (activeStates.length === 0) return null;

    return (
      <div className="mt-2 space-y-1.5">
        {activeStates.map(({ kind, state }) => (
          <div key={kind} className="bg-slate-900/80 rounded-lg p-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-slate-400 flex items-center gap-1">
                {kind === 'video' && <Video className="w-3 h-3" />}
                {kind === 'audio' && <Music className="w-3 h-3" />}
                {kind === 'captions' && <Subtitles className="w-3 h-3" />}
                {kind === 'thumbnail' && <Image className="w-3 h-3" />}
                下载{getKindLabel(kind)}
                {state?.status === 'queued' && <span className="text-amber-400/70">(排队中...)</span>}
                {state?.status === 'downloading' && <span className="text-cyan-400/70">(处理中...)</span>}
              </span>
              <span className="text-[10px] text-slate-500">{state?.progress || 0}%</span>
            </div>
            <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-amber-500 to-amber-400 transition-all duration-500"
                style={{ width: `${state?.progress || 0}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    );
  };

  // 渲染视频项（兼容两种API格式）
  const renderVideoItem = (video: any, index: number) => {
    const isOfficial = isUsingOfficialApi && isOfficialYoutubeSnippetPayload(video);
    const title = isOfficial ? video.snippet?.title : video.title;
    const thumbnail = isOfficial 
      ? (video.snippet?.thumbnails?.high?.url || video.snippet?.thumbnails?.medium?.url)
      : video.videoThumbnails?.[0]?.url;
    const videoId = isOfficial ? video.id?.videoId : video.videoId;
    const duration = isOfficial ? formatDuration(video.contentDetails?.duration || 'PT0S') : (video.lengthSeconds ? formatDuration(`PT${video.lengthSeconds}S`) : '未知');
    const viewCount = isOfficial ? video.statistics?.viewCount : video.viewCount;
    const likeCount = isOfficial ? video.statistics?.likeCount : video.likeCount;
    const commentCount = isOfficial ? video.statistics?.commentCount : undefined; // Invidious 列表不返回评论数
    const publishedText = isOfficial 
      ? new Date(video.snippet?.publishedAt).toLocaleDateString('zh-CN')
      : video.publishedText;
    const url = `https://youtube.com/watch?v=${videoId}`;
    
    return (
      <div key={videoId || index} className="flex gap-3 p-2 rounded-lg bg-slate-800/30 hover:bg-slate-800/60 transition-colors">
        <div className="relative flex-shrink-0">
          <img src={thumbnail} alt={title} className="w-40 h-24 object-cover rounded-lg" />
          <div className="absolute bottom-1 right-1 bg-black/80 text-white text-xs px-1 rounded">
            {duration}
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <a href={url} target="_blank" rel="noopener noreferrer" className="font-medium text-slate-200 hover:text-emerald-400 line-clamp-2 text-sm">
            {title}
          </a>
          <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {publishedText}
            </span>
            <span className="flex items-center gap-1">
              <Eye className="w-3 h-3" />
              {formatNumber(parseViewCount(viewCount || '0'))}
            </span>
            {likeCount && (
              <span className="flex items-center gap-1">
                <ThumbsUp className="w-3 h-3" />
                {formatNumber(parseViewCount(String(likeCount)))}
              </span>
            )}
            {commentCount && (
              <span className="flex items-center gap-1">
                <MessageCircle className="w-3 h-3" />
                {formatNumber(parseViewCount(String(commentCount)))}
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setVideoUrl(url)}
              className="px-3 py-1 text-xs bg-emerald-500/10 text-emerald-400 rounded-md hover:bg-emerald-500/20 transition-colors"
            >
              解析
            </button>
            {renderDownloadButton(url, 'video', '下载视频', <Download className="w-3 h-3" />, {
              className: 'px-3 py-1',
            })}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1 text-xs bg-slate-700/50 text-slate-300 rounded-md hover:bg-slate-700 transition-colors"
            >
              观看
            </a>
          </div>
        </div>
      </div>
    );
  };

  // 渲染频道项（兼容两种API格式）
  const renderChannelItem = (channel: any) => {
    const isOfficial = isUsingOfficialApi && isOfficialYoutubeSnippetPayload(channel);
    const channelId = channel.id || channel.authorId;
    const name = isOfficial ? channel.snippet?.title : channel.author;
    const thumbnail = isOfficial 
      ? (channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.default?.url)
      : (channel.authorThumbnails?.[2]?.url || channel.authorThumbnails?.[0]?.url);
    const subscriberCount = isOfficial 
      ? parseViewCount(channel.statistics?.subscriberCount || '0')
      : channel.subscriberCount;
    const videoCount = isOfficial 
      ? parseViewCount(channel.statistics?.videoCount || '0')
      : channel.videoCount;
    
    return (
      <div
        key={channelId}
        className={`flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
          selectedChannel && (selectedChannel.id || selectedChannel.authorId) === channelId
            ? 'bg-emerald-500/10 border-emerald-500/50'
            : 'bg-slate-800/30 border-slate-700/50 hover:border-slate-600'
        }`}
        onClick={() => selectChannel(channel)}
      >
        <img src={thumbnail} alt={name} className="w-12 h-12 rounded-full" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-slate-200 truncate">{name}</div>
          <div className="text-xs text-slate-500">
            {formatNumber(subscriberCount)} 订阅 · {formatNumber(videoCount)} 视频
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); addToMonitor(channel); }}
          className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
          title="添加到监控"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="bg-red-500/10 p-2 rounded-lg border border-red-500/20">
            <Rss className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-100">YouTube 频道监控</h1>
            <p className="text-xs text-slate-500">
              搜索 / 频道链接打开列表 · 点击监控项加载最新视频 · 解析详情与 MeTube 下载
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* API状态指示 */}
          <div className={`px-3 py-1 rounded-full text-xs flex items-center gap-1.5 ${
            isUsingOfficialApi 
              ? quotaFallbackActive
                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                : 'bg-red-500/10 text-red-400 border border-red-500/30' 
              : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
          }`}>
            {isUsingOfficialApi ? (
              quotaFallbackActive ? (
                <>
                  <Rss className="w-3 h-3" />
                  官方 Key 已配置 · 数据经 Invidious
                </>
              ) : (
                <>
                  <Youtube className="w-3 h-3" />
                  官方 API
                </>
              )
            ) : (
              <>
                <Rss className="w-3 h-3" />
                备用 API
              </>
            )}
          </div>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="p-2 rounded-lg bg-slate-800/50 border border-slate-700 text-slate-400 hover:text-emerald-400 hover:border-emerald-500/50 transition-all"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* 设置面板 */}
      {showSettings && (
        <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-emerald-400 mb-4">
            <Settings className="w-4 h-4" />
            <span className="text-sm font-medium">YouTube API 配置</span>
          </div>
          
          <div className="space-y-2 max-w-md">
            <label className="block text-xs text-slate-400 mb-1.5 flex items-center gap-2">
              <Youtube className="w-4 h-4 text-red-400" />
              YouTube Data API v3 Key
              {!YOUTUBE_API_KEY && <span className="text-amber-400">(可选填)</span>}
            </label>
            <input
              type="password"
              value={userYoutubeApiKey}
              onChange={(e) => setUserYoutubeApiKey(e.target.value)}
              placeholder={YOUTUBE_API_KEY ? '已配置环境变量' : '输入你的 YouTube API Key'}
              className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-red-500/50"
            />
            <p className="text-xs text-slate-500">
              {YOUTUBE_API_KEY 
                ? '已通过环境变量配置，所有用户共享此API'
                : '个人专用API Key，仅自己可用'}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              官方配额用尽时会自动改用 Invidious（需在 Vercel 配置 <code className="text-slate-400">INVIDIOUS_UPSTREAM_URL</code>）。
            </p>
            {!YOUTUBE_API_KEY && (
              <a
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1"
              >
                <ExternalLink className="w-3 h-3" />
                申请 YouTube API Key
              </a>
            )}
          </div>
        </div>
      )}

      {/* 成功提示 */}
      {infoMsg && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 flex items-center gap-2 text-emerald-300 text-sm">
          <Check className="w-4 h-4 flex-shrink-0" />
          {infoMsg}
          <button
            type="button"
            onClick={() => setInfoMsg(null)}
            className="ml-auto text-emerald-400 hover:text-emerald-200"
          >
            ×
          </button>
        </div>
      )}

      {/* 错误提示 */}
      {(searchError || parseError) && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center gap-2 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {searchError || parseError}
          <button 
            onClick={() => { setSearchError(null); setParseError(null); }}
            className="ml-auto text-red-400 hover:text-red-300"
          >
            ×
          </button>
        </div>
      )}

      {/* 主内容区 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 左侧：搜索和频道视频 */}
        <div className="lg:col-span-2 space-y-4">
          {/* 频道链接 / UC / @ 直达 */}
          <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Link2 className="w-4 h-4 text-cyan-400" />
              <h2 className="text-sm font-medium text-slate-200">打开频道（不依赖搜索）</h2>
            </div>
            <p className="text-xs text-slate-500 mb-2">
              粘贴频道页链接、<code className="text-slate-400">UC…</code> 频道 ID，或 <code className="text-slate-400">@用户名</code> / 关键词（取首个匹配频道）。
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={channelLinkInput}
                onChange={(e) => setChannelLinkInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void resolveChannelFromInput()}
                placeholder="例如 https://www.youtube.com/@xxx 或 UCxxxxxxxx"
                className="flex-1 bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
              />
              <button
                type="button"
                onClick={() => void resolveChannelFromInput()}
                disabled={resolvingChannel || !channelLinkInput.trim()}
                className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/50 text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 shrink-0"
              >
                {resolvingChannel ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                打开频道
              </button>
            </div>
          </div>

          {/* 搜索 */}
          <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Search className="w-4 h-4 text-emerald-400" />
              <h2 className="text-sm font-medium text-slate-200">搜索频道</h2>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void searchChannels()}
                placeholder="输入频道名称或关键词..."
                className="flex-1 bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
              />
              <button
                type="button"
                onClick={() => void searchChannels()}
                disabled={isSearching}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
              >
                {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                搜索
              </button>
            </div>

            {/* 搜索结果 */}
            {searchResults.length > 0 && (
              <div className="mt-4 space-y-2 max-h-80 overflow-y-auto">
                {searchResults.map(renderChannelItem)}
              </div>
            )}
          </div>

          {/* 频道视频 */}
          {selectedChannel && (
            <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Video className="w-4 h-4 text-emerald-400" />
                  <h2 className="text-sm font-medium text-slate-200">
                    {selectedChannel.snippet?.title || selectedChannel.author} - 最新视频
                  </h2>
                </div>
                <button
                  onClick={() => fetchChannelVideos(selectedChannel)}
                  disabled={isLoadingVideos}
                  className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-emerald-400 transition-colors"
                >
                  <RefreshCw className={`w-4 h-4 ${isLoadingVideos ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {isLoadingVideos && channelVideos.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
                </div>
              ) : channelVideos.length > 0 ? (
                <>
                  <div className="space-y-2">
                    {channelVideos.map(renderVideoItem)}
                  </div>
                  {/* 分页控件 */}
                  <div className="flex items-center justify-between mt-4 pt-3 border-t border-slate-700/50">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">每页</span>
                      <select
                        value={videoPageSize}
                        onChange={(e) => changePageSize(Number(e.target.value))}
                        className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300"
                      >
                        <option value={10}>10</option>
                        <option value={20}>20</option>
                        <option value={50}>50</option>
                      </select>
                      <span className="text-xs text-slate-500">条</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">第 {videoPage} 页</span>
                      <button
                        onClick={() => {
                          setVideoPage(p => Math.max(1, p - 1));
                          fetchChannelVideos(selectedChannel, videoPage - 1, videoPageSize);
                        }}
                        disabled={videoPage <= 1}
                        className="p-1 rounded bg-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <button
                        onClick={loadMoreVideos}
                        disabled={isLoadingVideos || !hasMoreVideos}
                        className="p-1 rounded bg-slate-800 text-slate-400 hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-center py-8 text-slate-500 text-sm">
                  暂无视频数据
                </div>
              )}
            </div>
          )}
        </div>

        {/* 右侧：监控列表和视频解析 */}
        <div className="space-y-4">
          {/* 监控列表 */}
          <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-red-400" />
                <h2 className="text-sm font-medium text-slate-200">监控列表</h2>
                <span className="text-xs text-slate-500">({monitoredChannels.length})</span>
              </div>
              <button
                onClick={refreshAllChannels}
                disabled={isRefreshing || monitoredChannels.length === 0}
                className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-emerald-400 disabled:opacity-50 transition-colors"
                title="刷新全部"
              >
                <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {monitoredChannels.length === 0 ? (
              <div className="text-center py-6 text-slate-500 text-sm">
                暂无监控频道<br />
                <span className="text-xs">搜索并添加频道到列表</span>
              </div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {monitoredChannels.map((channel) => {
                  const active =
                    selectedChannel &&
                    (selectedChannel.id === channel.channelId ||
                      selectedChannel.authorId === channel.channelId);
                  return (
                    <div
                      key={channel.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openMonitoredChannel(channel)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openMonitoredChannel(channel);
                        }
                      }}
                      className={`p-2 rounded-lg border text-left cursor-pointer transition-colors ${
                        active
                          ? 'bg-emerald-500/15 border-emerald-500/40 ring-1 ring-emerald-500/30'
                          : 'bg-slate-800/30 border-slate-700/30 hover:border-slate-600 hover:bg-slate-800/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-slate-200 font-medium truncate">{channel.name}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void refreshChannel(channel);
                            }}
                            className="p-1 rounded text-slate-500 hover:text-emerald-400 transition-colors"
                            title="仅刷新摘要"
                          >
                            <RefreshCw className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeFromMonitor(channel.id);
                            }}
                            className="p-1 rounded text-slate-500 hover:text-red-400 transition-colors"
                            title="移除"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-600 font-mono truncate">
                        {channel.channelId}
                      </div>
                      {channel.lastVideoTitle && (
                        <div className="mt-1 text-xs text-slate-500 line-clamp-1">
                          最新：{channel.lastVideoTitle}
                        </div>
                      )}
                      <div className="mt-1 text-xs text-slate-600">
                        {channel.lastVideoDate ? `更新: ${channel.lastVideoDate}` : '从未更新'} · 点击查看视频列表
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 视频解析 */}
          <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Download className="w-4 h-4 text-blue-400" />
              <h2 className="text-sm font-medium text-slate-200">视频解析</h2>
            </div>
            <div className="mb-3 space-y-2 rounded-lg border border-slate-700/60 bg-slate-800/30 p-2">
              <label className="text-[10px] uppercase tracking-wider text-slate-500">MeTube 下载选项</label>
              <select
                value={metubeKind}
                onChange={(e) => setMetubeKind(e.target.value as MetubeDownloadKind)}
                className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200"
              >
                <option value="video">视频</option>
                <option value="audio">音频</option>
                <option value="captions">字幕文件</option>
                <option value="thumbnail">封面图（jpg）</option>
              </select>
              {metubeKind === 'video' && (
                <select
                  value={metubeVideoQuality}
                  onChange={(e) => setMetubeVideoQuality(e.target.value)}
                  className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200"
                >
                  <option value="best">画质：最佳</option>
                  <option value="worst">画质：最低</option>
                  <option value="2160">2160p</option>
                  <option value="1440">1440p</option>
                  <option value="1080">1080p</option>
                  <option value="720">720p</option>
                  <option value="480">480p</option>
                  <option value="360">360p</option>
                  <option value="240">240p</option>
                </select>
              )}
              {metubeKind === 'audio' && (
                <>
                  <select
                    value={metubeAudioFormat}
                    onChange={(e) => {
                      const f = e.target.value;
                      setMetubeAudioFormat(f);
                      if (f === 'opus' || f === 'wav' || f === 'flac') setMetubeAudioQuality('best');
                    }}
                    className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200"
                  >
                    <option value="m4a">格式 m4a</option>
                    <option value="mp3">格式 mp3</option>
                    <option value="opus">格式 opus</option>
                    <option value="wav">格式 wav</option>
                    <option value="flac">格式 flac</option>
                  </select>
                  <select
                    value={metubeAudioQuality}
                    onChange={(e) => setMetubeAudioQuality(e.target.value)}
                    disabled={['opus', 'wav', 'flac'].includes(metubeAudioFormat)}
                    className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 disabled:opacity-50"
                  >
                    {['opus', 'wav', 'flac'].includes(metubeAudioFormat) ? (
                      <option value="best">音质：最佳（仅此选项）</option>
                    ) : metubeAudioFormat === 'mp3' ? (
                      <>
                        <option value="best">音质：最佳</option>
                        <option value="320">320 kbps</option>
                        <option value="192">192 kbps</option>
                        <option value="128">128 kbps</option>
                      </>
                    ) : (
                      <>
                        <option value="best">音质：最佳</option>
                        <option value="192">192 kbps</option>
                        <option value="128">128 kbps</option>
                      </>
                    )}
                  </select>
                </>
              )}
              {metubeKind === 'captions' && (
                <>
                  <select
                    value={metubeCaptionFormat}
                    onChange={(e) => setMetubeCaptionFormat(e.target.value)}
                    className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200"
                  >
                    <option value="srt">srt</option>
                    <option value="vtt">vtt</option>
                    <option value="txt">txt</option>
                    <option value="ttml">ttml</option>
                  </select>
                  <select
                    value={metubeSubtitleLanguage}
                    onChange={(e) =>
                      setMetubeSubtitleLanguage(e.target.value as typeof metubeSubtitleLanguage)
                    }
                    className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200"
                  >
                    <option value="auto">字幕语言：自动（推荐）</option>
                    <option value="en">英语 en</option>
                    <option value="zh-Hans">简体中文</option>
                    <option value="zh-Hant">繁体中文</option>
                    <option value="ja">日语</option>
                    <option value="ko">韩语</option>
                  </select>
                </>
              )}
              {metubeKind === 'thumbnail' && (
                <p className="text-[10px] text-slate-500">将下载 YouTube 封面为 jpg（MeTube 仅支持 jpg）。</p>
              )}
            </div>
            <div className="space-y-3">
              <input
                type="text"
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && parseVideo()}
                placeholder="粘贴 YouTube 视频链接..."
                className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/50"
              />
              <button
                onClick={parseVideo}
                disabled={isParsing || !videoUrl.trim()}
                className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
              >
                {isParsing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                解析视频
              </button>
            </div>

            {/* 解析结果 */}
            {parsedVideo && (
              <div className="mt-4 p-3 rounded-lg bg-slate-800/50 border border-slate-700/50">
                {parsedVideo.thumbnail && (
                  <img src={parsedVideo.thumbnail} alt={parsedVideo.title} className="w-full rounded-lg mb-3" />
                )}
                <h3 className="font-medium text-slate-200 text-sm line-clamp-2 mb-2">{parsedVideo.title}</h3>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 mb-2">
                  <span className="flex items-center gap-1">
                    <Eye className="w-3 h-3" />
                    {formatNumber(parsedVideo.viewCount)} 次观看
                  </span>
                  {parsedVideo.likeCount != null && (
                    <span className="flex items-center gap-1">
                      <ThumbsUp className="w-3 h-3" />
                      {formatNumber(parsedVideo.likeCount)}
                    </span>
                  )}
                  {parsedVideo.commentCount != null && (
                    <span>{formatNumber(parsedVideo.commentCount)} 条评论</span>
                  )}
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {parsedVideo.duration}
                  </span>
                </div>
                {parsedVideo.channelTitle && (
                  <p className="text-xs text-slate-500 mb-2">频道：{parsedVideo.channelTitle}</p>
                )}
                {(parsedVideo.tags?.length > 0 || parsedVideo.keywords?.length > 0) && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {(parsedVideo.tags?.length ? parsedVideo.tags : parsedVideo.keywords).slice(0, 24).map((t: string) => (
                      <span
                        key={t}
                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-slate-700/50 text-[10px] text-slate-400"
                      >
                        <Tag className="w-2.5 h-2.5" />
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {parsedVideo.description ? (
                  <div className="mb-3">
                    <button
                      type="button"
                      onClick={() => setDescExpanded((v) => !v)}
                      className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 mb-1"
                    >
                      <FileText className="w-3 h-3" />
                      简介
                      {descExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>
                    <p
                      className={`text-xs text-slate-500 whitespace-pre-wrap break-words ${
                        descExpanded ? '' : 'line-clamp-4'
                      }`}
                    >
                      {parsedVideo.description}
                    </p>
                  </div>
                ) : null}
                {/* 解析结果下载按钮（多类型） */}
                <div className="mt-3 pt-3 border-t border-slate-700/50">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">MeTube 下载</p>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    {renderDownloadButton(parsedVideo.url, 'video', '视频', <Video className="w-3 h-3" />)}
                    {renderDownloadButton(parsedVideo.url, 'audio', '音频', <Music className="w-3 h-3" />)}
                    {renderDownloadButton(parsedVideo.url, 'captions', '字幕', <Subtitles className="w-3 h-3" />)}
                    {renderDownloadButton(parsedVideo.url, 'thumbnail', '封面', <Image className="w-3 h-3" />)}
                  </div>
                  {parsedVideo.captions?.length > 0 ? (
                    <p className="text-[10px] text-slate-500 mb-2">
                      解析到的字幕轨道（仅供参考）：{' '}
                      {parsedVideo.captions.map((c: { label: string }) => c.label).join('、')}
                    </p>
                  ) : (
                    <p className="text-[10px] text-slate-600 mb-2">
                      解析结果未列出字幕轨道时，仍可通过上方「字幕」走 MeTube 下载（与后台一致）。
                    </p>
                  )}
                  {/* 下载进度条 */}
                  {renderDownloadProgress(parsedVideo.url, parsedVideo.url)}
                </div>

                {/* 操作按钮 */}
                <div className="flex flex-wrap gap-2 mt-3">
                  <a
                    href={parsedVideo.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 bg-emerald-500/10 text-emerald-400 rounded-md text-xs hover:bg-emerald-500/20 transition-colors flex items-center gap-1"
                  >
                    <ExternalLink className="w-3 h-3" />
                    观看
                  </a>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(parsedVideo.url, 'url')}
                    className="px-3 py-1.5 bg-slate-700/50 text-slate-300 rounded-md text-xs hover:bg-slate-700 transition-colors flex items-center gap-1"
                  >
                    {copiedId === 'url' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    复制
                  </button>
                </div>

                {/* MeTube 下载历史（放在解析结果下方） */}
                {metubeHistory.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-slate-700/50">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Download className="w-3 h-3 text-amber-400" />
                        <h3 className="text-xs font-medium text-slate-300">下载记录</h3>
                      </div>
                      <div className="flex items-center gap-2">
                        {VITE_METUBE_PUBLIC_URL && (
                          <a
                            href={VITE_METUBE_PUBLIC_URL.replace(/\/$/, '')}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-amber-400/90 hover:text-amber-300"
                          >
                            MeTube
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => void refreshMetubeHistory()}
                          disabled={metubeHistoryLoading}
                          className="p-0.5 rounded text-slate-500 hover:text-amber-400 transition-colors"
                          title="刷新"
                        >
                          <RefreshCw className={`w-3 h-3 ${metubeHistoryLoading ? 'animate-spin' : ''}`} />
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {metubeHistory.slice(0, 5).map((item: any, idx: number) => {
                        const title = item.title || item.name || `下载 #${idx + 1}`;
                        const status: string = String(item.status || item.state || 'unknown');
                        const isDone = ['completed', 'done', 'finished'].includes(status);
                        const fileHref = isDone && VITE_METUBE_PUBLIC_URL
                          ? metubePublicFileHref(VITE_METUBE_PUBLIC_URL, item as Record<string, unknown>)
                          : null;
                        return (
                          <div key={item.uid || item.id || idx} className="flex items-center gap-2 p-1.5 rounded bg-slate-800/30 text-[10px]">
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isDone ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                            <span className="flex-1 truncate text-slate-300">{title}</span>
                            <span className="text-slate-500">{status}</span>
                            {fileHref && (
                              <button
                                type="button"
                                onClick={() => {
                                  setInfoMsg(
                                    '正在打开下载：已尝试在新标签页打开；若被拦截将自动改用本页保存。大文件请稍候，勿重复点击。'
                                  );
                                  void forceDownloadFile(
                                    fileHref,
                                    metubeHistoryItemDownloadName(item as Record<string, unknown>)
                                  );
                                }}
                                className="text-amber-400 hover:text-amber-300"
                                title="直接下载"
                              >
                                <Download className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
