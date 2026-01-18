/**
 * YouTube字幕提取服务
 * 通过Google Apps Script API提取YouTube视频字幕
 */

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
 * @param videoId YouTube视频ID
 * @param gasApiUrl Google Apps Script API URL (用户需要在设置中配置)
 * @returns 字幕文本
 */
export const fetchYouTubeTranscript = async (
  videoId: string,
  gasApiUrl?: string
): Promise<{ success: boolean; transcript?: string; error?: string }> => {
  try {
    console.log(`[YouTubeService] 开始提取视频字幕，视频ID: ${videoId}`);
    
    // 如果用户提供了自己的GAS API URL
    if (gasApiUrl) {
      console.log(`[YouTubeService] 使用用户配置的GAS API: ${gasApiUrl}`);
      
      // 使用 GET 请求（避免 CORS 预检问题）
      const url = `${gasApiUrl}?videoId=${encodeURIComponent(videoId)}`;
      const response = await fetch(url, {
        method: 'GET',
      });
      
      if (!response.ok) {
        throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (data.success && data.transcript) {
        const cleanedTranscript = cleanTranscript(data.transcript);
        console.log(`[YouTubeService] 字幕提取成功，长度: ${cleanedTranscript.length}字`);
        return { success: true, transcript: cleanedTranscript };
      } else {
        throw new Error(data.error || '字幕提取失败');
      }
    }
    
    // 尝试使用默认的公共GAS API（如果用户没有配置）
    // 注意：这里需要替换为实际的公共GAS API URL
    console.log(`[YouTubeService] 未配置GAS API，尝试使用youtube-transcript-api库`);
    
    // 方案1：使用youtube-transcript-api（需要后端支持）
    // 这里提供一个简单的实现，实际需要用户部署自己的后端服务
    const fallbackApiUrl = 'https://your-gas-api-url.com/api/transcript'; // 用户需要替换
    
    try {
      const response = await fetch(fallbackApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ videoId }),
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.transcript) {
          const cleanedTranscript = cleanTranscript(data.transcript);
          return { success: true, transcript: cleanedTranscript };
        }
      }
    } catch (fallbackError) {
      console.warn('[YouTubeService] 公共API调用失败:', fallbackError);
    }
    
    // 如果所有方法都失败，返回错误
    return {
      success: false,
      error: '请在设置中配置您的 Google Apps Script API URL。\n\n请参考文档部署您自己的字幕提取服务。',
    };
    
  } catch (error: any) {
    console.error('[YouTubeService] 字幕提取失败:', error);
    return {
      success: false,
      error: error.message || '字幕提取失败，请检查网络连接或API配置',
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
