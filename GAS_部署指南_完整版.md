# Google Apps Script 部署指南 - YouTube 字幕提取 API

## ⚠️ 重要提示

**405 Method Not Allowed** 和 **CORS 错误** 的原因：
1. 部署时权限设置错误（没有选择"任何人"）
2. 代码中缺少 CORS 头处理
3. 没有正确配置 `doPost` 函数

本指南将帮助您正确部署，解决所有 CORS 和权限问题。

---

## 📋 完整部署步骤

### 第一步：打开 Google Apps Script

1. 访问：https://script.google.com/
2. 点击左上角 **"新建项目"**
3. 等待项目创建完成

### 第二步：粘贴代码

1. 删除默认的 `myFunction()` 函数
2. 复制 `GAS_完整代码_支持CORS.gs` 文件中的全部代码
3. 粘贴到编辑器中
4. 点击 **"保存"** 图标（💾）或按 `Ctrl+S`
5. 为项目命名：`YouTube字幕提取API`

### 第三步：部署为网络应用（⚠️ 最关键的步骤）

1. 点击右上角 **"部署"** 按钮
2. 选择 **"新建部署"**
3. 在弹出窗口中：
   - **类型**：点击"选择类型"，选择 **"网络应用"**
   - **说明**：输入 `YouTube字幕提取API v1`
   - **执行身份**：选择 **"我"**（这是您的 Google 账号）
   - ⚠️ **有权访问该应用的用户**：**必须选择"任何人"**
     - ❌ 不要选择"仅我自己"
     - ❌ 不要选择"仅限我所在组织的用户"
     - ✅ **必须选择"任何人"**（这样前端才能跨域访问）

4. 点击 **"部署"**

5. **授权提示**：
   - 如果出现"需要授权"提示，点击 **"授权访问"**
   - 选择您的 Google 账号
   - 如果出现"此应用未经验证"警告：
     - 点击左下角 **"高级"**
     - 点击 **"前往 YouTube字幕提取API（不安全）"**
     - 点击 **"允许"**

6. **部署成功**：
   - 复制 **"网络应用"** URL（类似于：`https://script.google.com/macros/s/AKfycby.../exec`）
   - ⚠️ 保存这个 URL，稍后需要配置到前端

### 第四步：测试 API（重要！）

#### 方法 1：浏览器直接测试（GET 请求）

1. 打开浏览器
2. 访问：`您的API_URL?videoId=UyyjU8fzEYU`
3. 替换 `您的API_URL` 为上一步复制的 URL
4. 例如：
   ```
   https://script.google.com/macros/s/AKfycby.../exec?videoId=UyyjU8fzEYU
   ```
5. **期望结果**：浏览器显示 JSON 数据：
   ```json
   {
     "success": true,
     "transcript": "视频字幕内容...",
     "videoId": "UyyjU8fzEYU"
   }
   ```

6. **如果失败**：
   - 检查 URL 是否正确
   - 检查是否选择了"任何人"权限
   - 检查视频 ID 是否正确

#### 方法 2：使用 Postman 测试（POST 请求）

1. 打开 Postman（或其他 API 测试工具）
2. 选择 **POST** 请求
3. URL：粘贴您的 API URL
4. Headers：
   - `Content-Type`: `application/json`
5. Body：选择 **raw**，输入：
   ```json
   {
     "videoId": "UyyjU8fzEYU"
   }
   ```
6. 点击 **Send**
7. **期望结果**：返回 JSON 数据（同上）

### 第五步：配置到前端

1. 复制您的 API URL
2. 确认 URL 格式正确（以 `/exec` 结尾）
3. **前端代码已经配置好，无需修改**
4. 如果需要更换 URL，修改 `components/Tools.tsx` 第 20 行：
   ```typescript
   const [gasApiUrl, setGasApiUrl] = useState<string>('您的新URL');
   ```

### 第六步：前端测试

1. 确保开发服务器正在运行：`npm run dev`
2. 打开浏览器：`http://localhost:3000/`
3. 在输入框粘贴 YouTube 链接：
   ```
   https://www.youtube.com/watch?v=UyyjU8fzEYU
   ```
4. 点击 **"提取字幕"** 按钮
5. **期望结果**：
   - 控制台显示：`[YouTubeService] 字幕提取成功，长度: XXX字`
   - 输入框自动填充字幕内容
   - 右侧显示：`✅ 字幕提取成功！`

---

## ❌ 常见错误及解决方案

### 错误 1：405 Method Not Allowed

**原因**：
- 部署时没有选择"任何人"权限
- 或者代码中缺少 `doPost` 函数

**解决方案**：
1. 回到 Google Apps Script
2. 点击 **"部署"** → **"管理部署"**
3. 点击当前部署右侧的 **"编辑"** 图标（铅笔）
4. 确认 **"有权访问该应用的用户"** 设置为 **"任何人"**
5. 点击 **"部署"**
6. 复制新的 URL（URL 会变化！）
7. 更新前端配置

### 错误 2：CORS 错误（Access-Control-Allow-Origin）

**原因**：
- 部署权限设置为"仅我自己"或"仅限组织"
- 或者代码中缺少 CORS 头

**解决方案**：
- 同上（错误 1）

### 错误 3：Redirect (重定向)

**原因**：
- API URL 错误（没有以 `/exec` 结尾）
- 或者使用了旧的部署 URL

**解决方案**：
1. 确认 URL 格式：`https://script.google.com/macros/s/AKfycby.../exec`
2. URL 必须以 `/exec` 结尾
3. 如果不是，重新复制正确的 URL

### 错误 4：未找到字幕

**原因**：
- 该视频没有字幕
- 或者字幕被禁用

**解决方案**：
1. 确认视频有字幕（在 YouTube 上打开视频，点击"字幕"按钮）
2. 尝试其他有字幕的视频
3. 推荐测试视频：
   - `UyyjU8fzEYU`（TED 演讲，有英文字幕）
   - `dQw4w9WgXcQ`（经典视频，有多语言字幕）

---

## 🔧 高级配置

### 查看日志

1. 在 Google Apps Script 编辑器中
2. 点击左侧 **"执行"** 图标
3. 查看最近的执行记录和日志

### 更新代码

1. 修改代码后，点击 **"保存"**
2. 点击 **"部署"** → **"管理部署"**
3. 点击当前部署右侧的 **"编辑"** 图标
4. 将 **"版本"** 改为 **"新版本"**
5. 点击 **"部署"**
6. ⚠️ URL 不会变化，无需更新前端

### 删除旧部署

1. 点击 **"部署"** → **"管理部署"**
2. 找到旧版本
3. 点击右侧的 **"归档"** 图标

---

## 📚 参考资料

- [Google Apps Script 官方文档](https://developers.google.com/apps-script)
- [YouTube Data API](https://developers.google.com/youtube/v3)
- [CORS 跨域资源共享](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/CORS)

---

## 🆘 还是不行？

如果按照上述步骤仍然无法解决问题，请提供：

1. **错误截图**（浏览器 F12 → Console 和 Network 标签）
2. **API URL**（可以打码部分内容）
3. **部署配置截图**（权限设置部分）
4. **测试结果**（GET 请求是否成功）

我会帮您诊断具体问题。
