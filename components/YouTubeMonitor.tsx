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
  PieChart, StarHalf, ArrowUp, ArrowDown, Minus, Filter, Heart,
  Brain, AlertTriangle,
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
  calcTrendScore,
  generateReason,
  saveVideoSnapshot,
  ytGetVideoComments,
  getKeywordSearchIndex,
  getTrendingKeywordsFromVideos,
  type CommentResult,
} from '../services/youtubeAnalyticsService';
import { streamContentGeneration } from '../services/geminiService';

// ── 配置 ──────────────────────────────────────────────────────────────
const YOUTUBE_API_KEY = (import.meta as any).env?.VITE_YOUTUBE_API_KEY || '';
const VITE_METUBE_PUBLIC_URL = ((import.meta as any).env?.VITE_METUBE_PUBLIC_URL as string | undefined)?.trim() || '';

// ── 静态关键词提取函数（用于词云）───────────────────────────────────
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'to', 'of', 'in', 'for', 'on', 'with',
  'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after',
  'and', 'or', 'but', 'not', 'no', 'so', 'very', 'just', 'this', 'that',
  'these', 'those', 'it', 'its', 'i', 'you', 'he', 'she', 'we', 'they',
  'official', 'video', 'hd', '4k', 'new', 'vs', 'part', 'ft', 'feat', 'live', 'today',
  'one', 'two', 'first',
  '的', '了', '和', '是', '在', '我', '有', '个', '他', '她', '们',
  '这', '那', '你', '也', '就', '都', '还', '与', '或', '不', '很',
  '会', '能', '要', '之', '以', '等', '为', '上', '下', '中', '来',
  '去', '后', '前', '大', '小', '多', '少', '一', '第', '更', '最',
]);

