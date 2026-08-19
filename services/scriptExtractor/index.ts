/**
 * v10.6 链接一键提取文案 — 主入口
 *
 * 适配器调度器：
 *   - 自动嗅探平台
 *   - 调度对应适配器
 *   - 复用现有 Whisper ASR 服务
 *
 * 用法：
 *   import { extractScriptFromUrl } from '@/services/scriptExtractor';
 *   const result = await extractScriptFromUrl(inputVal);
 *   setInputVal(result.text);
 */

import { douyinExtractor } from './adapters/douyin';
import { toutiaoExtractor } from './adapters/toutiao';
import type { ExtractOptions, ExtractResult } from './types';
import { ExtractError, type IScriptExtractor } from './types';

/** 所有适配器注册表 */
export const ADAPTERS: IScriptExtractor[] = [douyinExtractor, toutiaoExtractor];

/** 嗅探第一个匹配的适配器 */
export function detectAdapter(input: string): IScriptExtractor | null {
  for (const adapter of ADAPTERS) {
    if (adapter.detectUrl(input)) return adapter;
  }
  return null;
}

/**
 * 默认 ASR base URL：
 *   - 本地 dev：/api/remotion（vite proxy → 本地 18093 ASR 服务）
 *   - 线上 prod：VITE_REMITION_API_BASE（Railway）
 */
function defaultAsrBase(): string {
  // 1) Vite 注入的环境变量
  // @ts-ignore
  const envBase = import.meta.env?.VITE_REMITION_API_BASE as string | undefined;
  if (envBase && envBase.trim()) return envBase.replace(/\/$/, '');

  // 2) 兜底：相对路径（同源部署时）
  return '/api/remotion';
}

/**
 * 主入口：从链接提取文案
 * @param input 用户输入的 URL 或分享文案（含 URL 的一段文字）
 * @param opts  可选：自定义 ASR base、proxy base
 */
export async function extractScriptFromUrl(
  input: string,
  opts?: ExtractOptions,
): Promise<ExtractResult> {
  const finalOpts: ExtractOptions = {
    asrBase: opts?.asrBase ?? defaultAsrBase(),
    proxyBase: opts?.proxyBase ?? '/api',
    signal: opts?.signal,
  };

  // 先从分享文案中提取 URL（用户可能粘贴的是「文案 + 链接」整段分享文字）
  const url = extractFirstUrl(input);
  const target = url || input;

  const adapter = detectAdapter(target);
  if (!adapter) {
    throw new ExtractError(
      'UNSUPPORTED_URL',
      '不支持的链接，目前支持：抖音 / 今日头条',
    );
  }

  return adapter.extractScript(target, finalOpts);
}

/**
 * 从字符串中提取第一个 URL（http / https 链接）
 */
function extractFirstUrl(input: string): string | null {
  const m = (input || '').match(/https?:\/\/[^\s\u4e00-\u9fff"']+/);
  return m ? m[0] : null;
}

/** 重新导出类型，方便上层 import */
export { ExtractError } from './types';
export type {
  ExtractOptions,
  ExtractResult,
  IScriptExtractor,
  Platform,
} from './types';