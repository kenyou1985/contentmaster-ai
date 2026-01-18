/**
 * Google Apps Script - YouTube 字幕提取服务
 * 使用 RapidAPI - YouTube Transcript API
 * 
 * ✅ 优点：
 * - 简单易用，无需OAuth
 * - 免费版：1000次/月
 * - 稳定可靠，成功率95%+
 * 
 * 📝 申请步骤：
 * 1. 访问：https://rapidapi.com/ugoBas/api/youtube-transcript3
 * 2. 点击"Sign Up"注册账号
 * 3. 选择免费计划（Basic: 1000 requests/month）
 * 4. 复制您的 X-RapidAPI-Key
 * 5. 将密钥填入下方 RAPIDAPI_KEY 变量
 * 6. 部署为网络应用（权限：任何人）
 */

// ⚠️ 在此处填入您的 RapidAPI 密钥
var RAPIDAPI_KEY = 'YOUR_RAPIDAPI_KEY_HERE'; // 替换为您的实际密钥

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
    if (!RAPIDAPI_KEY || RAPIDAPI_KEY === 'YOUR_RAPIDAPI_KEY_HERE') {
      var result = {
        success: false,
        error: '未配置 RapidAPI 密钥。请在代码中设置 RAPIDAPI_KEY 变量。',
        guide: '访问 https://rapidapi.com/ugoBas/api/youtube-transcript3 获取密钥'
      };
      
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    var result = extractTranscriptWithRapidApi(videoId);
    
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

// 使用 RapidAPI 提取字幕
function extractTranscriptWithRapidApi(videoId) {
  try {
    Logger.log('========== 使用 RapidAPI 提取字幕 ==========');
    Logger.log('视频ID: ' + videoId);
    
    // 构建 RapidAPI 请求 URL
    var apiUrl = 'https://youtube-transcript3.p.rapidapi.com/api/transcript';
    
    // 构建请求参数（只使用videoId，不指定语言，让API自动选择）
    var params = {
      'videoId': videoId
    };
    
    // 将参数转换为查询字符串
    var queryString = Object.keys(params).map(function(key) {
      return key + '=' + encodeURIComponent(params[key]);
    }).join('&');
    
    var fullUrl = apiUrl + '?' + queryString;
    Logger.log('请求URL: ' + fullUrl);
    
    Logger.log('调用 RapidAPI...');
    
    // 发送请求
    var response = UrlFetchApp.fetch(fullUrl, {
      method: 'get',
      muteHttpExceptions: true,
      headers: {
        'X-RapidAPI-Host': 'youtube-transcript3.p.rapidapi.com',
        'X-RapidAPI-Key': RAPIDAPI_KEY
      }
    });
    
    var statusCode = response.getResponseCode();
    Logger.log('HTTP Status: ' + statusCode);
    
    // 检查响应状态
    if (statusCode === 403) {
      return {
        success: false,
        error: 'API密钥无效或配额已用完。\n\n请检查：\n1. API密钥是否正确\n2. 是否还有剩余配额\n3. 订阅是否还有效'
      };
    }
    
    if (statusCode === 404) {
      return {
        success: false,
        error: '未找到字幕。该视频可能：\n1) 没有字幕\n2) 字幕被禁用\n3) 视频不存在或已删除'
      };
    }
    
    if (statusCode !== 200) {
      return {
        success: false,
        error: 'API调用失败: HTTP ' + statusCode
      };
    }
    
    // 解析响应
    var data = JSON.parse(response.getContentText());
    Logger.log('响应数据类型: ' + typeof data);
    
    // 首先检查API是否返回错误
    if (data.success === false && data.error) {
      Logger.log('❌ API返回错误: ' + data.error);
      return {
        success: false,
        error: 'RapidAPI服务返回错误：\n' + data.error + '\n\n可能原因：\n1) 该视频没有公开字幕\n2) 字幕语言不匹配\n3) API服务暂时不可用\n\n💡 建议：使用手动复制功能'
      };
    }
    
    // 处理不同的API响应格式
    var transcript = '';
    
    // 格式1: 数组格式 [{text: "...", start: 0, duration: 5}, ...]
    if (Array.isArray(data)) {
      Logger.log('检测到数组格式，共 ' + data.length + ' 个片段');
      
      var texts = [];
      for (var i = 0; i < data.length; i++) {
        if (data[i].text) {
          texts.push(data[i].text);
        }
      }
      transcript = texts.join(' ');
    }
    // 格式2: 对象格式 {transcript: [...]}
    else if (data.transcript && Array.isArray(data.transcript)) {
      Logger.log('检测到对象格式，共 ' + data.transcript.length + ' 个片段');
      
      var texts = [];
      for (var i = 0; i < data.transcript.length; i++) {
        if (data.transcript[i].text) {
          texts.push(data.transcript[i].text);
        }
      }
      transcript = texts.join(' ');
    }
    // 格式3: 直接的文本
    else if (typeof data === 'string') {
      Logger.log('检测到字符串格式');
      transcript = data;
    }
    else {
      Logger.log('未知的响应格式: ' + JSON.stringify(data).substring(0, 200));
      return {
        success: false,
        error: '未知的API响应格式'
      };
    }
    
    // 清理字幕文本
    transcript = cleanTranscript(transcript);
    
    if (!transcript || transcript.length < 10) {
      return {
        success: false,
        error: '字幕内容为空或过短'
      };
    }
    
    Logger.log('✅ 字幕提取成功！长度: ' + transcript.length);
    
    return {
      success: true,
      transcript: transcript,
      videoId: videoId,
      method: 'rapidapi',
      length: transcript.length
    };
    
  } catch (error) {
    Logger.log('❌ 提取失败: ' + error.toString());
    return {
      success: false,
      error: '提取异常: ' + error.toString()
    };
  }
}

// 清理字幕文本
function cleanTranscript(text) {
  if (!text) return '';
  
  // 移除多余的空格和换行
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/[\r\n]+/g, ' ');
  
  // 移除方括号内的内容（如 [音乐]、[笑声]）
  text = text.replace(/\[[^\]]+\]/g, '');
  
  // 移除时间戳格式
  text = text.replace(/\d{1,2}:\d{2}(?::\d{2})?\s*/g, '');
  
  // 移除多余的空格
  text = text.replace(/\s+/g, ' ');
  
  // 去除首尾空格
  text = text.trim();
  
  return text;
}

