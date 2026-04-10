/**
 * YouTube 分析核心服务
 *
 * 职责：
 * 1. YouTube Data API v3 调用（含配额记录）
 * 2. Invidious 备用兜底
 * 3. 榜单计算（播放量/涨速/互动率/新晋）
 * 4. 趋势分（爆款指数）计算
 * 5. 词云数据生成
 * 6. 竞争频道发现
 * 7. 视频快照持久化（配合 storageService）
 */

import { storage, type VideoSnapshot, genId } from './storageService';

// ── 配置 ──────────────────────────────────────────────────────────────

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const DAILY_QUOTA_LIMIT = 10_000; // YouTube Data API 免费配额
const QUOTA_COST = {
  search: 100,
  videos_list: 1,
  channels_list: 1,
};

// ── 类型 ──────────────────────────────────────────────────────────────

export interface VideoMeta {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  thumbnail?: string;
  viewCount: number;
  likeCount?: number;
  commentCount?: number;
  publishedAt: number; // timestamp ms
  duration?: number;   // seconds
  tags?: string[];
  description?: string;
  url: string;
  fetchedAt: number;
}

export interface ChannelMeta {
  channelId: string;
  title: string;
  description?: string;
  thumbnail?: string;
  subscriberCount: number;
  videoCount: number;
  viewCount: number;
  fetchedAt: number;
}

export interface TrendingVideo extends VideoMeta {
  /** 爆款指数（0-100），综合播放量、增速、互动率计算 */
  trendScore: number;
  /** 推荐理由（中文） */
  reason: string;
  /** 趋势标签 */
  trendTag?: string;
  /** 所属分组（如果有） */
  groupId?: string;
}

export interface RankingResult {
  dimension: RankingDimension;
  timeRange: TimeRange;
  videos: TrendingVideo[];
  computedAt: number;
}

export type RankingDimension = 'views' | 'growth' | 'engagement' | 'new';
export type TimeRange = '24h' | '7d' | '30d';

export interface WordCloudEntry {
  word: string;
  weight: number; // 出现频率（归一化 0-100）
  count: number;
}

export interface CompetitorChannel {
  channel: ChannelMeta;
  overlapKeywords: string[];
  recentTrendScore: number;
}

export interface FetchResult<T> {
  data: T;
  fromCache: boolean;
  quotaUsed?: number;
}

// ── 工具函数 ──────────────────────────────────────────────────────────

function parseISO8601Duration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const h = parseInt(match[1] || '0');
  const m = parseInt(match[2] || '0');
  const s = parseInt(match[3] || '0');
  return h * 3600 + m * 60 + s;
}

function parseViewCount(text: string): number {
  const m = text.match(/[\d,]+/);
  if (!m) return 0;
  return parseInt(m[0].replace(/,/g, ''));
}

function subOrText(val: string | undefined): string {
  return val ?? '0';
}

function safeStr(val: unknown): string {
  return typeof val === 'string' ? val : '';
}

// ── 核心 fetch（带配额记录）────────────────────────────────────────────

/**
 * 带配额记录的 fetch 封装
 * quotaKey 必须是 QUOTA_COST 中定义的操作名
 */
async function quotaFetch(
  url: string,
  quotaKey: keyof typeof QUOTA_COST,
  apiKey?: string
): Promise<Response & { _quotaCost?: number }> {
  const cost = QUOTA_COST[quotaKey];
  const finalUrl = apiKey ? `${url}${url.includes('?') ? '&' : '?'}key=${apiKey}` : url;
  const res = await fetch(finalUrl);
  // 仅成功响应计入配额；403/429/500 等错误不扣配额
  if (res.ok) {
    await storage.logApiUsage(cost, quotaKey);
  }
  (res as any)._quotaCost = cost;
  return res;
}

// ── YouTube 官方 API ──────────────────────────────────────────────────

/**
 * 搜索视频（支持关键词/频道过滤）
 */
