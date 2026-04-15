import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Youtube, Image, Wand2, Loader2, Copy, Clock, Trash2, X, Download, Maximize2, Terminal } from 'lucide-react';
import { ApiProvider } from '../types';
import { streamContentGeneration } from '../services/geminiService';
import { saveHistory, getHistory } from '../services/historyService';
import { generateImage, COVER_GEMINI_IMAGE_MODEL } from '../services/yunwuService';
import { useToast } from './Toast';
import { cacheImages } from '../services/imageCacheService';

interface LogEntry {
  id: number;
  type: 'info' | 'success' | 'error' | 'warning' | 'debug';
  message: string;
  timestamp: Date;
  details?: string; // 可选的详细信息
}

interface ChannelHistoryRecord {
  id: string; // 唯一标识符
  name: string; // 项目名称（用户可编辑）
  topic: string;
  targetAudience: string;
  contentType: string;
  brandPositioning: string;
  nameLang: 'zh' | 'en' | 'both';
  output: {
    names: string[];
    avatarPrompts: string[];
    bannerPrompts: string[];
    description: string;
    keywords: string[];
    avatarUrls?: string[][];
    bannerUrls?: string[][];
  };
  timestamp: number; // 创建时间
  updatedAt: number; // 最近修改时间
}

interface ChannelGeneratorProps {
  apiKey: string;
  provider: ApiProvider;
  toast?: ReturnType<typeof useToast>;
}

