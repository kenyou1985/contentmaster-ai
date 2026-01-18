/**
 * Google Apps Script - YouTube 字幕提取服务
 * ✅ 终极版本 - 使用多种方法提取字幕
 * 
 * 方法列表：
 * 1. ytInitialPlayerResponse 变量
 * 2. window["ytInitialPlayerResponse"]
 * 3. 直接访问字幕 API（timedtext）
 * 4. 从视频页面提取字幕URL
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
        usage: '使用方法: URL?videoId=VIDEO_ID'
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
      error: 'GET 请求失败: ' + error.toString()
    };
    
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// 提取字幕核心函数
function extractTranscript(videoId) {
  try {
    Logger.log('========== 开始提取字幕 ==========');
    Logger.log('视频ID: ' + videoId);
    
    // 方法1：尝试直接访问 YouTube 的字幕 API（timedtext）
    Logger.log('尝试方法1: 直接访问字幕 API');
    var transcript = tryTimedTextApi(videoId);
    if (transcript) {
      Logger.log('✅ 方法1 成功！');
      return {
        success: true,
        transcript: transcript,
        videoId: videoId,
        method: 'timedtext-api',
        length: transcript.length
      };
    }
    Logger.log('❌ 方法1 失败');
    
    // 方法2：从视频页面提取字幕信息
    Logger.log('尝试方法2: 从视频页面提取');
    transcript = tryExtractFromPage(videoId);
    if (transcript) {
      Logger.log('✅ 方法2 成功！');
      return {
        success: true,
        transcript: transcript,
        videoId: videoId,
        method: 'page-extraction',
        length: transcript.length
      };
    }
    Logger.log('❌ 方法2 失败');
    
    // 所有方法都失败
    return {
      success: false,
      error: '未找到字幕。可能原因：\n1) 该视频没有公开字幕\n2) 视频被限制（地区、年龄等）\n3) YouTube 检测到机器访问\n\n💡 建议：手动复制字幕',
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

// 方法1：尝试直接访问 YouTube 的 timedtext API
function tryTimedTextApi(videoId) {
  try {
    Logger.log('尝试直接访问 timedtext API...');
    
    // 尝试多种语言代码和格式
    var langCodes = ['zh-Hans', 'zh-Hant', 'zh-CN', 'zh-TW', 'zh', 'en', 'en-US', 'en-GB'];
    var formats = ['srv3', 'srv2', 'srv1', 'json3', 'ttml'];
    
    for (var i = 0; i < langCodes.length; i++) {
      var lang = langCodes[i];
      
      for (var j = 0; j < formats.length; j++) {
        var fmt = formats[j];
        
        // 构建字幕 API URL
        var captionUrl = 'https://www.youtube.com/api/timedtext?v=' + videoId + 
                         '&lang=' + lang + 
                         '&fmt=' + fmt;
        
        try {
          var response = UrlFetchApp.fetch(captionUrl, {
            muteHttpExceptions: true,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://www.youtube.com/'
            }
          });
          
          var statusCode = response.getResponseCode();
          
          if (statusCode === 200) {
            var content = response.getContentText();
            
            // 检查是否有有效内容
            if (content && content.length > 100 && (content.indexOf('<text') > -1 || content.indexOf('"text"') > -1)) {
              Logger.log('✓✓✓ 找到有效字幕！语言: ' + lang + ', 格式: ' + fmt + ', 长度: ' + content.length);
              
              // 解析字幕
              var transcript = parseTranscriptXml(content);
              if (transcript && transcript.length > 50) {
                Logger.log('✓✓✓ 字幕解析成功，长度: ' + transcript.length);
                return transcript;
              }
            } else if (content && content.length > 0) {
              Logger.log('⚠️ 语言 ' + lang + ' 格式 ' + fmt + ': 返回内容过短或无效 (长度: ' + content.length + ')');
            }
          } else if (statusCode === 404) {
            // 404 是正常的（该语言/格式不存在），不记录
          } else {
            Logger.log('⚠️ 语言 ' + lang + ' 格式 ' + fmt + ': HTTP ' + statusCode);
          }
        } catch (e) {
          // 只记录非404错误
          if (e.toString().indexOf('404') === -1) {
            Logger.log('❌ 语言 ' + lang + ' 格式 ' + fmt + ' 错误: ' + e.toString().substring(0, 100));
          }
        }
      }
    }
    
    Logger.log('❌ 所有语言和格式都尝试失败');
    return null;
    
  } catch (error) {
    Logger.log('timedtext API 失败: ' + error.toString());
    return null;
  }
}

// 方法2：从视频页面提取（原有方法的改进版）
function tryExtractFromPage(videoId) {
  try {
    var url = 'https://www.youtube.com/watch?v=' + videoId;
    Logger.log('访问: ' + url);
    
    var response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cookie': 'CONSENT=YES+cb'  // 同意 cookies，可能获取更多数据
      }
    });
    
    if (response.getResponseCode() !== 200) {
      Logger.log('❌ HTTP ' + response.getResponseCode());
      return null;
    }
    
    var html = response.getContentText();
    Logger.log('HTML 长度: ' + html.length);
    
    // 尝试多种正则模式提取 ytInitialPlayerResponse
    var patterns = [
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});/,
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*var/,
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*if/,
      /window\["ytInitialPlayerResponse"\]\s*=\s*(\{.+?\});/,
      /"playerResponse":\s*"(\{.+?\})"/  // JSON编码的版本
    ];
    
    for (var i = 0; i < patterns.length; i++) {
      Logger.log('尝试正则模式 ' + (i + 1));
      var match = html.match(patterns[i]);
      
      if (match && match[1]) {
        var jsonStr = match[1];
        
        // 如果是 JSON 编码的字符串，需要解码
        if (jsonStr.indexOf('\\"') > -1) {
          jsonStr = jsonStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        
        try {
          var playerResponse = JSON.parse(jsonStr);
          Logger.log('✓ JSON 解析成功');
          
          var transcript = extractFromPlayerResponse(playerResponse);
          if (transcript) {
            return transcript;
          }
        } catch (e) {
          Logger.log('JSON 解析失败: ' + e.toString());
        }
      }
    }
    
    return null;
    
  } catch (error) {
    Logger.log('页面提取失败: ' + error.toString());
    return null;
  }
}

// 从 playerResponse 提取字幕
function extractFromPlayerResponse(playerResponse) {
  try {
    if (!playerResponse.captions) {
      Logger.log('❌ 没有 captions 字段');
      
      // 尝试其他可能的位置
      if (playerResponse.playerCaptionsTracklistRenderer) {
        Logger.log('✓ 找到 playerCaptionsTracklistRenderer（备用位置）');
        playerResponse.captions = {
          playerCaptionsTracklistRenderer: playerResponse.playerCaptionsTracklistRenderer
        };
      } else {
        return null;
      }
    }
    
    Logger.log('✓ 找到 captions');
    
    if (!playerResponse.captions.playerCaptionsTracklistRenderer) {
      Logger.log('❌ 没有 playerCaptionsTracklistRenderer');
      return null;
    }
    
    var renderer = playerResponse.captions.playerCaptionsTracklistRenderer;
    
    if (!renderer.captionTracks || renderer.captionTracks.length === 0) {
      Logger.log('❌ 没有 captionTracks');
      return null;
    }
    
    var captionTracks = renderer.captionTracks;
    Logger.log('✓ 找到 ' + captionTracks.length + ' 个字幕轨道');
    
    // 选择字幕轨道
    var selectedTrack = selectCaptionTrack(captionTracks);
    if (!selectedTrack || !selectedTrack.baseUrl) {
      Logger.log('❌ 无法选择字幕轨道');
      return null;
    }
    
    Logger.log('✓ 选择字幕: ' + selectedTrack.languageCode);
    
    // 获取字幕 URL
    var captionUrl = selectedTrack.baseUrl;
    
    // 修复：如果是相对路径，补充完整域名
    if (captionUrl.indexOf('http') !== 0) {
      captionUrl = 'https://www.youtube.com' + captionUrl;
      Logger.log('✓ 补充完整URL');
    }
    
    // 下载字幕
    return downloadAndParseCaption(captionUrl);
    
  } catch (error) {
    Logger.log('extractFromPlayerResponse 失败: ' + error.toString());
    return null;
  }
}

// 选择字幕轨道（优先顺序：中文 > 英文 > 其他）
function selectCaptionTrack(captionTracks) {
  Logger.log('可用字幕轨道:');
  for (var i = 0; i < captionTracks.length; i++) {
    Logger.log('  ' + i + ': ' + captionTracks[i].languageCode + ' - ' + (captionTracks[i].name ? captionTracks[i].name.simpleText : '无名称'));
  }
  
  // 优先1: 中文字幕
  for (var i = 0; i < captionTracks.length; i++) {
    var track = captionTracks[i];
    if (track.languageCode) {
      var lang = track.languageCode.toLowerCase();
      if (lang.indexOf('zh') === 0 || lang.indexOf('cn') > -1) {
        Logger.log('✓ 选择中文字幕: ' + track.languageCode);
        return track;
      }
    }
  }
  
  // 优先2: 英文字幕
  for (var i = 0; i < captionTracks.length; i++) {
    var track = captionTracks[i];
    if (track.languageCode) {
      var lang = track.languageCode.toLowerCase();
      if (lang.indexOf('en') === 0) {
        Logger.log('✓ 选择英文字幕: ' + track.languageCode);
        return track;
      }
    }
  }
  
  // 优先3: 第一个字幕
  Logger.log('✓ 使用第一个字幕: ' + captionTracks[0].languageCode);
  return captionTracks[0];
}

// 下载并解析字幕
function downloadAndParseCaption(captionUrl) {
  try {
    Logger.log('下载字幕...');
    Logger.log('URL: ' + captionUrl.substring(0, 150) + '...');
    
    var response = UrlFetchApp.fetch(captionUrl, {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://www.youtube.com/'
      }
    });
    
    var statusCode = response.getResponseCode();
    Logger.log('HTTP Status: ' + statusCode);
    
    if (statusCode !== 200) {
      Logger.log('❌ 字幕下载失败: HTTP ' + statusCode);
      return null;
    }
    
    var xml = response.getContentText();
    Logger.log('✓ 字幕 XML 长度: ' + xml.length);
    
    // 如果XML为空，记录详细信息
    if (xml.length === 0) {
      Logger.log('⚠️ XML为空，可能原因：');
      Logger.log('  1. 该字幕轨道无数据（自动生成但未完成）');
      Logger.log('  2. 需要特定的认证信息');
      Logger.log('  3. URL参数不完整');
      return null;
    }
    
    // 记录XML的开头部分（用于调试）
    Logger.log('XML 开头: ' + xml.substring(0, 200));
    
    return parseTranscriptXml(xml);
    
  } catch (error) {
    Logger.log('下载字幕失败: ' + error.toString());
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