async function searchVideosByKeyword(
  keyword: string,
  apiKey: string,
  maxResults = 20,
  order = 'viewCount' as const
): Promise<VideoMeta[]> {
  const res = await quotaFetch(
    `${YOUTUBE_API_BASE}/search?part=snippet&type=video&q=${encodeURIComponent(keyword)}&maxResults=${maxResults}&order=${order}&publishedAfter=${getPublishedAfter('7d')}`,
    'search',
    apiKey
  );
  if (!res.ok) throw new Error(`YouTube search failed: ${res.status}`);
  const data = await res.json();
  const items = data.items || [];
  if (!items.length) return [];

  const videoIds = items.map((i: any) => i.id.videoId).filter(Boolean).join(',');
  const detailRes = await quotaFetch(
    `${YOUTUBE_API_BASE}/videos?part=contentDetails,statistics&id=${videoIds}`,
    'videos_list',
    apiKey
  );
  const detailData = await detailRes.json();
  const detailMap = new Map((detailData.items || []).map((v: any) => [v.id, v]));

  return items.map((item: any) => {
    const vid = item.id.videoId;
    const d = detailMap.get(vid) || {};
    const stats = d.statistics || {};
    return normalizeVideoMeta(item, d, Date.now());
  });
}

/** 搜索频道 */
async function searchChannels(keyword: string, apiKey: string): Promise<ChannelMeta[]> {
  const res = await quotaFetch(
    `${YOUTUBE_API_BASE}/search?part=snippet&type=channel&q=${encodeURIComponent(keyword)}&maxResults=10`,
    'search',
    apiKey
  );
  if (!res.ok) throw new Error(`YouTube channel search failed: ${res.status}`);
  const data = await res.json();
  const channelIds = (data.items || []).map((i: any) => i.id.channelId).filter(Boolean).join(',');
  if (!channelIds) return [];

  const detailRes = await quotaFetch(
    `${YOUTUBE_API_BASE}/channels?part=snippet,statistics&id=${channelIds}`,
    'channels_list',
    apiKey
  );
  const detailData = await detailRes.json();
  return (detailData.items || []).map(normalizeChannelMeta);
}

/** 获取频道最新视频 */
async function getChannelLatestVideos(
  channelId: string,
  apiKey: string,
  maxResults = 20
): Promise<VideoMeta[]> {
  const searchRes = await quotaFetch(
    `${YOUTUBE_API_BASE}/search?part=snippet&channelId=${channelId}&maxResults=${maxResults}&order=date&type=video`,
    'search',
    apiKey
  );
  if (!searchRes.ok) throw new Error(`Channel search failed: ${searchRes.status}`);
  const searchData = await searchRes.json();
  const items = searchData.items || [];
  if (!items.length) return [];

  const videoIds = items.map((i: any) => i.id.videoId).filter(Boolean).join(',');
  const detailRes = await quotaFetch(
    `${YOUTUBE_API_BASE}/videos?part=contentDetails,statistics&id=${videoIds}`,
    'videos_list',
    apiKey
  );
  const detailData = await detailRes.json();
  const detailMap = new Map((detailData.items || []).map((v: any) => [v.id, v]));

  return items.map((item: any) => {
    const vid = item.id.videoId;
    const d = detailMap.get(vid) || {};
    return normalizeVideoMeta(item, d, Date.now());
  });
}

/** 获取视频详情（批量） */
async function getVideosDetail(
  videoIds: string[],
  apiKey: string
): Promise<VideoMeta[]> {
  if (!videoIds.length) return [];
  const ids = videoIds.join(',');
  const res = await quotaFetch(
    `${YOUTUBE_API_BASE}/videos?part=snippet,contentDetails,statistics&id=${ids}`,
    'videos_list',
    apiKey
  );
  if (!res.ok) throw new Error(`Video detail failed: ${res.status}`);
  const data = await res.json();
  return (data.items || []).map((v: any) => normalizeVideoMeta(v, v, Date.now()));
}

/** 获取频道详情 */
async function getChannelDetail(channelId: string, apiKey: string): Promise<ChannelMeta | null> {
  const res = await quotaFetch(
    `${YOUTUBE_API_BASE}/channels?part=snippet,statistics&id=${channelId}`,
    'channels_list',
    apiKey
  );
  if (!res.ok) return null;
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) return null;
  return normalizeChannelMeta(item);
}

// ── Invidious 备用 API ────────────────────────────────────────────────

/** 同源 Invidious 代理 URL */
function invidiousProxyUrl(path: string, query: Record<string, string> = {}): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const params = new URLSearchParams({ path, ...query });
  return `${origin}/api/invidious?${params.toString()}`;
}

