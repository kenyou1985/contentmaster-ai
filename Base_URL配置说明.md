# 🌐 Base URL 配置说明

## 当前默认配置

系统默认使用：**`https://yunwu.ai`**

## Base URL 选项

### 1. Yunwu AI（推荐）
- **主选项**: `https://yunwu.ai`
- **备选选项**: `https://api.yunwu.ai`
- **说明**: 系统会自动尝试这两个 URL，优先使用主选项

### 2. Google 官方 API
- **URL**: `https://generativelanguage.googleapis.com`
- **说明**: 如果使用 Google 官方的 API Key（以 `AIza` 开头）

## 自动检测规则

1. **如果 API Key 以 `sk-` 开头**：
   - 自动使用 `https://yunwu.ai`
   - 验证时会自动尝试 `https://api.yunwu.ai` 作为备选

2. **如果 API Key 以 `AIza` 开头**：
   - 使用 Google 官方 API
   - Base URL: `https://generativelanguage.googleapis.com`

3. **如果手动设置了 Base URL**：
   - 使用您设置的 URL
   - 不会自动尝试其他变体

## 如何修改 Base URL

### 方法 1: 在界面中设置
1. 点击右上角的设置图标（⚙️）
2. 在 "Base URL (Optional)" 输入框中输入您想要的 URL
3. 点击"驗證 Key"按钮测试

### 方法 2: 使用环境变量
在项目根目录创建 `.env.local` 文件：
```env
VITE_GEMINI_BASE_URL=https://yunwu.ai
```

### 方法 3: 在代码中修改
编辑 `App.tsx` 文件，修改默认值：
```typescript
return storedUrl || envBaseUrl || 'https://yunwu.ai';
```

## 验证机制

系统在验证 API Key 时会：
1. 首先尝试 `https://yunwu.ai`
2. 如果失败，自动尝试 `https://api.yunwu.ai`
3. 对每个 URL 尝试不同的模型：
   - `gemini-2.0-flash-exp`（优先）
   - `gemini-3-pro-preview-thinking`（备选）

## 常见问题

### Q: 应该使用哪个 Base URL？
**A**: 
- 如果使用 Yunwu AI（`sk-` 开头的 Key）：使用 `https://yunwu.ai` 或 `https://api.yunwu.ai`
- 如果使用 Google 官方 API：使用 `https://generativelanguage.googleapis.com`

### Q: 验证失败怎么办？
**A**: 
1. 检查浏览器控制台（F12）查看详细错误
2. 尝试手动切换 Base URL
3. 确认网络连接正常
4. 确认 API Key 格式正确

### Q: 如何知道当前使用的 Base URL？
**A**: 
- 打开浏览器控制台（F12）
- 查看 Console 标签
- 查找 `[Gemini Service] Using Base URL: ...` 日志

## 当前配置位置

- **默认值**: `App.tsx` 第 21 行
- **初始化**: `services/geminiService.ts` 第 15、25 行
- **验证**: `services/geminiService.ts` 第 96、103 行

---

**提示**: 如果验证失败，系统会自动尝试备选 URL，无需手动切换。
