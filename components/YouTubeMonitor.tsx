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

/** 通过 fetch + Blob 方式强制下载文件（解决跨域 download 属性失效问题） */
async function forceDownloadFile(url: string, filename?: string) {
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
    window.open(url, '_blank');
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

  getChannelVideos: async (channelId: string, apiKey: string): Promise<YouTubeVideo[]> => {
    const searchRes = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&maxResults=20&order=date&type=video&key=${apiKey}`
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

  getChannelVideos: async (channelId: string): Promise<InvidiousVideo[]> => {
    const data = await fetchInvidiousJson<{ videos?: InvidiousVideo[] }>(
      `channels/${channelId}/videos`,
      {}
    );
    return data.videos?.slice(0, 20) || [];
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
  /** 仅当前正在提交的 watch URL 显示「提交中」，避免全列表共用 loading */
  const [metubeSubmittingUrl, setMetubeSubmittingUrl] = useState<string | null>(null);
  const [cookiesPaste, setCookiesPaste] = useState('');
  const [cookiesUploading, setCookiesUploading] = useState(false);
  const [cookiesHint, setCookiesHint] = useState<string | null>(null);
  const [cookieStatusText, setCookieStatusText] = useState<string | null>(null);
  /** MeTube 下载历史（轮询展示） */
  const [metubeHistory, setMetubeHistory] = useState<any[]>([]);
  const [metubeHistoryLoading, setMetubeHistoryLoading] = useState(false);
  
  // 下载进度跟踪：key = url+kind, value = 状态
  type DownloadStatus = 'queued' | 'downloading' | 'completed' | 'error';
  const [activeDownloads, setActiveDownloads] = useState<Record<string, { status: DownloadStatus; progress?: number; error?: string; uid?: string }>>({});
  
  // 频道详情
  const [selectedChannel, setSelectedChannel] = useState<any>(null);
  const [channelVideos, setChannelVideos] = useState<any[]>([]);
  const [isLoadingVideos, setIsLoadingVideos] = useState(false);
  
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
  const [descExpanded, setDescExpanded] = useState(false);

  // 使用的API
  const activeApiKey = YOUTUBE_API_KEY || userYoutubeApiKey;
  const isUsingOfficialApi = !!activeApiKey;

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

      // 查找匹配的下载项
      const item = hist.find((h: any) => {
        const hUrl = h.url || '';
        const normalizedUrl = hUrl.replace(/^https?:\/\/(www\.)?youtu\.be\//, 'https://youtube.com/watch?v=');
        return normalizedUrl === url || hUrl.includes(url.split('v=')[1]?.split('&')[0] || '');
      });

      if (item) {
        const status = String(item.status || item.state || '').toLowerCase();
        if (['completed', 'done', 'finished'].includes(status)) {
          setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'completed', progress: 100 } }));
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

    setMetubeSubmittingUrl(url);
    setInfoMsg(null);
    setSearchError(null);

    try {
      // 根据类型构建不同的 payload
      const payload = buildMetubePayloadWithKind(url, dlKind);
      await metubePostAdd(payload);

      setInfoMsg(`已提交「${getKindLabel(dlKind)}」到 MeTube 队列，开始轮询状态...`);

      // 开始轮询下载状态
      pollDownloadStatus(url, dlKind);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : 'MeTube 提交失败';
      setSearchError(errMsg);
      setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: errMsg } }));
    } finally {
      setMetubeSubmittingUrl(null);
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
      case 'captions':
        return {
          ...base,
          download_type: 'captions',
          format: metubeCaptionFormat,
          quality: 'best',
          codec: 'auto',
          subtitle_language: 'en',
          subtitle_mode: 'prefer_manual',
        };
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
    fetchChannelVideos(channel);
  };

  /** 用频道 ID 拉取元数据并打开视频列表（监控列表 / 直链解析共用） */
  const openChannelByChannelId = async (channelId: string) => {
    setSearchError(null);
    setInfoMsg(null);
    try {
      if (isUsingOfficialApi) {
        const ch = await youtubeApi.getChannelById(channelId, activeApiKey);
        if (!ch) {
          setSearchError('频道不存在或 ID 无效');
          return;
        }
        selectChannel(ch);
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
        results = await youtubeApi.searchChannels(searchTerm, activeApiKey);
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
        results = await youtubeApi.searchChannels(q, activeApiKey);
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
  const fetchChannelVideos = async (channel: any) => {
    setIsLoadingVideos(true);
    try {
      let videos: any[] = [];
      
      if (isUsingOfficialApi) {
        videos = await youtubeApi.getChannelVideos(channel.id || channel.authorId, activeApiKey);
      } else {
        videos = await invidiousApi.getChannelVideos(channel.authorId || channel.id);
      }
      
      setChannelVideos(videos);
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
        const video = await youtubeApi.getVideoDetails(videoId, activeApiKey);
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
        const video = await invidiousApi.getVideoDetails(videoId);
        const caps = Array.isArray(video.captions) ? video.captions : [];
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
          captions: caps.map((c: any) => ({
            label: c.label || c.name || 'caption',
            lang: c.language_code || c.languageCode,
          })),
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
        videos = await youtubeApi.getChannelVideos(channel.channelId, activeApiKey);
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
    icon: React.ReactNode
  ) => {
    const dlKey = getDownloadKey(videoUrl, kind);
    const dlState = activeDownloads[dlKey];
    const isActive = dlState?.status === 'downloading' || dlState?.status === 'queued';
    const isDone = dlState?.status === 'completed';
    const isError = dlState?.status === 'error';

    return (
      <button
        key={kind}
        type="button"
        disabled={isActive}
        onClick={() => queueMetubeDownload(videoUrl, kind)}
        className={`px-2 py-1.5 rounded-md text-xs flex items-center justify-center gap-1 transition-colors disabled:opacity-50 ${
          isDone
            ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
            : isError
            ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
            : 'bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
        }`}
        title={isError ? dlState.error : undefined}
      >
        {isActive ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : isDone ? (
          <CheckCircle className="w-3 h-3" />
        ) : (
          icon
        )}
        {isDone ? '完成' : isError ? '失败' : label}
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
    const isOfficial = isUsingOfficialApi;
    const title = isOfficial ? video.snippet?.title : video.title;
    const thumbnail = isOfficial 
      ? (video.snippet?.thumbnails?.high?.url || video.snippet?.thumbnails?.medium?.url)
      : video.videoThumbnails?.[0]?.url;
    const videoId = isOfficial ? video.id?.videoId : video.videoId;
    const duration = isOfficial ? formatDuration(video.contentDetails?.duration || 'PT0S') : (video.lengthSeconds ? formatDuration(`PT${video.lengthSeconds}S`) : '未知');
    const viewCount = isOfficial ? video.statistics?.viewCount : video.viewCount;
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
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setVideoUrl(url)}
              className="px-3 py-1 text-xs bg-emerald-500/10 text-emerald-400 rounded-md hover:bg-emerald-500/20 transition-colors"
            >
              解析
            </button>
            <button
              type="button"
              disabled={metubeSubmittingUrl === url}
              onClick={() => queueMetubeDownload(url, 'video')}
              className="px-3 py-1 text-xs bg-amber-500/10 text-amber-400 rounded-md hover:bg-amber-500/20 transition-colors disabled:opacity-50"
            >
              {metubeSubmittingUrl === url ? '提交中…' : 'MeTube 下载'}
            </button>
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
    const isOfficial = isUsingOfficialApi;
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
              ? 'bg-red-500/10 text-red-400 border border-red-500/30' 
              : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
          }`}>
            {isUsingOfficialApi ? (
              <>
                <Youtube className="w-3 h-3" />
                官方 API
              </>
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
        <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4 space-y-4">
          <div className="flex items-center gap-2 text-emerald-400">
            <Settings className="w-4 h-4" />
            <span className="text-sm font-medium">API 配置</span>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 官方 API Key 配置 */}
            <div className="space-y-2">
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

            {/* Invidious 代理 + MeTube 说明 */}
            <div className="space-y-2">
              <label className="block text-xs text-slate-400 mb-1.5 flex items-center gap-2">
                <Rss className="w-4 h-4 text-amber-400" />
                无 Key 时的数据与下载
              </label>
              <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3 text-xs text-slate-400 space-y-2">
                <p>
                  <span className="text-slate-300">搜索 / 频道 / 解析</span>：走本站{' '}
                  <code className="text-amber-300/90">/api/invidious</code> 代理到 Invidious（Vercel
                  环境变量 <code className="text-slate-300">INVIDIOUS_UPSTREAM_URL</code>）。
                </p>
                <p className="text-slate-500">
                  MeTube <strong className="text-slate-400">没有</strong> Invidious 的{' '}
                  <code>/api/v1</code> 接口，不能把 MeTube 域名填进 Invidious 上游。
                </p>
                <p>
                  <span className="text-slate-300">加入下载队列</span>：走{' '}
                  <code className="text-amber-300/90">/api/metube/add</code>，需在 Vercel 配置{' '}
                  <code className="text-slate-300">METUBE_URL</code>（你的 Railway MeTube 根地址）。
                </p>
                <a
                  href="https://railway.app/deploy/metube-1"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-400 hover:text-amber-300 flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" />
                  Railway 部署 MeTube
                </a>
              </div>
            </div>
          </div>

          <div className="border-t border-slate-700/50 pt-4 space-y-3">
            <div className="flex items-center gap-2 text-amber-400">
              <Download className="w-4 h-4" />
              <span className="text-sm font-medium">MeTube 下载失败（YouTube 机器人检测）</span>
            </div>
            <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3 text-xs text-slate-400 space-y-2">
              <p>
                本站页面<strong className="text-slate-300">无法</strong>嵌入「YouTube
                官方登录」并自动读取登录 Cookie：YouTube 的会话 Cookie 多为 HttpOnly，浏览器禁止任意第三方页面读取（安全策略）。可行做法是：在你本机浏览器登录
                YouTube 后，按 yt-dlp 文档导出 Netscape 格式的{' '}
                <code className="text-slate-300">cookies.txt</code>，再粘贴到下方上传到 Railway 上的 MeTube。
              </p>
              <a
                href="https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies"
                target="_blank"
                rel="noopener noreferrer"
                className="text-amber-400 hover:text-amber-300 inline-flex items-center gap-1"
              >
                <ExternalLink className="w-3 h-3" />
                yt-dlp：导出 YouTube cookies 说明
              </a>
              {VITE_METUBE_PUBLIC_URL ? (
                <p>
                  <a
                    href={VITE_METUBE_PUBLIC_URL.replace(/\/$/, '')}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1"
                  >
                    <ExternalLink className="w-3 h-3" />
                    打开 MeTube（VITE_METUBE_PUBLIC_URL）
                  </a>
                </p>
              ) : (
                <p className="text-slate-500">
                  可选：在前端环境变量中配置 <code className="text-slate-400">VITE_METUBE_PUBLIC_URL</code> 为你的 MeTube
                  公网地址，此处会显示直达链接。
                </p>
              )}
              <p className="text-slate-500">
                <strong className="text-slate-400">方案 B（服务端）</strong>：在 Vercel 设置{' '}
                <code className="text-slate-300">METUBE_YTDL_OVERRIDES_JSON</code>（需 Railway MeTube 开启{' '}
                <code className="text-slate-300">ALLOW_YTDL_OPTIONS_OVERRIDES=true</code>
                ），例如{' '}
                <code className="text-slate-300 break-all">
                  {`{"extractor_args":{"youtube":{"player_client":["android"]}}}`}
                </code>
                ；或在 MeTube 容器环境变量 <code className="text-slate-300">YTDL_OPTIONS</code> 中配置同等参数 / 代理。
              </p>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">粘贴 cookies.txt（Netscape 格式）</label>
              <textarea
                value={cookiesPaste}
                onChange={(e) => setCookiesPaste(e.target.value)}
                placeholder="# Netscape HTTP Cookie File&#10;.youtube.com	TRUE	/	TRUE	0	CONSENT	..."
                rows={5}
                className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-600 font-mono focus:outline-none focus:border-amber-500/50"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void uploadCookiesToMetube()}
                  disabled={cookiesUploading}
                  className="px-3 py-1.5 rounded-lg text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white"
                >
                  {cookiesUploading ? '上传中…' : '上传到 MeTube'}
                </button>
                <button
                  type="button"
                  onClick={() => void refreshCookieStatus()}
                  className="px-3 py-1.5 rounded-lg text-xs bg-slate-700 hover:bg-slate-600 text-slate-200"
                >
                  查询 cookie 状态
                </button>
              </div>
              {cookiesHint && <p className="mt-2 text-xs text-amber-300/90">{cookiesHint}</p>}
              {cookieStatusText && (
                <pre className="mt-2 p-2 rounded bg-slate-950/80 text-[10px] text-slate-400 overflow-x-auto max-h-40 whitespace-pre-wrap break-all">
                  {cookieStatusText}
                </pre>
              )}
            </div>
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

              {isLoadingVideos ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
                </div>
              ) : channelVideos.length > 0 ? (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {channelVideos.map(renderVideoItem)}
                </div>
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
                    {/* 视频下载 */}
                    {renderDownloadButton(parsedVideo.url, 'video', '视频', <Video className="w-3 h-3" />)}
                    {/* 音频下载 */}
                    {renderDownloadButton(parsedVideo.url, 'audio', '音频', <Music className="w-3 h-3" />)}
                    {/* 字幕下载（需有字幕数据） */}
                    {parsedVideo.captions?.length > 0 ? (
                      parsedVideo.captions.slice(0, 2).map((c: { label: string; lang?: string }, i: number) => (
                        <button
                          key={`cap-${i}`}
                          type="button"
                          disabled={metubeSubmittingUrl === parsedVideo.url + '_captions_' + c.label}
                          onClick={() => {
                            // 直接使用 MeTube 下载字幕
                            queueMetubeDownload(parsedVideo.url, 'captions');
                          }}
                          className="px-2 py-1.5 bg-blue-500/10 text-blue-300 rounded-md text-xs hover:bg-blue-500/20 transition-colors flex items-center justify-center gap-1 disabled:opacity-50"
                        >
                          {metubeSubmittingUrl === parsedVideo.url + '_captions_' + c.label ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Subtitles className="w-3 h-3" />
                          )}
                          {c.label}
                        </button>
                      ))
                    ) : (
                      <span className="px-2 py-1.5 text-[10px] text-slate-600 col-span-1">无字幕</span>
                    )}
                    {/* 封面图下载 */}
                    {renderDownloadButton(parsedVideo.url, 'thumbnail', '封面', <Image className="w-3 h-3" />)}
                  </div>
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
              </div>
            )}
          </div>

          {/* MeTube 下载历史 */}
          <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Download className="w-4 h-4 text-amber-400" />
                <h2 className="text-sm font-medium text-slate-200">MeTube 下载记录</h2>
              </div>
              <div className="flex items-center gap-1.5">
                {VITE_METUBE_PUBLIC_URL ? (
                  <a
                    href={VITE_METUBE_PUBLIC_URL.replace(/\/$/, '')}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-amber-400/90 hover:text-amber-300"
                  >
                    打开 MeTube
                  </a>
                ) : (
                  <span className="text-[10px] text-slate-600" title="配置 VITE_METUBE_PUBLIC_URL 后可显示「下载文件」直链">
                    未配公网地址
                  </span>
                )}
                <span className="text-[10px] text-slate-500">自动轮询</span>
                <button
                  type="button"
                  onClick={() => void refreshMetubeHistory()}
                  disabled={metubeHistoryLoading}
                  className="p-1 rounded text-slate-500 hover:text-amber-400 transition-colors"
                  title="手动刷新"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${metubeHistoryLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>

            {metubeHistoryLoading && metubeHistory.length === 0 ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
              </div>
            ) : metubeHistory.length === 0 ? (
              <p className="text-xs text-slate-500 text-center py-2">
                暂无下载记录。提交后会自动刷新（首次约需 5-10 秒）。
              </p>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {metubeHistory.map((item: any, idx: number) => {
                  const title = item.title || item.name || `下载 #${idx + 1}`;
                  const status: string = String(item.status || item.state || 'unknown');
                  const errMsg = item.error ? String(item.error) : '';
                  const isError =
                    !!errMsg ||
                    /error|fail|No video formats/i.test(status) ||
                    ['error', 'failed'].includes(status);
                  const isDone = ['completed', 'done', 'finished'].includes(status);
                  const fileHref =
                    isDone && VITE_METUBE_PUBLIC_URL
                      ? metubePublicFileHref(VITE_METUBE_PUBLIC_URL, item as Record<string, unknown>)
                      : null;
                  const watchUrl = typeof item.url === 'string' ? item.url : '';
                  return (
                    <div
                      key={item.uid || item.id || idx}
                      className={`flex items-start gap-2 p-2 rounded-lg text-xs ${
                        isError
                          ? 'bg-red-500/10 border border-red-500/20'
                          : isDone
                          ? 'bg-emerald-500/10 border border-emerald-500/20'
                          : 'bg-slate-800/30 border border-slate-700/30'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-slate-200 font-medium truncate">{title}</p>
                        {watchUrl && (
                          <a
                            href={watchUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-slate-500 hover:text-amber-400 truncate block mt-0.5"
                          >
                            {watchUrl}
                          </a>
                        )}
                        {item.error && (
                          <p className="text-red-400 mt-0.5 break-all">
                            错误：{item.error.slice(0, 120)}
                          </p>
                        )}
                        <p className={`mt-0.5 ${isError ? 'text-red-400' : isDone ? 'text-emerald-400' : 'text-slate-500'}`}>
                          状态：{status}
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {fileHref && (
                            <button
                              type="button"
                              onClick={() => forceDownloadFile(fileHref, title as string + '.mp4')}
                              className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded bg-amber-600/20 text-amber-300 hover:bg-amber-600/35 text-[10px]"
                            >
                              <Download className="w-3 h-3" />
                              下载文件
                            </button>
                          )}
                          {isDone && !fileHref && VITE_METUBE_PUBLIC_URL && (
                            <span className="text-[10px] text-slate-600">无本地路径，请到 MeTube 页下载</span>
                          )}
                          {watchUrl && (
                            <button
                              type="button"
                              disabled={metubeSubmittingUrl === watchUrl}
                              onClick={() => void queueMetubeDownload(watchUrl, metubeKind)}
                              className="inline-flex px-2 py-0.5 rounded bg-slate-700/60 text-slate-300 hover:bg-slate-600 text-[10px] disabled:opacity-50"
                            >
                              {metubeSubmittingUrl === watchUrl ? '提交中…' : '按当前选项重下'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