async function invidiousFetch<T>(path: string, query: Record<string, string> = {}): Promise<T> {
  const url = invidiousProxyUrl(path, query);
  const res = await fetch(url);
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error(text.slice(0, 240)); }
  const err = (data as any)?.error;
  if (!res.ok || (err && typeof err === 'string')) {
    throw new Error(err || `Invidious ${res.status}`);
  }
  return data as T;
}

async function invidiousSearchVideos(keyword: string, maxResults = 20): Promise<VideoMeta[]> {
  const data = await invidiousFetch<any[]>('search', { q: keyword, type: 'video' });
  const videos = data.slice(0, maxResults);
  const results: VideoMeta[] = [];

  for (const v of videos) {
    const videoId = v.videoId || v.id;
    if (!videoId) continue;
    try {
      const detail = await invidiousFetch<any>(`videos/${videoId}`, {});
      results.push(normalizeInvidiousVideo(detail));
    } catch { /* skip failed items */ }
  }
  return results;
}

async function invidiousGetChannelVideos(channelId: string, maxResults = 20): Promise<VideoMeta[]> {
  const data = await invidiousFetch<any>('channels/videos', {
    cid: channelId,
  });
  const videos = (data.videos || []).slice(0, maxResults);
  return videos.map(normalizeInvidiousVideo);
}

async function invidiousGetVideoDetail(videoId: string): Promise<VideoMeta> {
  const detail = await invidiousFetch<any>(`videos/${videoId}`, {});
  return normalizeInvidiousVideo(detail);
}

// ── 归一化 ────────────────────────────────────────────────────────────

function normalizeVideoMeta(item: any, detail: any, fetchedAt: number): VideoMeta {
  const snippet = item.snippet || item;
  const vid = item.id?.videoId || item.id || '';
  const stats = detail?.statistics || {};
  const content = detail?.contentDetails || {};
  return {
    videoId: vid,
    title: safeStr(snippet.title),
    channelId: safeStr(snippet.channelId),
    channelTitle: safeStr(snippet.channelTitle),
    thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url,
    viewCount: parseViewCount(subOrText(stats.viewCount)),
    likeCount: parseViewCount(subOrText(stats.likeCount)),
    commentCount: parseViewCount(subOrText(stats.commentCount)),
    publishedAt: snippet.publishedAt ? new Date(snippet.publishedAt).getTime() : fetchedAt,
    duration: parseISO8601Duration(content.duration || ''),
    tags: Array.isArray(snippet.tags) ? snippet.tags : [],
    description: safeStr(snippet.description),
    url: `https://youtube.com/watch?v=${vid}`,
    fetchedAt,
  };
}

function normalizeChannelMeta(item: any): ChannelMeta {
  const snippet = item.snippet || {};
  const stats = item.statistics || {};
  return {
    channelId: item.id || '',
    title: safeStr(snippet.title),
    description: safeStr(snippet.description),
    thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url,
    subscriberCount: parseViewCount(subOrText(stats.subscriberCount)),
    videoCount: parseViewCount(subOrText(stats.videoCount)),
    viewCount: parseViewCount(subOrText(stats.viewCount)),
    fetchedAt: Date.now(),
  };
}

function normalizeInvidiousVideo(v: any): VideoMeta {
  return {
    videoId: v.videoId || v.id || '',
    title: safeStr(v.title),
    channelId: safeStr(v.authorId),
    channelTitle: safeStr(v.author),
    thumbnail: v.videoThumbnails?.[0]?.url,
    viewCount: v.viewCount || 0,
    likeCount: v.likeCount,
    commentCount: undefined,
    publishedAt: v.published ? new Date(v.published * 1000).getTime() : Date.now(),
    duration: v.lengthSeconds,
    tags: Array.isArray(v.keywords) ? v.keywords : [],
    description: safeStr(v.description),
    url: `https://youtube.com/watch?v=${v.videoId || v.id}`,
    fetchedAt: Date.now(),
  };
}

// ── 配额检查 ─────────────────────────────────────────────────────────

export async function checkQuotaStatus(): Promise<{
  usedToday: number;
  remaining: number;
  percentUsed: number;
}> {
  const { totalUnits } = await storage.getApiQuotaToday();
  const remaining = Math.max(0, DAILY_QUOTA_LIMIT - totalUnits);
  return {
    usedToday: totalUnits,
    remaining,
    percentUsed: Math.min(100, (totalUnits / DAILY_QUOTA_LIMIT) * 100),
  };
}

