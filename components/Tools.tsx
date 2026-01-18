import React, { useState } from 'react';
import { ToolMode, NicheType, ApiProvider } from '../types';
import { NICHES } from '../constants';
import { streamContentGeneration, initializeGemini } from '../services/geminiService';
import { fetchYouTubeTranscript, extractYouTubeVideoId, isYouTubeLink } from '../services/youtubeService';
import { FileText, Maximize2, RefreshCw, Scissors, ArrowRight, Copy, ChevronDown, Video, Download, Plus, X } from 'lucide-react';

interface ToolsProps {
  apiKey: string;
  provider: ApiProvider;
}

// 任务接口
interface Task {
  id: string;
  mode: ToolMode;
  niche: NicheType;
  inputText: string;
  outputText: string;
  isGenerating: boolean;
  isExtractingTranscript: boolean;
}

export const Tools: React.FC<ToolsProps> = ({ apiKey, provider }) => {
  // 多任务管理
  const [tasks, setTasks] = useState<Task[]>([
    {
      id: 'task-1',
      mode: ToolMode.REWRITE,
      niche: NicheType.TCM_METAPHYSICS,
      inputText: '',
      outputText: '',
      isGenerating: false,
      isExtractingTranscript: false,
    }
  ]);
  const [activeTaskId, setActiveTaskId] = useState<string>('task-1');
  
  // 当前活动任务
  const activeTask = tasks.find(t => t.id === activeTaskId) || tasks[0];
  const activeTaskIndex = tasks.findIndex(t => t.id === activeTaskId);
  
  // 便捷访问当前任务的状态（保持向后兼容）
  const mode = activeTask.mode;
  const niche = activeTask.niche;
  const inputText = activeTask.inputText;
  const outputText = activeTask.outputText;
  const isGenerating = activeTask.isGenerating;
  const isExtractingTranscript = activeTask.isExtractingTranscript;
  
  // 更新当前任务状态
  const updateActiveTask = (updates: Partial<Task>) => {
    setTasks(prev => prev.map(task => 
      task.id === activeTaskId ? { ...task, ...updates } : task
    ));
  };
  
  // 设置模式（更新当前任务）
  const setMode = (newMode: ToolMode) => {
    updateActiveTask({ mode: newMode });
  };
  
  // 设置赛道（更新当前任务）
  const setNiche = (newNiche: NicheType) => {
    updateActiveTask({ niche: newNiche });
  };
  
  // 设置输入文本（更新当前任务）
  const setInputText = (text: string) => {
    updateActiveTask({ inputText: text });
  };
  
  // 设置输出文本（更新当前任务）
  const setOutputText = (text: string) => {
    updateActiveTask({ outputText: text });
  };
  
  // 设置生成状态（更新当前任务）
  const setIsGenerating = (generating: boolean) => {
    updateActiveTask({ isGenerating: generating });
  };
  
  // 设置提取状态（更新当前任务）
  const setIsExtractingTranscript = (extracting: boolean) => {
    updateActiveTask({ isExtractingTranscript: extracting });
  };
  
  // ⚠️ RapidAPI版本 - 请将下面的 URL 替换为您部署 GAS_RapidAPI集成版.gs 后的新 URL
  // 示例：https://script.google.com/macros/s/AKfycby.../exec
  const [gasApiUrl, setGasApiUrl] = useState<string>('https://script.google.com/macros/s/AKfycbylTL8WWoBBcYo5LaXGsIoUiBVxWVFLEcaH4cMuXbnB2UEQ-tsUI6jqYS8tcYT0wxQaqA/exec'); // ⚠️⚠️⚠️ 必须填入您的实际GAS部署URL，否则无法使用！
  
  // 创建新任务
  const createNewTask = () => {
    const newTask: Task = {
      id: `task-${Date.now()}`,
      mode: ToolMode.REWRITE,
      niche: NicheType.TCM_METAPHYSICS,
      inputText: '',
      outputText: '',
      isGenerating: false,
      isExtractingTranscript: false,
    };
    setTasks(prev => [...prev, newTask]);
    setActiveTaskId(newTask.id);
  };
  
  // 删除任务
  const deleteTask = (taskId: string) => {
    if (tasks.length <= 1) {
      // 至少保留一个任务
      return;
    }
    setTasks(prev => prev.filter(t => t.id !== taskId));
    // 如果删除的是当前任务，切换到第一个任务
    if (taskId === activeTaskId) {
      const remainingTasks = tasks.filter(t => t.id !== taskId);
      if (remainingTasks.length > 0) {
        setActiveTaskId(remainingTasks[0].id);
      }
    }
  };
  
  // 切换任务
  const switchTask = (taskId: string) => {
    setActiveTaskId(taskId);
  };

  // 清理Markdown格式符号，输出纯文本（保留编号格式）
  const cleanMarkdownFormat = (text: string, mode?: ToolMode): string => {
    if (!text) return '';
    let cleaned = text
      // 移除Markdown标题标记
      .replace(/^#{1,6}\s+/gm, '')
      // 移除所有Markdown特殊符号
      .replace(/\*\*/g, '') // 移除 **粗体**
      .replace(/\*/g, '') // 移除 *斜体*（但要保留编号中的点，所以先处理**）
      .replace(/__/g, '') // 移除 __粗体__
      .replace(/_/g, '') // 移除 _斜体_
      .replace(/~~/g, '') // 移除 ~~删除线~~
      .replace(/~/g, '') // 移除 ~删除线~
      .replace(/`/g, '') // 移除 `代码`
      .replace(/<[^>]+>/g, ''); // 移除HTML标签
    
    // 对于脚本模式，保留方括号格式（如[序號]、[名稱]等）
    if (mode === ToolMode.SCRIPT) {
      // 保留方括号格式，只移除链接格式
      cleaned = cleaned.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1'); // 移除链接格式，保留文本
      // 不移除方括号格式，保留[序號]、[名稱]等
    } else {
      // 其他模式移除方括号格式
      cleaned = cleaned
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // 移除链接格式，保留文本
        .replace(/\[([^\]]+)\]/g, '$1'); // 移除引用链接格式
    }
    
    // 移除无序列表标记（保留编号格式）
    cleaned = cleaned.replace(/^\s*[-*+•]\s+/gm, '');
    
    // 对于摘要模式，保留编号格式（1. 2. 3.等）
    if (mode === ToolMode.SUMMARIZE) {
      // 不移除编号，只清理其他格式
    } else if (mode !== ToolMode.SCRIPT) {
      // 脚本模式也保留编号格式（镜头序号）
      // 其他模式移除编号格式
      cleaned = cleaned.replace(/^\s*\d+\.\s+/gm, '');
    }
    
    return cleaned
      // 清理多余空行
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim();
  };

  // 清洗脚本输出，保留镜头、角色信息、场景信息，删除重复镜头和无关内容
  const cleanScriptOutput = (text: string): string => {
    if (!text) return '';
    
    const lines = text.split('\n');
    const cleanedLines: string[] = [];
    let inShot = false;
    let inRoleInfo = false;
    let inSceneInfo = false;
    const seenShots = new Set<number>(); // 记录已见过的镜头号，防止重复
    let currentShotNumber = 0;
    let skipCurrentShot = false; // 标记当前镜头是否需要跳过（重复镜头）
    let sceneInfoComplete = false; // 标记场景信息是否已完成
    let skipInvalidBlock = false; // 标记是否在跳过无效格式块（如【脚本角色清单】）
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // 检测并跳过非模板格式的内容（更全面的检测）
      const invalidPatterns = [
        '【脚本角色清单】', '【脚本场景清单】',
        '----', // 分隔符
        /^角色\d+:/,  // 角色1:、角色2:等
        /^场景\d+:/,  // 场景1:、场景2:等
        /^性别:/,     // 性别: 男
        /^年龄:/,     // 年龄: 90岁
        /^外貌特征:/,  // 外貌特征: ...
        /^性格特征:/,  // 性格特征: ...
        /^语言风格:/,  // 语言风格: ...
        /^描述:/      // 描述: (作为独立行，不是[描述])
      ];
      
      const isInvalidLine = invalidPatterns.some(pattern => {
        if (typeof pattern === 'string') {
          return line.includes(pattern);
        } else {
          return pattern.test(line);
        }
      });
      
      if (isInvalidLine) {
        console.log(`[cleanScriptOutput] 跳过非模板格式内容: ${line}`);
        skipInvalidBlock = true;
        continue;
      }
      
      // 检测是否回到有效内容（镜头、角色信息、场景信息）
      if (skipInvalidBlock) {
        // 检查是否遇到模板格式的开始标记
        if (/^镜头\d+|^鏡頭\d+/.test(line) || 
            line === '[角色信息]' || 
            line === '[场景信息]' || line === '[場景信息]' ||
            /^\[(名称|名稱|别名|別名|描述)\]/.test(line)) {
          skipInvalidBlock = false;
          console.log(`[cleanScriptOutput] 回到有效内容: ${line}`);
          // 继续处理该行
        } else {
          // 继续跳过非模板内容
          continue;
        }
      }
      
      // 如果场景信息已完成，检测后续内容
      if (sceneInfoComplete) {
        // 如果遇到空行，继续
        if (!line) {
          cleanedLines.push(lines[i]);
          continue;
        }
        // 如果遇到 [名称] 标记（表示场景信息的下一个条目），保留
        if (/^\[(名称|名稱)\]/.test(line)) {
          cleanedLines.push(lines[i]);
          continue;
        }
        // 如果遇到其他内容（如重复镜头、多余文字等），停止处理
        console.log(`[cleanScriptOutput] 场景信息完成后遇到多余内容，停止处理: ${line.substring(0, 50)}...`);
        break;
      }
      
      // 检测角色信息开始
      if (line === '[角色信息]') {
        inShot = false;
        inRoleInfo = true;
        inSceneInfo = false;
        skipCurrentShot = false;
        cleanedLines.push(lines[i]);
        continue;
      }
      
      // 检测场景信息开始
      if (line === '[场景信息]' || line === '[場景信息]') {
        inShot = false;
        inRoleInfo = false;
        inSceneInfo = true;
        skipCurrentShot = false;
        cleanedLines.push(lines[i]);
        continue;
      }
      
      // 如果在角色信息块内
      if (inRoleInfo) {
        // 检查是否遇到场景信息（表示角色信息块结束）
        if (line === '[场景信息]' || line === '[場景信息]') {
          inRoleInfo = false;
          inSceneInfo = true;
          cleanedLines.push(lines[i]);
          continue;
        }
        cleanedLines.push(lines[i]);
        continue;
      }
      
      // 如果在场景信息块内
      if (inSceneInfo) {
        cleanedLines.push(lines[i]);
        // 检测场景信息是否已完成（已有至少一个完整的场景条目）
        // 当遇到连续空行或者下一个不相关的内容时，认为场景信息完成
        if (/^\[(描述)\]/.test(line)) {
          // 刚输出了描述字段，下一个条目可能是另一个场景或结束
          // 继续等待，看看是否有下一个 [名称]
        }
        continue;
      }
      
      // 检测镜头开始
      const shotMatch = line.match(/^(?:镜头|鏡頭)(\d+)/);
      if (shotMatch) {
        const shotNum = parseInt(shotMatch[1]);
        
        // 检查是否重复镜头
        if (seenShots.has(shotNum)) {
          console.log(`[cleanScriptOutput] 跳过重复镜头: ${shotNum}`);
          skipCurrentShot = true; // 标记需要跳过这个镜头的所有内容
          inShot = false;
          continue;
        }
        
        seenShots.add(shotNum);
        currentShotNumber = shotNum;
        inShot = true;
        skipCurrentShot = false;
        cleanedLines.push(lines[i]);
        continue;
      }
      
      // 如果当前镜头需要跳过，则跳过所有相关行
      if (skipCurrentShot) {
        continue;
      }
      
      // 如果在镜头块内，保留该行
      if (inShot) {
        cleanedLines.push(lines[i]);
        continue;
      }
      
      // 如果行包含镜头相关字段（镜头文案、图片提示词等），也保留
      if (/^(镜头文案|圖片提示詞|图片提示词|视频提示词|視頻提示詞|景别|景別|语音分镜|語音分鏡|音效)[：:]/.test(line)) {
        cleanedLines.push(lines[i]);
        continue;
      }
      
      // 如果行包含角色或场景信息字段，也保留
      if (/^\[(名称|名稱|别名|別名|描述)\]/.test(line)) {
        cleanedLines.push(lines[i]);
        continue;
      }
      
      // 其他行跳过（删除不相关信息）
    }
    
    // 检测场景信息是否真正完成（有[场景信息]标记）
    const finalText = cleanedLines.join('\n');
    if (finalText.includes('[场景信息]') || finalText.includes('[場景信息]')) {
      sceneInfoComplete = true;
      console.log(`[cleanScriptOutput] 场景信息已完成，已清洗后续多余内容`);
    }
    
    console.log(`[cleanScriptOutput] 保留的镜头数量: ${seenShots.size}, 镜头编号: ${Array.from(seenShots).sort((a,b)=>a-b).join(', ')}`);
    return finalText;
  };

  // 检查是否有提前的收尾词（字数不足时不应该出现）
  const hasPrematureEnding = (text: string): boolean => {
    const endingKeywords = [
      /下課/i,
      /下课/i,
      /散會/i,
      /散会/i,
      /下期再見/i,
      /下期再见/i,
      /今天就到這/i,
      /今天就到这/i,
      /咱們下次/i,
      /咱们下次/i,
    ];
    return endingKeywords.some(pattern => pattern.test(text));
  };

  // 检测并清理不完整的镜头（脚本模式专用）
  const cleanIncompleteShot = (text: string): { cleaned: string; lastShotNumber: number; needsRework: boolean } => {
    // 匹配镜头格式：镜头[数字] 或 鏡頭[数字]
    const shotPattern = /(?:镜头|鏡頭)(\d+)/g;
    const shots: Array<{ number: number; startIndex: number }> = [];
    let match;
    const shotMatches: RegExpExecArray[] = [];
    
    // 收集所有镜头匹配
    while ((match = shotPattern.exec(text)) !== null) {
      shotMatches.push(match);
      shots.push({ 
        number: parseInt(match[1]), 
        startIndex: match.index 
      });
    }
    
    if (shots.length === 0) {
      return { cleaned: text, lastShotNumber: 0, needsRework: false };
    }
    
    // 检查最后一个镜头是否完整
    const lastShot = shots[shots.length - 1];
    const lastShotStart = lastShot.startIndex;
    // 查找最后一个镜头的结束位置（下一个镜头开始或文本末尾）
    let lastShotEnd = text.length;
    // 检查是否有角色信息或场景信息开始
    const roleInfoIndex = text.indexOf('[角色信息]', lastShotStart);
    const sceneInfoIndex = text.indexOf('[场景信息]', lastShotStart);
    const sceneInfoIndex2 = text.indexOf('[場景信息]', lastShotStart);
    
    if (roleInfoIndex > lastShotStart && roleInfoIndex < lastShotEnd) {
      lastShotEnd = roleInfoIndex;
    }
    if (sceneInfoIndex > lastShotStart && sceneInfoIndex < lastShotEnd) {
      lastShotEnd = sceneInfoIndex;
    }
    if (sceneInfoIndex2 > lastShotStart && sceneInfoIndex2 < lastShotEnd) {
      lastShotEnd = sceneInfoIndex2;
    }
    
    const lastShotContent = text.substring(lastShotStart, lastShotEnd);
    
    // 检查是否包含所有必需字段（支持繁体和简体）
    const requiredFields = [
      { zh: '镜头文案', tw: '鏡頭文案' },
      { zh: '图片提示词', tw: '圖片提示詞' },
      { zh: '视频提示词', tw: '視頻提示詞' },
      { zh: '景别', tw: '景別' },
      { zh: '语音分镜', tw: '語音分鏡' },
      { zh: '音效', tw: '音效' }
    ];
    
    const hasAllFields = requiredFields.every(field => 
      lastShotContent.includes(field.zh) || lastShotContent.includes(field.tw)
    );
    
    // 检查最后一个字段（音效）是否完整（有值，不是空行）
    const hasCompleteLastField = /音效[：:]\s*[^\n\r]+/.test(lastShotContent);
    
    // 检查镜头内容是否被截断
    // 只有在缺少字段或最后字段不完整时，才检查长度
    // 如果所有字段都存在且最后字段完整，则认为镜头完整，不管长度
    let isTruncated = false;
    if (!hasAllFields || !hasCompleteLastField) {
      // 如果字段不完整，检查长度是否过短（可能被截断）
      isTruncated = lastShotContent.length < 150; // 放宽到150字符
    }
    
    if (!hasAllFields || !hasCompleteLastField || isTruncated) {
      // 删除不完整的最后一个镜头
      const cleaned = text.substring(0, lastShotStart).trim();
      console.log(`[cleanIncompleteShot] 镜头${lastShot.number}不完整: hasAllFields=${hasAllFields}, hasCompleteLastField=${hasCompleteLastField}, isTruncated=${isTruncated}, length=${lastShotContent.length}`);
      return { cleaned, lastShotNumber: lastShot.number, needsRework: true };
    }
    
    return { cleaned: text, lastShotNumber: lastShot.number, needsRework: false };
  };

  // 检查内容是否完整（是否有明确的结尾）
  const isContentComplete = (text: string, mode: ToolMode, originalLength: number): boolean => {
    if (mode === ToolMode.SUMMARIZE) {
      // 摘要模式：检查是否有标签部分（表示完整输出）
      return text.includes('熱門標籤') || text.includes('#');
    }
    
    if (mode === ToolMode.SCRIPT) {
      // 脚本模式：检查场景信息是否已输出（最关键的完成标志）
      const hasRoleInfo = text.includes('[角色信息]');
      const hasSceneInfo = text.includes('[场景信息]') || text.includes('[場景信息]');
      
      // ⚠️ 关键：如果已经有场景信息，说明脚本已完成，立即返回true
      if (hasSceneInfo && hasRoleInfo) {
        console.log('[isContentComplete] 检测到场景信息已输出，脚本完成！');
        return true;
      }
      
      // 检查是否有未完成的标记（----表示还需要续写）
      const hasIncompleteMarker = text.includes('----');
      
      // 如果有未完成标记，说明不完整
      if (hasIncompleteMarker) return false;
      
      // 检查镜头数量
      const shotCount = (text.match(/鏡頭\d+|镜头\d+/g) || []).length;
      
      // 如果镜头数量为0，说明还没开始输出，不算完整
      if (shotCount === 0) return false;
      
      // 检查最后一个镜头是否完整
      const { needsRework } = cleanIncompleteShot(text);
      if (needsRework) return false;
      
      // 计算已搬运的原文字数
      let copiedTextLength = 0;
      // 支持多种引号格式：" " 「 」 " "
      const shotTextPattern = /镜头文案[：:]\s*[^-]+-[^：:]+[：:]\s*[""「"]([\s\S]*?)[""」"]/g;
      const shotTextMatches = text.matchAll(shotTextPattern);
      for (const match of shotTextMatches) {
        if (match[1]) {
          copiedTextLength += match[1].trim().length;
        }
      }
      console.log(`[isContentComplete] 已搬运原文: ${copiedTextLength}/${originalLength} 字 (${(copiedTextLength/originalLength*100).toFixed(1)}%)`);
      
      // ⚠️ 关键：如果已搬运的文案长度 >= 原文长度的95%，说明原文已全部搬运完毕
      if (copiedTextLength >= originalLength * 0.95) {
        console.log(`[isContentComplete] 原文已搬运完毕（${copiedTextLength}/${originalLength}字），等待角色和场景信息...`);
        // 如果原文搬运完毕，且有角色信息和场景信息，则完成
        return hasRoleInfo && hasSceneInfo;
      }
      
      // 其他情况：继续生成
      return false;
    }
    
    // 其他模式：检查字数和结尾完整性
    const length = text.length;
    const hasProperEnding = /[。！？.!?]$/.test(text.trim()); // 以标点结尾
    const notTruncated = !text.endsWith('...') && !text.endsWith('…');
    
    if (mode === ToolMode.REWRITE || mode === ToolMode.POLISH) {
      // 改写和润色：必须字数>=原文的90%才认为完整
      // 如果字数不足但出现了收尾词，说明提前结束了，需要继续
      const reachedMinimum = length >= originalLength * 0.9;
      const reachedTarget = length >= originalLength * 0.95;
      
      // 如果字数不足90%，即使有收尾标点也不算完整
      if (!reachedMinimum) {
        return false;
      }
      
      // 字数达到90-95%，且有标点结尾，才算完整
      return reachedTarget && hasProperEnding && notTruncated;
    } else if (mode === ToolMode.EXPAND) {
      // 扩写：必须字数>=1.4倍才认为接近完成
      const reachedMinimum = length >= originalLength * 1.4;
      const reachedTarget = length >= originalLength * 1.5;
      
      if (!reachedMinimum) {
        return false;
      }
      
      return reachedTarget && hasProperEnding && notTruncated;
    }
    
    return hasProperEnding && notTruncated;
  };

  // 提取YouTube字幕
  const handleExtractTranscript = async () => {
    const videoId = extractYouTubeVideoId(inputText.trim());
    if (!videoId) {
      setOutputText('❌ 无法识别YouTube视频链接，请检查链接格式。');
      return;
    }
    
    setIsExtractingTranscript(true);
    setOutputText('⏳ 正在提取YouTube视频字幕，请稍候...');
    
    try {
      const result = await fetchYouTubeTranscript(videoId, gasApiUrl || undefined);
      
      if (result.success && result.transcript) {
        // 将字幕显示在输入框中
        setInputText(result.transcript);
        setOutputText('✅ 字幕提取成功！已自动填入输入框，您可以选择处理模式后点击生成按钮。');
        console.log(`[Tools] YouTube字幕提取成功，长度: ${result.transcript.length}字`);
      } else {
        // 字幕提取失败，提供手动操作指南
        const manualGuide = `❌ 自动提取字幕失败

📋 请手动提取字幕（2分钟完成）：

**方法1：使用 YouTube 内置字幕**
1. 打开视频：https://www.youtube.com/watch?v=${videoId}
2. 点击视频下方的 "..." 菜单
3. 选择 "显示转录文本" 或 "Show transcript"
4. 复制全部文本
5. 粘贴到输入框中（可以保留或删除 YouTube 链接）

**方法2：使用在线工具**
• DownSub: https://downsub.com/
• SaveSubs: https://savesubs.com/
• 粘贴视频链接，下载 TXT 格式字幕
• 复制内容到输入框

**方法3：使用浏览器扩展**
• Video Transcript（Chrome）
• YouTube Transcript（Firefox）

---
失败原因：${result.error || '未知'}

💡 提示：手动提取后，自动字幕功能仍在开发调试中。`;
        
        setOutputText(manualGuide);
        console.error('[Tools] YouTube字幕提取失败:', result.error);
      }
    } catch (error: any) {
      setOutputText(`❌ 字幕提取异常：${error.message}\n\n请尝试手动复制YouTube字幕。`);
      console.error('[Tools] YouTube字幕提取异常:', error);
    } finally {
      setIsExtractingTranscript(false);
    }
  };

  const handleAction = async () => {
    // ⚠️ 关键：锁定当前任务ID，确保整个生成过程都更新正确的任务
    const currentTaskId = activeTaskId;
    const currentTask = tasks.find(t => t.id === currentTaskId);
    
    if (!apiKey || !currentTask || !currentTask.inputText) return;
    
    // 使用当前任务的输入文本
    const taskInputText = currentTask.inputText;
    const taskMode = currentTask.mode;
    const taskNiche = currentTask.niche;
    
    // 更新特定任务的函数
    const updateTask = (updates: Partial<Task>) => {
      setTasks(prev => prev.map(task => 
        task.id === currentTaskId ? { ...task, ...updates } : task
      ));
    };
    
    updateTask({ isGenerating: true, outputText: '' });

    // 脚本输出模式：不依赖赛道配置，作为独立通用模块
    const nicheConfig = taskMode === ToolMode.SCRIPT ? null : NICHES[taskNiche];
    let localOutput = '';
    const MAX_CONTINUATIONS = 15; // 最大续写次数（增加到15次以支持长文本）
    let continuationCount = 0;
    
    // 检测是否为YouTube链接
    const isYouTube = isYouTubeLink(taskInputText.trim());
    const videoId = isYouTube ? extractYouTubeVideoId(taskInputText.trim()) : null;
    
    // 如果只有 YouTube 链接，没有其他文本内容，提示用户点击"提取字幕"按钮
    if (isYouTube && videoId) {
      const textWithoutLink = taskInputText.trim().replace(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)[^\s]*/gi, '').trim();
      
      // 如果移除链接后没有其他文本，说明只有链接
      if (!textWithoutLink || textWithoutLink.length < 10) {
        updateTask({ isGenerating: false, outputText: `📺 檢測到 YouTube 視頻鏈接\n\n視頻ID: ${videoId}\n\n💡 請點擊輸入框旁的「提取字幕」按鈕，系統將自動提取視頻字幕並填入輸入框。\n\n⚠️ 注意：需要在設置中配置 Google Apps Script API URL 才能使用自動提取功能。` });
        return;
      }
    }
    
    // Inject Niche Persona into the system instruction, enforce Chinese
    // 脚本输出模式：使用通用系统指令，不关联赛道，不进行任何改写或洗稿
    let systemInstruction = '';
    if (taskMode === ToolMode.SCRIPT) {
      // 脚本输出模式：通用系统指令，完全独立，不进行任何改写、润色、洗稿或修改
      systemInstruction = `你是一位专业的视频脚本生成助手。你的任务是：
1. 将原文内容按照指定格式转换为视频脚本
2. **绝对铁律：镜头文案必须100%按照原文输出，禁止任何改写、润色、扩写、缩写或修改**
3. **只进行格式转换，不进行任何内容改写**
4. **续写时同样适用：所有镜头（包括镜头14、镜头15、镜头16...）都必须100%原文还原**
5. 请务必使用简体中文输出（角色和场景描述部分），镜头文案保持原文语言`;
    } else {
      // 其他模式：使用赛道配置
      if (!nicheConfig) {
        setIsGenerating(false);
        setOutputText('错误：找不到赛道配置');
        return;
      }
      systemInstruction = `${nicheConfig.systemInstruction}\n你也是一位專業的內容編輯。請務必使用繁體中文輸出。`;
    }
    
    // 如果是YouTube链接（且有文本内容），添加特殊说明
    if (isYouTube && videoId) {
      systemInstruction += `\n\n⚠️ 重要提示：用戶提供了一個 YouTube 視頻鏈接（視頻ID: ${videoId}），同時也提供了轉錄文本。請直接處理轉錄文本內容，忽略鏈接部分。`;
    }
    
    const originalLength = taskInputText.length;

    // 生成初始prompt的函数
    const generateInitialPrompt = (mode: ToolMode, originalLength: number): string => {
        const inputSection = isYouTube && videoId 
            ? `## Input Data
⚠️ **檢測到 YouTube 視頻鏈接**（視頻ID: ${videoId}）

${taskInputText}

**注意**：上述輸入包含 YouTube 視頻鏈接和轉錄文本。請直接處理轉錄文本內容，忽略鏈接部分。`
            : `## Input Data
${taskInputText}`;

    // 检测输入语言（简单判断：如果包含中文字符，认为是中文；否则认为是英文）
    const hasChinese = /[\u4e00-\u9fff]/.test(taskInputText);
    const hasEnglish = /[a-zA-Z]/.test(taskInputText);
    let inputLanguage = '繁體中文'; // 默认繁体中文
    
    if (!hasChinese && hasEnglish) {
      // 纯英文
      inputLanguage = 'English';
    } else if (hasChinese && hasEnglish) {
      // 中英混合，判断哪个占比更多
      const chineseCount = (inputText.match(/[\u4e00-\u9fff]/g) || []).length;
      const englishCount = (inputText.match(/[a-zA-Z]/g) || []).length;
      if (englishCount > chineseCount * 2) {
        inputLanguage = 'English (主要)';
      } else if (chineseCount > 0) {
        inputLanguage = '繁體中文 (主要)';
      }
    }
    
    console.log(`[Tools] 检测输入语言: ${inputLanguage}, 中文字符数: ${(taskInputText.match(/[\u4e00-\u9fff]/g) || []).length}, 英文字符数: ${(taskInputText.match(/[a-zA-Z]/g) || []).length}`);

    switch (taskMode) {
        case ToolMode.REWRITE:
                return `### 任務指令：文本洗稿與像素級改編

${inputSection}

## 原文字數統計
原文共 ${originalLength} 字

## 語言一致性要求（CRITICAL - 最高優先級）
⚠️ **輸入語言：${inputLanguage}**
⚠️ **輸出語言必須與輸入語言完全一致**
- 如果原文是英文，洗稿後的文本也必須是英文
- 如果原文是中文，洗稿後的文本也必須是中文
- 如果原文是中英混合，洗稿後也必須保持相同的語言比例和風格
- **絕對禁止語言轉換**（如英文變中文、中文變英文）

## 洗稿策略（CRITICAL）
⚠️ **像素級模仿 - 1比1復刻原文框架**
- **洗稿為主，弱改編**：保持原文的敘事結構、情節發展、人物關係、時間線完全不變
- **框架100%復刻**：開頭-發展-高潮-結尾的結構必須與原文一致
- **情節1比1對應**：每個情節點、每個轉折、每個細節都必須在洗稿版本中找到對應
- **只改表達方式**：僅替換詞彙、調整句式、變換表達角度，但不改變內容實質
- **禁止深度改編**：禁止添加新情節、刪除原有情節、改變情節順序、修改人物設定

## Style Context
請以 ${nicheConfig.name} 的風格和語氣進行洗稿，融入該領域的專業術語和表達方式。

## Constraints & Rules
1. **詞彙替換**：使用同義詞或更高級的詞彙替換原有詞彙，避免重複。
2. **句式變換**：將主動句改為被動句，長句拆短，短句合併，改變敘述語序。
3. **框架鎖定**：在不影響邏輯的前提下，可以微調句子順序，但絕不改變段落結構和情節順序。
4. **去AI味**：避免使用死板的翻譯腔，增加口語化或更自然的連接詞（如"其實"、"換句話說"、"說白了"）。
5. **完整性**：絕對不能丟失原文的關鍵數據、專有名詞和核心論點。
6. **賽道風格融合**：確保洗稿後的文本符合 ${nicheConfig.name} 的獨特語氣和表達習慣。
7. **字數保持（重要）**：洗稿後的文本字數必須 >= ${originalLength * 0.9} 字（至少保持原文90%的長度），不得大幅縮減內容。
8. **禁止提前收尾（關鍵）**：
   - ⚠️ **一次性輸出不可能完成全部內容，系統會自動續寫**
   - 在首次輸出時，**嚴禁使用任何收尾語**（如「下課」「散會」「下期再見」等）
   - 保持內容連貫流暢，自然過渡，不要有結束的意思
   - 只有在字數達標後的最終收尾時才使用收尾語
9. **TTS 純淨輸出（關鍵）**：
   - 嚴禁輸出任何括號內的描述詞，如「（教室的燈光漸漸暗去...）」「（院師猛地一拍驚堂木...）」
   - 嚴禁使用 **、*、__、~~ 等 Markdown 特殊符號
   - 嚴禁輸出章節標記、段落編號、說明文字、注釋或元信息
   - 只輸出純粹的第一人稱語音文稿內容，適合直接 TTS 配音

## 零解釋輸出規則（CRITICAL - 絕對禁止違反）
⚠️ **從第一個字就開始洗稿內容，禁止任何前置內容**
- ❌ 禁止輸出：「這裡為您提供...」「以下是改寫後的內容」「根據您的要求...」等任何說明文字
- ❌ 禁止輸出：「---」「##」「標題：」等任何分隔符、標題、標記
- ❌ 禁止輸出：「改寫如下：」「洗稿版本：」「最終版本：」等任何引導語
- ✅ 正確做法：直接從故事的第一句話開始輸出，零解釋，零標記，純文本

## Output Format
**立即開始輸出洗稿內容（使用 ${inputLanguage}），從故事的第一個字開始，不要有任何前置說明、標題、分隔符或解釋。**`;
        case ToolMode.EXPAND:
                const targetMinLength = Math.floor(originalLength * 1.5);
                const targetMaxLength = Math.floor(originalLength * 2);
                return `### 任務指令：深度內容擴寫

${inputSection}

## 原文字數統計
原文共 ${originalLength} 字
目標字數：${targetMinLength}-${targetMaxLength} 字（1.5-2倍擴寫）

## 語言一致性要求（CRITICAL - 最高優先級）
⚠️ **輸入語言：${inputLanguage}**
⚠️ **輸出語言必須與輸入語言完全一致**
- 如果原文是英文，擴寫後的文本也必須是英文
- 如果原文是中文，擴寫後的文本也必須是中文
- 如果原文是中英混合，擴寫後也必須保持相同的語言比例和風格
- **絕對禁止語言轉換**（如英文變中文、中文變英文）

## Goals
將提供的簡短文本或大綱擴展為一篇內容詳實、邏輯嚴密的深度文章，融入 ${nicheConfig.name} 的專業視角。

## Workflow
1. **分析核心觀點**：識別輸入文本中的主要論點和關鍵詞。
2. **多維展開**：
   - **What（是什麼）**：詳細解釋概念定義，使用 ${nicheConfig.name} 領域的專業術語。
   - **Why（為什麼）**：分析背後的原因、背景或動機，結合該領域的邏輯和思維方式。
   - **How（怎麼做）**：提供具體的方法論、步驟或解決方案。
   - **Example（舉例）**：根據上下文虛構或引用一個貼切的場景/案例來佐證觀點，案例要符合該領域特色。
3. **補充細節**：增加形容詞、描寫性語句和修辭手法，豐富文本的顆粒度。
4. **邏輯銜接**：使用過渡句，確保從一個點到另一個點的流動自然。
5. **風格融合**：全文保持 ${nicheConfig.name} 的獨特語氣和表達習慣。

## Constraints
- 擴寫後的字數必須達到 ${targetMinLength}-${targetMaxLength} 字（原文的1.5-2倍）。
- 保持原文的語氣（專業、幽默或嚴肅），並融入 ${nicheConfig.name} 的風格特色。
- 不要堆砌無意義的廢話，確保新增內容有實質信息量。
- **禁止提前收尾**：一次性輸出不可能完成全部內容，首次輸出時嚴禁使用「下課」「散會」等收尾語，保持內容連貫。
- **TTS 純淨輸出**：嚴禁輸出括號內的描述詞、**、*等特殊符號、章節標記、段落編號、說明文字或注釋。

## Output Format
直接輸出擴寫後的完整純淨文章（使用 ${inputLanguage} 輸出），保持簡潔連貫流暢，無需分段標記或元信息。嚴禁使用「## 」「### 」「第一章」「（）」「**」等標記。`;
        case ToolMode.SUMMARIZE:
                return `### 任務指令：YouTube 內容摘要與優化

${inputSection}

## Goals
從 ${nicheConfig.name} 領域專家的視角，為上述文本生成完整的 YouTube 視頻內容包裝方案，包括標題、簡介、標籤和封面設計方案。

## Output Requirements（必須繁體中文輸出）

請按照以下格式輸出：

核心主題：
用一句話概括這篇文章在講什麼，要精準且吸引人。

YouTube 爆款標題（5個，必須標題黨風格，留鉤子，用不同角度）：
⚠️ **標題要求（CRITICAL）**：
- 必須是標題黨風格，強烈吸引點擊
- 每個標題必須留鉤子（懸念、反轉、驚人真相、禁忌話題等）
- 5個標題必須從不同角度切入，避免重複
- 可以使用：數字衝擊、疑問句、反轉、禁忌、驚人真相、對比、時間緊迫感等技巧
- 長度：40-60字，要足夠吸引人

1. [標題1 - 角度1：使用數字衝擊/驚人真相/禁忌話題，留強烈鉤子]
2. [標題2 - 角度2：使用疑問句/反轉/對比，製造懸念]
3. [標題3 - 角度3：使用時間緊迫感/警告/危機感，引發焦慮]
4. [標題4 - 角度4：使用反轉/顛覆認知/顛覆常識，製造衝突]
5. [標題5 - 角度5：使用揭秘/內幕/隱藏真相，滿足好奇心]

視頻簡介：
[開場鉤子1-2句話]

核心要點：
• [要點1]
• [要點2]
• [要點3]
• [要點4]
• [要點5]

[結尾CTA - 呼籲訂閱/評論/分享]

熱門標籤：
#標籤1 #標籤2 #標籤3 #標籤4 #標籤5 #標籤6 #標籤7 #標籤8 #標籤9 #標籤10

【標籤語言規則】
- ⚠️ 標籤語言必須與文案內容語言一致
- 如果文案是繁體中文，標籤必須全部使用繁體中文（如 #倪海廈 #中醫玄學 #風水）
- 如果文案是簡體中文，標籤必須全部使用簡體中文
- 如果文案是英文，標籤才使用英文
- 包含 ${nicheConfig.name} 領域專屬標籤和通用熱門標籤
- 禁止中英文混合標籤

封面設計方案：

AI 圖片提示詞（5個，必須使用中文輸出）：
⚠️ **提示詞要求（CRITICAL）**：
- 必須使用中文輸出，禁止使用英文
- 適合 Midjourney/Stable Diffusion/DALL-E 等 AI 繪圖工具
- 描述要具體、視覺化，包含色彩、構圖、光線、氛圍等元素
- 每個提示詞要突出不同的視覺重點

1. [提示詞1 - 用中文描述封面視覺元素，強調核心概念和情緒張力]
2. [提示詞2 - 用中文描述，突出關鍵人物或場景的視覺特徵]
3. [提示詞3 - 用中文描述，展現衝突或對比的視覺效果]
4. [提示詞4 - 用中文描述，營造懸念或神秘感的視覺氛圍]
5. [提示詞5 - 用中文描述，結合標題文案的視覺呈現]

封面標題文案（5個，每個分上中下三行）：
1. 
   上行：[核心概念，不超過10字]
   中行：[關鍵信息，不超過10字]
   下行：[行動呼籲或懸念，不超過10字]

2. 
   上行：[核心概念，不超過10字]
   中行：[關鍵信息，不超過10字]
   下行：[行動呼籲或懸念，不超過10字]

3. 
   上行：[核心概念，不超過10字]
   中行：[關鍵信息，不超過10字]
   下行：[行動呼籲或懸念，不超過10字]

4. 
   上行：[核心概念，不超過10字]
   中行：[關鍵信息，不超過10字]
   下行：[行動呼籲或懸念，不超過10字]

5. 
   上行：[核心概念，不超過10字]
   中行：[關鍵信息，不超過10字]
   下行：[行動呼籲或懸念，不超過10字]

【封面設計要求】
- 圖片提示詞要具體描述視覺元素、色彩、構圖、風格
- 封面標題文案必須從內容核心提煉，每行不超過10個字
- 標題文案要簡潔有力，具有視覺衝擊力
- 上中下三行要有邏輯層次：上行吸引注意，中行傳達核心，下行引發行動

## Output Format
請嚴格按照上述格式輸出，使用繁體中文，無需額外解釋或分析。嚴禁使用 **、*、__、~~ 等 Markdown 特殊符號。`;
        case ToolMode.POLISH:
                return `### 任務指令：文本潤色與優化

${inputSection}

## 原文字數統計
原文共 ${originalLength} 字

## 語言一致性要求（CRITICAL - 最高優先級）
⚠️ **輸入語言：${inputLanguage}**
⚠️ **輸出語言必須與輸入語言完全一致**
- 如果原文是英文，潤色後的文本也必須是英文
- 如果原文是中文，潤色後的文本也必須是中文
- 如果原文是中英混合，潤色後也必須保持相同的語言比例和風格
- **絕對禁止語言轉換**（如英文變中文、中文變英文）

## Goals
像一位嚴厲的文字編輯一樣，以 ${nicheConfig.name} 領域的專業標準優化這段文本，使其更具專業感、流暢感和高級感。

## Checkpoints
1. **語法修正**：糾正所有錯別字、標點錯誤和語病。
2. **詞彙升級**：將平庸的詞彙替換為更精準、更具表現力的詞彙（例如將"很多"改為"不勝枚舉"，將"好"改為"卓越"），並融入 ${nicheConfig.name} 領域的專業術語。
3. **修辭增強**：在合適的地方加入排比、比喻、反問等修辭手法，增強感染力和說服力。
4. **精簡冗餘**：刪除囉嗦的重複表達，使句子更乾練有力。
5. **語氣統一**：確保全文語氣一致（根據原文判斷是商務風、學術風還是文學風），並強化 ${nicheConfig.name} 的獨特風格。
6. **邏輯流暢**：優化句子之間的銜接，確保思路連貫、層次分明。
7. **字數保持**：潤色後的字數應與原文相當（約 ${originalLength * 0.9}-${originalLength * 1.1} 字），不要大幅縮減或擴充。
8. **禁止提前收尾**：首次輸出時嚴禁使用「下課」「散會」等收尾語，保持內容連貫流暢。
9. **TTS 純淨輸出（關鍵）**：嚴禁輸出括號內的描述詞、**、*等特殊符號，只輸出純粹的第一人稱語音文稿。

## Comparison Standard
在"信（準確）、達（通順）、雅（優美）"三個維度上都必須有明顯提升，同時保持 ${nicheConfig.name} 的專業風範。

## Output Format
請直接輸出潤色後的純淨最終版本（使用 ${inputLanguage} 輸出），保持簡潔連貫流暢，無需標註修改痕跡或解釋。嚴禁使用「## 」「### 」「修改說明：」「（）」「**」等任何標記。`;
        case ToolMode.SCRIPT:
                // 检测语言（简单判断：如果包含中文字符，认为是中文）
                const isChinese = /[\u4e00-\u9fff]/.test(inputText);
                const minChars = 200; // 统一字数要求：200-300字
                const maxChars = 300; // 统一字数要求：200-300字
                
                return `### 任务指令：视频脚本生成

${inputSection}

## 原文字数统计
原文共 ${originalLength} 字

## ⚠️ 格式铁律（CRITICAL - 最高优先级 - 违反即失败）

### 角色信息和场景信息格式 - 写死格式，100%模板复刻

**⚠️⚠️⚠️ 每个字段必须独占一行，禁止放在同一行！⚠️⚠️⚠️**

**角色信息正确格式（写死，不可更改）：**

[角色信息]
[名称]医生
[别名]倪医生，主播
[描述]一位55岁中年男性，身高175cm，一头整齐的黑白相间短发，身材适中，穿着一身深灰色的传统长衫（或中山装），面容清癯，眼神深邃且坚定，有一种看透世事的智慧感。

[名称]助手
[别名]小李，助理
[描述]一位30岁左右的年轻女性，身着白色工作服，表情专注认真。

**场景信息正确格式（写死，不可更改）：**

[场景信息]
[名称]场景-室内
[别名]无
[描述]古色古香的书房或诊室，背景有书架、医学经络图、毛笔字画，光线柔和庄重。

[名称]场景-户外
[别名]无
[描述]自然风光，山水画卷般的场景，展现天人合一的理念。

**❌❌❌ 绝对禁止的错误格式（违反即失败）：**

错误示例1（字段在同一行）：
❌ [名称]医生[别名]倪医生，主播[描述]一位55岁...

错误示例2（使用其他标题）：
❌ 【脚本角色清单】
❌ 角色1:、角色2:

错误示例3（使用其他字段）：
❌ 性别:、年龄:、外貌特征:、性格特征:、语言风格:

错误示例4（字段不完整）：
❌ [名称]医生
❌ [别名]倪医生
❌ （缺少[描述]字段）

**✅✅✅ 必须遵守的规则（写死，不可违反）：**
1. ✅ 第一行必须是 [角色信息] 或 [场景信息]
2. ✅ 每个角色/场景必须包含三个字段：[名称]、[别名]、[描述]
3. ✅ **每个字段必须独占一行**（[名称]一行、[别名]一行、[描述]一行）
4. ✅ 字段格式：[字段名]内容（字段名用方括号，后面直接跟内容，不换行）
5. ✅ 每个角色/场景之间用空行分隔
6. ✅ [描述]字段必须详细（角色至少50字，场景至少30字）
7. ✅ 禁止增加或减少字段
8. ✅ 禁止使用任何其他格式

## Goals
将上述文本内容转换为适合语音视频制作的脚本模板，包含镜头分镜、图片提示词、视频提示词、语音分镜和音效设计。

## 输出要求（CRITICAL）

### 镜头数量限制
- 镜头总数不得超过 60 个
- 根据原文长度和内容密度合理分配镜头数量
- 每个镜头对应一段连续的文本内容

### 镜头格式（每个镜头必须包含以下所有字段，严格按照此格式）

镜头[序号]
镜头文案: [角色名]-[语气词]："[⚠️ 这里必须填入原文的连续长段落，100%原文还原，一个字都不能改，200-300字，无动作描述，纯净文本]"
图片提示词: [景别], [画面描述], [环境描述]
视频提示词: [秒数]s: [画面描述], [运镜方式]
景别: [全景/中景/特写]
语音分镜: [角色名]
音效: [具体的音效名]

⚠️ **格式要求**：
- 每个字段独占一行
- 字段名后使用冒号+空格（如：镜头文案: ）
- 镜头之间用空行分隔


## 详细要求

### 镜头文案（CRITICAL - 100%原文还原，绝对禁止修改）
⚠️ **绝对铁律：镜头文案必须100%按照原文输出，禁止任何修改、增加或缩减**

**这是最重要的规则，违反即失败：**
- 必须是原文的连续长段落，一个字都不能改
- 禁止任何改写、润色、扩写、缩写
- 禁止添加任何新内容
- 禁止删除任何原文内容
- 禁止修改任何标点符号
- 禁止修改任何字词
- 禁止替换任何同义词
- 禁止改变任何句式
- 禁止调整任何语序
- **必须从原文中直接复制粘贴，不能有任何改动**

**格式要求：**
- 每个镜头文案必须：200-300字（严格控制字数）
- 无动作描述，纯净文本，适合 TTS 语音合成
- 格式：[角色名]-[语气词]："[原文文本内容，100%还原]"
- 语气词限定：只能使用以下六种之一：高兴、愤怒、悲伤、害怕、惊讶、平静
- ⚠️ **字数铁律**：每个镜头文案必须在200-300字之间，不能过短或过长

### 图片提示词
- 必须适合 AI 绘图工具（Midjourney/Stable Diffusion/DALL-E）
- 包含：景别（全景/中景/特写）、画面描述、环境描述
- 描述要具体、视觉化，包含色彩、构图、光线等元素
- 根据原文内容和场景特点设计视觉风格

### 视频提示词
- 格式：[秒数]s: [画面描述], [运镜方式]
- 秒数：根据文案长度合理分配（通常 5-15 秒）
- 运镜方式：推拉摇移、固定机位、跟随、环绕等
- 画面描述：简洁描述该时段的视觉重点

### 景别
- 必须是：全景、中景、特写 三者之一
- 根据内容重点选择合适的景别

### 语音分镜
- 标注该镜头的主要说话角色
- 如果没有明确角色，使用"旁白"或"解说"

### 音效
- 具体的音效名称，如：背景音乐、键盘敲击声、脚步声、环境音等
- 如果不需要音效，标注"无"或"背景音乐"

## 完整输出格式示例（必须严格遵守）

镜头1
镜头文案: 医生-平静："[200-300字的原文文本，100%还原，一个字都不能改]"
图片提示词: 中景, 一位中年男性医生坐在古色古香的书房中, 背景有书架和医学图谱, 柔和的光线
视频提示词: 8s: 医生平静讲述, 固定机位
景别: 中景
语音分镜: 医生
音效: 背景音乐

镜头2
镜头文案: 医生-平静："[200-300字的原文文本，100%还原，一个字都不能改]"
图片提示词: 中景, 医生讲解医学知识, 手指指向经络图, 书房环境
视频提示词: 10s: 医生讲解示范, 缓慢推近
景别: 中景
语音分镜: 医生
音效: 背景音乐

... (继续输出所有镜头，直到原文全部转换完毕) ...

⚠️ **镜头文案字数铁律**：每个镜头文案必须严格控制在200-300字之间！

[角色信息]
[名称]医生
[别名]倪医生，主播
[描述]一位55岁中年男性，身高175cm，一头整齐的黑白相间短发，身材适中，穿着一身深灰色的传统长衫（或中山装），面容清癯，眼神深邃且坚定，有一种看透世事的智慧感。

[名称]助手
[别名]小李，助理
[描述]一位30岁左右的年轻女性，身着白色工作服，表情专注认真。

[场景信息]
[名称]场景-室内
[别名]无
[描述]古色古香的书房或诊室，背景有书架、医学经络图、毛笔字画，光线柔和庄重。

[名称]场景-户外
[别名]无
[描述]自然风光，山水画卷般的场景，展现天人合一的理念。

⚠️ **格式铁律（再次强调 - 写死格式）**：
- ✅ 必须使用 [角色信息] 和 [场景信息] 作为标题
- ✅ 必须使用 [名称]、[别名]、[描述] 三个字段
- ✅ **每个字段必须独占一行**（不能写成 [名称]医生[别名]倪医生[描述]...）
- ✅ 字段格式：[字段名]内容（方括号+字段名+内容，不换行）
- ✅ 每个角色/场景之间用空行分隔
- ✅ 禁止使用任何其他格式

❌ **错误示例（绝对禁止）**：
[名称]医生[别名]倪医生，主播[描述]一位55岁...  ← 这是错误的！所有字段挤在一行！

✅ **正确示例**：
[名称]医生
[别名]倪医生，主播
[描述]一位55岁...  ← 这是正确的！每个字段独占一行！

## Output Format（输出格式 - CRITICAL - 写死格式）

**必须严格按照以下顺序和格式输出：**

1. **镜头信息**（按序号从1开始）
   - 镜头[序号]
   - 镜头文案: [角色名]-[语气词]："[原文内容100%还原]"
   - 图片提示词: [内容]
   - 视频提示词: [内容]
   - 景别: [全景/中景/特写]
   - 语音分镜: [角色名]
   - 音效: [音效名]
   - （空行分隔）

2. **角色信息**（所有镜头完成后 - 写死格式）
   [角色信息]
   [名称]角色名
   [别名]别名1，别名2
   [描述]详细描述（至少50字）
   （空行）
   [名称]下一个角色名
   [别名]别名
   [描述]详细描述
   
   ⚠️ **每个字段必须独占一行！不能写成：[名称]角色名[别名]别名[描述]描述**

3. **场景信息**（角色信息完成后 - 写死格式）
   [场景信息]
   [名称]场景名
   [别名]别名或"无"
   [描述]详细描述（至少30字）
   （空行）
   [名称]下一个场景名
   [别名]别名或"无"
   [描述]详细描述
   
   ⚠️ **每个字段必须独占一行！不能写成：[名称]场景名[别名]无[描述]描述**

**格式铁律（违反即失败 - 写死，不可更改）：**
- ✅ 角色信息必须用 [角色信息] 开头，不是【脚本角色清单】
- ✅ 场景信息必须用 [场景信息] 开头，不是【脚本场景清单】
- ✅ 必须用 [名称]、[别名]、[描述] 三个字段，不是"角色1:"、"性别:"、"年龄:"
- ✅ **每个字段必须独占一行**（这是最容易犯的错误！）
- ✅ 字段格式：[字段名]内容（方括号+字段名+内容，不换行）
- ✅ 每个角色/场景之间用空行分隔
- ✅ 使用简体中文输出（镜头文案保持原文语言）
- ❌ 严禁使用 **、*、__、~~ 等 Markdown 特殊符号
- ❌ 严禁使用任何不在模板中的格式
- ❌ **严禁将所有字段挤在一行**

## 续写规则
- 如果一次性无法完成全部脚本，在最后一个完整镜头后输出「----」（4个横线），系统会自动续写
- 续写时从「----」下一行开始，继续输出下一个镜头
- **续写时同样适用：所有镜头都必须100%原文还原，禁止任何改写、润色、扩写、缩写**
- 必须完成所有镜头、角色信息和场景信息才算完整

## 角色信息和场景信息（在所有镜头完成后输出）

⚠️ **输出时机**：只有在所有镜头都输出完成后，才能输出角色信息和场景信息。

### 角色信息格式（CRITICAL - 严格按照此格式，禁止使用其他格式）

⚠️ **绝对禁止**：
- 禁止使用【脚本角色清单】、角色1:、性别:、年龄:、外貌特征:、性格特征:、语言风格: 等格式
- 禁止使用任何不在模板中的格式
- **只能使用以下模板格式，一个字都不能改**

[角色信息]
[名称]医生
[别名]倪医生，主播
[描述]一位55岁中年男性，身高175cm，一头整齐的黑白相间短发，身材适中，穿着一身深灰色的传统长衫（或中山装），面容清癯，眼神深邃且坚定，有一种看透世事的智慧感。

[名称]... (如果原文中有其他角色，继续列出)

⚠️ **格式要求（绝对铁律 - 写死格式）**：
- **必须使用 [角色信息] 作为开头标记**
- **必须使用 [名称]、[别名]、[描述] 三个字段标记，不能增加或减少**
- **每个字段必须独占一行**（不能写成 [名称]医生[别名]...[描述]...）
- **字段格式：[字段名]内容**（方括号+字段名+内容，不换行）
- **[描述] 字段必须输出详细内容**：包含年龄、性别、身高、外貌、穿着、性格等（至少50字）
- 内容必须根据原文提取或合理推断
- 每个角色之间用空行分隔
- **禁止输出任何其他格式的角色信息**
- **禁止省略 [描述] 字段或输出空内容**
- **禁止将所有字段挤在一行**

### 场景信息格式（CRITICAL - 严格按照此格式，禁止使用其他格式）

⚠️ **绝对禁止**：
- 禁止使用【脚本场景清单】、场景1:、描述: 等格式
- 禁止使用任何不在模板中的格式
- **只能使用以下模板格式，一个字都不能改**

[场景信息]
[名称]场景-室内
[别名]无
[描述]古色古香的书房或诊室，背景有书架、医学经络图、毛笔字画，光线柔和庄重。

[名称]... (如果原文中有其他场景，继续列出)

⚠️ **格式要求（绝对铁律 - 写死格式）**：
- **必须使用 [场景信息] 作为开头标记**
- **必须使用 [名称]、[别名]、[描述] 三个字段标记，不能增加或减少**
- **每个字段必须独占一行**（不能写成 [名称]场景-室内[别名]无[描述]...）
- **字段格式：[字段名]内容**（方括号+字段名+内容，不换行）
- **[描述] 字段必须输出详细内容**：包含场景类型、环境特点、视觉元素、氛围等（至少30字）
- 内容必须根据原文提取或合理推断
- 每个场景之间用空行分隔
- **禁止输出任何其他格式的场景信息**
- **禁止省略 [描述] 字段或输出空内容**
- **禁止将所有字段挤在一行**

## 输出要求（CRITICAL - 绝对禁止违反）
- **严禁重复输出已完成的镜头，每个镜头编号只能出现一次**
- **严格按照上述模板格式输出，禁止使用其他格式**
- **绝对禁止输出以下格式**：
  - 【脚本角色清单】
  - 角色1:、性别:、年龄:、外貌特征:、性格特征:、语言风格:
  - 【脚本场景清单】
  - 场景1:、场景2:
  - 或任何其他不在模板中的格式
- **只能输出模板中定义的格式**：
  - 镜头信息：镜头[序号] + 6个字段
  - 角色信息：[角色信息] + [名称][别名][描述]
  - 场景信息：[场景信息] + [名称][别名][描述]
- 不要输出任何额外的说明、标题或解释
- 所有镜头、角色信息、场景信息输出完成后，立即结束，不要输出任何其他内容`;
            default:
                return '';
        }
    };

    // 生成续写prompt
    const generateContinuePrompt = (currentContent: string, mode: ToolMode, originalLength: number, cleanInfo?: { cleaned: string; lastShotNumber: number; needsRework: boolean } | null, originalText?: string): string => {
        const context = currentContent.slice(-2000); // 取最后2000字作为上下文（脚本模式需要更多上下文）
        const currentLength = currentContent.length;
        
        if (mode === ToolMode.REWRITE || mode === ToolMode.POLISH) {
            const progress = (currentLength / originalLength * 100).toFixed(0);
            const needsMore = currentLength < originalLength * 0.9;
            
            return `繼續完成上述 ${nicheConfig.name} 風格的${mode === ToolMode.REWRITE ? '改寫' : '潤色'}，保持風格一致。

【已完成部分（末尾）】
${context}

【字數統計】
- 原文：${originalLength} 字
- 已完成：${currentLength} 字（${progress}%）
- ${needsMore ? `⚠️ 還需要約 ${originalLength - currentLength} 字` : '✓ 接近目標'}

【續寫規則（重要）】
${needsMore ? 
`⚠️ **字數嚴重不足，嚴禁使用任何收尾語！**
- 嚴禁使用「下課」「散會」「下期再見」「今天就到這」等收尾詞
- 直接自然銜接上文，繼續${mode === ToolMode.REWRITE ? '改寫' : '潤色'}
- 保持內容流暢連貫，不要有結束的意思` :
`✓ 字數已接近目標，可以適當收尾
- 在內容自然結束時，可以使用「下課」「下期再見」等收尾語
- 添加互動引導（如「歡迎在評論區分享你的看法」）`}
- **TTS 純淨輸出**：嚴禁輸出括號內的描述詞、**、*等特殊符號
- 第一行必須是「-----」，第二行開始直接續寫`;
        } else if (mode === ToolMode.EXPAND) {
            const targetMin = Math.floor(originalLength * 1.5);
            const progress = (currentLength / targetMin * 100).toFixed(0);
            const needsMore = currentLength < originalLength * 1.4;
            
            return `繼續完成上述 ${nicheConfig.name} 風格的深度擴寫，保持風格一致。

【已完成部分（末尾）】
${context}

【字數統計】
- 原文：${originalLength} 字，目標：${targetMin} 字
- 已擴寫：${currentLength} 字（${progress}%）
- ${needsMore ? `⚠️ 還需要約 ${targetMin - currentLength} 字` : '✓ 接近目標'}

【續寫規則（重要）】
${needsMore ?
`⚠️ **字數嚴重不足，嚴禁使用任何收尾語！**
- 直接自然銜接上文，繼續深入展開論述
- 保持內容流暢，不要有結束的意思` :
`✓ 字數已接近目標，可以適當收尾
- 確保內容完整、邏輯閉環
- 可以使用適當的收尾語和互動引導`}
- **TTS 純淨輸出**：嚴禁輸出括號內的描述詞、**、*等特殊符號
- 第一行必須是「-----」，第二行開始直接續寫`;
        } else if (mode === ToolMode.SCRIPT) {
            // 检测语言
            const isChinese = /[\u4e00-\u9fff]/.test(inputText);
            const minChars = isChinese ? 200 : 450;
            const maxChars = isChinese ? 250 : 800;
            
            // 统计已完成的镜头数量
            const shotCount = (currentContent.match(/鏡頭\d+|镜头\d+/g) || []).length;
            
            // 计算已搬运的原文字数（提取所有镜头文案中的文本）
            let copiedTextLength = 0;
            // 匹配镜头文案格式：镜头文案: [角色名]-[语气词]："[文本内容]"
            // 使用非贪婪匹配和多行模式，支持文本内容中包含换行
            const shotTextPattern = /镜头文案[：:]\s*[^-]+-[^：:]+[：:]\s*[""「"]([\s\S]*?)[""」"]/g;
            const shotTextMatches = currentContent.matchAll(shotTextPattern);
            for (const match of shotTextMatches) {
                if (match[1]) {
                    // 提取纯文本内容（去除格式标记）
                    const pureText = match[1].trim();
                    copiedTextLength += pureText.length;
                }
            }
            const originalTextContent = originalText || inputText;
            const remainingTextLength = originalTextContent.length - copiedTextLength;
            const copyProgress = copiedTextLength > 0 
                ? ((copiedTextLength / originalTextContent.length) * 100).toFixed(0)
                : '0';
            
            // 估算还需要多少镜头（基于原文长度和已完成内容）
            // 统一字数要求：每个镜头200-300字，取中间值250字来估算
            const estimatedTotalShots = Math.min(60, Math.ceil(originalLength / 250));
            const remainingShots = Math.max(0, estimatedTotalShots - shotCount);
            
            // 检查是否需要重新输出不完整的镜头
            const needsRework = cleanInfo?.needsRework || false;
            const lastShotNumber = cleanInfo?.lastShotNumber || shotCount;
            
            let reworkInstruction = '';
            if (needsRework) {
                reworkInstruction = `\n\n【重要：重新输出不完整镜头】
检测到镜头${lastShotNumber}输出不完整（缺少必需字段或字段未完成）。
请从「----」下一行开始，重新完整输出镜头${lastShotNumber}，包含所有必需字段：
- 镜头${lastShotNumber}
- 镜头文案: [角色名]-[语气词]："[完整文本]"
- 图片提示词: [景别], [画面描述], [环境描述]
- 视频提示词: [秒数]s: [画面描述], [运镜方式]
- 景别: [全景/中景/特写]
- 语音分镜: [角色名]
- 音效: [具体的音效名]

输出完镜头${lastShotNumber}后，如果还有剩余镜头，继续输出下一个镜头。`;
            }
            
            // 检查是否所有镜头都已完成
            // ⚠️ 关键判断：1) 镜头数量达标 或 2) 原文已搬运完毕（>=95%）
            const allShotsComplete = (shotCount >= estimatedTotalShots || copiedTextLength >= originalLength * 0.95) && !cleanInfo?.needsRework;
            const hasRoleInfo = currentContent.includes('[角色信息]');
            const hasSceneInfo = currentContent.includes('[场景信息]') || currentContent.includes('[場景信息]');
            
            let roleSceneInstruction = '';
            // 只有在所有镜头都完成后，才输出角色信息和场景信息
            if (allShotsComplete && !hasRoleInfo && !hasSceneInfo) {
                roleSceneInstruction = `\n\n【输出角色信息和场景信息 - 所有镜头已完成】
⚠️ 重要：所有镜头（${shotCount}个）已输出完成，现在必须输出角色信息和场景信息。

⚠️ **绝对禁止输出以下格式（违反即失败）**：
- ❌ 【脚本角色清单】
- ❌ 角色1:、角色2:
- ❌ 性别:、年龄:、外貌特征:、性格特征:、语言风格:
- ❌ 【脚本场景清单】
- ❌ 场景1:、场景2:
- ❌ 描述: (作为单独字段)
- ❌ 或任何其他不在模板中的格式

⚠️ **只能使用以下模板格式（一个字都不能改）**：

[角色信息]
[名称]医生
[别名]倪医生，主播
[描述]一位55岁中年男性，身高175cm，一头整齐的黑白相间短发，身材适中，穿着一身深灰色的传统长衫（或中山装），面容清癯，眼神深邃且坚定，有一种看透世事的智慧感。

[名称]... (如果原文中有其他角色，继续列出，每个角色必须包含[名称]、[别名]、[描述]三个字段)

[场景信息]
[名称]场景-室内
[别名]无
[描述]古色古香的书房或诊室，背景有书架、医学经络图、毛笔字画，光线柔和庄重。

[名称]... (如果原文中有其他场景，继续列出，每个场景必须包含[名称]、[别名]、[描述]三个字段)

⚠️ **格式要求（CRITICAL - 绝对铁律 - 写死格式）**：
1. **必须使用 [角色信息] 作为开头标记**
2. **必须使用 [场景信息] 作为开头标记**
3. **每个角色/场景必须且只能包含三个字段：[名称]、[别名]、[描述]**
4. **⚠️⚠️⚠️ 每个字段必须独占一行 ⚠️⚠️⚠️**
   - ❌ 错误：[名称]医生[别名]倪医生[描述]一位55岁...（所有字段在一行）
   - ✅ 正确：
     [名称]医生
     [别名]倪医生
     [描述]一位55岁...（每个字段独占一行）
5. **字段格式：[字段名]内容**（方括号+字段名+内容，不换行）
6. **[描述] 字段必须输出详细内容**：
   - 角色描述：年龄、性别、身高、外貌、穿着、性格等（至少50字）
   - 场景描述：场景类型、环境特点、视觉元素、氛围等（至少30字）
7. **禁止省略 [描述] 字段或输出空内容**
8. **禁止增加任何其他字段（如性别、年龄、外貌特征等作为单独字段）**
9. **禁止使用任何其他格式（如角色1:、场景1:等）**
10. **禁止将所有字段挤在一行**
11. **内容必须从原文中提取或合理推断**
12. 每个角色/场景之间用空行分隔
13. **⚠️⚠️⚠️ 输出完场景信息的最后一个[描述]字段后，立即停止，不要输出任何其他内容，包括镜头、说明文字、注释等，任务完成！⚠️⚠️⚠️**`;
            }
            
            return `继续完成视频脚本生成，保持格式一致。

⚠️ **绝对铁律（续写时同样适用，特别是镜头14及之后）**：
1. **镜头文案必须100%原文还原**：
   - 前面的镜头（镜头1-镜头13）和原文一致
   - **后面的镜头（镜头14、镜头15、镜头16...所有后续镜头）也必须和原文一致，一个字都不能改**
   - **禁止任何改写、润色、扩写、缩写**
   - **只进行格式转换，不进行任何内容改写**
2. **脚本输出模块作为独立模块**：
   - 只做原文格式转换输出
   - 不做任何扩写和文案修改
   - 必须从原文中直接复制粘贴，不能有任何改动

【原文内容（CRITICAL - 必须从这里复制粘贴）】
${originalText || inputText}

【已完成部分（末尾）】
${context}

【进度统计】
- 原文总长度：${originalLength} 字
- 已搬运原文：${copiedTextLength} 字（${copyProgress}%）
- 还需搬运：约 ${remainingTextLength} 字
- 已完成镜头：${shotCount} 个
- 预计总镜头：约 ${estimatedTotalShots} 个（不超过60个）
- 还需完成：约 ${remainingShots} 个镜头
- 角色信息：${hasRoleInfo ? '✓ 已完成' : '✗ 未完成'}
- 场景信息：${hasSceneInfo ? '✓ 已完成' : '✗ 未完成'}
${copiedTextLength >= originalLength * 0.95 ? '\n⚠️⚠️⚠️ 原文已搬运完毕（≥95%），如果所有镜头都已输出完成，必须立即输出角色信息和场景信息，然后结束任务！⚠️⚠️⚠️' : ''}${reworkInstruction}${roleSceneInstruction}

【续写要求（CRITICAL）】${!needsRework && !roleSceneInstruction ? `
1. **继续输出镜头**：从「----」下一行开始，继续输出下一个镜头
2. **镜头格式**：必须包含所有字段（镜头序号、镜头文案、图片提示词、视频提示词、景别、语音分镜、音效）
3. **镜头文案（绝对铁律 - 100%原文还原，绝对禁止修改）**：
   ⚠️ **这是最重要的规则，违反即失败**：
   - **必须从上面提供的【原文内容】中继续复制粘贴，不能有任何改动**
   - **根据【进度统计】，你已经搬运了${copiedTextLength}字（${copyProgress}%），还需要搬运约${remainingTextLength}字**
   - **查看【已完成部分】的最后一个镜头文案，找到对应的原文位置，然后从该位置之后继续搬运**
   - **不要重复已搬运的内容，也不要跳过任何原文内容**
   - **必须100%按照原文输出，一个字都不能改**
   - **禁止任何改写、润色、扩写、缩写**
   - **禁止添加任何新内容**
   - **禁止删除任何原文内容**
   - **禁止修改任何标点符号**
   - **禁止修改任何字词**
   - **禁止替换任何同义词**
   - **禁止改变任何句式**
   - **禁止调整任何语序**
   - **必须从原文中直接复制粘贴，不能有任何改动**
   - **前面的镜头文案和原文一致，后面的也必须和原文一致，不能有任何变化**
   - **续写时同样适用：镜头16、镜头17、镜头18...所有后续镜头都必须100%原文还原**
4. **镜头文案格式**：
   - **字数铁律**：每个镜头文案必须严格控制在200-300字之间
   - 格式：[角色名]-[语气词]："[原文文本内容，100%还原]"
   - 语气词限定：只能使用以下六种之一：高兴、愤怒、悲伤、害怕、惊讶、平静
   - 必须是原文的连续长段落，无动作描述，纯净文本
4. **图片提示词**：适合 AI 绘图工具，包含景别、画面描述、环境描述
5. **视频提示词**：格式 [秒数]s: [画面描述], [运镜方式]
6. **景别**：必须是 全景、中景、特写 三者之一
7. **完成标记**：
   - 如果本次输出无法完成全部镜头，在最后一个完整镜头后输出「----」（4个横线）
   - ⚠️ **严禁提前输出角色信息和场景信息**：只有在所有镜头（${estimatedTotalShots}个）都输出完成后，才能输出角色信息和场景信息
   - 如果所有镜头都已完成，不需要输出「----」` : ''}

【输出格式（CRITICAL - 绝对禁止违反）】
第一行必须是「----」，第二行开始直接输出。

⚠️ **只能输出以下三种内容**：
1. **镜头信息**：镜头[序号] + 镜头文案 + 图片提示词 + 视频提示词 + 景别 + 语音分镜 + 音效
2. **角色信息**（所有镜头完成后）：[角色信息] + [名称][别名][描述] （每个角色重复[名称][别名][描述]）
3. **场景信息**（所有镜头完成后）：[场景信息] + [名称][别名][描述] （每个场景重复[名称][别名][描述]）

⚠️ **绝对禁止输出以下内容**：
- ❌ 【脚本角色清单】、【脚本场景清单】
- ❌ 角色1:、角色2:、场景1:、场景2:
- ❌ 性别:、年龄:、外貌特征:、性格特征:、语言风格:
- ❌ 描述: (作为独立行)
- ❌ 任何说明性文字、注释、解释
- ❌ 任何不在模板中的格式

请使用简体中文输出，镜头文案保持原文语言。严禁使用 **、*、__、~~ 等 Markdown 特殊符号。

⚠️ **输出完场景信息后，立即结束，不要输出任何其他内容。**`;
        }
        
        return '';
    };

    try {
        initializeGemini(apiKey, { provider });
        
        // 生成初始内容
        const initialPrompt = generateInitialPrompt(taskMode, originalLength);
        await streamContentGeneration(initialPrompt, systemInstruction, (chunk) => {
            localOutput += chunk;
            updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode) });
        });
        
        // 检查是否需要续写（摘要模式不需要续写）
        if (taskMode !== ToolMode.SUMMARIZE) {
            while (!isContentComplete(localOutput, taskMode, originalLength) && continuationCount < MAX_CONTINUATIONS) {
                continuationCount++;
                console.log(`[Tools] Content incomplete, continuing (${continuationCount}/${MAX_CONTINUATIONS})...`);
                
                // 脚本模式：检测并清理不完整的镜头
                let cleanInfo: { cleaned: string; lastShotNumber: number; needsRework: boolean } | null = null;
                if (taskMode === ToolMode.SCRIPT) {
                    // 计算当前进度
                    const currentShotCount = (localOutput.match(/鏡頭\d+|镜头\d+/g) || []).length;
                    let currentCopiedLength = 0;
                    const shotTextPattern = /镜头文案[：:]\s*[^-]+-[^：:]+[：:]\s*[""「"]([\s\S]*?)[""」"]/g;
                    const shotTextMatches = localOutput.matchAll(shotTextPattern);
                    for (const match of shotTextMatches) {
                        if (match[1]) {
                            currentCopiedLength += match[1].trim().length;
                        }
                    }
                    const progress = ((currentCopiedLength / originalLength) * 100).toFixed(1);
                    console.log(`[Tools] 续写前进度: 镜头${currentShotCount}个, 已搬运${currentCopiedLength}/${originalLength}字 (${progress}%)`);
                    
                    cleanInfo = cleanIncompleteShot(localOutput);
                    if (cleanInfo.needsRework) {
                        console.log(`[Tools] Detected incomplete shot ${cleanInfo.lastShotNumber}, cleaning and reworking...`);
                        localOutput = cleanInfo.cleaned;
                        updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode) });
                    }
                }
                
                // 添加分隔符（脚本模式使用----，其他模式使用-----）
                const separator = taskMode === ToolMode.SCRIPT ? '\n\n----\n\n' : '\n\n-----\n\n';
                localOutput += separator;
                updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode) });
                
                // 生成续写prompt（传入清理后的内容和是否需要重新输出镜头的信息，以及原文）
                const continuePrompt = generateContinuePrompt(localOutput, taskMode, originalLength, cleanInfo, taskInputText);
                
                // 续写
                await streamContentGeneration(continuePrompt, systemInstruction, (chunk) => {
                    localOutput += chunk;
                    updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode) });
                });
                
                // ⚠️ 关键：每次续写后立即检查是否已输出场景信息
                if (taskMode === ToolMode.SCRIPT) {
                    const hasSceneInfo = localOutput.includes('[场景信息]') || localOutput.includes('[場景信息]');
                    if (hasSceneInfo) {
                        console.log('[Tools] 续写中检测到场景信息已输出，立即停止续写！');
                        break; // 立即退出续写循环
                    }
                }
            }
            
            // 清理续写分隔符（脚本模式使用----，其他模式使用-----）
            if (taskMode === ToolMode.SCRIPT) {
                localOutput = localOutput.replace(/\n*----\n*/g, '\n\n');
                // 脚本模式：清洗内容，保留镜头、角色信息、场景信息，删除重复镜头
                localOutput = cleanScriptOutput(localOutput);
                
                // 强制检查：如果场景信息已完成，立即停止
                const hasSceneInfo = localOutput.includes('[场景信息]') || localOutput.includes('[場景信息]');
                if (hasSceneInfo) {
                    console.log('[Tools] 检测到场景信息已完成，强制结束生成');
                    // 清理场景信息后的所有内容
                    const sceneInfoIndex = Math.max(
                        localOutput.lastIndexOf('[场景信息]'),
                        localOutput.lastIndexOf('[場景信息]')
                    );
                    if (sceneInfoIndex !== -1) {
                        // 找到场景信息后的最后一个 [描述] 字段
                        const afterSceneInfo = localOutput.substring(sceneInfoIndex);
                        const lastDescIndex = afterSceneInfo.lastIndexOf('[描述]');
                        if (lastDescIndex !== -1) {
                            // 找到描述内容的结束位置（下一个换行或文本结束）
                            const descStartInFull = sceneInfoIndex + lastDescIndex;
                            let descEndInFull = localOutput.indexOf('\n\n', descStartInFull);
                            if (descEndInFull === -1) {
                                descEndInFull = localOutput.length;
                            } else {
                                // 保留描述后的一个空行
                                descEndInFull += 2;
                            }
                            localOutput = localOutput.substring(0, descEndInFull).trim();
                        }
                    }
                }
            } else {
                localOutput = localOutput.replace(/\n*-----\n*/g, '\n\n');
            }
            // 清理多余空行
            localOutput = localOutput.replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
            updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode) });
            
            if (isContentComplete(localOutput, taskMode, originalLength)) {
                console.log('[Tools] Content generation complete');
            } else {
                console.log('[Tools] Reached max continuations, stopping');
                
                // 脚本模式：如果达到最大续写次数但内容不完整，给出提示
                if (taskMode === ToolMode.SCRIPT) {
                    // 计算已搬运的原文字数
                    let copiedTextLength = 0;
                    const shotTextPattern = /镜头文案[：:]\s*[^-]+-[^：:]+[：:]\s*[""「"]([\s\S]*?)[""」"]/g;
                    const shotTextMatches = localOutput.matchAll(shotTextPattern);
                    for (const match of shotTextMatches) {
                        if (match[1]) {
                            copiedTextLength += match[1].trim().length;
                        }
                    }
                    const copyProgress = ((copiedTextLength / originalLength) * 100).toFixed(0);
                    const shotCount = (localOutput.match(/鏡頭\d+|镜头\d+/g) || []).length;
                    
                    if (copiedTextLength < originalLength * 0.95) {
                        const warningMsg = `\n\n⚠️ 注意：已达到最大续写次数（${MAX_CONTINUATIONS}次），但原文可能未完全转换完成。\n\n当前进度：\n- 已完成镜头：${shotCount} 个\n- 已搬运原文：${copiedTextLength}/${originalLength} 字（${copyProgress}%）\n\n如需继续，请点击「----」符号后输入继续指令。`;
                        localOutput += warningMsg;
                        updateTask({ outputText: cleanMarkdownFormat(localOutput, taskMode) });
                    }
                }
            }
        }
    } catch (e: any) {
        const errorMsg = e?.message || String(e) || '未知錯誤';
        console.error('[Tools] Error:', e);
        
        // 如果是 YouTube 链接且错误信息提示需要转录文本，显示友好提示
        if (isYouTube && (errorMsg.includes('網絡') || errorMsg.includes('API Key') || errorMsg.includes('連接'))) {
            updateTask({ outputText: `⚠️ YouTube 視頻處理提示\n\n檢測到您輸入的是 YouTube 視頻鏈接。\n\n由於系統無法直接訪問 YouTube 視頻內容，請按以下步驟操作：\n\n1. 打開 YouTube 視頻\n2. 點擊「⋯」菜單 → 選擇「顯示轉錄」或「字幕」\n3. 複製完整的轉錄文本\n4. 將轉錄文本粘貼到此處（可以保留或刪除 YouTube 鏈接）\n5. 再次點擊生成按鈕\n\n或者，如果您已經有轉錄文本，請將文本和鏈接一起粘貼，系統會自動處理文本內容。\n\n---\n\n錯誤詳情：${errorMsg}` });
        } else {
            // 显示详细的错误信息
            updateTask({ outputText: `❌ 生成內容時發生錯誤\n\n錯誤信息：${errorMsg}\n\n請檢查：\n1. API Key 是否正確配置\n2. 網絡連接是否正常\n3. API 服務是否可用\n\n如果問題持續，請聯繫技術支持。` });
        }
    } finally {
        updateTask({ isGenerating: false });
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(outputText);
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
       {/* Settings Bar */}
       <div className="flex flex-col md:flex-row gap-4 justify-between items-center bg-slate-800/50 p-4 rounded-xl border border-slate-800">
           <div className="flex gap-2 overflow-x-auto pb-2 md:pb-0 w-full md:w-auto">
                {/* Tool Modes */}
                {[
                    { id: ToolMode.REWRITE, label: '改寫/洗稿', icon: <RefreshCw size={16} /> },
                    { id: ToolMode.EXPAND, label: '深度擴寫', icon: <Maximize2 size={16} /> },
                    { id: ToolMode.SUMMARIZE, label: '摘要總結', icon: <Scissors size={16} /> },
                    { id: ToolMode.POLISH, label: '潤色優化', icon: <FileText size={16} /> },
                    { id: ToolMode.SCRIPT, label: '腳本輸出', icon: <Video size={16} /> },
                ].map((tool) => (
                    <button
                        key={tool.id}
                        onClick={() => setMode(tool.id as ToolMode)}
                        className={`px-4 py-2 rounded-lg border flex items-center gap-2 transition-all whitespace-nowrap text-sm font-medium ${
                            mode === tool.id 
                            ? 'bg-emerald-600 text-white border-emerald-500 shadow-md' 
                            : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
                        }`}
                    >
                        {tool.icon}
                        <span>{tool.label}</span>
                    </button>
                ))}
           </div>

           <div className="flex items-center gap-4 w-full md:w-auto">
           {/* Niche Context Selector */}
               <div className="relative group w-[180px] md:w-[180px] md:ml-auto">
               <label className="text-base font-extrabold text-emerald-400 mb-1 ml-1 tracking-wide">選擇賽道</label>
               <select 
                    value={niche} 
                    onChange={(e) => setNiche(e.target.value as NicheType)}
                    className="w-full appearance-none bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 font-bold focus:outline-none focus:border-emerald-500 cursor-pointer"
               >
                   {Object.values(NICHES).map(n => (
                       <option key={n.id} value={n.id}>{n.icon} {n.name}</option>
                   ))}
               </select>
               <ChevronDown className="absolute right-3 top-8 text-slate-500 pointer-events-none" size={14} />
               </div>

               {/* Generate Button */}
               <button 
                   onClick={handleAction}
                   disabled={isGenerating || !inputText}
                   className="flex items-center gap-2 px-4 md:px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg shadow-lg shadow-emerald-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:scale-105 active:scale-95 whitespace-nowrap"
               >
                   <ArrowRight size={18} />
                   <span className="hidden sm:inline">生成</span>
               </button>
           </div>
       </div>

      {/* 任务标签页 */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2">
        {tasks.map((task, index) => (
          <div
            key={task.id}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all whitespace-nowrap ${
              task.id === activeTaskId
                ? 'bg-emerald-600/20 border-emerald-500 text-emerald-400'
                : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:bg-slate-700/50'
            }`}
          >
            <button
              onClick={() => switchTask(task.id)}
              className="flex items-center gap-2 text-sm font-medium"
            >
              <span>任务 {index + 1}</span>
              {task.isGenerating && (
                <span className="inline-block w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
              )}
            </button>
            {tasks.length > 1 && (
              <button
                onClick={() => deleteTask(task.id)}
                className="text-slate-500 hover:text-red-400 transition-colors"
                title="删除任务"
              >
                <X size={14} />
              </button>
            )}
          </div>
        ))}
        <button
          onClick={createNewTask}
          className="flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-700 bg-slate-800/50 text-slate-400 hover:bg-slate-700/50 hover:text-emerald-400 transition-all"
          title="新建任务"
        >
          <Plus size={16} />
          <span className="text-sm font-medium">新建</span>
        </button>
      </div>

      {/* Grid: Input and Output */}
       <div className="grid grid-cols-1 md:grid-cols-2 gap-6 h-[600px]">
            {/* Input */}
            <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-400 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>原始文本</span>
              <span className="text-xs text-slate-600">（支持 YouTube 鏈接自動提取）</span>
            </div>
            {isYouTubeLink(inputText.trim()) && (
              <button
                onClick={handleExtractTranscript}
                disabled={isExtractingTranscript}
                className="flex items-center gap-1 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-md shadow disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                <Download size={14} />
                <span>{isExtractingTranscript ? '提取中...' : '提取字幕'}</span>
              </button>
            )}
          </label>
                <textarea 
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
            placeholder="請在此粘貼您的內容或 YouTube 鏈接..."
                    className="flex-1 bg-slate-800/50 border border-slate-700 rounded-xl p-4 text-slate-200 resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500 leading-relaxed custom-scrollbar"
                />
            </div>

            {/* Output */}
            <div className="flex flex-col gap-2 relative">
                <label className="text-sm font-medium text-slate-400 flex justify-between items-center">
                    <span>生成結果</span>
                    {outputText && (
                        <button onClick={copyToClipboard} className="text-xs flex items-center gap-1 text-emerald-400 hover:text-emerald-300">
                            <Copy size={12} /> 複製
                        </button>
                    )}
                </label>
                <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl p-4 text-slate-200 overflow-y-auto whitespace-pre-wrap leading-relaxed relative custom-scrollbar">
                    {outputText}
                    {isGenerating && (
                        <>
                            {!outputText && (
                                <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">
                                    <div className="flex items-center gap-2">
                                        <span className="inline-block w-2 h-4 bg-emerald-500 animate-pulse" />
                                        <span>生成中...</span>
                </div>
                </div>
                            )}
                            {outputText && <span className="inline-block w-2 h-4 bg-emerald-500 ml-1 animate-pulse" />}
                        </>
                    )}
                    {!outputText && !isGenerating && (
                        <div className="absolute inset-0 flex items-center justify-center text-slate-600 text-sm">
                            結果將顯示於此
                </div>
                    )}
                </div>
            </div>
       </div>
    </div>
  );
};