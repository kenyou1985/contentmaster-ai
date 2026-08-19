/**
 * v10.6 链接一键提取文案 — 类型定义
 *
 * 适配器模式核心接口：
 *   - detectUrl(input): 嗅探当前平台是否匹配；返回 null 则不处理
 *   - extractScript(input, opts): 从链接提取文案
 *
 * 多平台扩展：
 *   - 新增平台只需在 adapters/ 下加一个文件，实现 IScriptExtractor
 *   - 在 index.ts 的 ADAPTERS 数组中注册即可
 */

export type Platform = 'douyin' | 'toutiao' | string;

export interface ExtractOptions {
  /**
   * 复用项目现有 Whisper ASR 服务的 base URL
   * 默认走 VITE_REMITION_API_BASE（Railway 部署的 ASR 服务）
   */
  asrBase?: string;

  /**
   * Vite dev proxy 的 base（前缀 /api）
   * 默认 '/api'
   */
  proxyBase?: string;

  /**
   * abort signal（用户取消时调用）
   */
  signal?: AbortSignal;
}

export interface ExtractResult {
  platform: Platform;
  /** 文案正文（用于填入 inputVal） */
  text: string;
  /** 可选标题（部分平台 SSR 会带） */
  title?: string;
  /** 文案来源：author-desc（作者手写）/ asr（自动转写）/ article（文章页 SSR） */
  source: 'author-desc' | 'asr' | 'article' | 'fallback';
  /** 警告：文案 < 8 字时被标记为 suspicious，便于上层提示 */
  suspicious?: boolean;
  /** 原始 payload，便于排查 */
  raw?: unknown;
}

export class ExtractError extends Error {
  code:
    | 'UNSUPPORTED_URL'
    | 'INVALID_URL'
    | 'FETCH_FAILED'
    | 'PARSE_FAILED'
    | 'ASR_FAILED'
    | 'NO_CONTENT';
  constructor(code: ExtractError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'ExtractError';
  }
}

export interface IScriptExtractor {
  /** 平台名 */
  readonly platform: Platform;
  /** 嗅探 URL，返回匹配的特征字符串（如视频 ID） */
  detectUrl(input: string): string | null;
  /** 提取文案 */
  extractScript(input: string, opts?: ExtractOptions): Promise<ExtractResult>;
}