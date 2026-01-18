# YouTube 字幕自动提取功能使用说明

## 🎯 功能概述

ContentMaster AI 现已支持 **YouTube 视频字幕自动提取** 功能！只需输入 YouTube 视频链接，点击"提取字幕"按钮，即可自动提取视频字幕并填入输入框，无需手动复制粘贴。

---

## ✨ 主要特性

- ✅ **一键提取**：输入 YouTube 链接，点击按钮即可自动提取字幕
- ✅ **自动清理**：自动移除时间戳、特殊标记等，输出纯净文本
- ✅ **智能检测**：自动识别 YouTube 链接并显示提取按钮
- ✅ **API 驱动**：通过 Google Apps Script API 实现，可自定义部署
- ✅ **无需后端**：完全基于前端和 Google Apps Script，无需额外服务器

---

## 🚀 使用步骤

### 步骤 1：部署 Google Apps Script API

请参考 [GAS_DEPLOYMENT_GUIDE.md](./GAS_DEPLOYMENT_GUIDE.md) 文档，部署您自己的 YouTube 字幕提取 API。

**核心步骤：**
1. 创建 Google Apps Script 项目
2. 复制提供的代码
3. 部署为 Web 应用
4. 复制 API URL

### 步骤 2：配置 API URL

有以下三种配置方式：

#### 方式 1：环境变量（推荐）

在项目根目录创建 `.env` 文件：

```env
VITE_YOUTUBE_API_URL=https://script.google.com/macros/s/YOUR_ID/exec
```

#### 方式 2：代码配置

在 `components/Tools.tsx` 中修改默认值：

```typescript
const [gasApiUrl, setGasApiUrl] = useState<string>(
  'https://script.google.com/macros/s/YOUR_ID/exec'
);
```

#### 方式 3：用户界面配置（未来功能）

在设置面板中添加输入框，让用户输入自己的 API URL。

### 步骤 3：使用字幕提取功能

1. **输入 YouTube 链接**
   - 在"原始文本"输入框中粘贴 YouTube 视频链接
   - 支持的格式：
     - `https://www.youtube.com/watch?v=VIDEO_ID`
     - `https://youtu.be/VIDEO_ID`
     - `https://www.youtube.com/embed/VIDEO_ID`

2. **点击"提取字幕"按钮**
   - 系统会自动识别 YouTube 链接
   - 在输入框标签旁边显示绿色的"提取字幕"按钮
   - 点击按钮开始提取

3. **等待提取完成**
   - 按钮会显示"提取中..."状态
   - 提取成功后，字幕会自动填入输入框
   - 输出框会显示成功提示

4. **处理字幕内容**
   - 选择处理模式（改写/扩写/摘要/润色/脚本输出）
   - 点击"生成"按钮开始处理

---

## 🎨 界面说明

### 提取按钮显示逻辑

- **未检测到 YouTube 链接**：不显示按钮
- **检测到 YouTube 链接**：显示绿色"提取字幕"按钮
- **正在提取**：按钮显示"提取中..."并禁用
- **提取完成**：字幕自动填入输入框，可继续处理

### 状态提示

- ⏳ **提取中**：`正在提取YouTube视频字幕，请稍候...`
- ✅ **成功**：`字幕提取成功！已自动填入输入框，您可以选择处理模式后点击生成按钮。`
- ❌ **失败**：显示具体错误信息和解决建议

---

## 🔧 技术实现

### 前端部分

**新增服务：** `services/youtubeService.ts`

```typescript
- extractYouTubeVideoId()  // 提取视频 ID
- isYouTubeLink()          // 检测是否为 YouTube 链接
- fetchYouTubeTranscript() // 调用 API 提取字幕
- cleanTranscript()        // 清理字幕文本
```

**组件更新：** `components/Tools.tsx`

```typescript
- handleExtractTranscript()  // 处理字幕提取
- isExtractingTranscript     // 提取状态
- gasApiUrl                  // API URL 配置
```

### 后端部分（Google Apps Script）

**主要函数：**

```javascript
- doPost(e)                  // 处理 POST 请求
- getYouTubeTranscript()     // 提取字幕主逻辑
- parseTranscriptXml()       // 解析字幕 XML
```

---

## ⚙️ API 接口说明

### 请求格式

```http
POST https://script.google.com/macros/s/YOUR_ID/exec
Content-Type: application/json

{
  "videoId": "dQw4w9WgXcQ"
}
```