/** 判断是否为配额相关错误（403 / 429 / quota 相关消息） */
function isQuotaError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /quota|ratelimit|rate.limit|exceeded|usage.limit|daily.limit|403|429/i.test(msg);
}

/** 标记已切换到 Invidious 备用模式（导出给组件用） */
let _fallbackActive = false;
export function setQuotaFallbackActive(active: boolean): void {
  _fallbackActive = active;
  // 通知 UI 更新
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('yt-quota-fallback'));
  }
}
export function isQuotaFallbackActive(): boolean {
  return _fallbackActive;
}

/** 判断是否接近配额上限（>80%） */
export async function isQuotaNearLimit(): Promise<boolean> {
  const { percentUsed } = await checkQuotaStatus();
  return percentUsed >= 30;
}

// ── 趋势分计算（核心算法）──────────────────────────────────────────────

/**
 * 计算单条视频的爆款指数（0-100）
 *
 * 维度：
 * - 绝对播放量（归一化到 0-40 分）
 * - 涨速（近 7 天播放量增长估算，0-30 分）
 * - 互动率（(点赞+评论)/播放量，0-20 分）
 * - 新鲜度（发布越新分数越高，0-10 分）
 */
export function calcTrendScore(video: VideoMeta, historySnapshots: VideoSnapshot[] = []): number {
  const now = Date.now();
  const ageHours = (now - video.publishedAt) / (1000 * 60 * 60);

  // 1. 绝对播放量分（最多 40 分）
  // 100万播放 = 40分，线性映射到对数空间
  const rawViews = Math.max(1, video.viewCount);
  const viewScore = Math.min(40, Math.log10(rawViews + 1) * 4);

  // 2. 涨速分（最多 30 分）
  let growthScore = 0;
  if (historySnapshots.length >= 2) {
    const sorted = [...historySnapshots].sort((a, b) => a.fetchedAt - b.fetchedAt);
    const oldest = sorted[0];
    const newest = sorted[sorted.length - 1];
    const timeDelta = (newest.fetchedAt - oldest.fetchedAt) / (1000 * 60 * 60); // 小时
    const viewDelta = Math.max(0, newest.viewCount - oldest.viewCount);
    if (timeDelta > 0) {
      // 每小时增长 10 万播放 = 30分
      const hourlyGrowth = viewDelta / timeDelta;
      growthScore = Math.min(30, (hourlyGrowth / 100_000) * 30);
    }
  } else {
    // 无历史数据：根据年龄估算（发布 <24h 强提示）
    if (ageHours < 24) growthScore = 20 + Math.max(0, 10 - ageHours / 2);
    else if (ageHours < 72) growthScore = 10;
    else growthScore = 0;
  }

  // 3. 互动率分（最多 20 分）
  const likes = video.likeCount ?? 0;
  const comments = video.commentCount ?? 0;
  const totalEngagements = likes + comments;
  const engagementRate = rawViews > 0 ? totalEngagements / rawViews : 0;
  const engagementScore = Math.min(20, engagementRate * 1000); // 10% 互动率 = 100分，上限 20

  // 4. 新鲜度分（最多 10 分）
  let freshnessScore = 0;
  if (ageHours <= 1) freshnessScore = 10;
  else if (ageHours <= 6) freshnessScore = 9;
  else if (ageHours <= 24) freshnessScore = 8;
  else if (ageHours <= 72) freshnessScore = 6;
  else if (ageHours <= 168) freshnessScore = 4; // 7 天
  else freshnessScore = Math.max(0, 2 - (ageHours - 168) / 720); // 30 天后趋近 0

  const total = viewScore + growthScore + engagementScore + freshnessScore;
  return Math.round(Math.min(100, total) * 10) / 10;
}

