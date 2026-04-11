/**
 * YouTubeAPI23 (RapidAPI) 服务封装
 *
 * 文档：https://rapidapi.com/miketheminer96/api/youtubeapi23
 *
 * 实际支持的端点（根据 RapidAPI Playground 测试）：
 * - GET /search?q=关键词&maxResults=20 - 搜索视频
 * - GET /channel?id=UCxxx - 获取频道信息
 *
 * 以下端点返回 404，不存在：
 * - /channel-videos
 * - /video
 * - /trending
 * - /related
 * - /comments
 * - /channel-search
 */

// ── 类型定义 ────────────────────────────────────────────────────────────

export interface RapidChannelMeta {
  channelId: string;
  title: string;
  description?: string;
  thumbnail?: string;
  subscriberCount: number;
  videoCount: number;
  viewCount: number;
  country?: string;
  createdAt?: string;
  fetchedAt: number;
}

export interface RapidVideoMeta {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  thumbnail?: string;
  viewCount: number;
  likeCount?: number;
  commentCount?: number;
  publishedAt: number; // ms timestamp
  duration?: number;   // seconds
  description?: string;
  url: string;
  fetchedAt: number;
}

export interface RapidComment {
  commentId: string;
  author: string;
  authorChannelUrl?: string;
  authorThumbnail?: string;
  text: string;
  publishedAt: number; // ms timestamp
  likeCount: number;
  replyCount: number;
  isReply?: boolean;
  parentCommentId?: string;
}

export interface RapidSearchOptions {
  /** 排序方式：relevance | upload_date | view_count | rating */
  order?: 'relevance' | 'upload_date' | 'view_count' | 'rating';
  /** 视频类型：video | playlist | channel | all */
  type?: 'video' | 'playlist' | 'channel' | 'all';
  /** 时长：any | short (<4m) | medium (4-20m) | long (>20m) */
  duration?: 'any' | 'short' | 'medium' | 'long';
  /** 安全搜索：moderate | none */
  safeSearch?: 'moderate' | 'none';
  /** 最多返回条数（默认 20） */
  maxResults?: number;
}

// ── 配置 ────────────────────────────────────────────────────────────────

const RAPID_API_HOST = 'youtubeapi23.p.rapidapi.com';

/** 从环境变量读取 Key */
function getRapidApiKey(): string {
  const key = (import.meta as any).env?.VITE_RAPIDAPI_KEY || '';
  return key as string;
}

// ── 核心请求 ────────────────────────────────────────────────────────────

async function rapidGet<T>(
  endpoint: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const apiKey = getRapidApiKey();
  if (!apiKey) {
    throw new Error(
      'RapidAPI Key 未配置。请在 .env 中设置 VITE_RAPIDAPI_KEY=你的Key。'
    );
  }

  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      searchParams.set(k, String(v));
    }
  }
  const qs = searchParams.toString();
  const url = `https://${RAPID_API_HOST}${endpoint}${qs ? `?${qs}` : ''}`;

  console.log(`[RapidAPI] GET ${url}`);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-rapidapi-host': RAPID_API_HOST,
      'x-rapidapi-key': apiKey,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = `RapidAPI ${res.status}`;
    if (res.status === 404) {
      msg = `RapidAPI 404: 端点 ${endpoint} 不存在`;
    } else if (res.status === 403) {
      msg = `RapidAPI 403: API Key 无效或权限不足`;
    } else if (res.status === 429) {
      msg = `RapidAPI 429: 请求频率超限`;
    }
    try {
      const json = JSON.parse(text);
      msg = (json as any)?.message || (json as any)?.error || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  return res.json() as Promise<T>;
}

// ── 归一化函数 ─────────────────────────────────────────────────────────

function safeNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseInt(v.replace(/,/g, '')) || 0;
  return 0;
}

function safeStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function normalizeRapidChannel(raw: any): RapidChannelMeta {
  return {
    channelId: safeStr(raw.channelId || raw.id || ''),
    title: safeStr(raw.title || raw.name),
    description: safeStr(raw.description),
    thumbnail: safeStr(
      raw.thumbnail || raw.avatar ||
      raw.thumbnails?.high?.url || raw.thumbnails?.medium?.url || raw.thumbnails?.default?.url
    ),
    subscriberCount: safeNum(
      raw.subscriberCount || raw.subscribers ||
      raw.metrics?.subscriberCount ||
      raw.statistics?.subscriberCount
    ),
    videoCount: safeNum(
      raw.videoCount || raw.totalVideos ||
      raw.metrics?.videoCount ||
      raw.statistics?.videoCount
    ),
    viewCount: safeNum(
      raw.viewCount || raw.views ||
      raw.metrics?.viewCount ||
      raw.statistics?.viewCount
    ),
    country: safeStr(raw.country),
    createdAt: safeStr(raw.createdAt || raw.publishedAt),
    fetchedAt: Date.now(),
  };
}

export function normalizeRapidVideo(raw: any): RapidVideoMeta {
  return {
    videoId: safeStr(raw.videoId || raw.id),
    title: safeStr(raw.title),
    channelId: safeStr(raw.channelId || raw.author?.channelId),
    channelTitle: safeStr(
      raw.channelTitle || raw.author?.name || raw.author?.channelTitle || raw.author
    ),
    thumbnail: safeStr(
      raw.thumbnail || raw.thumbnails?.[0] ||
      raw.thumbnails?.high?.url || raw.thumbnails?.medium?.url ||
      (raw.videoId ? `https://img.youtube.com/vi/${raw.videoId}/hqdefault.jpg` : undefined)
    ),
    viewCount: safeNum(raw.viewCount || raw.views),
    likeCount: safeNum(raw.likeCount || raw.likes),
    commentCount: safeNum(raw.commentCount || raw.comments),
    publishedAt: raw.publishedAt ? new Date(raw.publishedAt).getTime() : (raw.published ? new Date(raw.published).getTime() : Date.now()),
    duration: safeNum(raw.duration || raw.lengthSeconds),
    description: safeStr(raw.description),
    url: raw.videoId ? `https://youtube.com/watch?v=${raw.videoId}` : (raw.url || ''),
    fetchedAt: Date.now(),
  };
}

