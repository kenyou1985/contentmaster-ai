/**
 * v10.6 抖音文案提取适配器
 *
 * 策略：
 *   1) 先嗅探 URL 类型：
 *      - 短链 v.douyin.com/xxx：fetch 跟随 redirect 拿 302 Location
 *        → 提取 aweme_id（从 Location 的 query string `?modal_id=...` 或 path `/video/{id}`）
 *      - 长链 www.iesdouyin.com/share/video/{id} 或 www.douyin.com/video/{id}
 *        → 直接拿 aweme_id
 *   2) 通过现有 dev proxy `/api/douyin-proxy?url=...` 抓
 *      `https://www.iesdouyin.com/share/video/{id}/` 页面 HTML
 *   3) 从 HTML 中解析 `window._ROUTER_DATA = {...}` → 拿到 aweme 对象
 *      - 优先取 `aweme.desc`（作者手写文案，90% 短视频都有）
 *      - 若 desc 为空，则取 `aweme.video.play_addr.url_list[0]` 视频直链
 *        → 通过 `/api/video-proxy` 下载视频 → 用 ffmpeg.wasm 抽音频
 *        → 调 Whisper ASR 转文字
 *   4) 返回 ExtractResult
 *
 * CORS：
 *   - iesdouyin.com 浏览器 fetch 通常允许 CORS（HTML 端）
 *   - aweme.snssdk.com 视频直链防盗链 → 必须走后端 proxy
 */

import type {
  ExtractOptions,
  ExtractResult,
  IScriptExtractor,
} from '../types';
import { ExtractError } from '../types';
import { transcribeAudio } from '../../localAsrService';
import { extractAudioFromVideo } from '../../audioExtractor';

const PROXY_BASE_DEFAULT = '/api';

/**
 * v10.6.2 真实可行性说明：
 *   - 抖音现代页面（SPA）在 SSR HTML 中只渲染骨架（_ROUTER_DATA 里只有
 *     metadata：ua / webId / itemId / commonContext），不在 SSR 里携带
 *     aweme.desc / aweme.video.play_addr
 *   - 真正的 desc / play_addr 走前端 SDK + a_bogus 签名 + msToken XHR 异步
 *     加载（`/aweme/v1/web/aweme/detail/`），无法在浏览器直接抓取
 *   - 因此 SSR 路径只能拿到 metadata，desc 通常为空
 *
 * 务实策略：
 *   1) 尽量从 SSR / <meta> / <title> / og:description 拿"作者手写文案"
 *      （90% 情况拿不到，2026 抖音 SSR 已不内嵌）
 *   2) 拿不到时 → 抛 NEEDS_VIDEO_FILE，UI 捕获后弹出文件选择器
 *      让用户上传抖音视频 → 走 audioExtractor + Whisper ASR 全链路
 */

/** 1) 嗅探链接，提取 aweme_id（如果识别为抖音） */
function sniffDouyinId(input: string): string | null {
  const raw = (input || '').trim();
  if (!raw) return null;

  // 形式 1：长链 www.iesdouyin.com/share/video/{id}
  let m = raw.match(/iesdouyin\.com\/share\/video\/(\d+)/);
  if (m) return m[1];

  // 形式 2：长链 www.douyin.com/video/{id}
  m = raw.match(/(?:www\.)?douyin\.com\/video\/(\d+)/);
  if (m) return m[1];

  // 形式 3：modal_id=xxx（分享 modal 形式）
  m = raw.match(/modal_id=(\d+)/);
  if (m) return m[1];

  // 形式 4：短链 v.douyin.com/xxxxx（无法直接嗅探 id，需要 GET 跟随 redirect）
  if (/v\.douyin\.com\//.test(raw)) return '__short__';

  // 形式 5：m.iesdouyin.com 移动端分享
  m = raw.match(/m\.iesdouyin\.com\/share\/video\/(\d+)/);
  if (m) return m[1];

  return null;
}

/** 2) 跟随短链 redirect 拿长链 */
async function followShortUrl(shortUrl: string, proxyBase: string): Promise<string> {
  // 通过后端 fetch 跟随 redirect（避免浏览器 CORS）
  const r = await fetch(`${proxyBase}/douyin-proxy?url=${encodeURIComponent(shortUrl)}`, {
    redirect: 'follow',
    method: 'GET',
  });
  // 拿最终 URL（x-final-url 是我们 proxy 自己设的）
  const finalUrl = r.headers.get('x-final-url') || r.url;
  if (!finalUrl) {
    throw new ExtractError('FETCH_FAILED', '短链跳转失败，无法获取真实链接');
  }
  return finalUrl;
}

/** 3) 从 iesdouyin HTML 解析 _ROUTER_DATA JSON */
function parseRouterData(html: string): any {
  // _ROUTER_DATA 可能在 script 标签里，可能是 JSON 字面量（未转义）
  // 兼容三种形式：
  //   a) <script>window._ROUTER_DATA = {...}</script>
  //   b) <script>self.__routify__ = {...}</script>
  //   c) JSON 内嵌在 script 标签

  // 形式 a / b：寻找赋值语句
  const patterns = [
    /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\});/,
    /self\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\});/,
    /_ROUTER_DATA\s*=\s*(\{[\s\S]*?\});/,
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        // 解析失败，尝试宽松解析（去掉 undefined）
        try {
          // eslint-disable-next-line no-new-func
          return new Function('return ' + m[1])();
        } catch {
          // 继续下一个 pattern
        }
      }
    }
  }
  return null;
}