/** 生成推荐理由 */
export function generateReason(video: VideoMeta, historySnapshots: VideoSnapshot[] = []): string {
  const now = Date.now();
  const ageHours = (now - video.publishedAt) / (1000 * 60 * 60);
  const reasons: string[] = [];

  // 播放量
  if (video.viewCount >= 10_000_000) reasons.push('千万级播放爆款');
  else if (video.viewCount >= 1_000_000) reasons.push('百万级热门视频');
  else if (video.viewCount >= 100_000) reasons.push('十万级优质内容');

  // 涨速
  if (historySnapshots.length >= 2) {
    const sorted = [...historySnapshots].sort((a, b) => a.fetchedAt - b.fetchedAt);
    const newest = sorted[sorted.length - 1];
    const oldest = sorted[0];
    const hours = (newest.fetchedAt - oldest.fetchedAt) / (1000 * 60 * 60);
    if (hours > 0) {
      const growth = ((newest.viewCount - oldest.viewCount) / hours).toFixed(0);
      if (parseFloat(growth) >= 10000) reasons.push(`每小时增长约${formatCount(parseFloat(growth))}播放`);
    }
  } else {
    if (ageHours < 6) reasons.push('新发布涨势迅猛');
    else if (ageHours < 24) reasons.push('24小时内快速上升');
  }

  // 互动率
  const likes = video.likeCount ?? 0;
  const comments = video.commentCount ?? 0;
  const engRate = video.viewCount > 0 ? (likes + comments) / video.viewCount : 0;
  if (engRate >= 0.05) reasons.push('超高互动率（赞评比>5%）');
  else if (engRate >= 0.02) reasons.push('高互动率（赞评比>2%）');

  // 时长
  if (video.duration && video.duration <= 60) reasons.push('短视频格式');
  else if (video.duration && video.duration >= 1200) reasons.push('长视频深度内容');

  return reasons.slice(0, 3).join(' · ') || '综合热度较高';
}

// ── 榜单计算 ──────────────────────────────────────────────────────────

function getPublishedAfter(range: TimeRange): string {
  const now = new Date();
  const offset: Record<TimeRange, number> = { '24h': 1, '7d': 7, '30d': 30 };
  const days = offset[range];
  now.setDate(now.getDate() - days);
  return now.toISOString().replace('.000Z', 'Z');
}

/** 计算视频榜单 */
export async function computeRanking(
  videos: VideoMeta[],
  dimension: RankingDimension,
  timeRange: TimeRange
): Promise<RankingResult> {
  const now = Date.now();
  const rangeMs: Record<TimeRange, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  const cutoff = now - rangeMs[timeRange];

  // 过滤时间范围
  const filtered = videos.filter((v) => v.publishedAt >= cutoff);

  // 分别计算趋势分
  const scored: TrendingVideo[] = await Promise.all(
    filtered.map(async (v) => {
      const history = await storage.getVideoHistory(v.videoId);
      const score = calcTrendScore(v, history);
      const reason = generateReason(v, history);
      return {
        ...v,
        trendScore: score,
        reason,
        publishedAt: v.publishedAt,
        fetchedAt: v.fetchedAt,
      };
    })
  );

  // 按维度排序
  const sorted = scored.sort((a, b) => {
    switch (dimension) {
      case 'views':
        return b.viewCount - a.viewCount;
      case 'growth': {
        // 用趋势分代替实际增速（有历史快照则更准确）
        return b.trendScore - a.trendScore;
      }
      case 'engagement': {
        const engA = ((a.likeCount ?? 0) + (a.commentCount ?? 0)) / Math.max(1, a.viewCount);
        const engB = ((b.likeCount ?? 0) + (b.commentCount ?? 0)) / Math.max(1, b.viewCount);
        return engB - engA;
      }
      case 'new':
        return b.publishedAt - a.publishedAt;
      default:
        return b.trendScore - a.trendScore;
    }
  });

  return {
    dimension,
    timeRange,
    videos: sorted.slice(0, 100),
    computedAt: now,
  };
}

/** 合并多个频道的视频并计算榜单 */
export async function computeGroupRanking(
  channelVideosMap: Map<string, VideoMeta[]>,
  dimension: RankingDimension,
  timeRange: TimeRange
): Promise<RankingResult> {
  const allVideos: VideoMeta[] = [];
  for (const [, videos] of channelVideosMap) {
    allVideos.push(...videos);
  }
  // 去重
  const seen = new Set<string>();
  const deduped = allVideos.filter((v) => {
    if (seen.has(v.videoId)) return false;
    seen.add(v.videoId);
    return true;
  });
  return computeRanking(deduped, dimension, timeRange);
}

// ── 词云 ────────────────────────────────────────────────────────────

