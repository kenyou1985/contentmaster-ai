import React, { useState, useRef, useEffect } from 'react';
import { ApiProvider, ToolMode, NicheType } from '../types';
import { generateImage, ImageGenerationOptions } from '../services/yunwuService';
import { generateTextToVideo, generateImageToVideo, checkVideoTaskStatus, DayuVideoGenerationOptions } from '../services/dayuVideoService';
import { cacheVideo, getCachedVideoUrl, downloadVideo } from '../services/videoCacheService';
import { generateImage as generateRunningHubImage, generateVideo as generateRunningHubVideo, checkTaskStatus as checkRunningHubTaskStatus, type RunningHubImageOptions, type RunningHubVideoOptions } from '../services/runninghubService';
import { generateJimengImages } from '../services/jimengService';
import { detectCharactersInPrompt } from '../services/characterLibraryService';
import { CharacterLibrary } from './CharacterLibrary';
import { Upload, FileText, Image as ImageIcon, Video, Play, Download, Edit2, Save, X, Loader2, Plus, Trash2, RefreshCw, Settings, FolderOpen, Rocket, Copy, Check, CheckSquare, Square, Users, HardDrive } from 'lucide-react';
import JSZip from 'jszip';
import { HistorySelector } from './HistorySelector';
import { getHistory, HistoryRecord } from '../services/historyService';
import { useToast } from './Toast';
import { ProgressBar } from './ProgressBar';

interface MediaGeneratorProps {
  apiKey: string; // 全局API Key（当provider是runninghub时，这就是RunningHub API Key）
  provider: ApiProvider;
  toast?: ReturnType<typeof useToast>;
  dayuApiKey?: string; // 大洋芋 API Key（用于视频生成）
  setDayuApiKey?: (key: string) => void; // 设置大洋芋 API Key
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
  videoUrl?: string; // 保留向后兼容（显示第一个视频）
  videoUrls?: string[]; // 支持多个视频（追加模式）
  cachedVideoUrl?: string; // 缓存的视频 Blob URL
  cachedVideoUrls?: string[]; // 缓存的视频 Blob URL 数组
  imageGenerating?: boolean;
  videoGenerating?: boolean;
  selected?: boolean;
  editing?: boolean;
  selectedImageIndex?: number; // 选中的图片索引（-1 表示未选中）
}

// 图片模型配置（根据yunwu.ai文档）
const IMAGE_MODELS = [
  { id: 'dall-e-3', name: 'DALL·E 3', endpoint: '/v1/images/generations', supportsImageToImage: false },
  { id: 'sora-image', name: 'Sora Image', endpoint: '/v1/chat/completions', supportsImageToImage: false }, // 使用 chat/completions
  { id: 'banana', name: 'Banana (Gemini 2.5 Flash)', endpoint: '/v1/images/generations', apiModelName: 'gemini-2.5-flash-image', supportsImageToImage: false },
  { id: 'banana-2', name: 'Banana 2 (Gemini 3 Pro)', endpoint: '/v1/images/generations', apiModelName: 'gemini-3-pro-image-preview', supportsImageToImage: false },
  { id: 'flux-1-kontext-dev', name: 'Flux 1 Kontext Dev', endpoint: '/v1/images/generations', apiModelName: 'flux.1-kontext-dev', supportsImageToImage: false }, // 注意：API 名称使用点号
  { id: 'grok-3-image', name: 'Grok 3 Image', endpoint: '/v1/chat/completions', supportsImageToImage: false }, // 使用 chat/completions
  { id: 'grok-4-image', name: 'Grok 4 Image', endpoint: '/v1/chat/completions', supportsImageToImage: false }, // 使用 chat/completions
  { id: 'jimeng', name: '即梦 (Jimeng)', endpoint: 'jimeng', isJimeng: true, supportsImageToImage: true }, // 即梦模型，支持图生图
  // RunningHub 开源模型
  { id: 'runninghub-flux', name: 'RunningHub - Flux', endpoint: 'runninghub', isRunningHub: true, runningHubModel: 'flux', supportsImageToImage: true },
  { id: 'runninghub-z-image', name: 'RunningHub - Z-Image', endpoint: 'runninghub', isRunningHub: true, runningHubModel: 'z-image', supportsImageToImage: true },
  { id: 'runninghub-qwen-image', name: 'RunningHub - Qwen-Image', endpoint: 'runninghub', isRunningHub: true, runningHubModel: 'qwen-image', supportsImageToImage: true },
];

