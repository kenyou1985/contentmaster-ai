import React, { useState, useRef, useEffect } from 'react';
import { ApiProvider, ToolMode, NicheType } from '../types';
import { generateImage, generateVideo, ImageGenerationOptions, VideoGenerationOptions } from '../services/yunwuService';
import { Upload, FileText, Image as ImageIcon, Video, Play, Download, Edit2, Save, X, Loader2, Plus, Trash2, RefreshCw, Settings, FolderOpen, Rocket, Copy, Check, CheckSquare, Square } from 'lucide-react';
import JSZip from 'jszip';
import { HistorySelector } from './HistorySelector';
import { getHistory, HistoryRecord } from '../services/historyService';

interface MediaGeneratorProps {
  apiKey: string;
  provider: ApiProvider;
}

// 镜头数据接口
interface Shot {
  id: string;
  number: number;
  caption: string;
  imagePrompt: string;
  videoPrompt: string;
  shotType: string;
  voiceOver: string;
  soundEffect: string;
  imageUrls?: string[]; // 支持多张图片
  videoUrl?: string;
  imageGenerating?: boolean;
  videoGenerating?: boolean;
  selected?: boolean;
  editing?: boolean;
}

// 图片模型配置（根据yunwu.ai文档）
const IMAGE_MODELS = [
  { id: 'dall-e-3', name: 'DALL·E 3', endpoint: '/v1/images/generations' },
  { id: 'sora-image', name: 'Sora Image', endpoint: '/v1/chat/completions' }, // 使用 chat/completions
  { id: 'banana', name: 'Banana (Gemini 2.5 Flash)', endpoint: '/v1/images/generations', apiModelName: 'gemini-2.5-flash-image' },
  { id: 'banana-2', name: 'Banana 2 (Gemini 3 Pro)', endpoint: '/v1/images/generations', apiModelName: 'gemini-3-pro-image-preview' },
  { id: 'flux-1-kontext-dev', name: 'Flux 1 Kontext Dev', endpoint: '/v1/images/generations', apiModelName: 'flux.1-kontext-dev' }, // 注意：API 名称使用点号
  { id: 'grok-3-image', name: 'Grok 3 Image', endpoint: '/v1/chat/completions' }, // 使用 chat/completions
  { id: 'grok-4-image', name: 'Grok 4 Image', endpoint: '/v1/chat/completions' }, // 使用 chat/completions
];

// 视频模型配置（根据yunwu.ai文档）
const VIDEO_MODELS = [
  { id: 'sora-2-all', name: 'Sora 2 All', endpoint: '/v1/videos', duration: 10 }, // 支持 /v1/videos 和 /v1/video/create（自动尝试）
  { id: 'sora', name: 'Sora', endpoint: '/v1/videos', duration: 10 }, // 使用 /v1/videos 端点
  { id: 'veo3', name: 'Veo 3', endpoint: '/v1/videos', duration: 10 }, // 使用 /v1/videos 端点
  { id: 'veo3-fast', name: 'Veo 3 Fast', endpoint: '/v1/videos', duration: 10 }, // 使用 /v1/videos 端点
  { id: 'veo_3_1-fast', name: 'Veo 3.1 Fast', endpoint: '/v1/videos', duration: 10 }, // 使用 /v1/videos 端点
  { id: 'veo_3_1-fast-4K', name: 'Veo 3.1 Fast 4K', endpoint: '/v1/videos', duration: 10 }, // 使用 /v1/videos 端点
  { id: 'grok-video-3', name: 'Grok Video 3', endpoint: '/v1/video/create', duration: 10 }, // 使用 /v1/video/create 端点
  { id: 'kling-video-v2.5', name: 'Kling Video v2.5', endpoint: '/v1/videos', duration: 10 }, // 使用 /v1/videos 端点
  { id: 'seedream-v4', name: 'Seedream v4', endpoint: '/v1/videos', duration: 10 }, // 使用 /v1/videos 端点
];

// 图片比例配置
// 注意：DALL-E 3 只支持 1024x1024, 1024x1792, 1792x1024
// Sora Image 只支持三种比例：1:1, 2:3, 3:2
const IMAGE_RATIOS = [
  { id: '1:1', name: '1:1 (正方形)', width: 1024, height: 1024, dallE3Supported: true, soraImageSupported: true },
  { id: '2:3', name: '2:3 (竖屏)', width: 1024, height: 1536, dallE3Supported: false, soraImageSupported: true },
  { id: '3:2', name: '3:2 (横屏)', width: 1536, height: 1024, dallE3Supported: false, soraImageSupported: true },
  { id: '16:9', name: '16:9 (横屏)', width: 1920, height: 1080, dallE3Supported: false, soraImageSupported: false },
  { id: '9:16', name: '9:16 (竖屏)', width: 1080, height: 1920, dallE3Supported: false, soraImageSupported: false },
  { id: '4:3', name: '4:3 (标准)', width: 1024, height: 768, dallE3Supported: false, soraImageSupported: false },
  { id: '3:4', name: '3:4 (竖屏)', width: 768, height: 1024, dallE3Supported: false, soraImageSupported: false },
  // DALL-E 3 专用比例
  { id: 'dall-e-3-portrait', name: 'DALL-E 3 竖屏 (1024x1792)', width: 1024, height: 1792, dallE3Supported: true, soraImageSupported: false },
  { id: 'dall-e-3-landscape', name: 'DALL-E 3 横屏 (1792x1024)', width: 1792, height: 1024, dallE3Supported: true, soraImageSupported: false },
];