export function normalizeRapidComment(raw: any): RapidComment {
  return {
    commentId: safeStr(raw.commentId || raw.id),
    author: safeStr(raw.author || raw.authorName || raw.user || raw.name),
    authorChannelUrl: safeStr(raw.authorChannelUrl || raw.authorUrl),
    authorThumbnail: safeStr(raw.authorThumbnail || raw.avatar || raw.authorImage),
    text: safeStr(raw.text || raw.content || raw.comment || raw.body),
    publishedAt: raw.publishedAt ? new Date(raw.publishedAt).getTime() : Date.now(),
    likeCount: safeNum(raw.likeCount || raw.likes || raw.likesCount),
    replyCount: safeNum(raw.replyCount || raw.replies || raw.repliesCount),
    isReply: Boolean(raw.isReply || raw.parentCommentId),
    parentCommentId: safeStr(raw.parentCommentId || raw.parentId),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// API 端点（youtubeapi23 实际支持的）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 搜索视频
 * GET /search?q=关键词&maxResults=20
 */
export async function rapidSearchVideos(
  keyword: string,
  opts: RapidSearchOptions = {}
): Promise<RapidVideoMeta[]> {
  const params: Record<string, string | number> = { q: keyword };
  if (opts.order) params.order = opts.order;
  if (opts.type) params.type = opts.type;
  if (opts.duration) params.duration = opts.duration;
  if (opts.safeSearch) params.safeSearch = opts.safeSearch;
  params.maxResults = opts.maxResults ?? 20;

  const raw = await rapidGet<any>('/search', params);
  
  // youtubeapi23 /search 返回 results 数组
  const items = Array.isArray(raw) ? raw : raw.results || raw.videos || raw.items || [];
  return items.map(normalizeRapidVideo);
}

/**
 * 搜索频道（通过搜索 type=channel）
 * GET /search?q=关键词&type=channel&maxResults=10
 */
export async function rapidSearchChannels(
  keyword: string,
  maxResults = 10
): Promise<RapidChannelMeta[]> {
  const raw = await rapidGet<any>('/search', {
    q: keyword,
    type: 'channel',
    maxResults,
  });

  // 搜索频道类型时返回的是频道对象
  const items = Array.isArray(raw) ? raw : raw.results || raw.channels || raw.items || [];
  
  return items.map((item: any) => normalizeRapidChannel({
    channelId: item.channelId || item.id || '',
    title: item.title || item.channelTitle || item.name || '',
    description: item.description || '',
    thumbnail: item.thumbnail || item.thumbnails?.[0]?.url || '',
    subscriberCount: item.subscriberCount || item.subscribers || 0,
    videoCount: item.videoCount || 0,
    viewCount: item.viewCount || 0,
    country: item.country || '',
  }));
}

/**
 * 获取频道信息（需要频道ID）
 * GET /channel?id=UCxxx
 */
export async function rapidGetChannelDetails(
  opts: { channelId?: string }
): Promise<RapidChannelMeta> {
  if (!opts.channelId) {
    throw new Error('需要提供 channelId');
  }
  const raw = await rapidGet<any>('/channel', { id: opts.channelId });
  return normalizeRapidChannel(raw);
}

// ═══════════════════════════════════════════════════════════════════════════
// 不支持的端点（返回占位函数，避免调用时崩溃）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 获取频道视频列表 - 不支持
 */
export async function rapidGetChannelVideos(
  channelId: string,
  maxResults = 20
): Promise<RapidVideoMeta[]> {
  throw new Error(
    'youtubeapi23 不支持获取频道视频列表。请使用 VITE_YOUTUBE_API_KEY 或其他 API。'
  );
}

/**
 * 获取视频详情 - 不支持
 */
export async function rapidGetVideoDetails(videoId: string): Promise<RapidVideoMeta> {
  throw new Error(
    'youtubeapi23 不支持获取视频详情。请使用 VITE_YOUTUBE_API_KEY 或其他 API。'
  );
}

/**
 * 获取热门视频 - 不支持
 */
export async function rapidGetTrendingVideos(
  region = 'US',
  maxResults = 20
): Promise<RapidVideoMeta[]> {
  throw new Error(
    'youtubeapi23 不支持获取热门视频。请使用 VITE_YOUTUBE_API_KEY 或其他 API。'
  );
}

/**
 * 获取相关视频 - 不支持
 */
export async function rapidGetRelatedVideos(
  videoId: string,
  maxResults = 15
): Promise<RapidVideoMeta[]> {
  throw new Error(
    'youtubeapi23 不支持获取相关视频。请使用 VITE_YOUTUBE_API_KEY 或其他 API。'
  );
}

/**
 * 获取视频评论 - 不支持
 */
export async function rapidGetVideoComments(
  videoId: string,
  maxResults = 50
): Promise<RapidComment[]> {
  throw new Error(
    'youtubeapi23 不支持获取视频评论。请使用 VITE_YOUTUBE_API_KEY 或其他 API。'
  );
}

/**
 * 获取评论回复 - 不支持
 */
export async function rapidGetCommentReplies(
  commentId: string,
  maxResults = 20
): Promise<RapidComment[]> {
  throw new Error(
    'youtubeapi23 不支持获取评论回复。请使用 VITE_YOUTUBE_API_KEY 或其他 API。'
  );
}

/**
 * 获取全部评论 - 不支持
 */
export async function rapidGetAllComments(
  videoId: string,
  topLevelMax = 50,
  replyMaxPerComment = 10
): Promise<{ topLevel: RapidComment[]; total: number }> {
  throw new Error(
    'youtubeapi23 不支持获取评论。请使用 VITE_YOUTUBE_API_KEY 或其他 API。'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 导出（供 youtubeAnalyticsService 使用）
// ═══════════════════════════════════════════════════════════════════════════

export { rapidGet };
