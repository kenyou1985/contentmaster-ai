/**
 * YouTube 频道监控与爆款分析
 *
 * 功能模块：
 * - 频道分组管理（增删改、拖拽排序）
 * - 多维度榜单（播放量 / 涨速 / 互动率 / 新晋）
 * - 关键词定时监控 + 浏览器通知
 * - 爆款趋势分析 + 趋势分
 * - 视频对比
 * - 竞争频道发现
 * - 词云
 * - CSV/JSON 导出
 * - API 配额指示器
 *
 * 数据层：storageService (IndexedDB)
 * 分析层：youtubeAnalyticsService
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search, Video, Monitor, Download, ExternalLink, Loader2, Settings,
  Eye, Clock, RefreshCw, Rss, Trash2, Plus, Copy, Check, CheckCircle,
  AlertCircle, Youtube, ThumbsUp, Tag, Link2, ChevronDown, ChevronUp,
  FileText, Music, Image, Subtitles, MessageCircle, ChevronLeft, ChevronRight,
  TrendingUp, BarChart2, Zap, Star, Users, FolderOpen, PlusCircle,
  X, Edit2, GripVertical, Bell, BellOff, Play, LayoutGrid,
  DownloadCloud, TrendingDown, Crown, Sparkles, BarChart, GitCompare,
  PieChart, StarHalf, ArrowUp, ArrowDown, Minus, Filter,
} from 'lucide-react';

// ── 导入服务 ─────────────────────────────────────────────────────────
import {
  storage,
  genId,
  type ChannelGroup,
  type KeywordMonitor,
  type KeywordSearchResult,
  type VideoComparison,
  type VideoSnapshot,
} from '../services/storageService';
import {
  type VideoMeta,
  type ChannelMeta,
  type TrendingVideo,
  type RankingDimension,
  type TimeRange,
  type RankingResult,
  type WordCloudEntry,
  type CompetitorChannel,
  ytSearchVideos,
  ytGetChannelVideos,
  ytGetVideoDetail,
  ytSearchChannels,
  computeRanking,
  computeGroupRanking,
  buildWordCloud,
  discoverCompetitors,
  checkQuotaStatus,
  calcTrendScore,
  generateReason,
  saveVideoSnapshot,
  isQuotaFallbackActive,
  setQuotaFallbackActive as setYtQuotaFallback,
} from '../services/youtubeAnalyticsService';

// ── 配置 ──────────────────────────────────────────────────────────────
const YOUTUBE_API_KEY = (import.meta as any).env?.VITE_YOUTUBE_API_KEY || '';
const VITE_METUBE_PUBLIC_URL = ((import.meta as any).env?.VITE_METUBE_PUBLIC_URL as string | undefined)?.trim() || '';

// ── 工具函数 ─────────────────────────────────────────────────────────

const formatNumber = (num: number): string => {
  if (num >= 100_000_000) return (num / 100_000_000).toFixed(1) + '亿';
  if (num >= 10_000) return (num / 10_000).toFixed(1) + '万';
  return num.toLocaleString();
};

const parseViewCount = (text: string): number => {
  const m = text.match(/[\d,]+/);
  if (!m) return 0;
  return parseInt(m[0].replace(/,/g, ''));
};

const formatDuration = (sec: number): string => {
  if (!sec) return '未知';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const formatAgo = (ts: number): string => {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (d > 0) return `${d}天前`;
  if (h > 0) return `${h}小时前`;
  if (m > 0) return `${m}分钟前`;
  return '刚刚';
};

function sanitizeBasename(name: string): string {
  return String(name || 'download').replace(/[/\\?%*:|"<>]/g, '_').trim().slice(0, 180) || 'download';
}

type MetubeDownloadKind = 'video' | 'audio' | 'captions' | 'thumbnail';

type MonitorSortMode = 'published_desc' | 'views_desc' | 'engagement_desc';

function engagementRatio(v: VideoMeta | TrendingVideo): number {
  return ((v.likeCount ?? 0) + (v.commentCount ?? 0)) / Math.max(1, v.viewCount);
}

function sortVideosForMonitor(list: VideoMeta[], mode: MonitorSortMode): VideoMeta[] {
  const copy = [...list];
  switch (mode) {
    case 'views_desc':
      return copy.sort((a, b) => b.viewCount - a.viewCount || b.publishedAt - a.publishedAt);
    case 'engagement_desc':
      return copy.sort((a, b) => engagementRatio(b) - engagementRatio(a) || b.viewCount - a.viewCount || b.publishedAt - a.publishedAt);
    case 'published_desc':
    default:
      return copy.sort((a, b) => b.publishedAt - a.publishedAt);
  }
}

// ── 组件主入口 ──────────────────────────────────────────────────────

export const YouTubeMonitor: React.FC = () => {
  // ── API 配置状态 ────────────────────────────────────────────────
  const [userApiKey, setUserApiKey] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const activeApiKey = YOUTUBE_API_KEY || userApiKey;
  const isUsingOfficial = !!activeApiKey;

  // ── Tab 状态 ──────────────────────────────────────────────────
  type MainTab = 'monitor' | 'rankings' | 'keywords' | 'analysis' | 'compare';
  const [activeTab, setActiveTab] = useState<MainTab>('monitor');

  // ── 频道分组状态 ────────────────────────────────────────────────
  const [channelGroups, setChannelGroups] = useState<ChannelGroup[]>([]);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [draggedChannelId, setDraggedChannelId] = useState<string | null>(null);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');

  // ── 监控频道状态 ────────────────────────────────────────────────
  const [monitoredChannelIds, setMonitoredChannelIds] = useState<Set<string>>(new Set());
  const [channelMetaMap, setChannelMetaMap] = useState<Map<string, ChannelMeta>>(new Map());
  const [groupVideos, setGroupVideos] = useState<Map<string, VideoMeta[]>>(new Map());
  const [monitorSortMode, setMonitorSortMode] = useState<MonitorSortMode>('published_desc');
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [loadingChannels, setLoadingChannels] = useState<Set<string>>(new Set());

  // ── 榜单状态 ──────────────────────────────────────────────────
  const [rankingDimension, setRankingDimension] = useState<RankingDimension>('views');
  const [rankingTimeRange, setRankingTimeRange] = useState<TimeRange>('7d');
  const [rankingResult, setRankingResult] = useState<RankingResult | null>(null);
  const [isRankingLoading, setIsRankingLoading] = useState(false);

  // ── 关键词监控状态 ──────────────────────────────────────────────
  const [keywordMonitors, setKeywordMonitors] = useState<KeywordMonitor[]>([]);
  const [keywordResults, setKeywordResults] = useState<Map<string, KeywordSearchResult[]>>(new Map());
  const [newKeyword, setNewKeyword] = useState('');
  const [isKeywordFetching, setIsKeywordFetching] = useState(false);
  const [keywordIntervals, setKeywordIntervals] = useState<Map<string, ReturnType<typeof setInterval>>>(new Map());

  // ── 视频分析状态 ───────────────────────────────────────────────
  const [analysisVideo, setAnalysisVideo] = useState<VideoMeta | TrendingVideo | null>(null);
  const [analysisHistory, setAnalysisHistory] = useState<VideoSnapshot[]>([]);
  const [isLoadingAnalysis, setIsLoadingAnalysis] = useState(false);
  const [wordCloud, setWordCloud] = useState<WordCloudEntry[]>([]);
  const [competitors, setCompetitors] = useState<CompetitorChannel[]>([]);
  const [isDiscoveringCompetitors, setIsDiscoveringCompetitors] = useState(false);

  // ── 视频对比状态 ────────────────────────────────────────────────
  const [compareVideos, setCompareVideos] = useState<VideoMeta[]>([]);

  // ── 搜索状态 ──────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ChannelMeta[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [channelLinkInput, setChannelLinkInput] = useState('');
  const [resolvingChannel, setResolvingChannel] = useState(false);

  // ── 视频解析 / 下载状态 ─────────────────────────────────────────
  const [videoUrl, setVideoUrl] = useState('');
  const [parsedVideo, setParsedVideo] = useState<VideoMeta | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [activeDownloads, setActiveDownloads] = useState<Record<string, {
    status: 'queued' | 'downloading' | 'completed' | 'error';
    progress?: number; error?: string; fileHref?: string;
  }>>({});
  const [metubeKind, setMetubeKind] = useState<MetubeDownloadKind>('video');
  const [metubeVideoQuality, setMetubeVideoQuality] = useState('best');
  const [metubeAudioFormat, setMetubeAudioFormat] = useState('m4a');
  const [metubeAudioQuality, setMetubeAudioQuality] = useState('best');
  const [metubeCaptionFormat, setMetubeCaptionFormat] = useState('srt');
  const [metubeSubtitleLanguage, setMetubeSubtitleLanguage] = useState<'auto' | 'en' | 'zh-Hans' | 'zh-Hant' | 'ja' | 'ko'>('auto');
  const [descExpanded, setDescExpanded] = useState(false);
  const parseSectionRef = useRef<HTMLDivElement | null>(null);

  // ── 提示 / 错误状态 ─────────────────────────────────────────────
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [quotaStatus, setQuotaStatus] = useState({ usedToday: 0, remaining: 10000, percentUsed: 0 });
  // 本地镜像 service 的 fallback 状态（通过自定义事件驱动更新）
  const [quotaFallbackActive, setQuotaFallbackUi] = useState(false);
  useEffect(() => {
    const handler = () => setQuotaFallbackUi(isQuotaFallbackActive());
    window.addEventListener('yt-quota-fallback', handler);
    return () => window.removeEventListener('yt-quota-fallback', handler);
  }, []);

  // ── 复制状态 ──────────────────────────────────────────────────
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // ── 初始化：加载分组和关键词 ────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const groups = await storage.getChannelGroups();
        setChannelGroups(groups.length ? groups : []);
        const monitors = await storage.getKeywordMonitors();
        setKeywordMonitors(monitors);
        const comparisons = await storage.getVideoComparisons();
        if (comparisons.length) setCompareVideos([]);
        const qs = await checkQuotaStatus();
        setQuotaStatus(qs);
        const savedKey = await storage.get<string>('YOUTUBE_API_KEY');
        if (savedKey) setUserApiKey(savedKey);
      } catch (e) {
        console.error('[YouTubeMonitor] 本地数据加载失败', e);
        setErrorMsg(
          '本地存储初始化失败，请强制刷新页面（Ctrl+Shift+R）。若仍失败，请在浏览器设置中清除本站数据后重试。'
        );
      }
    };
    void load();
  }, []);

  // ── 启动关键词定时任务 ───────────────────────────────────────────
  useEffect(() => {
    const timers: ReturnType<typeof setInterval>[] = [];
    for (const km of keywordMonitors) {
      if (!km.enabled) continue;
      const intervalMs = (km.intervalMinutes || 30) * 60 * 1000;
      const timer = setInterval(() => {
        void fetchKeywordResults(km.keyword);
      }, Math.max(intervalMs, 60_000));
      timers.push(timer);
      setKeywordIntervals(prev => new Map(prev).set(km.id, timer));
    }
    return () => {
      for (const t of timers) clearInterval(t);
    };
  }, [keywordMonitors]);

  // ── 存储 helpers ─────────────────────────────────────────────────
  const saveApiKey = useCallback(async (key: string) => {
    await storage.set('YOUTUBE_API_KEY', key);
  }, []);

  useEffect(() => {
    if (userApiKey) void saveApiKey(userApiKey).catch((err) => console.warn('[YouTubeMonitor] 保存 API Key 失败', err));
  }, [userApiKey, saveApiKey]);

  // ── 频道分组 CRUD ───────────────────────────────────────────────
  const loadGroups = useCallback(async () => {
    const groups = await storage.getChannelGroups();
    setChannelGroups(groups.length ? groups : []);
  }, []);

  const createGroup = useCallback(async () => {
    if (!newGroupName.trim()) return;
    const group: ChannelGroup = {
      id: genId('grp_'),
      name: newGroupName.trim(),
      color: GROUP_COLORS[channelGroups.length % GROUP_COLORS.length],
      channelIds: [],
      order: channelGroups.length,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await storage.saveChannelGroup(group);
    await loadGroups();
    setNewGroupName('');
    setShowNewGroup(false);
  }, [newGroupName, channelGroups.length, loadGroups]);

  const deleteGroup = useCallback(async (id: string) => {
    await storage.deleteChannelGroup(id);
    await loadGroups();
    if (selectedGroupId === id) setSelectedGroupId(null);
  }, [selectedGroupId, loadGroups]);

  const renameGroup = useCallback(async (id: string, newName: string) => {
    const group = channelGroups.find(g => g.id === id);
    if (!group) return;
    await storage.saveChannelGroup({ ...group, name: newName.trim(), updatedAt: Date.now() });
    await loadGroups();
    setEditingGroupId(null);
  }, [channelGroups, loadGroups]);

  const addChannelToGroup = useCallback(async (groupId: string, channelId: string) => {
    const group = channelGroups.find(g => g.id === groupId);
    if (!group || group.channelIds.includes(channelId)) return;
    await storage.saveChannelGroup({
      ...group,
      channelIds: [...group.channelIds, channelId],
      updatedAt: Date.now(),
    });
    await loadGroups();
    // 开始加载该频道的视频
    void fetchGroupChannelVideos(groupId, channelId);
  }, [channelGroups, loadGroups]);

  const removeChannelFromGroup = useCallback(async (groupId: string, channelId: string) => {
    const group = channelGroups.find(g => g.id === groupId);
    if (!group) return;
    await storage.saveChannelGroup({
      ...group,
      channelIds: group.channelIds.filter(id => id !== channelId),
      updatedAt: Date.now(),
    });
    await loadGroups();
  }, [channelGroups, loadGroups]);

  // ── 抓取分组内频道视频 ───────────────────────────────────────────
  const fetchGroupChannelVideos = useCallback(async (groupId: string, channelId: string) => {
    setLoadingChannels(prev => new Set(prev).add(channelId));
    try {
      const videos = await ytGetChannelVideos(channelId, activeApiKey || undefined, 20);
      setGroupVideos(prev => {
        const next = new Map(prev);
        next.set(`${groupId}_${channelId}`, videos);
        return next;
      });
      // 保存视频快照
      for (const v of videos) {
        void saveVideoSnapshot(v);
      }
    } catch (e) {
      console.warn(`[YTMonitor] 抓取频道 ${channelId} 失败:`, e);
    } finally {
      setLoadingChannels(prev => {
        const next = new Set(prev);
        next.delete(channelId);
        return next;
      });
    }
  }, [activeApiKey]);

  const refreshSelectedGroup = useCallback(async () => {
    if (!selectedGroupId) return;
    const group = channelGroups.find(g => g.id === selectedGroupId);
    if (!group) return;
    setIsRefreshingAll(true);
    for (const cid of group.channelIds) {
      await fetchGroupChannelVideos(selectedGroupId, cid);
    }
    setIsRefreshingAll(false);
  }, [selectedGroupId, channelGroups, fetchGroupChannelVideos]);

  // ── 加载频道元数据 ───────────────────────────────────────────────
  const loadChannelMeta = useCallback(async (channelId: string) => {
    if (channelMetaMap.has(channelId)) return;
    try {
      let ch: ChannelMeta | null = null;
      if (activeApiKey) {
        try {
          const results = await ytSearchChannels(channelId, activeApiKey);
          ch = results.find(c => c.channelId === channelId) || results[0] || null;
          if (ch) {
            const detail = await ytGetChannelVideos(channelId, activeApiKey, 1).then(v => v[0]);
            if (detail) {
              ch = { ...ch, subscriberCount: ch.subscriberCount, videoCount: ch.videoCount };
            }
          }
          setYtQuotaFallback(false);
        } catch (e) {
          if (isQuotaError(e)) setYtQuotaFallback(true);
          throw e;
        }
      }
      if (!ch) {
        ch = {
          channelId,
          title: channelId,
          subscriberCount: 0,
          videoCount: 0,
          viewCount: 0,
          fetchedAt: Date.now(),
        };
      }
      setChannelMetaMap(prev => new Map(prev).set(channelId, ch!));
    } catch (e) {
      console.warn(`[YTMonitor] 加载频道 ${channelId} 元数据失败:`, e);
    }
  }, [activeApiKey, channelMetaMap]);

  // ── 榜单计算 ────────────────────────────────────────────────────
  const computeRankings = useCallback(async () => {
    setIsRankingLoading(true);
    try {
      // 收集所有分组的视频
      const allVideos: VideoMeta[] = [];
      for (const group of channelGroups) {
        for (const cid of group.channelIds) {
          const key = `${group.id}_${cid}`;
          const videos = groupVideos.get(key) || [];
          allVideos.push(...videos);
        }
      }
      // 去重
      const seen = new Set<string>();
      const deduped = allVideos.filter(v => { if (seen.has(v.videoId)) return false; seen.add(v.videoId); return true; });

      const result = await computeRanking(deduped, rankingDimension, rankingTimeRange);
      setRankingResult(result);
    } catch (e) {
      console.error('[YTMonitor] 榜单计算失败:', e);
      setErrorMsg('榜单计算失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setIsRankingLoading(false);
    }
  }, [channelGroups, groupVideos, rankingDimension, rankingTimeRange]);

  // ── 关键词监控 ──────────────────────────────────────────────────
  const fetchKeywordResults = useCallback(async (keyword: string) => {
    setIsKeywordFetching(true);
    try {
      const videos = await ytSearchVideos(keyword, activeApiKey || undefined, 30);
      const results: KeywordSearchResult[] = videos.map(v => ({
        id: genId(`kw_`),
        keyword,
        videoId: v.videoId,
        title: v.title,
        channelId: v.channelId,
        channelTitle: v.channelTitle,
        viewCount: v.viewCount,
        likeCount: v.likeCount,
        publishedAt: v.publishedAt,
        fetchedAt: Date.now(),
        thumbnail: v.thumbnail,
        url: v.url,
      }));
      await storage.saveKeywordResults(results);
      setKeywordResults(prev => new Map(prev).set(keyword, results));

      // 浏览器通知（新视频）
      const prev = keywordResults.get(keyword);
      if (prev && prev.length > 0) {
        const prevIds = new Set(prev.map(p => p.videoId));
        const newOnes = results.filter(r => !prevIds.has(r.videoId));
        if (newOnes.length > 0 && Notification.permission === 'granted') {
          new Notification(`📺 关键词 "${keyword}" 新增 ${newOnes.length} 条视频`, {
            body: newOnes[0].title.slice(0, 80),
          });
        }
      }
    } catch (e) {
      console.error('[YTMonitor] 关键词抓取失败:', e);
    } finally {
      setIsKeywordFetching(false);
    }
  }, [activeApiKey, keywordResults]);

  const addKeywordMonitor = useCallback(async () => {
    const kw = newKeyword.trim();
    if (!kw) return;
    if (keywordMonitors.find(m => m.keyword === kw)) return;
    const monitor: KeywordMonitor = {
      id: genId('km_'),
      keyword: kw,
      enabled: true,
      intervalMinutes: 30,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await storage.saveKeywordMonitor(monitor);
    setKeywordMonitors(prev => [...prev, monitor]);
    setNewKeyword('');
    // 立即抓取一次
    void fetchKeywordResults(kw);
  }, [newKeyword, keywordMonitors, fetchKeywordResults]);

  const removeKeywordMonitor = useCallback(async (id: string) => {
    await storage.deleteKeywordMonitor(id);
    setKeywordMonitors(prev => prev.filter(m => m.id !== id));
    const km = keywordMonitors.find(m => m.id === id);
    if (km) {
      setKeywordResults(prev => { const next = new Map(prev); next.delete(km.keyword); return next; });
    }
  }, [keywordMonitors]);

  const toggleKeywordMonitor = useCallback(async (id: string) => {
    const km = keywordMonitors.find(m => m.id === id);
    if (!km) return;
    const updated = { ...km, enabled: !km.enabled, updatedAt: Date.now() };
    await storage.saveKeywordMonitor(updated);
    setKeywordMonitors(prev => prev.map(m => m.id === id ? updated : m));
  }, [keywordMonitors]);

  // ── 视频分析 ────────────────────────────────────────────────────
  const analyzeVideo = useCallback(async (video: VideoMeta) => {
    setIsLoadingAnalysis(true);
    setAnalysisVideo(null);
    try {
      const [detail, history] = await Promise.all([
        ytGetVideoDetail(video.videoId, activeApiKey || undefined),
        storage.getVideoHistory(video.videoId),
      ]);
      setAnalysisVideo(detail);
      setAnalysisHistory(history);
    } catch (e) {
      setAnalysisVideo(video);
      setAnalysisHistory([]);
      console.warn('[YTMonitor] 视频详情加载失败，使用列表数据:', e);
    } finally {
      setIsLoadingAnalysis(false);
    }
  }, [activeApiKey]);

  const discoverCompetitorsForKeywords = useCallback(async () => {
    if (!activeApiKey) { setErrorMsg('需要配置 YouTube API Key 才能发现竞争频道'); return; }
    setIsDiscoveringCompetitors(true);
    try {
      const keywords = keywordMonitors.filter(m => m.enabled).map(m => m.keyword);
      if (!keywords.length) { setErrorMsg('请先添加至少一个关键词监控'); setIsDiscoveringCompetitors(false); return; }
      const comps = await discoverCompetitors(keywords, activeApiKey, 15);
      setCompetitors(comps);
    } catch (e) {
      setErrorMsg('竞争发现失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setIsDiscoveringCompetitors(false);
    }
  }, [activeApiKey, keywordMonitors]);

  // ── 词云 ────────────────────────────────────────────────────────
  const buildWordCloudForGroup = useCallback(async (groupId: string) => {
    const group = channelGroups.find(g => g.id === groupId);
    if (!group) return;
    const titles: string[] = [];
    for (const cid of group.channelIds) {
      const videos = groupVideos.get(`${groupId}_${cid}`) || [];
      titles.push(...videos.map(v => v.title));
    }
    if (!titles.length) { setWordCloud([]); return; }
    setWordCloud(buildWordCloud(titles));
  }, [channelGroups, groupVideos]);

  // ── 视频对比 ────────────────────────────────────────────────────
  const addToCompare = useCallback(async (video: VideoMeta) => {
    if (compareVideos.find(v => v.videoId === video.videoId)) return;
    if (compareVideos.length >= 6) { setErrorMsg('最多同时对比 6 个视频'); return; }
    setCompareVideos(prev => [...prev, video]);
  }, [compareVideos]);

  const removeFromCompare = useCallback((videoId: string) => {
    setCompareVideos(prev => prev.filter(v => v.videoId !== videoId));
  }, []);

  // ── 搜索频道 ────────────────────────────────────────────────────
  const doSearchChannels = useCallback(async (query: string) => {
    if (!query.trim()) return;
    setIsSearching(true);
    try {
      if (activeApiKey) {
        try {
          const results = await ytSearchChannels(query, activeApiKey);
          setYtQuotaFallback(false);
          setSearchResults(results);
          if (!results.length) {
            setErrorMsg('未搜索到频道，请换关键词或确认 API Key / 配额');
          }
        } catch (e) {
          if (isQuotaError(e)) setYtQuotaFallback(true);
          throw e;
        }
      } else {
        setSearchResults([]);
      }
    } catch {
      setErrorMsg('搜索失败');
    } finally {
      setIsSearching(false);
    }
  }, [activeApiKey]);

  const resolveChannelFromInput = useCallback(async () => {
    const raw = channelLinkInput.trim();
    if (!raw) return;
    if (!activeApiKey) {
      setErrorMsg('请先在右上角设置中填写 YouTube Data API Key，或配置环境变量 VITE_YOUTUBE_API_KEY');
      return;
    }
    setResolvingChannel(true);
    setErrorMsg(null);
    try {
      const ucMatch = raw.match(/UC[\w-]{22}/);
      if (ucMatch) {
        const list = await ytSearchChannels(ucMatch[0], activeApiKey);
        const ch = list[0];
        if (ch) setSearchResults([{ ...ch, channelId: ucMatch[0] }]);
        else setErrorMsg('未找到该频道（请检查频道 ID 是否正确，或 API 配额/权限是否足够）');
        return;
      }
      const chMatch = raw.match(/youtube\.com\/channel\/([^/?#]+)/i);
      if (chMatch?.[1]?.startsWith('UC')) {
        const list = await ytSearchChannels(chMatch[1], activeApiKey);
        const ch = list[0];
        if (ch) setSearchResults([{ ...ch, channelId: chMatch[1] }]);
        else setErrorMsg('未找到该频道，请检查链接或 API Key');
        return;
      }
      const handleMatch = raw.match(/youtube\.com\/@([^/?#]+)/i);
      const handle = handleMatch ? handleMatch[1] : raw.startsWith('@') ? raw.slice(1) : raw;
      await doSearchChannels(handle);
    } catch (e) {
      setErrorMsg('解析频道失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setResolvingChannel(false);
    }
  }, [channelLinkInput, activeApiKey, doSearchChannels]);

  // ── MeTube 下载 ──────────────────────────────────────────────────
  async function metubePostAdd(body: Record<string, unknown>) {
    const origin = window.location.origin;
    const res = await fetch(`${origin}/api/metube/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { const j = JSON.parse(text) as { error?: string }; if (j.error) msg = j.error; } catch { /* ignore */ }
      throw new Error(msg || `MeTube ${res.status}`);
    }
  }

  async function fetchMetubeHistory(): Promise<any[]> {
    const origin = window.location.origin;
    const res = await fetch(`${origin}/api/metube/history`);
    if (!res.ok) return [];
    try {
      const text = await res.text();
      const data = JSON.parse(text);
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  }

  function getDownloadKey(url: string, kind: MetubeDownloadKind) { return `${url}::${kind}`; }

  async function pollDownloadStatus(url: string, kind: MetubeDownloadKind, maxAttempts = 60) {
    const dlKey = getDownloadKey(url, kind);
    let attempts = 0;
    const poll = async () => {
      attempts++;
      const hist = await fetchMetubeHistory();
      const vid = url.split('v=')[1]?.split('&')[0] || '';
      const item = (hist as any[]).find((h: any) => {
        const hUrl = String(h.url || '');
        return hUrl.includes(vid) || hUrl.replace(/^https?:\/\/(www\.)?youtu\.be\//, 'https://youtube.com/watch?v=') === url;
      });
      if (item) {
        const status = String(item.status || item.state || '').toLowerCase();
        if (['completed', 'done', 'finished'].includes(status)) {
          const fileHref = VITE_METUBE_PUBLIC_URL && item.entry ? `${VITE_METUBE_PUBLIC_URL}/download/${encodeURIComponent(String(item.entry).split('/').pop() || '')}` : null;
          setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'completed', progress: 100, fileHref } }));
          return;
        } else if (['error', 'failed'].includes(status) || item.error) {
          setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: item.error || '下载失败' } }));
          return;
        } else {
          setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'downloading', progress: Math.min(95, Math.round((attempts / maxAttempts) * 100)) } }));
        }
      } else {
        setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'queued', progress: Math.min(20, attempts * 2) } }));
      }
      if (attempts < maxAttempts) {
        setTimeout(poll, 3000);
      } else {
        setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: '下载超时，请到 MeTube 检查' } }));
      }
    };
    poll();
  }

  async function queueMetubeDownload(url: string, kind: MetubeDownloadKind) {
    const dlKey = getDownloadKey(url, kind);
    setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'downloading', progress: 5 } }));
    setInfoMsg(null);
    setErrorMsg(null);
    try {
      const payload = buildMetubePayload(url, kind);
      await metubePostAdd(payload);
      setInfoMsg(`已提交「${kind}」到 MeTube 队列`);
      void pollDownloadStatus(url, kind);
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'MeTube 提交失败');
      setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: String(e) } }));
    }
  }

  function buildMetubePayload(url: string, kind: MetubeDownloadKind): Record<string, unknown> {
    const base: Record<string, unknown> = { url: url.trim(), auto_start: true };
    switch (kind) {
      case 'video': return { ...base, download_type: 'video', quality: metubeVideoQuality, format: 'any', codec: 'auto' };
      case 'audio': return { ...base, download_type: 'audio', format: metubeAudioFormat, quality: metubeAudioQuality };
      case 'captions': {
        const cap: Record<string, unknown> = { ...base, download_type: 'captions', format: metubeCaptionFormat, quality: 'best', codec: 'auto', subtitle_mode: 'prefer_manual' };
        if (metubeSubtitleLanguage !== 'auto') cap.subtitle_language = metubeSubtitleLanguage;
        return cap;
      }
      case 'thumbnail': return { ...base, download_type: 'thumbnail', format: 'jpg', quality: 'best', codec: 'auto' };
      default: return { ...base, download_type: 'video', quality: 'best', format: 'any', codec: 'auto' };
    }
  }

  async function parseVideo() {
    if (!videoUrl.trim()) return;
    const patterns = [/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/, /^([a-zA-Z0-9_-]{11})$/];
    let videoId = '';
    for (const p of patterns) { const m = videoUrl.match(p); if (m) { videoId = m[1]; break; } }
    if (!videoId) {
      setErrorMsg('无效的 YouTube 链接');
      requestAnimationFrame(() => parseSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      return;
    }
    setIsParsing(true);
    setErrorMsg(null);
    setInfoMsg(null);
    setParsedVideo(null);
    setDescExpanded(false);
    try {
      const detail = await ytGetVideoDetail(videoId, activeApiKey || undefined);
      setParsedVideo(detail);
      setInfoMsg('解析成功，下方已显示视频信息');
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const hint =
        !activeApiKey && /401|403|Unauthorized|Authorization/i.test(raw)
          ? '（未配置 API Key 时依赖 Invidious；请在设置中填写 YouTube API Key 或检查本地 /api/invidious 代理）'
          : '';
      setErrorMsg(`解析失败: ${raw}${hint}`);
    } finally {
      setIsParsing(false);
      requestAnimationFrame(() => parseSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    }
  }

  // ── 导出 ────────────────────────────────────────────────────────
  function exportCSV(videos: TrendingVideo[] | VideoMeta[], filename: string) {
    const header = ['视频ID', '标题', '频道', '播放量', '点赞', '评论', '发布时', '链接'];
    const rows = videos.map(v => [
      v.videoId,
      `"${v.title.replace(/"/g, '""')}"`,
      `"${v.channelTitle}"`,
      String(v.viewCount),
      String(v.likeCount ?? ''),
      String(v.commentCount ?? ''),
      new Date(v.publishedAt).toLocaleString('zh-CN'),
      v.url,
    ]);
    const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\n');
    downloadBlob(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), `${filename}.csv`);
  }

  function exportJSON(data: unknown, filename: string) {
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${filename}.json`);
  }

  function downloadBlob(blob: Blob, filename: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ── 渲染：辅助 ──────────────────────────────────────────────────
  function copyToClipboard(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  function getTrendScoreColor(score: number): string {
    if (score >= 80) return 'text-red-400';
    if (score >= 60) return 'text-orange-400';
    if (score >= 40) return 'text-yellow-400';
    return 'text-slate-400';
  }

  function getTrendScoreBg(score: number): string {
    if (score >= 80) return 'bg-red-500/20 border-red-500/40';
    if (score >= 60) return 'bg-orange-500/20 border-orange-500/40';
    if (score >= 40) return 'bg-yellow-500/20 border-yellow-500/40';
    return 'bg-slate-800/30 border-slate-700/30';
  }

  // ── 渲染：视频卡片 ───────────────────────────────────────────────
  const renderVideoCard = (video: VideoMeta | TrendingVideo, showScore = false) => {
    const isTrending = 'trendScore' in video;
    const score = isTrending ? (video as TrendingVideo).trendScore : 0;
    const reason = isTrending ? (video as TrendingVideo).reason : '';
    const dlKey = getDownloadKey(video.url, metubeKind);
    const dlState = activeDownloads[dlKey];
    const isDownloading = dlState?.status === 'downloading' || dlState?.status === 'queued';

    return (
      <div key={video.videoId} className={`flex gap-3 p-3 rounded-xl border transition-all ${showScore ? getTrendScoreBg(score) : 'bg-slate-800/30 border-slate-700/30'} hover:border-slate-600 hover:bg-slate-800/50`}>
        {/* 缩略图 */}
        <div className="relative flex-shrink-0">
          <img src={video.thumbnail || ''} alt={video.title} className="w-44 h-28 object-cover rounded-lg" />
          {video.duration != null && (
            <div className="absolute bottom-1 right-1 bg-black/80 text-white text-xs px-1 rounded">
              {formatDuration(video.duration)}
            </div>
          )}
          {isTrending && (
            <div className={`absolute top-1 left-1 px-1.5 py-0.5 rounded text-xs font-bold ${score >= 80 ? 'bg-red-600' : score >= 60 ? 'bg-orange-600' : score >= 40 ? 'bg-yellow-600' : 'bg-slate-700'} text-white`}>
              {score.toFixed(1)}
            </div>
          )}
        </div>

        {/* 右侧内容 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <a href={video.url} target="_blank" rel="noopener noreferrer" className="font-medium text-slate-200 hover:text-emerald-400 line-clamp-2 text-sm flex-1">
              {video.title}
            </a>
            {isTrending && reason && (
              <span className="text-[10px] text-slate-500 flex-shrink-0 max-w-[120px] line-clamp-2 text-right">{reason}</span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 min-w-0 text-xs text-slate-400">
            <Youtube className="w-3.5 h-3.5 text-red-500/90 flex-shrink-0" />
            <span className="truncate font-medium text-slate-300" title={video.channelTitle}>{video.channelTitle || '未知频道'}</span>
            {video.channelId && (
              <span className="text-[10px] text-slate-600 font-mono flex-shrink-0 hidden sm:inline" title={video.channelId}>
                {video.channelId.slice(0, 10)}…
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
            <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{new Date(video.publishedAt).toLocaleDateString('zh-CN')}</span>
            <span className="flex items-center gap-1"><Eye className="w-3 h-3" />{formatNumber(video.viewCount)}</span>
            {video.likeCount != null && <span className="flex items-center gap-1"><ThumbsUp className="w-3 h-3" />{formatNumber(video.likeCount)}</span>}
            {video.commentCount != null && <span className="flex items-center gap-1"><MessageCircle className="w-3 h-3" />{formatNumber(video.commentCount)}</span>}
          </div>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <button onClick={() => void analyzeVideo(video)} className="px-2 py-1 text-xs bg-emerald-500/10 text-emerald-400 rounded-md hover:bg-emerald-500/20 transition-colors flex items-center gap-1">
              <BarChart2 className="w-3 h-3" />分析
            </button>
            <button onClick={() => { if (!isDownloading) void queueMetubeDownload(video.url, metubeKind); }} disabled={isDownloading} className="px-2 py-1 text-xs bg-amber-500/10 text-amber-400 rounded-md hover:bg-amber-500/20 transition-colors flex items-center gap-1 disabled:opacity-50">
              {isDownloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              {isDownloading ? `${dlState?.progress || 0}%` : '下载'}
            </button>
            <button onClick={() => void addToCompare(video)} className="px-2 py-1 text-xs bg-slate-700/50 text-slate-300 rounded-md hover:bg-slate-700 transition-colors flex items-center gap-1">
              <GitCompare className="w-3 h-3" />对比
            </button>
            <a href={video.url} target="_blank" rel="noopener noreferrer" className="px-2 py-1 text-xs bg-slate-700/50 text-slate-300 rounded-md hover:bg-slate-700 transition-colors flex items-center gap-1">
              <ExternalLink className="w-3 h-3" />观看
            </a>
          </div>
        </div>
      </div>
    );
  };

  // ── 渲染：对比视图 ──────────────────────────────────────────────
  const renderCompareView = () => {
    if (!compareVideos.length) return (
      <div className="text-center py-16 text-slate-500">
        <GitCompare className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p>点击视频卡片的「对比」按钮添加视频</p>
        <p className="text-xs mt-1">最多同时对比 6 个视频</p>
      </div>
    );

    const metrics = [
      { label: '播放量', key: 'viewCount' as const, format: formatNumber },
      { label: '点赞', key: 'likeCount' as const, format: (n: number) => formatNumber(n ?? 0), highlight: true },
      { label: '评论', key: 'commentCount' as const, format: (n: number) => formatNumber(n ?? 0) },
      { label: '互动率', key: 'engagement' as const, format: (n: number) => `${(n * 100).toFixed(1)}%`, highlight: true },
      { label: '时长', key: 'duration' as const, format: (n: number) => formatDuration(n ?? 0) },
    ];

    const maxEngagement = Math.max(...compareVideos.map(v => ((v.likeCount ?? 0) + (v.commentCount ?? 0)) / Math.max(1, v.viewCount)));
    const maxViews = Math.max(...compareVideos.map(v => v.viewCount));

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-200">视频对比 <span className="text-slate-500 text-xs">({compareVideos.length} / 6)</span></h3>
          <button onClick={() => setCompareVideos([])} className="text-xs text-slate-500 hover:text-red-400 flex items-center gap-1">
            <Trash2 className="w-3 h-3" />清空
          </button>
        </div>

        {/* 视频头部 */}
        <div className="grid gap-3" style={{ gridTemplateColumns: `200px repeat(${compareVideos.length}, 1fr)` }}>
          <div /> {/* 左上角留空 */}
          {compareVideos.map(v => (
            <div key={v.videoId} className="relative">
              <img src={v.thumbnail || ''} alt={v.title} className="w-full aspect-video object-cover rounded-lg" />
              <p className="mt-1 text-xs text-slate-300 line-clamp-2">{v.channelTitle}</p>
              <button onClick={() => removeFromCompare(v.videoId)} className="mt-1 text-xs text-red-400 hover:text-red-300 flex items-center gap-1">
                <X className="w-3 h-3" />移除
              </button>
            </div>
          ))}
        </div>

        {/* 指标对比 */}
        <div className="space-y-2">
          {metrics.map(metric => (
            <div key={metric.label} className="grid gap-3 py-2 border-t border-slate-800" style={{ gridTemplateColumns: `120px repeat(${compareVideos.length}, 1fr)` }}>
              <div className="text-xs text-slate-500 flex items-center gap-1">{metric.highlight && <Star className="w-3 h-3 text-amber-400" />}{metric.label}</div>
              {compareVideos.map(v => {
                const raw = metric.key === 'engagement'
                  ? ((v.likeCount ?? 0) + (v.commentCount ?? 0)) / Math.max(1, v.viewCount)
                  : metric.key === 'viewCount'
                    ? v.viewCount
                    : metric.key === 'likeCount'
                      ? v.likeCount ?? 0
                      : metric.key === 'commentCount'
                        ? v.commentCount ?? 0
                        : v.duration ?? 0;
                const isBest = metric.key === 'viewCount'
                  ? v.viewCount === maxViews
                  : metric.key === 'engagement'
                    ? raw === maxEngagement
                    : false;
                return (
                  <div key={v.videoId} className={`text-xs text-slate-200 ${isBest && metric.highlight ? 'font-bold text-emerald-400' : ''}`}>
                    {metric.format(raw as number)}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── 渲染：分析面板 ───────────────────────────────────────────────
  const renderAnalysisPanel = () => {
    if (!analysisVideo && !isLoadingAnalysis) return (
      <div className="text-center py-16 text-slate-500">
        <BarChart2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p>点击视频卡片的「分析」按钮查看详情</p>
      </div>
    );
    if (isLoadingAnalysis) return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
      </div>
    );

    const video = analysisVideo!;
    const score = calcTrendScore(video, analysisHistory);
    const reason = generateReason(video, analysisHistory);

    // 历史趋势
    const sortedHistory = [...analysisHistory].sort((a, b) => a.fetchedAt - b.fetchedAt);
    const maxView = Math.max(...sortedHistory.map(s => s.viewCount), video.viewCount, 1);

    return (
      <div className="space-y-4">
        <div className="flex items-start gap-4">
          {video.thumbnail && (
            <img src={video.thumbnail} alt={video.title} className="w-64 rounded-xl flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-slate-100 text-lg line-clamp-2">{video.title}</h3>
            <p className="text-sm text-slate-400 mt-1">{video.channelTitle}</p>
            <div className="mt-2 flex flex-wrap gap-3 text-sm text-slate-500">
              <span className="flex items-center gap-1"><Eye className="w-4 h-4" />{formatNumber(video.viewCount)}播放</span>
              {video.likeCount != null && <span className="flex items-center gap-1"><ThumbsUp className="w-4 h-4" />{formatNumber(video.likeCount)}点赞</span>}
              {video.commentCount != null && <span className="flex items-center gap-1"><MessageCircle className="w-4 h-4" />{formatNumber(video.commentCount)}评论</span>}
              {video.duration != null && <span className="flex items-center gap-1"><Clock className="w-4 h-4" />{formatDuration(video.duration)}</span>}
            </div>
          </div>
          {/* 趋势分 */}
          <div className={`flex-shrink-0 w-20 h-20 rounded-2xl border-2 flex flex-col items-center justify-center ${score >= 80 ? 'border-red-500 bg-red-500/10' : score >= 60 ? 'border-orange-500 bg-orange-500/10' : score >= 40 ? 'border-yellow-500 bg-yellow-500/10' : 'border-slate-600 bg-slate-800/50'}`}>
            <span className={`text-2xl font-black ${getTrendScoreColor(score)}`}>{score.toFixed(0)}</span>
            <span className="text-[10px] text-slate-500">趋势分</span>
          </div>
        </div>

        {/* 推荐理由 */}
        <div className="bg-slate-800/30 rounded-xl p-3 border border-slate-700/30">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-medium text-amber-400">推荐理由</span>
          </div>
          <p className="text-sm text-slate-300">{reason}</p>
        </div>

        {/* 播放量趋势图（纯 CSS） */}
        {sortedHistory.length >= 2 && (
          <div className="bg-slate-800/30 rounded-xl p-3 border border-slate-700/30">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="w-4 h-4 text-cyan-400" />
              <span className="text-sm font-medium text-slate-300">播放量趋势</span>
              <span className="text-xs text-slate-500 ml-auto">{sortedHistory.length} 个数据点</span>
            </div>
            <div className="flex items-end gap-1 h-20">
              {sortedHistory.map((s, i) => {
                const height = Math.max(2, Math.round((s.viewCount / maxView) * 72));
                return (
                  <div key={i} className="flex-1 bg-cyan-500/60 rounded-t hover:bg-cyan-400/80 transition-colors group relative" style={{ height }}>
                    <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-300 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10">
                      {new Date(s.fetchedAt).toLocaleDateString('zh-CN')}: {formatNumber(s.viewCount)}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] text-slate-600 mt-1">
              <span>{new Date(sortedHistory[0].fetchedAt).toLocaleDateString('zh-CN')}</span>
              <span>今天</span>
            </div>
          </div>
        )}

        {/* 指标柱状对比 */}
        {compareVideos.length >= 2 && (
          <div className="bg-slate-800/30 rounded-xl p-3 border border-slate-700/30">
            <div className="flex items-center gap-2 mb-3">
              <BarChart className="w-4 h-4 text-violet-400" />
              <span className="text-sm font-medium text-slate-300">指标对比</span>
            </div>
            <div className="space-y-2">
              {[{ label: '播放量', key: 'viewCount' }, { label: '点赞', key: 'likeCount' }, { label: '评论', key: 'commentCount' }].map(m => {
                const vals = compareVideos.map(v => {
                  const val = m.key === 'viewCount' ? v.viewCount : m.key === 'likeCount' ? (v.likeCount ?? 0) : (v.commentCount ?? 0);
                  return val;
                });
                const maxVal = Math.max(...vals, 1);
                return (
                  <div key={m.label} className="flex items-center gap-2 text-xs">
                    <span className="w-12 text-slate-500">{m.label}</span>
                    {vals.map((val, i) => (
                      <div key={i} className="flex-1 flex items-center gap-1">
                        <div className="flex-1 bg-slate-700 rounded-full h-2 overflow-hidden">
                          <div className="h-full bg-emerald-500/70 rounded-full transition-all" style={{ width: `${(val / maxVal) * 100}%` }} />
                        </div>
                        <span className="w-16 text-right text-slate-400">{formatNumber(val)}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── 渲染：词云 ──────────────────────────────────────────────────
  const renderWordCloud = (entries: WordCloudEntry[], title = '词云分析') => {
    if (!entries.length) return null;
    const maxWeight = Math.max(...entries.map(e => e.weight), 1);
    const hashRot = (s: string, i: number) => {
      let h = i * 31;
      for (let c = 0; c < s.length; c++) h = (h + s.charCodeAt(c) * (c + 1)) % 360;
      return { rx: (h % 22) - 11, ry: ((h * 7) % 18) - 9, rz: (h % 12) - 6, z: (h % 14) };
    };
    return (
      <div className="relative overflow-hidden rounded-xl border border-slate-700/40 bg-gradient-to-br from-slate-900/90 via-slate-800/50 to-slate-900/90 p-4 shadow-inner">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_25%,rgba(16,185,129,0.12),transparent_50%)]" />
        <div className="relative z-10 mb-3 flex items-center gap-2">
          <PieChart className="h-4 w-4 text-pink-400" />
          <span className="text-sm font-medium text-slate-200">{title}</span>
          <span className="ml-auto text-[10px] text-slate-500">字号与热度相关 · 悬浮略放大</span>
        </div>
        <div
          className="relative z-10 flex min-h-[220px] flex-wrap content-center justify-center gap-x-4 gap-y-5 px-2 py-6"
          style={{ perspective: '960px' }}
        >
          {entries.slice(0, 48).map((e, i) => {
            const fontSize = 13 + Math.round((e.weight / maxWeight) * 22);
            const opacity = 0.5 + (e.weight / maxWeight) * 0.5;
            const { rx, ry, rz, z } = hashRot(e.word, i);
            const hue = 155 + (i * 19) % 75;
            const light = 68 - (e.weight / maxWeight) * 18;
            return (
              <span
                key={`${e.word}-${i}`}
                className="inline-block cursor-default select-none transition-transform duration-200 hover:z-20 hover:scale-110"
                style={{
                  fontSize: `${fontSize}px`,
                  opacity,
                  fontWeight: e.weight > maxWeight * 0.45 ? 700 : 500,
                  color: `hsl(${hue}, 52%, ${light}%)`,
                  transform: `rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) translateZ(${Math.round((e.weight / maxWeight) * 14)}px)`,
                  transformStyle: 'preserve-3d',
                  textShadow: `
                    0 1px 0 rgba(0,0,0,0.55),
                    0 2px 6px rgba(0,0,0,0.45),
                    0 ${4 + z * 0.15}px ${14 + z}px rgba(16,185,129,${0.12 + (e.weight / maxWeight) * 0.22})
                  `,
                }}
              >
                {e.word}
              </span>
            );
          })}
        </div>
      </div>
    );
  };

  // ── 渲染：竞争频道 ──────────────────────────────────────────────
  const renderCompetitors = () => {
    if (!competitors.length && !isDiscoveringCompetitors) return (
      <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-700/30">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-medium text-slate-300">竞争频道发现</span>
          </div>
          <button
            onClick={() => void discoverCompetitorsForKeywords()}
            disabled={isDiscoveringCompetitors || !activeApiKey}
            className="px-3 py-1 text-xs bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 transition-colors disabled:opacity-50 flex items-center gap-1"
          >
            {isDiscoveringCompetitors ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
            {isDiscoveringCompetitors ? '分析中...' : '发现竞争频道'}
          </button>
        </div>
        <p className="text-xs text-slate-500">基于关键词重叠度发现同类竞争频道，展示其趋势分和关键词重叠情况。</p>
      </div>
    );

    return (
      <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-700/30">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-medium text-slate-300">竞争频道 <span className="text-xs text-slate-500">({competitors.length})</span></span>
          </div>
          <button onClick={() => setCompetitors([])} className="text-xs text-slate-500 hover:text-red-400">关闭</button>
        </div>
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {competitors.map((c, i) => (
            <div key={c.channel.channelId} className="flex items-center gap-3 p-2 rounded-lg bg-slate-900/30 hover:bg-slate-800/50 transition-colors">
              <span className="text-xs text-slate-600 w-5 text-right">#{i + 1}</span>
              <img src={c.channel.thumbnail || ''} alt={c.channel.title} className="w-10 h-10 rounded-full flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-slate-200 truncate">{c.channel.title}</div>
                <div className="flex items-center gap-2 text-[10px] text-slate-500 mt-0.5">
                  <span>{formatNumber(c.channel.subscriberCount)} 订阅</span>
                  <span>·</span>
                  <span>趋势分 {c.recentTrendScore.toFixed(1)}</span>
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {c.overlapKeywords.slice(0, 3).map(kw => (
                    <span key={kw} className="px-1 py-0.5 bg-blue-500/10 text-blue-400 rounded text-[10px]">{kw}</span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── 主渲染 ───────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* 页面标题 */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="bg-red-500/10 p-2 rounded-lg border border-red-500/20">
            <Rss className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-100">YouTube 爆款监控</h1>
            <p className="text-xs text-slate-500">频道分组 · 多维榜单 · 关键词监控 · 趋势分析</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* API 状态 */}
          <div className={`px-3 py-1 rounded-full text-xs flex items-center gap-1.5 ${
            isUsingOfficial ? quotaFallbackActive ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30' : 'bg-red-500/10 text-red-400 border border-red-500/30' : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
          }`}>
            {isUsingOfficial ? <Youtube className="w-3 h-3" /> : <Rss className="w-3 h-3" />}
            {isUsingOfficial ? (quotaFallbackActive ? '配额告警 → Invidious' : '官方 API') : '备用 API'}
          </div>
          {/* 配额指示 */}
          <div className="px-2 py-1 rounded-full text-xs bg-slate-800/50 border border-slate-700/50 text-slate-400" title={`今日配额: ${formatNumber(quotaStatus.usedToday)} / 10,000`}>
            <span className={quotaStatus.percentUsed > 80 ? 'text-amber-400' : ''}>{formatNumber(quotaStatus.remaining)}</span>
            <span className="text-slate-600"> 剩余</span>
          </div>
          <button onClick={async () => { const qs = await checkQuotaStatus(); setQuotaStatus(qs); }} className="p-2 rounded-lg bg-slate-800/50 border border-slate-700 text-slate-400 hover:text-emerald-400 transition-all" title="刷新配额">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={() => setShowSettings(!showSettings)} className="p-2 rounded-lg bg-slate-800/50 border border-slate-700 text-slate-400 hover:text-emerald-400 transition-all">
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* 设置面板 */}
      {showSettings && (
        <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-emerald-400 mb-3">
            <Settings className="w-4 h-4" />
            <span className="text-sm font-medium">YouTube API 配置</span>
          </div>
          <div className="space-y-2 max-w-md">
            <label className="block text-xs text-slate-400 flex items-center gap-2">
              <Youtube className="w-4 h-4 text-red-400" />
              YouTube Data API v3 Key {!YOUTUBE_API_KEY && <span className="text-amber-400">(可选)</span>}
            </label>
            <input type="password" value={userApiKey} onChange={e => setUserApiKey(e.target.value)} placeholder={YOUTUBE_API_KEY ? '已配置环境变量' : '输入个人专用 API Key'} className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-red-500/50" />
            <p className="text-xs text-slate-500">{YOUTUBE_API_KEY ? '已通过环境变量配置' : '个人专用 Key 仅自己可用，配额独立'}</p>
            {!YOUTUBE_API_KEY && (
              <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1">
                <ExternalLink className="w-3 h-3" />申请 API Key
              </a>
            )}
            {/* 通知权限 */}
            <div className="pt-2 border-t border-slate-700/50">
              <p className="text-xs text-slate-400 mb-1">浏览器通知</p>
              {typeof Notification !== 'undefined' && Notification.permission === 'default' && (
                <button onClick={() => Notification.requestPermission()} className="px-3 py-1 text-xs bg-amber-500/20 text-amber-400 rounded-lg hover:bg-amber-500/30 transition-colors flex items-center gap-1">
                  <Bell className="w-3 h-3" />开启通知（关键词新视频提醒）
                </button>
              )}
              {typeof Notification !== 'undefined' && Notification.permission === 'granted' && (
                <span className="text-xs text-emerald-400 flex items-center gap-1"><Bell className="w-3 h-3" />通知已开启</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 提示消息 */}
      {infoMsg && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 flex items-center gap-2 text-emerald-300 text-sm">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />{infoMsg}
          <button onClick={() => setInfoMsg(null)} className="ml-auto text-emerald-400 hover:text-emerald-200">×</button>
        </div>
      )}
      {errorMsg && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center gap-2 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />{errorMsg}
          <button onClick={() => setErrorMsg(null)} className="ml-auto text-red-400 hover:text-red-200">×</button>
        </div>
      )}

      {/* 主内容区 */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        {/* 左侧：频道分组 + 关键词 */}
        <div className="xl:col-span-1 space-y-4">
          {/* 频道分组 */}
          <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-violet-400" />
                <h2 className="text-sm font-medium text-slate-200">频道分组</h2>
                <span className="text-xs text-slate-500">({channelGroups.length})</span>
              </div>
              <button onClick={() => setShowNewGroup(true)} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-emerald-400 transition-colors" title="新建分组">
                <PlusCircle className="w-4 h-4" />
              </button>
            </div>

            {/* 新建分组 */}
            {showNewGroup && (
              <div className="flex gap-2 mb-3">
                <input
                  value={newGroupName}
                  onChange={e => setNewGroupName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && void createGroup()}
                  placeholder="分组名称..."
                  autoFocus
                  className="flex-1 bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-violet-500/50"
                />
                <button onClick={() => void createGroup()} className="px-2 py-1 bg-emerald-500/20 text-emerald-400 rounded-lg text-xs hover:bg-emerald-500/30 transition-colors">创建</button>
                <button onClick={() => { setShowNewGroup(false); setNewGroupName(''); }} className="px-2 py-1 text-slate-500 hover:text-slate-300 text-xs">取消</button>
              </div>
            )}

            {/* 分组列表 */}
            {channelGroups.length === 0 ? (
              <div className="text-center py-6 text-slate-500 text-sm">
                <FolderOpen className="w-8 h-8 mx-auto mb-2 opacity-30" />
                暂无分组<br />
                <span className="text-xs">点击 + 新建分组</span>
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[400px] overflow-y-auto">
                {/* 全部频道选项 */}
                <div
                  onClick={() => { setSelectedGroupId(null); }}
                  className={`p-2 rounded-lg border cursor-pointer transition-colors text-sm ${!selectedGroupId ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400' : 'bg-slate-800/30 border-slate-700/30 text-slate-400 hover:border-slate-600'}`}
                >
                  <div className="flex items-center gap-2">
                    <LayoutGrid className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>全部频道</span>
                    <span className="ml-auto text-xs text-slate-600">{channelGroups.reduce((s, g) => s + g.channelIds.length, 0)}</span>
                  </div>
                </div>

                {channelGroups.map(group => (
                  <div
                    key={group.id}
                    onClick={() => { setSelectedGroupId(group.id); void buildWordCloudForGroup(group.id); void refreshSelectedGroup(); }}
                    className={`p-2 rounded-lg border cursor-pointer transition-colors group ${selectedGroupId === group.id ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-slate-800/30 border-slate-700/30 hover:border-slate-600'}`}
                  >
                    <div className="flex items-center gap-2">
                      {editingGroupId === group.id ? (
                        <input
                          value={editingGroupName}
                          onChange={e => setEditingGroupName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') void renameGroup(group.id, editingGroupName); if (e.key === 'Escape') setEditingGroupId(null); }}
                          onBlur={() => void renameGroup(group.id, editingGroupName)}
                          onClick={e => e.stopPropagation()}
                          autoFocus
                          className="flex-1 bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-xs text-slate-200 focus:outline-none"
                        />
                      ) : (
                        <>
                          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: group.color }} />
                          <span className="flex-1 text-sm text-slate-200 truncate">{group.name}</span>
                          <span className="text-xs text-slate-600">{group.channelIds.length}</span>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={(e) => { e.stopPropagation(); setEditingGroupId(group.id); setEditingGroupName(group.name); }} className="p-0.5 rounded text-slate-500 hover:text-slate-300" title="重命名"><Edit2 className="w-3 h-3" /></button>
                            <button onClick={(e) => { e.stopPropagation(); void deleteGroup(group.id); }} className="p-0.5 rounded text-slate-500 hover:text-red-400" title="删除"><Trash2 className="w-3 h-3" /></button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 频道添加区 */}
            <div className="mt-3 pt-3 border-t border-slate-700/30">
              <div className="flex gap-2">
                <input
                  value={channelLinkInput}
                  onChange={e => setChannelLinkInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && void resolveChannelFromInput()}
                  placeholder="频道链接 / UC... / @名"
                  className="flex-1 bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
                />
                <button onClick={() => void resolveChannelFromInput()} disabled={resolvingChannel || !channelLinkInput.trim()} className="px-2 py-1 bg-cyan-500/20 text-cyan-400 rounded-lg text-xs hover:bg-cyan-500/30 transition-colors disabled:opacity-50 flex items-center gap-1">
                  {resolvingChannel ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}
                  打开
                </button>
              </div>

              {/* 搜索结果（快速添加） */}
              {searchResults.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {searchResults.slice(0, 5).map(ch => {
                    const inAnyGroup = channelGroups.some(g => g.channelIds.includes(ch.channelId));
                    return (
                      <div key={ch.channelId} className="flex items-center gap-2 p-1.5 rounded-lg bg-slate-800/40 border border-slate-700/40 hover:border-slate-600 transition-colors">
                        <img src={ch.thumbnail || ''} alt={ch.title} className="w-7 h-7 rounded-full flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-slate-200 truncate">{ch.title}</div>
                          <div className="text-[10px] text-slate-600">{formatNumber(ch.subscriberCount)} 订阅</div>
                        </div>
                        <button
                          onClick={() => {
                            if (!selectedGroupId) { setErrorMsg('请先在左侧选择一个分组'); return; }
                            void addChannelToGroup(selectedGroupId, ch.channelId);
                          }}
                          disabled={inAnyGroup}
                          className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          title={inAnyGroup ? '已在某分组中' : `添加到「${channelGroups.find(g => g.id === selectedGroupId)?.name || '选中分组'}」`}
                        >
                          {inAnyGroup ? '已添加' : '添加'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 关键词监控 */}
          <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Search className="w-4 h-4 text-cyan-400" />
              <h2 className="text-sm font-medium text-slate-200">关键词监控</h2>
              <span className="text-xs text-slate-500">({keywordMonitors.length})</span>
              {isKeywordFetching && <Loader2 className="w-3 h-3 text-cyan-400 animate-spin ml-auto" />}
            </div>

            {/* 添加关键词 */}
            <div className="flex gap-2 mb-3">
              <input
                value={newKeyword}
                onChange={e => setNewKeyword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void addKeywordMonitor()}
                placeholder="例如：AI 视频生成"
                className="flex-1 bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
              />
              <button onClick={() => void addKeywordMonitor()} className="px-2 py-1 bg-cyan-500/20 text-cyan-400 rounded-lg text-xs hover:bg-cyan-500/30 transition-colors flex items-center gap-1">
                <Plus className="w-3 h-3" />添加
              </button>
            </div>

            {/* 关键词列表 */}
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {keywordMonitors.length === 0 && (
                <div className="text-center py-4 text-slate-500 text-xs">
                  暂无监控关键词<br />
                  <span className="text-slate-600">添加后将定时抓取新视频</span>
                </div>
              )}
              {keywordMonitors.map(km => (
                <div key={km.id} className="flex items-center gap-2 p-1.5 rounded-lg bg-slate-800/30 hover:bg-slate-800/50 transition-colors group">
                  <button
                    onClick={() => void toggleKeywordMonitor(km.id)}
                    className={`p-0.5 rounded flex-shrink-0 ${km.enabled ? 'text-cyan-400' : 'text-slate-600'}`}
                    title={km.enabled ? '暂停监控' : '开启监控'}
                  >
                    {km.enabled ? <Bell className="w-3 h-3" /> : <BellOff className="w-3 h-3" />}
                  </button>
                  <span className={`flex-1 text-xs truncate ${km.enabled ? 'text-slate-200' : 'text-slate-600'}`}>{km.keyword}</span>
                  {km.lastFetchedAt && <span className="text-[10px] text-slate-600 flex-shrink-0">{formatAgo(km.lastFetchedAt)}</span>}
                  <button onClick={() => { void fetchKeywordResults(km.keyword); void storage.saveKeywordMonitor({ ...km, lastFetchedAt: Date.now() }); setKeywordMonitors(prev => prev.map(m => m.id === km.id ? { ...m, lastFetchedAt: Date.now() } : m)); }} className="p-0.5 rounded text-slate-500 hover:text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity" title="立即刷新">
                    <RefreshCw className="w-3 h-3" />
                  </button>
                  <button onClick={() => void removeKeywordMonitor(km.id)} className="p-0.5 rounded text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity" title="删除">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 右侧：主内容 */}
        <div className="xl:col-span-3">
          {/* Tab 切换 */}
          <div className="flex items-center gap-1 bg-slate-900/50 border border-slate-700/50 rounded-xl p-1 mb-4 overflow-x-auto">
            {([
              { id: 'monitor', label: '监控面板', icon: Monitor },
              { id: 'rankings', label: '榜单', icon: Crown },
              { id: 'keywords', label: '关键词结果', icon: Search },
              { id: 'analysis', label: '趋势分析', icon: TrendingUp },
              { id: 'compare', label: '视频对比', icon: GitCompare },
            ] as const).map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  activeTab === tab.id ? 'bg-emerald-500/20 text-emerald-400' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                <tab.icon className="w-3.5 h-3.5" />
                {tab.label}
                {tab.id === 'keywords' && keywordMonitors.length > 0 && (
                  <span className="px-1 rounded-full bg-cyan-500/20 text-cyan-400 text-[10px]">{keywordMonitors.length}</span>
                )}
              </button>
            ))}
          </div>

          {/* Tab 内容 */}
          {activeTab === 'monitor' && (
            <div className="space-y-4">
              {/* 刷新按钮 */}
              <div className="flex items-center justify-between">
                <div className="text-sm text-slate-300">
                  {selectedGroupId
                    ? <>分组：<span className="text-emerald-400">{channelGroups.find(g => g.id === selectedGroupId)?.name}</span></>
                    : <span className="text-slate-500">全部频道</span>}
                  {isRefreshingAll && <Loader2 className="w-3 h-3 animate-spin inline ml-2 text-emerald-400" />}
                </div>
                <button
                  onClick={() => void refreshSelectedGroup()}
                  disabled={isRefreshingAll || !selectedGroupId}
                  className="px-3 py-1 text-xs bg-emerald-500/10 text-emerald-400 rounded-lg hover:bg-emerald-500/20 transition-colors disabled:opacity-50 flex items-center gap-1"
                >
                  <RefreshCw className={`w-3 h-3 ${isRefreshingAll ? 'animate-spin' : ''}`} />
                  刷新{selectedGroupId ? '分组' : '全部'}
                </button>
              </div>

              {/* 收集所有视频 */}
              {(() => {
                const allVideos: VideoMeta[] = [];
                if (selectedGroupId) {
                  const group = channelGroups.find(g => g.id === selectedGroupId);
                  if (group) {
                    for (const cid of group.channelIds) {
                      const vids = groupVideos.get(`${selectedGroupId}_${cid}`) || [];
                      allVideos.push(...vids);
                    }
                  }
                } else {
                  for (const group of channelGroups) {
                    for (const cid of group.channelIds) {
                      const vids = groupVideos.get(`${group.id}_${cid}`) || [];
                      allVideos.push(...vids);
                    }
                  }
                }
                const seen = new Set<string>();
                const deduped = allVideos.filter(v => { if (seen.has(v.videoId)) return false; seen.add(v.videoId); return true; });
                const sorted = sortVideosForMonitor(deduped, monitorSortMode);

                if (!sorted.length) return (
                  <div className="text-center py-20 text-slate-500">
                    <Video className="w-12 h-12 mx-auto mb-3 opacity-30" />
                    <p>暂无视频数据</p>
                    <p className="text-xs mt-1">搜索频道并添加到分组，然后点击「刷新」</p>
                  </div>
                );

                return (
                  <>
                    {/* 排序 + 导出 */}
                    <div className="flex flex-wrap items-center gap-2 justify-between">
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <Filter className="h-3 w-3 text-slate-500" />
                        <span className="text-slate-500">排序</span>
                        <select
                          value={monitorSortMode}
                          onChange={e => setMonitorSortMode(e.target.value as MonitorSortMode)}
                          className="rounded-lg border border-slate-700/80 bg-slate-800/70 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                        >
                          <option value="published_desc">最新发布（默认）</option>
                          <option value="views_desc">播放量从高到低</option>
                          <option value="engagement_desc">互动率（赞+评 / 播放）从高到低</option>
                        </select>
                        <span className="hidden sm:inline text-slate-600">同条件下按发布时间次要排序</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => exportCSV(sorted, `monitor_${selectedGroupId || 'all'}_${new Date().toISOString().slice(0, 10)}`)} className="px-3 py-1 text-xs bg-slate-800/50 text-slate-400 rounded-lg hover:bg-slate-800 transition-colors flex items-center gap-1">
                          <DownloadCloud className="w-3 h-3" />导出 CSV
                        </button>
                        <button onClick={() => exportJSON(sorted, `monitor_${selectedGroupId || 'all'}_${new Date().toISOString().slice(0, 10)}`)} className="px-3 py-1 text-xs bg-slate-800/50 text-slate-400 rounded-lg hover:bg-slate-800 transition-colors flex items-center gap-1">
                          <DownloadCloud className="w-3 h-3" />导出 JSON
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {sorted.map(v => renderVideoCard(v))}
                    </div>
                    {/* 词云（选中分组时显示） */}
                    {selectedGroupId && renderWordCloud(wordCloud, channelGroups.find(g => g.id === selectedGroupId)?.name + ' 词云')}
                  </>
                );
              })()}
            </div>
          )}

          {activeTab === 'rankings' && (
            <div className="space-y-4">
              {/* 榜单控制栏 */}
              <div className="flex items-center gap-3 bg-slate-900/50 border border-slate-700/50 rounded-xl p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">维度：</span>
                  {([
                    { id: 'views', label: '播放量', icon: Eye },
                    { id: 'growth', label: '涨速', icon: TrendingUp },
                    { id: 'engagement', label: '互动率', icon: ThumbsUp },
                    { id: 'new', label: '新晋', icon: Zap },
                  ] as const).map(d => (
                    <button
                      key={d.id}
                      onClick={() => setRankingDimension(d.id)}
                      className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors ${
                        rankingDimension === d.id ? 'bg-emerald-500/20 text-emerald-400' : 'text-slate-400 hover:bg-slate-800'
                      }`}
                    >
                      <d.icon className="w-3 h-3" />{d.label}
                    </button>
                  ))}
                </div>
                <div className="h-4 w-px bg-slate-700" />
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">时间：</span>
                  {([
                    { id: '24h', label: '24小时' },
                    { id: '7d', label: '7天' },
                    { id: '30d', label: '30天' },
                  ] as const).map(r => (
                    <button
                      key={r.id}
                      onClick={() => setRankingTimeRange(r.id)}
                      className={`px-2 py-1 rounded-lg text-xs transition-colors ${
                        rankingTimeRange === r.id ? 'bg-cyan-500/20 text-cyan-400' : 'text-slate-400 hover:bg-slate-800'
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => void computeRankings()}
                    disabled={isRankingLoading}
                    className="px-3 py-1 bg-amber-500/20 text-amber-400 rounded-lg text-xs hover:bg-amber-500/30 transition-colors disabled:opacity-50 flex items-center gap-1"
                  >
                    {isRankingLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Crown className="w-3 h-3" />}
                    {isRankingLoading ? '计算中...' : '计算榜单'}
                  </button>
                  {rankingResult && (
                    <button onClick={() => exportCSV(rankingResult.videos, `ranking_${rankingDimension}_${rankingTimeRange}_${new Date().toISOString().slice(0, 10)}`)} className="px-2 py-1 text-xs bg-slate-800/50 text-slate-400 rounded-lg hover:bg-slate-800 transition-colors flex items-center gap-1">
                      <DownloadCloud className="w-3 h-3" />导出
                    </button>
                  )}
                </div>
              </div>

              {/* 榜单列表 */}
              {!rankingResult ? (
                <div className="text-center py-20 text-slate-500">
                  <Crown className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>选择维度和时间范围，点击「计算榜单」</p>
                  <p className="text-xs mt-1">榜单基于所有分组的频道视频数据计算</p>
                </div>
              ) : rankingResult.videos.length === 0 ? (
                <div className="text-center py-16 text-slate-500">
                  <BarChart2 className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p>该范围暂无数据</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {/* 榜单头部 */}
                  <div className="flex items-center gap-2 text-xs text-slate-500 mb-2">
                    <Crown className="w-3.5 h-3.5 text-amber-400" />
                    <span className="font-medium text-slate-300">
                      {rankingResult.dimension === 'views' ? '播放量' : rankingResult.dimension === 'growth' ? '涨速' : rankingResult.dimension === 'engagement' ? '互动率' : '新晋'}榜
                    </span>
                    <span>·</span>
                    <span>{rankingResult.timeRange === '24h' ? '24小时' : rankingResult.timeRange === '7d' ? '7天' : '30天'}</span>
                    <span>·</span>
                    <span>{rankingResult.videos.length} 条</span>
                    <span className="ml-auto">计算于 {new Date(rankingResult.computedAt).toLocaleString('zh-CN')}</span>
                  </div>
                  {rankingResult.videos.map((v, i) => (
                    <div key={v.videoId} className="flex items-center gap-3">
                      {/* 排名 */}
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-black flex-shrink-0 ${i === 0 ? 'bg-amber-500/20 text-amber-400' : i === 1 ? 'bg-slate-400/20 text-slate-300' : i === 2 ? 'bg-orange-600/20 text-orange-400' : 'bg-slate-800/50 text-slate-500'}`}>
                        {i + 1}
                      </div>
                      {/* 视频卡片 */}
                      <div className="flex-1">{renderVideoCard(v, true)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'keywords' && (
            <div className="space-y-4">
              {keywordMonitors.length === 0 ? (
                <div className="text-center py-20 text-slate-500">
                  <Search className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>暂无关键词监控</p>
                  <p className="text-xs mt-1">在左侧添加关键词，将自动定时抓取</p>
                </div>
              ) : (
                keywordMonitors.map(km => {
                  const results = keywordResults.get(km.keyword) || [];
                  return (
                    <div key={km.id}>
                      <div className="flex items-center gap-2 mb-2">
                        <Tag className="w-4 h-4 text-cyan-400" />
                        <h3 className="text-sm font-medium text-slate-200">{km.keyword}</h3>
                        <span className="text-xs text-slate-500">{results.length} 条结果</span>
                        <button onClick={() => void fetchKeywordResults(km.keyword)} disabled={isKeywordFetching} className="ml-auto p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-cyan-400 transition-colors">
                          <RefreshCw className={`w-3 h-3 ${isKeywordFetching ? 'animate-spin' : ''}`} />
                        </button>
                      </div>
                      {!results.length ? (
                        <div className="text-center py-8 text-slate-600 text-sm">
                          {isKeywordFetching ? '抓取中...' : '暂无数据，点击刷新'}
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {results.map(r => renderVideoCard({
                            videoId: r.videoId,
                            title: r.title,
                            channelId: r.channelId,
                            channelTitle: r.channelTitle,
                            viewCount: r.viewCount,
                            likeCount: r.likeCount,
                            publishedAt: r.publishedAt,
                            fetchedAt: r.fetchedAt,
                            thumbnail: r.thumbnail,
                            url: r.url || `https://youtube.com/watch?v=${r.videoId}`,
                          }))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}

          {activeTab === 'analysis' && (
            <div className="space-y-4">
              {renderAnalysisPanel()}
              {renderCompetitors()}
              {/* 视频解析 */}
              <div ref={parseSectionRef} className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4 scroll-mt-4">
                <div className="flex items-center gap-2 mb-3">
                  <Download className="w-4 h-4 text-blue-400" />
                  <h2 className="text-sm font-medium text-slate-200">视频解析</h2>
                </div>
                {!activeApiKey && (
                  <p className="mb-3 text-xs text-amber-400/95 leading-relaxed">
                    未填写 YouTube API Key 时解析走 Invidious 镜像；若请求返回 401，请在顶部「YouTube API 配置」中填写 Key。
                  </p>
                )}
                {/* MeTube 选项 */}
                <div className="mb-3 space-y-1.5 rounded-lg border border-slate-700/60 bg-slate-800/30 p-2">
                  <label className="text-[10px] uppercase tracking-wider text-slate-500">MeTube 下载类型</label>
                  <select value={metubeKind} onChange={e => setMetubeKind(e.target.value as MetubeDownloadKind)} className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200">
                    <option value="video">视频</option><option value="audio">音频</option><option value="captions">字幕文件</option><option value="thumbnail">封面图</option>
                  </select>
                  {metubeKind === 'video' && (
                    <select value={metubeVideoQuality} onChange={e => setMetubeVideoQuality(e.target.value)} className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200">
                      <option value="best">最佳画质</option>{['2160','1440','1080','720','480','360','240'].map(q => <option key={q} value={q}>{q}p</option>)}
                    </select>
                  )}
                  {metubeKind === 'audio' && (
                    <>
                      <select value={metubeAudioFormat} onChange={e => setMetubeAudioFormat(e.target.value)} className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200">
                        {['m4a','mp3','opus','wav','flac'].map(f => <option key={f} value={f}>格式 {f}</option>)}
                      </select>
                    </>
                  )}
                  {metubeKind === 'captions' && (
                    <select value={metubeCaptionFormat} onChange={e => setMetubeCaptionFormat(e.target.value)} className="w-full bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200">
                      {['srt','vtt','txt','ttml'].map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  )}
                </div>
                <div className="flex gap-2">
                  <input value={videoUrl} onChange={e => setVideoUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && void parseVideo()} placeholder="粘贴 YouTube 视频链接..." className="flex-1 bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/50" />
                  <button onClick={() => void parseVideo()} disabled={isParsing || !videoUrl.trim()} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2">
                    {isParsing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    解析
                  </button>
                </div>
                {parsedVideo && (
                  <div className="mt-4 p-3 rounded-lg bg-slate-800/50 border border-slate-700/50">
                    <div className="flex gap-3">
                      {parsedVideo.thumbnail && <img src={parsedVideo.thumbnail} alt={parsedVideo.title} className="w-48 rounded-lg flex-shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-slate-200 text-sm line-clamp-2">{parsedVideo.title}</h3>
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500 mt-1">
                          <span className="flex items-center gap-1"><Eye className="w-3 h-3" />{formatNumber(parsedVideo.viewCount)}</span>
                          {parsedVideo.likeCount != null && <span className="flex items-center gap-1"><ThumbsUp className="w-3 h-3" />{formatNumber(parsedVideo.likeCount)}</span>}
                          {parsedVideo.duration != null && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatDuration(parsedVideo.duration)}</span>}
                        </div>
                        <div className="flex flex-wrap gap-2 mt-2">
                          <button onClick={() => void queueMetubeDownload(parsedVideo.url, metubeKind)} className="px-3 py-1 text-xs bg-amber-500/10 text-amber-400 rounded-md hover:bg-amber-500/20 transition-colors flex items-center gap-1">
                            <Download className="w-3 h-3" />下载{metubeKind === 'video' ? '视频' : metubeKind === 'audio' ? '音频' : metubeKind === 'captions' ? '字幕' : '封面'}
                          </button>
                          <button onClick={() => void analyzeVideo(parsedVideo)} className="px-3 py-1 text-xs bg-emerald-500/10 text-emerald-400 rounded-md hover:bg-emerald-500/20 transition-colors flex items-center gap-1">
                            <BarChart2 className="w-3 h-3" />分析
                          </button>
                          <button onClick={() => void addToCompare(parsedVideo)} className="px-3 py-1 text-xs bg-slate-700/50 text-slate-300 rounded-md hover:bg-slate-700 transition-colors flex items-center gap-1">
                            <GitCompare className="w-3 h-3" />对比
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'compare' && renderCompareView()}
        </div>
      </div>
    </div>
  );
};

// ── 工具函数（组件外）────────────────────────────────────────────────
function isQuotaError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /quota|ratelimit|rate.limit|exceeded|usage.limit|daily.limit|403|429/i.test(msg);
}

const GROUP_COLORS = ['#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#14b8a6'];
