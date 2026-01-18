/**
 * Google Apps Script - YouTube 字幕提取服务
 * ✅ 改进版本 - 增强日志和错误处理
 * ✅ 使用多种方法尝试提取字幕
 * 
 * 部署步骤：
 * 1. 复制此代码到 Google Apps Script
 * 2. 点击"保存"
 * 3. 点击"部署" -> "管理部署" -> "编辑"
 * 4. 版本：选择"新版本"
 * 5. 点击"部署"
 */

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
        usage: '使用方法: ' + ScriptApp.getService().getUrl() + '?videoId=VIDEO_ID'
      };
      
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // 提取字幕
    var result = extractTranscript(videoId);
    
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    var result = {
      success: false,
      error: 'GET 请求处理失败: ' + error.toString(),
      stack: error.stack
    };
    
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// 处理 POST 请求
function doPost(e) {
  try {
    var requestData = JSON.parse(e.postData.contents);
    var videoId = requestData.videoId;
    
    if (!videoId) {
      var result = {
        success: false,
        error: '缺少 videoId 参数'
      };
      
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    var result = extractTranscript(videoId);
    
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    var result = {
      success: false,
      error: 'POST 请求处理失败: ' + error.toString()
    };
    
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// 提取 YouTube 字幕的核心函数
function extractTranscript(videoId) {
  try {
    Logger.log('========== 开始提取字幕 ==========');
    Logger.log('视频ID: ' + videoId);
    
    // 构建 YouTube 页面 URL
    var url = 'https://www.youtube.com/watch?v=' + videoId;
    Logger.log('YouTube URL: ' + url);
    
    // 获取页面 HTML
    var response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    
    var statusCode = response.getResponseCode();
    Logger.log('HTTP Status: ' + statusCode);
    
    if (statusCode !== 200) {
      return {
        success: false,
        error: 'YouTube 页面访问失败: HTTP ' + statusCode
      };
    }
    
    var html = response.getContentText();
    Logger.log('HTML 长度: ' + html.length);
    
    // 方法1：尝试从 ytInitialPlayerResponse 提取
    Logger.log('尝试方法1: ytInitialPlayerResponse');
    var transcript = extractFromYtInitialPlayerResponse(html, videoId);
    
    if (transcript) {
      Logger.log('✅ 方法1 成功！字幕长度: ' + transcript.length);
      return {
        success: true,
        transcript: transcript,
        videoId: videoId,
        length: transcript.length,
        method: 'ytInitialPlayerResponse'
      };
    }
    
    Logger.log('❌ 方法1 失败，尝试方法2');
    
    // 方法2：尝试从 window["ytInitialPlayerResponse"] 提取
    Logger.log('尝试方法2: window["ytInitialPlayerResponse"]');
    transcript = extractFromWindowYtInitialPlayerResponse(html, videoId);
    
    if (transcript) {
      Logger.log('✅ 方法2 成功！字幕长度: ' + transcript.length);
      return {
        success: true,
        transcript: transcript,
        videoId: videoId,
        length: transcript.length,
        method: 'window.ytInitialPlayerResponse'
      };
    }
    
    Logger.log('❌ 方法2 失败');
    
    // 所有方法都失败
    return {
      success: false,
      error: '未找到字幕。可能原因：\n1) 该视频没有字幕\n2) 字幕被禁用\n3) YouTube 页面结构已更改\n4) 需要登录才能查看',
      debug: {
        videoId: videoId,
        htmlLength: html.length,
        hasYtInitialPlayerResponse: html.indexOf('ytInitialPlayerResponse') > -1,
        hasWindowYtInitialPlayerResponse: html.indexOf('window["ytInitialPlayerResponse"]') > -1
      }
    };
    
  } catch (error) {
    Logger.log('❌ 提取字幕时出错: ' + error.toString());
    return {
      success: false,
      error: '字幕提取异常: ' + error.toString(),
      stack: error.stack
    };
  }
}

// 方法1：从 ytInitialPlayerResponse = {...}; 提取
function extractFromYtInitialPlayerResponse(html, videoId) {
  try {
    // 尝试多种正则模式
    var patterns = [
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});/,
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*var/,
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*if/,
      /ytInitialPlayerResponse\s*=\s*(\{[^;]+\});/
    ];
    
    for (var i = 0; i < patterns.length; i++) {
      Logger.log('尝试正则模式 ' + (i + 1));
      var match = html.match(patterns[i]);
      
      if (match && match[1]) {
        Logger.log('✓ 正则匹配成功，JSON 长度: ' + match[1].length);
        return parsePlayerResponse(match[1], videoId);
      }
    }
    
    Logger.log('所有正则模式都未匹配');
    return null;
    
  } catch (error) {
    Logger.log('方法1 错误: ' + error.toString());
    return null;
  }
}

// 方法2：从 window["ytInitialPlayerResponse"] = {...}; 提取
function extractFromWindowYtInitialPlayerResponse(html, videoId) {
  try {
    var pattern = /window\["ytInitialPlayerResponse"\]\s*=\s*(\{.+?\});/;
    var match = html.match(pattern);
    
    if (match && match[1]) {
      Logger.log('✓ window["ytInitialPlayerResponse"] 匹配成功');
      return parsePlayerResponse(match[1], videoId);
    }
    
    return null;
    
  } catch (error) {
    Logger.log('方法2 错误: ' + error.toString());
    return null;
  }
}

// 解析 playerResponse JSON 并提取字幕
function parsePlayerResponse(jsonString, videoId) {
  try {
    Logger.log('开始解析 JSON...');
    var playerResponse = JSON.parse(jsonString);
    Logger.log('✓ JSON 解析成功');
    
    // 检查字幕数据
    if (!playerResponse.captions) {
      Logger.log('❌ 没有 captions 字段');
      return null;
    }
    
    Logger.log('✓ 找到 captions');
    
    if (!playerResponse.captions.playerCaptionsTracklistRenderer) {
      Logger.log('❌ 没有 playerCaptionsTracklistRenderer');
      return null;
    }
    
    Logger.log('✓ 找到 playerCaptionsTracklistRenderer');
    
    if (!playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks) {
      Logger.log('❌ 没有 captionTracks');
      return null;
    }
    
    var captionTracks = playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
    Logger.log('✓ 找到 captionTracks，数量: ' + captionTracks.length);
    
    if (captionTracks.length === 0) {
      Logger.log('❌ captionTracks 为空');
      return null;
    }
    
    // 选择字幕轨道
    var selectedTrack = selectCaptionTrack(captionTracks);
    
    if (!selectedTrack) {
      Logger.log('❌ 无法选择字幕轨道');
      return null;
    }
    
    Logger.log('✓ 选择字幕轨道: ' + selectedTrack.languageCode);
    
    // 获取字幕内容
    var captionUrl = selectedTrack.baseUrl;
    
    if (!captionUrl) {
      Logger.log('❌ 字幕 URL 为空');
      return null;
    }
    
    // 修复：如果是相对路径，补充完整域名
    if (captionUrl.indexOf('http') !== 0) {
      captionUrl = 'https://www.youtube.com' + captionUrl;
      Logger.log('✓ 补充完整URL');
    }
    
    Logger.log('字幕 URL: ' + captionUrl.substring(0, 100) + '...');
    
    // 下载字幕
    var transcript = downloadAndParseCaption(captionUrl);
    
    return transcript;
    
  } catch (error) {
    Logger.log('❌ 解析 playerResponse 失败: ' + error.toString());
    return null;
  }
}

// 选择字幕轨道（优先中文）
function selectCaptionTrack(captionTracks) {
  // 优先选择中文字幕
  for (var i = 0; i < captionTracks.length; i++) {
    var track = captionTracks[i];
    if (track.languageCode) {
      var langCode = track.languageCode.toLowerCase();
      if (langCode.indexOf('zh') === 0 || langCode.indexOf('cn') > -1) {
        Logger.log('找到中文字幕: ' + track.languageCode);
        return track;
      }
    }
  }
  
  // 否则选择第一个
  Logger.log('使用第一个字幕轨道: ' + captionTracks[0].languageCode);
  return captionTracks[0];
}

// 下载并解析字幕
function downloadAndParseCaption(captionUrl) {
  try {
    Logger.log('开始下载字幕...');
    
    var response = UrlFetchApp.fetch(captionUrl, {
      muteHttpExceptions: true
    });
    
    var statusCode = response.getResponseCode();
    Logger.log('字幕下载 HTTP Status: ' + statusCode);
    
    if (statusCode !== 200) {
      Logger.log('❌ 字幕下载失败: HTTP ' + statusCode);
      return null;
    }
    
    var captionXml = response.getContentText();
    Logger.log('✓ 字幕 XML 长度: ' + captionXml.length);
    
    // 解析 XML
    var transcript = parseTranscriptXml(captionXml);
    
    if (transcript) {
      Logger.log('✓ 字幕解析成功，长度: ' + transcript.length);
    } else {
      Logger.log('❌ 字幕解析失败');
    }
    
    return transcript;
    
  } catch (error) {
    Logger.log('❌ 下载字幕失败: ' + error.toString());
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
    
    return transcript;
    
  } catch (error) {
    Logger.log('❌ 解析 XML 失败: ' + error.toString());
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
  
  // 移除多余的空格和换行
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/[\r\n]+/g, ' ');
  
  // 移除方括号内的内容（如 [音乐]）
  text = text.replace(/\[[^\]]+\]/g, '');
  
  // 移除多余的空格
  text = text.replace(/\s+/g, ' ');
  
  // 去除首尾空格
  text = text.trim();
  
  return text;
}