/** 4) 从 _ROUTER_DATA 找到 aweme 信息 */
function findAwemeInRouterData(data: any): any {
  if (!data) return null;
  // _ROUTER_DATA 通常结构：{ loaderData: { "video_(id)/page": { videoInfoRes: { item_list: [...] } } } }
  // 兼容多种 key
  const tryKeys = ['item_list', 'aweme_list', 'aweme_detail', 'itemInfo', 'data'];
  const tryWalk = (obj: any, depth = 0): any => {
    if (!obj || depth > 8) return null;
    if (Array.isArray(obj)) {
      for (const it of obj) {
        const r = tryWalk(it, depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (typeof obj !== 'object') return null;

    // 命中条件：包含 video 字段 + desc 字段
    if (obj.video && (typeof obj.desc === 'string' || obj.desc !== undefined)) {
      return obj;
    }
    // 也接受 title + play_addr
    if (obj.video?.play_addr && (typeof obj.desc === 'string' || obj.title)) {
      return obj;
    }

    for (const key of tryKeys) {
      if (obj[key] !== undefined) {
        const r = tryWalk(obj[key], depth + 1);
        if (r) return r;
      }
    }
    // 遍历所有 key（兜底）
    for (const k of Object.keys(obj)) {
      if (k.startsWith('_')) continue;
      const r = tryWalk(obj[k], depth + 1);
      if (r) return r;
    }
    return null;
  };
  return tryWalk(data);
}

/** 5) 提取视频直链 URL */
function extractVideoUrl(aweme: any): string | null {
  if (!aweme?.video) return null;
  const va = aweme.video.play_addr;
  const candidates: string[] = [];
  if (va?.url_list) candidates.push(...va.url_list);
  if (aweme.video.bit_rate) {
    for (const br of aweme.video.bit_rate) {
      if (br?.play_addr?.url_list) candidates.push(...br.play_addr.url_list);
    }
  }
  // 抖音直链通常带 playwm（水印）后缀，去掉得到无水印版本
  for (const u of candidates) {
    if (!u) continue;
    if (u.includes('playwm')) return u.replace(/playwm/g, 'play');
    return u;
  }
  return null;
}

export const douyinExtractor: IScriptExtractor = {
  platform: 'douyin',

  detectUrl(input: string): string | null {
    return sniffDouyinId(input);
  },

  async extractScript(input: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
    const proxyBase = opts.proxyBase || PROXY_BASE_DEFAULT;
    let id = sniffDouyinId(input);
    if (!id) {
      throw new ExtractError('UNSUPPORTED_URL', '不是有效的抖音链接');
    }

    // 短链 → follow redirect 拿长链
    if (id === '__short__') {
      const finalUrl = await followShortUrl(input, proxyBase);
      id = sniffDouyinId(finalUrl);
      if (!id || id === '__short__') {
        throw new ExtractError('INVALID_URL', `短链跳转后仍无法解析 ID：${finalUrl}`);
      }
    }

    // 抓 iesdouyin 页面 HTML
    const shareUrl = `https://www.iesdouyin.com/share/video/${id}/`;
    let html: string;
    try {
      const r = await fetch(`${proxyBase}/douyin-proxy?url=${encodeURIComponent(shareUrl)}`, {
        method: 'GET',
      });
      if (!r.ok) {
        throw new ExtractError('FETCH_FAILED', `抓取抖音页面失败 HTTP ${r.status}`);
      }
      html = await r.text();
    } catch (e: any) {
      if (e instanceof ExtractError) throw e;
      throw new ExtractError('FETCH_FAILED', `网络错误：${e?.message || String(e)}`);
    }

    const routerData = parseRouterData(html);
    if (!routerData) {
      // SSR 数据缺失（典型 2026 抖音 SPA 行为）
      throw new ExtractError(
        'NEEDS_VIDEO_FILE',
        '抖音 SSR 已不再内嵌作者文案与视频直链。请上传抖音视频文件（mp4/mov），将走 ASR 转写。',
      );
    }

    const aweme = findAwemeInRouterData(routerData);
    if (!aweme) {
      throw new ExtractError(
        'NEEDS_VIDEO_FILE',
        '抖音 SSR 未携带作者文案（2026 SPA 行为）。请上传抖音视频文件，将走 ASR 转写。',
      );
    }

    const desc = (aweme.desc || '').trim();
    const title = (aweme.title || aweme.share_title || '').trim();

    // 策略 1：作者手写文案
    if (desc && desc.length >= 4) {
      return {
        platform: 'douyin',
        text: title ? `${title}\n\n${desc}` : desc,
        title: title || undefined,
        source: 'author-desc',
        raw: { id, hasVideo: !!extractVideoUrl(aweme) },
      };
    }

    // 策略 2：作者没写文案 → 走 ASR
    const videoUrl = extractVideoUrl(aweme);
    if (!videoUrl) {
      // SSR 找不到 video url（抖音 2026 典型行为），提示用户上传文件
      throw new ExtractError(
        'NEEDS_VIDEO_FILE',
        '未找到视频直链。请上传抖音视频文件，将走 ASR 转写。',
      );
    }
    if (!opts.asrBase) {
      throw new ExtractError('NO_CONTENT', '该视频无作者文案，且 ASR 服务未配置');
    }

    return await transcribeDouyinVideo(videoUrl, title, opts, id);
  },
};

/**
 * v10.6.2 新增：当 douyin 抛 NEEDS_VIDEO_FILE 时，UI 调用此函数
 * 直接对用户上传的 File 对象做 ASR → Whisper 转写
 */
export async function transcribeVideoFile(
  file: File,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  // 抽音 → 16kHz mono WAV
  let wavBlob: Blob;
  try {
    wavBlob = await extractAudioFromVideo(file, { targetSampleRate: 16000, targetChannels: 1 });
  } catch (e: any) {
    throw new ExtractError('PARSE_FAILED', `音频提取失败：${e?.message || String(e)}`);
  }

  // 调 Whisper ASR
  const asrResult = await transcribeAudio(
    await blobToDataUrl(wavBlob),
    file.name.replace(/\.[^.]+$/, '') + '.wav',
  );
  if (!asrResult.ok) {
    throw new ExtractError('ASR_FAILED', asrResult.error || 'ASR 返回失败状态');
  }
  const cleaned = (asrResult.text || '').trim();
  if (!cleaned) {
    throw new ExtractError('NO_CONTENT', 'ASR 未识别出有效文字');
  }
  return {
    platform: 'douyin',
    text: cleaned,
    source: 'asr',
    suspicious: cleaned.length < 8,
    raw: { filename: file.name, size: file.size },
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/** 6) 视频下载 → 抽音 → Whisper ASR */
async function transcribeDouyinVideo(
  videoUrl: string,
  title: string,
  opts: ExtractOptions,
  id: string,
): Promise<ExtractResult> {
  const proxyBase = opts.proxyBase || PROXY_BASE_DEFAULT;

  // 下载视频（用 proxy 解决防盗链）
  const videoResp = await fetch(`${proxyBase}/video-proxy?url=${encodeURIComponent(videoUrl)}`);
  if (!videoResp.ok) {
    throw new ExtractError('FETCH_FAILED', `下载视频失败 HTTP ${videoResp.status}`);
  }
  const videoBlob = await videoResp.blob();
  if (videoBlob.size < 1024) {
    throw new ExtractError('FETCH_FAILED', '下载的视频文件过小，可能被防盗链拦截');
  }

  // 抽音 → 16kHz mono WAV
  let wavBlob: Blob;
  try {
    // videoBlob → File（extractAudioFromVideo 接受 File 类型）
    const videoFile = new File([videoBlob], `douyin-${id}.mp4`, { type: videoBlob.type || 'video/mp4' });
    wavBlob = await extractAudioFromVideo(videoFile, { targetSampleRate: 16000, targetChannels: 1 });
  } catch (e: any) {
    throw new ExtractError('PARSE_FAILED', `音频提取失败：${e?.message || String(e)}`);
  }

  // 转 data: URL → 调 Whisper ASR
  const dataUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(wavBlob);
  });

  let asrText: string;
  try {
    const asrResult = await transcribeAudio(dataUrl, `douyin-${id}.wav`);
    asrText = asrResult.text || '';
    if (!asrResult.ok) {
      throw new ExtractError('ASR_FAILED', asrResult.error || 'ASR 返回失败状态');
    }
  } catch (e: any) {
    if (e instanceof ExtractError) throw e;
    throw new ExtractError('ASR_FAILED', `ASR 识别失败：${e?.message || String(e)}`);
  }

  const cleaned = (asrText || '').trim();
  if (!cleaned) {
    throw new ExtractError('NO_CONTENT', 'ASR 未识别出有效文字');
  }

  return {
    platform: 'douyin',
    text: title ? `${title}\n\n${cleaned}` : cleaned,
    title: title || undefined,
    source: 'asr',
    suspicious: cleaned.length < 8,
    raw: { id, videoUrl },
  };
}