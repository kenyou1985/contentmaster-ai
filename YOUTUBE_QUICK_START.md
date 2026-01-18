# YouTube 字幕提取功能 - 快速开始

## 🎯 新功能

现在可以通过 API 自动提取 YouTube 视频字幕，无需手动复制粘贴！

---

## ⚡ 3 分钟快速部署

### 1. 创建 Google Apps Script 项目

访问 https://script.google.com/ 并创建新项目

### 2. 复制代码

将以下代码粘贴到 `Code.gs`：

```javascript
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
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function getYouTubeTranscript(videoId) {
  try {
    var url = 'https://www.youtube.com/watch?v=' + videoId;
    var response = UrlFetchApp.fetch(url);
    var html = response.getContentText();
    
    var captionMatch = html.match(/"captionTracks":\[(.*?)\]/);
    if (!captionMatch) return null;
    
    var captionsData = JSON.parse('[' + captionMatch[1] + ']');
    if (captionsData.length === 0) return null;
    
    var captionUrl = captionsData[0].baseUrl;
    var captionResponse = UrlFetchApp.fetch(captionUrl);
    var captionXml = captionResponse.getContentText();
    
    return parseTranscriptXml(captionXml);
  } catch (error) {
    Logger.log('Error: ' + error.toString());
    return null;
  }
}

function parseTranscriptXml(xml) {
  var text = xml.replace(/<[^>]+>/g, '');
  text = text.replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/&#39;/g, "'")
             .replace(/&nbsp;/g, ' ');
  return text.trim();
}
```

### 3. 部署为 Web 应用

1. 点击 **"部署"** → **"新建部署"**
2. 选择类型：**"Web 应用"**
3. **谁可以访问**：选择 **"所有人"**
4. 点击 **"部署"**
5. **复制 URL**（格式：`https://script.google.com/macros/s/xxx/exec`）

### 4. 配置应用

在 `components/Tools.tsx` 中找到这行：

```typescript
const [gasApiUrl, setGasApiUrl] = useState<string>('');
```

改为：

```typescript
const [gasApiUrl, setGasApiUrl] = useState<string>(
  'https://script.google.com/macros/s/YOUR_ID/exec'  // 替换为您的 URL
);
```

### 5. 重新构建

```bash
npm run build
npm run dev
```

---

## 🎬 使用方法

1. **输入 YouTube 链接**
   ```
   https://youtu.be/dQw4w9WgXcQ
   ```

2. **点击"提取字幕"按钮**
   - 绿色按钮会出现在输入框标签旁边

3. **等待提取完成**
   - 字幕会自动填入输入框

4. **选择处理模式并生成**
   - 改写/扩写/摘要/润色/脚本输出

---

## 🔍 测试视频

可以使用这些视频测试（都有字幕）：

- `dQw4w9WgXcQ` - Rick Astley - Never Gonna Give You Up
- `jNQXAC9IVRw` - Me at the zoo (第一个YouTube视频)

---

## ⚠️ 常见问题

### Q: 点击按钮没反应？

A: 检查：
1. API URL 是否已配置
2. 浏览器控制台是否有错误
3. Google Apps Script 是否部署成功

### Q: 提示"字幕提取失败"？

A: 可能原因：
1. 视频没有字幕（手动打开视频确认）
2. 视频是私密的
3. API 未正确部署

### Q: 字幕内容有问题？

A: 尝试：
1. 使用其他视频测试
2. 检查原始字幕是否正确
3. 更新字幕清理逻辑

---

## 📚 详细文档

- **完整部署指南**：[GAS_DEPLOYMENT_GUIDE.md](./GAS_DEPLOYMENT_GUIDE.md)
- **功能使用说明**：[YOUTUBE_FEATURE_README.md](./YOUTUBE_FEATURE_README.md)
- **技术实现细节**：查看 `services/youtubeService.ts`

---

## 🎉 完成！

现在您可以一键提取 YouTube 视频字幕了！

有问题？查看完整文档或在控制台查看错误日志。