// 风格库配置
const STYLE_LIBRARY = [
  { id: 'none', name: '无风格（使用原提示词）', prompt: '' },
  { id: 'anime', name: '二次元风格', prompt: 'anime style, 2D animation, Japanese animation' },
  { id: 'cg-animation', name: 'CG动画', prompt: 'CG animation, 3D rendered, computer graphics' },
  { id: 'photographic', name: '摄影风格', prompt: 'photographic style, professional photography, realistic' },
  { id: 'real-photography', name: '真实摄影', prompt: 'real photography, high quality, professional camera shot' },
  { id: 'cinematic', name: '电影风格', prompt: 'cinematic style, movie quality, dramatic lighting' },
  { id: 'illustration', name: '插画风格', prompt: 'illustration style, artistic, hand-drawn' },
];

export const MediaGenerator: React.FC<MediaGeneratorProps> = ({ apiKey, provider }) => {
  const [scriptText, setScriptText] = useState('');
  const [shots, setShots] = useState<Shot[]>([]);
  const [selectedImageModel, setSelectedImageModel] = useState(IMAGE_MODELS[0].id);
  const [selectedVideoModel, setSelectedVideoModel] = useState(VIDEO_MODELS[0].id);
  const [selectedImageRatio, setSelectedImageRatio] = useState(IMAGE_RATIOS[2].id); // 默认9:16
  const [selectedStyle, setSelectedStyle] = useState(STYLE_LIBRARY[0].id);
  const [editingShotId, setEditingShotId] = useState<string | null>(null);
  const [enlargedImageUrl, setEnlargedImageUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showScriptInput, setShowScriptInput] = useState(false);
  const [generateImageCount, setGenerateImageCount] = useState(1); // 每次生成的图片数量
  const [showScriptHistorySelector, setShowScriptHistorySelector] = useState(false);
  const [scriptHistoryRecords, setScriptHistoryRecords] = useState<HistoryRecord[]>([]);

  // 组件加载时不自动读取，避免读取旧数据
  // 用户需要手动点击"从改写工具读取"按钮来加载最新脚本

  // 解析脚本文本，提取镜头信息
  const parseScript = (text: string): Shot[] => {
    const lines = text.split('\n');
    const parsedShots: Shot[] = [];
    let currentShot: Partial<Shot> | null = null;
    let currentField: string | null = null;
    let fieldContent: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      
      // 检测镜头开始
      const shotMatch = trimmedLine.match(/^(?:镜头|鏡頭)(\d+)/);
      if (shotMatch) {
        // 保存上一个镜头的当前字段
        if (currentShot && currentField && fieldContent.length > 0) {
          const content = fieldContent.join('\n').trim();
          if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
          else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
          else if (currentField === 'caption') currentShot.caption = content;
        }
        fieldContent = [];
        currentField = null;
        
        // 保存上一个镜头
        if (currentShot && currentShot.number) {
          parsedShots.push(currentShot as Shot);
        }
        
        // 创建新镜头
        currentShot = {
          id: `shot-${shotMatch[1]}`,
          number: parseInt(shotMatch[1]),
          caption: '',
          imagePrompt: '',
          videoPrompt: '',
          shotType: '',
          voiceOver: '',
          soundEffect: '',
          selected: false,
        };
        continue;
      }
      
      // 如果当前有镜头，解析字段
      if (currentShot) {
        if (/^镜头文案[：:]/.test(trimmedLine)) {
          if (currentField && fieldContent.length > 0) {
            const content = fieldContent.join('\n').trim();
            if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
            else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
            else if (currentField === 'caption') currentShot.caption = content;
          }
          fieldContent = [];
          currentField = 'caption';
          const match = trimmedLine.match(/^镜头文案[：:]\s*(.+)/);
          if (match && match[1]) {
            // 提取引号内的内容
            const captionMatch = match[1].match(/[""「"]([\s\S]*?)[""」"]/);
            if (captionMatch) {
              fieldContent.push(captionMatch[1]);
            } else {
              fieldContent.push(match[1]);
            }
          }
        } else if (/^(?:图片提示词|圖片提示詞)[：:]/.test(trimmedLine)) {
          if (currentField && fieldContent.length > 0) {
            const content = fieldContent.join('\n').trim();
            if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
            else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
            else if (currentField === 'caption') currentShot.caption = content;
          }
          fieldContent = [];
          currentField = 'imagePrompt';
          const match = trimmedLine.match(/^(?:图片提示词|圖片提示詞)[：:]\s*(.+)/);
          if (match && match[1]) fieldContent.push(match[1]);
        } else if (/^(?:视频提示词|視頻提示詞)[：:]/.test(trimmedLine)) {
          if (currentField && fieldContent.length > 0) {
            const content = fieldContent.join('\n').trim();
            if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
            else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
            else if (currentField === 'caption') currentShot.caption = content;
          }
          fieldContent = [];
          currentField = 'videoPrompt';
          const match = trimmedLine.match(/^(?:视频提示词|視頻提示詞)[：:]\s*(.+)/);
          if (match && match[1]) fieldContent.push(match[1]);
        } else if (/^景别[：:]/.test(trimmedLine) || /^景別[：:]/.test(trimmedLine)) {
          if (currentField && fieldContent.length > 0) {
            const content = fieldContent.join('\n').trim();
            if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
            else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
            else if (currentField === 'caption') currentShot.caption = content;
          }
          fieldContent = [];
          currentField = null;
          const match = trimmedLine.match(/^景别[：:]\s*(.+)/) || trimmedLine.match(/^景別[：:]\s*(.+)/);
          if (match) currentShot.shotType = match[1];
        } else if (/^(?:语音分镜|語音分鏡)[：:]/.test(trimmedLine)) {
          if (currentField && fieldContent.length > 0) {
            const content = fieldContent.join('\n').trim();
            if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
            else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
            else if (currentField === 'caption') currentShot.caption = content;
          }
          fieldContent = [];
          currentField = null;
          const match = trimmedLine.match(/^(?:语音分镜|語音分鏡)[：:]\s*(.+)/);
          if (match) currentShot.voiceOver = match[1];
        } else if (/^音效[：:]/.test(trimmedLine)) {
          if (currentField && fieldContent.length > 0) {
            const content = fieldContent.join('\n').trim();
            if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
            else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
            else if (currentField === 'caption') currentShot.caption = content;
          }
          fieldContent = [];
          currentField = null;
          const match = trimmedLine.match(/^音效[：:]\s*(.+)/);
          if (match) currentShot.soundEffect = match[1];
        } else if (currentField && trimmedLine) {
          fieldContent.push(trimmedLine);
        } else if (!trimmedLine) {
          if (currentField && fieldContent.length > 0) {
            const content = fieldContent.join('\n').trim();
            if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
            else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
            else if (currentField === 'caption') currentShot.caption = content;
          }
          currentField = null;
          fieldContent = [];
        }
      }
    }
    
    // 保存最后一个字段
    if (currentShot && currentField && fieldContent.length > 0) {
      const content = fieldContent.join('\n').trim();
      if (currentField === 'imagePrompt') currentShot.imagePrompt = content;
      else if (currentField === 'videoPrompt') currentShot.videoPrompt = content;
      else if (currentField === 'caption') currentShot.caption = content;
    }
    
    // 保存最后一个镜头
    if (currentShot && currentShot.number) {
      parsedShots.push(currentShot as Shot);
    }
    
    return parsedShots;
  };

  // 处理脚本输入
  const handleScriptInput = (text: string) => {
    setScriptText(text);
    if (text.trim()) {
      const parsed = parseScript(text);
      setShots(parsed);
    } else {
      setShots([]);
    }
  };

  // 处理文件上传
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      handleScriptInput(content);
    };
    reader.readAsText(file);
  };

  // 加载脚本历史记录并显示选择器
  const loadScriptFromTools = () => {
    console.log('[MediaGenerator] ========== 开始读取脚本历史记录 ==========');
    
    // 收集所有可能的脚本历史记录来源
    const allRecords: HistoryRecord[] = [];
    
    // 1. 从 Tools 模块的新历史记录系统读取（SCRIPT 模式）
    const niches = [NicheType.TCM_METAPHYSICS, NicheType.FINANCE_CRYPTO, NicheType.STORY_REVENGE, NicheType.GENERAL_VIRAL];
    niches.forEach(niche => {
      const historyKey = `${ToolMode.SCRIPT}_${niche}`;
      const records = getHistory('tools', historyKey);
      console.log(`[MediaGenerator] 从 ${historyKey} 读取到 ${records.length} 条记录`);
      allRecords.push(...records);
    });
    
    // 2. 从旧的 scriptHistory 读取（保持向后兼容）
    try {
      const historyKey = 'scriptHistory';
      const historyStr = localStorage.getItem(historyKey);
      if (historyStr) {
        const history = JSON.parse(historyStr);
        if (Array.isArray(history)) {
          history.forEach((item: any) => {
            if (item && item.content && item.content.trim()) {
              allRecords.push({
                content: item.content,
                timestamp: item.timestamp || Date.now(),
                metadata: {
                  topic: '脚本历史记录',
                },
              });
            }
          });
          console.log(`[MediaGenerator] 从 scriptHistory 读取到 ${history.length} 条记录`);
        }
      }
    } catch (error) {
      console.error('[MediaGenerator] 读取 scriptHistory 失败:', error);
    }
    
    // 3. 从 lastGeneratedScript 读取（最新脚本）
    try {
      const savedScript = localStorage.getItem('lastGeneratedScript');
      if (savedScript && savedScript.trim()) {
        const hasShots = /(?:镜头|鏡頭)\s*\d+/.test(savedScript);
        if (hasShots) {
          allRecords.unshift({
            content: savedScript,
            timestamp: Date.now(),
            metadata: {
              topic: '最新生成的脚本',
            },
          });
          console.log('[MediaGenerator] 从 lastGeneratedScript 读取到最新脚本');
        }
      }
    } catch (error) {
      console.error('[MediaGenerator] 读取 lastGeneratedScript 失败:', error);
    }
    
    // 按时间戳排序（最新的在前）
    allRecords.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    
    // 去重（相同内容的记录只保留最新的）
    const uniqueRecords: HistoryRecord[] = [];
    const seenContents = new Set<string>();
    allRecords.forEach(record => {
      const contentHash = record.content.trim().substring(0, 200); // 使用前200字符作为哈希
      if (!seenContents.has(contentHash)) {
        seenContents.add(contentHash);
        uniqueRecords.push(record);
      }
    });
    
    console.log(`[MediaGenerator] 总共找到 ${uniqueRecords.length} 条唯一脚本记录`);
    
    if (uniqueRecords.length > 0) {
      // 显示历史记录选择器
      setScriptHistoryRecords(uniqueRecords);
      setShowScriptHistorySelector(true);
    } else {
      // 没有历史记录，提示用户
      alert('未找到脚本历史记录。请先在改写工具中生成脚本。');
    }
  };
  
  // 处理脚本历史记录选择
  const handleScriptHistorySelect = (record: HistoryRecord) => {
    console.log('[MediaGenerator] 选择脚本历史记录:', {
      timestamp: new Date(record.timestamp).toLocaleString(),
      contentLength: record.content.length,
    });
    
    if (record.content && record.content.trim()) {
      // 验证脚本是否包含镜头信息
      const hasShots = /(?:镜头|鏡頭)\s*\d+/.test(record.content);
      const shotCount = (record.content.match(/(?:镜头|鏡頭)\s*\d+/g) || []).length;
      
      if (hasShots && shotCount > 0) {
        // 解析脚本
        const parsed = parseScript(record.content);
        console.log('[MediaGenerator] 解析后的镜头数量:', parsed.length);
        
        if (parsed.length > 0) {
          // 清除当前数据
          setShots([]);
          setScriptText('');
          
          // 加载选中的脚本
          setScriptText(record.content);
          setShots(parsed);
          setShowScriptInput(false);
          setShowScriptHistorySelector(false);
          console.log('[MediaGenerator] ✅ 脚本加载成功，镜头数量:', parsed.length);
        } else {
          alert('脚本解析失败，无法提取镜头信息。');
        }
      } else {
        alert('选中的记录不包含有效的镜头信息。');
      }
    } else {
      alert('选中的记录内容为空。');
    }
  };

  // 更新镜头数据
  const updateShot = (shotId: string, updates: Partial<Shot>) => {
    setShots(prev => prev.map(shot => 
      shot.id === shotId ? { ...shot, ...updates } : shot
    ));
  };

  // 添加新镜头
  const handleAddShot = () => {
    const newShot: Shot = {
      id: `shot-${Date.now()}`,
      number: shots.length + 1,
      caption: '',
      imagePrompt: '',
      videoPrompt: '',
      shotType: '',
      voiceOver: '',
      soundEffect: '',
      selected: false,
      editing: true,
    };
    setShots([...shots, newShot]);
    setEditingShotId(newShot.id);
  };

  // 删除选中镜头
  const handleDeleteSelected = () => {
    const selectedShots = shots.filter(s => s.selected);
    if (selectedShots.length === 0) {
      alert('请先选择要删除的镜头');
      return;
    }
    if (confirm(`确定要删除 ${selectedShots.length} 个镜头吗？`)) {
      setShots(shots.filter(s => !s.selected));
    }
  };

  // 批量选择功能
  const handleSelectAll = () => {
    setShots(prev => prev.map(shot => ({ ...shot, selected: true })));
  };

  const handleDeselectAll = () => {
    setShots(prev => prev.map(shot => ({ ...shot, selected: false })));
  };

  const handleToggleSelect = () => {
    setShots(prev => prev.map(shot => ({ ...shot, selected: !shot.selected })));
  };

  // 批量导出图片为 ZIP
  const handleExportImagesAsZip = async () => {
    const selectedShots = shots.filter(s => s.selected && s.imageUrls && s.imageUrls.length > 0);
    
    if (selectedShots.length === 0) {
      alert('请先选择包含图片的镜头');
      return;
    }

    try {
      const zip = new JSZip();
      let imageCount = 0;

      // 下载并添加每张图片到 ZIP
      for (const shot of selectedShots) {
        if (!shot.imageUrls || shot.imageUrls.length === 0) continue;

        for (let i = 0; i < shot.imageUrls.length; i++) {
          const imageUrl = shot.imageUrls[i];
          try {
            // 获取图片数据
            const response = await fetch(imageUrl);
            if (!response.ok) {
              console.warn(`无法下载图片: ${imageUrl}`);
              continue;
            }

            const blob = await response.blob();
            
            // 确定文件扩展名
            const contentType = response.headers.get('content-type') || 'image/png';
            let extension = 'png';
            if (contentType.includes('jpeg') || contentType.includes('jpg')) {
              extension = 'jpg';
            } else if (contentType.includes('webp')) {
              extension = 'webp';
            } else if (contentType.includes('gif')) {
              extension = 'gif';
            }

            // 如果是 data URL，需要特殊处理
            if (imageUrl.startsWith('data:')) {
              const base64Match = imageUrl.match(/data:([^;]+);base64,(.+)/);
              if (base64Match) {
                const mimeType = base64Match[1];
                const base64Data = base64Match[2];
                extension = mimeType.includes('jpeg') ? 'jpg' : 
                           mimeType.includes('png') ? 'png' : 
                           mimeType.includes('webp') ? 'webp' : 
                           mimeType.includes('gif') ? 'gif' : 'png';
                
                zip.file(`镜头${shot.number}_图片${i + 1}.${extension}`, base64Data, { base64: true });
              } else {
                // 如果 data URL 格式不正确，尝试直接使用 blob
                zip.file(`镜头${shot.number}_图片${i + 1}.${extension}`, blob);
              }
            } else {
              // 普通 URL，使用 blob
              const fileName = `镜头${shot.number}_图片${i + 1}.${extension}`;
              zip.file(fileName, blob);
            }

            imageCount++;
          } catch (error) {
            console.error(`下载图片失败 (镜头${shot.number}, 图片${i + 1}):`, error);
          }
        }
      }

      if (imageCount === 0) {
        alert('没有可导出的图片');
        return;
      }

      // 生成 ZIP 文件并下载
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `镜头图片_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      alert(`成功导出 ${imageCount} 张图片到 ZIP 文件`);
    } catch (error: any) {
      console.error('导出 ZIP 失败:', error);
      alert(`导出失败: ${error.message || '未知错误'}`);
    }
  };

  // 保存编辑
  const handleSaveEdit = (shotId: string) => {
    setEditingShotId(null);
    updateShot(shotId, { editing: false });
  };

  // 获取适合模型的尺寸（DALL-E 3 和 Sora Image 有特殊限制）
  const getImageSize = (model: string, ratioId: string): string => {
    const selectedRatio = IMAGE_RATIOS.find(r => r.id === ratioId);
    if (!selectedRatio) return '1024x1024';
    
    // DALL-E 3 只支持特定尺寸
    if (model === 'dall-e-3') {
      if (selectedRatio.dallE3Supported) {
        return `${selectedRatio.width}x${selectedRatio.height}`;
      } else {
        // 如果不支持，根据比例选择最接近的 DALL-E 3 支持的尺寸
        const aspectRatio = selectedRatio.width / selectedRatio.height;
        if (aspectRatio > 1) {
          // 横屏，使用 1792x1024
          return '1792x1024';
        } else if (aspectRatio < 1) {
          // 竖屏，使用 1024x1792
          return '1024x1792';
        } else {
          // 正方形，使用 1024x1024
          return '1024x1024';
        }
      }
    }
    
    // Sora Image 支持任意比例，使用原始尺寸（比例会在提示词中添加）
    if (model === 'sora-image') {
      // 返回比例格式，用于在提示词中添加【比例】
      return `${selectedRatio.width}x${selectedRatio.height}`;
    }
    
    // 其他模型使用原始尺寸
    return `${selectedRatio.width}x${selectedRatio.height}`;
  };

  // 生成单个图片（支持生成多张）
  const handleGenerateImage = async (shot: Shot, regenerate: boolean = false) => {
    if (!apiKey) {
      alert('请先配置 API Key');
      return;
    }
    
    if (!shot.imagePrompt) {
      alert('该镜头没有图片提示词');
      return;
    }
    
    updateShot(shot.id, { imageGenerating: true });
    
    const selectedRatio = IMAGE_RATIOS.find(r => r.id === selectedImageRatio);
    const selectedStyleObj = STYLE_LIBRARY.find(s => s.id === selectedStyle);
    
    // 组合提示词（添加风格）
    let finalPrompt = shot.imagePrompt;
    if (selectedStyleObj && selectedStyleObj.prompt) {
      finalPrompt = `${finalPrompt}, ${selectedStyleObj.prompt}`;
    }
    
    // 获取适合模型的尺寸
    const imageSize = getImageSize(selectedImageModel, selectedImageRatio);
    
    try {
      let newImageUrls: string[] = [];
      
      // sora-image、grok-3-image、grok-4-image 使用 chat/completions，不支持 n 参数，需要多次调用来生成多张图片
      const chatCompletionsModels = ['sora-image', 'grok-3-image', 'grok-4-image'];
      if (chatCompletionsModels.includes(selectedImageModel) && generateImageCount > 1) {
        // 多次调用生成多张图片（这些模型不支持 n 参数）
        for (let i = 0; i < generateImageCount; i++) {
          const options: ImageGenerationOptions = {
            model: selectedImageModel,
            prompt: finalPrompt,
            size: imageSize,
            quality: 'standard',
            // 注意：这些模型不支持 n 参数，所以不传
          };
          
          const result = await generateImage(apiKey, options);
          
          if (result.success && result.url) {
            newImageUrls.push(result.url);
          } else if (result.success && result.data?.data && Array.isArray(result.data.data)) {
            // 处理多张图片的情况（grok 可能一次返回多张）
            const urls = result.data.data.map((item: any) => item.url || item).filter(Boolean);
            newImageUrls.push(...urls);
          } else {
            console.warn(`第 ${i + 1} 张图片生成失败:`, result.error);
          }
          
          // 延迟避免API限流
          if (i < generateImageCount - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // 增加到2秒延迟
          }
        }
      } else if (chatCompletionsModels.includes(selectedImageModel)) {
        // 单张图片，也不传 n 参数
        const options: ImageGenerationOptions = {
          model: selectedImageModel,
          prompt: finalPrompt,
          size: imageSize,
          quality: 'standard',
          // 注意：这些模型不支持 n 参数
        };
        
        const result = await generateImage(apiKey, options);
        
        if (result.success) {
          if (result.url) {
            newImageUrls = [result.url];
          } else if (result.data?.data && Array.isArray(result.data.data)) {
            newImageUrls = result.data.data.map((item: any) => item.url || item).filter(Boolean);
          }
        } else {
          alert(`图片生成失败: ${result.error || '未知错误'}`);
          updateShot(shot.id, { imageGenerating: false });
          return;
        }
      } else {
        // 其他模型或单张图片，正常调用
        const options: ImageGenerationOptions = {
          model: selectedImageModel,
          prompt: finalPrompt,
          size: imageSize,
          quality: 'standard',
          n: generateImageCount, // 生成多张图片
        };
        
        const result = await generateImage(apiKey, options);
        
        if (result.success) {
          // 处理多张图片的情况
          if (result.data?.data && Array.isArray(result.data.data)) {
            // OpenAI 格式：data.data 是数组
            newImageUrls = result.data.data.map((item: any) => item.url || item.b64_json).filter(Boolean);
          } else if (result.data?.images && Array.isArray(result.data.images)) {
            // 其他格式：images 数组
            newImageUrls = result.data.images.map((item: any) => item.url || item).filter(Boolean);
          } else if (result.url) {
            // 单张图片
            newImageUrls = [result.url];
          }
        } else {
          alert(`图片生成失败: ${result.error || '未知错误'}`);
          updateShot(shot.id, { imageGenerating: false });
          return;
        }
      }
      
      if (newImageUrls.length > 0) {
        // 如果是重新生成，替换所有图片；否则追加
        const currentUrls = shot.imageUrls || [];
        const updatedUrls = regenerate ? newImageUrls : [...currentUrls, ...newImageUrls];
        updateShot(shot.id, { imageUrls: updatedUrls, imageGenerating: false });
      } else {
        alert('图片生成成功但未获取到图片URL');
        updateShot(shot.id, { imageGenerating: false });
      }
    } catch (error: any) {
      alert(`图片生成失败: ${error.message || '未知错误'}`);
      updateShot(shot.id, { imageGenerating: false });
    }
  };

  // 生成单个视频
  const handleGenerateVideo = async (shot: Shot, regenerate: boolean = false) => {
    if (!apiKey) {
      alert('请先配置 API Key');
      return;
    }
    
    if (!shot.videoPrompt) {
      alert('该镜头没有视频提示词');
      return;
    }
    
    updateShot(shot.id, { videoGenerating: true });
    
    const selectedModel = VIDEO_MODELS.find(m => m.id === selectedVideoModel);
    const options: VideoGenerationOptions = {
      model: selectedVideoModel,
      prompt: shot.videoPrompt,
      duration: selectedModel?.duration || 10,
      aspect_ratio: selectedImageRatio,
    };
    
    try {
      const result = await generateVideo(apiKey, options);
      
      if (result.success && result.url) {
        updateShot(shot.id, { videoUrl: result.url, videoGenerating: false });
      } else {
        alert(`视频生成失败: ${result.error || '未知错误'}`);
        updateShot(shot.id, { videoGenerating: false });
      }
    } catch (error: any) {
      alert(`视频生成失败: ${error.message || '未知错误'}`);
      updateShot(shot.id, { videoGenerating: false });
    }
  };

  // 批量生成图片（仅未生成的）
  const handleBatchGenerateImages = async () => {
    const shotsWithoutImages = shots.filter(s => s.imagePrompt && (!s.imageUrls || s.imageUrls.length === 0) && !s.imageGenerating);
    if (shotsWithoutImages.length === 0) {
      alert('所有镜头都已生成图片或正在生成中');
      return;
    }
    
    if (!confirm(`确定要批量生成 ${shotsWithoutImages.length} 个镜头的图片吗？`)) {
      return;
    }
    
    for (const shot of shotsWithoutImages) {
      await handleGenerateImage(shot);
      await new Promise(resolve => setTimeout(resolve, 2000)); // 延迟2秒避免API限流
    }
  };

  // 批量生成视频（仅未生成的）
  const handleBatchGenerateVideos = async () => {
    const shotsWithoutVideos = shots.filter(s => s.videoPrompt && !s.videoUrl && !s.videoGenerating);
    if (shotsWithoutVideos.length === 0) {
      alert('所有镜头都已生成视频或正在生成中');
      return;
    }
    
    if (!confirm(`确定要批量生成 ${shotsWithoutVideos.length} 个镜头的视频吗？`)) {
      return;
    }
    
    for (const shot of shotsWithoutVideos) {
      await handleGenerateVideo(shot);
      await new Promise(resolve => setTimeout(resolve, 3000)); // 延迟3秒避免API限流
    }
  };

  const selectedCount = shots.filter(s => s.selected).length;
  const generatingCount = shots.filter(s => s.imageGenerating || s.videoGenerating).length;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* 顶部操作栏 */}
      <div className="flex flex-col gap-4 bg-slate-800/50 p-4 rounded-xl border border-slate-800">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-emerald-400 flex items-center gap-2">
            <Video size={24} />
            媒體生成
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={loadScriptFromTools}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-all"
            >
              <FolderOpen size={16} />
              從改寫工具讀取
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium rounded-lg transition-all"
            >
              <Upload size={16} />
              上傳腳本文件
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.csv"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              onClick={() => setShowScriptInput(!showScriptInput)}
              className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium rounded-lg transition-all"
            >
              <FileText size={16} />
              {showScriptInput ? '隱藏' : '手動輸入'}
            </button>
          </div>
        </div>

        {/* 设置选项 - 一排显示 */}
        <div className="flex flex-wrap items-end gap-3 pt-4 border-t border-slate-700">
          <div className="flex-1 min-w-[140px]">
            <label className="text-xs text-slate-500 mb-1 block">圖片模型</label>
            <select
              value={selectedImageModel}
              onChange={(e) => {
                const newModel = e.target.value;
                setSelectedImageModel(newModel);
                
                // 如果切换到 sora-image，检查当前比例是否支持
                if (newModel === 'sora-image') {
                  const currentRatio = IMAGE_RATIOS.find(r => r.id === selectedImageRatio);
                  if (currentRatio && !currentRatio.soraImageSupported) {
                    // 自动切换到第一个支持的比例（1:1）
                    setSelectedImageRatio('1:1');
                  }
                }
              }}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {IMAGE_MODELS.map(model => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </select>
          </div>

          <div className="flex-1 min-w-[140px]">
            <label className="text-xs text-slate-500 mb-1 block">視頻模型</label>
            <select
              value={selectedVideoModel}
              onChange={(e) => setSelectedVideoModel(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {VIDEO_MODELS.map(model => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </select>
          </div>

          <div className="flex-1 min-w-[120px]">
            <label className="text-xs text-slate-500 mb-1 block">
              圖片比例
              {selectedImageModel === 'dall-e-3' && (
                <span className="text-amber-400 ml-1" title="DALL-E 3 只支持 1024x1024, 1024x1792, 1792x1024">⚠️</span>
              )}
              {selectedImageModel === 'sora-image' && (
                <span className="text-blue-400 ml-1" title="Sora Image 只支持 1:1, 2:3, 3:2 三种比例">⚠️</span>
              )}
            </label>
            <select
              value={selectedImageRatio}
              onChange={(e) => setSelectedImageRatio(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {IMAGE_RATIOS.map(ratio => {
                // sora-image 只显示支持的比例
                if (selectedImageModel === 'sora-image' && !ratio.soraImageSupported) {
                  return null;
                }
                
                let label = ratio.name;
                if (selectedImageModel === 'dall-e-3' && !ratio.dallE3Supported) {
                  label += ' (不支持)';
                }
                return (
                  <option key={ratio.id} value={ratio.id}>
                    {label}
                  </option>
                );
              }).filter(Boolean)}
            </select>
          </div>

          <div className="flex-1 min-w-[120px]">
            <label className="text-xs text-slate-500 mb-1 block">風格設置</label>
            <select
              value={selectedStyle}
              onChange={(e) => setSelectedStyle(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {STYLE_LIBRARY.map(style => (
                <option key={style.id} value={style.id}>{style.name}</option>
              ))}
            </select>
          </div>

          <div className="flex-1 min-w-[100px]">
            <label className="text-xs text-slate-500 mb-1 block">生成數量</label>
            <select
              value={generateImageCount}
              onChange={(e) => setGenerateImageCount(parseInt(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {[1, 2, 3, 4].map(count => (
                <option key={count} value={count}>{count} 張</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* 脚本输入区域 */}
      {showScriptInput && (
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
          <label className="text-sm font-medium text-slate-400 mb-2 block">腳本內容</label>
          <textarea
            value={scriptText}
            onChange={(e) => handleScriptInput(e.target.value)}
            placeholder="請粘貼腳本內容或從改寫工具讀取..."
            className="w-full h-40 bg-slate-900/50 border border-slate-700 rounded-lg p-4 text-slate-200 resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
      )}

      {/* 主内容区域 */}
      <div className="flex flex-col gap-4">
        {/* 操作栏 */}
        <div className="flex items-center justify-between bg-slate-800/50 border border-slate-700 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-slate-300">鏡頭列表 ({shots.length})</h3>
          <div className="flex items-center gap-2">
            {/* 批量选择按钮 */}
            <div className="flex items-center gap-1 border-r border-slate-700 pr-2 mr-2">
              <button
                onClick={handleSelectAll}
                className="flex items-center gap-1 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium rounded transition-all"
                title="全选"
              >
                <CheckSquare size={14} />
              </button>
              <button
                onClick={handleDeselectAll}
                className="flex items-center gap-1 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium rounded transition-all"
                title="取消全选"
              >
                <Square size={14} />
              </button>
              <button
                onClick={handleToggleSelect}
                className="flex items-center gap-1 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium rounded transition-all"
                title="反选"
              >
                <RefreshCw size={14} />
              </button>
            </div>
            
            <button
              onClick={handleAddShot}
              className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded transition-all"
            >
              <Plus size={14} />
              添加鏡頭
            </button>
            <button
              onClick={handleDeleteSelected}
              disabled={selectedCount === 0}
              className="flex items-center gap-1 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded transition-all disabled:opacity-50"
            >
              <Trash2 size={14} />
              刪除選中 ({selectedCount})
            </button>
            <button
              onClick={handleExportImagesAsZip}
              disabled={selectedCount === 0 || shots.filter(s => s.selected && s.imageUrls && s.imageUrls.length > 0).length === 0}
              className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded transition-all disabled:opacity-50"
              title="导出选中镜头的所有图片为 ZIP 文件"
            >
              <Download size={14} />
              導出圖片 ZIP ({selectedCount})
            </button>
          </div>
        </div>

        {/* 镜头列表（每个镜头带独立预览窗口） */}
        <div className="flex-1 overflow-y-auto custom-scrollbar space-y-4">
          {shots.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <FileText size={48} className="mx-auto mb-4 opacity-50" />
              <p>暫無鏡頭數據</p>
              <p className="text-xs mt-2">請從改寫工具讀取腳本或手動添加鏡頭</p>
            </div>
          ) : (
            shots.map((shot) => (
              <div
                key={shot.id}
                className="grid grid-cols-1 lg:grid-cols-2 gap-4"
              >
                {/* 左侧：镜头信息 */}
                <div
                  className={`bg-slate-900/50 border rounded-lg p-4 transition-all ${
                    shot.selected ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-700'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={shot.selected || false}
                      onChange={(e) => updateShot(shot.id, { selected: e.target.checked })}
                      className="mt-1 rounded"
                    />
                    <div className="flex-1 space-y-3">
                      {/* 镜头编号和操作 */}
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-emerald-400">鏡頭 {shot.number}</span>
                        <div className="flex items-center gap-2">
                          {shot.editing ? (
                            <button
                              onClick={() => handleSaveEdit(shot.id)}
                              className="text-emerald-400 hover:text-emerald-300"
                              title="保存"
                            >
                              <Check size={16} />
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                setEditingShotId(shot.id);
                                updateShot(shot.id, { editing: true });
                              }}
                              className="text-slate-400 hover:text-slate-300"
                              title="編輯"
                            >
                              <Edit2 size={16} />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* 镜头内容 */}
                      {shot.editing ? (
                        <div className="space-y-2">
                          <div>
                            <label className="text-xs text-slate-500 mb-1 block">圖片提示詞</label>
                            <textarea
                              value={shot.imagePrompt}
                              onChange={(e) => updateShot(shot.id, { imagePrompt: e.target.value })}
                              className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-200 resize-none"
                              rows={2}
                            />
                          </div>
                          <div>
                            <label className="text-xs text-slate-500 mb-1 block">視頻提示詞</label>
                            <textarea
                              value={shot.videoPrompt}
                              onChange={(e) => updateShot(shot.id, { videoPrompt: e.target.value })}
                              className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-200 resize-none"
                              rows={2}
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2 text-sm">
                          <div>
                            <span className="text-slate-500">圖片提示詞:</span>
                            <p className="text-slate-300 mt-1">{shot.imagePrompt || '無'}</p>
                          </div>
                          <div>
                            <span className="text-slate-500">視頻提示詞:</span>
                            <p className="text-slate-300 mt-1">{shot.videoPrompt || '無'}</p>
                          </div>
                        </div>
                      )}

                      {/* 生成按钮 */}
                      <div className="flex items-center gap-2 pt-2 border-t border-slate-700">
                        <button
                          onClick={() => handleGenerateImage(shot, false)}
                          disabled={shot.imageGenerating || !shot.imagePrompt}
                          className="text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded disabled:opacity-50 flex items-center gap-1"
                        >
                          {shot.imageGenerating ? (
                            <>
                              <Loader2 size={12} className="animate-spin" />
                              生成中...
                            </>
                          ) : (
                            <>
                              <ImageIcon size={12} />
                              生成圖片
                            </>
                          )}
                        </button>

                        <button
                          onClick={() => handleGenerateVideo(shot)}
                          disabled={shot.videoGenerating || !shot.videoPrompt}
                          className="text-xs px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded disabled:opacity-50 flex items-center gap-1"
                        >
                          {shot.videoGenerating ? (
                            <>
                              <Loader2 size={12} className="animate-spin" />
                              生成中...
                            </>
                          ) : (
                            <>
                              <Video size={12} />
                              生成視頻
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 右侧：预览窗口 */}
                <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-slate-400">預覽窗口</span>
                    {(shot.imageUrls && shot.imageUrls.length > 0) && (
                      <button
                        onClick={() => handleGenerateImage(shot, true)}
                        disabled={shot.imageGenerating}
                        className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50 flex items-center gap-1"
                        title="重新生成"
                      >
                        {shot.imageGenerating ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                      </button>
                    )}
                  </div>
                  
                  {/* 图片预览网格 */}
                  {shot.imageUrls && shot.imageUrls.length > 0 ? (
                    <div className={`grid gap-2 ${
                      shot.imageUrls.length === 1 ? 'grid-cols-1' :
                      shot.imageUrls.length === 2 ? 'grid-cols-2' :
                      shot.imageUrls.length === 3 ? 'grid-cols-2' :
                      'grid-cols-2'
                    }`}>
                      {shot.imageUrls.map((url, index) => (
                        <div key={index} className="relative group">
                          <img
                            src={url}
                            alt={`镜头${shot.number}-图片${index + 1}`}
                            className="w-full h-auto rounded border border-slate-700 cursor-pointer hover:border-emerald-500 transition-all object-cover"
                            style={{ 
                              maxHeight: shot.imageUrls && shot.imageUrls.length > 1 ? '150px' : '300px',
                              minHeight: '100px'
                            }}
                            onDoubleClick={() => setEnlargedImageUrl(url)}
                            onClick={() => setEnlargedImageUrl(url)}
                          />
                          <div className="absolute top-1 right-1 bg-black/50 text-white text-[10px] px-1 rounded opacity-0 group-hover:opacity-100 transition-opacity">
                            {index + 1}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-32 text-slate-500 text-xs">
                      {shot.imageGenerating ? (
                        <div className="flex flex-col items-center gap-2">
                          <Loader2 size={24} className="animate-spin text-emerald-400" />
                          <span>生成中...</span>
                        </div>
                      ) : (
                        <span>暫無圖片</span>
                      )}
                    </div>
                  )}

                  {/* 视频预览 */}
                  {shot.videoUrl && (
                    <div className="mt-3 pt-3 border-t border-slate-700">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-slate-400">視頻預覽</span>
                        <button
                          onClick={() => handleGenerateVideo(shot, true)}
                          disabled={shot.videoGenerating}
                          className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50 flex items-center gap-1"
                          title="重新生成"
                        >
                          {shot.videoGenerating ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                        </button>
                      </div>
                      <video
                        src={shot.videoUrl}
                        controls
                        className="w-full rounded border border-slate-700 max-h-48"
                      />
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* 批量操作 */}
        {shots.length > 0 && (
          <div className="flex items-center gap-2 pt-2 border-t border-slate-700 bg-slate-800/50 border border-slate-700 rounded-xl p-4">
            <button
              onClick={handleBatchGenerateImages}
              disabled={generatingCount > 0}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-all disabled:opacity-50"
            >
              <Rocket size={16} />
              批量生成圖片
            </button>
            <button
              onClick={handleBatchGenerateVideos}
              disabled={generatingCount > 0}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium rounded transition-all disabled:opacity-50"
            >
              <Rocket size={16} />
              批量生成視頻
            </button>
            <span className="text-sm text-slate-500 ml-auto">
              {generatingCount > 0 ? `生成中: ${generatingCount} 個任務...` : '就緒'}
            </span>
          </div>
        )}
      </div>

      {/* 图片放大模态框 */}
      {enlargedImageUrl && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setEnlargedImageUrl(null)}
        >
          <div className="relative max-w-7xl max-h-[90vh]">
            <button
              onClick={() => setEnlargedImageUrl(null)}
              className="absolute top-4 right-4 bg-slate-800 hover:bg-slate-700 text-white rounded-full p-2 z-10"
            >
              <X size={24} />
            </button>
            <img
              src={enlargedImageUrl}
              alt="放大預覽"
              className="max-w-full max-h-[90vh] rounded-lg border-2 border-slate-700"
              onClick={(e) => e.stopPropagation()}
            />
            <a
              href={enlargedImageUrl}
              download
              className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-all"
              onClick={(e) => e.stopPropagation()}
            >
              <Download size={16} />
              下載圖片
            </a>
          </div>
        </div>
      )}
      
      {/* 脚本历史记录选择器 */}
      {showScriptHistorySelector && (
        <HistorySelector
          records={scriptHistoryRecords}
          onSelect={handleScriptHistorySelect}
          onClose={() => setShowScriptHistorySelector(false)}
          onDelete={(timestamp) => {
            // 删除历史记录
            const updatedRecords = scriptHistoryRecords.filter(r => r.timestamp !== timestamp);
            setScriptHistoryRecords(updatedRecords);
            
            // 如果删除后没有记录了，关闭选择器
            if (updatedRecords.length === 0) {
              setShowScriptHistorySelector(false);
            }
          }}
          title="選擇腳本歷史記錄"
        />
      )}
    </div>
  );
};
