/**
 * 文案成片主面板（v1.0）
 *
 * 流程：
 * 1. 用户输入文案 → 点击「智能解析」
 * 2. AI 返回 3 套「标题+封面提示词+人物信息」方案
 * 3. 用户选中一套 → 上传角色参考图（可选）
 * 4. 点击「生成封面」→ 调用 yunwuService.generateImage（GPT Image 2）
 * 5. 点击「生成配音」→ 调用 copyParallelTtsService.runParallelTts（5 段并行）
 * 6. 点击「生成视频」→ Ken Burns 推镜头 + 封面 + 配音 → MP4
 * 7. 「导出 MP4」+「导出剪映草稿」
 */

import React, { useState, useRef, useCallback, useMemo } from 'react';
import {
  Sparkles,
  Loader2,
  Wand2,
  Image as ImageIcon,
  Volume2,
  Video,
  Check,
  Upload,
  AlertCircle,
  Download,
  Film,
  Mic,
  Square,
  Play,
  X,
  ChevronDown,
  Zap,
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

  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [characterRefs, setCharacterRefs] = useState<string[]>([]); // base64 data URLs
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [coverImageUrl, setCoverImageUrl] = useState<string>('');
  const [coverGenerating, setCoverGenerating] = useState<boolean>(false);
  const [coverError, setCoverError] = useState<string | null>(null);

  const [ttsProgress, setTtsProgress] = useState<ParallelTtsProgress | null>(null);
  const [ttsGenerating, setTtsGenerating] = useState<boolean>(false);
  const [ttsResult, setTtsResult] = useState<ParallelTtsResult | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);

  const [videoUrl, setVideoUrl] = useState<string>('');
  const [videoGenerating, setVideoGenerating] = useState<boolean>(false);

  const abortRef = useRef<AbortController | null>(null);

  // ──────────────────────────────────────────────
  // 派生
  // ──────────────────────────────────────────────
  const selectedOption: CopyTitleOption | null = useMemo(
    () => analysisResult?.titleOptions[selectedIndex] ?? null,
    [analysisResult, selectedIndex]
  );

  const charCount = rawCopy.length;

  // ──────────────────────────────────────────────
  // 文案解析
  // ──────────────────────────────────────────────
  const handleAnalyze = useCallback(async () => {
    if (!apiKey?.trim()) {
      toast.error('请先在顶部输入云雾 API Key', 4000);
      return;
    }
    if (rawCopy.trim().length < 50) {
      toast.error('文案过短，至少 50 字，建议 300 字以上', 4000);
      return;
    }
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisResult(null);
    setSelectedIndex(0);
    setCoverImageUrl('');
    setTtsResult(null);
    setVideoUrl('');
    try {
      const r = await analyzeCopyWithLlm(apiKey, rawCopy, COPY_ANALYSIS_PROMPT, (msg) => {
        console.log(msg);
      });
      setAnalysisResult(r);
    } catch (e: any) {
      setAnalysisError(e?.message || '解析失败');
      toast.error(e?.message || '智能解析失败', 5000);
    } finally {
      setAnalyzing(false);
    }
  }, [apiKey, rawCopy, toast]);

  // ──────────────────────────────────────────────
  // 角色参考图上传
  // ──────────────────────────────────────────────
  const handleUploadRef = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
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
      })
      .catch((err) => toast.error('参考图读取失败：' + err.message, 4000));
    // 清空以便重复上传
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [characterRefs.length, toast]);

  const removeRef = (idx: number) => {
    setCharacterRefs((prev) => prev.filter((_, i) => i !== idx));
  };

  // ──────────────────────────────────────────────
  // 生成封面
  // ──────────────────────────────────────────────
  const handleGenerateCover = useCallback(async () => {
    if (!selectedOption) {
      toast.error('请先选择一套方案', 3000);
      return;
    }
    if (!apiKey?.trim()) {
      toast.error('请先在顶部输入云雾 API Key', 4000);
      return;
    }
    setCoverGenerating(true);
    setCoverError(null);
    setCoverImageUrl('');
    try {
      const character = analysisResult?.characterInfo as CopyCharacterInfo | undefined;
      const promptText = `${selectedOption.coverPromptEn}\n\nStyle hints: ${selectedOption.styleKeywords.join(', ')}`;
      const r = await generateImage(apiKey, {
        model: 'gpt-image-2',
        prompt: promptText,
        size: '1280x720', // 16:9 横屏
        quality: 'high',
        n: 1,
        referenceDataUrls: characterRefs.length > 0 ? characterRefs : undefined,
        characterName: character?.name || undefined,
        timeoutMs: 240_000,
      });
      if (!r.success) {
        throw new Error(r.error || '生图失败');
      }
      const url = r.url;
      if (!url) throw new Error('生图返回无 URL');
      setCoverImageUrl(url);
      toast.success('封面图生成成功', 2500);
    } catch (e: any) {
      setCoverError(e?.message || '封面生成失败');
      toast.error(e?.message || '封面生成失败', 5000);
    } finally {
      setCoverGenerating(false);
    }
  }, [apiKey, selectedOption, analysisResult, characterRefs, toast]);

  // ──────────────────────────────────────────────
  // 生成配音（5 段并行）
  // ──────────────────────────────────────────────
  const handleGenerateTts = useCallback(async () => {
    if (!selectedOption) {
      toast.error('请先选择一套方案', 3000);
      return;
    }
    if (!runningHubApiKey?.trim()) {
      toast.error('请先在顶部输入 RunningHub API Key', 4000);
      return;
    }
    if (rawCopy.trim().length < 50) {
      toast.error('文案过短，无法配音', 3000);
      return;
    }
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
          onProgress: (p) => setTtsProgress(p),
          signal: ac.signal,
        }
      );
      setTtsResult(r);
      toast.success(`5 段并行配音完成，总时长 ${r.totalDuration.toFixed(1)} 秒`, 3000);
    } catch (e: any) {
      setTtsError(e?.message || '配音失败');
      toast.error(e?.message || '配音失败', 5000);
    } finally {
      setTtsGenerating(false);
      setTtsProgress(null);
      abortRef.current = null;
    }
  }, [runningHubApiKey, apiKey, selectedOption, rawCopy, toast]);

  const handleCancelTts = () => {
    abortRef.current?.abort();
  };

  // ──────────────────────────────────────────────
  // 重置
  // ──────────────────────────────────────────────
  const handleReset = () => {
    setAnalysisResult(null);
    setSelectedIndex(0);
    setCharacterRefs([]);
    setCoverImageUrl('');
    setCoverError(null);
    setTtsResult(null);
    setTtsError(null);
    setTtsProgress(null);
    setVideoUrl('');
    setAnalysisError(null);
  };

  // ──────────────────────────────────────────────
  // 渲染
  // ──────────────────────────────────────────────
  return (
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

        {/* 文本编辑 */}
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
            >
              重置
            </button>
          </div>
        </div>

        {/* 角色参考图 */}
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

        {/* 解析按钮 */}
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

      {/* ───────────── 右栏：方案 + 生成进度 + 预览 ───────────── */}
      <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 space-y-4">
        <div className="flex items-center gap-2">
          <Zap size={18} className="text-amber-400" />
          <h3 className="text-lg font-bold text-amber-300">方案选择 + 生成</h3>
        </div>

        {/* ─── 3 套方案卡片 ─── */}
        {analysisResult && (
          <div className="grid grid-cols-1 gap-2">
            {analysisResult.titleOptions.map((opt, idx) => (
              <button
                key={idx}
                onClick={() => setSelectedIndex(idx)}
                className={`text-left p-3 rounded-lg border-2 transition-all ${
                  selectedIndex === idx
                    ? 'border-emerald-400 bg-emerald-900/30'
                    : 'border-slate-700 bg-slate-900/50 hover:border-slate-500'
                }`}
                type="button"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-bold text-amber-300">
                    {opt.emoji} {opt.styleTag}
                  </span>
                  {selectedIndex === idx && <Check size={16} className="text-emerald-400" />}
                </div>
                <div className="text-sm text-slate-100 font-medium leading-snug mb-1">
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
            ))}
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
          </div>
        )}

        {/* ─── 生成封面 ─── */}
        {selectedOption && (
          <div className="space-y-2">
            <button
              onClick={handleGenerateCover}
              disabled={coverGenerating}
              className="w-full px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-lg flex items-center justify-center gap-2 disabled:opacity-50 transition-all"
              type="button"
            >
              {coverGenerating ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> 生成封面中...
                </>
              ) : (
                <>
                  <ImageIcon size={16} /> 生成封面图（GPT Image 2）
                </>
              )}
            </button>
            {coverError && (
              <div className="bg-red-900/30 border border-red-700 rounded p-2 text-xs text-red-300">
                {coverError}
              </div>
            )}
            {coverImageUrl && (
              <div className="border border-slate-600 rounded-lg overflow-hidden">
                <img src={coverImageUrl} alt="封面" className="w-full" />
              </div>
            )}
          </div>
        )}

        {/* ─── 5 段并行配音 ─── */}
        {selectedOption && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button
                onClick={handleGenerateTts}
                disabled={ttsGenerating}
                className="flex-1 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white font-bold rounded-lg flex items-center justify-center gap-2 disabled:opacity-50 transition-all"
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
                  className="px-3 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg"
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
                    className="text-[10px] text-blue-400 hover:text-blue-300 underline"
                  >
                    下载 WAV
                  </a>
                </div>
                <audio controls src={ttsResult.mergedAudioUrl} className="w-full h-8" />
                {/* 段详情 */}
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

        {/* ─── 导出 ─── */}
        {coverImageUrl && ttsResult && (
          <div className="border-t border-slate-700 pt-3 space-y-2">
            <div className="text-xs text-slate-400 font-semibold">导出视频</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                disabled
                className="px-4 py-2 bg-slate-700 text-slate-500 rounded-lg text-xs cursor-not-allowed flex items-center justify-center gap-1"
                title="视频导出（需 Remotion 服务）"
                type="button"
              >
                <Film size={14} /> 导出 MP4（待启动）
              </button>
              <button
                disabled
                className="px-4 py-2 bg-slate-700 text-slate-500 rounded-lg text-xs cursor-not-allowed flex items-center justify-center gap-1"
                title="剪映草稿导出"
                type="button"
              >
                <Download size={14} /> 剪映草稿（待启动）
              </button>
            </div>
            <p className="text-[10px] text-slate-500">
              视频导出需接入 Remotion 渲染服务（媒体生成的 Ken Burns 推镜头流程），后续接入
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default CopyBasedPanel;
