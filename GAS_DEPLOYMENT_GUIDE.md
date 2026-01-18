# Google Apps Script API 部署指南

## YouTube 字幕提取服务部署

本指南将帮助您部署自己的 YouTube 字幕提取 API 服务，以便在应用中实现一键提取 YouTube 视频字幕的功能。

---

## 📋 前置要求

1. **Google 账号**
2. **Google Apps Script 访问权限**
3. **YouTube 视频链接**（用于测试）

---

## 🚀 部署步骤

### 步骤 1：创建 Google Apps Script 项目

1. 访问 [Google Apps Script](https://script.google.com/)
2. 点击 **"新建项目"**
3. 将项目命名为：`YouTube Transcript API`

### 步骤 2：添加代码

将以下代码粘贴到 `Code.gs` 文件中：

```javascript
/**
 * YouTube 字幕提取 API
 * Google Apps Script 兼容版本（使用 var 而非 const/let）
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
```

### 步骤 3：部署为 Web 应用

1. 点击右上角的 **"部署"** → **"新建部署"**
2. 选择类型：**"Web 应用"**
3. 配置：
   - **说明**：YouTube Transcript API v1
   - **执行身份**：选择 **"我"**
   - **谁可以访问**：选择 **"所有人"**（重要！）
4. 点击 **"部署"**
5. **复制 Web 应用 URL**（格式类似：`https://script.google.com/macros/s/xxx/exec`）

### 步骤 4：测试 API

使用以下命令测试 API（将 `YOUR_API_URL` 替换为实际 URL）：

```bash
curl -X POST YOUR_API_URL \
  -H "Content-Type: application/json" \
  -d '{"videoId": "dQw4w9WgXcQ"}'
```

成功响应示例：

```json
{
  "success": true,
  "transcript": "视频字幕内容..."
}
```

---

## 🔧 在应用中配置

### 方法 1：环境变量（推荐）

1. 在项目根目录创建 `.env` 文件：

```env
VITE_YOUTUBE_API_URL=https://script.google.com/macros/s/YOUR_ID/exec
```

2. 在 `vite.config.ts` 中配置：

```typescript
export default defineConfig({
  define: {
    'process.env.VITE_YOUTUBE_API_URL': JSON.stringify(process.env.VITE_YOUTUBE_API_URL)
  }
});
```

### 方法 2：直接在代码中配置

在 `components/Tools.tsx` 中设置默认 API URL：

```typescript
const [gasApiUrl, setGasApiUrl] = useState<string>(
  'https://script.google.com/macros/s/YOUR_ID/exec'
);
```

### 方法 3：用户界面配置（最灵活）

在设置面板中添加输入框，让用户输入他们自己的 API URL。

---

## ⚠️ 注意事项

### 1. CORS 问题

Google Apps Script 会自动处理 CORS，无需额外配置。

### 2. API 配额限制

- **每天 20,000 次调用**
- **每个用户每 100 秒 100 次调用**

如果超出限制，请考虑：
- 添加缓存机制
- 使用多个 GAS 项目
- 升级到 Google Cloud Functions

### 3. 字幕可用性

并非所有 YouTube 视频都有字幕：
- 优先使用有自动生成字幕的视频
- 检查视频是否启用了字幕功能
- 处理"无字幕"的错误情况

### 4. 隐私和安全

- **不要**在公共代码库中暴露 API URL
- 考虑添加 API 密钥验证
- 定期更换部署版本

---

## 🐛 故障排除

### 问题 1：API 返回 403 错误

**原因**：部署权限设置错误

**解决方案**：
1. 重新部署
2. 确保 "谁可以访问" 设置为 **"所有人"**

### 问题 2：无法提取字幕

**原因**：
- 视频没有字幕
- 视频是私密的
- YouTube 页面结构变化

**解决方案**：
1. 检查视频是否有字幕
2. 使用公开视频测试
3. 更新字幕提取逻辑

### 问题 3：字幕格式不正确

**原因**：XML 解析问题

**解决方案**：
- 增强 `parseTranscriptXml` 函数
- 添加更多的文本清理规则

---

## 📚 高级功能

### 多语言字幕支持

修改 `getYouTubeTranscript` 函数以支持特定语言：

```javascript
function getYouTubeTranscript(videoId, languageCode) {
  // ... 现有代码 ...
  
  // 筛选指定语言的字幕
  const captionTrack = captionsData.find(track => 
    track.languageCode === languageCode
  );
  
  if (captionTrack) {
    const captionUrl = captionTrack.baseUrl;
    // ... 继续处理 ...
  }
}
```

### 添加 API 密钥验证

```javascript
function doPost(e) {
  // 验证 API 密钥
  const apiKey = e.parameter.apiKey || requestData.apiKey;
  const validApiKey = 'YOUR_SECRET_API_KEY';
  
  if (apiKey !== validApiKey) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: 'Invalid API key'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  
  // ... 继续处理 ...
}
```

---

## 📞 支持

如果您在部署过程中遇到问题，请：

1. 检查 Google Apps Script 日志（**查看** → **执行日志**）
2. 确认 API URL 格式正确
3. 测试简单的 GET 请求确认服务运行正常
4. 查看浏览器控制台的网络请求详情

---

## 🎉 完成

现在您已经成功部署了 YouTube 字幕提取 API！

在应用中输入 YouTube 链接并点击"提取字幕"按钮，即可自动提取视频字幕。
