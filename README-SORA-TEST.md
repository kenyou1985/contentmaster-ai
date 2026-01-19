# Sora 视频生成 API 测试方案

## 📋 测试目的

在集成到代码之前，先测试 yunwu.ai Sora 视频生成 API 的配置是否正确，确保能够成功生成视频。

## 🛠️ 测试工具

提供了两种测试方式：

### 方式 1: 浏览器测试（推荐）

1. 打开 `test-sora-video.html` 文件（直接在浏览器中打开）
2. 填写你的 yunwu.ai API Key
3. 选择测试模式：
   - **文生视频 (Text-to-Video)**：直接根据提示词生成视频
   - **图生视频 (Image-to-Video)**：基于图片生成视频
4. 填写必要的参数
5. 点击"开始测试"按钮
6. 查看返回结果

### 方式 2: Node.js 命令行测试

1. 确保 Node.js 版本 >= 18（支持内置 fetch）
2. 打开 `test-sora-video.js` 文件
3. 将 `YOUR_API_KEY_HERE` 替换为你的 yunwu.ai API Key
4. 运行命令：
   ```bash
   node test-sora-video.js
   ```

## 📝 API 接口说明

根据 [yunwu.apifox.cn](https://yunwu.apifox.cn/) 文档，Sora 视频生成使用以下接口：

### 接口地址
```
POST https://yunwu.ai/v1/video/create
```

### 请求头
```
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY
```

### 请求参数

#### 文生视频 (Text-to-Video)
```json
{
  "model": "sora-2",           // 或 "sora-2-pro"
  "prompt": "视频提示词",        // 必填
  "orientation": "landscape",  // "landscape" 或 "portrait"，必填
  "size": "large",             // "small" (720p) 或 "large" (1080p)，必填
  "duration": 10,              // 10, 15, 或 25 秒，必填
  "watermark": true            // 是否添加水印，必填，默认 true
  // 注意：文生视频不包含 images 字段
}
```

#### 图生视频 (Image-to-Video)
```json
{
  "model": "sora-2",           // 或 "sora-2-pro"
  "prompt": "视频提示词",        // 必填
  "images": ["图片URL"],        // 图片 URL 数组，必填（图生视频模式）
  "orientation": "landscape",  // "landscape" 或 "portrait"，必填
  "size": "large",             // "small" (720p) 或 "large" (1080p)，必填
  "duration": 10,              // 10, 15, 或 25 秒，必填
  "watermark": true            // 是否添加水印，必填，默认 true
}
```

### 响应格式

#### 成功响应
```json
{
  "id": "task_id_123",         // 任务 ID（如果返回，需要轮询查询状态）
  "url": "https://...",        // 视频 URL（如果直接返回）
  "video_url": "https://...",  // 视频 URL（另一种格式）
  // 其他字段...
}
```

#### 错误响应
```json
{
  "error": {
    "message": "错误信息"
  }
}
```

## 🔍 常见错误及解决方案

### 1. "当前分组上游负载已饱和"
- **原因**：服务器负载过高
- **解决方案**：
  - 等待 30 秒 - 2 分钟后重试
  - 错峰使用（避开高峰期）

### 2. "模型不可用" 或 "No available channels"
- **原因**：
  - API Key 没有该模型的权限
  - 账户余额不足
  - 模型需要特殊权限或白名单
- **解决方案**：
  - 联系 yunwu.ai 客服确认模型可用性和账户权限
  - 检查账户余额

### 3. HTTP 400 错误
- **原因**：请求参数不正确
- **解决方案**：
  - 检查必填字段是否都提供了
  - 检查参数格式是否正确（如 orientation 必须是 "landscape" 或 "portrait"）
  - 检查 size 必须是 "small" 或 "large"

### 4. HTTP 401 错误
- **原因**：API Key 无效或未提供
- **解决方案**：
  - 检查 API Key 是否正确
  - 检查 Authorization 头格式是否正确

## 📊 测试检查清单

- [ ] API Key 配置正确
- [ ] 文生视频测试成功
- [ ] 图生视频测试成功（如果有图片 URL）
- [ ] 能够正确解析响应数据
- [ ] 如果返回 task_id，能够查询任务状态
- [ ] 能够获取视频 URL

## 🎯 测试成功后

如果测试成功，说明：
1. API Key 配置正确
2. 接口地址正确
3. 请求参数格式正确
4. 账户有足够的权限和余额

此时可以：
1. 将测试成功的配置应用到代码中
2. 检查代码中的参数是否与测试时一致
3. 如果测试时遇到"负载已饱和"错误，这是正常的，可以稍后重试

## 📚 参考文档

- [yunwu.apifox.cn](https://yunwu.apifox.cn/) - yunwu.ai API 文档
- Sora 视频生成相关接口文档

## 💡 提示

1. **图生视频模式**：需要提供公开可访问的图片 URL，不能是本地文件路径
2. **任务 ID**：如果 API 返回了 task_id，说明是异步任务，需要使用轮询接口查询任务状态
3. **视频 URL**：如果直接返回了 video_url，说明视频已生成完成，可以直接使用
4. **测试环境**：建议先在测试环境验证，再应用到生产环境