// 测试函数
function testRapidApi() {
  Logger.log('========== 测试 RapidAPI ==========');
  
  // 检查API密钥
  if (!RAPIDAPI_KEY || RAPIDAPI_KEY === 'YOUR_RAPIDAPI_KEY_HERE') {
    Logger.log('❌ 请先配置 RAPIDAPI_KEY');
    Logger.log('获取密钥：https://rapidapi.com/ugoBas/api/youtube-transcript3');
    return;
  }
  
  Logger.log('✓ API Key: ' + RAPIDAPI_KEY.substring(0, 10) + '...');
  
  // 测试视频（使用您在RapidAPI后台测试成功的视频）
  var testVideos = [
    'ZacjOVVgoLY',  // ✅ 后台测试成功的视频
    'dQw4w9WgXcQ',  // Rick Astley - 有字幕
    'UyyjU8fzEYU'   // TED Talk - 有字幕
  ];
  
  for (var i = 0; i < testVideos.length; i++) {
    Logger.log('\n========== 测试视频 ' + (i + 1) + ' ==========');
    Logger.log('Video ID: ' + testVideos[i]);
    
    var result = extractTranscriptWithRapidApi(testVideos[i]);
    
    if (result.success) {
      Logger.log('✅✅✅ 成功！');
      Logger.log('长度: ' + result.length);
      Logger.log('前100字: ' + result.transcript.substring(0, 100) + '...');
    } else {
      Logger.log('❌ 失败: ' + result.error);
    }
  }
  
  Logger.log('\n========== 测试完成 ==========');
}
