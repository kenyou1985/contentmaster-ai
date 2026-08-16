/**
 * 文案成片主面板（v1.1）
 *
 * 流程：
 * 1. 用户输入文案 → 点击「智能解析」
 * 2. AI 返回 3 套「标题+封面提示词+人物信息」方案
 * 3. 用户可选 1~3 套 → 上传角色参考图（可选）
 * 4. 点击「批量生成封面」→ 同时为每套方案生成封面图（多选对比）
 * 5. 从已生成封面中挑一个作为最终选择
 * 6. 点击「5 段并行配音」→ 5 段并行 TTS → 合并为 1 个 WAV
 * 7. 点击「生成视频」→ Ken Burns 推镜头 + 封面 + 配音 → MP4
 * 8. 「导出 MP4」+「导出剪映草稿」
 *
 * v1.1 新增：
 * - 终端日志框（同步滚动日志）
 * - 封面比例选择（16:9 / 9:16 / 4:3 / 3:4）
 * - 方案多选批量生成（3 套可全生成，对比后再选）
 * - 封面下载按钮
 * - 封面文案完整保留（一字不漏）
 */

import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import {
  Sparkles,
  Loader2,
  Wand2,
  Image as ImageIcon,
  Mic,
  Square,
  Check,
  Upload,
  AlertCircle,
  Download,
  Film,
  X,
  Zap,
  Terminal,
  Trash2,
  Copy as CopyIcon,
} from 'lucide-react';
import { useToast } from './Toast';
import { generateImage } from '../services/yunwuService';
import {
  analyzeCopyWithLlm,
  type CopyAnalysisResult,
  type CopyTitleOption,
  type CopyCharacterInfo,
} from '../services/copyAnalysisService';
import { runParallelTts, type ParallelTtsProgress, type ParallelTtsResult } from '../services/copyParallelTtsService';
import { COPY_ANALYSIS_PROMPT } from '../constants';

const SCRIPT_MAX_LEN = 8000; // 文案成片文案上限

// 封面比例
const COVER_RATIOS = [
  { id: '16:9', label: '16:9 横屏', w: 1280, h: 720 },
  { id: '9:16', label: '9:16 竖屏', w: 720, h: 1280 },
  { id: '4:3', label: '4:3 标屏', w: 1280, h: 960 },
  { id: '3:4', label: '3:4 海报', w: 960, h: 1280 },
] as const;

type CoverRatioId = (typeof COVER_RATIOS)[number]['id'];

interface CoverImageEntry {
  index: number;
  url: string;
  title: string;
  emoji: string;
  styleTag: string;
}

interface LogEntry {
  id: string;
  time: string;
  tag: string; // 'INFO' | 'WARN' | 'ERROR' | 'STAGE' | 'TTS' | 'IMG' | 'PARSE'
  message: string;
}

