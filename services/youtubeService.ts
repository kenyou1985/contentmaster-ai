/**
 * YouTube字幕提取服务
 * 通过Google Apps Script API提取YouTube视频字幕
 */

/**
 * 默认 GAS API URL（项目内置）
 * 调用方可通过第二个参数覆盖
 */
export const DEFAULT_GAS_API_URL =
  'https://script.google.com/macros/s/AKfycbylTL8WWoBBcYo5LaXGsIoUiBVxWVFLEcaH4cMuXbnB2UEQ-tsUI6jqYS8tcYT0wxQaqA/exec';

/**
 * 提取YouTube视频ID
 */
export const extractYouTubeVideoId = (url: string): string | null => {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  return null;
};

/**
 * 检测是否为YouTube链接
 */
export const isYouTubeLink = (text: string): boolean => {
  const youtubePatterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
  ];
  return youtubePatterns.some(pattern => pattern.test(text));
};

/**
 * 清理字幕文本（移除时间戳等）
 */
const cleanTranscript = (text: string): string => {
  if (!text) return '';
  
  // 移除时间戳格式 (例如: 0:00, 1:23, 12:34:56)
  let cleaned = text.replace(/\d{1,2}:\d{2}(?::\d{2})?\s*/g, '');
  
  // 移除方括号内的内容 (例如: [音乐], [笑声])
  cleaned = cleaned.replace(/\[[^\]]+\]/g, '');
  
  // 移除多余的空行
  cleaned = cleaned.replace(/\n\s*\n\s*\n+/g, '\n\n');
  
  // 移除行首行尾空白
  cleaned = cleaned.trim();
  
  return cleaned;
};

/**
 * 通过Google Apps Script API提取YouTube字幕
 *
 * 行为：
 *  1. 如果调用方传入 gasApiUrl，优先使用该 URL；
 *  2. 否则使用项目内置的 DEFAULT_GAS_API_URL。
 *
 * @param videoId YouTube视频ID
 * @param gasApiUrl 可选，自定义 GAS API URL（不传则用 DEFAULT_GAS_API_URL）
 * @returns 字幕文本
 */
export const fetchYouTubeTranscript = async (
  videoId: string,
  gasApiUrl?: string
): Promise<{ success: boolean; transcript?: string; error?: string }> => {
  const targetUrl = gasApiUrl || DEFAULT_GAS_API_URL;
  console.log(`[YouTubeService] 使用 GAS API: ${targetUrl}`);

  try {
    console.log(`[YouTubeService] 开始提取视频字幕，视频ID: ${videoId}`);

    // 1. 主路径：调用 GAS API（GET，避免 CORS 预检）
    const url = `${targetUrl}?videoId=${encodeURIComponent(videoId)}`;
    const response = await fetch(url, {
      method: 'GET',
      // GAS 对简单 GET 不要求预检；但保留可读头，方便 GAS 日志
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (data?.success && data?.transcript) {
      const cleanedTranscript = cleanTranscript(data.transcript);
      console.log(`[YouTubeService] 字幕提取成功，长度: ${cleanedTranscript.length}字`);
      return { success: true, transcript: cleanedTranscript };
    }

    // GAS 返回 success=false 时也抛错，给上层统一处理
    throw new Error(data?.error || '字幕提取失败（GAS 返回 success=false）');
  } catch (error: any) {
    console.error('[YouTubeService] 字幕提取失败:', error);
    return {
      success: false,
      error: `${error?.message || '字幕提取失败'}\n\nGAS URL: ${targetUrl}\n如需更换请联系管理员更新 DEFAULT_GAS_API_URL 常量。`,
    };
  }
};

/**
 * 从文本中提取YouTube链接
 */
export const extractYouTubeUrl = (text: string): string | null => {
  const urlPattern = /https?:\/\/(www\.)?(youtube\.com|youtu\.be)[^\s]*/gi;
  const match = text.match(urlPattern);
  return match ? match[0] : null;
};