// 视频模型配置（根据大洋芋 API 文档：https://6ibmqmipvf.apifox.cn/）
const VIDEO_MODELS = [
  // 普通模式（3-5分钟，生产力）
  { id: 'sora2-landscape', name: 'Sora 2 横屏 10秒', duration: 10, supportedDurations: [10], defaultSize: '1080P', supportedSizes: ['720P', '1080P'], orientation: 'landscape' },
  { id: 'sora2-portrait', name: 'Sora 2 竖屏 10秒', duration: 10, supportedDurations: [10], defaultSize: '1080P', supportedSizes: ['720P', '1080P'], orientation: 'portrait' },
  { id: 'sora2-landscape-15s', name: 'Sora 2 横屏 15秒', duration: 15, supportedDurations: [15], defaultSize: '1080P', supportedSizes: ['720P', '1080P'], orientation: 'landscape' },
  { id: 'sora2-portrait-15s', name: 'Sora 2 竖屏 15秒', duration: 15, supportedDurations: [15], defaultSize: '1080P', supportedSizes: ['720P', '1080P'], orientation: 'portrait' },
  // Pro 模式（15-30分钟，创作）
  { id: 'sora2-pro-landscape-25s', name: 'Sora 2 Pro 横屏 25秒', duration: 25, supportedDurations: [25], defaultSize: '1080P', supportedSizes: ['1080P'], orientation: 'landscape' },
  { id: 'sora2-pro-portrait-25s', name: 'Sora 2 Pro 竖屏 25秒', duration: 25, supportedDurations: [25], defaultSize: '1080P', supportedSizes: ['1080P'], orientation: 'portrait' },
  { id: 'sora2-pro-portrait-hd-15s', name: 'Sora 2 Pro 竖屏 HD 15秒', duration: 15, supportedDurations: [15], defaultSize: '1080P', supportedSizes: ['1080P'], orientation: 'portrait' },
  { id: 'sora2-pro-landscape-hd-15s', name: 'Sora 2 Pro 横屏 HD 15秒', duration: 15, supportedDurations: [15], defaultSize: '1080P', supportedSizes: ['1080P'], orientation: 'landscape' },
  // RunningHub 开源模型
  { id: 'runninghub-wan2.2', name: 'RunningHub - Wan2.2', duration: 10, supportedDurations: [5, 10, 15], defaultSize: '720P', supportedSizes: ['720P'], orientation: 'landscape', isRunningHub: true },
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

export const MediaGenerator: React.FC<MediaGeneratorProps> = ({ 
  apiKey, 
  provider, 
  toast: externalToast,
  dayuApiKey: externalDayuApiKey,
  setDayuApiKey: externalSetDayuApiKey,
}) => {
  const internalToast = useToast();
  const toast = externalToast || internalToast;
  
  // 大洋芋 API Key 状态（用于视频生成）
  const [dayuApiKey, setDayuApiKey] = useState(() => {
    return localStorage.getItem('DAYU_API_KEY') || externalDayuApiKey || '';
  });
  
  // 同步外部 API Key（如果提供）
  useEffect(() => {
    if (externalDayuApiKey !== undefined) {
      setDayuApiKey(externalDayuApiKey);
    }
  }, [externalDayuApiKey]);
  
  // 保存到 localStorage
  useEffect(() => {
    if (dayuApiKey) {
      localStorage.setItem('DAYU_API_KEY', dayuApiKey);
      if (externalSetDayuApiKey) {
        externalSetDayuApiKey(dayuApiKey);
      }
    }
  }, [dayuApiKey, externalSetDayuApiKey]);

  // 即梦 API 配置状态
  // 默认使用3030端口（简化方案，直接调用Node.js即梦API服务）
  const [jimengApiBaseUrl, setJimengApiBaseUrl] = useState(() => {
    return localStorage.getItem('JIMENG_API_BASE_URL') || 'http://localhost:3030';
  });
  const [jimengSessionId, setJimengSessionId] = useState(() => {
    return localStorage.getItem('JIMENG_SESSION_ID') || '';
  });
  
  // RunningHub API Key：从全局apiKey获取（当provider是runninghub时）
  const runningHubApiKey = provider === 'runninghub' ? apiKey : '';
  
  // 角色库管理
  const [showCharacterLibrary, setShowCharacterLibrary] = useState(false);
  
  // 保存即梦配置到 localStorage
  useEffect(() => {
    if (jimengApiBaseUrl) {
      localStorage.setItem('JIMENG_API_BASE_URL', jimengApiBaseUrl);
    }
  }, [jimengApiBaseUrl]);
  
  useEffect(() => {
    if (jimengSessionId) {
      localStorage.setItem('JIMENG_SESSION_ID', jimengSessionId);
    }
  }, [jimengSessionId]);
  
  const [scriptText, setScriptText] = useState('');
  const [shots, setShots] = useState<Shot[]>([]);
  const [selectedImageModel, setSelectedImageModel] = useState(IMAGE_MODELS[0].id);
  const [selectedVideoModel, setSelectedVideoModel] = useState(VIDEO_MODELS[0].id);
  const [selectedImageRatio, setSelectedImageRatio] = useState(IMAGE_RATIOS[2].id); // 默认9:16
  const [selectedStyle, setSelectedStyle] = useState(STYLE_LIBRARY[0].id);
  // 视频参数设置
  const [selectedVideoSize, setSelectedVideoSize] = useState<string>(VIDEO_MODELS[0]?.defaultSize || '1080P');
  const [selectedVideoDuration, setSelectedVideoDuration] = useState<number>(VIDEO_MODELS[0]?.duration || 10);
  const [selectedVideoOrientation, setSelectedVideoOrientation] = useState<string>('landscape'); // 视频方向：landscape 或 portrait
  const [editingShotId, setEditingShotId] = useState<string | null>(null);
  const [expandedCaptions, setExpandedCaptions] = useState<Set<string>>(new Set()); // 展开的文案ID集合
  const [expandedImagePrompts, setExpandedImagePrompts] = useState<Set<string>>(new Set()); // 展开的图片提示词ID集合
  const [expandedVideoPrompts, setExpandedVideoPrompts] = useState<Set<string>>(new Set()); // 展开的视频提示词ID集合
  const [editingRole, setEditingRole] = useState<{ shotId: string; role: string } | null>(null); // 编辑角色
  const [editingTone, setEditingTone] = useState<{ shotId: string; tone: string } | null>(null); // 编辑语气
  const [editingShotType, setEditingShotType] = useState<{ shotId: string; shotType: string } | null>(null); // 编辑景别
  const [enlargedImageUrl, setEnlargedImageUrl] = useState<string | null>(null);
  const [enlargedVideoUrl, setEnlargedVideoUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showScriptInput, setShowScriptInput] = useState(false);
  const [generateImageCount, setGenerateImageCount] = useState(1); // 每次生成的图片数量
  const [showScriptHistorySelector, setShowScriptHistorySelector] = useState(false);
  const [scriptHistoryRecords, setScriptHistoryRecords] = useState<HistoryRecord[]>([]);
  
  // 批量操作进度
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; type: 'image' | 'video' } | null>(null);

  // 组件加载时不自动读取，避免读取旧数据
  // 用户需要手动点击"从改写工具读取"按钮来加载最新脚本

  // 视频预览组件（支持缓存）
  const VideoPreview: React.FC<{
    videoUrl: string;
    cachedVideoUrl?: string;
    shotId: string;
  }> = ({ videoUrl, cachedVideoUrl, shotId }) => {
    const [currentVideoUrl, setCurrentVideoUrl] = useState<string>(cachedVideoUrl || videoUrl);
    const [isCaching, setIsCaching] = useState(false);
    const [isCached, setIsCached] = useState(!!cachedVideoUrl);
    
    // 检查并加载缓存
    useEffect(() => {
      const loadCache = async () => {
        // 如果已有缓存URL，直接使用
        if (cachedVideoUrl) {
          setCurrentVideoUrl(cachedVideoUrl);
          setIsCached(true);
          return;
        }
        
        // 检查是否有已缓存的视频
        const cached = getCachedVideoUrl(videoUrl);
        if (cached) {
          setCurrentVideoUrl(cached);
          setIsCached(true);
          updateShot(shotId, { cachedVideoUrl: cached });
          return;
        }
        
        // 自动缓存视频（后台进行，不阻塞UI）
        setIsCaching(true);
        try {
          const cachedUrl = await cacheVideo(videoUrl);
          setCurrentVideoUrl(cachedUrl);
          setIsCached(true);
          updateShot(shotId, { cachedVideoUrl: cachedUrl });
          toast.success('视频已缓存到本地，播放更流畅', 3000);
        } catch (error: any) {
          console.warn('[VideoPreview] 自动缓存失败:', error);
          // 缓存失败时使用原始URL
          setCurrentVideoUrl(videoUrl);
        } finally {
          setIsCaching(false);
        }
      };
      
      loadCache();
    }, [videoUrl, cachedVideoUrl, shotId]);
    
    const handleDownload = async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await downloadVideo(videoUrl, `video_${Date.now()}.mp4`);
        toast.success('视频下载成功', 3000);
      } catch (error: any) {
        toast.error(`下载失败: ${error.message}`, 5000);
      }
    };
    
    return (
      <div 
        className="relative cursor-pointer group"
        onClick={() => setEnlargedVideoUrl(currentVideoUrl)}
      >
        <video
          src={currentVideoUrl}
          className="w-full h-32 object-cover rounded border border-slate-700"
          controls={false}
          preload="auto"
          onMouseEnter={(e) => {
            const video = e.currentTarget;
            video.currentTime = 0;
            video.play().catch(() => {
              // 自动播放失败时静默处理
            });
          }}
          onMouseLeave={(e) => {
            const video = e.currentTarget;
            video.pause();
            video.currentTime = 0;
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-all rounded">
          <div className="bg-black/50 rounded-full p-2 group-hover:bg-black/70 transition-all">
            <Play size={24} className="text-white/90 group-hover:text-white" fill="white" />
          </div>
        </div>
        {/* 缓存状态指示器 */}
        <div className="absolute top-1 right-1 flex gap-1">
          {isCaching && (
            <div className="bg-blue-600/80 text-white text-[8px] px-1.5 py-0.5 rounded flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />
              缓存中
            </div>
          )}
          {isCached && !isCaching && (
            <div className="bg-emerald-600/80 text-white text-[8px] px-1.5 py-0.5 rounded flex items-center gap-1" title="已缓存到本地">
              <HardDrive size={10} />
              已缓存
            </div>
          )}
          <button
            onClick={handleDownload}
            className="bg-slate-800/80 hover:bg-slate-700/80 text-white p-1 rounded transition-all"
            title="下载视频"
          >
            <Download size={12} />
          </button>
        </div>
      </div>
    );
  };

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
      toast.warning('未找到脚本历史记录。请先在改写工具中生成脚本。');
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
          toast.error('脚本解析失败，无法提取镜头信息。');
        }
      } else {
        toast.warning('选中的记录不包含有效的镜头信息。');
      }
    } else {
      toast.warning('选中的记录内容为空。');
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
      toast.warning('请先选择要删除的镜头');
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
      toast.warning('请先选择包含图片的镜头');
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
        toast.warning('没有可导出的图片');
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

      toast.success(`成功导出 ${imageCount} 张图片到 ZIP 文件`);
    } catch (error: any) {
      console.error('导出 ZIP 失败:', error);
      toast.error(`导出失败: ${error.message || '未知错误'}`);
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
    // 检查选中的模型
    const selectedModel = IMAGE_MODELS.find(m => m.id === selectedImageModel);
    
    // 检查 API Key 配置
    if (selectedModel?.isJimeng) {
      if (!jimengSessionId || jimengSessionId.trim() === '') {
        alert('请先配置即梦 SESSION_ID');
        return;
      }
    } else if (selectedModel?.isRunningHub) {
      if (provider !== 'runninghub' || !apiKey || apiKey.trim() === '') {
        alert('请先在顶部配置 RunningHub API Key（选择 RunningHub 服务）');
        return;
      }
    } else {
      if (!apiKey) {
        alert('请先配置 API Key');
        return;
      }
    }
    
    if (!shot.imagePrompt) {
      toast.warning('该镜头没有图片提示词');
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
    
    // 检测提示词中是否包含角色库中的角色
    const matchedCharacters = detectCharactersInPrompt(finalPrompt);
    const useImageToImage = matchedCharacters.length > 0 && (selectedModel?.isJimeng || selectedModel?.isRunningHub);
    
    if (useImageToImage) {
      toast.info(`检测到角色 "${matchedCharacters.map(c => c.name).join(', ')}"，将使用图生图模式`, 5000);
    }
    
    // 获取适合模型的尺寸
    const imageSize = getImageSize(selectedImageModel, selectedImageRatio);
    
    try {
      let newImageUrls: string[] = [];
      
      // RunningHub 模型处理
      if (selectedModel?.isRunningHub) {
        const selectedRatio = IMAGE_RATIOS.find(r => r.id === selectedImageRatio);
        const width = selectedRatio?.width || 1024;
        const height = selectedRatio?.height || 1024;
        
        // 构建生成选项
        const generationOptions: RunningHubImageOptions = {
          prompt: finalPrompt,
          model: selectedModel.runningHubModel as 'flux' | 'z-image' | 'qwen-image',
          width,
          height,
          num_images: generateImageCount,
        };
        
        // 如果检测到角色，使用图生图模式
        if (useImageToImage && matchedCharacters.length > 0) {
          const characterImage = matchedCharacters[0].imageUrl;
          generationOptions.image_url = characterImage;
        }
        
        // 生成多张图片
        if (generateImageCount > 1) {
          for (let i = 0; i < generateImageCount; i++) {
            const result = await generateRunningHubImage(apiKey, {
              ...generationOptions,
              num_images: 1, // 每次生成1张
            });
            
            if (result.success) {
              if (result.url) {
                newImageUrls.push(result.url);
              } else if (result.urls && result.urls.length > 0) {
                newImageUrls.push(...result.urls);
              }
            } else {
              console.warn(`第 ${i + 1} 张图片生成失败:`, result.error);
            }
            
            // 延迟避免API限流
            if (i < generateImageCount - 1) {
              await new Promise(resolve => setTimeout(resolve, 1500));
            }
          }
        } else {
          const result = await generateRunningHubImage(apiKey, generationOptions);
          
          if (result.success) {
            if (result.url) {
              newImageUrls = [result.url];
            } else if (result.urls && result.urls.length > 0) {
              newImageUrls = result.urls;
            } else {
              toast.error('图片生成成功但未获取到图片URL');
              updateShot(shot.id, { imageGenerating: false });
              return;
            }
            toast.success(`成功生成 ${newImageUrls.length} 张图片！`, 8000);
          } else {
            const errorMsg = result.error || 'RunningHub 图片生成失败';
            updateShot(shot.id, { imageGenerating: false });
            throw new Error(errorMsg);
          }
        }
      }
      // 即梦模型特殊处理
      else if (selectedModel?.isJimeng) {
        // 使用即梦API生成图片
        const selectedRatio = IMAGE_RATIOS.find(r => r.id === selectedImageRatio);
        const width = selectedRatio?.width || 1080;
        const height = selectedRatio?.height || 1920;
        
        // 构建生成选项
        const generationOptions: any = {
          prompt: finalPrompt,
          num_images: generateImageCount,
          width,
          height
        };
        
        // 如果检测到角色，使用图生图模式
        if (useImageToImage && matchedCharacters.length > 0) {
          // 使用第一个匹配角色的图片
          const characterImage = matchedCharacters[0].imageUrl;
          generationOptions.images = [characterImage];
          generationOptions.sample_strength = 0.7; // 默认采样强度
        }
        
        const result = await generateJimengImages(
          jimengApiBaseUrl,
          jimengSessionId,
          generationOptions
        );
        
        if (result.success && result.data) {
          newImageUrls = result.data.map(item => item.url);
          toast.success(`成功生成 ${newImageUrls.length} 张图片！`, 8000);
        } else {
          const errorMsg = result.error || '即梦图片生成失败';
          updateShot(shot.id, { imageGenerating: false });
          throw new Error(errorMsg);
        }
      } else {
        // 原有的yunwu.ai模型处理逻辑
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
          const errorMsg = `图片生成失败: ${result.error || '未知错误'}`;
          updateShot(shot.id, { imageGenerating: false });
          throw new Error(errorMsg);
        }
      } else {
        // 其他模型：如果生成多张，需要多次调用（因为某些模型可能不支持 n 参数或支持有限）
        if (generateImageCount > 1) {
          // 多次调用生成多张图片
          for (let i = 0; i < generateImageCount; i++) {
            const options: ImageGenerationOptions = {
              model: selectedImageModel,
              prompt: finalPrompt,
              size: imageSize,
              quality: 'standard',
              n: 1, // 每次只生成1张，通过多次调用来生成多张
            };
            
            const result = await generateImage(apiKey, options);
            
            if (result.success) {
              // 处理单张图片的情况
              if (result.url) {
                newImageUrls.push(result.url);
              } else if (result.data?.data && Array.isArray(result.data.data) && result.data.data.length > 0) {
                // OpenAI 格式：data.data 是数组
                const urls = result.data.data.map((item: any) => item.url || item.b64_json).filter(Boolean);
                newImageUrls.push(...urls);
              } else if (result.data?.images && Array.isArray(result.data.images) && result.data.images.length > 0) {
                // 其他格式：images 数组
                const urls = result.data.images.map((item: any) => item.url || item).filter(Boolean);
                newImageUrls.push(...urls);
              }
            } else {
              console.warn(`第 ${i + 1} 张图片生成失败:`, result.error);
            }
            
            // 延迟避免API限流
            if (i < generateImageCount - 1) {
              await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5秒延迟
            }
          }
        } else {
          // 单张图片，正常调用
          const options: ImageGenerationOptions = {
            model: selectedImageModel,
            prompt: finalPrompt,
            size: imageSize,
            quality: 'standard',
            n: 1,
          };
          
          const result = await generateImage(apiKey, options);
          
          if (result.success) {
            // 处理单张图片的情况
            if (result.url) {
              newImageUrls = [result.url];
            } else if (result.data?.data && Array.isArray(result.data.data) && result.data.data.length > 0) {
              // OpenAI 格式：data.data 是数组
              newImageUrls = result.data.data.map((item: any) => item.url || item.b64_json).filter(Boolean);
            } else if (result.data?.images && Array.isArray(result.data.images) && result.data.images.length > 0) {
              // 其他格式：images 数组
              newImageUrls = result.data.images.map((item: any) => item.url || item).filter(Boolean);
            }
          } else {
            const errorMsg = `图片生成失败: ${result.error || '未知错误'}`;
            updateShot(shot.id, { imageGenerating: false });
            throw new Error(errorMsg);
          }
        }
      }
      } // 结束 else 块（即梦模型处理）
      
      if (newImageUrls.length > 0) {
        // 重新绘图时也追加图片，不覆盖原有图片
        const currentUrls = shot.imageUrls || [];
        const updatedUrls = [...currentUrls, ...newImageUrls]; // 始终追加，不替换
        
        // 自动选中新生成的第一张图片
        let selectedIndex: number;
        if (currentUrls.length === 0) {
          // 之前没有图片，选中新生成的第一张（索引0）
          selectedIndex = 0;
        } else {
          // 之前有图片，选中新生成的第一张（即 currentUrls.length，因为新图片是追加的）
          selectedIndex = currentUrls.length;
        }
        
        updateShot(shot.id, { 
          imageUrls: updatedUrls, 
          selectedImageIndex: selectedIndex,
          imageGenerating: false 
        });
      } else {
        const errorMsg = '图片生成成功但未获取到图片URL';
        updateShot(shot.id, { imageGenerating: false });
        throw new Error(errorMsg);
      }
    } catch (error: any) {
      // 确保 imageGenerating 状态被清除
      updateShot(shot.id, { imageGenerating: false });
      // 重新抛出错误，让调用者处理（批量生成会统一统计，单个生成会显示错误）
      throw error;
    }
  };

  // 辅助函数：追加视频URL到镜头（支持追加模式）
  const appendVideoToShot = (shotId: string, videoUrl: string, cachedUrl?: string) => {
    const shot = shots.find(s => s.id === shotId);
    if (!shot) return;
    
    // 追加模式：保留原有视频，添加新视频
    const currentVideoUrls = shot.videoUrls || (shot.videoUrl ? [shot.videoUrl] : []);
    const currentCachedUrls = shot.cachedVideoUrls || (shot.cachedVideoUrl ? [shot.cachedVideoUrl] : []);
    const updatedVideoUrls = [...currentVideoUrls, videoUrl];
    const updatedCachedUrls = cachedUrl ? [...currentCachedUrls, cachedUrl] : currentCachedUrls;
    
    updateShot(shotId, {
      videoUrl: videoUrl, // 保留向后兼容，显示最新的视频
      videoUrls: updatedVideoUrls, // 追加到数组
      cachedVideoUrl: cachedUrl || shot.cachedVideoUrl, // 保留向后兼容
      cachedVideoUrls: updatedCachedUrls, // 追加到数组
      videoGenerating: false
    });
    
    return updatedVideoUrls.length;
  };

  // RunningHub 任务状态轮询
  const pollRunningHubTaskStatus = async (taskId: string, shotId: string, maxAttempts: number = 180) => {
    let attempts = 0;
    let lastProgress = 0;
    let lastStatus = '';
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5;
    
    const poll = async () => {
      attempts++;
      
      if (attempts > maxAttempts) {
        // 超时后最后一次查询
        console.log(`[MediaGenerator] RunningHub 轮询超时，进行最后一次查询: taskId=${taskId}`);
        try {
          const finalResult = await checkRunningHubTaskStatus(apiKey, taskId);
          if (finalResult.success && finalResult.url) {
            try {
              toast.info('视频生成成功，正在缓存视频...', 3000);
              const cachedUrl = await cacheVideo(finalResult.url);
              const totalCount = appendVideoToShot(shotId, finalResult.url, cachedUrl);
              toast.success(`视频生成成功并已缓存！（共 ${totalCount} 个视频）`, 8000);
            } catch (cacheError: any) {
              console.warn('[MediaGenerator] 视频缓存失败:', cacheError);
              const totalCount = appendVideoToShot(shotId, finalResult.url);
              toast.success(`视频生成成功！（共 ${totalCount} 个视频）`, 8000);
            }
            return;
          }
        } catch (error) {
          console.error('[MediaGenerator] 最后一次查询失败:', error);
        }
        
        toast.warning(
          `视频生成超时（已轮询 ${maxAttempts} 次），但任务可能仍在后台处理中。\n\n` +
          `任务ID: ${taskId}\n` +
          `最后状态: ${lastStatus || '未知'}\n` +
          `最后进度: ${lastProgress}%\n\n` +
          `请稍后手动刷新或重新查询任务状态。`,
          12000
        );
        updateShot(shotId, { videoGenerating: false });
        return;
      }
      
      try {
        const result = await checkRunningHubTaskStatus(apiKey, taskId);
        consecutiveErrors = 0;
        
        if (result.success) {
          lastStatus = result.status || '';
          lastProgress = result.progress || 0;
          
          console.log(`[MediaGenerator] RunningHub 任务 ${taskId} 状态: ${result.status}, 进度: ${result.progress}%`);
          
          // 检查是否有视频URL（支持多种字段名）
          // RunningHubResult 有 url 字段，DayuVideoResult 有 videoUrl 字段
          // 注意：即使设置了 batch_size=1，API 可能仍返回多个视频，这里只取第一个
          let videoUrl = result.url || (result as any).videoUrl;
          
          // 如果还没有找到URL，从data中提取（只取第一个视频）
          if (!videoUrl && result.data) {
            const data = result.data;
            const files = data.files || data.outputs || [];
            
            // 先找出所有视频文件
            const videoFiles = files.filter((f: any) => 
              f.url?.includes('.mp4') || 
              f.fileName?.includes('.mp4') ||
              f.outputType === 'mp4' ||
              f.type === 'video/mp4'
            );
            
            if (videoFiles.length > 0) {
              // 只取第一个视频文件
              videoUrl = videoFiles[0].url || videoFiles[0].fileUrl || videoFiles[0].fileName;
              if (videoFiles.length > 1) {
                console.warn(`[MediaGenerator] RunningHub 返回了 ${videoFiles.length} 个视频，但只使用第一个:`, videoUrl);
              }
            } else if (files.length > 0) {
              // 如果没有找到mp4，使用第一个文件
              videoUrl = files[0].url || files[0].fileUrl || files[0].fileName;
            }
            
            // 也尝试从data的顶层字段查找
            if (!videoUrl) {
              videoUrl = data.videoUrl || data.video_url || data.url || data.outputUrl;
            }
          }
          
          if (videoUrl) {
            // 已获取到视频URL，追加模式
            try {
              toast.info('视频生成成功，正在缓存视频...', 3000);
              const cachedUrl = await cacheVideo(videoUrl);
              const totalCount = appendVideoToShot(shotId, videoUrl, cachedUrl);
              toast.success(`视频生成成功并已缓存！（共 ${totalCount} 个视频）`, 8000);
            } catch (cacheError: any) {
              console.warn('[MediaGenerator] 视频缓存失败:', cacheError);
              const totalCount = appendVideoToShot(shotId, videoUrl);
              toast.success(`视频生成成功！（共 ${totalCount} 个视频）`, 8000);
            }
            return;
          } else if (result.status === 'SUCCESS' || result.status === 'completed' || result.status === 'success') {
            // 状态完成但无URL，可能是URL字段名不对，尝试从data中提取（只取第一个视频）
            if (result.data) {
              const data = result.data;
              const files = data.files || data.outputs || [];
              
              // 先找出所有视频文件，只取第一个
              const videoFiles = files.filter((f: any) => 
                f.url?.includes('.mp4') || 
                f.fileName?.includes('.mp4') ||
                f.outputType === 'mp4'
              );
              
              let extractedUrl: string | undefined;
              if (videoFiles.length > 0) {
                extractedUrl = videoFiles[0].url || videoFiles[0].fileUrl || videoFiles[0].fileName;
                if (videoFiles.length > 1) {
                  console.warn(`[MediaGenerator] RunningHub 返回了 ${videoFiles.length} 个视频，但只使用第一个`);
                }
              } else if (files.length > 0) {
                extractedUrl = files[0].url || files[0].fileUrl || files[0].fileName;
              }
              
              // 也尝试从data的顶层字段查找
              if (!extractedUrl) {
                extractedUrl = data.videoUrl || data.video_url || data.url;
              }
              
              if (extractedUrl) {
                console.log('[MediaGenerator] 从data中提取到视频URL:', extractedUrl);
                try {
                  toast.info('视频生成成功，正在缓存视频...', 3000);
                  const cachedUrl = await cacheVideo(extractedUrl);
                  const totalCount = appendVideoToShot(shotId, extractedUrl, cachedUrl);
                  toast.success(`视频生成成功并已缓存！（共 ${totalCount} 个视频）`, 8000);
                } catch (cacheError: any) {
                  console.warn('[MediaGenerator] 视频缓存失败:', cacheError);
                  const totalCount = appendVideoToShot(shotId, extractedUrl);
                  toast.success(`视频生成成功！（共 ${totalCount} 个视频）`, 8000);
                }
                return;
              }
            }
            // 如果仍然没有URL，继续轮询（可能URL还在生成中）
            console.log('[MediaGenerator] 任务状态为SUCCESS但无URL，继续轮询获取URL');
            setTimeout(poll, 5000);
          } else if (result.status === 'FAILED' || result.status === 'failed' || result.status === 'error') {
            toast.error(`视频生成失败: ${result.error || '未知错误'}`, 6000);
            updateShot(shotId, { videoGenerating: false });
            return;
          } else {
            // 任务进行中，继续轮询
            const progress = result.progress || 0;
            let pollInterval = 5000;
            
            if (progress >= 90) {
              pollInterval = 3000;
            } else if (progress >= 50) {
              pollInterval = 4000;
            }
            
            setTimeout(poll, pollInterval);
          }
        } else {
          consecutiveErrors++;
          if (consecutiveErrors >= maxConsecutiveErrors) {
            toast.error(`连续 ${maxConsecutiveErrors} 次查询失败，请检查网络连接或API配置`, 8000);
            updateShot(shotId, { videoGenerating: false });
            return;
          }
          console.warn(`[MediaGenerator] RunningHub 查询任务状态失败 (${consecutiveErrors}/${maxConsecutiveErrors}):`, result.error);
          setTimeout(poll, 5000);
        }
      } catch (error: any) {
        consecutiveErrors++;
        console.error(`[MediaGenerator] RunningHub 轮询任务状态异常 (${consecutiveErrors}/${maxConsecutiveErrors}):`, error);
        
        if (consecutiveErrors >= maxConsecutiveErrors) {
          toast.error(`连续 ${maxConsecutiveErrors} 次查询异常，请检查网络连接`, 8000);
          updateShot(shotId, { videoGenerating: false });
          return;
        }
        
        setTimeout(poll, 5000);
      }
    };
    
    setTimeout(poll, 3000);
  };

  // 轮询任务状态（大洋芋）
  // 根据API文档：普通模式3-5分钟，pro模式15-30分钟
  // 增加轮询次数和超时时间，确保能获取到已完成的视频
  const pollTaskStatus = async (taskId: string, shotId: string, maxAttempts: number = 360) => {
    let attempts = 0;
    let lastProgress = 0;
    let lastStatus = '';
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5; // 连续错误次数限制
    
    const poll = async () => {
      attempts++;
      
      // 根据模型类型调整超时时间
      // 普通模式：最多30分钟（360次 * 5秒 = 1800秒 = 30分钟）
      // Pro模式可能需要更长时间，但先设置30分钟作为基础超时
      if (attempts > maxAttempts) {
        // 即使超时，也尝试最后一次查询，可能视频已经生成完成（这是关键修复）
        console.log(`[MediaGenerator] 轮询超时（${maxAttempts}次），进行最后一次查询: taskId=${taskId}`);
        try {
          const finalResult = await checkVideoTaskStatus(dayuApiKey, taskId);
          console.log(`[MediaGenerator] 最后一次查询结果:`, {
            success: finalResult.success,
            status: finalResult.status,
            progress: finalResult.progress,
            hasVideoUrl: !!finalResult.videoUrl,
            dataKeys: finalResult.data ? Object.keys(finalResult.data) : []
          });
          
          if (finalResult.success) {
            // 尝试从多个可能的字段提取视频URL
            const data = finalResult.data || {};
            const possibleUrl = finalResult.videoUrl ||
                               data.video_url ||
                               data.url ||
                               data.videoUrl ||
                               data.video ||
                               data.output?.url ||
                               data.output?.video_url ||
                               data.result?.url ||
                               data.result?.video_url ||
                               data.files?.[0]?.url;
            
            if (possibleUrl) {
              // 最后一次查询成功获取到视频URL，自动缓存，追加模式
              try {
                const cachedUrl = await cacheVideo(possibleUrl);
                const totalCount = appendVideoToShot(shotId, possibleUrl, cachedUrl);
                toast.success(`视频生成成功并已缓存！（已超时但成功获取到视频，共 ${totalCount} 个视频）`, 8000);
              } catch (cacheError: any) {
                console.warn('[MediaGenerator] 视频缓存失败:', cacheError);
                const totalCount = appendVideoToShot(shotId, possibleUrl);
                toast.success(`视频生成成功！（已超时但成功获取到视频，共 ${totalCount} 个视频）`, 8000);
              }
              return;
            } else if (finalResult.status === 'completed' || finalResult.status === 'success') {
              // 状态为完成但无URL，可能是URL字段名不对，记录完整数据用于调试
              console.error(`[MediaGenerator] 任务状态为完成但无视频URL，完整响应数据:`, JSON.stringify(data, null, 2));
              toast.warning(
                `视频生成已完成，但无法获取视频URL。\n\n` +
                `任务ID: ${taskId}\n` +
                `状态: ${finalResult.status}\n` +
                `请检查API响应格式或联系技术支持。`,
                10000
              );
              updateShot(shotId, { videoGenerating: false });
              return;
            }
          }
        } catch (error: any) {
          console.error('[MediaGenerator] 最后一次查询失败:', error);
        }
        
        // 超时且最后一次查询也未获取到视频
        toast.warning(
          `视频生成超时（已轮询 ${maxAttempts} 次，约 ${Math.floor(maxAttempts * 5 / 60)} 分钟），但任务可能仍在后台处理中。\n\n` +
          `任务ID: ${taskId}\n` +
          `最后状态: ${lastStatus || '未知'}\n` +
          `最后进度: ${lastProgress}%\n\n` +
          `提示：即使显示超时，如果后台已生成成功，您可以：\n` +
          `1. 等待几分钟后刷新页面\n` +
          `2. 或使用任务ID手动查询任务状态\n` +
          `3. 或重新生成视频`,
          15000
        );
        updateShot(shotId, { videoGenerating: false });
        return;
      }
      
      try {
        const result = await checkVideoTaskStatus(dayuApiKey, taskId);
        consecutiveErrors = 0; // 重置连续错误计数
        
        if (result.success) {
          lastStatus = result.status || '';
          lastProgress = result.progress || 0;
          
          console.log(`[MediaGenerator] 任务 ${taskId} 状态: ${result.status}, 进度: ${result.progress}%, 视频URL: ${result.videoUrl ? '已获取' : '未获取'}`);
          
          // 检查任务是否完成（状态为 completed 或已获取到视频URL）
          // 注意：即使状态不是 completed，如果有 videoUrl 也认为已完成
          if (result.videoUrl) {
            // 已获取到视频URL，任务完成，自动缓存
              try {
                toast.info('视频生成成功，正在缓存视频以提升播放性能...', 3000);
                const cachedUrl = await cacheVideo(result.videoUrl);
                const totalCount = appendVideoToShot(shotId, result.videoUrl, cachedUrl);
                toast.success(`视频生成成功并已缓存！（共 ${totalCount} 个视频）`, 8000);
              } catch (cacheError: any) {
                console.warn('[MediaGenerator] 视频缓存失败，使用原始URL:', cacheError);
                const totalCount = appendVideoToShot(shotId, result.videoUrl);
                toast.success(`视频生成成功！（共 ${totalCount} 个视频）`, 8000);
              }
              return;
          } else if (result.status === 'completed' || result.status === 'success') {
            // 状态为完成，但还没有视频URL，可能是URL字段名不对，再查询一次
            console.log(`[MediaGenerator] 任务状态为完成但无视频URL，检查响应数据:`, result.data);
            // 尝试从data中提取URL
            const data = result.data || {};
            const possibleUrl = data.video_url || data.url || data.videoUrl || data.result?.url || data.result?.video_url;
            if (possibleUrl) {
              // 自动缓存视频，追加模式
              try {
                toast.info('视频生成成功，正在缓存视频...', 3000);
                const cachedUrl = await cacheVideo(possibleUrl);
                const totalCount = appendVideoToShot(shotId, possibleUrl, cachedUrl);
                toast.success(`视频生成成功并已缓存！（共 ${totalCount} 个视频）`, 8000);
              } catch (cacheError: any) {
                console.warn('[MediaGenerator] 视频缓存失败，使用原始URL:', cacheError);
                const totalCount = appendVideoToShot(shotId, possibleUrl);
                toast.success(`视频生成成功！（共 ${totalCount} 个视频）`, 8000);
              }
              return;
            } else {
              // 状态完成但无URL，继续轮询等待URL出现
              console.warn(`[MediaGenerator] 任务状态为完成但无视频URL，继续轮询...`);
              setTimeout(poll, 5000);
            }
          } else if (result.status === 'failed' || result.status === 'error' || result.status === 'failure') {
            // 任务失败
            toast.error(`视频生成失败: ${result.error || '未知错误'}`, 6000);
            updateShot(shotId, { videoGenerating: false });
            return;
          } else {
            // 任务进行中（pending, in_progress, processing 等），继续轮询
            // 根据进度调整轮询间隔：进度越高，轮询越频繁
            const progress = result.progress || 0;
            let pollInterval = 5000; // 默认5秒
            
            if (progress >= 90) {
              pollInterval = 3000; // 接近完成时，3秒轮询一次
            } else if (progress >= 50) {
              pollInterval = 4000; // 进度过半时，4秒轮询一次
            }
            
            setTimeout(poll, pollInterval);
          }
        } else {
          // 查询失败，但继续重试（可能是临时网络问题）
          consecutiveErrors++;
          if (consecutiveErrors >= maxConsecutiveErrors) {
            toast.error(`连续 ${maxConsecutiveErrors} 次查询失败，请检查网络连接或API配置`, 8000);
            updateShot(shotId, { videoGenerating: false });
            return;
          }
          console.warn(`[MediaGenerator] 查询任务状态失败 (${consecutiveErrors}/${maxConsecutiveErrors}):`, result.error);
          setTimeout(poll, 5000);
        }
      } catch (error: any) {
        consecutiveErrors++;
        console.error(`[MediaGenerator] 轮询任务状态异常 (${consecutiveErrors}/${maxConsecutiveErrors}):`, error);
        
        if (consecutiveErrors >= maxConsecutiveErrors) {
          toast.error(`连续 ${maxConsecutiveErrors} 次查询异常，请检查网络连接`, 8000);
          updateShot(shotId, { videoGenerating: false });
          return;
        }
        
        setTimeout(poll, 5000);
      }
    };
    
    // 延迟 3 秒后开始第一次轮询
    setTimeout(poll, 3000);
  };

  // 生成单个视频
  const handleGenerateVideo = async (shot: Shot, regenerate: boolean = false) => {
    const selectedModel = VIDEO_MODELS.find(m => m.id === selectedVideoModel);
    const isRunningHubModel = selectedModel?.isRunningHub;
    
    // 检查 API Key
    if (isRunningHubModel) {
      if (provider !== 'runninghub' || !apiKey || !apiKey.trim()) {
        toast.error('请先在顶部配置 RunningHub API Key（选择 RunningHub 服务）');
        return;
      }
    } else {
      if (!dayuApiKey || !dayuApiKey.trim()) {
        toast.error('请先配置大洋芋 API Key（用于视频生成）');
        return;
      }
    }
    
    if (!shot.videoPrompt) {
      toast.error('该镜头没有视频提示词');
      return;
    }
    
    updateShot(shot.id, { videoGenerating: true });
    
    if (!selectedModel) {
      toast.error('请选择视频模型');
      updateShot(shot.id, { videoGenerating: false });
      return;
    }
    
    // 获取当前镜头的图片 URL（如果有）
    const shotImages = shot.imageUrls && shot.imageUrls.length > 0 ? shot.imageUrls : [];
    
    // 判断模式：如果有图片，则为图生视频；否则为文生视频
    const hasImages = shotImages.length > 0;
    
    // 如果有图片，必须使用选中的图片
    if (hasImages) {
      // 检查是否有选中的图片
      if (shot.selectedImageIndex === undefined || shot.selectedImageIndex < 0) {
        toast.error('请先选择要用于生成视频的图片（点击图片即可选择）', 6000);
        updateShot(shot.id, { videoGenerating: false });
        return;
      }
      
      // 验证选中的图片索引是否有效
      if (shot.selectedImageIndex >= shotImages.length) {
        toast.error('选中的图片索引无效，请重新选择图片', 6000);
        updateShot(shot.id, { videoGenerating: false });
        return;
      }
    }
    
    const mode = hasImages ? '图生视频 (Image-to-Video)' : '文生视频 (Text-to-Video)';
    console.log(`[MediaGenerator] 视频生成模式: ${mode}, 图片数量: ${shotImages.length}, 选中图片索引: ${shot.selectedImageIndex}`);
    
    if (hasImages) {
      const selectedImageIndex = shot.selectedImageIndex!;
      toast.info(`使用图生视频模式，基于选中的图片（第 ${selectedImageIndex + 1} 张）生成视频`, 5000);
    } else {
      toast.info('使用文生视频模式，直接根据提示词生成视频');
    }
    
    try {
      let result;
      
      // RunningHub 模型处理
      if (isRunningHubModel) {
        if (hasImages) {
          // 图生视频模式
          const selectedImageUrl = shotImages[shot.selectedImageIndex!];
          
          if (!selectedImageUrl) {
            toast.error('选中的图片URL无效，请重新选择图片', 6000);
            updateShot(shot.id, { videoGenerating: false });
            return;
          }
          
          const options: RunningHubVideoOptions = {
            prompt: shot.videoPrompt,
            model: 'wan2.2',
            image_url: selectedImageUrl,
            duration: selectedModel.duration || 10,
          };
          
          result = await generateRunningHubVideo(apiKey, options);
        } else {
          // 文生视频模式
          const options: RunningHubVideoOptions = {
            prompt: shot.videoPrompt,
            model: 'wan2.2',
            duration: selectedModel.duration || 10,
          };
          
          result = await generateRunningHubVideo(apiKey, options);
        }
      } else {
        // 大洋芋模型处理
        if (hasImages) {
          // 图生视频模式：必须使用选中的图片
          const selectedImageUrl = shotImages[shot.selectedImageIndex!];
          
          if (!selectedImageUrl) {
            toast.error('选中的图片URL无效，请重新选择图片', 6000);
            updateShot(shot.id, { videoGenerating: false });
            return;
          }
          
          console.log(`[MediaGenerator] 使用选中的图片生成视频: 索引 ${shot.selectedImageIndex}, URL: ${selectedImageUrl.substring(0, 50)}...`);
          
          const options: DayuVideoGenerationOptions = {
            prompt: shot.videoPrompt,
            model: selectedVideoModel,
            input_reference: selectedImageUrl, // 使用选中的图片
          };
          
          result = await generateImageToVideo(dayuApiKey, options);
        } else {
          // 文生视频模式
          const options: DayuVideoGenerationOptions = {
            prompt: shot.videoPrompt,
            model: selectedVideoModel,
          };
          
          result = await generateTextToVideo(dayuApiKey, options);
        }
      }
      
      if (result.success) {
        // 记录完整的响应数据用于调试
        console.log('[MediaGenerator] 视频生成响应:', {
          hasTaskId: !!result.taskId,
          taskId: result.taskId,
          hasVideoUrl: !!result.videoUrl,
          videoUrl: result.videoUrl,
          status: result.status,
          progress: result.progress,
          dataKeys: result.data ? Object.keys(result.data) : [],
          fullData: result.data,
        });
        
        // 如果result中没有taskId，尝试从result.data中提取
        if (!result.taskId && result.data) {
          const extractedTaskId = result.data.id || result.data.taskId || result.data.task_id || result.data.video_id;
          if (extractedTaskId) {
            console.log('[MediaGenerator] 从data中提取taskId:', extractedTaskId);
            result.taskId = extractedTaskId;
          }
        }
        
        // 检查是否直接返回了视频URL（同步完成，较少见）
        if (result.videoUrl) {
          // 自动缓存视频，并追加到 videoUrls 数组
          try {
            toast.info('视频生成成功，正在缓存视频...', 3000);
            const cachedUrl = await cacheVideo(result.videoUrl);
            
            // 追加模式：保留原有视频，添加新视频
            const currentVideoUrls = shot.videoUrls || (shot.videoUrl ? [shot.videoUrl] : []);
            const currentCachedUrls = shot.cachedVideoUrls || (shot.cachedVideoUrl ? [shot.cachedVideoUrl] : []);
            const updatedVideoUrls = [...currentVideoUrls, result.videoUrl];
            const updatedCachedUrls = [...currentCachedUrls, cachedUrl];
            
            updateShot(shot.id, { 
              videoUrl: result.videoUrl, // 保留向后兼容，显示最新的视频
              videoUrls: updatedVideoUrls, // 追加到数组
              cachedVideoUrl: cachedUrl, // 保留向后兼容
              cachedVideoUrls: updatedCachedUrls, // 追加到数组
              videoGenerating: false 
            });
            toast.success(`视频生成成功并已缓存！（共 ${updatedVideoUrls.length} 个视频）`, 8000);
          } catch (cacheError: any) {
            console.warn('[MediaGenerator] 视频缓存失败，使用原始URL:', cacheError);
            
            // 追加模式：即使缓存失败也追加视频URL
            const currentVideoUrls = shot.videoUrls || (shot.videoUrl ? [shot.videoUrl] : []);
            const updatedVideoUrls = [...currentVideoUrls, result.videoUrl];
            
            updateShot(shot.id, { 
              videoUrl: result.videoUrl,
              videoUrls: updatedVideoUrls,
              videoGenerating: false 
            });
            toast.success(`视频生成成功！（共 ${updatedVideoUrls.length} 个视频）`, 8000);
          }
        } else if (result.taskId) {
          // 异步任务，开始轮询
          console.log(`[MediaGenerator] 视频生成任务已提交: taskId=${result.taskId}, status=${result.status}, progress=${result.progress}`);
          const modelInfo = selectedModel?.name || selectedVideoModel;
          const isProModel = modelInfo?.includes('Pro') || modelInfo?.includes('pro');
          const isRunningHub = isRunningHubModel;
          const estimatedTime = isRunningHub ? '3-10分钟' : (isProModel ? '15-30分钟' : '3-5分钟');
          
          toast.info(
            `视频生成任务已提交\n` +
            `任务ID: ${result.taskId}\n` +
            `预计耗时: ${estimatedTime}\n` +
            `系统会自动获取结果，请耐心等待...`,
            8000
          );
          
          // 使用对应的轮询函数
          if (isRunningHub) {
            await pollRunningHubTaskStatus(result.taskId, shot.id);
          } else {
            await pollTaskStatus(result.taskId, shot.id);
          }
        } else {
          // 成功但没有taskId和videoUrl，可能是响应格式问题
          console.warn('[MediaGenerator] 视频生成响应异常:', result);
          toast.warning('视频生成任务已提交，但未获取到任务ID，请稍后手动检查', 8000);
          updateShot(shot.id, { videoGenerating: false });
        }
      } else {
        // 生成失败
        const errorMsg = result.error || '未知错误';
        if (errorMsg.includes('负载已饱和') || errorMsg.includes('saturated') || errorMsg.includes('负载')) {
          toast.error('服务器暂时繁忙，请稍后重试', 8000);
        } else {
          toast.error(`视频生成失败: ${errorMsg}`, 6000);
        }
        updateShot(shot.id, { videoGenerating: false });
      }
    } catch (error: any) {
      const errorMsg = error.message || '未知错误';
      if (errorMsg.includes('负载已饱和') || errorMsg.includes('saturated') || errorMsg.includes('负载')) {
        toast.error('服务器暂时繁忙，请稍后重试', 8000);
      } else {
        toast.error(`视频生成失败: ${errorMsg}`, 6000);
      }
      updateShot(shot.id, { videoGenerating: false });
    }
  };

  // 并发控制辅助函数：限制同时执行的任务数量
  const runConcurrentTasks = async <T,>(
    tasks: (() => Promise<T>)[],
    concurrency: number,
    onProgress?: (completed: number, total: number) => void
  ): Promise<{ success: T[]; failed: { error: any; index: number }[] }> => {
    const results: { success: T[]; failed: { error: any; index: number }[] } = {
      success: [],
      failed: []
    };
    
    let completed = 0;
    let currentIndex = 0;
    
    // 创建并发池
    const workers: Promise<void>[] = [];
    
    const runNext = async (): Promise<void> => {
      while (currentIndex < tasks.length) {
        const index = currentIndex++;
        const task = tasks[index];
        
        try {
          const result = await task();
          results.success.push(result);
          completed++;
          if (onProgress) {
            onProgress(completed, tasks.length);
          }
        } catch (error: any) {
          results.failed.push({ error, index });
          completed++;
          if (onProgress) {
            onProgress(completed, tasks.length);
          }
        }
      }
    };
    
    // 启动并发工作池
    for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
      workers.push(runNext());
    }
    
    // 等待所有任务完成
    await Promise.all(workers);
    
    return results;
  };

  // 批量生成图片（选中的镜头，支持追加模式）- 并发执行
  const handleBatchGenerateImages = async () => {
    // 只处理选中的镜头
    const selectedShots = shots.filter(s => s.selected);
    if (selectedShots.length === 0) {
      toast.warning('请先选择需要生成图片的镜头', 4000);
      return;
    }
    
    // 从选中的镜头中过滤出有图片提示词且不在生成中的
    // 注意：不再过滤已有图片的镜头，允许继续追加生成
    const shotsToGenerate = selectedShots.filter(s => 
      s.imagePrompt && 
      !s.imageGenerating
    );
    
    if (shotsToGenerate.length === 0) {
      // 检查是否有正在生成中的镜头
      const generatingShots = selectedShots.filter(s => s.imageGenerating);
      if (generatingShots.length > 0) {
        toast.info(`选中的镜头中有 ${generatingShots.length} 个正在生成图片，请等待完成`, 4000);
      } else {
        toast.info('选中的镜头都没有图片提示词，请先添加提示词', 4000);
      }
      return;
    }
    
    // 统计已有图片的镜头数量
    const shotsWithImages = shotsToGenerate.filter(s => s.imageUrls && s.imageUrls.length > 0);
    const shotsWithoutImages = shotsToGenerate.filter(s => !s.imageUrls || s.imageUrls.length === 0);
    
    const confirmMessage = shotsWithImages.length > 0
      ? `确定要为选中的 ${shotsToGenerate.length} 个镜头批量生成图片吗？\n\n` +
        `- ${shotsWithoutImages.length} 个镜头将生成第一张图片\n` +
        `- ${shotsWithImages.length} 个镜头将追加生成新图片（保留原有图片）\n\n` +
        `将并发生成，提高效率。`
      : `确定要为选中的 ${shotsToGenerate.length} 个镜头批量生成图片吗？\n\n将并发生成，提高效率。`;
    
    if (!confirm(confirmMessage)) {
      return;
    }
    
    // 初始化进度
    setBatchProgress({ current: 0, total: shotsToGenerate.length, type: 'image' });
    
    try {
      // 创建任务数组（每个镜头一个任务）
      const tasks = shotsToGenerate.map((shot, index) => 
        async () => {
          const existingCount = shot.imageUrls?.length || 0;
          console.log(`[MediaGenerator] 开始并发生成图片: 镜头 ${shot.number} (${index + 1}/${shotsToGenerate.length})，已有 ${existingCount} 张图片，将追加生成`);
          await handleGenerateImage(shot);
          return { shot, index };
        }
      );
      
      // 并发执行，最多同时5个请求（图片生成相对快速，可以设置更高的并发数）
      const concurrency = 5;
      const results = await runConcurrentTasks(
        tasks,
        concurrency,
        (completed, total) => {
          setBatchProgress(prev => prev ? { ...prev, current: completed } : null);
        }
      );
      
      const successCount = results.success.length;
      const failCount = results.failed.length;
      
      if (failCount === 0) {
        toast.success(`成功为 ${successCount} 个镜头生成图片！（并发执行，已追加到原有图片）`, 8000);
      } else {
        toast.warning(`完成：成功 ${successCount} 个，失败 ${failCount} 个`, 8000);
        // 记录失败的镜头
        results.failed.forEach(({ error, index }) => {
          console.error(`[MediaGenerator] 图片生成失败: 镜头 ${shotsToGenerate[index].number}`, error);
        });
      }
    } catch (error: any) {
      toast.error(`批量生成图片失败: ${error.message || '未知错误'}`, 6000);
    } finally {
      setBatchProgress(null);
    }
  };

  // 批量生成视频（选中的镜头，支持追加模式）- 并发执行
  const handleBatchGenerateVideos = async () => {
    // 只处理选中的镜头
    const selectedShots = shots.filter(s => s.selected);
    if (selectedShots.length === 0) {
      toast.warning('请先选择需要生成视频的镜头', 4000);
      return;
    }
    
    // 从选中的镜头中过滤出有视频提示词且不在生成中的
    // 注意：不再过滤已有视频的镜头，允许继续追加生成
    const shotsToGenerate = selectedShots.filter(s => {
      if (!s.videoPrompt || s.videoGenerating) {
        return false;
      }
      // 如果有图片，必须已选中图片
      if (s.imageUrls && s.imageUrls.length > 0) {
        return s.selectedImageIndex !== undefined && s.selectedImageIndex >= 0 && s.selectedImageIndex < s.imageUrls.length;
      }
      // 没有图片也可以生成（文生视频）
      return true;
    });
    
    if (shotsToGenerate.length === 0) {
      const shotsWithImagesButNoSelection = selectedShots.filter(s => 
        s.videoPrompt && 
        !s.videoGenerating &&
        s.imageUrls && 
        s.imageUrls.length > 0 &&
        (s.selectedImageIndex === undefined || s.selectedImageIndex < 0)
      );
      
      if (shotsWithImagesButNoSelection.length > 0) {
        toast.error(`有 ${shotsWithImagesButNoSelection.length} 个镜头有图片但未选择图片，请先选择图片后再批量生成视频`, 8000);
      } else {
        const generatingShots = selectedShots.filter(s => s.videoGenerating);
        if (generatingShots.length > 0) {
          toast.info(`选中的镜头中有 ${generatingShots.length} 个正在生成视频，请等待完成`, 4000);
        } else {
          toast.info('选中的镜头都没有视频提示词，请先添加提示词', 4000);
        }
      }
      return;
    }
    
    // 统计已有视频的镜头数量
    const shotsWithVideos = shotsToGenerate.filter(s => s.videoUrl);
    const shotsWithoutVideos = shotsToGenerate.filter(s => !s.videoUrl);
    
    const confirmMessage = shotsWithVideos.length > 0
      ? `确定要为选中的 ${shotsToGenerate.length} 个镜头批量生成视频吗？\n\n` +
        `- ${shotsWithoutVideos.length} 个镜头将生成第一个视频\n` +
        `- ${shotsWithVideos.length} 个镜头将追加生成新视频（保留原有视频）\n\n` +
        `注意：将使用每个镜头选中的图片生成视频。\n\n将并发生成，提高效率。`
      : `确定要批量生成 ${shotsToGenerate.length} 个镜头的视频吗？\n\n注意：将使用每个镜头选中的图片生成视频。\n\n将并发生成，提高效率。`;
    
    if (!confirm(confirmMessage)) {
      return;
    }
    
    // 初始化进度
    setBatchProgress({ current: 0, total: shotsToGenerate.length, type: 'video' });
    
    try {
      // 创建任务数组（每个镜头一个任务）
      const tasks = shotsToGenerate.map((shot, index) => 
        async () => {
          const hasExistingVideo = !!shot.videoUrl;
          console.log(`[MediaGenerator] 开始并发生成视频: 镜头 ${shot.number} (${index + 1}/${shotsToGenerate.length})，${hasExistingVideo ? '已有视频，将追加生成' : '将生成第一个视频'}`);
          await handleGenerateVideo(shot);
          return { shot, index };
        }
      );
      
      // 并发执行，最多同时3个请求（视频生成较耗时，设置较低的并发数避免API限流）
      const concurrency = 3;
      const results = await runConcurrentTasks(
        tasks,
        concurrency,
        (completed, total) => {
          setBatchProgress(prev => prev ? { ...prev, current: completed } : null);
        }
      );
      
      const successCount = results.success.length;
      const failCount = results.failed.length;
      
      if (failCount === 0) {
        toast.success(`成功为 ${successCount} 个镜头生成视频！（并发执行，已追加到原有视频）`, 8000);
      } else {
        toast.warning(`完成：成功 ${successCount} 个，失败 ${failCount} 个`, 8000);
        // 记录失败的镜头
        results.failed.forEach(({ error, index }) => {
          console.error(`[MediaGenerator] 视频生成失败: 镜头 ${shotsToGenerate[index].number}`, error);
        });
      }
    } catch (error: any) {
      toast.error(`批量生成视频失败: ${error.message || '未知错误'}`, 6000);
    } finally {
      setBatchProgress(null);
    }
  };

  // 批量生成语音（占位函数，待实现）
  const handleBatchGenerateVoice = async () => {
    const selectedShots = shots.filter(s => s.selected && s.caption);
    if (selectedShots.length === 0) {
      toast.warning('请先选择需要生成语音的镜头');
      return;
    }
    
    if (!confirm(`确定要为 ${selectedShots.length} 个镜头批量生成语音吗？`)) {
      return;
    }
    
    toast.info('批量生成语音功能开发中...', 3000);
    // TODO: 实现批量语音生成逻辑
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
        <div className="flex flex-nowrap items-end gap-2 pt-3 border-t border-slate-700 overflow-x-auto">
          {/* 大洋芋 API Key 输入 */}
          <div className="flex-shrink-0 w-[160px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block flex items-center gap-1">
              大洋芋 API Key
              <span className="text-amber-400 text-[9px]">(視頻)</span>
            </label>
            <input
              type="password"
              value={dayuApiKey}
              onChange={(e) => setDayuApiKey(e.target.value)}
              placeholder="輸入 API Key"
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            />
      </div>
          
          {/* 即梦 API 配置（仅在选择即梦模型时显示） */}
          {selectedImageModel === 'jimeng' && (
            <>
              <div className="flex-shrink-0 w-[140px]">
                <label className="text-[10px] text-slate-500 mb-0.5 block flex items-center gap-1">
                  即梦 API 地址
                  <span className="text-blue-400 text-[9px]">(圖片)</span>
                </label>
                <input
                  type="text"
                  value={jimengApiBaseUrl}
                  onChange={(e) => setJimengApiBaseUrl(e.target.value)}
                  placeholder="http://localhost:5100"
                  className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div className="flex-shrink-0 w-[160px]">
                <label className="text-[10px] text-slate-500 mb-0.5 block flex items-center gap-1">
                  即梦 SESSION_ID
                  <span className="text-blue-400 text-[9px]">(圖片)</span>
                </label>
                <input
                  type="text"
                  value={jimengSessionId}
                  onChange={(e) => setJimengSessionId(e.target.value)}
                  placeholder="輸入 SESSION_ID"
                  className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div className="flex-shrink-0">
                <label className="text-[10px] text-slate-500 mb-0.5 block">
                  角色库
                </label>
                <button
                  onClick={() => setShowCharacterLibrary(true)}
                  className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 text-[11px] rounded flex items-center gap-1"
                  title="管理角色库（支持图生图）"
                >
                  <Users size={14} />
                  管理
                </button>
              </div>
            </>
          )}

          {/* RunningHub 提示（API Key在全局配置中） */}
          {((selectedImageModel && selectedImageModel.startsWith('runninghub-')) || selectedVideoModel === 'runninghub-wan2.2') && provider !== 'runninghub' && (
            <div className="flex-shrink-0 px-3 py-1 bg-purple-900/30 border border-purple-700/50 rounded text-[10px] text-purple-300 flex items-center">
              ⚠️ 请在顶部配置 RunningHub API Key
            </div>
          )}

          <div className="flex-shrink-0 w-[120px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block">圖片模型</label>
            <select
              value={selectedImageModel}
              onChange={(e) => {
                const newModel = e.target.value;
                setSelectedImageModel(newModel);
                
                // 如果切换到 DALL-E 3，检查当前比例是否支持
                if (newModel === 'dall-e-3') {
                  const currentRatio = IMAGE_RATIOS.find(r => r.id === selectedImageRatio);
                  if (currentRatio && !currentRatio.dallE3Supported) {
                    // 自动切换到第一个支持的比例（1:1）
                    setSelectedImageRatio('1:1');
                  }
                }
                // 如果切换到 sora-image，检查当前比例是否支持
                if (newModel === 'sora-image') {
                  const currentRatio = IMAGE_RATIOS.find(r => r.id === selectedImageRatio);
                  if (currentRatio && !currentRatio.soraImageSupported) {
                    // 自动切换到第一个支持的比例（1:1）
                    setSelectedImageRatio('1:1');
                  }
                }
              }}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {IMAGE_MODELS.map(model => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </select>
          </div>
          
          <div className="flex-shrink-0 w-[120px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block">視頻模型</label>
            <select
              value={selectedVideoModel}
              onChange={(e) => {
                const newModel = e.target.value;
                setSelectedVideoModel(newModel);
                
                // 切换模型时，自动更新 size 和 duration 的默认值
                const model = VIDEO_MODELS.find(m => m.id === newModel);
                if (model) {
                  if (model.defaultSize) {
                    setSelectedVideoSize(model.defaultSize);
                  }
                  if (model.duration) {
                    setSelectedVideoDuration(model.duration);
                  }
                }
              }}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {VIDEO_MODELS.map(model => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </select>
          </div>
          
          {/* 视频分辨率设置 */}
          <div className="flex-shrink-0 w-[90px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block">視頻分辨率</label>
            <select
              value={selectedVideoSize}
              onChange={(e) => setSelectedVideoSize(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {(() => {
                const model = VIDEO_MODELS.find(m => m.id === selectedVideoModel);
                const sizes = model?.supportedSizes || ['720P', '1080P'];
                return sizes.map(size => (
                  <option key={size} value={size}>{size}</option>
                ));
              })()}
            </select>
          </div>
          
          {/* 视频时长设置 */}
          <div className="flex-shrink-0 w-[90px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block">視頻時長（秒）</label>
            <select
              value={selectedVideoDuration}
              onChange={(e) => setSelectedVideoDuration(Number(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {(() => {
                const model = VIDEO_MODELS.find(m => m.id === selectedVideoModel);
                const durations = model?.supportedDurations || [10];
                return durations.map(duration => (
                  <option key={duration} value={duration}>{duration}秒</option>
                ));
              })()}
            </select>
          </div>
          
          {/* 视频方向选择 */}
          <div className="flex-shrink-0 w-[90px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block">視頻方向</label>
            <select
              value={selectedVideoOrientation}
              onChange={(e) => setSelectedVideoOrientation(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              <option value="landscape">横屏</option>
              <option value="portrait">竖屏</option>
            </select>
          </div>
          
          <div className="flex-shrink-0 w-[90px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block">
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
              onChange={(e) => {
                const newRatio = e.target.value;
                setSelectedImageRatio(newRatio);
                
                // 当图片比例改变时，自动更新视频方向（但用户可以手动覆盖）
                const currentRatio = IMAGE_RATIOS.find(r => r.id === newRatio);
                if (currentRatio) {
                  if (currentRatio.width > currentRatio.height) {
                    setSelectedVideoOrientation('landscape'); // 横屏
                  } else if (currentRatio.width < currentRatio.height) {
                    setSelectedVideoOrientation('portrait'); // 竖屏
                  } else {
                    // 正方形默认使用 landscape
                    setSelectedVideoOrientation('landscape');
                  }
                }
              }}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {IMAGE_RATIOS.map(ratio => {
                // DALL-E 3 只显示支持的比例
                if (selectedImageModel === 'dall-e-3' && !ratio.dallE3Supported) {
                  return null;
                }
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

          <div className="flex-shrink-0 w-[100px]">
            <label className="text-[10px] text-slate-500 mb-0.5 block">風格設置</label>
            <select
              value={selectedStyle}
              onChange={(e) => setSelectedStyle(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
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
              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
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
            
            {/* 批量操作按钮 */}
            <div className="flex items-center gap-1 border-l border-slate-700 pl-2 ml-2">
              <button
                onClick={handleBatchGenerateImages}
                disabled={generatingCount > 0}
                className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded transition-all disabled:opacity-50"
                title="批量生成图片"
              >
                <Rocket size={14} />
                批量生成圖片
              </button>
              <button
                onClick={handleBatchGenerateVideos}
                disabled={generatingCount > 0}
                className="flex items-center gap-1 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded transition-all disabled:opacity-50"
                title="批量生成视频"
              >
                <Rocket size={14} />
                批量生成視頻
              </button>
              <button
                onClick={handleBatchGenerateVoice}
                disabled={generatingCount > 0}
                className="flex items-center gap-1 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium rounded transition-all disabled:opacity-50"
                title="批量生成语音"
              >
                <Rocket size={14} />
                批量生成語音
              </button>
            </div>
            
            <span className="text-xs text-slate-500 ml-2">
              {generatingCount > 0 ? `生成中: ${generatingCount} 個任務...` : '就緒'}
            </span>
          </div>
          </div>

        {/* 镜头列表 - 表格式布局 */}
        <div className="flex-1 overflow-x-auto custom-scrollbar">
          {shots.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <FileText size={48} className="mx-auto mb-4 opacity-50" />
              <p>暫無鏡頭數據</p>
              <p className="text-xs mt-2">請從改寫工具讀取腳本或手動添加鏡頭</p>
            </div>
          ) : (
            <div className="min-w-full">
              {/* 表头 */}
              <div className="grid grid-cols-[60px_200px_160px_220px_160px_220px_140px] gap-1.5 bg-slate-800/70 border-b border-slate-700 p-2 text-xs font-semibold text-slate-300 sticky top-0 z-10">
                <div className="flex items-center justify-center">編號</div>
                <div className="flex items-center">文案</div>
                <div className="flex items-center">提示詞</div>
                <div className="flex items-center">新圖</div>
                <div className="flex items-center">視頻提示詞</div>
                <div className="flex items-center">視頻</div>
                <div className="flex items-center justify-end pr-2">操作</div>
              </div>
              
              {/* 表格内容 */}
              {shots.map((shot) => (
                <div
                  key={shot.id}
                  className={`grid grid-cols-[60px_200px_160px_220px_160px_220px_140px] gap-1.5 border-b border-slate-700/50 p-2 hover:bg-slate-800/30 transition-colors ${
                    shot.selected ? 'bg-emerald-500/10' : ''
                  }`}
                >
                  {/* 编号列 */}
                  <div className="flex items-center justify-center">
                    <input
                      type="checkbox"
                      checked={shot.selected || false}
                      onChange={(e) => updateShot(shot.id, { selected: e.target.checked })}
                      className="rounded mr-2"
                    />
                    <span className="text-xs font-semibold text-emerald-400">{shot.number}</span>
                  </div>

                  {/* 文案列 */}
                  <div className="flex flex-col gap-1">
                    <div className={`text-[11px] text-slate-300 leading-relaxed ${
                      expandedCaptions.has(shot.id) ? '' : 'line-clamp-4'
                    }`}>
                      {shot.caption || '無文案'}
                    </div>
                    {shot.caption && shot.caption.length > 100 && (
                      <button
                        onClick={() => {
                          setExpandedCaptions(prev => {
                            const newSet = new Set(prev);
                            if (newSet.has(shot.id)) {
                              newSet.delete(shot.id);
                            } else {
                              newSet.add(shot.id);
                            }
                            return newSet;
                          });
                        }}
                        className="text-[9px] text-blue-400 hover:text-blue-300 self-start"
                      >
                        {expandedCaptions.has(shot.id) ? '收起' : '展开'}
                      </button>
                    )}
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => {
                          // 提取文案中的角色（格式：角色名-语气: 或 角色名:）
                          const roleMatch = shot.caption?.match(/^([^-:：]+)[-:：]/);
                          const extractedRole = roleMatch ? roleMatch[1].trim() : '角色';
                          setEditingRole({ shotId: shot.id, role: extractedRole });
                        }}
                        className="text-[10px] px-1.5 py-0.5 bg-blue-600 hover:bg-blue-500 text-white rounded"
                        title="角色（可编辑）"
                      >
                        {editingRole?.shotId === shot.id ? (
                          <input
                            type="text"
                            value={editingRole.role}
                            onChange={(e) => setEditingRole({ ...editingRole, role: e.target.value })}
                            onBlur={() => {
                              // 更新文案，替换开头的角色
                              if (shot.caption) {
                                const toneMatch = shot.caption.match(/^[^-:：]+-([^:：]+)[:：]/);
                                const tone = toneMatch ? toneMatch[1].trim() : '';
                                if (tone) {
                                  const newCaption = shot.caption.replace(/^[^-:：]+[-:：]/, `${editingRole.role}-`);
                                  updateShot(shot.id, { caption: newCaption });
                                } else {
                                  const newCaption = shot.caption.replace(/^[^-:：]+[-:：]/, `${editingRole.role}:`);
                                  updateShot(shot.id, { caption: newCaption });
                                }
                              } else {
                                updateShot(shot.id, { caption: `${editingRole.role}-` });
                              }
                              setEditingRole(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.currentTarget.blur();
                              }
                            }}
                            className="w-16 bg-slate-800 border border-slate-600 rounded px-1 text-[10px] text-slate-200"
                            autoFocus
                          />
                        ) : (
                          shot.caption?.match(/^([^-:：]+)[-:：]/)?.[1]?.trim() || '添加'
                        )}
                      </button>
                      <button
                        onClick={() => {
                          // 提取文案中的语气（格式：角色名-语气:）
                          const toneMatch = shot.caption?.match(/^[^-:：]+-([^:：]+)[:：]/);
                          const extractedTone = toneMatch ? toneMatch[1].trim() : '语气';
                          setEditingTone({ shotId: shot.id, tone: extractedTone });
                        }}
                        className="text-[10px] px-1.5 py-0.5 bg-slate-700 hover:bg-slate-600 text-white rounded"
                        title="语气（可编辑）"
                      >
                        {editingTone?.shotId === shot.id ? (
                          <input
                            type="text"
                            value={editingTone.tone}
                            onChange={(e) => setEditingTone({ ...editingTone, tone: e.target.value })}
                            onBlur={() => {
                              // 更新文案，替换语气部分
                              if (shot.caption) {
                                const roleMatch = shot.caption.match(/^([^-:：]+)[-:：]/);
                                const role = roleMatch ? roleMatch[1].trim() : '角色';
                                const newCaption = shot.caption.replace(/^[^-:：]+-[^:：]+[:：]/, `${role}-${editingTone.tone}:`);
                                updateShot(shot.id, { caption: newCaption });
                              } else {
                                updateShot(shot.id, { caption: `角色-${editingTone.tone}:` });
                              }
                              setEditingTone(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.currentTarget.blur();
                              }
                            }}
                            className="w-16 bg-slate-800 border border-slate-600 rounded px-1 text-[10px] text-slate-200"
                            autoFocus
                          />
                        ) : (
                          shot.caption?.match(/^[^-:：]+-([^:：]+)[:：]/)?.[1]?.trim() || '讲述者'
                        )}
                      </button>
                    </div>
                  </div>

                  {/* 提示词列（图片提示词） */}
                  <div className="flex flex-col gap-1">
                    {shot.editing ? (
                      <textarea
                        value={shot.imagePrompt}
                        onChange={(e) => updateShot(shot.id, { imagePrompt: e.target.value })}
                        className="w-full bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-slate-200 resize-none h-16"
                        placeholder="圖片提示詞"
                      />
                    ) : (
                      <>
                        <div className={`text-[10px] text-slate-300 leading-relaxed ${
                          expandedImagePrompts.has(shot.id) ? '' : 'line-clamp-3'
                        }`}>
                          {shot.imagePrompt || '無'}
                        </div>
                        {shot.imagePrompt && shot.imagePrompt.length > 60 && (
                          <button
                            onClick={() => {
                              setExpandedImagePrompts(prev => {
                                const newSet = new Set(prev);
                                if (newSet.has(shot.id)) {
                                  newSet.delete(shot.id);
                                } else {
                                  newSet.add(shot.id);
                                }
                                return newSet;
                              });
                            }}
                            className="text-[9px] text-blue-400 hover:text-blue-300 self-start"
                          >
                            {expandedImagePrompts.has(shot.id) ? '收起' : '展开'}
                          </button>
                        )}
                        <button
                          onClick={() => {
                            // 提取提示词开头的景别（如"中景,"、"近景,"等）
                            const shotTypeMatch = shot.imagePrompt?.match(/^([^,，]+)[,，]/);
                            const extractedShotType = shotTypeMatch ? shotTypeMatch[1].trim() : '中景';
                            setEditingShotType({ shotId: shot.id, shotType: extractedShotType });
                          }}
                          className="text-[10px] px-1.5 py-0.5 bg-blue-600 hover:bg-blue-500 text-white rounded self-start"
                          title="景别（可编辑）"
                        >
                          {editingShotType?.shotId === shot.id ? (
                            <input
                              type="text"
                              value={editingShotType.shotType}
                              onChange={(e) => setEditingShotType({ ...editingShotType, shotType: e.target.value })}
                              onBlur={() => {
                                // 更新提示词，替换开头的景别
                                if (shot.imagePrompt) {
                                  const newPrompt = shot.imagePrompt.replace(/^[^,，]+[,，]\s*/, `${editingShotType.shotType}, `);
                                  updateShot(shot.id, { imagePrompt: newPrompt, shotType: editingShotType.shotType });
                                } else {
                                  updateShot(shot.id, { imagePrompt: `${editingShotType.shotType}, `, shotType: editingShotType.shotType });
                                }
                                setEditingShotType(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.currentTarget.blur();
                                }
                              }}
                              className="w-12 bg-slate-800 border border-slate-600 rounded px-1 text-[10px] text-slate-200"
                              autoFocus
                            />
                          ) : (
                            shot.shotType || (shot.imagePrompt?.match(/^([^,，]+)[,，]/)?.[1]?.trim()) || '中景'
                          )}
                        </button>
                      </>
                    )}
                  </div>

                  {/* 新图列（图片预览） */}
                  <div className="flex flex-col gap-1">
                    {shot.imageUrls && shot.imageUrls.length > 0 ? (
                      <>
                        {shot.imageUrls.length <= 2 ? (
                          <>
                            {/* 主图 */}
                            <div className="relative">
                              <img
                                src={shot.imageUrls[shot.selectedImageIndex !== undefined && shot.selectedImageIndex >= 0 ? shot.selectedImageIndex : 0]}
                                alt={`镜头${shot.number}-主图`}
                                className="w-full h-32 object-cover rounded border border-slate-700 cursor-pointer"
                                onDoubleClick={() => {
                                  const currentIndex = shot.selectedImageIndex !== undefined && shot.selectedImageIndex >= 0 ? shot.selectedImageIndex : 0;
                                  setEnlargedImageUrl(shot.imageUrls![currentIndex]);
                                }}
                                onClick={() => {
                                  const currentIndex = shot.selectedImageIndex !== undefined && shot.selectedImageIndex >= 0 ? shot.selectedImageIndex : 0;
                                  const nextIndex = (currentIndex + 1) % shot.imageUrls!.length;
                                  updateShot(shot.id, { selectedImageIndex: nextIndex });
                                }}
                              />
                              {shot.imageGenerating && (
                                <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded">
                                  <Loader2 size={16} className="animate-spin text-emerald-400" />
                                </div>
                              )}
                            </div>
                            {/* 缩略图（只有1-2张时显示） */}
                            {shot.imageUrls.length > 1 && (
                              <div className="flex gap-1">
                                {shot.imageUrls.slice(0, 2).map((url, index) => {
                                  const isSelected = (shot.selectedImageIndex !== undefined && shot.selectedImageIndex >= 0 ? shot.selectedImageIndex : 0) === index;
                                  return (
                                    <img
                                      key={index}
                                      src={url}
                                      alt={`缩略图${index + 1}`}
                                      className={`w-12 h-12 object-cover rounded border-2 cursor-pointer ${
                                        isSelected ? 'border-orange-500' : 'border-slate-700'
                                      }`}
                                      onClick={() => updateShot(shot.id, { selectedImageIndex: index })}
                                    />
                                  );
                                })}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            {/* 超过2张时，缩小预览，网格排列 */}
                            <div className="grid grid-cols-2 gap-1">
                              {shot.imageUrls.map((url, index) => {
                                const isSelected = (shot.selectedImageIndex !== undefined && shot.selectedImageIndex >= 0 ? shot.selectedImageIndex : 0) === index;
                                return (
                                  <div key={index} className="relative">
                                    <img
                                      src={url}
                                      alt={`图片${index + 1}`}
                                      className={`w-full h-16 object-cover rounded border-2 cursor-pointer ${
                                        isSelected ? 'border-orange-500' : 'border-slate-700'
                                      }`}
                                      onClick={() => updateShot(shot.id, { selectedImageIndex: index })}
                                      onDoubleClick={() => setEnlargedImageUrl(url)}
                                    />
                                    {isSelected && (
                                      <div className="absolute top-0.5 left-0.5 bg-orange-500 text-white text-[8px] px-1 rounded">
                                        {index + 1}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                            {shot.imageGenerating && (
                              <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded">
                                <Loader2 size={16} className="animate-spin text-emerald-400" />
                              </div>
                            )}
                          </>
                        )}
                      </>
                    ) : (
                      <div className="flex items-center justify-center h-32 bg-slate-800/50 rounded border border-slate-700 text-slate-500 text-[10px]">
                        {shot.imageGenerating ? (
                          <Loader2 size={16} className="animate-spin text-emerald-400" />
                        ) : (
                          '暫無圖片'
                        )}
                      </div>
                    )}
                  </div>

                  {/* 视频提示词列 */}
                  <div className="flex flex-col gap-1">
                    {shot.editing ? (
                      <textarea
                        value={shot.videoPrompt}
                        onChange={(e) => updateShot(shot.id, { videoPrompt: e.target.value })}
                        className="w-full bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-slate-200 resize-none h-16"
                        placeholder="視頻提示詞"
                      />
                    ) : (
                      <>
                        <div className={`text-[10px] text-slate-300 leading-relaxed ${
                          expandedVideoPrompts.has(shot.id) ? '' : 'line-clamp-3'
                        }`}>
                          {shot.videoPrompt || '無'}
                        </div>
                        {shot.videoPrompt && shot.videoPrompt.length > 60 && (
                          <button
                            onClick={() => {
                              setExpandedVideoPrompts(prev => {
                                const newSet = new Set(prev);
                                if (newSet.has(shot.id)) {
                                  newSet.delete(shot.id);
                                } else {
                                  newSet.add(shot.id);
                                }
                                return newSet;
                              });
                            }}
                            className="text-[9px] text-blue-400 hover:text-blue-300 self-start"
                          >
                            {expandedVideoPrompts.has(shot.id) ? '收起' : '展开'}
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  {/* 视频列（视频预览，支持多个视频） */}
                  <div className="flex flex-col gap-1">
                    {(() => {
                      // 获取所有视频URL（优先使用 videoUrls 数组，兼容 videoUrl）
                      const videoUrls = shot.videoUrls || (shot.videoUrl ? [shot.videoUrl] : []);
                      const cachedVideoUrls = shot.cachedVideoUrls || (shot.cachedVideoUrl ? [shot.cachedVideoUrl] : []);
                      
                      if (videoUrls.length > 0) {
                        // 显示所有视频（最新的在顶部）
                        return (
                          <div className="flex flex-col gap-1">
                            {videoUrls.map((videoUrl, index) => {
                              const cachedUrl = cachedVideoUrls[index];
                              const isLatest = index === videoUrls.length - 1;
                              return (
                                <div key={index} className="relative">
                                  <VideoPreview 
                                    videoUrl={videoUrl}
                                    cachedVideoUrl={cachedUrl}
                                    shotId={shot.id}
                                  />
                                  {videoUrls.length > 1 && (
                                    <div className="absolute top-1 left-1 bg-slate-900/80 text-[9px] text-slate-300 px-1 py-0.5 rounded">
                                      {isLatest ? '最新' : `视频 ${index + 1}`}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        );
                      } else {
                        // 没有视频
                        return (
                          <div className="flex items-center justify-center h-32 bg-slate-800/50 rounded border border-slate-700 text-slate-500 text-[10px]">
                            {shot.videoGenerating ? (
                              <Loader2 size={16} className="animate-spin text-purple-400" />
                            ) : (
                              '暫無視頻'
                            )}
                          </div>
                        );
                      }
                    })()}
                  </div>

                  {/* 操作列 */}
                  <div className="flex flex-col gap-1 items-end pr-2">
                    <button
                      onClick={async () => {
                        try {
                          await handleGenerateImage(shot, true);
                        } catch (error: any) {
                          toast.error(`图片生成失败: ${error.message || '未知错误'}`, 6000);
                        }
                      }}
                      disabled={shot.imageGenerating}
                      className="text-[10px] px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50 whitespace-nowrap"
                      title="重新绘图"
                    >
                      重新繪圖
                    </button>
                    <button
                      className="text-[10px] px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded whitespace-nowrap"
                      title="配音试听"
                    >
                      配音試聽
                    </button>
                    <button
                      onClick={() => handleGenerateVideo(shot)}
                      disabled={shot.videoGenerating || !shot.videoPrompt}
                      className="text-[10px] px-2 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded disabled:opacity-50 whitespace-nowrap"
                      title="制作动画"
                    >
                      製作動畫
                    </button>
                    <button
                      onClick={() => {
                        setEditingShotId(shot.id);
                        updateShot(shot.id, { editing: !shot.editing });
                      }}
                      className={`text-[10px] px-2 py-1 rounded whitespace-nowrap ${
                        shot.editing 
                          ? 'bg-orange-600 hover:bg-orange-500 text-white border-2 border-orange-400' 
                          : 'bg-slate-700 hover:bg-slate-600 text-white'
                      }`}
                      title="镜头设置"
                    >
                      鏡頭設置
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

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

      {/* 视频播放模态框 */}
      {enlargedVideoUrl && (
        <div
          className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4"
          onClick={() => setEnlargedVideoUrl(null)}
        >
          <div className="relative max-w-7xl max-h-[90vh] w-full">
            <button
              onClick={() => setEnlargedVideoUrl(null)}
              className="absolute top-4 right-4 bg-slate-800 hover:bg-slate-700 text-white rounded-full p-2 z-10"
            >
              <X size={24} />
            </button>
            <video
              src={enlargedVideoUrl}
              controls
              autoPlay
              className="max-w-full max-h-[90vh] rounded-lg border-2 border-slate-700"
              onClick={(e) => e.stopPropagation()}
            />
            <a
              href={enlargedVideoUrl}
              download
              className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium rounded transition-all"
              onClick={(e) => e.stopPropagation()}
            >
              <Download size={16} />
              下載視頻
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

      {/* 角色库管理 */}
      {showCharacterLibrary && (
        <CharacterLibrary
          onClose={() => setShowCharacterLibrary(false)}
          jimengApiBaseUrl={jimengApiBaseUrl}
          jimengSessionId={jimengSessionId}
        />
      )}
    </div>
  );
};
