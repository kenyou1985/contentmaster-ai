# YouTube Data API v3 申请指南

## 📝 步骤 1：创建 Google Cloud 项目

1. **访问 Google Cloud Console**：
   - 打开：https://console.cloud.google.com/
   - 使用您的 Google 账号登录

2. **创建新项目**：
   - 点击顶部的项目下拉菜单
   - 点击 **"新建项目"**
   - 项目名称：`YouTube字幕提取`
   - 点击 **"创建"**
   - 等待项目创建完成（约10秒）

## 📝 步骤 2：启用 YouTube Data API v3

1. **进入 API 库**：
   - 在左侧菜单，点击 **"API和服务"** → **"库"**
   - 或直接访问：https://console.cloud.google.com/apis/library

2. **搜索并启用**：
   - 在搜索框输入：`YouTube Data API v3`
   - 点击搜索结果中的 **"YouTube Data API v3"**
   - 点击 **"启用"** 按钮
   - 等待启用完成（约5秒）

## 📝 步骤 3：创建 API 密钥

1. **创建凭据**：
   - 在左侧菜单，点击 **"凭据"**
   - 或直接访问：https://console.cloud.google.com/apis/credentials

2. **创建 API 密钥**：
   - 点击顶部的 **"+ 创建凭据"**
   - 选择 **"API 密钥"**
   - 等待密钥生成（约3秒）
   - **立即复制密钥**并保存到安全的地方

3. **限制 API 密钥（推荐）**：
   - 在弹出窗口中，点击 **"限制密钥"**
   - 或在凭据列表中，点击刚创建的密钥右侧的 **"编辑"**
   
   **API 限制**：
   - 选择 **"限制密钥"**
   - 勾选 **"YouTube Data API v3"**
   
   **应用限制**（可选）：
   - 如果只在网站使用：选择 **"HTTP 引荐来源网址（网站）"**
   - 添加您的域名：`http://localhost:3000/*` 和 `https://yourdomain.com/*`
   
   - 点击 **"保存"**

4. **复制 API 密钥**：
   ```
   您的API密钥：AIzaSy...（43个字符）
   ```
   ⚠️ **妥善保管，不要公开分享**

## 📊 配额说明

**免费配额**（每天）：
- **10,000 units** 免费
- **captions.list**：50 units/次
- **captions.download**：200 units/次

**计算**：
- 每次提取字幕 ≈ 250 units
- 每天可提取约 **40个视频**

**如果配额不足**：
- 可以申请增加配额（通常免费）
- 或等到第二天（配额每天重置）

## ⚠️ 注意事项

1. **API密钥安全**：
   - 不要在代码中硬编码
   - 不要提交到Git
   - 限制密钥的使用范围

2. **配额管理**：
   - 在控制台查看使用情况
   - 避免无限循环调用
   - 实现缓存机制

3. **错误处理**：
   - API可能返回403（配额超限）
   - API可能返回404（视频无字幕）
   - 需要适当的错误处理

## 🔗 有用的链接

- **Google Cloud Console**：https://console.cloud.google.com/
- **YouTube API 文档**：https://developers.google.com/youtube/v3
- **配额查看**：https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas
- **价格说明**：https://developers.google.com/youtube/v3/determine_quota_cost

## ✅ 完成确认

确认您已完成：
- [ ] 创建了 Google Cloud 项目
- [ ] 启用了 YouTube Data API v3
- [ ] 创建并复制了 API 密钥
- [ ] （可选）限制了 API 密钥的使用范围

**下一步**：将API密钥配置到Google Apps Script代码中。
