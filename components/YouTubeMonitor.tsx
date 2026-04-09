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
  AlertCircle,
  Youtube
} from 'lucide-react';

// ============================================================
// API配置
// ============================================================
// YouTube Data API v3 - 从环境变量获取（Vercel部署时配置）
const YOUTUBE_API_KEY = (import.meta as any).env?.VITE_YOUTUBE_API_KEY || '';

/** 同源 Invidious 代理（Vercel: api/invidious；开发: vite 中间件）。勿把 MeTube 当作 Invidious。 */
function invidiousProxyUrl(path: string, query: Record<string, string> = {}): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const params = new URLSearchParams({ path, ...query });
  return `${origin}/api/invidious?${params.toString()}`;
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
  if (!res.ok) {
    const err = (data as { error?: string })?.error;
    throw new Error(err || `HTTP ${res.status}`);
  }
  return data as T;
}

async function metubeAddToQueue(videoUrl: string): Promise<void> {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const res = await fetch(`${origin}/api/metube/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: videoUrl }),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* keep text */
    }
    throw new Error(msg || `MeTube ${res.status}`);
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
  const [metubeBusy, setMetubeBusy] = useState(false);
  
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

  const queueMetubeDownload = async (url: string) => {
    setMetubeBusy(true);
    setInfoMsg(null);
    setSearchError(null);
    try {
      await metubeAddToQueue(url);
      setInfoMsg('已提交到 MeTube 下载队列，请到 Railway 上的 MeTube 页面查看进度。');
    } catch (e: unknown) {
      setSearchError(e instanceof Error ? e.message : 'MeTube 提交失败');
    } finally {
      setMetubeBusy(false);
    }
  };

  // 搜索频道
  const searchChannels = async () => {
    if (!searchQuery.trim()) return;
    
    setIsSearching(true);
    setSearchError(null);
    setInfoMsg(null);
    try {
      let results: any[] = [];
      
      if (isUsingOfficialApi) {
        // 使用官方 API
        results = await youtubeApi.searchChannels(searchQuery, activeApiKey);
      } else {
        // 使用 Invidious
        results = await invidiousApi.searchChannels(searchQuery);
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
    
    try {
      let result: any = {};
      
      if (isUsingOfficialApi) {
        const video = await youtubeApi.getVideoDetails(videoId, activeApiKey);
        result = {
          title: video.snippet.title,
          thumbnail: video.snippet.thumbnails.high?.url || video.snippet.thumbnails.medium?.url,
          viewCount: parseViewCount(video.statistics?.viewCount || '0'),
          duration: formatDuration(video.contentDetails?.duration || 'PT0S'),
          channelTitle: video.snippet.channelTitle,
          description: video.snippet.description,
          videoId: videoId,
          url: `https://youtube.com/watch?v=${videoId}`,
        };
      } else {
        const video = await invidiousApi.getVideoDetails(videoId);
        result = {
          title: video.title,
          thumbnail: video.videoThumbnails?.[0]?.url,
          viewCount: video.viewCount || 0,
          duration: video.lengthSeconds ? formatDuration(`PT${video.lengthSeconds}S`) : '未知',
          channelTitle: video.author,
          description: video.description,
          videoId: videoId,
          url: `https://youtube.com/watch?v=${videoId}`,
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

  // 选择频道
  const selectChannel = (channel: any) => {
    setSelectedChannel(channel);
    fetchChannelVideos(channel);
  };

  // 复制
  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
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
              disabled={metubeBusy}
              onClick={() => queueMetubeDownload(url)}
              className="px-3 py-1 text-xs bg-amber-500/10 text-amber-400 rounded-md hover:bg-amber-500/20 transition-colors disabled:opacity-50"
            >
              {metubeBusy ? '提交中…' : 'MeTube 下载'}
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
            <p className="text-xs text-slate-500">监控频道更新 · 视频信息解析</p>
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
                onKeyDown={(e) => e.key === 'Enter' && searchChannels()}
                placeholder="输入频道名称或关键词..."
                className="flex-1 bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
              />
              <button
                onClick={searchChannels}
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
                {monitoredChannels.map((channel) => (
                  <div key={channel.id} className="p-2 rounded-lg bg-slate-800/30 border border-slate-700/30">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-slate-200 font-medium truncate">{channel.name}</span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => refreshChannel(channel)}
                          className="p-1 rounded text-slate-500 hover:text-emerald-400 transition-colors"
                          title="刷新"
                        >
                          <RefreshCw className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => removeFromMonitor(channel.id)}
                          className="p-1 rounded text-slate-500 hover:text-red-400 transition-colors"
                          title="移除"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    {channel.lastVideoTitle && (
                      <div className="mt-1 text-xs text-slate-500 line-clamp-1">
                        最新：{channel.lastVideoTitle}
                      </div>
                    )}
                    <div className="mt-1 text-xs text-slate-600">
                      {channel.lastVideoDate ? `更新: ${channel.lastVideoDate}` : '从未更新'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 视频解析 */}
          <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Download className="w-4 h-4 text-blue-400" />
              <h2 className="text-sm font-medium text-slate-200">视频解析</h2>
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
                <div className="flex items-center gap-3 text-xs text-slate-500 mb-3">
                  <span className="flex items-center gap-1">
                    <Eye className="w-3 h-3" />
                    {formatNumber(parsedVideo.viewCount)} 次观看
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {parsedVideo.duration}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <a
                    href={parsedVideo.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 bg-emerald-500/10 text-emerald-400 rounded-md text-xs hover:bg-emerald-500/20 transition-colors flex items-center gap-1"
                  >
                    <ExternalLink className="w-3 h-3" />
                    观看视频
                  </a>
                  <button
                    type="button"
                    disabled={metubeBusy}
                    onClick={() => queueMetubeDownload(parsedVideo.url)}
                    className="px-3 py-1.5 bg-amber-500/10 text-amber-400 rounded-md text-xs hover:bg-amber-500/20 transition-colors flex items-center gap-1 disabled:opacity-50"
                  >
                    {metubeBusy ? '提交中…' : 'MeTube 下载'}
                  </button>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(parsedVideo.url, 'url')}
                    className="px-3 py-1.5 bg-slate-700/50 text-slate-300 rounded-md text-xs hover:bg-slate-700 transition-colors flex items-center gap-1"
                  >
                    {copiedId === 'url' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    复制链接
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
