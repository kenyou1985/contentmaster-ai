/**
 * Invidious 上游列表与请求策略（供 api/invidious 与 vite 开发代理共用）。
 * 部分公共实例对数据中心 IP 返回 403（OpenResty）；使用常见浏览器头并支持多实例回退。
 */

export const INVIDIOUS_FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** 单次上游请求超时（毫秒）。Hobby 函数约 10s 上限，串行多实例时总时长须低于该限制 */
export const INVIDIOUS_UPSTREAM_FETCH_MS = 2200;

/** 最多尝试的上游数量（主站 + 备用），避免总等待超过 Serverless 时限 */
export const INVIDIOUS_MAX_UPSTREAMS = 4;

type EnvLike = Record<string, string | undefined>;

/** 解析上游根地址列表（无末尾斜杠） */
export function listInvidiousUpstreamBases(env: EnvLike): string[] {
  const urlsEnv = env.INVIDIOUS_UPSTREAM_URLS?.trim();
  if (urlsEnv) {
    return urlsEnv
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean)
      .slice(0, INVIDIOUS_MAX_UPSTREAMS);
  }
  const primary = (env.INVIDIOUS_UPSTREAM_URL || 'https://invidious.projectsegfau.lt').replace(/\/$/, '');
  const extra =
    env.INVIDIOUS_UPSTREAM_FALLBACKS?.split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean) ?? [];
  const merged = [...new Set([primary, ...extra])];
  return merged.slice(0, INVIDIOUS_MAX_UPSTREAMS);
}

function looksLikeJsonBody(contentType: string, bodyUtf8Prefix: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes('application/json') || ct.includes('json')) return true;
  const p = bodyUtf8Prefix.trimStart();
  return p.startsWith('{') || p.startsWith('[');
}

/** 是否应换下一个上游重试 */
export function shouldTryNextInvidiousUpstream(
  status: number,
  contentType: string,
  bodyUtf8Prefix: string,
  hasMore: boolean
): boolean {
  if (!hasMore) return false;
  if (status >= 500) return true;
  if ([401, 403, 404, 429, 502, 503, 504].includes(status)) return true;
  if (status >= 200 && status < 300 && !looksLikeJsonBody(contentType, bodyUtf8Prefix)) return true;
  return false;
}