export const ChannelGenerator: React.FC<ChannelGeneratorProps> = ({ apiKey, provider, toast: externalToast }) => {
  const internalToast = useToast();
  const toast = externalToast || internalToast;

  const [channelTopic, setChannelTopic] = useState('');
  const [channelTargetAudience, setChannelTargetAudience] = useState('');
  const [channelContentType, setChannelContentType] = useState('');
  const [channelBrandPositioning, setChannelBrandPositioning] = useState('');
  const [channelOutput, setChannelOutput] = useState<{
    names: string[];
    avatarPrompts: string[];
    bannerPrompts: string[];
    description: string;
    keywords: string[];
    avatarUrls?: string[][];  // 每组最多3个版本
    bannerUrls?: string[][];   // 每组最多3个版本
  } | null>(null);
  const [isGeneratingChannel, setIsGeneratingChannel] = useState(false);
  // 头像/横幅生成中状态 - 使用数组支持多任务并行
  const [generatingAvatars, setGeneratingAvatars] = useState<number[]>([]);
  const [generatingBanners, setGeneratingBanners] = useState<number[]>([]);
  const [channelNameLang, setChannelNameLang] = useState<'zh' | 'en' | 'both'>('both');
  const [selectedNameForDesc, setSelectedNameForDesc] = useState<number>(0);
  const [channelHistory, setChannelHistory] = useState<ChannelHistoryRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ url: string; title: string; prompt: string } | null>(null);

  // 终端日志状态
  const [terminalLogs, setTerminalLogs] = useState<LogEntry[]>([]);
  const [showTerminal, setShowTerminal] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const logIdRef = useRef(0);

  // 添加日志
  const addLog = (message: string, type: 'info' | 'success' | 'error' | 'warning' | 'debug' = 'info', details?: string) => {
    const entry: LogEntry = {
      id: ++logIdRef.current,
      type,
      message,
      timestamp: new Date(),
      details,
    };
    setTerminalLogs(prev => [...prev.slice(-199), entry]);
  };

  // 清空日志
  const clearLogs = () => setTerminalLogs([]);

  // 自动滚动到最新日志
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalLogs]);

  // 头像风格选择状态 (默认 -1 = 自动按顺序)
  const [avatarStyleSelections, setAvatarStyleSelections] = useState<{ [key: number]: number }>({});
  // 横幅风格选择状态 (默认 -1 = 自动按顺序)
  const [bannerStyleSelections, setBannerStyleSelections] = useState<{ [key: number]: number }>({});

  // 头像风格定义
  const avatarStyleDefinitions = [
    { name: '真实摄影', desc: 'Photorealistic photography style, ultra detailed, natural lighting, professional camera quality' },
    { name: '动漫插画', desc: 'Anime/illustration style, vibrant colors, clean linework, Japanese art aesthetic, do not include channel name in image' },
    { name: '美漫画风', desc: 'American comic book style, bold colors, pop art influence, graphic design elements, do not include channel name in image' },
  ];

  // 横幅风格定义
  const bannerStyleDefinitions = [
    { name: '电影摄影', desc: 'Cinematic photography style, dramatic lighting, film grain texture, ultra detailed, 4K quality, do not include channel name in image' },
    { name: '纸艺拼贴', desc: '2D paper cut/collage art style, layered depth, colorful paper textures, silhouette elements, handcrafted look' },
    { name: '等轴测插画', desc: 'Isometric illustration style, clean vector art, soft pastel colors, 3D effect, modern graphic design' },
  ];

  const openImagePreview = (url: string, title: string, prompt: string) => {
    setPreviewImage({ url, title, prompt });
  };

  const HISTORY_KEY = 'channel_generator_history';

  // 加载历史记录
  useEffect(() => {
    try {
      const saved = localStorage.getItem(HISTORY_KEY);
      if (saved) {
        const records = JSON.parse(saved) as ChannelHistoryRecord[];
        setChannelHistory(records);
      }
    } catch (e) {
      console.error('加载频道历史记录失败:', e);
    }
  }, []);

  // 保存历史记录（使用函数式更新避免闭包陷阱）
  const saveChannelHistory = useCallback((record: ChannelHistoryRecord) => {
    try {
      setChannelHistory(prev => {
        // 确保记录有ID和更新时间
        const finalRecord = {
          ...record,
          id: record.id || `channel_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          updatedAt: record.updatedAt || Date.now(),
        };
        // 更新或添加记录
        const existingIndex = prev.findIndex(r => r.id === finalRecord.id);
        let updated: ChannelHistoryRecord[];
        if (existingIndex >= 0) {
          updated = [
            finalRecord,
            ...prev.filter((_, i) => i !== existingIndex)
          ];
        } else {
          updated = [finalRecord, ...prev].slice(0, 20);
        }
        localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
        return updated;
      });
    } catch (e) {
      console.error('保存频道历史记录失败:', e);
      addLog(`✗ 保存历史记录失败: ${e}`, 'error');
    }
  }, [addLog]);

  // 删除单条历史记录
  const deleteChannelHistory = (id: string) => {
    const updated = channelHistory.filter(r => r.id !== id);
    setChannelHistory(updated);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
    addLog(`已删除项目`, 'info');
  };

  // 清空全部历史
  const clearChannelHistory = () => {
    setChannelHistory([]);
    localStorage.removeItem(HISTORY_KEY);
  };

  // 加载历史记录到表单
  const loadFromHistory = (record: ChannelHistoryRecord) => {
    setChannelTopic(record.topic);
    setChannelTargetAudience(record.targetAudience);
    setChannelContentType(record.contentType);
    setChannelBrandPositioning(record.brandPositioning);
    setChannelNameLang(record.nameLang);
    setChannelOutput(record.output);
    setSelectedNameForDesc(0);
    setShowHistory(false);
  };

  const generateChannelAssets = async () => {
    if (!apiKey?.trim()) {
      toast.error('请先配置 API Key');
      return;
    }
    if (!channelTopic.trim()) {
      toast.warning('请输入频道主题');
      return;
    }

    setIsGeneratingChannel(true);
    setChannelOutput(null);
    addLog('开始生成频道资产...', 'info');

    try {
      const { initializeGemini } = await import('../services/geminiService');
      initializeGemini(apiKey, { provider });
      addLog(`初始化模型 API，Provider: ${provider}`, 'debug');

      const input = [
        `【频道主题】${channelTopic}`,
        `【目标观众】${channelTargetAudience || '未指定'}`,
        `【内容类型】${channelContentType || '未指定'}`,
        `【品牌定位】${channelBrandPositioning || '未指定'}`,
      ].join('\n');

      const nameLangReq = channelNameLang === 'zh'
        ? '频道名称必须是中文、清晰，专业、10个中文字符以内'
        : channelNameLang === 'en'
        ? '频道名称必须是英文、专业、30个英文字符以内'
        : '方案1-2为中文（10字符以内），方案3为英文（30字符以内）';

      const prompt = `你是 YouTube Channel Setup Co-Pilot。请根据以下信息生成完整的频道资产。

【输入信息】
${input}

【输出要求】
请严格按以下格式输出，包含所有字段：

## 频道名称（3个备选方案）
${nameLangReq}
1. [名称1]
2. [名称2]
3. [名称3]

## 头像提示词（3个备选方案，英文，可直接用于AI生成头像）
1. [英文提示词1，描述要专业、清晰、可直接用于AI绘图]
2. [英文提示词2]
3. [英文提示词3]

## 横幅提示词（3个备选方案，英文，可直接用于AI生成横幅）
1. [英文提示词1，包含2560x1440px尺寸要求、品牌元素、安全区等]
2. [英文提示词2]
3. [英文提示词3]

## 频道说明文本（${channelNameLang === 'zh' ? '中文' : channelNameLang === 'en' ? '英文' : '中英双语（先中文后英文）'}，包含价值主张、发布频率、CTA和关键词，950字符内）
[完整的频道说明文本]

## 关键词字段（3个方案：中文/英文/混合，每方案5-10个关键词，用逗号分隔）
方案1（中文）：[关键词1]，[关键词2]，[关键词3]...
方案2（英文）：keyword1, keyword2, keyword3...
方案3（混合）：[关键词1]，keyword2，[关键词3]...

【重要】
- 头像和横幅提示词必须是英文、可直接用于AI生图
- 频道说明要包含CTA（呼吁订阅）
- 只输出上述格式内容，不要有任何解释`;

      addLog(`发送生成请求到 gemini-3.1-pro-preview`, 'debug', `温度: 0.7`);
      addLog(`输入信息: 主题=${channelTopic.substring(0, 30)}...`, 'debug');

      let result = '';
      await streamContentGeneration(
        prompt,
        '你是专业YouTube频道品牌策划专家。',
        (chunk) => {
          result += chunk;
        },
        'gemini-3.1-pro-preview',
        { temperature: 0.7 }
      );

      addLog('模型响应接收完成，开始解析...', 'debug', `响应长度: ${result.length} 字符`);

      const output = parseChannelOutput(result);
      if (output) {
        setChannelOutput(output);
        addLog('✓ 频道资产生成成功', 'success', `名称: ${output.names.join(', ')}`);
        toast.success('频道资产生成完成！');
        
        // 生成项目名称（使用第一个频道名称或主题）
        const projectName = output.names[0] || channelTopic.substring(0, 20) || '未命名项目';
        
        // 检查是否已存在相同的项目（基于主题+目标观众+内容类型）
        const existingRecord = channelHistory.find(r => 
          r.topic === channelTopic && 
          r.targetAudience === channelTargetAudience && 
          r.contentType === channelContentType
        );
        
        if (existingRecord) {
          // 更新现有项目：合并图片到原有记录
          addLog(`发现已有项目 "${existingRecord.name}"，更新中...`, 'info');
          // 更新现有记录（稍后处理）
          const finalRecord = {
            ...existingRecord,
            output: {
              ...existingRecord.output,
              avatarUrls: output.avatarUrls || existingRecord.output.avatarUrls,
              bannerUrls: output.bannerUrls || existingRecord.output.bannerUrls,
            },
            updatedAt: Date.now(),
          };
          
          // 异步缓存图片
          if (output.avatarUrls?.some(v => v?.length > 0) || output.bannerUrls?.some(v => v?.length > 0)) {
            try {
              const cached = await cacheImages(output.avatarUrls || [[], [], []], output.bannerUrls || [[], [], []]);
              finalRecord.output = { ...finalRecord.output, ...cached };
              addLog(`✓ 图片已缓存，更新项目 "${existingRecord.name}"`, 'success', `头像: ${cached.avatarUrls.flat().filter(Boolean).length} 张, 横幅: ${cached.bannerUrls.flat().filter(Boolean).length} 张`);
            } catch (cacheErr) {
              addLog(`⚠ 图片缓存失败，但仍更新项目记录`, 'warning');
            }
          }
          
          // 更新历史记录（使用函数式更新避免闭包陷阱）
          setChannelHistory(prev => {
            const updatedHistory = [
              finalRecord,
              ...prev.filter(r => r.id !== existingRecord.id)
            ].slice(0, 20);
            localStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
            return updatedHistory;
          });
          addLog(`✓ 项目 "${existingRecord.name}" 已更新`, 'success');
        } else {
          // 创建新项目
          const newRecord: ChannelHistoryRecord = {
            id: `channel_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            name: projectName,
            topic: channelTopic,
            targetAudience: channelTargetAudience,
            contentType: channelContentType,
            brandPositioning: channelBrandPositioning,
            nameLang: channelNameLang,
            output,
            timestamp: Date.now(),
            updatedAt: Date.now(),
          };
          
          // 异步缓存图片（不阻塞UI）
          if (output.avatarUrls?.some(v => v?.length > 0) || output.bannerUrls?.some(v => v?.length > 0)) {
            try {
              const cached = await cacheImages(output.avatarUrls || [[], [], []], output.bannerUrls || [[], [], []]);
              newRecord.output = { ...newRecord.output, ...cached };
              addLog(`✓ 图片已缓存到新项目 "${projectName}"`, 'success', `头像: ${cached.avatarUrls.flat().filter(Boolean).length} 张, 横幅: ${cached.bannerUrls.flat().filter(Boolean).length} 张`);
            } catch (cacheErr) {
              addLog(`⚠ 图片缓存失败，项目 "${projectName}" 已创建`, 'warning');
              saveChannelHistory(newRecord);
            }
            saveChannelHistory(newRecord);
          } else {
            saveChannelHistory(newRecord);
            addLog(`✓ 新项目 "${projectName}" 已创建`, 'success');
          }
        }
      } else {
        throw new Error('解析生成结果失败');
      }
    } catch (e: any) {
      addLog(`✗ 频道资产生成失败: ${e?.message || e}`, 'error');
      toast.error('生成失败：' + (e?.message || e));
    } finally {
      setIsGeneratingChannel(false);
    }
  };

  // 重新生成频道说明（基于选定的频道名）
  const regenerateDescription = async () => {
    if (!apiKey?.trim()) {
      addLog('请先配置 API Key', 'warning');
      toast.error('请先配置 API Key');
      return;
    }
    if (!channelOutput?.names?.length) {
      addLog('请先生成频道资产', 'warning');
      toast.warning('请先生成频道资产');
      return;
    }

    const selectedName = channelOutput.names[selectedNameForDesc];
    if (!selectedName) {
      addLog('请选择一个频道名称', 'warning');
      toast.warning('请选择一个频道名称');
      return;
    }

    setIsGeneratingChannel(true);
    addLog(`开始重新生成频道说明...`, 'info', `使用名称: ${selectedName}`);

    try {
      const { initializeGemini } = await import('../services/geminiService');
      initializeGemini(apiKey, { provider });

      const descPrompt = `请基于以下信息，为YouTube频道生成一段专业的频道说明（About）：

频道名称：${selectedName}
频道主题：${channelTopic}
目标观众：${channelTargetAudience || '未指定'}
内容类型：${channelContentType || '未指定'}
品牌定位：${channelBrandPositioning || '未指定'}

要求：
1. 200-500字，包含频道定位、内容特色、更新时间、联系方式等要素
2. 使用emoji增加可读性
3. 格式清晰，段落分明
4. 突出频道独特卖点

请直接输出频道说明，不要其他解释。`;

      addLog(`发送频道说明请求到 gemini-3.1-pro-preview`, 'debug');

      const result = await streamContentGeneration(
        descPrompt,
        () => {},
        { temperature: 0.7 },
        'gemini-3.1-pro-preview'
      );

      if (result) {
        setChannelOutput(prev => prev ? { ...prev, description: result.trim() } : null);
        addLog('✓ 频道说明重新生成成功', 'success');
        toast.success('频道说明已重新生成');
      }
    } catch (e: any) {
      addLog(`✗ 频道说明生成失败: ${e?.message || e}`, 'error');
      toast.error('生成说明失败：' + (e?.message || e));
    } finally {
      setIsGeneratingChannel(false);
    }
  };

  const parseChannelOutput = (text: string): {
    names: string[];
    avatarPrompts: string[];
    bannerPrompts: string[];
    description: string;
    keywords: string[];
    avatarUrls?: string[];
    bannerUrls?: string[];
  } | null => {
    try {
      const lines = text.split('\n');
      let section = '';
      const names: string[] = [];
      const avatarPrompts: string[] = [];
      const bannerPrompts: string[] = [];
      let description = '';
      const keywords: string[] = [];
      let currentList: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        
        if (trimmed.includes('频道名称') || trimmed.match(/^#+\s*频道名称/)) {
          section = 'names';
          currentList = names;
        } else if (trimmed.includes('头像提示词') || trimmed.match(/^#+\s*头像/)) {
          section = 'avatar';
          currentList = avatarPrompts;
        } else if (trimmed.includes('横幅提示词') || trimmed.match(/^#+\s*横幅/)) {
          section = 'banner';
          currentList = bannerPrompts;
        } else if (trimmed.includes('频道说明') || trimmed.match(/^#+\s*频道说明/)) {
          section = 'description';
        } else if (trimmed.includes('关键词') || trimmed.match(/^#+\s*关键词/)) {
          section = 'keywords';
        } else if (section === 'names' || section === 'avatar' || section === 'banner') {
          const match = trimmed.match(/^\d+[\.、:：]\s*(.+)/) || trimmed.match(/^[a-z][\.、:：]\s*(.+)/i);
          if (match) {
            currentList.push(match[1].trim());
          }
        } else if (section === 'description' && trimmed.length > 20) {
          description += (description ? '\n' : '') + trimmed;
        } else if (section === 'keywords') {
          const kwMatch = trimmed.match(/方案\d+[（(]?[^{}（）()]+[）)]?[:：]\s*(.+)/);
          if (kwMatch) {
            keywords.push(kwMatch[1].trim());
          }
        }
      }

      while (names.length < 3) names.push(`Channel ${names.length + 1}`);
      while (avatarPrompts.length < 3) avatarPrompts.push('Professional channel avatar');
      while (bannerPrompts.length < 3) bannerPrompts.push('YouTube banner 2560x1440px');
      while (keywords.length < 3) keywords.push(keywords[0] || '');

      return {
        names: names.slice(0, 3),
        avatarPrompts: avatarPrompts.slice(0, 3),
        bannerPrompts: bannerPrompts.slice(0, 3),
        description: description.slice(0, 1000),
        keywords: keywords.slice(0, 3),
        avatarUrls: [[], [], []],
        bannerUrls: [[], [], []],
      };
    } catch (e) {
      console.error('解析频道输出失败:', e);
      return null;
    }
  };

  const generateAvatarImage = async (index: number, styleOverride?: number) => {
    if (!channelOutput?.avatarPrompts?.[index]) return;
    
    // 标记为生成中
    setGeneratingAvatars(prev => [...prev, index]);
    const prompt = channelOutput.avatarPrompts[index];
    
    // 获取当前风格选择（使用传入的styleOverride或已选风格，-1表示自动按顺序）
    const selectedStyle = styleOverride !== undefined ? styleOverride : (avatarStyleSelections[index] ?? -1);
    const styleIndex = selectedStyle === -1 ? index : selectedStyle;
    const styleDef = avatarStyleDefinitions[styleIndex];
    const channelName = channelOutput.names[index] || 'Channel';
    
    // 检查风格是否需要包含频道名（动漫和美漫默认包含）
    const includeChannelName = styleIndex !== 1 && styleIndex !== 2;
    
    addLog(`[头像] 方案${index + 1} 开始生成 (${styleDef.name}风格)`, 'info');
    
    try {
      let result: { success: boolean; url?: string; error?: string } | null = null;
      
      // 构建提示词
      let fullPrompt = `${prompt}\n\nStyle: ${styleDef.desc}`;
      if (includeChannelName) {
        fullPrompt += `\n\nIncorporate the channel name "${channelName}" creatively into the design.`;
      }
      fullPrompt += '\n\nYouTube channel avatar, circular or square profile image, high quality, professional look, clean composition.';
      
      // 首次尝试
      try {
        result = await generateImage(apiKey, {
          model: COVER_GEMINI_IMAGE_MODEL,
          prompt: fullPrompt,
          size: '1024x1024',
          quality: 'high',
          n: 1,
        });
      } catch (e) {
        // 首次失败，尝试重试一次
        addLog(`[头像] 方案${index + 1} 首次失败，尝试重试...`, 'warning');
        await new Promise(resolve => setTimeout(resolve, 2000));
        result = await generateImage(apiKey, {
          model: COVER_GEMINI_IMAGE_MODEL,
          prompt: fullPrompt,
          size: '1024x1024',
          quality: 'high',
          n: 1,
        });
      }

      if (result.success && result.url) {
        // 使用函数式更新确保正确获取最新状态
        setChannelOutput(prev => {
          if (!prev) return prev;
          const newImages = prev.avatarUrls ? [...prev.avatarUrls] : [[], [], []];
          const currentArray = newImages[index] ? [...newImages[index]] : [];
          currentArray.push(result!.url!);
          // 限制每个方案最多保存3个版本
          if (currentArray.length > 3) {
            currentArray.shift();
          }
          newImages[index] = currentArray;
          return { ...prev, avatarUrls: newImages };
        });
        
        // 异步缓存图片并更新历史记录
        const newAvatarUrls = channelOutput.avatarUrls ? [...channelOutput.avatarUrls] : [[], [], []];
        const arr = newAvatarUrls[index] ? [...newAvatarUrls[index]] : [];
        arr.push(result.url);
        if (arr.length > 3) arr.shift();
        newAvatarUrls[index] = arr;
        
        const currentBannerUrls = channelOutput.bannerUrls || [[], [], []];
        
        (async () => {
          try {
            const cached = await cacheImages(newAvatarUrls, currentBannerUrls);
            // 更新历史记录（使用函数式更新避免闭包陷阱）
            setChannelHistory(prev => {
              if (prev.length === 0) return prev;
              const updatedRecord = {
                ...prev[0],
                output: {
                  ...prev[0].output,
                  avatarUrls: cached.avatarUrls,
                  bannerUrls: cached.bannerUrls,
                },
                updatedAt: Date.now(),
              };
              const updatedHistory = [updatedRecord, ...prev.slice(1)].slice(0, 20);
              localStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
              addLog(`✓ 头像已缓存，更新项目 "${prev[0].name}"`, 'success', `头像: ${cached.avatarUrls.flat().filter(Boolean).length} 张`);
              return updatedHistory;
            });
          } catch (cacheErr) {
            addLog(`⚠ 图片缓存失败`, 'warning');
          }
        })();
        
        addLog(`[头像] 方案${index + 1} 生成成功！(${styleDef.name}风格)`, 'success');
        toast.success(`头像生成成功！(${styleDef.name}风格)`);
      } else {
        addLog(`[头像] 方案${index + 1} 生成失败：${result.error || '未知错误'}`, 'error');
        toast.error('头像生成失败：' + (result.error || '未知错误'));
      }
    } catch (e: any) {
      addLog(`[头像] 方案${index + 1} 生成失败：${e?.message || e}`, 'error');
      toast.error('生成失败：' + (e?.message || e));
    } finally {
      // 移除生成中状态
      setGeneratingAvatars(prev => prev.filter(i => i !== index));
    }
  };

  // 并行生成所有头像
  const generateAllAvatars = async () => {
    if (!channelOutput?.avatarPrompts?.length) return;
    addLog('[头像] 开始并行生成所有头像方案...', 'info');
    const promises = channelOutput.avatarPrompts.map((_, i) => generateAvatarImage(i));
    await Promise.allSettled(promises);
    addLog('[头像] 所有头像方案生成完成', 'success');
  };

  const generateBannerImage = async (index: number, styleOverride?: number) => {
    if (!channelOutput?.bannerPrompts?.[index]) return;
    
    // 标记为生成中
    setGeneratingBanners(prev => [...prev, index]);
    const prompt = channelOutput.bannerPrompts[index];
    
    // 获取当前风格选择（使用传入的styleOverride或已选风格，-1表示自动按顺序）
    const selectedStyle = styleOverride !== undefined ? styleOverride : (bannerStyleSelections[index] ?? -1);
    const styleIndex = selectedStyle === -1 ? index : selectedStyle;
    const styleDef = bannerStyleDefinitions[styleIndex];
    const channelName = channelOutput.names[index] || 'Channel';
    
    // 检查频道名称是否包含中文字符
    const hasChineseChars = /[\u4e00-\u9fa5]/.test(channelName);
    
    // 检查风格是否需要包含频道名（电影摄影不带）
    const includeChannelName = styleIndex !== 0;
    
    addLog(`[横幅] 方案${index + 1} 开始生成 (${styleDef.name}风格)`, 'info');
    
    try {
      let result: { success: boolean; url?: string; error?: string } | null = null;
      
      // 构建提示词 - 横幅方案2需要特别注意中文频道名
      let fullPrompt = `${prompt}\n\nStyle: ${styleDef.desc}`;
      
      if (includeChannelName) {
        // 对于包含频道名的横幅，处理中文频道名
        if (hasChineseChars) {
          // 中文频道名需要特殊处理：使用拼音或保持原样
          // 在提示词中明确说明不要在横幅上渲染中文文字（文字渲染可能会出现乱码）
          fullPrompt += `\n\nIMPORTANT: The channel name "${channelName}" contains Chinese characters. DO NOT render Chinese text directly in the banner image as it may appear as garbled text. Instead, incorporate visual elements, symbols, or icons that represent the channel theme. Create an abstract/symbolic design that conveys the channel's essence without readable Chinese characters.`;
        } else {
          fullPrompt += `\n\nIncorporate the channel name "${channelName}" creatively into the design.`;
        }
      }
      fullPrompt += '\n\nYouTube channel banner, wide aspect ratio, high quality, professional look.';
      
      // 清理提示词中的尺寸标注（如 2560x1440px）
      fullPrompt = fullPrompt.replace(/2560\s*[xX×]\s*1440\s*px?/gi, '');
      fullPrompt = fullPrompt.replace(/\d+\s*[xX×]\s*\d+\s*px?/g, '');
      
      // 首次尝试
      try {
        result = await generateImage(apiKey, {
          model: COVER_GEMINI_IMAGE_MODEL,
          prompt: fullPrompt,
          size: '1280x720',
          quality: 'high',
          n: 1,
        });
      } catch (e) {
        // 首次失败，尝试重试一次
        addLog(`[横幅] 方案${index + 1} 首次失败，尝试重试...`, 'warning');
        await new Promise(resolve => setTimeout(resolve, 2000));
        result = await generateImage(apiKey, {
          model: COVER_GEMINI_IMAGE_MODEL,
          prompt: fullPrompt,
          size: '1280x720',
          quality: 'high',
          n: 1,
        });
      }

      if (result.success && result.url) {
        // 使用函数式更新确保正确获取最新状态
        setChannelOutput(prev => {
          if (!prev) return prev;
          const newImages = prev.bannerUrls ? [...prev.bannerUrls] : [[], [], []];
          const currentArray = newImages[index] ? [...newImages[index]] : [];
          currentArray.push(result!.url!);
          // 限制每个方案最多保存3个版本
          if (currentArray.length > 3) {
            currentArray.shift();
          }
          newImages[index] = currentArray;
          return { ...prev, bannerUrls: newImages };
        });
        
        // 异步缓存图片并更新历史记录
        const currentAvatarUrls = channelOutput.avatarUrls || [[], [], []];
        const newBannerUrls = channelOutput.bannerUrls ? [...channelOutput.bannerUrls] : [[], [], []];
        const arr = newBannerUrls[index] ? [...newBannerUrls[index]] : [];
        arr.push(result.url);
        if (arr.length > 3) arr.shift();
        newBannerUrls[index] = arr;
        
        (async () => {
          try {
            const cached = await cacheImages(currentAvatarUrls, newBannerUrls);
            // 更新历史记录（使用函数式更新避免闭包陷阱）
            setChannelHistory(prev => {
              if (prev.length === 0) return prev;
              const updatedRecord = {
                ...prev[0],
                output: {
                  ...prev[0].output,
                  avatarUrls: cached.avatarUrls,
                  bannerUrls: cached.bannerUrls,
                },
                updatedAt: Date.now(),
              };
              const updatedHistory = [updatedRecord, ...prev.slice(1)].slice(0, 20);
              localStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
              addLog(`✓ 横幅已缓存，更新项目 "${prev[0].name}"`, 'success', `横幅: ${cached.bannerUrls.flat().filter(Boolean).length} 张`);
              return updatedHistory;
            });
          } catch (cacheErr) {
            addLog(`⚠ 图片缓存失败`, 'warning');
          }
        })();
        
        addLog(`[横幅] 方案${index + 1} 生成成功！(${styleDef.name}风格)`, 'success');
        toast.success(`横幅生成成功！(${styleDef.name}风格)`);
      } else {
        addLog(`[横幅] 方案${index + 1} 生成失败：${result.error || '未知错误'}`, 'error');
        toast.error('横幅生成失败：' + (result.error || '未知错误'));
      }
    } catch (e: any) {
      addLog(`[横幅] 方案${index + 1} 生成失败：${e?.message || e}`, 'error');
      toast.error('生成失败：' + (e?.message || e));
    } finally {
      // 移除生成中状态
      setGeneratingBanners(prev => prev.filter(i => i !== index));
    }
  };

  // 并行生成所有横幅
  const generateAllBanners = async () => {
    if (!channelOutput?.bannerPrompts?.length) return;
    addLog('[横幅] 开始并行生成所有横幅方案...', 'info');
    const promises = channelOutput.bannerPrompts.map((_, i) => generateBannerImage(i));
    await Promise.allSettled(promises);
    addLog('[横幅] 所有横幅方案生成完成', 'success');
  };

  const handleClear = () => {
    setChannelTopic('');
    setChannelTargetAudience('');
    setChannelContentType('');
    setChannelBrandPositioning('');
    setChannelOutput(null);
    setSelectedNameForDesc(0);
    toast.success('已清空');
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* 标题 */}
      <div className="text-center py-6">
        <h1 className="text-2xl font-bold text-white mb-2 flex items-center justify-center gap-3">
          <Youtube size={28} className="text-red-500" />
          YouTube 频道生成器
        </h1>
        <p className="text-slate-400 text-sm">快速生成专业频道名称、头像横幅提示词、频道说明和关键词</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 左侧：输入区域 */}
        <div className="flex flex-col gap-4">
          <div className="bg-slate-800/50 p-6 rounded-xl border border-slate-700">
            <h3 className="text-sm font-semibold text-emerald-300 mb-4 flex items-center gap-2">
              <Wand2 size={16} />
              频道信息输入
            </h3>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">频道主题 *</label>
                <textarea
                  value={channelTopic}
                  onChange={(e) => setChannelTopic(e.target.value)}
                  placeholder="例如：生物大战长视频、历史对比、奇特组合..."
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 resize-none focus:outline-none focus:border-emerald-500"
                  rows={2}
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">目标观众</label>
                <textarea
                  value={channelTargetAudience}
                  onChange={(e) => setChannelTargetAudience(e.target.value)}
                  placeholder="例如：喜欢历史对比、生物科普、奇特组合的观众"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 resize-none focus:outline-none focus:border-emerald-500"
                  rows={2}
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">内容类型</label>
                <textarea
                  value={channelContentType}
                  onChange={(e) => setChannelContentType(e.target.value)}
                  placeholder="例如：长视频，强调时代、数量、体型、能力与规则的对比"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 resize-none focus:outline-none focus:border-emerald-500"
                  rows={2}
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">品牌定位</label>
                <textarea
                  value={channelBrandPositioning}
                  onChange={(e) => setChannelBrandPositioning(e.target.value)}
                  placeholder="例如：高冲击力、专业、极具视觉张力"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-200 resize-none focus:outline-none focus:border-emerald-500"
                  rows={2}
                />
              </div>
            </div>
            
            {/* 语言选择 */}
            <div className="mt-4 pt-4 border-t border-slate-700">
              <label className="text-xs text-slate-400 mb-2.5 block">频道名称语言</label>
              <div className="flex gap-2">
                {[
                  { value: 'both', label: '中英各半' },
                  { value: 'zh', label: '中文' },
                  { value: 'en', label: '英文' },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setChannelNameLang(opt.value as 'zh' | 'en' | 'both')}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                      channelNameLang === opt.value
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            
            <div className="flex gap-3 mt-5">
              <button
                onClick={generateChannelAssets}
                disabled={isGeneratingChannel || !channelTopic.trim()}
                className="flex-1 px-4 py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:from-slate-600 disabled:to-slate-600 text-white text-sm font-semibold rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg disabled:shadow-none"
              >
                {isGeneratingChannel ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    生成中...
                  </>
                ) : (
                  <>
                    <Wand2 size={16} />
                    生成频道资产
                  </>
                )}
              </button>
              <button
                onClick={handleClear}
                className="px-4 py-3 bg-rose-600 hover:bg-rose-500 text-white text-sm font-medium rounded-lg transition-all"
              >
                清空
              </button>
            </div>
            
            {/* 历史记录入口 */}
            <div className="mt-3 pt-3 border-t border-slate-700">
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="w-full px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded-lg transition-all flex items-center justify-center gap-2"
              >
                <Clock size={12} />
                {showHistory ? '收起历史记录' : `历史记录${channelHistory.length > 0 ? `（${channelHistory.length}条）` : '（暂无记录）'}`}
              </button>
              
              {showHistory && (
                <div className="mt-2 space-y-2 max-h-60 overflow-y-auto">
                  {channelHistory.length > 0 ? (
                    <>
                      {channelHistory.map((record, idx) => (
                        <div key={record.id} className="bg-slate-900/80 rounded-lg p-3 border border-slate-700">
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[10px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
                                {new Date(record.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                              </span>
                              <span className="text-xs font-medium text-emerald-400">{record.name}</span>
                              {record.timestamp !== record.updatedAt && (
                                <span className="text-[10px] text-slate-500">
                                  (修改于 {new Date(record.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })})
                                </span>
                              )}
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => loadFromHistory(record)}
                                className="text-xs text-emerald-400 hover:text-emerald-300"
                              >
                                加载
                              </button>
                              <button
                                onClick={() => deleteChannelHistory(record.id)}
                                className="text-xs text-rose-400 hover:text-rose-300"
                              >
                                <Trash2 size={10} />
                              </button>
                            </div>
                          </div>
                          <p className="text-xs text-slate-500 line-clamp-1">主题：{record.topic}</p>
                          <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">
                            {record.output.names[0] || '未命名'}
                            {record.output.names[1] ? ` / ${record.output.names[1]}` : ''}
                            {record.output.names[2] ? ` / ${record.output.names[2]}` : ''}
                          </p>
                          {/* 历史图片缩略图 */}
                          {(record.output.avatarUrls?.some(v => v?.length > 0) || record.output.bannerUrls?.some(v => v?.length > 0)) && (
                            <div className="flex gap-2 mt-2 flex-wrap">
                              {record.output.avatarUrls?.flat().slice(0, 6).map((url, i) => (
                                <img key={`av-${i}`} src={url} alt="avatar" className="w-8 h-8 rounded object-cover border border-blue-600" />
                              ))}
                              {record.output.bannerUrls?.flat().slice(0, 6).map((url, i) => (
                                <img key={`bn-${i}`} src={url} alt="banner" className="w-12 h-6 rounded object-cover border border-purple-600" />
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                      <button
                        onClick={clearChannelHistory}
                        className="w-full px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-500 text-xs rounded-lg transition-all"
                      >
                        清空全部历史
                      </button>
                    </>
                  ) : (
                    <div className="bg-slate-900/80 rounded-lg p-4 border border-slate-700 text-center">
                      <Clock size={24} className="text-slate-600 mx-auto mb-2" />
                      <p className="text-xs text-slate-500">暂无历史记录</p>
                      <p className="text-xs text-slate-600 mt-1">生成频道后会自动保存到这里</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 右侧：生成结果 + 终端日志 */}
        <div className="flex flex-col gap-4">
          {channelOutput ? (
            <div className="bg-slate-800/50 p-6 rounded-xl border border-slate-700 space-y-5 overflow-y-auto max-h-[600px]">
              {/* 频道名称 */}
              <div>
                <h4 className="text-sm font-semibold text-emerald-300 mb-3 flex items-center gap-2">
                  <Youtube size={14} />
                  频道名称（3个方案，点击选择用于频道说明）
                </h4>
                <div className="space-y-2">
                  {channelOutput.names.map((name, i) => (
                    <div key={i} className="bg-slate-900/80 rounded-lg p-3 border border-slate-700">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-slate-500">方案 {i + 1}</span>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setSelectedNameForDesc(i)}
                            className={`text-xs px-2 py-0.5 rounded ${
                              selectedNameForDesc === i
                                ? 'bg-emerald-600 text-white'
                                : 'text-slate-400 hover:text-emerald-300'
                            }`}
                          >
                            {selectedNameForDesc === i ? '已选择' : '用于说明'}
                          </button>
                          <button
                            onClick={() => navigator.clipboard.writeText(name)}
                            className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                          >
                            <Copy size={10} /> 复制
                          </button>
                        </div>
                      </div>
                      <p className="text-sm text-slate-200 font-medium">{name}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* 头像提示词 */}
              <div>
                <h4 className="text-sm font-semibold text-blue-300 mb-3 flex items-center gap-2">
                  <Image size={14} />
                  头像提示词（3个方案，点击生图）
                  {generatingAvatars.length > 0 && (
                    <span className="ml-auto text-xs text-blue-400 flex items-center gap-1">
                      <Loader2 size={10} className="animate-spin" />
                      生成中 {generatingAvatars.length}个
                    </span>
                  )}
                  <button
                    onClick={generateAllAvatars}
                    disabled={generatingAvatars.length > 0 || !channelOutput?.avatarPrompts?.length}
                    className="ml-auto text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:opacity-50 text-white flex items-center gap-1 cursor-pointer"
                  >
                    <Wand2 size={10} />
                    全部生成
                  </button>
                </h4>
                <div className="space-y-2">
                  {channelOutput.avatarPrompts.map((prompt, i) => (
                    <div key={i} className="bg-slate-900/80 rounded-lg p-3 border border-slate-700">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-500">方案 {i + 1}</span>
                          {/* 风格选择下拉菜单 */}
                          <select
                            value={avatarStyleSelections[i] ?? -1}
                            onChange={(e) => {
                              const val = parseInt(e.target.value);
                              setAvatarStyleSelections(prev => ({ ...prev, [i]: val }));
                            }}
                            className="text-xs bg-slate-800 text-blue-400 rounded px-1 py-0.5 border border-slate-600 cursor-pointer"
                          >
                            <option value={-1}>自动(方案{i+1})</option>
                            <option value={0}>真实摄影</option>
                            <option value={1}>动漫插画</option>
                            <option value={2}>美漫画风</option>
                          </select>
                        </div>
                        <button
                          onClick={() => generateAvatarImage(i)}
                          disabled={generatingAvatars.includes(i)}
                          className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                        >
                          {generatingAvatars.includes(i) ? (
                            <>
                              <Loader2 size={10} className="animate-spin" />
                              生成中...
                            </>
                          ) : (
                            <>
                              <Image size={10} />
                              生图
                            </>
                          )}
                        </button>
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed">{prompt}</p>
                      {channelOutput.avatarUrls?.[i]?.length ? (
                        <div className="mt-2">
                          {/* 显示所有版本的缩略图 */}
                          <div className="flex gap-1 flex-wrap">
                            {channelOutput.avatarUrls[i].map((url, vIdx) => (
                              <div key={vIdx} className="relative group">
                                <img
                                  src={url}
                                  alt={`Avatar ${i + 1} v${vIdx + 1}`}
                                  className="rounded-lg w-16 h-16 object-cover border border-slate-600 cursor-pointer hover:border-blue-500 transition-colors"
                                  onClick={() => openImagePreview(url, `头像方案${i + 1} v${vIdx + 1}`, prompt)}
                                />
                                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center gap-1">
                                  <button
                                    onClick={() => openImagePreview(url, `头像方案${i + 1} v${vIdx + 1}`, prompt)}
                                    className="p-1 bg-blue-600 hover:bg-blue-500 rounded"
                                    title="预览"
                                  >
                                    <Maximize2 size={10} />
                                  </button>
                                  <a
                                    href={url}
                                    download={`avatar-${i + 1}-v${vIdx + 1}.png`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="p-1 bg-emerald-600 hover:bg-emerald-500 rounded"
                                    title="下载"
                                  >
                                    <Download size={10} />
                                  </a>
                                </div>
                              </div>
                            ))}
                          </div>
                          {/* 重新生成按钮 */}
                          <button
                            onClick={() => generateAvatarImage(i)}
                            disabled={generatingAvatars.includes(i)}
                            className="mt-2 text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 cursor-pointer disabled:opacity-50"
                          >
                            {generatingAvatars.includes(i) ? (
                              <>
                                <Loader2 size={12} className="animate-spin" />
                                生成中...
                              </>
                            ) : (
                              <>
                                <Wand2 size={12} />
                                重新生成
                              </>
                            )}
                          </button>
                        </div>
                      ) : generatingAvatars.includes(i) ? (
                        <div className="mt-2 flex items-center gap-2 text-xs text-blue-400">
                          <Loader2 size={14} className="animate-spin" />
                          生成中...
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>

              {/* 横幅提示词 */}
              <div>
                <h4 className="text-sm font-semibold text-purple-300 mb-3 flex items-center gap-2">
                  <Image size={14} />
                  横幅提示词（3个方案，点击生图）
                  {generatingBanners.length > 0 && (
                    <span className="ml-auto text-xs text-purple-400 flex items-center gap-1">
                      <Loader2 size={10} className="animate-spin" />
                      生成中 {generatingBanners.length}个
                    </span>
                  )}
                  <button
                    onClick={generateAllBanners}
                    disabled={generatingBanners.length > 0 || !channelOutput?.bannerPrompts?.length}
                    className="ml-auto text-xs px-2 py-1 rounded bg-purple-600 hover:bg-purple-500 disabled:bg-slate-600 disabled:opacity-50 text-white flex items-center gap-1 cursor-pointer"
                  >
                    <Wand2 size={10} />
                    全部生成
                  </button>
                </h4>
                <div className="space-y-2">
                  {channelOutput.bannerPrompts.map((prompt, i) => (
                    <div key={i} className="bg-slate-900/80 rounded-lg p-3 border border-slate-700">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-500">方案 {i + 1}</span>
                          {/* 风格选择下拉菜单 */}
                          <select
                            value={bannerStyleSelections[i] ?? -1}
                            onChange={(e) => {
                              const val = parseInt(e.target.value);
                              setBannerStyleSelections(prev => ({ ...prev, [i]: val }));
                            }}
                            className="text-xs bg-slate-800 text-purple-400 rounded px-1 py-0.5 border border-slate-600 cursor-pointer"
                          >
                            <option value={-1}>自动(方案{i+1})</option>
                            <option value={0}>电影摄影</option>
                            <option value={1}>纸艺拼贴</option>
                            <option value={2}>等轴测插画</option>
                          </select>
                        </div>
                        <button
                          onClick={() => generateBannerImage(i)}
                          disabled={generatingBanners.includes(i)}
                          className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                        >
                          {generatingBanners.includes(i) ? (
                            <>
                              <Loader2 size={10} className="animate-spin" />
                              生成中...
                            </>
                          ) : (
                            <>
                              <Image size={10} />
                              生图
                            </>
                          )}
                        </button>
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed break-words">{prompt}</p>
                      {channelOutput.bannerUrls?.[i]?.length ? (
                        <div className="mt-2">
                          {/* 显示所有版本的缩略图 */}
                          <div className="flex gap-1 flex-wrap">
                            {channelOutput.bannerUrls[i].map((url, vIdx) => (
                              <div key={vIdx} className="relative group cursor-pointer" onClick={() => openImagePreview(url, `横幅方案${i + 1} v${vIdx + 1}`, prompt)}>
                                <img
                                  src={url}
                                  alt={`Banner ${i + 1} v${vIdx + 1}`}
                                  className="rounded-lg w-32 h-16 object-cover border border-slate-600 hover:border-purple-500 transition-colors"
                                />
                                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center gap-1">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openImagePreview(url, `横幅方案${i + 1} v${vIdx + 1}`, prompt);
                                    }}
                                    className="p-1 bg-purple-600 hover:bg-purple-500 rounded"
                                    title="预览"
                                  >
                                    <Maximize2 size={10} />
                                  </button>
                                  <a
                                    href={url}
                                    download={`banner-${i + 1}-v${vIdx + 1}.png`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="p-1 bg-emerald-600 hover:bg-emerald-500 rounded"
                                    title="下载"
                                  >
                                    <Download size={10} />
                                  </a>
                                </div>
                              </div>
                            ))}
                          </div>
                          {/* 重新生成按钮 */}
                          <button
                            onClick={() => generateBannerImage(i)}
                            disabled={generatingBanners.includes(i)}
                            className="mt-2 text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1 cursor-pointer disabled:opacity-50"
                          >
                            {generatingBanners.includes(i) ? (
                              <>
                                <Loader2 size={12} className="animate-spin" />
                                生成中...
                              </>
                            ) : (
                              <>
                                <Wand2 size={12} />
                                重新生成
                              </>
                            )}
                          </button>
                        </div>
                      ) : generatingBanners.includes(i) ? (
                        <div className="mt-2 flex items-center gap-2 text-xs text-purple-400">
                          <Loader2 size={14} className="animate-spin" />
                          生成中...
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>

              {/* 频道说明 */}
              <div>
                <h4 className="text-sm font-semibold text-amber-300 mb-3 flex items-center gap-2">
                  <Youtube size={14} />
                  频道说明（已选择：{channelOutput.names[selectedNameForDesc] || '方案1'}）
                  <button
                    onClick={() => regenerateDescription()}
                    disabled={isGeneratingChannel}
                    className="ml-auto text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700"
                  >
                    <Wand2 size={10} />
                    重新生成
                  </button>
                </h4>
                <div className="bg-slate-900/80 rounded-lg p-3 border border-slate-700">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-slate-500">{channelOutput.description.length} 字符</span>
                    <button
                      onClick={() => navigator.clipboard.writeText(channelOutput.description)}
                      className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                    >
                      <Copy size={10} /> 复制
                    </button>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{channelOutput.description}</p>
                </div>
              </div>

              {/* 关键词 */}
              <div>
                <h4 className="text-sm font-semibold text-rose-300 mb-3">关键词字段</h4>
                <div className="bg-slate-900/80 rounded-lg p-3 border border-slate-700">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-slate-500">3个方案（中文/英文/混合）</span>
                    <button
                      onClick={() => navigator.clipboard.writeText(channelOutput.keywords.join('\n\n'))}
                      className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                    >
                      <Copy size={10} /> 复制全部
                    </button>
                  </div>
                  <div className="space-y-2">
                    {channelOutput.keywords.map((kw, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className="text-xs text-slate-500 shrink-0">方案{i + 1}：</span>
                        <p className="text-xs text-slate-300">{kw}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-slate-800/50 p-12 rounded-xl border border-slate-700 flex flex-col items-center justify-center text-center h-full min-h-[400px]">
              <Youtube size={64} className="text-slate-600 mb-4" />
              <p className="text-slate-400 text-sm mb-2">填写左侧频道信息</p>
              <p className="text-slate-500 text-sm">点击"生成频道资产"开始</p>
              <div className="mt-6 text-xs text-slate-600 space-y-1">
                <p>将为你生成：</p>
                <p>频道名称（3个方案）</p>
                <p>头像提示词（3个方案）</p>
                <p>横幅提示词（3个方案）</p>
                <p>频道说明文本</p>
                <p>关键词字段</p>
              </div>
            </div>
          )}

          {/* 终端日志窗口 - 始终显示 */}
          <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                <Terminal size={14} />
                操作日志
                {terminalLogs.length > 0 && (
                  <span className="text-xs text-slate-500 ml-1">({terminalLogs.length})</span>
                )}
              </h4>
              <button
                onClick={clearLogs}
                className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-400 flex items-center gap-1"
              >
                <Trash2 size={10} />
                清空
              </button>
            </div>
            <div
              ref={terminalRef}
              className="bg-slate-950 rounded-lg p-3 border border-slate-800 h-64 overflow-y-auto font-mono text-xs"
            >
              {terminalLogs.length === 0 ? (
                <div className="text-slate-600 flex items-center gap-2">
                  <span className="animate-pulse">●</span>
                  等待操作...
                </div>
              ) : (
                <div className="space-y-0.5">
                  {terminalLogs.map((log) => (
                    <div key={log.id} className="group">
                      <div className="flex items-start gap-2 py-0.5 hover:bg-slate-900/50 px-1 rounded cursor-pointer" title={log.details || '无详细信息'}>
                        <span className="text-slate-600 shrink-0 w-16">
                          {log.timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                        <span className={
                          log.type === 'success' ? 'text-emerald-400' :
                          log.type === 'error' ? 'text-rose-400' :
                          log.type === 'warning' ? 'text-amber-400' :
                          log.type === 'debug' ? 'text-cyan-400' :
                          'text-blue-300'
                        }>
                          {log.type === 'success' ? '✓' :
                           log.type === 'error' ? '✗' :
                           log.type === 'warning' ? '⚠' :
                           log.type === 'debug' ? '◆' : '●'} {log.message}
                        </span>
                        {log.details && (
                          <span className="text-slate-600 text-[10px] ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            [{log.details}]
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 图片预览模态框 */}
      {previewImage && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setPreviewImage(null)}
        >
          <div
            className="relative max-w-4xl w-full bg-slate-900 rounded-xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-slate-700">
              <div>
                <h3 className="text-white font-medium">{previewImage.title}</h3>
                <p className="text-slate-400 text-xs mt-1 max-w-md truncate">{previewImage.prompt}</p>
              </div>
              <button
                onClick={() => setPreviewImage(null)}
                className="text-slate-400 hover:text-white p-2"
              >
                <X size={20} />
              </button>
            </div>
            <div className="p-4 flex justify-center bg-slate-950">
              <img
                src={previewImage.url}
                alt={previewImage.title}
                className="max-h-[60vh] object-contain rounded-lg"
              />
            </div>
            <div className="flex gap-3 p-4 border-t border-slate-700">
              <button
                onClick={() => navigator.clipboard.writeText(previewImage.prompt)}
                className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg flex items-center justify-center gap-2"
              >
                <Copy size={14} />
                复制提示词
              </button>
              <a
                href={previewImage.url}
                download={`${previewImage.title}.png`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-lg flex items-center justify-center gap-2"
              >
                <Download size={14} />
                下载图片
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
