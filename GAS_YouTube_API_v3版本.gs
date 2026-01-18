/**
 * Google Apps Script - YouTube 字幕提取服务
 * 使用 YouTube Data API v3（官方API）
 * 
 * ⚠️ 重要说明：
 * YouTube Data API v3 的 captions 端点需要 OAuth 2.0 认证
 * 本代码使用替代方案：通过 API Key 访问公开字幕
 * 
 * 配置步骤：
 * 1. 在 Google Cloud Console 启用 YouTube Data API v3
 * 2. 创建 API 密钥
 * 3. 将 API 密钥填入下方 YOUTUBE_API_KEY 变量
 * 4. 部署为网络应用（权限：任何人）
 */

// ⚠️ 在此处填入您的 YouTube API 密钥
var YOUTUBE_API_KEY = 'YOUR_API_KEY_HERE'; // 替换为您的实际API密钥

// 处理 GET 请求
function doGet(e) {
  try {
    var videoId = '';
    
    if (e && e.parameter && e.parameter.videoId) {
      videoId = e.parameter.videoId;
    }
    
    if (!videoId) {
      var result = {
        success: false,
        error: '请提供 videoId 参数',
        usage: 'URL?videoId=VIDEO_ID'
      };
      
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // 检查API密钥
    if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY === 'YOUR_API_KEY_HERE') {
      var result = {
        success: false,
        error: '未配置 YouTube API 密钥。请在代码中设置 YOUTUBE_API_KEY 变量。',
        guide: '参考 YouTube_API_申请指南.md 获取API密钥'
      };
      
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    var result = extractTranscriptWithApi(videoId);
    
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    var result = {
      success: false,
      error: 'GET 请求失败: ' + error.toString()
    };
    
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// 使用 YouTube Data API v3 提取字幕
function extractTranscriptWithApi(videoId) {
  try {
    Logger.log('========== 使用 YouTube API v3 提取字幕 ==========');
    Logger.log('视频ID: ' + videoId);
    
    // 方法1: 尝试使用官方 API 获取字幕列表
    Logger.log('尝试方法1: YouTube Data API v3');
    var transcript = tryYouTubeDataApi(videoId);
    if (transcript) {
      Logger.log('✅ 方法1 成功！');
      return {
        success: true,
        transcript: transcript,
        videoId: videoId,
        method: 'youtube-data-api-v3',
        length: transcript.length
      };
    }
    Logger.log('❌ 方法1 失败');
    
    // 方法2: 备用方案 - 直接访问timedtext（无需认证）
    Logger.log('尝试方法2: 直接访问timedtext（备用）');
    transcript = tryDirectTimedText(videoId);
    if (transcript) {
      Logger.log('✅ 方法2 成功！');
      return {
        success: true,
        transcript: transcript,
        videoId: videoId,
        method: 'timedtext-fallback',
        length: transcript.length
      };
    }
    Logger.log('❌ 方法2 失败');
    
    // 所有方法都失败
    return {
      success: false,
      error: '未找到字幕。可能原因：\n1) 该视频没有公开字幕\n2) 视频设置为私密或已删除\n3) 需要OAuth认证\n\n💡 建议：手动复制字幕',
      videoId: videoId
    };
    
  } catch (error) {
    Logger.log('❌ 提取失败: ' + error.toString());
    return {
      success: false,
      error: '提取异常: ' + error.toString()
    };
  }
}

// 方法1: 使用 YouTube Data API v3
function tryYouTubeDataApi(videoId) {
  try {
    // 注意：captions 端点需要 OAuth 2.0，这里我们使用 videos 端点获取基本信息
    // 然后尝试访问公开的字幕
    
    // 1. 获取视频信息（确认视频存在且可访问）
    var videoUrl = 'https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=' + 
                    videoId + '&key=' + YOUTUBE_API_KEY;
    
    Logger.log('调用 YouTube API: videos');
    var response = UrlFetchApp.fetch(videoUrl, {
      muteHttpExceptions: true
    });
    
    var statusCode = response.getResponseCode();
    Logger.log('HTTP Status: ' + statusCode);
    
    if (statusCode !== 200) {
      Logger.log('❌ API 调用失败: ' + statusCode);
      return null;
    }
    
    var data = JSON.parse(response.getContentText());
    
    if (!data.items || data.items.length === 0) {
      Logger.log('❌ 视频不存在或不可访问');
      return null;
    }
    
    Logger.log('✓ 视频信息获取成功');
    Logger.log('标题: ' + data.items[0].snippet.title);
    
    // 2. 尝试获取字幕（注意：captions.list 需要 OAuth 2.0）
    // 由于API限制，我们使用备用方法
    Logger.log('⚠️ captions端点需要OAuth认证，使用备用方法...');
    return null;
    
  } catch (error) {
    Logger.log('YouTube Data API 调用失败: ' + error.toString());
    return null;
  }
}

// 方法2: 直接访问 timedtext（备用方案）
function tryDirectTimedText(videoId) {
  try {
    Logger.log('尝试直接访问timedtext...');
    
    // 尝试多种语言
    var langCodes = ['zh-Hans', 'zh-Hant', 'zh-CN', 'zh-TW', 'zh', 'en', 'en-US'];
    
    for (var i = 0; i < langCodes.length; i++) {
      var lang = langCodes[i];
      
      var captionUrl = 'https://www.youtube.com/api/timedtext?v=' + videoId + 
                       '&lang=' + lang + 
                       '&fmt=srv3';
      
      try {
        var response = UrlFetchApp.fetch(captionUrl, {
          muteHttpExceptions: true,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        
        if (response.getResponseCode() === 200) {
          var xml = response.getContentText();
          
          if (xml && xml.length > 100 && xml.indexOf('<text') > -1) {
            Logger.log('✓ 找到字幕: ' + lang);
            var transcript = parseTranscriptXml(xml);
            if (transcript && transcript.length > 50) {
              return transcript;
            }
          }
        }
      } catch (e) {
        // 继续尝试下一个
      }
    }
    
    return null;
    
  } catch (error) {
    Logger.log('直接访问失败: ' + error.toString());
    return null;
  }
}

// 解析字幕 XML
function parseTranscriptXml(xml) {
  try {
    var textPattern = /<text[^>]*>([^<]+)<\/text>/g;
    var matches = [];
    var match;
    
    while ((match = textPattern.exec(xml)) !== null) {
      if (match[1]) {
        var text = decodeHtmlEntities(match[1]);
        matches.push(text);
      }
    }
    
    Logger.log('提取到 ' + matches.length + ' 个文本段');
    
    if (matches.length === 0) {
      return null;
    }
    
    var transcript = matches.join(' ');
    transcript = cleanTranscript(transcript);
    
    Logger.log('✓ 清理后长度: ' + transcript.length);
    
    return transcript;
    
  } catch (error) {
    Logger.log('解析 XML 失败: ' + error.toString());
    return null;
  }
}

// 解码 HTML 实体
function decodeHtmlEntities(text) {
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  return text;
}

// 清理字幕文本
function cleanTranscript(text) {
  if (!text) return '';
  
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/[\r\n]+/g, ' ');
  text = text.replace(/\[[^\]]+\]/g, '');
  text = text.replace(/\s+/g, ' ');
  text = text.trim();
  
  return text;
}

// 测试函数
function testYouTubeApi() {
  Logger.log('测试 YouTube API v3...');
  
  // 检查API密钥
  if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY === 'YOUR_API_KEY_HERE') {
    Logger.log('❌ 请先配置 YOUTUBE_API_KEY');
    return;
  }
  
  Logger.log('API Key: ' + YOUTUBE_API_KEY.substring(0, 10) + '...');
  
  var testVideos = ['dQw4w9WgXcQ', 'UyyjU8fzEYU'];
  
  for (var i = 0; i < testVideos.length; i++) {
    Logger.log('\n========== 测试视频 ' + (i + 1) + ' ==========');
    var result = extractTranscriptWithApi(testVideos[i]);
    Logger.log('结果: ' + JSON.stringify(result));
  }
}
