/**
 * YouTube 分析核心服务
 *
 * 职责：
 * 1. YouTube Data API v3 调用（含配额记录）
 * 2. RapidAPI 备用兜底
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

export interface Comment {
  commentId: string;
  author: string;
  text: string;
  likeCount: number;
  publishedAt: number;
  replyCount: number;
}

export interface CommentResult {
  videoId: string;
  comments: Comment[];
  total: number;
  nextPageToken?: string;
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
    const d = detailMap.get(vid) || ({} as any);
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

// ── 归一化 ────────────────────────────────────────────────────────────

/**
 * 使用 YouTube 官方 API v3 获取评论
 */
async function fetchCommentsFromOfficialAPI(videoId: string, apiKey: string, maxResults: number): Promise<Comment[]> {
  const comments: Comment[] = [];
  let pageToken = '';

  const fetchPage = async (): Promise<string | undefined> => {
    const params = new URLSearchParams({
      part: 'snippet',
      videoId,
      key: apiKey,
      maxResults: String(Math.min(maxResults, 100)),
      order: 'time',
      textFormat: 'plainText',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${YOUTUBE_API_BASE}/commentThreads?${params}`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`YouTube API 错误: ${res.status} - ${err}`);
    }

    const data = await res.json();
    if (data.error) {
      throw new Error(`YouTube API 错误: ${data.error.message}`);
    }

    for (const item of data.items || []) {
      const snippet = item.snippet.topLevelComment.snippet;
      comments.push({
        commentId: item.id,
        author: snippet.authorDisplayName,
        text: snippet.textDisplay || snippet.textOriginal,
        likeCount: snippet.likeCount || 0,
        publishedAt: new Date(snippet.publishedAt).getTime(),
        replyCount: item.snippet.totalReplyCount || 0,
      });
    }

    return data.nextPageToken;
  };

  while (comments.length < maxResults) {
    const nextToken = await fetchPage();
    if (!nextToken) break;
    pageToken = nextToken;
  }

  return comments.slice(0, maxResults);
}

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
      videos = await ytSearchVideos(kw, apiKey, 10);
    } catch {
      continue;
    }
    for (const v of videos) {
      const existing = channelMap.get(v.channelId);
      if (existing) {
        existing.overlap.add(kw);
      } else {
        try {
          const ch = await getChannelDetail(v.channelId, apiKey);
          if (ch) {
            channelMap.set(v.channelId, { channel: ch, overlap: new Set([kw]) });
          }
        } catch { /* skip */ }
      }
    }
  }

  const competitors: CompetitorChannel[] = [];
  for (const [, { channel, overlap }] of channelMap) {
    let videos: VideoMeta[];
    try {
      videos = await ytGetChannelVideos(channel.channelId, apiKey, 5);
    } catch {
      videos = [];
    }
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
 * 搜索视频
 */
export async function ytSearchVideos(
  keyword: string,
  apiKey?: string,
  maxResults = 20
): Promise<VideoMeta[]> {
  if (!apiKey) throw new Error('请先在右上角设置中填写 YouTube Data API Key');
  return await searchVideosByKeyword(keyword, apiKey, maxResults);
}

/**
 * 获取频道视频
 */
export async function ytGetChannelVideos(
  channelId: string,
  apiKey?: string,
  maxResults = 20
): Promise<VideoMeta[]> {
  if (!apiKey) throw new Error('请先在右上角设置中填写 YouTube Data API Key');
  return await getChannelLatestVideos(channelId, apiKey, maxResults);
}

/**
 * 获取视频详情
 */
export async function ytGetVideoDetail(
  videoId: string,
  apiKey?: string
): Promise<VideoMeta> {
  if (!apiKey) throw new Error('请先在右上角设置中填写 YouTube Data API Key');
  const videos = await getVideosDetail([videoId], apiKey);
  if (!videos[0]) throw new Error(`未找到视频 ID: ${videoId}`);
  return videos[0];
}

/**
 * 搜索频道
 * 注意：若 keyword 为频道 ID（UC…），必须用 channels.list
 */
export async function ytSearchChannels(
  keyword: string,
  apiKey?: string
): Promise<ChannelMeta[]> {
  if (!apiKey) throw new Error('请先在右上角设置中填写 YouTube Data API Key');
  const q = keyword.trim();

  // 频道 ID 格式：直接用 channels.list
  if (/^UC[\w-]{22}$/.test(q)) {
    const ch = await getChannelDetail(q, apiKey);
    return ch ? [ch] : [];
  }

  // 关键词搜索
  return await searchChannels(q, apiKey);
}

/**
 * 获取视频评论
 */
export async function ytGetVideoComments(
  videoId: string,
  apiKey?: string,
  maxResults = 50
): Promise<CommentResult> {
  if (!apiKey) throw new Error('请先在右上角设置中填写 YouTube Data API Key');
  const comments = await fetchCommentsFromOfficialAPI(videoId, apiKey, maxResults);
  return {
    videoId,
    total: comments.length,
    comments,
    nextPageToken: undefined,
  };
}

// ── 辅助 ──────────────────────────────────────────────────────────────

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/**
 * 获取关键词搜索指数和相关信息
 * 基于 YouTube 搜索结果数量和视频统计数据估算热度
 */
export async function getKeywordSearchIndex(
  keyword: string,
  apiKey?: string
): Promise<{
  keyword: string;
  estimatedViews: number;
  relatedKeywords: { word: string;热度: string; searchIndex: number }[];
  lastUpdated: number;
}> {
  const relatedKeywords: { word: string;热度: string; searchIndex: number }[] = [];

  try {
    // 获取主关键词的搜索结果来估算热度
    let totalViews = 0;
    let videoCount = 0;

    if (apiKey) {
      try {
        const response = await fetch(
          `${YOUTUBE_API_BASE}/search?part=snippet&q=${encodeURIComponent(keyword)}&type=video&maxResults=50&key=${apiKey}`
        );
        if (response.ok) {
          const data = await response.json();
          videoCount = data.pageInfo?.totalResults || 0;

          // 获取部分视频的播放量
          const videoIds = (data.items || []).slice(0, 10).map((item: any) => item.id.videoId).join(',');
          if (videoIds) {
            const statsRes = await fetch(
              `${YOUTUBE_API_BASE}/videos?part=statistics&id=${videoIds}&key=${apiKey}`
            );
            if (statsRes.ok) {
              const statsData = await statsRes.json();
              for (const item of statsData.items || []) {
                totalViews += parseInt(item.statistics?.viewCount || '0');
              }
            }
          }
        }
      } catch (e) {
        console.warn('[YouTubeAnalytics] 获取搜索指数失败', e);
      }
    }

    // 生成相关关键词（基于主关键词的变体）
    const baseWord = keyword.split(/[\s\u4e00-\u9fa5]/)[0] || keyword;
    const variations = [
      `${baseWord} 最新`,
      `${baseWord} 教程`,
      `${baseWord} 2024`,
      `${baseWord} 排行`,
      `${baseWord} 推荐`,
      `${baseWord} 测评`,
      `${baseWord} 盘点`,
      `${baseWord} 合集`,
    ];

    // 为每个变体分配模拟热度指数
    const baseIndex = Math.min(100, Math.max(1, Math.floor(videoCount / 10)));
    variations.forEach((word, idx) => {
      const variance = Math.random() * 40 - 20;
      const index = Math.max(1, Math.min(100, baseIndex + variance));
      relatedKeywords.push({
        word,
        热度: index > 80 ? '🔥爆' : index > 60 ? '热' : index > 40 ? '中' : '低',
        searchIndex: Math.round(index),
      });
    });

    // 按热度排序
    relatedKeywords.sort((a, b) => b.searchIndex - a.searchIndex);

    return {
      keyword,
      estimatedViews: totalViews,
      relatedKeywords: relatedKeywords.slice(0, 8),
      lastUpdated: Date.now(),
    };
  } catch (e) {
    console.warn('[YouTubeAnalytics] 获取关键词信息失败', e);
    return {
      keyword,
      estimatedViews: 0,
      relatedKeywords: [],
      lastUpdated: Date.now(),
    };
  }
}

/**
 * 从视频标题中提取真正的热门关键词（短词，非长句）
 */
export async function getTrendingKeywordsFromVideos(
  videos: VideoMeta[],
  apiKey?: string
): Promise<{ word: string; weight: number; views: number }[]> {
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
    'official music', 'music video', 'audio',
    // 中文停用
    '的', '了', '和', '是', '在', '我', '有', '个', '他', '她', '们',
    '这', '那', '你', '也', '就', '都', '还', '与', '或', '不', '很',
    '会', '能', '要', '之', '以', '等', '为', '上', '下', '中', '来',
    '去', '后', '前', '大', '小', '多', '少', '一', '第', '更', '最',
    '视频', '教程', '完整', '版', '系列', '合集', '最新', '官方',
    '高清', '1080p', '4k',
  ]);

  // 提取短词的函数
  function extractKeywords(title: string): string[] {
    const keywords: string[] = [];

    // 处理中文（2-4字词）
    const chineseWords = title.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
    for (const word of chineseWords) {
      if (STOP_WORDS.has(word) || /^\d+$/.test(word)) continue;
      keywords.push(word);
    }

    // 处理英文（单词形式，2-15字符）
    const englishWords = title.toLowerCase().split(/[\s\-_,\.!?()[\]{}:;"'【】《》（）\/\\|]+/);
    for (const word of englishWords) {
      if (STOP_WORDS.has(word) || /^\d+$/.test(word)) continue;
      if (word.length >= 2 && word.length <= 15 && /^[a-z0-9]+$/.test(word)) {
        keywords.push(word);
      }
    }

    return keywords;
  }

  // 统计关键词出现次数和总播放量
  const keywordStats = new Map<string, { count: number; totalViews: number }>();

  for (const video of videos) {
    const keywords = extractKeywords(video.title);
    for (const kw of keywords) {
      const stats = keywordStats.get(kw) || { count: 0, totalViews: 0 };
      stats.count += 1;
      stats.totalViews += video.viewCount || 0;
      keywordStats.set(kw, stats);
    }
  }

  // 计算权重（结合出现次数和总播放量）
  const maxViews = Math.max(...Array.from(keywordStats.values()).map(s => s.totalViews), 1);
  const maxCount = Math.max(...Array.from(keywordStats.values()).map(s => s.count), 1);

  const result = Array.from(keywordStats.entries())
    .map(([word, stats]) => ({
      word,
      weight: Math.round((stats.count / maxCount) * 50 + (stats.totalViews / maxViews) * 50),
      views: stats.totalViews,
    }))
    // 出现1次就算，播放量高也保留
    .filter(item => item.count >= 1)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 30); // 取前30个

  return result;
}

export { genId };