/** 从标题列表生成词云数据 */
export function buildWordCloud(titles: string[]): WordCloudEntry[] {
  // 停用词
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'to', 'of', 'in', 'for', 'on', 'with',
    'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after',
    'and', 'or', 'but', 'not', 'no', 'so', 'very', 'just', 'this', 'that',
    'these', 'those', 'it', 'its', 'i', 'you', 'he', 'she', 'we', 'they',
    'my', 'your', 'his', 'her', 'our', 'their', 'what', 'which', 'who',
    'how', 'why', 'when', 'where', '2024', '2025', '2026', '2023', '2022',
    'official', 'video', 'hd', '4k', 'new', 'vs', 'part', '1', '2', '3',
    'one', 'two', 'first', 'ft', 'feat', 'live', 'today', '2026',
    // 中文停用
    '的', '了', '和', '是', '在', '我', '有', '个', '他', '她', '们',
    '这', '那', '你', '也', '就', '都', '还', '与', '或', '不', '很',
    '会', '能', '要', '之', '以', '等', '为', '上', '下', '中', '来',
    '去', '后', '前', '大', '小', '多', '少', '一', '第', '更', '最',
  ]);

  const wordCount = new Map<string, number>();

  /** 英文按空白切分；无空格的中文长串拆成 2 字词，避免整句标题当成一个词挤在词云里 */
  function tokenizeTitle(raw: string): string[] {
    const out: string[] = [];
    const segments = raw.toLowerCase().split(/[\s\-_\/\\.,!?()[\]{}'":;]+/);
    for (let seg of segments) {
      seg = seg.replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
      if (!seg || seg.length < 2) continue;
      if (/^[a-z0-9]+$/.test(seg)) {
        if (!STOP_WORDS.has(seg)) out.push(seg);
        continue;
      }
      if (seg.length <= 6) {
        if (!STOP_WORDS.has(seg)) out.push(seg);
        continue;
      }
      for (let i = 0; i <= seg.length - 2; i++) {
        const bi = seg.slice(i, i + 2);
        if (!STOP_WORDS.has(bi)) out.push(bi);
      }
    }
    return out;
  }

  for (const title of titles) {
    const words = tokenizeTitle(title).filter((w) => w.length >= 2 && w.length <= 16);

    for (const w of words) {
      wordCount.set(w, (wordCount.get(w) || 0) + 1);
    }
  }

  const maxCount = Math.max(...wordCount.values(), 1);
  return Array.from(wordCount.entries())
    .map(([word, count]) => ({
      word,
      count,
      weight: Math.round((count / maxCount) * 100),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 100);
}

// ── 竞争频道发现 ──────────────────────────────────────────────────────

/**
 * 基于关键词重叠发现竞争频道
 */
export async function discoverCompetitors(
  myKeywords: string[],
  apiKey: string,
  topN = 10
): Promise<CompetitorChannel[]> {
  const channelMap = new Map<string, { channel: ChannelMeta; overlap: Set<string> }>();

  for (const kw of myKeywords.slice(0, 5)) {
    let videos: VideoMeta[];
    try {
      videos = await searchVideosByKeyword(kw, apiKey, 10, 'viewCount');
    } catch {
      continue;
    }
    for (const v of videos) {
      const existing = channelMap.get(v.channelId);
      if (existing) {
        existing.overlap.add(kw);
      } else {
        const ch = await getChannelDetail(v.channelId, apiKey);
        if (ch) {
          channelMap.set(v.channelId, { channel: ch, overlap: new Set([kw]) });
        }
      }
    }
  }

  const competitors: CompetitorChannel[] = [];
  for (const [, { channel, overlap }] of channelMap) {
    const videos = await getChannelLatestVideos(channel.channelId, apiKey, 5);
    const avgScore = videos.length
      ? videos.reduce((s, v) => s + calcTrendScore(v, []), 0) / videos.length
      : 0;
    competitors.push({
      channel,
      overlapKeywords: Array.from(overlap),
      recentTrendScore: Math.round(avgScore * 10) / 10,
    });
  }

  return competitors.sort((a, b) => b.recentTrendScore - a.recentTrendScore).slice(0, topN);
}

// ── 快照保存 ─────────────────────────────────────────────────────────

/** 保存视频快照（配合每日定时抓取） */
export async function saveVideoSnapshot(video: VideoMeta): Promise<void> {
  const snapshot: VideoSnapshot = {
    videoId: video.videoId,
    channelId: video.channelId,
    channelTitle: video.channelTitle,
    title: video.title,
    viewCount: video.viewCount,
    likeCount: video.likeCount,
    commentCount: video.commentCount,
    publishedAt: video.publishedAt,
    fetchedAt: video.fetchedAt,
    duration: video.duration,
    thumbnail: video.thumbnail,
    url: video.url,
  };
  await storage.appendVideoSnapshot(snapshot);
}

// ── 统一 fetch 入口（自动选择 API）─────────────────────────────────────

/**
 * 搜索视频（自动处理配额不足回退）
 */
export async function ytSearchVideos(
  keyword: string,
  apiKey?: string,
  maxResults = 20
): Promise<VideoMeta[]> {
  if (!apiKey) return invidiousSearchVideos(keyword, maxResults);

  // 配额已接近上限时跳过官方 API
  const nearLimit = await isQuotaNearLimit().catch(() => false);
  if (nearLimit) {
    setQuotaFallbackActive(true);
    return invidiousSearchVideos(keyword, maxResults);
  }

  try {
    return await searchVideosByKeyword(keyword, apiKey, maxResults);
  } catch (e) {
    if (isQuotaError(e)) {
      setQuotaFallbackActive(true);
      console.warn('[YT] 官方 API 配额耗尽，切换 Invidious');
    }
    try {
      return await invidiousSearchVideos(keyword, maxResults);
    } catch (e2) {
      throw e; // 优先抛出原始错误，Invidious 失败时仍保留官方 API 的报错
    }
  }
}

/**
 * 获取频道视频（自动处理配额不足回退）
 */
export async function ytGetChannelVideos(
  channelId: string,
  apiKey?: string,
  maxResults = 20
): Promise<VideoMeta[]> {
  if (!apiKey) return invidiousGetChannelVideos(channelId, maxResults);

  const nearLimit = await isQuotaNearLimit().catch(() => false);
  if (nearLimit) {
    setQuotaFallbackActive(true);
    return invidiousGetChannelVideos(channelId, maxResults);
  }

  try {
    return await getChannelLatestVideos(channelId, apiKey, maxResults);
  } catch (e) {
    if (isQuotaError(e)) {
      setQuotaFallbackActive(true);
      console.warn('[YT] 官方 API 配额耗尽，切换 Invidious');
    }
    try {
      return await invidiousGetChannelVideos(channelId, maxResults);
    } catch (e2) {
      throw e;
    }
  }
}

/**
 * 获取视频详情（自动处理配额不足回退）
 */
export async function ytGetVideoDetail(
  videoId: string,
  apiKey?: string
): Promise<VideoMeta> {
  if (!apiKey) return invidiousGetVideoDetail(videoId);

  const nearLimit = await isQuotaNearLimit().catch(() => false);
  if (nearLimit) {
    setQuotaFallbackActive(true);
    return invidiousGetVideoDetail(videoId);
  }

  try {
    const videos = await getVideosDetail([videoId], apiKey);
    return videos[0];
  } catch (e) {
    if (isQuotaError(e)) {
      setQuotaFallbackActive(true);
      console.warn('[YT] 官方 API 配额耗尽，切换 Invidious');
    }
    return invidiousGetVideoDetail(videoId);
  }
}

/**
 * 搜索频道
 * 注意：若 keyword 为频道 ID（UC…），必须用 channels.list，不能用 search?q=UC…（后者常返回空且浪费 100 单位配额）
 */
export async function ytSearchChannels(
  keyword: string,
  apiKey?: string
): Promise<ChannelMeta[]> {
  const q = keyword.trim();
  if (!apiKey) return [];

  if (/^UC[\w-]{22}$/.test(q)) {
    const nearLimit = await isQuotaNearLimit().catch(() => false);
    if (nearLimit) {
      setQuotaFallbackActive(true);
      return [];
    }
    try {
      const ch = await getChannelDetail(q, apiKey);
      return ch ? [ch] : [];
    } catch (e) {
      if (isQuotaError(e)) setQuotaFallbackActive(true);
      return [];
    }
  }

  const nearLimit = await isQuotaNearLimit().catch(() => false);
  if (nearLimit) {
    setQuotaFallbackActive(true);
    return [];
  }

  try {
    return await searchChannels(q, apiKey);
  } catch (e) {
    if (isQuotaError(e)) {
      setQuotaFallbackActive(true);
      console.warn('[YT] 官方 API 配额耗尽');
    }
    return [];
  }
}

// ── 辅助 ──────────────────────────────────────────────────────────────

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export { genId };