const CopyBasedPanel: React.FC<{
  apiKey: string;
  runningHubApiKey: string;
}> = ({ apiKey, runningHubApiKey }) => {
  const toast = useToast();

  // ──────────────────────────────────────────────
  // 状态
  // ──────────────────────────────────────────────
  const [rawCopy, setRawCopy] = useState<string>('');
  const [analysisResult, setAnalysisResult] = useState<CopyAnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  /** 多选：方案索引集合 */
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set([0]));
  /** 终选（最终采用哪个封面） */
  const [finalCoverIndex, setFinalCoverIndex] = useState<number | null>(null);
  const [characterRefs, setCharacterRefs] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 比例 */
  const [coverRatio, setCoverRatio] = useState<CoverRatioId>('16:9');

  /** 多套封面图 */
  const [generatedCovers, setGeneratedCovers] = useState<Map<number, CoverImageEntry>>(new Map());
  const [coversGenerating, setCoversGenerating] = useState<Set<number>>(new Set());
  const [coverErrors, setCoverErrors] = useState<Map<number, string>>(new Map());

  const [ttsProgress, setTtsProgress] = useState<ParallelTtsProgress | null>(null);
  const [ttsGenerating, setTtsGenerating] = useState<boolean>(false);
  const [ttsResult, setTtsResult] = useState<ParallelTtsResult | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);

  const [videoUrl, setVideoUrl] = useState<string>('');
  const [videoGenerating, setVideoGenerating] = useState<boolean>(false);

  const abortRef = useRef<AbortController | null>(null);

  /** 终端日志 */
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logScrollRef = useRef<HTMLDivElement>(null);
  const logIdRef = useRef(0);

  /** 自动滚动日志到底部 */
  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [logs]);

  // ──────────────────────────────────────────────
  // 日志
  // ──────────────────────────────────────────────
  const appendLog = useCallback((tag: LogEntry['tag'], message: string) => {
    const id = String(++logIdRef.current);
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setLogs((prev) => {
      const next = [...prev, { id, time, tag, message }];
      // 最多保留 500 条
      return next.length > 500 ? next.slice(-500) : next;
    });
    // 同步打印到 console（与原行为一致）
    console.log(`[${tag}] ${message}`);
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
    logIdRef.current = 0;
    appendLog('INFO', '日志已清空');
  }, [appendLog]);

  // ──────────────────────────────────────────────
  // 派生
  // ──────────────────────────────────────────────
  const selectedOptionList: CopyTitleOption[] = useMemo(() => {
    if (!analysisResult) return [];
    return Array.from(selectedIndices)
      .map((i) => analysisResult.titleOptions[i])
      .filter(Boolean);
  }, [analysisResult, selectedIndices]);

  const charCount = rawCopy.length;
  const currentRatio = COVER_RATIOS.find((r) => r.id === coverRatio) || COVER_RATIOS[0];

  const finalCover: CoverImageEntry | null =
    finalCoverIndex != null ? generatedCovers.get(finalCoverIndex) || null : null;

  // ──────────────────────────────────────────────
  // 文案解析
  // ──────────────────────────────────────────────
  const handleAnalyze = useCallback(async () => {
    if (!apiKey?.trim()) {
      appendLog('ERROR', '云雾 API Key 未配置');
      toast.error('请先在顶部输入云雾 API Key', 4000);
      return;
    }
    if (rawCopy.trim().length < 50) {
      appendLog('ERROR', `文案过短（${rawCopy.trim().length}字），至少 50 字，建议 300 字以上`);
      toast.error('文案过短，至少 50 字，建议 300 字以上', 4000);
      return;
    }
    appendLog('STAGE', '▶ 开始 AI 解析文案');
    appendLog('PARSE', `文案长度：${rawCopy.trim().length} 字`);
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisResult(null);
    setSelectedIndices(new Set([0]));
    setFinalCoverIndex(null);
    setGeneratedCovers(new Map());
    setCoverErrors(new Map());
    setTtsResult(null);
    setVideoUrl('');
    try {
      appendLog('PARSE', '调用 GPT-5.6-Luna 解析（预计 10~30s）...');
      const r = await analyzeCopyWithLlm(apiKey, rawCopy, COPY_ANALYSIS_PROMPT, (msg) => {
        appendLog('PARSE', msg.replace(/^\[.*?\] /, ''));
      });
      setAnalysisResult(r);
      appendLog('PARSE', `解析成功：${r.titleOptions.length} 套方案 + 人物「${r.characterInfo.name || '未识别'}」`);
      if (r.summary) appendLog('PARSE', `摘要：${r.summary}`);
      r.titleOptions.forEach((opt, i) => {
        appendLog('PARSE', `方案${i + 1} [${opt.styleTag}]：${opt.title}`);
      });
    } catch (e: any) {
      const msg = e?.message || '解析失败';
      setAnalysisError(msg);
      appendLog('ERROR', `AI 解析失败：${msg}`);
      toast.error(msg, 5000);
    } finally {
      setAnalyzing(false);
    }
  }, [apiKey, rawCopy, toast, appendLog]);

  // ──────────────────────────────────────────────
  // 角色参考图
  // ──────────────────────────────────────────────
  const handleUploadRef = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const max = 3;
      const promises: Promise<string>[] = [];
      for (let i = 0; i < Math.min(files.length, max - characterRefs.length); i++) {
        const f = files[i];
        promises.push(
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(f);
          })
        );
      }
      Promise.all(promises)
        .then((urls) => {
          setCharacterRefs((prev) => [...prev, ...urls].slice(0, max));
          appendLog('IMG', `已上传 ${urls.length} 张角色参考图（合计 ${urls.length + characterRefs.length} 张）`);
        })
        .catch((err) => {
          appendLog('ERROR', `参考图读取失败：${err.message}`);
          toast.error('参考图读取失败：' + err.message, 4000);
        });
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [characterRefs.length, toast, appendLog]
  );

  const removeRef = (idx: number) => {
    setCharacterRefs((prev) => prev.filter((_, i) => i !== idx));
  };

  const toggleSelectIndex = (idx: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        if (next.size > 1) next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  // ──────────────────────────────────────────────
  // 生成封面（单套）
  // ──────────────────────────────────────────────
  const generateSingleCover = useCallback(
    async (optionIdx: number, option: CopyTitleOption) => {
      if (!apiKey?.trim()) {
        appendLog('ERROR', '云雾 API Key 未配置');
        toast.error('请先在顶部输入云雾 API Key', 4000);
        return;
      }
      const character = analysisResult?.characterInfo as CopyCharacterInfo | undefined;

      // 关键：把完整标题嵌入 prompt，强制 AI 显示完整文字
      const fullPrompt = `${option.coverPromptEn}

=== CRITICAL: 必须在画面上完整显示以下中文标题（一字不漏，禁止简化、禁止拆分成几个词）===
TEXT (display exactly): "${option.title}"
===\n\nStyle hints: ${option.styleKeywords.join(', ')}`;

      setCoversGenerating((prev) => new Set(prev).add(optionIdx));
      setCoverErrors((prev) => {
        const next = new Map(prev);
        next.delete(optionIdx);
        return next;
      });

      const size = `${currentRatio.w}x${currentRatio.h}`;
      appendLog(
        'IMG',
        `▶ 生成封面 方案${optionIdx + 1} [${option.styleTag}]：${size}（${currentRatio.label}）`
      );
      appendLog('IMG', `  标题：${option.title}（${option.title.length}字）`);
      appendLog('IMG', `  标题已嵌入 prompt，强制 AI 完整显示`);
      if (character?.name) appendLog('IMG', `  人物：${character.name}（${character.title}）`);

      try {
        const r = await generateImage(apiKey, {
          model: 'gpt-image-2',
          prompt: fullPrompt,
          size,
          quality: 'high',
          n: 1,
          referenceDataUrls: characterRefs.length > 0 ? characterRefs : undefined,
          characterName: character?.name || undefined,
          timeoutMs: 240_000,
        });
        if (!r.success) throw new Error(r.error || '生图失败');
        const url = r.url;
        if (!url) throw new Error('生图返回无 URL');

        const entry: CoverImageEntry = {
          index: optionIdx,
          url,
          title: option.title,
          emoji: option.emoji,
          styleTag: option.styleTag,
        };
        setGeneratedCovers((prev) => {
          const next = new Map(prev);
          next.set(optionIdx, entry);
          return next;
        });
        // 默认终选第一张生成的封面
        setFinalCoverIndex((prev) => (prev == null ? optionIdx : prev));
        appendLog('IMG', `✓ 方案${optionIdx + 1} 封面生成成功 → ${url.slice(0, 60)}...`);
      } catch (e: any) {
        const msg = e?.message || '生成失败';
        setCoverErrors((prev) => new Map(prev).set(optionIdx, msg));
        appendLog('ERROR', `✗ 方案${optionIdx + 1} 封面生成失败：${msg}`);
      } finally {
        setCoversGenerating((prev) => {
          const next = new Set(prev);
          next.delete(optionIdx);
          return next;
        });
      }
    },
    [apiKey, analysisResult, characterRefs, currentRatio, toast, appendLog]
  );

  /** 批量生成所有选中方案的封面 */
  const handleGenerateAllCovers = useCallback(async () => {
    if (selectedOptionList.length === 0) {
      toast.error('请先选择至少 1 套方案', 3000);
      return;
    }
    appendLog('STAGE', `▶ 批量生成 ${selectedOptionList.length} 套封面（并行）`);
    selectedOptionList.forEach((opt, idx) => {
      const realIdx = Array.from(selectedIndices)[idx];
      generateSingleCover(realIdx, opt);
    });
    // 不 await，Promise.all 让多张同时执行
  }, [selectedOptionList, selectedIndices, generateSingleCover, toast, appendLog]);

  /** 单张重新生成 */
  const handleRegenerateOneCover = useCallback(
    (idx: number) => {
      const opt = analysisResult?.titleOptions[idx];
      if (!opt) return;
      generateSingleCover(idx, opt);
    },
    [analysisResult, generateSingleCover]
  );

  /** 终选某张封面 */
  const handlePickFinalCover = useCallback(
    (idx: number) => {
      if (!generatedCovers.has(idx)) return;
      setFinalCoverIndex(idx);
      const c = generatedCovers.get(idx)!;
      appendLog('STAGE', `✓ 已选定终封面：方案${idx + 1} [${c.styleTag}]「${c.title}」`);
      toast.success(`已选定终封面：方案${idx + 1}`, 2000);
    },
    [generatedCovers, appendLog, toast]
  );

  // ──────────────────────────────────────────────
  // 下载封面
  // ──────────────────────────────────────────────
  const handleDownloadCover = useCallback(
    (entry: CoverImageEntry) => {
      try {
        const a = document.createElement('a');
        a.href = entry.url;
        const safeTitle = entry.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
        a.download = `cover_${entry.index + 1}_${safeTitle}_${currentRatio.id.replace(':', 'x')}.png`;
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        appendLog('IMG', `↓ 下载封面：方案${entry.index + 1}（${a.download}）`);
      } catch (e: any) {
        appendLog('ERROR', `下载失败：${e.message}`);
      }
    },
    [currentRatio, appendLog]
  );

  // ──────────────────────────────────────────────
  // 5 段并行配音
  // ──────────────────────────────────────────────
  const handleGenerateTts = useCallback(async () => {
    if (selectedOptionList.length === 0) {
      toast.error('请先选择至少 1 套方案', 3000);
      return;
    }
    if (!runningHubApiKey?.trim()) {
      appendLog('ERROR', 'RunningHub API Key 未配置');
      toast.error('请先在顶部输入 RunningHub API Key', 4000);
      return;
    }
    if (rawCopy.trim().length < 50) {
      toast.error('文案过短，无法配音', 3000);
      return;
    }
    appendLog('STAGE', '▶ 开始 5 段并行配音（使用最终选定方案的标题作为字幕参考）');
    appendLog('TTS', `文案长度：${rawCopy.trim().length} 字`);
    setTtsGenerating(true);
    setTtsError(null);
    setTtsResult(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await runParallelTts(
        runningHubApiKey,
        apiKey,
        rawCopy,
        {
          speed: 1.0,
          prosodyEnhance: true,
          breath: true,
          autoPause: true,
          pauseStrength: 0.7,
          emphasisStrength: 0.5,
          referenceLanguage: 'auto',
        },
        {
          segmentCount: 5,
          polishWithLlm: !!apiKey?.trim(),
          onProgress: (p) => {
            setTtsProgress(p);
            appendLog('TTS', `${p.stage} | 段进度：${p.segmentsCompleted}/${p.segmentsTotal} ${p.segmentsStatus.map((s) => (s === 'done' ? '✓' : s === 'running' ? '▶' : s === 'failed' ? '✗' : '·')).join('')}`);
          },
          signal: ac.signal,
        }
      );
      setTtsResult(r);
      appendLog('TTS', `✓ 5 段并行配音完成，总时长 ${r.totalDuration.toFixed(1)} 秒`);
      const failedCount = r.segments.filter((s) => !s.success).length;
      if (failedCount > 0) appendLog('WARN', `${failedCount} 段配音失败，已用成功片段合并`);
      toast.success(`5 段并行配音完成，总时长 ${r.totalDuration.toFixed(1)} 秒`, 3000);
    } catch (e: any) {
      const msg = e?.message || '配音失败';
      setTtsError(msg);
      appendLog('ERROR', `配音失败：${msg}`);
      toast.error(msg, 5000);
    } finally {
      setTtsGenerating(false);
      setTtsProgress(null);
      abortRef.current = null;
    }
  }, [runningHubApiKey, apiKey, selectedOptionList, rawCopy, toast, appendLog]);

  const handleCancelTts = () => {
    abortRef.current?.abort();
    appendLog('WARN', '用户取消了配音任务');
  };

  // ──────────────────────────────────────────────
  // 重置
  // ──────────────────────────────────────────────
  const handleReset = useCallback(() => {
    appendLog('WARN', '用户点击「重置」');
    setAnalysisResult(null);
    setSelectedIndices(new Set([0]));
    setFinalCoverIndex(null);
    setCharacterRefs([]);
    setGeneratedCovers(new Map());
    setCoverErrors(new Map());
    setCoverRatio('16:9');
    setTtsResult(null);
    setTtsError(null);
    setTtsProgress(null);
    setVideoUrl('');
    setAnalysisError(null);
  }, [appendLog]);

  // ──────────────────────────────────────────────
  // 渲染
  // ──────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* ═══════════════ 顶部 ═══════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ───────────── 左栏：文案输入 + 角色参考图 ───────────── */}
        <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-emerald-400" />
            <h3 className="text-lg font-bold text-emerald-300">文案输入</h3>
            <span className="text-xs text-slate-500">
              一段文案 → 一张封面 → 一段配音 → 一镜到底视频
            </span>
          </div>

          <div>
            <label className="text-xs text-slate-400 font-semibold mb-1 block">
              你的文案（500 字以上最佳）
            </label>
            <textarea
              value={rawCopy}
              onChange={(e) => setRawCopy(e.target.value.slice(0, SCRIPT_MAX_LEN))}
              disabled={analyzing}
              rows={10}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-emerald-500 resize-y min-h-[200px]"
              placeholder="粘贴或输入需要做成视频的文案/口播稿...建议 300-3000 字，系统会切 5 段并行配音。"
            />
            <div className="flex items-center justify-between mt-1">
              <span
                className={`text-[10px] ${
                  charCount > SCRIPT_MAX_LEN * 0.9 ? 'text-amber-400' : 'text-slate-500'
                }`}
              >
                {charCount} / {SCRIPT_MAX_LEN}
              </span>
              <button
                onClick={handleReset}
                className="text-[10px] text-slate-500 hover:text-slate-300 underline"
                type="button"
              >
                重置
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs text-slate-400 font-semibold mb-1 block">
              角色参考图（可选，最多 3 张）
            </label>
            <div className="flex items-center gap-2 flex-wrap">
              {characterRefs.map((url, idx) => (
                <div key={idx} className="relative w-16 h-16 rounded overflow-hidden border border-slate-600">
                  <img src={url} alt={`ref ${idx + 1}`} className="w-full h-full object-cover" />
                  <button
                    onClick={() => removeRef(idx)}
                    className="absolute top-0 right-0 bg-red-500 text-white p-0.5 rounded-bl"
                    type="button"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
              {characterRefs.length < 3 && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={analyzing}
                  className="w-16 h-16 flex flex-col items-center justify-center bg-slate-900 border border-dashed border-slate-600 rounded hover:border-emerald-500 text-slate-500 hover:text-emerald-400 text-[10px]"
                  type="button"
                >
                  <Upload size={16} />
                  <span className="mt-0.5">上传</span>
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleUploadRef}
                className="hidden"
              />
            </div>
            <p className="text-[10px] text-slate-500 mt-1">
              上传人物参考图后，封面生成时会锁定人物面部特征
            </p>
          </div>

          <button
            onClick={handleAnalyze}
            disabled={analyzing || rawCopy.trim().length < 50}
            className="w-full px-4 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            type="button"
          >
            {analyzing ? (
              <>
                <Loader2 size={18} className="animate-spin" /> AI 解析中...
              </>
            ) : (
              <>
                <Wand2 size={18} /> 智能解析 → 生成 3 套方案
              </>
            )}
          </button>

          {analysisError && (
            <div className="bg-red-900/30 border border-red-700 rounded p-2 text-xs text-red-300 flex items-start gap-1">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{analysisError}</span>
            </div>
          )}
        </div>

        {/* ───────────── 右栏：方案 + 人物 + 比例 + 批量封面 ───────────── */}
        <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Zap size={18} className="text-amber-400" />
              <h3 className="text-lg font-bold text-amber-300">方案选择 + 批量生成封面</h3>
            </div>
            {/* 封面比例选择 */}
            <div className="flex items-center gap-1 bg-slate-900 border border-slate-700 rounded p-0.5">
              {COVER_RATIOS.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    setCoverRatio(r.id);
                    appendLog('IMG', `切换封面比例 → ${r.label}（${r.w}×${r.h}）`);
                  }}
                  className={`text-[10px] px-2 py-1 rounded font-semibold ${
                    coverRatio === r.id
                      ? 'bg-amber-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  type="button"
                  title={`${r.w}×${r.h}`}
                >
                  {r.id}
                </button>
              ))}
            </div>
          </div>

          {/* 3 套方案（多选） */}
          {analysisResult && (
            <div>
              <div className="text-[10px] text-slate-500 mb-1">
                点击卡片多选（已选 {selectedIndices.size} / 3），选中后将批量生成封面
              </div>
              <div className="grid grid-cols-1 gap-2">
                {analysisResult.titleOptions.map((opt, idx) => {
                  const isSelected = selectedIndices.has(idx);
                  const hasCover = generatedCovers.has(idx);
                  const isGenerating = coversGenerating.has(idx);
                  const errMsg = coverErrors.get(idx);
                  const isFinal = finalCoverIndex === idx;
                  return (
                    <div
                      key={idx}
                      className={`text-left p-2.5 rounded-lg border-2 transition-all ${
                        isFinal
                          ? 'border-emerald-400 bg-emerald-900/40 shadow-md'
                          : isSelected
                          ? 'border-amber-400 bg-amber-900/20'
                          : 'border-slate-700 bg-slate-900/50 hover:border-slate-500'
                      }`}
                    >
                      <button
                        onClick={() => toggleSelectIndex(idx)}
                        className="w-full text-left"
                        type="button"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-bold text-amber-300">
                            {opt.emoji} {opt.styleTag}
                          </span>
                          <div className="flex items-center gap-1">
                            {isFinal && (
                              <span className="text-[10px] px-1.5 bg-emerald-600 text-white rounded font-bold">
                                终选
                              </span>
                            )}
                            {hasCover && !isFinal && (
                              <span className="text-[10px] px-1.5 bg-slate-700 text-slate-300 rounded">
                                已生成
                              </span>
                            )}
                            {isSelected && !isFinal && (
                              <Check size={16} className="text-amber-400" />
                            )}
                          </div>
                        </div>
                        <div className="text-sm text-slate-100 font-medium leading-snug mb-1 break-words">
                          {opt.title}
                        </div>
                        <div className="text-[10px] text-slate-500 flex flex-wrap gap-1">
                          {opt.styleKeywords.map((k, i) => (
                            <span key={i} className="bg-slate-800 px-1.5 py-0.5 rounded">
                              {k}
                            </span>
                          ))}
                        </div>
                      </button>

                      {/* 错误提示 */}
                      {errMsg && (
                        <div className="bg-red-900/30 border border-red-700 rounded p-1.5 text-[10px] text-red-300 mt-1">
                          {errMsg}
                        </div>
                      )}

                      {/* 单张封面图（如果有） */}
                      {hasCover && (
                        <div className="mt-2 space-y-1.5">
                          <div
                            className={`relative border-2 rounded-lg overflow-hidden bg-slate-950 ${
                              isFinal ? 'border-emerald-400' : 'border-slate-600'
                            }`}
                          >
                            <img
                              src={generatedCovers.get(idx)!.url}
                              alt={`封面 ${idx + 1}`}
                              className="w-full block"
                            />
                            {isGenerating && (
                              <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-xs text-white">
                                <Loader2 size={16} className="animate-spin mr-1" />
                                生成中…
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            {!isFinal && (
                              <button
                                onClick={() => handlePickFinalCover(idx)}
                                className="text-[10px] px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded flex items-center gap-1"
                                type="button"
                              >
                                <Check size={10} /> 选为终封面
                              </button>
                            )}
                            <button
                              onClick={() => handleRegenerateOneCover(idx)}
                              disabled={isGenerating}
                              className="text-[10px] px-2 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-50"
                              type="button"
                            >
                              ↻ 重新生成
                            </button>
                            <button
                              onClick={() => handleDownloadCover(generatedCovers.get(idx)!)}
                              className="text-[10px] px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-1"
                              type="button"
                            >
                              <Download size={10} /> 下载
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 人物信息 */}
          {analysisResult?.characterInfo && (
            <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3 text-xs space-y-1">
              <div className="text-emerald-400 font-bold mb-1">👤 人物信息</div>
              <div className="text-slate-300">
                <span className="text-slate-500">姓名：</span>
                {analysisResult.characterInfo.name || '（未提取）'}
              </div>
              <div className="text-slate-300">
                <span className="text-slate-500">身份：</span>
                {analysisResult.characterInfo.title || '（未提取）'}
              </div>
              <div className="text-slate-300">
                <span className="text-slate-500">视觉：</span>
                {analysisResult.characterInfo.visualDescription || '（未提取）'}
              </div>
              <div className="text-slate-300">
                <span className="text-slate-500">情绪：</span>
                {analysisResult.characterInfo.dominantEmotion || '（未提取）'}
              </div>
            </div>
          )}

          {/* 批量生成封面按钮 */}
          {analysisResult && (
            <button
              onClick={handleGenerateAllCovers}
              disabled={selectedOptionList.length === 0 || coversGenerating.size > 0}
              className="w-full px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-lg flex items-center justify-center gap-2 disabled:opacity-50 transition-all"
              type="button"
            >
              {coversGenerating.size > 0 ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  生成中 {coversGenerating.size}/{selectedOptionList.length} 张…
                </>
              ) : (
                <>
                  <ImageIcon size={16} />
                  批量生成封面（{selectedOptionList.length} 张，{coverRatio}）
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* ═══════════════ 中部：5 段并行配音 ═══════════════ */}
      {analysisResult && (
        <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 space-y-4">
          <div className="flex items-center gap-2">
            <Mic size={18} className="text-purple-400" />
            <h3 className="text-lg font-bold text-purple-300">5 段并行配音</h3>
            <span className="text-xs text-slate-500">
              将用户原文完整切成 5 段，5 个 RunningHub TTS 任务同时跑（5倍提速）
            </span>
          </div>

          {/* 配音文案预览 */}
          <details className="bg-slate-900/50 border border-slate-700 rounded p-2">
            <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-200">
              📄 待配音文案预览（{rawCopy.trim().length} 字，点击展开）
            </summary>
            <div className="mt-2 text-xs text-slate-300 max-h-32 overflow-y-auto whitespace-pre-wrap leading-relaxed">
              {rawCopy.trim() || '（空）'}
            </div>
          </details>

          <div className="flex items-center gap-2">
            <button
              onClick={handleGenerateTts}
              disabled={ttsGenerating || rawCopy.trim().length < 50}
              className="flex-1 px-4 py-2.5 bg-purple-600 hover:bg-purple-500 text-white font-bold rounded-lg flex items-center justify-center gap-2 disabled:opacity-50 transition-all"
              type="button"
            >
              {ttsGenerating ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> 5 段并行配音中...
                </>
              ) : (
                <>
                  <Mic size={16} /> 5 段并行配音（5倍提速）
                </>
              )}
            </button>
            {ttsGenerating && (
              <button
                onClick={handleCancelTts}
                className="px-3 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-lg"
                type="button"
                title="取消"
              >
                <Square size={16} />
              </button>
            )}
          </div>

          {/* 段进度 */}
          {ttsProgress && (
            <div className="bg-slate-900/50 border border-slate-700 rounded p-2">
              <div className="text-[10px] text-slate-400 mb-1">
                {ttsProgress.stage} ({ttsProgress.segmentsCompleted}/{ttsProgress.segmentsTotal})
              </div>
              <div className="flex gap-1">
                {ttsProgress.segmentsStatus.map((s, i) => (
                  <div
                    key={i}
                    className={`flex-1 h-2 rounded ${
                      s === 'done'
                        ? 'bg-emerald-500'
                        : s === 'running'
                        ? 'bg-amber-500 animate-pulse'
                        : s === 'failed'
                        ? 'bg-red-500'
                        : 'bg-slate-700'
                    }`}
                    title={`段 ${i + 1}: ${s}`}
                  />
                ))}
              </div>
              {ttsProgress.lastLog && (
                <div className="text-[10px] text-slate-500 mt-1 truncate">
                  {ttsProgress.lastLog}
                </div>
              )}
            </div>
          )}

          {ttsError && (
            <div className="bg-red-900/30 border border-red-700 rounded p-2 text-xs text-red-300">
              {ttsError}
            </div>
          )}

          {/* 合并后音频 */}
          {ttsResult && (
            <div className="bg-slate-900/50 border border-emerald-700 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-emerald-400 font-bold">
                  ✓ 配音完成 · {ttsResult.totalDuration.toFixed(1)} 秒
                </span>
                <a
                  href={ttsResult.mergedAudioUrl}
                  download={`tts_${Date.now()}.wav`}
                  className="text-[10px] text-blue-400 hover:text-blue-300 underline flex items-center gap-1"
                >
                  <Download size={10} /> 下载 WAV
                </a>
              </div>
              <audio controls src={ttsResult.mergedAudioUrl} className="w-full h-8" />
              <details className="text-[10px] text-slate-500">
                <summary className="cursor-pointer hover:text-slate-300">
                  段详情（共 {ttsResult.segments.length} 段）
                </summary>
                <div className="mt-1 space-y-1">
                  {ttsResult.segments.map((s) => (
                    <div key={s.index} className="flex items-start gap-1">
                      <span
                        className={`flex-shrink-0 w-4 text-center ${
                          s.success ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {s.success ? '✓' : '✗'}
                      </span>
                      <span className="text-slate-400 truncate">
                        段{s.index + 1}: {s.text.slice(0, 30)}... ({s.duration.toFixed(1)}s)
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════ 底部：导出 + 终端日志 ═══════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 导出 */}
        <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 space-y-3">
          <div className="flex items-center gap-2">
            <Film size={18} className="text-blue-400" />
            <h3 className="text-lg font-bold text-blue-300">导出</h3>
          </div>
          {finalCover ? (
            <div className="bg-slate-900/50 border border-emerald-700 rounded p-2 text-xs space-y-1">
              <div className="text-emerald-400 font-bold">✓ 终封面已选</div>
              <div className="text-slate-300 truncate">
                {finalCover.emoji} [{finalCover.styleTag}] {finalCover.title}
              </div>
            </div>
          ) : (
            <div className="bg-slate-900/50 border border-slate-700 rounded p-2 text-xs text-slate-500">
              尚未选定终封面
            </div>
          )}
          {ttsResult && (
            <div className="bg-slate-900/50 border border-emerald-700 rounded p-2 text-xs space-y-1">
              <div className="text-emerald-400 font-bold">✓ 配音已完成</div>
              <div className="text-slate-300">
                总时长：{ttsResult.totalDuration.toFixed(1)} 秒
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              disabled
              className="px-3 py-2 bg-slate-700 text-slate-500 rounded-lg text-xs cursor-not-allowed flex items-center justify-center gap-1"
              title="视频导出（需 Remotion 服务）"
              type="button"
            >
              <Film size={14} /> 导出 MP4（待启动）
            </button>
            <button
              disabled
              className="px-3 py-2 bg-slate-700 text-slate-500 rounded-lg text-xs cursor-not-allowed flex items-center justify-center gap-1"
              title="剪映草稿导出"
              type="button"
            >
              <Download size={14} /> 剪映草稿（待启动）
            </button>
          </div>
          <p className="text-[10px] text-slate-500">
            视频导出需接入 Remotion 渲染服务，下版本接入
          </p>
        </div>

        {/* 终端日志 */}
        <div className="lg:col-span-2 bg-slate-900 p-3 rounded-xl border border-slate-700 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal size={16} className="text-emerald-400" />
              <h3 className="text-sm font-bold text-emerald-300">终端日志</h3>
              <span className="text-[10px] text-slate-500">({logs.length} 条)</span>
            </div>
            <button
              onClick={clearLogs}
              className="text-[10px] text-slate-500 hover:text-slate-300 flex items-center gap-1"
              type="button"
              title="清空日志"
            >
              <Trash2 size={10} /> 清空
            </button>
          </div>
          <div
            ref={logScrollRef}
            className="bg-black/60 rounded p-2 h-64 overflow-y-auto font-mono text-[10px] text-slate-300 space-y-0.5"
          >
            {logs.length === 0 ? (
              <div className="text-slate-600 italic">等待操作...所有任务进度、错误、警告都会记录在这里</div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="flex items-start gap-1">
                  <span className="text-slate-600 flex-shrink-0">{log.time}</span>
                  <span
                    className={`flex-shrink-0 px-1 rounded font-bold ${
                      log.tag === 'ERROR'
                        ? 'bg-red-900/60 text-red-300'
                        : log.tag === 'WARN'
                        ? 'bg-amber-900/60 text-amber-300'
                        : log.tag === 'STAGE'
                        ? 'bg-emerald-900/60 text-emerald-300'
                        : log.tag === 'IMG'
                        ? 'bg-purple-900/60 text-purple-300'
                        : log.tag === 'TTS'
                        ? 'bg-blue-900/60 text-blue-300'
                        : 'bg-slate-700 text-slate-400'
                    }`}
                  >
                    {log.tag}
                  </span>
                  <span className="break-all whitespace-pre-wrap flex-1">{log.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CopyBasedPanel;