/**
 * ContentMaster AI - 轻量 logger
 *
 * 背景：原代码里 `console.log/debug` 大量被 high-frequency 路径调用（如
 * `characterLibraryService` 每次读取都打印两次、`updateShot` 每次写都打两个对象），
 * 渲染期每帧上百条 log，污染 DevTools。
 *
 * 行为：
 * - 默认 level = 'info'，debug / log 全部静默。
 * - URL 上加 `?debug=1`（或 `localStorage.__CM_DEBUG__=1`）临时开启 debug。
 * - 保留 console 原方法以便一键恢复。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

function detectLevel(): LogLevel {
  if (typeof window === 'undefined') return 'info';
  try {
    const ls = window.localStorage?.getItem('__CM_DEBUG__');
    if (ls === '1' || ls === 'true') return 'debug';
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('debug') === '1' || sp.get('debug') === 'true') return 'debug';
  } catch {
    /* ignore */
  }
  return 'info';
}

let currentLevel: LogLevel = detectLevel();

if (typeof window !== 'undefined') {
  (window as any).__CM_LOG_LEVEL__ = currentLevel;
  (window as any).__CM_setLogLevel = (lv: LogLevel) => {
    currentLevel = lv;
    (window as any).__CM_LOG_LEVEL__ = lv;
  };
}

function shouldLog(lv: LogLevel): boolean {
  return LEVEL_ORDER[lv] >= LEVEL_ORDER[currentLevel];
}

export const logger = {
  debug: (...args: unknown[]) => {
    if (shouldLog('debug')) console.debug(...args);
  },
  log: (...args: unknown[]) => {
    if (shouldLog('debug')) console.log(...args);
  },
  info: (...args: unknown[]) => {
    if (shouldLog('info')) console.info(...args);
  },
  warn: (...args: unknown[]) => {
    if (shouldLog('warn')) console.warn(...args);
  },
  error: (...args: unknown[]) => {
    if (shouldLog('error')) console.error(...args);
  },
};