function getTrendingKeywordsFromVideosStatic(videos: { title: string; viewCount?: number }[]): { word: string; weight: number; views: number }[] {
  // 停用词（精简，只过滤无意义的虚词）
  const STOP_WORDS = new Set([
    // 英文停用
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'to', 'of', 'in', 'for', 'on', 'with',
    'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after',
    'and', 'or', 'but', 'not', 'no', 'so', 'very', 'just', 'this', 'that',
    'these', 'those', 'it', 'its', 'i', 'you', 'he', 'she', 'we', 'they',
    'my', 'your', 'his', 'her', 'our', 'their', 'what', 'which', 'who',
    'official', 'video', 'hd', '4k', 'new', 'vs', 'part', 'ft', 'feat', 'live',
    'one', 'two', 'three', 'four', 'first', 'second', 'third',
    'reaction', 'reactions', 'reacts', 'react',
    'official music', 'music video', 'audio', 'lyrics', 'lyric video',
    // 中文停用
    '的', '了', '和', '是', '在', '我', '有', '个', '他', '她', '们',
    '这', '那', '你', '也', '就', '都', '还', '与', '或', '不', '很',
    '会', '能', '要', '之', '以', '等', '为', '上', '下', '中', '来',
    '去', '后', '前', '大', '小', '多', '少', '一', '第', '更', '最',
    '视频', '教程', '完整', '版', '系列', '合集', '最新', '官方',
    '高清', '1080p', '4k',
  ]);

  const keywordStats = new Map<string, { count: number; totalViews: number }>();

  for (const video of videos) {
    const title = video.title || '';
    const views = video.viewCount || 0;

    // 提取中文词（2-4字）
    const chineseWords = title.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
    for (const word of chineseWords) {
      if (!STOP_WORDS.has(word) && !/^\d+$/.test(word) && word.length >= 2) {
        const stats = keywordStats.get(word) || { count: 0, totalViews: 0 };
        stats.count += 1;
        stats.totalViews += views;
        keywordStats.set(word, stats);
      }
    }

    // 提取英文词（纯单词，2-15字符，放宽限制）
    const englishWords = title.toLowerCase().split(/[\s\-_,\.!?()[\]{}:;"'【】《》（）\/\\|]+/);
    for (const word of englishWords) {
      if (word.length >= 2 && word.length <= 15 && /^[a-z0-9]+$/.test(word) && !STOP_WORDS.has(word)) {
        const stats = keywordStats.get(word) || { count: 0, totalViews: 0 };
        stats.count += 1;
        stats.totalViews += views;
        keywordStats.set(word, stats);
      }
    }
  }

  const maxViews = Math.max(...Array.from(keywordStats.values()).map(s => s.totalViews), 1);
  const maxCount = Math.max(...Array.from(keywordStats.values()).map(s => s.count), 1);

  return Array.from(keywordStats.entries())
    .map(([word, stats]) => ({
      word,
      weight: Math.round((stats.count / maxCount) * 50 + (stats.totalViews / maxViews) * 50),
      views: stats.totalViews,
      count: stats.count,
    }))
    .filter(item => item.count >= 1) // 出现1次就算
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 30); // 取前30个
}

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
  // ── 收藏相关类型 ──────────────────────────────────────────────
  type FavoriteVideo = {
    videoId: string;
    title: string;
    thumbnail: string;
    channelTitle: string;
    channelId?: string;
    viewCount: number;
    url: string;
    favoritedAt: number;
    groupId: string;
  };

  type FavoriteGroup = {
    id: string;
    name: string;
    color: string;
    videoIds: string[];
  };

  // ── API 配置状态 ────────────────────────────────────────────────
  const [userApiKey, setUserApiKey] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const activeApiKey = YOUTUBE_API_KEY || userApiKey;
  const isUsingOfficial = !!activeApiKey;

  // ── Tab 状态 ──────────────────────────────────────────────────
  type MainTab = 'monitor' | 'rankings' | 'keywords' | 'analysis' | 'compare' | 'comments';
  const [activeTab, setActiveTab] = useState<MainTab>('monitor');

  // ── 频道分组状态 ────────────────────────────────────────────────
  const [channelGroups, setChannelGroups] = useState<ChannelGroup[]>([]);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [draggedChannelId, setDraggedChannelId] = useState<string | null>(null);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [allChannels, setAllChannels] = useState<ChannelMeta[]>([]);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [leftExpandedGroupId, setLeftExpandedGroupId] = useState<string | null>(null); // 左侧分组展开状态

  // ── 监控频道状态 ────────────────────────────────────────────────
  const [monitoredChannelIds, setMonitoredChannelIds] = useState<Set<string>>(new Set());
  const [channelMetaMap, setChannelMetaMap] = useState<Map<string, ChannelMeta>>(new Map());
  const [groupVideos, setGroupVideos] = useState<Map<string, VideoMeta[]>>(new Map());
  const [monitorSortMode, setMonitorSortMode] = useState<MonitorSortMode>('published_desc');
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [loadingChannels, setLoadingChannels] = useState<Set<string>>(new Set());
  const [newVideoCounts, setNewVideoCounts] = useState<Map<string, number>>(new Map()); // 新视频数量（检测频道更新）

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

  // ── 关键词搜索状态 ──────────────────────────────────────────────
  const [keywordSearchQuery, setKeywordSearchQuery] = useState('');
  const [keywordSearchType, setKeywordSearchType] = useState<'keyword' | 'channel'>('keyword');
  const [keywordSearchSort, setKeywordSearchSort] = useState<'relevance' | 'date' | 'rating'>('relevance');
  const [keywordSearchDate, setKeywordSearchDate] = useState<string>('');
  const [keywordSearchResults, setKeywordSearchResults] = useState<KeywordSearchResult[]>([]);
  const [isKeywordSearching, setIsKeywordSearching] = useState(false);
  const [keywordIntervals, setKeywordIntervals] = useState<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const [keywordSearchIndex, setKeywordSearchIndex] = useState<{ keyword: string; estimatedViews: number; relatedKeywords: { word: string; 热度: string; searchIndex: number }[]; lastUpdated: number } | null>(null);
  const [isLoadingSearchIndex, setIsLoadingSearchIndex] = useState(false);

  // ── 频道视频列表状态 ───────────────────────────────────────────
  const [channelVideos, setChannelVideos] = useState<VideoMeta[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [isLoadingChannelVideos, setIsLoadingChannelVideos] = useState(false);

  // ── 词云缓存状态 ───────────────────────────────────────────────
  const [cachedKeywords, setCachedKeywords] = useState<Map<string, { keywords: WordCloudEntry[]; cachedAt: number }>>(new Map());

  // ── 视频分析状态 ───────────────────────────────────────────────
  const [analysisVideo, setAnalysisVideo] = useState<VideoMeta | TrendingVideo | null>(null);
  const [analysisHistory, setAnalysisHistory] = useState<VideoSnapshot[]>([]);
  const [isLoadingAnalysis, setIsLoadingAnalysis] = useState(false);
  const [wordCloud, setWordCloud] = useState<WordCloudEntry[]>([]);
  const [competitors, setCompetitors] = useState<CompetitorChannel[]>([]);
  const [isDiscoveringCompetitors, setIsDiscoveringCompetitors] = useState(false);

  // ── 视频对比状态 ────────────────────────────────────────────────
  const [compareVideos, setCompareVideos] = useState<VideoMeta[]>([]);

  // ── 评论提取状态 ───────────────────────────────────────────────
  const [commentVideoUrl, setCommentVideoUrl] = useState('');
  const [commentVideoId, setCommentVideoId] = useState('');
  const [commentResult, setCommentResult] = useState<CommentResult | null>(null);
  const [isLoadingComments, setIsLoadingComments] = useState(false);
  const [commentPage, setCommentPage] = useState(0);
  const COMMENT_PAGE_SIZE = 30;

  // ── 评论痛点分析状态 ──────────────────────────────────────────
  const [isAnalyzingPainPoints, setIsAnalyzingPainPoints] = useState(false);
  const [painPointsResult, setPainPointsResult] = useState<string | null>(null);

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
  // ── 复制状态 ──────────────────────────────────────────────────
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // ── 收藏状态 ─────────────────────────────────────────────────
  const [favorites, setFavorites] = useState<FavoriteVideo[]>([]);
  const [favoriteGroups, setFavoriteGroups] = useState<FavoriteGroup[]>([
    { id: 'default', name: '默认收藏', color: '#6366f1', videoIds: [] }
  ]);
  const [selectedFavoriteGroupId, setSelectedFavoriteGroupId] = useState<string>('default');
  const [showFavoritePicker, setShowFavoritePicker] = useState(false);
  const [favoritePickerVideo, setFavoritePickerVideo] = useState<VideoMeta | TrendingVideo | null>(null);
  const [customGroupName, setCustomGroupName] = useState('');
  const [favoriteToast, setFavoriteToast] = useState<string | null>(null);

  // ── 初始化：加载分组和关键词 ────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        // 加载已保存的频道元数据（解决刷新后频道列表为空的问题）
        const savedMeta = await storage.getChannelMetaMap();
        if (Object.keys(savedMeta).length > 0) {
          const map = new Map<string, ChannelMeta>();
          for (const [id, meta] of Object.entries(savedMeta)) map.set(id, meta);
          setChannelMetaMap(map);
        }
        const monitors = await storage.getKeywordMonitors();
        setKeywordMonitors(monitors);
        const comparisons = await storage.getVideoComparisons();
        if (comparisons.length) setCompareVideos([]);
        const savedKey = await storage.get<string>('YOUTUBE_API_KEY');
        if (savedKey) setUserApiKey(savedKey);
        // 初始化 allChannels（从分组中收集频道）
        await loadGroups();
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

  // 默认分组 ID
  const DEFAULT_GROUP_ID = 'default_group';

  // ── 频道分组 CRUD ───────────────────────────────────────────────
  const loadGroups = useCallback(async () => {
    let groups = await storage.getChannelGroups();
    
    // 确保默认分组存在
    const defaultGroupExists = groups.some(g => g.id === DEFAULT_GROUP_ID);
    if (!defaultGroupExists) {
      const defaultGroup: ChannelGroup = {
        id: DEFAULT_GROUP_ID,
        name: '默认分组',
        color: '#6366f1',
        channelIds: [],
        order: -1, // 默认分组排在最前
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await storage.saveChannelGroup(defaultGroup);
      groups = await storage.getChannelGroups();
    }
    
    setChannelGroups(groups.sort((a, b) => a.order - b.order));
    // 收集所有频道到 allChannels（直接从 storage 读取 channelMetaMap，确保初始化时也能获取）
    const savedMeta = await storage.getChannelMetaMap();
    const metaMap = new Map<string, ChannelMeta>();
    for (const [id, meta] of Object.entries(savedMeta)) metaMap.set(id, meta);
    // 同时更新 channelMetaMap state
    setChannelMetaMap(metaMap);
    const allChs: ChannelMeta[] = [];
    groups.forEach(g => {
      g.channelIds.forEach(id => {
        const ch = metaMap.get(id);
        if (ch && !allChs.some(c => c.channelId === id)) {
          allChs.push(ch);
        }
      });
    });
    setAllChannels(allChs);
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

  const addChannelToGroup = useCallback(async (groupId: string, channelId: string, channelMeta?: ChannelMeta) => {
    const group = channelGroups.find(g => g.id === groupId);
    if (!group || group.channelIds.includes(channelId)) return;
    await storage.saveChannelGroup({
      ...group,
      channelIds: [...group.channelIds, channelId],
      updatedAt: Date.now(),
    });
    // 保存频道元数据
    if (channelMeta) {
      if (!channelMetaMap.has(channelId)) {
        setChannelMetaMap(prev => new Map(prev).set(channelId, channelMeta));
        await storage.saveChannelMeta(channelMeta);
      }
    }
    await loadGroups();
    // 开始加载该频道的视频
    void fetchGroupChannelVideos(groupId, channelId);
  }, [channelGroups, channelMetaMap, loadGroups]);

  // 添加频道（自动归入默认分组）
  const addUngroupedChannel = useCallback(async (channel: ChannelMeta) => {
    if (allChannels.some(c => c.channelId === channel.channelId)) return;
    
    // 保存到默认分组
    const defaultGroup = channelGroups.find(g => g.id === DEFAULT_GROUP_ID) || {
      id: DEFAULT_GROUP_ID,
      name: '默认分组',
      color: '#6366f1',
      channelIds: [],
      order: -1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    await storage.saveChannelGroup({
      ...defaultGroup,
      channelIds: [...defaultGroup.channelIds, channel.channelId],
      updatedAt: Date.now(),
    });
    
    setAllChannels(prev => [...prev, channel]);
    if (!channelMetaMap.has(channel.channelId)) {
      setChannelMetaMap(prev => new Map(prev).set(channel.channelId, channel));
      void storage.saveChannelMeta(channel);
    }
    
    // 刷新分组并加载视频
    await loadGroups();
    void fetchGroupChannelVideos(DEFAULT_GROUP_ID, channel.channelId);
  }, [allChannels, channelMetaMap, channelGroups, loadGroups]);

  // ── 收藏功能 ─────────────────────────────────────────────────
  const toggleFavorite = useCallback((video: VideoMeta | TrendingVideo, groupId?: string) => {
    const videoId = video.videoId;
    const isFavorited = favorites.some(f => f.videoId === videoId);

    if (isFavorited) {
      // 取消收藏
      setFavorites(prev => prev.filter(f => f.videoId !== videoId));
      setFavoriteGroups(prev => prev.map(g => ({
        ...g,
        videoIds: g.videoIds.filter(id => id !== videoId)
      })));
    } else {
      // 添加收藏
      const targetGroupId = groupId || favoriteGroups[0]?.id || 'default';
      const groupName = favoriteGroups.find(g => g.id === targetGroupId)?.name || '默认收藏';
      const newFavorite: FavoriteVideo = {
        videoId,
        title: video.title,
        thumbnail: video.thumbnail || '',
        channelTitle: video.channelTitle,
        channelId: video.channelId,
        viewCount: video.viewCount,
        url: video.url,
        favoritedAt: Date.now(),
        groupId: targetGroupId,
      };
      setFavorites(prev => [...prev, newFavorite]);
      setFavoriteGroups(prev => prev.map(g =>
        g.id === targetGroupId
          ? { ...g, videoIds: [...g.videoIds, videoId] }
          : g
      ));
      // 弹窗通知
      setFavoriteToast(`已收藏到「${groupName}」`);
      setTimeout(() => setFavoriteToast(null), 3000);
    }
  }, [favorites, favoriteGroups]);

  const isVideoFavorited = useCallback((videoId: string) => {
    return favorites.some(f => f.videoId === videoId);
  }, [favorites]);

  const removeFavorite = useCallback((videoId: string) => {
    setFavorites(prev => prev.filter(f => f.videoId !== videoId));
    setFavoriteGroups(prev => prev.map(g => ({
      ...g,
      videoIds: g.videoIds.filter(id => id !== videoId)
    })));
  }, []);

  const addFavoriteGroup = useCallback((name: string) => {
    const newGroup: FavoriteGroup = {
      id: genId('favgrp_'),
      name,
      color: `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`,
      videoIds: [],
    };
    setFavoriteGroups(prev => [...prev, newGroup]);
  }, []);

  const removeFavoriteGroup = useCallback((groupId: string) => {
    if (groupId === 'default') return;
    const group = favoriteGroups.find(g => g.id === groupId);
    if (group) {
      // 把该组的视频移到默认组
      setFavorites(prev => prev.map(f =>
        f.groupId === groupId ? { ...f, groupId: 'default' } : f
      ));
      setFavoriteGroups(prev => prev.map(g =>
        g.id === 'default'
          ? { ...g, videoIds: [...g.videoIds, ...group.videoIds] }
          : g.id === groupId
            ? g
            : { ...g, videoIds: g.videoIds.filter(id => !group.videoIds.includes(id)) }
      ));
    }
    setFavoriteGroups(prev => prev.filter(g => g.id !== groupId));
  }, [favoriteGroups]);

  const moveFavoriteToGroup = useCallback((videoId: string, targetGroupId: string) => {
    setFavorites(prev => prev.map(f =>
      f.videoId === videoId ? { ...f, groupId: targetGroupId } : f
    ));
    setFavoriteGroups(prev => prev.map(g => {
      if (g.id === targetGroupId && !g.videoIds.includes(videoId)) {
        return { ...g, videoIds: [...g.videoIds, videoId] };
      }
      if (g.id !== targetGroupId) {
        return { ...g, videoIds: g.videoIds.filter(id => id !== videoId) };
      }
      return g;
    }));
  }, []);

  // 从全部频道中删除
  const removeFromAllChannels = useCallback(async (channelId: string) => {
    setAllChannels(prev => prev.filter(c => c.channelId !== channelId));
    setChannelMetaMap(prev => { const next = new Map(prev); next.delete(channelId); return next; });
    // 从所有分组中移除
    channelGroups.forEach(g => {
      if (g.channelIds.includes(channelId)) {
        void removeChannelFromGroup(g.id, channelId);
      }
    });
  }, [channelGroups]);

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

  // ── 抓取分组内频道视频（带缓存和新视频检测）───────────────────────
  const fetchGroupChannelVideos = useCallback(async (groupId: string, channelId: string, forceRefresh = false) => {
    // 获取旧视频列表用于比较
    const oldVideos = groupVideos.get(`${groupId}_${channelId}`) || [];
    const oldVideoIds = new Set(oldVideos.map(v => v.videoId));

    // 检查缓存（仅在非强制刷新时使用）
    if (!forceRefresh) {
      const cached = await storage.getCachedChannelVideos(channelId);
      if (cached && !storage.needsRefresh(cached.cachedAt, 30)) {
        setGroupVideos(prev => {
          const next = new Map(prev);
          next.set(`${groupId}_${channelId}`, cached.videos);
          return next;
        });
        // 检测新视频
        const newCount = cached.videos.filter(v => !oldVideoIds.has(v.videoId)).length;
        if (newCount > 0) {
          setNewVideoCounts(prev => {
            const next = new Map(prev);
            next.set(channelId, (prev.get(channelId) || 0) + newCount);
            return next;
          });
        }
        return; // 使用缓存
      }
    }

    setLoadingChannels(prev => new Set(prev).add(channelId));
    try {
      const videos = await ytGetChannelVideos(channelId, activeApiKey || undefined, 20);

      // 检测新增视频（通过比较 videoId）
      const newVideoIds = new Set(videos.map(v => v.videoId));
      const newCount = videos.filter(v => !oldVideoIds.has(v.videoId)).length;

      // 更新视频列表
      setGroupVideos(prev => {
        const next = new Map(prev);
        next.set(`${groupId}_${channelId}`, videos);
        return next;
      });

      // 如果有新视频，更新计数并提示
      if (newCount > 0) {
        setNewVideoCounts(prev => {
          const next = new Map(prev);
          next.set(channelId, (prev.get(channelId) || 0) + newCount);
          return next;
        });
        // 显示通知
        const channelName = channelMetaMap.get(channelId)?.title || channelId;
        setInfoMsg(`📺 ${channelName} 有 ${newCount} 个新视频`);
      }

      // 缓存结果
      await storage.cacheChannelVideos(channelId, videos);
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
  }, [activeApiKey, groupVideos, channelMetaMap]);

  // 加载分组内所有频道的视频（带缓存）
  const loadAllGroupChannels = useCallback(async (groupId: string, forceRefresh = false) => {
    const group = channelGroups.find(g => g.id === groupId);
    if (!group) return;
    // 刷新前清除该分组的新视频计数
    if (forceRefresh) {
      setNewVideoCounts(prev => {
        const next = new Map(prev);
        group.channelIds.forEach(cid => next.delete(cid));
        return next;
      });
    }
    for (const channelId of group.channelIds) {
      void fetchGroupChannelVideos(groupId, channelId, forceRefresh);
    }
  }, [channelGroups, fetchGroupChannelVideos]);

  const refreshSelectedGroup = useCallback(async () => {
    if (!selectedGroupId) return;
    const group = channelGroups.find(g => g.id === selectedGroupId);
    if (!group) return;
    setIsRefreshingAll(true);
    // 清除该分组的新视频计数
    setNewVideoCounts(prev => {
      const next = new Map(prev);
      group.channelIds.forEach(cid => next.delete(cid));
      return next;
    });
    for (const cid of group.channelIds) {
      await fetchGroupChannelVideos(selectedGroupId, cid, true); // 强制刷新
    }
    setIsRefreshingAll(false);
  }, [selectedGroupId, channelGroups, fetchGroupChannelVideos]);

  // ── 分组视频自动刷新（定时检查更新）─────────────────────────────
  useEffect(() => {
    if (!selectedGroupId || !channelGroups.length) return;

    const checkInterval = setInterval(async () => {
      const group = channelGroups.find(g => g.id === selectedGroupId);
      if (!group) return;

      for (const channelId of group.channelIds) {
        const cached = await storage.getCachedChannelVideos(channelId);
        if (cached && storage.needsRefresh(cached.cachedAt, 30)) {
          void fetchGroupChannelVideos(selectedGroupId, channelId, false);
        }
      }
    }, 10 * 60 * 1000); // 10分钟检查一次

    return () => clearInterval(checkInterval);
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
        } catch (e) {
          console.warn(`[YTMonitor] 加载频道 ${channelId} 元数据失败:`, e);
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
      void storage.saveChannelMeta(ch!);
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

  // 单次关键词搜索
  const searchKeyword = useCallback(async () => {
    const kw = keywordSearchQuery.trim();
    if (!kw) return;
    setIsKeywordSearching(true);
    setErrorMsg(null);
    setInfoMsg(null);
    try {
      const videos = await ytSearchVideos(kw, activeApiKey || undefined, 30);
      let results: KeywordSearchResult[] = videos.map(v => ({
        id: genId(`ks_`),
        keyword: kw,
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

      // 频道类型搜索 - 过滤结果
      if (keywordSearchType === 'channel') {
        const lowerKw = kw.toLowerCase();
        results = results.filter(r => r.channelTitle?.toLowerCase().includes(lowerKw));
      }

      // 按日期筛选
      if (keywordSearchDate) {
        const cutoff = Date.now() - parseInt(keywordSearchDate) * 24 * 60 * 60 * 1000;
        results = results.filter(r => r.publishedAt && r.publishedAt >= cutoff);
      }

      // 按排序
      if (keywordSearchSort === 'viewCount' || keywordSearchSort === 'rating') {
        results = [...results].sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
      } else if (keywordSearchSort === 'date') {
        results = [...results].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
      }

      setKeywordSearchResults(results);
      setInfoMsg(`搜索「${kw}」返回 ${results.length} 条结果`);

      // 同时获取搜索指数
      setIsLoadingSearchIndex(true);
      try {
        const indexData = await getKeywordSearchIndex(kw, activeApiKey || undefined);
        setKeywordSearchIndex(indexData);
      } catch (e) {
        console.warn('[YTMonitor] 获取搜索指数失败', e);
      } finally {
        setIsLoadingSearchIndex(false);
      }
    } catch (e) {
      console.error('[YTMonitor] 关键词搜索失败:', e);
      setErrorMsg('搜索失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setIsKeywordSearching(false);
    }
  }, [keywordSearchQuery, activeApiKey, keywordSearchType, keywordSearchDate, keywordSearchSort]);

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

  // ── 频道视频加载 ──────────────────────────────────────────────
  const loadChannelVideos = useCallback(async (channelId: string, forceRefresh = false) => {
    setSelectedChannelId(channelId);

    // 先尝试从缓存加载
    if (!forceRefresh) {
      const cached = await storage.getCachedChannelVideos(channelId);
      if (cached && !storage.needsRefresh(cached.cachedAt, 30)) { // 30分钟内不刷新
        setChannelVideos(cached.videos);
        setIsLoadingChannelVideos(false);
        return;
      }
    }

    setIsLoadingChannelVideos(true);
    try {
      const videos = await ytGetChannelVideos(channelId, activeApiKey || undefined, 30);
      setChannelVideos(videos);
      // 缓存结果
      await storage.cacheChannelVideos(channelId, videos);
    } catch (err) {
      console.error('[YouTubeMonitor] 加载频道视频失败:', err);
      // 加载失败时尝试使用缓存
      const cached = await storage.getCachedChannelVideos(channelId);
      if (cached) {
        setChannelVideos(cached.videos);
      } else {
        setChannelVideos([]);
      }
    } finally {
      setIsLoadingChannelVideos(false);
    }
  }, [activeApiKey]);

  // ── 视频分析 ────────────────────────────────────────────────────
  const analyzeVideo = useCallback(async (video: VideoMeta) => {
    // 自动填充视频 URL 并切换到解析区域
    setVideoUrl(video.url || `https://youtube.com/watch?v=${video.videoId}`);
    setActiveTab('analysis');
    requestAnimationFrame(() => parseSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));

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

  // ── 词云（带缓存）──────────────────────────────────────────────
  const buildWordCloudForGroup = useCallback(async (groupId: string) => {
    const group = channelGroups.find(g => g.id === groupId);
    if (!group) return;
    const videos: VideoMeta[] = [];
    for (const cid of group.channelIds) {
      videos.push(...(groupVideos.get(`${groupId}_${cid}`) || []));
    }
    if (!videos.length) { setWordCloud([]); return; }

    // 检查缓存（30分钟内有效）
    const cached = cachedKeywords.get(groupId);
    if (cached && Date.now() - cached.cachedAt < 30 * 60 * 1000) {
      setWordCloud(cached.keywords);
      return;
    }

    const keywords = await getTrendingKeywordsFromVideos(videos, activeApiKey || undefined);
    const wordCloudData = keywords.map(k => ({ word: k.word, count: k.views, weight: k.weight }));

    // 更新缓存
    setCachedKeywords(prev => {
      const next = new Map(prev);
      next.set(groupId, { keywords: wordCloudData, cachedAt: Date.now() });
      return next;
    });

    setWordCloud(wordCloudData);
  }, [channelGroups, groupVideos, activeApiKey, cachedKeywords]);

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
          setSearchResults(results);
          if (!results.length) {
            setErrorMsg('未搜索到频道，请换关键词或确认 API Key / 配额');
          }
        } catch (e) {
          console.warn('[YTMonitor] 搜索频道失败:', e);
          setErrorMsg('搜索失败');
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
      // 区分不同错误类型，给出更友好的提示
      const errLower = msg.toLowerCase();
      if (errLower.includes('403') || errLower.includes('forbidden')) {
        throw new Error(`MeTube 下载被拒绝 (403)：该视频可能受地区限制、版权保护或已下架。建议：1) 在 MeTube 后台上传 cookies；2) 尝试下载其他视频。`);
      } else if (errLower.includes('404') || errLower.includes('not found')) {
        throw new Error(`MeTube 未找到视频 (404)：视频可能已被删除或链接无效。`);
      } else if (errLower.includes('429') || errLower.includes('rate limit')) {
        throw new Error(`MeTube 请求过于频繁 (429)：请稍后再试。`);
      }
      throw new Error(msg || `MeTube ${res.status}`);
    }
    // 尝试解析响应，检测 MeTube 内部的错误
    try {
      const json = JSON.parse(text);
      if (json?.error || json?.message) {
        const me = json.error || json.message;
        const meLower = me.toLowerCase();
        if (meLower.includes('403') || meLower.includes('forbidden') || meLower.includes('http error')) {
          throw new Error(`MeTube 下载失败 (403)：该视频在 MeTube 服务器 IP 下被拒绝。可能原因：地区限制、版权保护、需登录。建议在 MeTube 后台上传 YouTube cookies。`);
        }
        throw new Error(me);
      }
    } catch (e) {
      if (e instanceof Error) throw e;
    }
    return text;
  }

  async function fetchMetubeHistory(): Promise<any[]> {
    try {
      const origin = window.location.origin;
      const url = `${origin}/api/metube/history`;
      console.log('[YouTubeMonitor] 请求 history API:', url);
      const res = await fetch(url);
      console.log('[YouTubeMonitor] history API 响应状态:', res.status, res.statusText);
      if (!res.ok) {
        const errText = await res.text();
        console.warn('[YouTubeMonitor] history fetch failed:', res.status, errText);
        return [];
      }
      const text = await res.text();
      console.log('[YouTubeMonitor] history API 原始响应:', text.substring(0, 500));
      const data = JSON.parse(text);
      if (!Array.isArray(data)) {
        console.warn('[YouTubeMonitor] history 响应不是数组:', typeof data, 'keys:', data ? Object.keys(data) : 'null');
        // 尝试从对象中提取数组（某些 API 返回 {done: [...]}, {items: [...]}, {downloads: [...]}, {videos: [...]}, {history: [...]}）
        if (data && typeof data === 'object') {
          const possibleKeys = ['done', 'items', 'downloads', 'videos', 'history', 'downloading', 'processing', 'queued'];
          for (const key of possibleKeys) {
            if (Array.isArray(data[key])) {
              console.log('[YouTubeMonitor] 从 data.' + key + ' 提取到数组，长度:', data[key].length);
              return data[key];
            }
          }
        }
        return [];
      }
      console.log('[YouTubeMonitor] history 数组长度:', data.length);
      if (data.length > 0) {
        console.log('[YouTubeMonitor] history 示例项:', JSON.stringify(data[0]).substring(0, 300));
      }
      return data;
    } catch (e) {
      console.error('[YouTubeMonitor] history fetch error:', e);
      return [];
    }
  }

  function getDownloadKey(url: string, kind: MetubeDownloadKind) { return `${url}::${kind}`; }

  async function pollDownloadStatus(url: string, kind: MetubeDownloadKind, maxAttempts = 60) {
    const dlKey = getDownloadKey(url, kind);
    let attempts = 0;
    console.log('[YouTubeMonitor] 开始轮询下载状态:', url, kind);

    const poll = async () => {
      attempts++;
      try {
        const hist = await fetchMetubeHistory();
        console.log(`[YouTubeMonitor] 轮询 #${attempts} - 历史记录数量:`, hist.length);

        const vid = url.split('v=')[1]?.split('&')[0] || '';
        // 尝试多种 URL 格式匹配
        const item = (hist as any[]).find((h: any) => {
          const hUrl = String(h.url || '');
          const normalizedHUrl = hUrl
            .replace(/^https?:\/\/(www\.)?youtu\.be\//, 'https://youtube.com/watch?v=')
            .replace(/^https?:\/\/(www\.)?youtube\.com\/watch\?v=/, 'https://youtube.com/watch?v=');
          const match = normalizedHUrl === url || hUrl.includes(vid) || hUrl.includes(`v=${vid}`);
          if (match) {
            console.log('[YouTubeMonitor] 匹配到历史项:', h.title || h.id, 'URL:', hUrl, 'vid:', vid);
          }
          return match;
        });

        if (item) {
          console.log('[YouTubeMonitor] 找到下载项:', item.title, '状态:', item.status, '错误:', item.error);
          const status = String(item.status || item.state || '').toLowerCase();
          const errorMsg = String(item.error || item.error_message || item.friendly_error || '').toLowerCase();
          const itemTitle = String(item.title || '').toLowerCase();
          
          // 检测 cookies 失效的特征：completed 但错误信息包含特定关键词
          const cookiesExpiredPatterns = [
            'no video formats found',
            'requested format is not available',
            'sign in to confirm',
            'not a bot',
            'cookies are no longer valid',
            'please update your cookies'
          ];
          const isCookiesExpired = cookiesExpiredPatterns.some(p => 
            errorMsg.includes(p) || itemTitle.includes(p)
          );
          
          // 检测 yt-dlp 下载失败的特征
          const downloadFailedPatterns = [
            'the downloaded file is empty',
            'http error 403',
            'forbidden',
            'unavailable',
            'private video',
            'login required'
          ];
          const isDownloadFailed = downloadFailedPatterns.some(p => errorMsg.includes(p)) || errorMsg.includes('403');

          if (['completed', 'done', 'finished'].includes(status)) {
            // 如果是 completed 但有错误信息，说明实���上下载失败了
            if (item.error || errorMsg) {
              if (isCookiesExpired) {
                const friendlyError = `下载失败：YouTube cookies 已失效。请在 MeTube 后台上传新的 YouTube cookies。`;
                console.error('[YouTubeMonitor] Cookies 失效:', errorMsg);
                setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: friendlyError } }));
                setErrorMsg(friendlyError);
              } else {
                setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: item.error || '下载失败' } }));
              }
            } else {
              // 尝试从多个可能的字段获取文件路径
              const filePath = item.entry || item.filepath || item.file_path || item.output || item.filename || '';
              // 构建下载链接
              let fileHref: string | null = null;
              if (filePath) {
                const fileName = String(filePath).split('/').pop() || String(filePath).split('\\').pop() || '';
                fileHref = VITE_METUBE_PUBLIC_URL
                  ? `${VITE_METUBE_PUBLIC_URL}/download/${encodeURIComponent(fileName)}`
                  : null;
              }
              console.log('[YouTubeMonitor] 下载完成:', { fileHref, filePath, item });
              setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'completed', progress: 100, fileHref } }));
              setInfoMsg(fileHref ? '下载完成！点击「保存文件」按钮下载文件到本地' : '下载完成！文件保存在 MeTube 服务器，请到 MeTube 后台查看');
            }
            return;
          } else if (['error', 'failed', 'error_ffmpeg', 'error_ytdl'].includes(status) || item.error || errorMsg) {
            // 区分 403 等服务端错误
            if (isCookiesExpired || errorMsg.includes('403') || errorMsg.includes('forbidden') || errorMsg.includes('http error') || errorMsg.includes('geo') || errorMsg.includes('region') || errorMsg.includes('copyright')) {
              const friendlyError = `下载失败 (403)：YouTube cookies 已失效。请在 MeTube 后台上传新的 YouTube cookies。`;
              console.error('[YouTubeMonitor] Cookies 失效或地区限制:', errorMsg);
              setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: friendlyError } }));
              setErrorMsg(friendlyError);
            } else if (errorMsg.includes('not found') || errorMsg.includes('404')) {
              setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: '视频未找到，可能已被删除' } }));
            } else if (isDownloadFailed) {
              const friendlyError = `下载失败：${item.error || '无法下载此视频，请检查视频是否需要登录或受版权保护'}`;
              console.error('[YouTubeMonitor] 下载错误:', errorMsg);
              setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: friendlyError } }));
            } else {
              console.error('[YouTubeMonitor] 下载错误:', item.error || errorMsg);
              setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: item.error || '下载失败' } }));
            }
            return;
          } else {
            setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'downloading', progress: Math.min(95, Math.round((attempts / maxAttempts) * 100)) } }));
          }
        } else {
          console.log('[YouTubeMonitor] 未找到匹配的下载项，vid:', vid, '当前 URL:', url);
          // 打印所有历史记录帮助调试
          if (hist.length > 0) {
            console.log('[YouTubeMonitor] 历史记录示例:', hist.slice(0, 3).map(h => ({ url: h.url, status: h.status, title: h.title })));
          } else {
            console.log('[YouTubeMonitor] 历史记录为空，打印原始数据用于调试');
            try {
              const res2 = await fetch(`${window.location.origin}/api/metube/history`);
              const text2 = await res2.text();
              console.log('[YouTubeMonitor] 原始 history 响应:', text2.substring(0, 1000));
            } catch (e) {
              console.log('[YouTubeMonitor] 获取原始响应失败:', e);
            }
          }
          setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'queued', progress: Math.min(20, attempts * 2) } }));
        }
        if (attempts < maxAttempts) {
          setTimeout(poll, 3000);
        } else {
          const timeoutMsg = hist.length === 0 
            ? '下载队列为空，可能是 cookies 失效导致。建议：到 MeTube 后台更新 YouTube cookies 后重试。'
            : '下载超时未完成，请到 MeTube 后台检查状态';
          console.warn('[YouTubeMonitor]', timeoutMsg);
          setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: timeoutMsg } }));
          setErrorMsg(timeoutMsg);
        }
      } catch (e) {
        console.error('[YouTubeMonitor] 轮询异常:', e);
        if (attempts < maxAttempts) {
          setTimeout(poll, 3000);
        } else {
          setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: '轮询出错，请刷新页面重试' } }));
        }
      }
    };
    poll();
  }

  async function queueMetubeDownload(url: string, kind: MetubeDownloadKind) {
    const dlKey = getDownloadKey(url, kind);
    console.log('[YouTubeMonitor] 开始下载:', url, kind);
    setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'downloading', progress: 5 } }));
    setInfoMsg(null);
    setErrorMsg(null);
    try {
      const payload = buildMetubePayload(url, kind);
      console.log('[YouTubeMonitor] 提交 payload:', payload);
      const result = await metubePostAdd(payload);
      console.log('[YouTubeMonitor] MeTube 响应:', result);
      setInfoMsg(`已提交「${kind}」到 MeTube 队列`);
      void pollDownloadStatus(url, kind);
    } catch (e: unknown) {
      console.error('[YouTubeMonitor] 下载失败:', e);
      const errMsg = e instanceof Error ? e.message : 'MeTube 提交失败';
      setErrorMsg(errMsg);
      setActiveDownloads(prev => ({ ...prev, [dlKey]: { status: 'error', error: errMsg } }));
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
    }
  }

  async function parseVideo() {
    const url = videoUrl.trim();
    if (!url) {
      setErrorMsg('请先输入 YouTube 视频链接');
      console.warn('[YouTubeMonitor] 解析失败: 链接为空');
      return;
    }
    const patterns = [/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/, /^([a-zA-Z0-9_-]{11})$/];
    let videoId = '';
    for (const p of patterns) { const m = url.match(p); if (m) { videoId = m[1]; break; } }
    if (!videoId) {
      setErrorMsg('无效的 YouTube 链接，请检查格式');
      console.warn('[YouTubeMonitor] 解析失败: 无效链接', url);
      return;
    }
    console.log('[YouTubeMonitor] 开始解析视频:', videoId);
    setIsParsing(true);
    setErrorMsg(null);
    setInfoMsg(null);
    setParsedVideo(null);
    setDescExpanded(false);
    try {
      const detail = await ytGetVideoDetail(videoId, activeApiKey || undefined);
      console.log('[YouTubeMonitor] 解析成功:', detail.title);
      setParsedVideo(detail);
      setInfoMsg('解析成功，下方已显示视频信息');
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      console.error('[YouTubeMonitor] 解析失败:', raw);
      const hint =
        !activeApiKey && /401|403|Unauthorized|Authorization/i.test(raw)
          ? '（请在设置中填写 YouTube API Key）'
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

  /** 从 URL 或纯 ID 提取视频 ID */
  function extractVideoIdFromUrl(input: string): string {
    const trimmed = input.trim();
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const p of patterns) { const m = trimmed.match(p); if (m) return m[1]; }
    return '';
  }

  /** 加载视频评论 */
  async function loadComments(videoId: string) {
    if (!videoId) return;
    setIsLoadingComments(true);
    setErrorMsg(null);
    setInfoMsg(null);
    setCommentResult(null);
    setCommentPage(0);
    setPainPointsResult(null);
    try {
      const result = await ytGetVideoComments(videoId, activeApiKey || undefined, 50);
      setCommentResult(result);
      if (result.comments.length === 0) {
        setInfoMsg('该视频暂无评论或评论已关闭');
      } else {
        setInfoMsg(`评论加载成功，共 ${result.total} 条`);
      }
    } catch (e) {
      setErrorMsg('评论加载失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setIsLoadingComments(false);
    }
  }

  /** 提取用户痛点 */
  async function extractPainPoints() {
    if (!commentResult || commentResult.comments.length === 0) {
      setErrorMsg('请先加载评论');
      return;
    }

    setIsAnalyzingPainPoints(true);
    setPainPointsResult(null);
    setErrorMsg(null);

    const commentsText = commentResult.comments
      .map((c, i) => `${i + 1}. ${c.text}`)
      .join('\n');

    const systemInstruction = `你是一个用户评论分析助手。

【你的任务】
从评论中提炼出用户的核心痛点需求。

【清洗规则】
过滤掉以下无效评论：
- 广告、推广信息
- 刷屏内容（"沙发"、"前排"、"哈哈"、"666"等无意义内容）
- 纯表情、符号
- 与视频内容无关的评论

【输出要求】
- 只输出 3-5 条用户痛点，每条一行
- 格式：1. 痛点内容
- 不要有任何解释、前言、总结
- 不要说"根据评论分析"之类的话
- 直接输出纯痛点列表`;

    const prompt = `评论内容：\n${commentsText}\n\n请直接输出用户痛点列表。`;

    let rawResult = '';
    try {
      await streamContentGeneration(
        prompt,
        systemInstruction,
        (chunk) => {
          rawResult += chunk;
          // 实时清理：去除常见的前缀文字
          let cleaned = rawResult
            .replace(/^(以下是|根据评论|用户痛点[:：]?|分析结果[:：]?|用户反馈[:：]?)\s*/gim, '')
            .replace(/^[-—–_=*~`#]+$/gm, '')
            .trim();
          setPainPointsResult(cleaned);
        },
        'gpt-5.4-mini',
        { temperature: 0.3, maxTokens: 1024 }
      );
    } catch (e) {
      setErrorMsg('痛点分析失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setIsAnalyzingPainPoints(false);
    }
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
    const isCompleted = dlState?.status === 'completed';
    const canSaveFile = isCompleted && dlState?.fileHref;

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
            <button onClick={() => { if (!isDownloading && !isCompleted) void queueMetubeDownload(video.url, metubeKind); }} disabled={isDownloading || isCompleted} className={`px-2 py-1 text-xs rounded-md transition-colors flex items-center gap-1 disabled:opacity-50 ${canSaveFile ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20' : isDownloading ? 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20' : 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'}`}>
              {isDownloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              {isDownloading ? `${dlState?.progress || 0}%` : canSaveFile ? '下载' : '下载'}
            </button>
            {canSaveFile && (
              <a href={dlState.fileHref} target="_blank" rel="noopener noreferrer" className="px-2 py-1 text-xs bg-emerald-500/10 text-emerald-400 rounded-md hover:bg-emerald-500/20 transition-colors flex items-center gap-1">
                <Download className="w-3 h-3" />保存文件
              </a>
            )}
            <button onClick={() => void addToCompare(video)} className="px-2 py-1 text-xs bg-slate-700/50 text-slate-300 rounded-md hover:bg-slate-700 transition-colors flex items-center gap-1">
              <GitCompare className="w-3 h-3" />对比
            </button>
            <a href={video.url} target="_blank" rel="noopener noreferrer" className="px-2 py-1 text-xs bg-slate-700/50 text-slate-300 rounded-md hover:bg-slate-700 transition-colors flex items-center gap-1">
              <ExternalLink className="w-3 h-3" />观看
            </a>
            {isVideoFavorited(video.videoId) ? (
              <button onClick={() => toggleFavorite(video)} className="px-2 py-1 text-xs bg-rose-500/20 text-rose-400 rounded-md hover:bg-rose-500/30 transition-colors flex items-center gap-1">
                <Heart className="w-3 h-3 fill-current" />已收藏
              </button>
            ) : (
              <button onClick={() => { setFavoritePickerVideo(video); setShowFavoritePicker(true); }} className="px-2 py-1 text-xs bg-slate-700/50 text-slate-300 rounded-md hover:bg-slate-600 transition-colors flex items-center gap-1">
                <Heart className="w-3 h-3" />收藏
              </button>
            )}
            <button onClick={() => { setCommentVideoUrl(video.url); setActiveTab('comments'); setTimeout(() => { const vid = extractVideoIdFromUrl(video.url); if (vid) void loadComments(vid); }, 100); }} className="px-2 py-1 text-xs bg-slate-700/50 text-slate-300 rounded-md hover:bg-slate-600 transition-colors flex items-center gap-1">
              <MessageCircle className="w-3 h-3" />评论
            </button>
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

  // ── 渲染：词云（精美云图效果） ──────────────────────────────────
  const renderWordCloud = (entries: WordCloudEntry[], title = '热门关键词') => {
    if (!entries.length) return null;

    // 确定性伪随机函数（用index作为seed，保证位置固定）
    const seededRandom = (seed: number, min: number, max: number) => {
      const x = Math.sin(seed * 9999) * 10000;
      return min + (x - Math.floor(x)) * (max - min);
    };

    // 按weight降序排列，保证最热的在前
    const sortedEntries = [...entries].sort((a, b) => b.weight - a.weight);
    const total = sortedEntries.length;

    // 颜色梯度：纯色块区分明显
    const getColor = (rank: number) => {
      const ratio = rank / Math.max(total - 1, 1);
      if (ratio < 0.2) return { bg: 'bg-rose-600', text: 'text-white', desc: '最热' };
      if (ratio < 0.4) return { bg: 'bg-orange-500', text: 'text-white', desc: '热门' };
      if (ratio < 0.6) return { bg: 'bg-purple-500', text: 'text-white', desc: '中等' };
      if (ratio < 0.8) return { bg: 'bg-sky-500', text: 'text-white', desc: '普通' };
      return { bg: 'bg-slate-500', text: 'text-white', desc: '冷门' };
    };

    return (
      <div className="rounded-xl border border-slate-700/50 bg-gradient-to-br from-slate-800/80 to-slate-900/80 p-5 relative overflow-hidden">
        {/* 装饰背景 */}
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-0 right-0 w-40 h-40 bg-gradient-to-br from-rose-500/20 to-transparent rounded-full blur-3xl" />
          <div className="absolute bottom-0 left-0 w-32 h-32 bg-gradient-to-tr from-cyan-500/20 to-transparent rounded-full blur-3xl" />
        </div>

        {/* 标题 */}
        <div className="flex items-center gap-2 mb-4 relative z-10">
          <TrendingUp className="h-4 w-4 text-rose-400" />
          <span className="text-sm font-semibold text-slate-200">{title}</span>
          <span className="text-xs text-slate-500 ml-auto">{sortedEntries.length} 个关键词</span>
        </div>

        {/* 词云主体 - 按热度排序，最热的字体最大 */}
        <div className="relative min-h-[140px] flex flex-wrap content-start items-center justify-center gap-x-4 gap-y-3">
          {sortedEntries.map((e, i) => {
            // 字号范围: 14px(冷门) ~ 32px(最热)
            const rankRatio = i / Math.max(total - 1, 1);
            const fontSize = Math.round(32 - rankRatio * 18);
            const offsetX = seededRandom(i * 3, -12, 12);
            const offsetY = seededRandom(i * 7, -8, 8);
            const color = getColor(i);
            const isTop = i < 3;

            return (
              <span
                key={`${e.word}-${i}`}
                className={`inline-block ${color.bg} ${color.text} rounded px-3 py-1 cursor-pointer transition-all duration-300 hover:scale-110 hover:shadow-lg hover:z-20 ${isTop ? 'font-extrabold' : 'font-bold'}`}
                style={{
                  fontSize: `${fontSize}px`,
                  transform: `translate(${offsetX}px, ${offsetY}px)`,
                  boxShadow: isTop ? '0 4px 20px rgba(244, 63, 94, 0.5)' : '0 2px 8px rgba(0, 0, 0, 0.3)',
                }}
                title={`排名: #${i + 1} | 热度: ${e.weight} | 出现: ${e.count}次 | 播放: ${formatNumber(e.views || 0)}`}
              >
                {e.word}
              </span>
            );
          })}
        </div>

        {/* 底部热度说明 */}
        <div className="flex items-center gap-4 mt-4 pt-3 border-t border-slate-700/30 relative z-10">
          <span className="text-[10px] text-slate-500">字号越大=越热门</span>
          <div className="flex items-center gap-2 ml-auto">
            <span className="w-4 h-4 rounded bg-rose-600"></span>
            <span className="text-[10px] text-slate-400">最热</span>
            <span className="w-4 h-4 rounded bg-orange-500"></span>
            <span className="text-[10px] text-slate-400">热门</span>
            <span className="w-4 h-4 rounded bg-purple-500"></span>
            <span className="text-[10px] text-slate-400">中等</span>
            <span className="w-4 h-4 rounded bg-sky-500"></span>
            <span className="text-[10px] text-slate-400">普通</span>
            <span className="w-4 h-4 rounded bg-slate-500"></span>
            <span className="text-[10px] text-slate-400">冷门</span>
          </div>
        </div>
      </div>
    );
  };

  // ── 渲染：收藏夹区域 ──────────────────────────────────────────
  const renderFavoritesSection = (videos: FavoriteVideo[]) => {
    return (
      <div className="bg-slate-800/30 rounded-xl p-4 border border-amber-500/30">
        <div className="flex items-center gap-2 mb-3">
          <Heart className="w-4 h-4 text-amber-400 fill-amber-400" />
          <span className="text-sm font-medium text-amber-300">收藏视频 <span className="text-xs text-slate-500">({videos.length})</span></span>
        </div>
        <div className="space-y-2">
          {videos.map(fav => (
            <div key={fav.videoId} className="flex gap-3 p-2 rounded-lg bg-slate-900/50 hover:bg-slate-800/50 transition-colors">
              <a href={fav.url} target="_blank" rel="noopener noreferrer" className="flex-shrink-0">
                <img src={fav.thumbnail} alt={fav.title} className="w-24 h-16 object-cover rounded" />
              </a>
              <div className="flex-1 min-w-0">
                <a href={fav.url} target="_blank" rel="noopener noreferrer" className="text-sm text-slate-200 hover:text-emerald-400 line-clamp-2">
                  {fav.title}
                </a>
                <div className="flex items-center gap-2 mt-1 text-xs text-slate-500">
                  <span>{fav.channelTitle}</span>
                  <span>·</span>
                  <span>{formatNumber(fav.viewCount)}播放</span>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <a href={fav.url} target="_blank" rel="noopener noreferrer" className="p-1.5 rounded bg-slate-700/50 text-slate-400 hover:text-emerald-400">
                  <ExternalLink className="w-3 h-3" />
                </a>
                <button onClick={() => removeFavorite(fav.videoId)} className="p-1.5 rounded bg-slate-700/50 text-slate-400 hover:text-rose-400">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── 渲染：收藏选择弹窗 ────────────────────────────────────────
  const renderFavoritePicker = () => {
    if (!showFavoritePicker || !favoritePickerVideo) return null;

    return (
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowFavoritePicker(false)}>
        <div className="bg-slate-800 rounded-xl p-4 w-80 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-slate-200">收藏到...</h3>
            <button onClick={() => setShowFavoritePicker(false)} className="text-slate-400 hover:text-slate-200">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 视频预览 */}
          <div className="flex gap-2 p-2 bg-slate-900/50 rounded-lg mb-4">
            <img src={favoritePickerVideo.thumbnail || ''} alt="" className="w-20 h-14 object-cover rounded" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-200 line-clamp-2">{favoritePickerVideo.title}</p>
              <p className="text-[10px] text-slate-500 mt-1">{favoritePickerVideo.channelTitle}</p>
            </div>
          </div>

          {/* 已有分组 */}
          <div className="space-y-1 mb-3">
            <p className="text-xs text-slate-500 mb-2">选择分组：</p>
            {favoriteGroups.map(group => (
              <button
                key={group.id}
                onClick={() => {
                  toggleFavorite(favoritePickerVideo, group.id);
                  setShowFavoritePicker(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-700/50 hover:bg-slate-700 transition-colors text-left"
              >
                <span className="w-3 h-3 rounded" style={{ backgroundColor: group.color }}></span>
                <span className="text-sm text-slate-200">{group.name}</span>
                <span className="text-xs text-slate-500 ml-auto">{group.videoIds.length}</span>
              </button>
            ))}
          </div>

          {/* 自定义分组 */}
          <div className="border-t border-slate-700 pt-3">
            <p className="text-xs text-slate-500 mb-2">新建分组：</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={customGroupName}
                onChange={e => setCustomGroupName(e.target.value)}
                placeholder="输入分组名称"
                className="flex-1 bg-slate-700/50 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-violet-500"
                onKeyDown={e => {
                  if (e.key === 'Enter' && customGroupName.trim()) {
                    addFavoriteGroup(customGroupName.trim());
                    setCustomGroupName('');
                  }
                }}
              />
              <button
                onClick={() => {
                  if (customGroupName.trim()) {
                    addFavoriteGroup(customGroupName.trim());
                    setCustomGroupName('');
                  }
                }}
                className="px-3 py-1.5 bg-violet-500/20 text-violet-400 rounded hover:bg-violet-500/30 text-sm"
              >
                新建
              </button>
            </div>
          </div>
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
            <div key={c.channel.channelId} className="flex items-center gap-3 p-2 rounded-lg bg-slate-900/30 hover:bg-slate-800/50 transition-colors group">
              <span className="text-xs text-slate-600 w-5 text-right flex-shrink-0">#{i + 1}</span>
              {/* 频道头像 - 可点击查看视频 */}
              <button
                onClick={() => {
                  setSelectedChannelId(c.channel.channelId);
                  void loadChannelVideos(c.channel.channelId);
                  setActiveTab('videos');
                }}
                className="relative flex-shrink-0"
              >
                <img src={c.channel.thumbnail || ''} alt={c.channel.title} className="w-10 h-10 rounded-full" />
                <div className="absolute inset-0 bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <Play className="w-4 h-4 text-white" />
                </div>
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {/* 频道名称可点击 */}
                  <button
                    onClick={() => {
                      setSelectedChannelId(c.channel.channelId);
                      void loadChannelVideos(c.channel.channelId);
                      setActiveTab('videos');
                    }}
                    className="text-sm text-slate-200 hover:text-blue-400 transition-colors text-left truncate"
                  >
                    {c.channel.title}
                  </button>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-slate-500 mt-0.5">
                  <span>{formatNumber(c.channel.subscriberCount)} 订阅</span>
                  <span>·</span>
                  <span className={c.recentTrendScore > 7 ? 'text-emerald-400' : c.recentTrendScore > 4 ? 'text-amber-400' : 'text-slate-500'}>
                    趋势分 {c.recentTrendScore.toFixed(1)}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <div className="flex flex-wrap gap-1">
                    {c.overlapKeywords.slice(0, 3).map(kw => (
                      <span key={kw} className="px-1 py-0.5 bg-blue-500/10 text-blue-400 rounded text-[10px]">{kw}</span>
                    ))}
                  </div>
                  {/* 添加到分组按钮 */}
                  {channelGroups.length > 0 && (
                    <select
                      className="text-[10px] bg-slate-700/50 text-slate-400 rounded px-1 py-0.5 cursor-pointer hover:bg-slate-700 ml-auto"
                      value=""
                      onChange={async (e) => {
                        if (e.target.value) {
                          await addChannelToGroup(e.target.value, c.channel.channelId, c.channel);
                          setErrorMsg('已添加到分组');
                        }
                      }}
                    >
                      <option value="">+ 添加到分组</option>
                      {channelGroups.map(g => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>
                  )}
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
            isUsingOfficial ? 'bg-red-500/10 text-red-400 border border-red-500/30' : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
          }`}>
            {isUsingOfficial ? <Youtube className="w-3 h-3" /> : <Rss className="w-3 h-3" />}
            {isUsingOfficial ? '官方 API' : '未配置 Key'}
          </div>
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

                {channelGroups.map(group => {
                  const isLeftExpanded = leftExpandedGroupId === group.id;
                  const channels = group.channelIds
                    .map(id => allChannels.find(c => c.channelId === id))
                    .filter(Boolean) as ChannelMeta[];
                  return (
                    <div key={group.id}>
                      <div
                        onClick={() => { 
                          setLeftExpandedGroupId(isLeftExpanded ? null : group.id);
                          setSelectedGroupId(group.id);
                          if (!isLeftExpanded) {
                            void buildWordCloudForGroup(group.id);
                            void refreshSelectedGroup();
                          }
                        }}
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
                              <ChevronRight className={`w-3 h-3 text-slate-500 transition-transform ${isLeftExpanded ? 'rotate-90' : ''}`} />
                              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button onClick={(e) => { e.stopPropagation(); setEditingGroupId(group.id); setEditingGroupName(group.name); }} className="p-0.5 rounded text-slate-500 hover:text-slate-300" title="重命名"><Edit2 className="w-3 h-3" /></button>
                                {group.id !== DEFAULT_GROUP_ID && (
                                  <button onClick={(e) => { e.stopPropagation(); void deleteGroup(group.id); }} className="p-0.5 rounded text-slate-500 hover:text-red-400" title="删除"><Trash2 className="w-3 h-3" /></button>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                      
                      {/* 展开的频道列表 */}
                      {isLeftExpanded && (
                        <div className="mt-1 ml-4 space-y-1 border-l border-slate-700/50 pl-3">
                          {channels.length === 0 ? (
                            <p className="text-xs text-slate-600 py-1">该分组暂无频道</p>
                          ) : (
                            channels.map(ch => {
                              const videos = groupVideos.get(`${group.id}_${ch.channelId}`) || [];
                              const isLoading = loadingChannels.has(ch.channelId);
                              const isChannelSelected = selectedChannelId === ch.channelId;
                              const newCount = newVideoCounts.get(ch.channelId) || 0;
                              return (
                                <div
                                  key={ch.channelId}
                                  className={`p-2 rounded-lg cursor-pointer transition-colors ${isChannelSelected ? 'bg-cyan-500/10 border border-cyan-500/30' : 'bg-slate-800/20 border border-transparent hover:bg-slate-800/40 hover:border-slate-700/50'}`}
                                >
                                  <div className="flex items-center gap-2">
                                    <img
                                      src={ch.thumbnail || ''}
                                      alt=""
                                      className="w-6 h-6 rounded-full object-cover flex-shrink-0"
                                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                      onClick={() => {
                                        setSelectedChannelId(ch.channelId);
                                        setExpandedGroupId(group.id);
                                        void fetchGroupChannelVideos(group.id, ch.channelId);
                                      }}
                                    />
                                    <div className="flex-1 min-w-0" onClick={() => {
                                      setSelectedChannelId(ch.channelId);
                                      setExpandedGroupId(group.id);
                                      void fetchGroupChannelVideos(group.id, ch.channelId);
                                    }}>
                                      <p className="text-xs text-slate-300 truncate">{ch.title || ch.channelId}</p>
                                      <p className="text-[10px] text-slate-500">{videos.length} 条视频</p>
                                    </div>
                                    {newCount > 0 && (
                                      <span className="px-1.5 py-0.5 bg-red-500/20 text-red-400 text-[10px] font-bold rounded-full animate-pulse">
                                        {newCount}新
                                      </span>
                                    )}
                                    {isLoading && <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />}
                                    {!isLoading && videos.length === 0 && (
                                      <span className="text-[10px] text-slate-600">无数据</span>
                                    )}
                                    {/* 移动分组按钮 */}
                                    <select
                                      onClick={e => e.stopPropagation()}
                                      onChange={async e => {
                                        const newGroupId = e.target.value;
                                        if (newGroupId && newGroupId !== group.id) {
                                          await removeChannelFromGroup(group.id, ch.channelId);
                                          await addChannelToGroup(newGroupId, ch.channelId, ch);
                                        }
                                        e.target.value = '';
                                      }}
                                      className="px-1 py-0.5 text-[10px] rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors cursor-pointer"
                                    >
                                      <option value="">移动</option>
                                      {channelGroups.filter(g => g.id !== group.id).map(g => (
                                        <option key={g.id} value={g.id}>{g.name}</option>
                                      ))}
                                    </select>
                                    {/* 删除按钮 */}
                                    <button
                                      onClick={e => {
                                        e.stopPropagation();
                                        void removeChannelFromGroup(group.id, ch.channelId);
                                      }}
                                      className="p-1 text-slate-600 hover:text-red-400 transition-colors"
                                      title="从分组移除"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  </div>
                                  
                                  {/* 频道视频预览 */}
                                  {isChannelSelected && videos.length > 0 && (
                                    <div className="mt-2 space-y-1">
                                      {videos.slice(0, 5).map(v => (
                                        <div
                                          key={v.videoId}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setAnalysisVideo(v);
                                          }}
                                          className="flex items-center gap-2 p-1.5 bg-slate-900/50 hover:bg-slate-800/60 rounded cursor-pointer transition-colors"
                                        >
                                          <img src={v.thumbnail || ''} alt="" className="w-12 h-8 rounded object-cover flex-shrink-0" />
                                          <div className="flex-1 min-w-0">
                                            <p className="text-[10px] text-slate-200 line-clamp-1">{v.title}</p>
                                            <p className="text-[10px] text-slate-500">
                                              {v.viewCount ? formatNumber(v.viewCount) : '0'} 播放
                                              {v.publishedAt ? ` · ${formatAgo(v.publishedAt)}` : ''}
                                            </p>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
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
                    const inAllChannels = allChannels.some(c => c.channelId === ch.channelId);
                    return (
                      <div key={ch.channelId} className="flex items-center gap-2 p-1.5 rounded-lg bg-slate-800/40 border border-slate-700/40 hover:border-slate-600 transition-colors">
                        <img src={ch.thumbnail || ''} alt={ch.title} className="w-7 h-7 rounded-full flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-slate-200 truncate">{ch.title}</div>
                          <div className="text-[10px] text-slate-600">{formatNumber(ch.subscriberCount)} 订阅</div>
                        </div>
                        <select
                          onChange={e => {
                            if (e.target.value) {
                              void addChannelToGroup(e.target.value, ch.channelId, ch);
                            }
                            e.target.value = '';
                          }}
                          disabled={inAllChannels}
                          className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <option value="">{inAllChannels ? '已添加' : '添加到'}</option>
                          {channelGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                        </select>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 视频解析 */}
          <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Download className="w-4 h-4 text-blue-400" />
              <h2 className="text-sm font-medium text-slate-200">视频解析</h2>
            </div>
            {!activeApiKey && (
              <p className="mb-2 text-xs text-amber-400/95">
                未填写 API Key 时无法获取视频数据
              </p>
            )}
            <div className="flex gap-2 mb-2">
              <select
                value={metubeKind}
                onChange={e => setMetubeKind(e.target.value as MetubeDownloadKind)}
                className="bg-slate-800/50 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500/50"
              >
                <option value="video">视频下载</option>
                <option value="audio">音频下载</option>
                <option value="captions">字幕下载</option>
                <option value="thumbnail">封面下载</option>
              </select>
              <input value={videoUrl} onChange={e => setVideoUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && void parseVideo()} placeholder="粘贴视频链接..." className="flex-1 bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/50" />
              <button onClick={() => { if (!videoUrl.trim()) { setErrorMsg('请先输入视频链接'); return; } void parseVideo(); }} disabled={isParsing} className="px-2 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-1">
                {isParsing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              </button>
            </div>
            {parsedVideo && (
              <div className="mt-2 p-2 rounded-lg bg-slate-800/50 border border-slate-700/50">
                <div className="flex gap-2">
                  {parsedVideo.thumbnail && <img src={parsedVideo.thumbnail} alt="" className="w-16 h-10 rounded object-cover flex-shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-200 line-clamp-2">{parsedVideo.title}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <button onClick={() => void analyzeVideo(parsedVideo)} className="px-1.5 py-0.5 text-[10px] bg-emerald-500/20 text-emerald-400 rounded hover:bg-emerald-500/30">
                        分析
                      </button>
                      <button onClick={() => void addToCompare(parsedVideo)} className="px-1.5 py-0.5 text-[10px] bg-slate-700/50 text-slate-300 rounded hover:bg-slate-700">
                        对比
                      </button>
                      <button
                        onClick={() => {
                          setVideoUrl(parsedVideo.url || `https://youtube.com/watch?v=${parsedVideo.videoId}`);
                          void queueMetubeDownload(parsedVideo.url || `https://youtube.com/watch?v=${parsedVideo.videoId}`, metubeKind);
                        }}
                        className="px-1.5 py-0.5 text-[10px] bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30 flex items-center gap-1"
                      >
                        <Download className="w-3 h-3" />下载
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 关键词搜索 */}
          <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Search className="w-4 h-4 text-cyan-400" />
              <h2 className="text-sm font-medium text-slate-200">搜索</h2>
            </div>
            {/* 搜索类型切换 */}
            <div className="flex gap-1 mb-2">
              <button
                onClick={() => setKeywordSearchType('keyword')}
                className={`px-2 py-0.5 text-[10px] rounded ${keywordSearchType === 'keyword' ? 'bg-cyan-500/30 text-cyan-400' : 'text-slate-500'}`}
              >
                关键词
              </button>
              <button
                onClick={() => setKeywordSearchType('channel')}
                className={`px-2 py-0.5 text-[10px] rounded ${keywordSearchType === 'channel' ? 'bg-cyan-500/30 text-cyan-400' : 'text-slate-500'}`}
              >
                频道
              </button>
            </div>
            <div className="flex gap-1 mb-2">
              <select value={keywordSearchSort} onChange={e => setKeywordSearchSort(e.target.value as any)} className="flex-1 bg-slate-800/50 border border-slate-700 rounded px-1 py-1 text-[10px] text-slate-300">
                <option value="relevance">相关度</option>
                <option value="date">最新</option>
                <option value="viewCount">最热</option>
              </select>
              <select value={keywordSearchDate} onChange={e => setKeywordSearchDate(e.target.value)} className="flex-1 bg-slate-800/50 border border-slate-700 rounded px-1 py-1 text-[10px] text-slate-300">
                <option value="">不限</option>
                <option value="1">今天</option>
                <option value="7">7天内</option>
                <option value="30">30天内</option>
                <option value="365">1年内</option>
              </select>
            </div>
            <div className="flex gap-2">
              <input
                value={keywordSearchQuery}
                onChange={e => setKeywordSearchQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void searchKeyword(); }}
                placeholder={keywordSearchType === 'channel' ? '搜索频道名称...' : '搜索关键词...'}
                className="flex-1 bg-slate-800/50 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
              />
              <button onClick={() => void searchKeyword()} disabled={isKeywordSearching || !keywordSearchQuery.trim()} className="px-2 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/50 text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-1">
                {isKeywordSearching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
              </button>
            </div>

            {/* 搜索指数显示 */}
            {(isLoadingSearchIndex || keywordSearchIndex) && (
              <div className="mt-2 p-2 rounded-lg bg-slate-800/40 border border-slate-700/40">
                {isLoadingSearchIndex ? (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Loader2 className="w-3 h-3 animate-spin" />正在分析搜索指数...
                  </div>
                ) : keywordSearchIndex && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <TrendingUp className="w-3 h-3 text-cyan-400" />
                      <span className="text-xs text-cyan-400 font-medium">「{keywordSearchIndex.keyword}」搜索指数</span>
                      <span className="text-[10px] text-slate-500">约 {formatNumber(keywordSearchIndex.estimatedViews)} 总播放</span>
                    </div>
                    {/* 相关关键词热度 */}
                    {keywordSearchIndex.relatedKeywords.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {keywordSearchIndex.relatedKeywords.map((item, idx) => (
                          <div
                            key={idx}
                            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] cursor-pointer hover:opacity-80 ${
                              item.热度 === '🔥爆' ? 'bg-red-500/20 text-red-400' :
                              item.热度 === '热' ? 'bg-orange-500/20 text-orange-400' :
                              item.热度 === '中' ? 'bg-yellow-500/20 text-yellow-400' :
                              'bg-slate-700/50 text-slate-400'
                            }`}
                            onClick={() => { setKeywordSearchQuery(item.word); void searchKeyword(); }}
                          >
                            <span>{item.word}</span>
                            <span className="font-bold">{item.searchIndex}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {keywordSearchResults.length > 0 && (
              <div className="mt-2 space-y-1 max-h-64 overflow-y-auto">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-slate-500">{keywordSearchResults.length} 条结果</span>
                  <button onClick={() => { setKeywordSearchResults([]); setKeywordSearchQuery(''); setKeywordSearchIndex(null); }} className="text-[10px] text-slate-600 hover:text-slate-400">清除</button>
                </div>
                {keywordSearchResults.map(r => (
                  <div key={r.videoId} className="flex items-center gap-2 p-1.5 rounded bg-slate-800/30 hover:bg-slate-800/50 cursor-pointer" onClick={() => { setVideoUrl(r.url || `https://youtube.com/watch?v=${r.videoId}`); void parseVideo(); }}>
                    {r.thumbnail && <img src={r.thumbnail} alt="" className="w-12 h-7 rounded object-cover flex-shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] text-slate-200 line-clamp-2">{r.title}</p>
                      <div className="flex items-center gap-2 text-[9px] text-slate-500 mt-0.5">
                        <span>{r.channelTitle}</span>
                        {r.viewCount && <span>{formatNumber(r.viewCount)} 播放</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
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

          {/* ── 收藏夹 ── */}
          <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Heart className="w-4 h-4 text-violet-400" />
              <h2 className="text-sm font-medium text-slate-200">我的收藏</h2>
              <span className="text-xs text-slate-500">({favorites.length})</span>
            </div>

            {/* 收藏分组标签 */}
            <div className="flex flex-wrap gap-1 mb-3">
              {favoriteGroups.map(g => (
                <button
                  key={g.id}
                  onClick={() => setSelectedFavoriteGroupId(g.id)}
                  className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                    selectedFavoriteGroupId === g.id
                      ? 'bg-violet-500/20 text-violet-300 border border-violet-500/40'
                      : 'bg-slate-800/50 text-slate-400 border border-slate-700/50 hover:bg-slate-800 hover:text-slate-300'
                  }`}
                >
                  {g.name} ({g.videoIds.length})
                </button>
              ))}
              <button
                onClick={() => {
                  const name = prompt('输入新分组名称：');
                  if (name) addFavoriteGroup(name);
                }}
                className="px-2 py-0.5 rounded text-[10px] bg-slate-800/50 text-slate-400 border border-slate-700/50 hover:bg-slate-800 hover:text-violet-400"
              >
                <Plus className="w-3 h-3 inline" />
              </button>
            </div>

            {/* 收藏视频列表 - 只显示选中分组的内容 */}
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {(() => {
                const groupVideos = favorites.filter(f => f.groupId === selectedFavoriteGroupId);
                if (groupVideos.length === 0) {
                  return (
                    <div className="text-center py-4 text-slate-500 text-xs">
                      该分组暂无收藏<br />
                      <span className="text-slate-600">点击视频的收藏按钮添加</span>
                    </div>
                  );
                }
                return groupVideos.map(fav => (
                  <div key={fav.videoId} className="flex gap-2 p-1.5 rounded-lg bg-slate-800/30 hover:bg-slate-800/50 transition-colors group">
                    <a href={fav.url} target="_blank" rel="noopener noreferrer" className="flex-shrink-0">
                      <img src={fav.thumbnail} alt="" className="w-16 h-10 object-cover rounded" />
                    </a>
                    <div className="flex-1 min-w-0">
                      <a href={fav.url} target="_blank" rel="noopener noreferrer" className="text-xs text-slate-200 hover:text-emerald-400 line-clamp-2 block">
                        {fav.title}
                      </a>
                      <div className="flex items-center gap-1 mt-0.5">
                        <select
                          value={fav.groupId}
                          onChange={e => moveFavoriteToGroup(fav.videoId, e.target.value)}
                          className="text-[9px] bg-slate-700/50 text-slate-400 rounded px-1 py-0.5 cursor-pointer"
                        >
                          {favoriteGroups.map(g => (
                            <option key={g.id} value={g.id}>{g.name}</option>
                          ))}
                        </select>
                        <span className="text-[9px] text-slate-600">{formatAgo(fav.favoritedAt)}</span>
                      </div>
                    </div>
                    <button onClick={() => removeFavorite(fav.videoId)} className="p-1 rounded text-slate-500 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ));
              })()}
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
              { id: 'comments', label: '评论提取', icon: MessageCircle },
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
              {/* 全部频道汇总视图（当没有展开分组时显示） */}
              {!expandedGroupId && (
                <>
                  {channelGroups.length === 0 ? (
                    <div className="text-center py-20 text-slate-500">
                      <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
                      <p>暂无监控分组</p>
                      <p className="text-xs mt-1">在左侧搜索并添加频道到分组</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {channelGroups.map(group => {
                        const channels = group.channelIds
                          .map(id => allChannels.find(c => c.channelId === id))
                          .filter(Boolean) as ChannelMeta[];
                        const groupVideoCount = channels.reduce((sum, ch) => {
                          const vids = groupVideos.get(`${group.id}_${ch.channelId}`) || [];
                          return sum + vids.length;
                        }, 0);
                        const isExpanded = expandedGroupId === group.id;
                        return (
                          <div key={group.id} className="bg-slate-900/50 border border-slate-700/50 rounded-xl overflow-hidden">
                            {/* 分组头部：点击展开 */}
                            <div
                              className="flex items-center gap-2 px-4 py-3 cursor-pointer hover:bg-slate-800/30 transition-colors"
                              onClick={() => setExpandedGroupId(isExpanded ? null : group.id)}
                            >
                              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: group.color }} />
                              <FolderOpen className="w-4 h-4 flex-shrink-0" style={{ color: group.color }} />
                              <span className="text-sm font-medium text-slate-200">{group.name}</span>
                              <span className="text-xs text-slate-500">({channels.length} 频道)</span>
                              {groupVideoCount > 0 && (
                                <span className="text-xs text-emerald-500/70 ml-1">· {groupVideoCount} 条视频</span>
                              )}
                              <button
                                onClick={e => { e.stopPropagation(); setSelectedGroupId(group.id); void loadAllGroupChannels(group.id); }}
                                className="ml-auto mr-2 px-2 py-0.5 text-[10px] bg-emerald-500/15 text-emerald-400 rounded hover:bg-emerald-500/25 flex items-center gap-1"
                              >
                                <RefreshCw className="w-2.5 h-2.5" />抓取
                              </button>
                              <ChevronRight className={`w-4 h-4 text-slate-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                            </div>

                            {/* 频道列表：展开时显示 */}
                            {isExpanded && (
                              <div className="border-t border-slate-800">
                                {channels.length === 0 ? (
                                  <p className="px-4 py-3 text-xs text-slate-600">该分组暂无频道</p>
                                ) : (
                                  <div className="divide-y divide-slate-800/50">
                                    {channels.map(ch => {
                                      const videos = groupVideos.get(`${group.id}_${ch.channelId}`) || [];
                                      const isLoading = loadingChannels.has(ch.channelId);
                                      const isSelected = selectedChannelId === ch.channelId && activeTab === 'monitor';
                                      return (
                                        <div key={ch.channelId} className={`${isSelected ? 'bg-emerald-500/5' : ''}`}>
                                          {/* 频道行 */}
                                          <div className="flex items-center gap-2 px-4 py-2 hover:bg-slate-800/30 transition-colors">
                                            <img
                                              src={ch.thumbnail || ''}
                                              alt=""
                                              className="w-7 h-7 rounded-full object-cover flex-shrink-0"
                                              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                            />
                                            <div className="flex-1 min-w-0">
                                              <p className="text-xs text-slate-300 truncate">{ch.title || ch.channelId}</p>
                                              {ch.subscriberCount > 0 && (
                                                <p className="text-[10px] text-slate-500">{formatNumber(ch.subscriberCount)} 订阅</p>
                                              )}
                                            </div>
                                            <span className="text-[10px] text-slate-600">{videos.length} 条</span>
                                            <button
                                              onClick={() => { setSelectedChannelId(ch.channelId); void fetchGroupChannelVideos(expandedGroupId, ch.channelId); }}
                                              disabled={isLoading}
                                              className="px-2 py-1 text-[10px] bg-cyan-500/15 text-cyan-400 rounded hover:bg-cyan-500/25 disabled:opacity-50 flex items-center gap-1"
                                            >
                                              {isLoading ? (
                                                <><Loader2 className="w-3 h-3 animate-spin" />加载中</>
                                              ) : (
                                                <>{videos.length === 0 ? '获取数据' : '刷新数据'}</>
                                              )}
                                            </button>
                                            <button
                                              onClick={() => void removeChannelFromGroup(expandedGroupId, ch.channelId)}
                                              className="p-1 text-slate-600 hover:text-red-400 transition-colors"
                                              title="从分组移除"
                                            >
                                              <Trash2 className="w-3 h-3" />
                                            </button>
                                          </div>

                                          {/* 频道视频预览：选中时显示 */}
                                          {isSelected && (
                                            <div className="px-4 pb-3">
                                              {isLoading ? (
                                                <div className="flex items-center gap-2 py-2 text-xs text-slate-500">
                                                  <Loader2 className="w-3 h-3 animate-spin" />加载视频数据中...
                                                </div>
                                              ) : videos.length === 0 ? (
                                                <p className="py-2 text-xs text-slate-600">暂无视频数据</p>
                                              ) : (
                                                <div className="space-y-1.5">
                                                  {videos.slice(0, 10).map(v => (
                                                    <div
                                                      key={v.videoId}
                                                      className="flex items-center gap-2 p-1.5 bg-slate-800/30 hover:bg-slate-800/60 rounded-lg cursor-pointer transition-colors"
                                                      onClick={() => setAnalysisVideo(v)}
                                                    >
                                                      <img src={v.thumbnail || ''} alt="" className="w-16 h-10 rounded object-cover flex-shrink-0" />
                                                      <div className="flex-1 min-w-0">
                                                        <p className="text-[10px] text-slate-200 line-clamp-1">{v.title}</p>
                                                        <p className="text-[10px] text-slate-500">
                                                          {v.viewCount ? `${formatNumber(v.viewCount)} 播放` : ''}
                                                          {v.publishedAt ? ` · ${new Date(v.publishedAt).toLocaleDateString()}` : ''}
                                                        </p>
                                                      </div>
                                                    </div>
                                                  ))}
                                                </div>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              {/* 展开分组后的分组数据视图 */}
              {expandedGroupId && (() => {
                const group = channelGroups.find(g => g.id === expandedGroupId);
                if (!group) return null;
                const channels = group.channelIds
                  .map(id => allChannels.find(c => c.channelId === id))
                  .filter(Boolean) as ChannelMeta[];
                return (
                  <>
                    {/* 顶部导航 */}
                    <div className="flex items-center gap-2 bg-slate-900/50 border border-slate-700/50 rounded-xl p-3">
                      <button
                        onClick={() => setExpandedGroupId(null)}
                        className="p-1 hover:bg-slate-800 rounded transition-colors"
                      >
                        <ChevronLeft className="w-4 h-4 text-slate-400" />
                      </button>
                      <FolderOpen className="w-4 h-4" style={{ color: group.color }} />
                      <h3 className="text-sm font-medium text-slate-200">{group.name}</h3>
                      <span className="text-xs text-slate-500">({channels.length} 频道)</span>
                      <button
                        onClick={() => { setExpandedGroupId(null); setSelectedGroupId(group.id); void loadAllGroupChannels(group.id); }}
                        className="ml-auto px-2 py-1 text-xs bg-cyan-500/15 text-cyan-400 rounded hover:bg-cyan-500/25 flex items-center gap-1"
                      >
                        <RefreshCw className="w-3 h-3" />查看分组数据
                      </button>
                    </div>

                    {/* 分组内所有视频 */}
                    {(() => {
                      const allGroupVideos: VideoMeta[] = [];
                      for (const ch of channels) {
                        const vids = groupVideos.get(`${group.id}_${ch.channelId}`) || [];
                        allGroupVideos.push(...vids);
                      }
                      const seen = new Set<string>();
                      const deduped = allGroupVideos.filter(v => { if (seen.has(v.videoId)) return false; seen.add(v.videoId); return true; });
                      const sorted = sortVideosForMonitor(deduped, monitorSortMode);

                      if (!sorted.length) return (
                        <div className="text-center py-16 text-slate-500">
                          <Video className="w-12 h-12 mx-auto mb-3 opacity-30" />
                          <p>该分组暂无视频数据</p>
                          <p className="text-xs mt-1">点击频道右侧的「获取数据」按钮抓取视频</p>
                        </div>
                      );

                      return (
                        <>
                          {/* 排序控制 + 导出 */}
                          <div className="flex items-center gap-3 flex-wrap">
                            <div className="flex items-center gap-2 text-xs text-slate-400">
                              <Filter className="h-3 w-3 text-slate-500" />
                              <select
                                value={monitorSortMode}
                                onChange={e => setMonitorSortMode(e.target.value as MonitorSortMode)}
                                className="rounded-lg border border-slate-700/80 bg-slate-800/70 px-2 py-1 text-xs text-slate-200 focus:outline-none"
                              >
                                <option value="published_desc">最新发布</option>
                                <option value="views_desc">播放量从高到低</option>
                                <option value="engagement_desc">互动率从高到低</option>
                              </select>
                            </div>
                            <span className="text-xs text-slate-600">{sorted.length} 条视频</span>
                            {/* 导出按钮 */}
                            {sorted.length > 0 && (
                              <>
                                <button
                                  onClick={() => exportCSV(sorted, `监控_${group.name}_${rankingTimeRange}`)}
                                  className="px-2 py-1 bg-emerald-500/15 text-emerald-400 rounded text-xs hover:bg-emerald-500/25 flex items-center gap-1 ml-auto"
                                >
                                  <FileText className="w-3 h-3" />导出CSV
                                </button>
                                <button
                                  onClick={() => exportJSON(sorted, `监控_${group.name}_${rankingTimeRange}`)}
                                  className="px-2 py-1 bg-violet-500/15 text-violet-400 rounded text-xs hover:bg-violet-500/25 flex items-center gap-1"
                                >
                                  <FileText className="w-3 h-3" />导出JSON
                                </button>
                              </>
                            )}
                          </div>

                          {/* 词云显示 - 提取真正热门关键词 */}
                          {(() => {
                            // 使用视频列表提取热门关键词
                            const keywords = deduped.length > 0
                              ? getTrendingKeywordsFromVideosStatic(deduped)
                              : [];
                            if (keywords.length === 0) return null;
                            return (
                              <div className="mt-4 mb-2">
                                {renderWordCloud(keywords.map(k => ({ word: k.word, count: k.views, weight: k.weight })), `${group.name} - 热门关键词`)}
                              </div>
                            );
                          })()}

                          <div className="space-y-2">
                            {sorted.map(v => renderVideoCard(v))}
                          </div>
                        </>
                      );
                    })()}
                  </>
                );
              })()}
            </div>
          )}

          {activeTab === 'rankings' && (
            <div className="space-y-4">
              {/* 榜单筛选和计算 */}
              <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">维度：</span>
                    <select
                      value={rankingDimension}
                      onChange={e => setRankingDimension(e.target.value as RankingDimension)}
                      className="bg-slate-800/50 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-cyan-500/50"
                    >
                      <option value="views">播放量</option>
                      <option value="growth">涨速</option>
                      <option value="engagement">互动率</option>
                      <option value="recent">新晋</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">时间：</span>
                    <select
                      value={rankingTimeRange}
                      onChange={e => setRankingTimeRange(e.target.value as TimeRange)}
                      className="bg-slate-800/50 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-cyan-500/50"
                    >
                      <option value="1d">近1天</option>
                      <option value="7d">近7天</option>
                      <option value="30d">近30天</option>
                      <option value="all">全部</option>
                    </select>
                  </div>
                  <button
                    onClick={() => void computeRankings()}
                    disabled={isRankingLoading}
                    className="px-3 py-1 bg-cyan-500/20 text-cyan-400 rounded-lg text-xs hover:bg-cyan-500/30 transition-colors flex items-center gap-1 disabled:opacity-50"
                  >
                    {isRankingLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <TrendingUp className="w-3 h-3" />}
                    {isRankingLoading ? '计算中...' : '计算榜单'}
                  </button>
                  {rankingResult && (
                    <>
                      <button
                        onClick={() => exportCSV(rankingResult.videos, `榜单_${rankingDimension}_${rankingTimeRange}`)}
                        className="px-2 py-1 bg-emerald-500/15 text-emerald-400 rounded text-xs hover:bg-emerald-500/25 flex items-center gap-1"
                      >
                        <FileText className="w-3 h-3" />CSV
                      </button>
                      <button
                        onClick={() => exportJSON(rankingResult, `榜单_${rankingDimension}_${rankingTimeRange}`)}
                        className="px-2 py-1 bg-violet-500/15 text-violet-400 rounded text-xs hover:bg-violet-500/25 flex items-center gap-1"
                      >
                        <FileText className="w-3 h-3" />JSON
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* 榜单结果 */}
              {!rankingResult ? (
                <div className="text-center py-20 text-slate-500">
                  <TrendingUp className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>暂无榜单数据</p>
                  <p className="text-xs mt-1">点击「计算榜单」生成播放量/涨速/互动率榜单</p>
                </div>
              ) : rankingResult.videos.length === 0 ? (
                <div className="text-center py-20 text-slate-500">
                  <TrendingUp className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>当前条件下无数据</p>
                  <p className="text-xs mt-1">请先在监控分组中添加频道并抓取数据</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {rankingResult.videos.map((v, idx) => renderVideoCard({
                    videoId: v.videoId,
                    title: v.title,
                    channelId: v.channelId,
                    channelTitle: v.channelTitle,
                    viewCount: v.viewCount,
                    likeCount: v.likeCount,
                    publishedAt: v.publishedAt,
                    fetchedAt: v.fetchedAt,
                    thumbnail: v.thumbnail,
                    url: v.url,
                    rank: idx + 1,
                  }))}
                </div>
              )}
            </div>
          )}

          {/* ── 关键词监控 ── */}
          {activeTab === 'keywords' && (
            <div className="space-y-4">
              {/* 关键词添加区 */}
              <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Tag className="w-4 h-4 text-cyan-400" />
                  <h2 className="text-sm font-medium text-slate-200">关键词监控</h2>
                  <span className="text-xs text-slate-500">({keywordMonitors.length})</span>
                </div>
                <div className="flex gap-2">
                  <input
                    value={newKeyword}
                    onChange={e => setNewKeyword(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && void addKeywordMonitor()}
                    placeholder="输入关键词进行监控..."
                    className="flex-1 bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
                  />
                  <button
                    onClick={() => void addKeywordMonitor()}
                    disabled={!newKeyword.trim()}
                    className="px-4 py-2 bg-cyan-500/20 text-cyan-400 rounded-lg text-sm hover:bg-cyan-500/30 transition-colors flex items-center gap-1 disabled:opacity-50"
                  >
                    <Plus className="w-4 h-4" />
                    添加
                  </button>
                </div>
              </div>

              {/* 关键词列表和结果 */}
              {keywordMonitors.length === 0 ? (
                <div className="text-center py-16 text-slate-500">
                  <Search className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>暂无关键词监控</p>
                  <p className="text-xs mt-1">在上方添加关键词开始监控</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {keywordMonitors.map(km => {
                    const results = keywordResults.get(km.keyword) || [];
                    return (
                      <div key={km.id} className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <Tag className="w-4 h-4 text-cyan-400" />
                          <h3 className="text-sm font-medium text-slate-200">{km.keyword}</h3>
                          <span className="text-xs text-slate-500">({results.length} 条结果)</span>
                          <button
                            onClick={() => void fetchKeywordResults(km.keyword)}
                            disabled={isKeywordFetching}
                            className="ml-auto p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-cyan-400 transition-colors"
                            title="刷新"
                          >
                            <RefreshCw className={`w-4 h-4 ${isKeywordFetching ? 'animate-spin' : ''}`} />
                          </button>
                          <button
                            onClick={async () => {
                              await storage.deleteKeywordMonitor(km.id);
                              setKeywordMonitors(prev => prev.filter(m => m.id !== km.id));
                              setKeywordResults(prev => { const next = new Map(prev); next.delete(km.keyword); return next; });
                            }}
                            className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-red-400 transition-colors"
                            title="删除"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>

                        {/* 导出按钮 */}
                        {results.length > 0 && (
                          <div className="flex gap-2 mb-3">
                            <button
                              onClick={() => exportCSV(results as unknown as TrendingVideo[], `关键词_${km.keyword}`)}
                              className="px-2 py-1 bg-emerald-500/15 text-emerald-400 rounded text-xs hover:bg-emerald-500/25 flex items-center gap-1"
                            >
                              <FileText className="w-3 h-3" />导出CSV
                            </button>
                            <button
                              onClick={() => exportJSON(results, `关键词_${km.keyword}`)}
                              className="px-2 py-1 bg-violet-500/15 text-violet-400 rounded text-xs hover:bg-violet-500/25 flex items-center gap-1"
                            >
                              <FileText className="w-3 h-3" />导出JSON
                            </button>
                          </div>
                        )}

                        {!results.length ? (
                          <div className="text-center py-8 text-slate-600 text-sm">
                            {isKeywordFetching ? (
                              <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />抓取中...</span>
                            ) : (
                              '暂无数据，点击刷新按钮获取'
                            )}
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
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'analysis' && (
            <div className="space-y-4">
              {renderAnalysisPanel()}
              {renderCompetitors()}
            </div>
          )}

          {activeTab === 'compare' && renderCompareView()}

          {/* ── 评论提取 ── */}
          {activeTab === 'comments' && (
            <div className="space-y-4">
              <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <MessageCircle className="w-4 h-4 text-blue-400" />
                  <h2 className="text-sm font-medium text-slate-200">视频评论提取</h2>
                  <span className="ml-auto text-xs text-slate-500">YouTube 官方 API</span>
                  {/* 导出按钮 - 移到顶部 */}
                  {commentResult && commentResult.comments.length > 0 && !isLoadingComments && (
                    <button
                      onClick={() => {
                        const txt = commentResult.comments.map(c =>
                          `【${c.author}】${formatAgo(c.publishedAt)} | 👍${formatNumber(c.likeCount)}${c.replyCount > 0 ? ` | 💬${c.replyCount}回复` : ''}\n${c.text}`
                        ).join('\n\n');
                        downloadBlob(new Blob(['\ufeff' + txt], { type: 'text/plain;charset=utf-8' }), `comments_${commentVideoId}_${Date.now()}.txt`);
                        setInfoMsg('评论已导出为 TXT 文件');
                      }}
                      className="px-3 py-1.5 text-xs bg-slate-700/50 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors flex items-center gap-1.5"
                    >
                      <DownloadCloud className="w-3 h-3" />导出（TXT）
                    </button>
                  )}
                  {/* 提取痛点按钮 */}
                  {commentResult && commentResult.comments.length > 0 && !isLoadingComments && (
                    <button
                      onClick={() => void extractPainPoints()}
                      className="px-3 py-1.5 text-xs bg-amber-600/80 hover:bg-amber-500 text-white rounded-lg transition-colors flex items-center gap-1.5"
                    >
                      <Brain className="w-3 h-3" />提取痛点
                    </button>
                  )}
                </div>
                <div className="flex gap-2 mb-3">
                  <input
                    value={commentVideoUrl}
                    onChange={e => setCommentVideoUrl(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const vid = extractVideoIdFromUrl(e.currentTarget.value);
                        setCommentVideoId(vid);
                        if (vid) void loadComments(vid);
                      }
                    }}
                    placeholder="粘贴 YouTube 视频链接或视频 ID..."
                    className="flex-1 bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/50"
                  />
                  <button
                    onClick={() => {
                      const vid = extractVideoIdFromUrl(commentVideoUrl);
                      setCommentVideoId(vid);
                      if (vid) void loadComments(vid);
                      else setErrorMsg('无效的 YouTube 链接');
                    }}
                    disabled={isLoadingComments}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                  >
                    {isLoadingComments ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    {isLoadingComments ? '加载中...' : '提取评论'}
                  </button>
                </div>
                {commentVideoId && !isLoadingComments && (
                  <p className="text-xs text-slate-500 mb-3">
                    视频ID：<span className="font-mono text-slate-400">{commentVideoId}</span>
                    {commentResult && (
                      <span className="ml-3">共 {commentResult.total} 条评论（显示 {commentResult.comments.length} 条）</span>
                    )}
                  </p>
                )}
                {isLoadingComments && (
                  <div className="text-center py-8 text-slate-500 text-sm flex items-center justify-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />正在通过官方 API 拉取评论，请稍候…
                  </div>
                )}
                {commentResult && commentResult.comments.length > 0 && !isLoadingComments && (
                  <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
                    {commentResult.comments.slice(0, (commentPage + 1) * COMMENT_PAGE_SIZE).map(c => (
                      <div key={c.commentId} className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30 hover:border-slate-600/50 transition-colors">
                        <div className="flex items-start gap-3">
                          {c.authorThumbnail && (
                            <img src={c.authorThumbnail} alt={c.author} className="w-8 h-8 rounded-full flex-shrink-0 mt-0.5" />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-medium text-slate-200">{c.author}</span>
                              {c.replyCount > 0 && (
                                <span className="text-[10px] text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded-full">
                                  {c.replyCount} 条回复
                                </span>
                              )}
                              <span className="text-[10px] text-slate-600 ml-auto flex-shrink-0">
                                {formatAgo(c.publishedAt)}
                              </span>
                            </div>
                            <p className="text-xs text-slate-300 mt-1 leading-relaxed whitespace-pre-wrap">{c.text}</p>
                            <div className="flex items-center gap-3 mt-1.5 text-[10px] text-slate-600">
                              <span className="flex items-center gap-1"><ThumbsUp className="w-3 h-3" />{formatNumber(c.likeCount)}</span>
                              <a href={`https://youtube.com/watch?v=${commentVideoId}&lc=${c.commentId}`} target="_blank" rel="noopener noreferrer" className="hover:text-slate-400 flex items-center gap-1">
                                <ExternalLink className="w-3 h-3" />查看原评论
                              </a>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                    {commentPage * COMMENT_PAGE_SIZE + COMMENT_PAGE_SIZE < commentResult.comments.length && (
                      <button
                        onClick={() => setCommentPage(p => p + 1)}
                        className="w-full py-2 text-xs text-slate-500 hover:text-slate-300 border border-dashed border-slate-700/50 rounded-lg hover:border-slate-600 transition-colors"
                      >
                        加载更多（{commentResult.comments.length - (commentPage + 1) * COMMENT_PAGE_SIZE} 条剩余）
                      </button>
                    )}
                  </div>
                )}

                {/* ── 痛点分析结果 ── */}
                {(isAnalyzingPainPoints || painPointsResult) && (
                  <div className="mt-4 p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400" />
                      <h3 className="text-sm font-medium text-amber-300">用户痛点分析</h3>
                      {isAnalyzingPainPoints && <Loader2 className="w-3 h-3 animate-spin text-amber-400 ml-auto" />}
                      {painPointsResult && !isAnalyzingPainPoints && (
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(painPointsResult);
                            setCopiedId('painpoints');
                            setTimeout(() => setCopiedId(null), 2000);
                          }}
                          className="ml-auto px-2 py-1 text-xs bg-amber-600/50 hover:bg-amber-500/60 text-amber-200 rounded-md transition-colors flex items-center gap-1"
                        >
                          {copiedId === 'painpoints' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          {copiedId === 'painpoints' ? '已复制' : '复制'}
                        </button>
                      )}
                    </div>
                    {isAnalyzingPainPoints && !painPointsResult && (
                      <p className="text-xs text-amber-400/70">正在调用 Gemini 模型分析评论，请稍候...</p>
                    )}
                    {painPointsResult && (
                      <div className="text-sm text-amber-100/90 whitespace-pre-wrap leading-relaxed">
                        {painPointsResult}
                      </div>
                    )}
                  </div>
                )}
                {commentResult && commentResult.comments.length === 0 && !isLoadingComments && (
                  <div className="text-center py-8 text-slate-500 text-sm">
                    该视频暂无评论或评论已关闭
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 收藏弹窗通知 */}
      {favoriteToast && (
        <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-5 fade-in duration-300">
          <div className="bg-slate-800 border border-violet-500/50 rounded-xl px-4 py-3 shadow-2xl flex items-center gap-3">
            <Heart className="w-5 h-5 text-violet-400 fill-violet-400 flex-shrink-0" />
            <span className="text-sm text-slate-200">{favoriteToast}</span>
          </div>
        </div>
      )}

      {/* 收藏选择弹窗 */}
      {renderFavoritePicker()}
    </div>
  );
};

// ── 工具函数（组件外）────────────────────────────────────────────────
function isQuotaError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /quota|ratelimit|rate.limit|exceeded|usage.limit|daily.limit|403|429/i.test(msg);
}

const GROUP_COLORS = ['#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#14b8a6'];
