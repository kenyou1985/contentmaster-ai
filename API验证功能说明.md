# 🔐 API Key 验证功能说明

## ✅ 已完成的改进

### 1. 默认配置更新
- ✅ **默认使用 Yunwu AI**: 系统现在默认使用 `https://api.yunwu.ai` 作为 Base URL
- ✅ **默认模型**: 使用 `gemini-3-pro-preview-thinking` 模型（支持思考功能）
- ✅ **自动检测**: 如果 API Key 以 `sk-` 开头，自动切换到 Yunwu AI

### 2. API Key 验证功能
- ✅ **验证按钮**: 在设置面板中添加了"驗證 Key"按钮
- ✅ **实时验证**: 点击按钮后立即验证 API Key 是否有效
- ✅ **状态显示**: 
  - ✅ 绿色：验证成功
  - ❌ 红色：验证失败
  - ⏳ 加载中：正在验证

### 3. 任务前验证
- ✅ **自动检查**: 在开始生成任务前，自动验证 API Key
- ✅ **友好提示**: 如果验证失败，会显示详细的错误信息
- ✅ **超时保护**: 验证过程有 5 秒超时保护，避免长时间等待

### 4. 错误处理改进
- ✅ **详细错误信息**: 提供更具体的错误原因
- ✅ **网络错误处理**: 特别处理网络连接失败的情况
- ✅ **模型不可用处理**: 如果指定模型不可用，自动尝试备用模型

## 🎯 使用方法

### 步骤 1: 输入 API Key
1. 点击右上角的设置图标（⚙️）
2. 在"API Key"输入框中输入您的 API Key
   - 如果使用 Yunwu AI，输入以 `sk-` 开头的 Key
   - 系统会自动识别并配置

### 步骤 2: 验证 API Key
1. 点击"驗證 Key"按钮
2. 等待验证结果（通常 2-5 秒）
3. 查看验证状态：
   - ✅ **验证成功**: 可以开始使用
   - ❌ **验证失败**: 检查错误信息并修复

### 步骤 3: 开始使用
- 验证成功后，可以正常使用所有功能
- 系统会在每次任务开始前自动进行快速验证

## 📋 验证功能详情

### 验证过程
1. 检查 API Key 是否为空
2. 初始化 Gemini API 客户端
3. 发送测试请求到 API
4. 检查响应是否有效
5. 如果主模型不可用，尝试备用模型

### 错误类型处理
- **API Key 无效**: 提示"API Key 無效或未授權"
- **配额用完**: 提示"API 配額已用完"
- **网络错误**: 提示"網絡連接失敗，請檢查網絡或 Base URL 配置"
- **模型不可用**: 自动尝试备用模型 `gemini-2.0-flash-exp`

## 🔧 技术细节

### 默认配置
```typescript
// 默认 Base URL
baseUrl: 'https://api.yunwu.ai'

// 默认模型
modelName: 'gemini-3-pro-preview-thinking'
```

### 验证函数
```typescript
validateApiKey(apiKey: string, customBaseUrl?: string): Promise<{
  valid: boolean;
  message: string;
  model?: string;
}>
```

## 📚 相关文档

- **Yunwu AI API 文档**: https://yunwu.apifox.cn/
- **Google Gemini API**: https://ai.google.dev/

## ⚠️ 注意事项

1. **首次使用**: 建议先验证 API Key，确保可以正常连接
2. **网络问题**: 如果在中国大陆，可能需要使用代理或 Yunwu AI 服务
3. **模型可用性**: 如果 `gemini-3-pro-preview-thinking` 不可用，系统会自动尝试备用模型
4. **验证超时**: 验证过程有 5 秒超时，如果网络较慢可能会超时

## 🎉 改进效果

- ✅ 减少因 API Key 错误导致的失败
- ✅ 提前发现问题，避免浪费时间
- ✅ 更友好的错误提示
- ✅ 默认使用更稳定的 Yunwu AI 服务

---

**更新日期**: 2024年
**版本**: v2.0 - 添加 API Key 验证功能
