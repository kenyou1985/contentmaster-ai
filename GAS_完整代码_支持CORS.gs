/**
 * Google Apps Script - YouTube 字幕提取服务
 * 支持 GET 和 POST 请求，正确处理 CORS
 * 
 * 部署步骤：
 * 1. 复制此代码到 Google Apps Script
 * 2. 点击"部署" -> "新建部署"
 * 3. 选择类型："网络应用"
 * 4. 说明："YouTube字幕提取API"
 * 5. 执行身份："我"
 * 6. ⚠️ 访问权限：选择"任何人"（这是关键！）
 * 7. 点击"部署"
 * 8. 复制"网络应用网址"
 */

// 处理 GET 请求（用于浏览器直接测试）
function doGet(e) {
  var videoId = '';
  
  // 从 URL 参数获取 videoId
  if (e && e.parameter && e.parameter.videoId) {
    videoId = e.parameter.videoId;
  }
  
  // 如果没有提供 videoId，返回使用说明
  if (!videoId) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: '请提供 videoId 参数',
      usage: '使用方法: ' + ScriptApp.getService().getUrl() + '?videoId=VIDEO_ID',
      example: ScriptApp.getService().getUrl() + '?videoId=UyyjU8fzEYU'
    }))
      .setMimeType(ContentService.MimeType.JSON)
      .setContent(addCorsHeaders());
  }
  
  // 提取字幕
  var result = extractTranscript(videoId);
  
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// 处理 POST 请求（用于前端调用）
function doPost(e) {
  // ⚠️ 关键：添加 CORS 头，允许跨域请求
  var output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  
  try {
    // 解析请求体
    var requestData = JSON.parse(e.postData.contents);
    var videoId = requestData.videoId;
    
    if (!videoId) {
      return output.setContent(JSON.stringify({
        success: false,
        error: '缺少 videoId 参数'
      }));
    }
    
    // 提取字幕
    var result = extractTranscript(videoId);
    
    return output.setContent(JSON.stringify(result));
    
  } catch (error) {
    return output.setContent(JSON.stringify({
      success: false,
      error: '请求解析失败: ' + error.toString()
    }));
  }
}

// 提取 YouTube 字幕的核心函数
function extractTranscript(videoId) {
  try {
    Logger.log('开始提取字幕，视频ID: ' + videoId);
    
    // 构建 YouTube 页面 URL
    var url = 'https://www.youtube.com/watch?v=' + videoId;
    
    // 获取页面 HTML
    var response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (response.getResponseCode() !== 200) {
      return {
        success: false,
        error: 'YouTube 页面访问失败: ' + response.getResponseCode()
      };
    }
    
    var html = response.getContentText();
    
    // 方法1：从 ytInitialPlayerResponse 提取字幕
    var transcript = extractFromYtInitialPlayerResponse(html, videoId);
    
    if (transcript) {
      Logger.log('字幕提取成功，长度: ' + transcript.length);
      return {
        success: true,
        transcript: transcript,
        videoId: videoId
      };
    }
    
    // 如果方法1失败，返回错误
    return {
      success: false,
      error: '未找到字幕数据。可能原因：1) 该视频没有字幕；2) 字幕被禁用；3) 需要登录才能查看'
    };
    
  } catch (error) {
    Logger.log('提取字幕时出错: ' + error.toString());
    return {
      success: false,
      error: '字幕提取异常: ' + error.toString()
    };
  }
}

// 从 ytInitialPlayerResponse 提取字幕
function extractFromYtInitialPlayerResponse(html, videoId) {
  try {
    // 查找 ytInitialPlayerResponse
    var pattern = /ytInitialPlayerResponse\s*=\s*({.+?});/;
    var match = html.match(pattern);
    
    if (!match) {
      Logger.log('未找到 ytInitialPlayerResponse');
      return null;
    }
    
    var playerResponse = JSON.parse(match[1]);
    
    // 提取字幕轨道
    if (!playerResponse.captions || 
        !playerResponse.captions.playerCaptionsTracklistRenderer || 
        !playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks) {
      Logger.log('未找到字幕轨道');
      return null;
    }
    
    var captionTracks = playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
    
    if (captionTracks.length === 0) {
      Logger.log('字幕轨道为空');
      return null;
    }
    
    // 优先选择中文字幕，否则选择第一个字幕
    var selectedTrack = null;
    
    for (var i = 0; i < captionTracks.length; i++) {
      var track = captionTracks[i];
      if (track.languageCode && (track.languageCode.indexOf('zh') === 0 || track.languageCode.indexOf('cn') === 0)) {
        selectedTrack = track;
        break;
      }
    }
    
    if (!selectedTrack) {
      selectedTrack = captionTracks[0];
    }
    
    Logger.log('选择字幕轨道: ' + selectedTrack.languageCode);
    
    // 获取字幕 URL
    var captionUrl = selectedTrack.baseUrl;
    
    if (!captionUrl) {
      Logger.log('字幕 URL 为空');
      return null;
    }
    
    // 下载字幕文件（XML 格式）
    var captionResponse = UrlFetchApp.fetch(captionUrl, {
      muteHttpExceptions: true
    });
    
    if (captionResponse.getResponseCode() !== 200) {
      Logger.log('字幕下载失败: ' + captionResponse.getResponseCode());
      return null;
    }
    
    var captionXml = captionResponse.getContentText();
    
    // 解析 XML 并提取文本
    var transcript = parseTranscriptXml(captionXml);
    
    return transcript;
    
  } catch (error) {
    Logger.log('从 ytInitialPlayerResponse 提取字幕失败: ' + error.toString());
    return null;
  }
}

// 解析字幕 XML
function parseTranscriptXml(xml) {
  try {
    // 提取所有 <text> 标签的内容
    var textPattern = /<text[^>]*>([^<]+)<\/text>/g;
    var matches = [];
    var match;
    
    while ((match = textPattern.exec(xml)) !== null) {
      if (match[1]) {
        // 解码 HTML 实体
        var text = decodeHtmlEntities(match[1]);
        matches.push(text);
      }
    }
    
    if (matches.length === 0) {
      return null;
    }
    
    // 拼接所有文本，用空格分隔
    var transcript = matches.join(' ');
    
    // 清理文本
    transcript = cleanTranscript(transcript);
    
    return transcript;
    
  } catch (error) {
    Logger.log('解析字幕 XML 失败: ' + error.toString());
    return null;
  }
}

// 解码 HTML 实体
function decodeHtmlEntities(text) {
  var entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' '
  };
  
  for (var entity in entities) {
    text = text.replace(new RegExp(entity, 'g'), entities[entity]);
  }
  
  return text;
}

// 清理字幕文本
function cleanTranscript(text) {
  if (!text) return '';
  
  // 移除多余的空格
  text = text.replace(/\s+/g, ' ');
  
  // 移除换行符
  text = text.replace(/[\r\n]+/g, ' ');
  
  // 移除方括号内的内容（如 [音乐]）
  text = text.replace(/\[[^\]]+\]/g, '');
  
  // 移除多余的空格
  text = text.replace(/\s+/g, ' ');
  
  // 去除首尾空格
  text = text.trim();
  
  return text;
}
