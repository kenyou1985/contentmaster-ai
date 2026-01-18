# YouTube 字幕提取 API 测试指南

## 您的 API URL
```
https://script.google.com/macros/s/AKfycbz5rXPxfqBvSvYugIiu8FAtcejR6AMwGmdT5VAXWPEU8nvg8eO5herl6_PuUYbrpng8/exec
```

## ✅ API 状态检测

### 测试结果
- **状态**: 🟢 运行正常
- **版本**: 1.0
- **响应时间**: 正常

### 测试命令
```bash
# Windows PowerShell
Invoke-WebRequest -Uri "https://script.google.com/macros/s/AKfycbz5rXPxfqBvSvYugIiu8FAtcejR6AMwGmdT5VAXWPEU8nvg8eO5herl6_PuUYbrpng8/exec" -UseBasicParsing
```

响应：
```json
{
  "service": "YouTube Transcript API",
  "version": "1.0",
  "status": "running"
}
```

---

## 🔄 升级建议

### 当前问题
目前部署的 GAS 代码中，`doGet` 函数只返回状态信息，不处理 `videoId` 参数。这意味着：
- ✅ POST 请求可以正常提取字幕（前端使用的方式）
- ❌ GET 请求无法提取字幕（不便于测试）

### 解决方案
我已经为您创建了一个改进版本的 GAS 代码：`GAS_代码_完整版_支持GET和POST.gs`

**新版本特性**：
1. ✅ 同时支持 GET 和 POST 请求
2. ✅ GET 请求支持 `videoId` 参数，方便测试
3. ✅ 优先选择英文字幕
4. ✅ 更详细的错误信息

**升级步骤**：
1. 打开 Google Apps Script 项目
2. 复制 `GAS_代码_完整版_支持GET和POST.gs` 的内容
3. 替换现有代码
4. 点击"部署" → "管理部署"
5. 点击编辑图标 ✏️
6. 选择"新版本"
7. 点击"部署"

**升级后的测试命令**：
```powershell
# 测试 API 状态
Invoke-WebRequest -Uri "https://script.google.com/macros/s/AKfycbz5rXPxfqBvSvYugIiu8FAtcejR6AMwGmdT5VAXWPEU8nvg8eO5herl6_PuUYbrpng8/exec" -UseBasicParsing

# 测试字幕提取（GET 请求 - 新功能）
$response = Invoke-WebRequest -Uri "https://script.google.com/macros/s/AKfycbz5rXPxfqBvSvYugIiu8FAtcejR6AMwGmdT5VAXWPEU8nvg8eO5herl6_PuUYbrpng8/exec?videoId=UyyjU8fzEYU" -UseBasicParsing
$response.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10

# 测试字幕提取（POST 请求 - 前端使用）
$body = '{"videoId": "UyyjU8fzEYU"}'
$response = Invoke-WebRequest -Uri "https://script.google.com/macros/s/AKfycbz5rXPxfqBvSvYugIiu8FAtcejR6AMwGmdT5VAXWPEU8nvg8eO5herl6_PuUYbrpng8/exec" -Method POST -Body $body -ContentType "application/json" -UseBasicParsing
$response.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10
```

---

## 🎯 前端集成

### 当前配置状态
✅ API URL 已配置在 `components/Tools.tsx` 第 20 行：
```typescript
const [gasApiUrl, setGasApiUrl] = useState<string>('https://script.google.com/macros/s/AKfycbz5rXPxfqBvSvYugIiu8FAtcejR6AMwGmdT5VAXWPEU8nvg8eO5herl6_PuUYbrpng8/exec');
```

### 使用方式
1. 在"原始文本"输入框中粘贴 YouTube 视频链接
2. 系统会自动检测到 YouTube 链接
3. 点击"提取字幕"按钮
4. 字幕内容会自动填充到输入框中

### 支持的 YouTube 链接格式
- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`
- `https://www.youtube.com/embed/VIDEO_ID`

---

## 📝 测试视频

### 推荐测试视频
1. **TED 演讲**：`UyyjU8fzEYU` - 有英文字幕
2. **Google I/O**：任何 Google I/O 演讲视频 - 通常都有英文字幕

### 测试命令（升级后）
```powershell
# 测试 TED 演讲视频字幕提取
Invoke-WebRequest -Uri "https://script.google.com/macros/s/AKfycbz5rXPxfqBvSvYugIiu8FAtcejR6AMwGmdT5VAXWPEU8nvg8eO5herl6_PuUYbrpng8/exec?videoId=UyyjU8fzEYU" -UseBasicParsing | Select-Object -ExpandProperty Content
```

---

## ⚠️ 注意事项

1. **字幕可用性**：并非所有 YouTube 视频都有字幕
2. **语言偏好**：新版本代码会优先提取英文字幕
3. **API 限制**：Google Apps Script 有每日调用次数限制
4. **CORS 支持**：API 已配置 CORS，可从任何域名访问

---

## 🔧 故障排除

### 问题：无法提取字幕
**可能原因**：
- 视频没有公开字幕
- 视频为私有或受限
- 网络连接问题

**解决方案**：
1. 检查视频是否有字幕（在 YouTube 上播放时查看 CC 按钮）
2. 尝试其他有字幕的视频
3. 检查 API 部署状态

### 问题：API 返回状态信息但不提取字幕
**原因**：当前部署的代码版本不支持 GET 请求提取字幕

**解决方案**：
1. 前端使用 POST 请求（已实现，无需更改）
2. 或升级到新版本 GAS 代码以支持 GET 测试

---

## 📞 技术支持

如有问题，请检查：
1. GAS 项目是否正确部署
2. API URL 是否正确配置
3. 浏览器控制台是否有错误信息

前端调试：打开浏览器开发者工具（F12），查看 Console 和 Network 标签。
