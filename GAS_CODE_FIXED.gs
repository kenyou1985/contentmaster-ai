/**
 * YouTube 字幕提取 API
 * Google Apps Script 兼容版本
 */

/**
 * 处理 POST 请求
 */
function doPost(e) {
  try {
    var requestData = JSON.parse(e.postData.contents);
    var videoId = requestData.videoId;
    
    if (!videoId) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: '缺少 videoId 参数'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    var transcript = getYouTubeTranscript(videoId);
    
    if (transcript) {
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        transcript: transcript
      })).setMimeType(ContentService.MimeType.JSON);
    } else {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: '无法提取字幕，请检查视频是否有字幕'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
  } catch (error) {
    Logger.log('Error: ' + error.toString());
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: '服务器错误: ' + error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * 处理 GET 请求（用于测试）
 */
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    service: 'YouTube Transcript API',
    version: '1.0',
    status: 'running'
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 提取 YouTube 视频字幕
 */
function getYouTubeTranscript(videoId) {
  try {
    var url = 'https://www.youtube.com/watch?v=' + videoId;
    var response = UrlFetchApp.fetch(url);
    var html = response.getContentText();
    
    var captionMatch = html.match(/"captionTracks":\[(.*?)\]/);
    
    if (!captionMatch) {
      Logger.log('未找到字幕');
      return null;
    }
    
    var captionsData = JSON.parse('[' + captionMatch[1] + ']');
    
    if (captionsData.length === 0) {
      Logger.log('字幕列表为空');
      return null;
    }
    
    var captionUrl = captionsData[0].baseUrl;
    var captionResponse = UrlFetchApp.fetch(captionUrl);
    var captionXml = captionResponse.getContentText();
    var transcript = parseTranscriptXml(captionXml);
    
    return transcript;
    
  } catch (error) {
    Logger.log('提取字幕时出错: ' + error.toString());
    return null;
  }
}

/**
 * 解析字幕 XML
 */
function parseTranscriptXml(xml) {
  try {
    var text = xml.replace(/<[^>]+>/g, '');
    
    text = text.replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>')
               .replace(/&quot;/g, '"')
               .replace(/&#39;/g, "'")
               .replace(/&nbsp;/g, ' ');
    
    text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');
    text = text.trim();
    
    return text;
    
  } catch (error) {
    Logger.log('解析字幕 XML 时出错: ' + error.toString());
    return '';
  }
}

/**
 * 测试函数
 */
function testTranscriptExtraction() {
  var videoId = 'dQw4w9WgXcQ';
  var transcript = getYouTubeTranscript(videoId);
  Logger.log('字幕内容:');
  Logger.log(transcript);
}