### 响应格式

**成功响应：**

```json
{
  "success": true,
  "transcript": "视频字幕内容..."
}
```

**失败响应：**

```json
{
  "success": false,
  "error": "错误信息"
}
```

---

## 🐛 故障排除

### 问题 1：点击"提取字幕"按钮没有反应

**可能原因：**
- 未配置 API URL
- API URL 格式错误
- 网络连接问题

**解决方案：**
1. 检查 `gasApiUrl` 是否已正确配置
2. 打开浏览器控制台查看错误信息
3. 确认网络连接正常

### 问题 2：提示"字幕提取失败"

**可能原因：**
- 视频没有字幕
- 视频是私密的
- API 配额已用完

**解决方案：**
1. 确认视频有字幕（手动打开视频检查）
2. 使用公开视频测试
3. 检查 Google Apps Script 配额（每天 20,000 次调用）

### 问题 3：字幕内容格式混乱

**可能原因：**
- YouTube 字幕格式变化
- 清理逻辑需要更新

**解决方案：**
1. 查看原始字幕内容
2. 更新 `cleanTranscript` 函数的清理规则
3. 手动调整提取后的文本

---

## 🔒 隐私和安全

### 数据处理

- ✅ 所有字幕提取在 Google Apps Script 服务器上进行
- ✅ 前端不存储任何视频数据
- ✅ 不会上传字幕内容到第三方服务
- ✅ 仅使用 YouTube 公开的字幕数据

### API 安全

**建议措施：**

1. **不要公开 API URL**
   - 不要在公共代码库中提交 API URL
   - 使用环境变量存储

2. **添加 API 密钥验证**（可选）
   ```javascript
   function doPost(e) {
     const apiKey = requestData.apiKey;
     if (apiKey !== 'YOUR_SECRET_KEY') {
       return errorResponse('Invalid API key');
     }
     // ... 继续处理 ...
   }
   ```

3. **设置使用配额**
   - 监控 Google Apps Script 使用情况
   - 考虑添加速率限制

---

## 📈 未来改进

### 计划功能

- [ ] **用户界面配置 API URL**
  - 在设置面板中添加 API URL 输入框
  - 支持多个 API URL 配置（负载均衡）

- [ ] **多语言字幕支持**
  - 检测可用语言列表
  - 让用户选择首选语言

- [ ] **字幕缓存**
  - 本地缓存已提取的字幕
  - 避免重复调用 API

- [ ] **批量提取**
  - 支持多个视频链接批量提取
  - 生成字幕合集

- [ ] **高级字幕处理**
  - 自动断句优化
  - 移除填充词（嗯、啊等）
  - 智能分段

---

## 🎓 开发文档

### 扩展字幕提取服务

如果您想扩展字幕提取服务，可以：

**1. 添加其他视频平台支持**

```typescript
// services/videoService.ts
export const extractBilibiliTranscript = async (bvid: string) => {
  // Bilibili 字幕提取逻辑
};

export const extractVimeoTranscript = async (videoId: string) => {
  // Vimeo 字幕提取逻辑
};
```

**2. 优化字幕质量**

```typescript
const enhanceTranscript = (text: string) => {
  // 自动断句
  text = addPunctuation(text);
  
  // 移除填充词
  text = removeFillerWords(text);
  
  // 修正常见错误
  text = fixCommonErrors(text);
  
  return text;
};
```

**3. 添加字幕翻译**

```typescript
const translateTranscript = async (text: string, targetLang: string) => {
  // 使用翻译 API（如 Google Translate）
  const translated = await googleTranslate(text, targetLang);
  return translated;
};
```

---

## 📞 技术支持

如果您在使用过程中遇到问题：

1. **查看部署指南**：[GAS_DEPLOYMENT_GUIDE.md](./GAS_DEPLOYMENT_GUIDE.md)
2. **检查浏览器控制台**：查看详细错误信息
3. **测试 API**：使用 curl 或 Postman 测试 API 是否正常
4. **查看日志**：Google Apps Script → 查看 → 执行日志

---

## 🎉 开始使用

1. 按照 [GAS_DEPLOYMENT_GUIDE.md](./GAS_DEPLOYMENT_GUIDE.md) 部署 API
2. 配置 API URL
3. 刷新页面
4. 输入 YouTube 链接并点击"提取字幕"

享受自动化的字幕提取体验！🚀
