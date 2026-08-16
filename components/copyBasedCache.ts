/**
 * v1.10：文案成片页面大块数据（base64 封面 / base64 配音音频）的
 * 模块级缓存层。
 *
 * 背景：
 *   localStorage 上限 5-10 MB，存不进几 MB 的 base64 音频（5 段配音 ≈ 10-30 MB）。
 *   `savePersisted` 会 catch 掉 QuotaExceededError 静默忽略，
 *   导致切走 sub-tab 再切回来时 base64 音频/封面"自动消失"。
 *
 * 设计：
 *   - 内存 cache：`__memoryCovers` / `__memoryTtsResult`，跨组件 mount/unmount 保留
 *   - sessionStorage：跨 tab 路由（切到「多镜头分镜」再回来）保留，
 *     关闭标签页后失效（避免长期累积占内存）
 *   - 优先从内存读 → 命中即返回
 *   - 内存 miss 时从 sessionStorage 读 → 写回内存
 *   - 都 miss 时从 localStorage 读 → 写回内存 + sessionStorage
 *   - 写入时同时更新三个层级（内存 + sessionStorage + localStorage）
 *
 * 注：base64 字符串单个最大 ≈ 30MB（5 段音频），sessionStorage 配额通常 5-10MB，
 *     所以 sessionStorage 仍然可能写失败 —— 但内存 cache 永远有效。
 *     真正跨刷新页面保留依赖 localStorage（已有逻辑 + STORAGE_KEY）。
 */
const COVERS_MEMORY_KEY = '__memory_covers__';
const TTS_MEMORY_KEY = '__memory_tts_result__';
const COVERS_SESSION_KEY = 'COPY_BASED_COVERS_SESSION_V1';
const TTS_SESSION_KEY = 'COPY_BASED_TTS_RESULT_SESSION_V1';

const __memoryCovers: any[] | null = (() => {
  try {
    // 模块级 state 不需要持久化跨页面刷新（关闭 tab 即失效）
    // 跨 mount/unmount 是 React 组件生命周期 → 模块级变量天然保留
    return null;
  } catch {
    return null;
  }
})();

let __memoryCoversCache: any[] | null = null;
let __memoryTtsCache: any | null = null;

/** 写入 / 读取 / 清空 — 文案成片页面用 */
export const copyBasedCache = {
  /**
   * 读取 covers（先内存 → sessionStorage → localStorage）
   */
  getCovers(): any[] | null {
    if (__memoryCoversCache !== null) return __memoryCoversCache;
    try {
      const s = sessionStorage.getItem(COVERS_SESSION_KEY);
      if (s) {
        __memoryCoversCache = JSON.parse(s);
        return __memoryCoversCache;
      }
    } catch {}
    try {
      const l = localStorage.getItem('COPY_BASED_COVERS_LOCAL_V1');
      if (l) {
        __memoryCoversCache = JSON.parse(l);
        // 写回 sessionStorage（QuotaExceededError 时 catch 即可）
        try { sessionStorage.setItem(COVERS_SESSION_KEY, l); } catch {}
        return __memoryCoversCache;
      }
    } catch {}
    return null;
  },

  setCovers(covers: any[]): void {
    __memoryCoversCache = covers;
    const json = JSON.stringify(covers);
    try { sessionStorage.setItem(COVERS_SESSION_KEY, json); } catch {}
    try { localStorage.setItem('COPY_BASED_COVERS_LOCAL_V1', json); } catch {}
  },

  getTtsResult(): any | null {
    if (__memoryTtsCache !== null) return __memoryTtsCache;
    try {
      const s = sessionStorage.getItem(TTS_SESSION_KEY);
      if (s) {
        __memoryTtsCache = JSON.parse(s);
        return __memoryTtsCache;
      }
    } catch {}
    try {
      const l = localStorage.getItem('COPY_BASED_TTS_LOCAL_V1');
      if (l) {
        __memoryTtsCache = JSON.parse(l);
        try { sessionStorage.setItem(TTS_SESSION_KEY, l); } catch {}
        return __memoryTtsCache;
      }
    } catch {}
    return null;
  },

  setTtsResult(tts: any): void {
    __memoryTtsCache = tts;
    const json = JSON.stringify(tts);
    try { sessionStorage.setItem(TTS_SESSION_KEY, json); } catch {}
    try { localStorage.setItem('COPY_BASED_TTS_LOCAL_V1', json); } catch {}
  },

  /** 清空所有缓存（用户点击「重置」时调用） */
  clear(): void {
    __memoryCoversCache = null;
    __memoryTtsCache = null;
    try { sessionStorage.removeItem(COVERS_SESSION_KEY); } catch {}
    try { sessionStorage.removeItem(TTS_SESSION_KEY); } catch {}
    try { localStorage.removeItem('COPY_BASED_COVERS_LOCAL_V1'); } catch {}
    try { localStorage.removeItem('COPY_BASED_TTS_LOCAL_V1'); } catch {}
  },
};