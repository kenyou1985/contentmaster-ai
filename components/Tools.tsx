import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import {
  PenTool, Youtube, Trash2, Wand2, Sparkles, Loader2, Copy, Download,
  RefreshCw, ChevronDown, ChevronUp, Eye, EyeOff, Check, X, Brain,
  Type, Globe, Lock, AlertTriangle, BarChart3,
} from 'lucide-react';
import type { ApiProvider } from '../types';
import { fetchYouTubeTranscript, extractYouTubeVideoId, isYouTubeLink } from '../services/youtubeService';
import {
  humanize,
  humanizeNinja,
  humanizeLocal,
  humanizeSentence,
  detectAI,
  cleanLlmOutput,
  type RewriteLevel,
  type WritingStyle,
  type DetectorReport,
  getScoreColor,
  getScoreBgColor,
  getClassificationColor,
  getVerdictLabel,
} from '../services/humanize';

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

const REWRITE_LEVELS: { id: RewriteLevel; label: string; desc: string }[] = [
  { id: 'light', label: '轻度', desc: '只改 AI 套话和 em-dash' },
  { id: 'medium', label: '中度', desc: '应用突发性 + AI 短语替换' },
  { id: 'aggressive', label: '强力', desc: '大幅重排 + 缩写注入' },
  { id: 'ninja', label: '忍者', desc: '多遍轮替，最大隐匿' },
];

const WRITING_STYLES: { id: WritingStyle; label: string }[] = [
  { id: 'natural', label: '通用自然' },
  { id: 'academic', label: '学术' },
  { id: 'professional', label: '专业' },
  { id: 'casual', label: '口语' },
  { id: 'creative', label: '创意' },
  { id: 'technical', label: '技术' },
];

const TARGET_LANGUAGES: { id: string; label: string }[] = [
  { id: 'auto', label: '随原文' },
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'es', label: 'Español' },
  { id: 'de', label: 'Deutsch' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Props（保持向后兼容）
// ─────────────────────────────────────────────────────────────────────────────

interface ToolsProps {
  apiKey: string;
  provider: ApiProvider;
  toast?: {
    success: (msg: string, ms?: number) => void;
    error: (msg: string, ms?: number) => void;
    info: (msg: string, ms?: number) => void;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────────────────────────

export const Tools: React.FC<ToolsProps> = ({ toast }) => {
  // ── 状态 ──────────────────────────────────────────────────────────────
  const [inputText, setInputText] = useState('');
  const [outputText, setOutputText] = useState('');
  const [level, setLevel] = useState<RewriteLevel>('medium');
  const [style, setStyle] = useState<WritingStyle>('natural');
  const [targetLang, setTargetLang] = useState<string>('auto');
  const [freezeWordsText, setFreezeWordsText] = useState('');
  const [privacyMode, setPrivacyMode] = useState(false);
  const [isWorking, setIsWorking] = useState(false);

  // ── 检测报告 ──────────────────────────────────────────────────────────
  const [beforeReport, setBeforeReport] = useState<DetectorReport | null>(null);
  const [afterReport, setAfterReport] = useState<DetectorReport | null>(null);
  const [showReport, setShowReport] = useState(true);
  const [runningDetection, setRunningDetection] = useState(false);
  const [rehumanizingIdx, setRehumanizingIdx] = useState<number | null>(null);

  // ── YouTube 提取 ──────────────────────────────────────────────────────
  const [youtubeInput, setYoutubeInput] = useState('');
  const [isExtractingTranscript, setIsExtractingTranscript] = useState(false);

  // ── 终端日志 ──────────────────────────────────────────────────────────
  const [terminalLog, setTerminalLog] = useState<string>('等待任务...');
  const terminalRef = useRef<HTMLDivElement>(null);

  const appendTerminal = useCallback((msg: string) => {
    const stamp = new Date().toLocaleTimeString();
    setTerminalLog(prev => `${prev}\n[${stamp}] ${msg}`.trim());
  }, []);

  // 终端自动滚动到底部
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalLog]);

  // ── 工具函数 ──────────────────────────────────────────────────────────
  const getFreezeWords = (): string[] =>
    freezeWordsText.split(/[,，\n]/).map(w => w.trim()).filter(Boolean);

  const toastMsg = (msg: string, kind: 'success' | 'error' | 'info' = 'info') => {
    toast?.[kind]?.(msg);
  };

  // ── YouTube 字幕提取 ──────────────────────────────────────────────────
  const handleExtractYouTube = async () => {
    const text = youtubeInput.trim();
    if (!text) {
      toastMsg('请输入 YouTube 链接', 'error');
      return;
    }
    if (!isYouTubeLink(text)) {
      toastMsg('链接不是有效的 YouTube URL', 'error');
      return;
    }
    const videoId = extractYouTubeVideoId(text);
    if (!videoId) {
      toastMsg('无法解析视频 ID', 'error');
      return;
    }
    setIsExtractingTranscript(true);
    appendTerminal(`开始提取 YouTube 字幕：${videoId}`);
    try {
      const result = await fetchYouTubeTranscript(videoId);
      if (result.success && result.transcript) {
        setInputText(prev => prev ? `${prev}\n\n${result.transcript}` : result.transcript!);
        appendTerminal(`字幕提取成功：${result.transcript!.length} 字符`);
        toastMsg('字幕提取成功', 'success');
      } else {
        appendTerminal(`字幕提取失败：${result.error || '未知错误'}`);
        toastMsg(`提取失败：${result.error || '未知错误'}`, 'error');
      }
    } catch (e: any) {
      appendTerminal(`字幕提取异常：${e?.message || e}`);
      toastMsg(`提取异常：${e?.message || e}`, 'error');
    } finally {
      setIsExtractingTranscript(false);
    }
  };

  // ── AI 检测 ──────────────────────────────────────────────────────────
  const handleDetectOnly = async () => {
    if (!inputText.trim()) {
      toastMsg('请输入文本', 'error');
      return;
    }
    setRunningDetection(true);
    appendTerminal('AI 检测中...');
    try {
      const report = detectAI(inputText);
      setBeforeReport(report);
      setAfterReport(null);
      appendTerminal(`AI 检测完成：得分 ${report.score}（${getVerdictLabel(report.verdict)}）`);
      toastMsg(`检测完成：${report.score} 分`, 'success');
    } catch (e: any) {
      appendTerminal(`AI 检测异常：${e?.message || e}`);
      toastMsg('检测失败', 'error');
    } finally {
      setRunningDetection(false);
    }
  };

  // ── 主改写 ────────────────────────────────────────────────────────────
  const handleHumanize = async () => {
    if (!inputText.trim()) {
      toastMsg('请输入文本', 'error');
      return;
    }
    setIsWorking(true);
    setOutputText('');
    setAfterReport(null);
    appendTerminal(`开始改写：等级=${level}，风格=${style}，语言=${targetLang}，模式=${privacyMode ? '本地' : 'LLM'}`);

    try {
      if (privacyMode) {
        // 仅本地后处理
        const final = humanizeLocal(inputText, {
          level,
          style,
          lang: targetLang === 'auto' ? 'auto' : (targetLang as any),
          freezeWords: getFreezeWords(),
        });
        setOutputText(final);
        const report = detectAI(final, { lang: targetLang === 'auto' ? 'auto' : (targetLang as any) });
        setAfterReport(report);
        const before = detectAI(inputText, { lang: targetLang === 'auto' ? 'auto' : (targetLang as any) });
        setBeforeReport(before);
        appendTerminal(`本地后处理完成：${report.score} 分（${getVerdictLabel(report.verdict)}）`);
        toastMsg('本地后处理完成', 'success');
      } else {
        const onProgress = (stage: string, message: string) => {
          appendTerminal(`[${stage}] ${message}`);
        };
        const result = level === 'ninja'
          ? await humanizeNinja(inputText, {
              level,
              style,
              lang: targetLang === 'auto' ? 'auto' : (targetLang as any),
              freezeWords: getFreezeWords(),
              withDetection: true,
              onProgress,
            })
          : await humanize(inputText, {
              level,
              style,
              lang: targetLang === 'auto' ? 'auto' : (targetLang as any),
              freezeWords: getFreezeWords(),
              withDetection: true,
              onProgress,
            });
        // 清理 LLM 元描述
        const cleanedFinal = cleanLlmOutput(result.final, result.lang);
        setOutputText(cleanedFinal);
        setBeforeReport(result.before || null);
        setAfterReport(result.after || null);
        const delta = result.improvement ?? 0;
        appendTerminal(`改写完成：${result.before?.score} → ${result.after?.score}（${delta >= 0 ? '+' : ''}${delta}）`);
        toastMsg(`改写完成（${delta >= 0 ? '+' : ''}${delta} 分）`, 'success');
      }
    } catch (e: any) {
      appendTerminal(`改写异常：${e?.message || e}`);
      toastMsg(`改写失败：${e?.message || e}`, 'error');
    } finally {
      setIsWorking(false);
    }
  };

  // ── 再洗一遍（Ninja 模式） ───────────────────────────────────────────
  const handleNinjaAgain = async () => {
    if (!outputText.trim()) {
      toastMsg('请先改写文本', 'error');
      return;
    }
    setIsWorking(true);
    appendTerminal('Ninja 强化再洗...');
    try {
      const result = await humanizeNinja(outputText, {
        level: 'ninja',
        style,
        lang: targetLang === 'auto' ? 'auto' : (targetLang as any),
        freezeWords: getFreezeWords(),
        withDetection: true,
        onProgress: (s, m) => appendTerminal(`[ninja-again/${s}] ${m}`),
      });
      const cleaned = cleanLlmOutput(result.final, result.lang);
      setOutputText(cleaned);
      setAfterReport(result.after || null);
      appendTerminal(`再洗完成：${result.after?.score} 分`);
      toastMsg(`再洗完成（${result.after?.score} 分）`, 'success');
    } catch (e: any) {
      appendTerminal(`再洗异常：${e?.message || e}`);
      toastMsg('再洗失败', 'error');
    } finally {
      setIsWorking(false);
    }
  };

  // ── 单句再人化 ──────────────────────────────────────────────────────
  const handleRehumanizeSentence = async (idx: number) => {
    const sent = afterReport?.sentences[idx] || beforeReport?.sentences[idx];
    if (!sent || !outputText) return;
    setRehumanizingIdx(idx);
    appendTerminal(`单句再人化：${sent.text.slice(0, 30)}...`);
    try {
      const newSentence = await humanizeSentence(sent.text, {
        level: 'medium',
        style,
        freezeWords: getFreezeWords(),
        issues: sent.issues,
      });
      // 替换输出文本中的对应句子
      const sentences = (afterReport || beforeReport)!.sentences;
      const newOutput = sentences.map((s, i) => (i === idx ? newSentence : s.text)).join(' ');
      setOutputText(newOutput);
      // 重新检测
      const newReport = detectAI(newOutput, { lang: targetLang === 'auto' ? 'auto' : (targetLang as any) });
      setAfterReport(newReport);
      appendTerminal(`单句再人化完成，新得分：${newReport.score}`);
      toastMsg('单句已重写', 'success');
    } catch (e: any) {
      appendTerminal(`单句再人化异常：${e?.message || e}`);
      toastMsg('单句再人化失败', 'error');
    } finally {
      setRehumanizingIdx(null);
    }
  };

  // ── 复制 ────────────────────────────────────────────────────────────
  const handleCopy = async () => {
    if (!outputText) return;
    try {
      await navigator.clipboard.writeText(outputText);
      toastMsg('已复制到剪贴板', 'success');
    } catch {
      toastMsg('复制失败', 'error');
    }
  };

  // ── 导出 .txt ───────────────────────────────────────────────────────
  const handleExport = () => {
    if (!outputText) return;
    const blob = new Blob([outputText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `humanized-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastMsg('已导出 .txt', 'success');
  };

  // ── 清空 ────────────────────────────────────────────────────────────
  const handleClear = () => {
    setInputText('');
    setOutputText('');
    setBeforeReport(null);
    setAfterReport(null);
    setYoutubeInput('');
    appendTerminal('已清空输入输出');
  };

  // ── 字符差异 ───────────────────────────────────────────────────────
  const charDiff = useMemo(() => {
    if (!inputText || !outputText) return null;
    const cleanedInput = inputText.replace(/\s+/g, '');
    const cleanedOutput = outputText.replace(/\s+/g, '');
    const delta = cleanedOutput.length - cleanedInput.length;
    const pct = cleanedInput.length ? Math.round((delta / cleanedInput.length) * 100) : 0;
    return { delta, pct };
  }, [inputText, outputText]);

  return (
    <div className="space-y-4 animate-in fade-in duration-500">
      {/* ─── 顶部工具栏 ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="bg-emerald-500/10 p-1.5 rounded-lg border border-emerald-500/30">
            <PenTool className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-100">AI 洗稿 / 人化</h2>
            <p className="text-xs text-slate-500">LLM 改写 + 10+ 项本地后处理 + AI 检测评分</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleClear}
            className="px-3 py-1.5 text-xs rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 flex items-center gap-1.5 transition-colors"
            title="清空输入输出"
          >
            <Trash2 className="w-3.5 h-3.5" /> 清空
          </button>
        </div>
      </div>

      {/* ─── YouTube 字幕提取 ───────────────────────────────────────── */}
      <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Youtube className="w-3.5 h-3.5 text-rose-400" />
          <span className="font-semibold">从 YouTube 视频提取字幕</span>
          <span className="text-slate-600">（支持 https://youtu.be/... 或 youtube.com/watch?v=...）</span>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={youtubeInput}
            onChange={(e) => setYoutubeInput(e.target.value)}
            placeholder="粘贴 YouTube 链接..."
            className="flex-1 bg-slate-900/70 border border-slate-700 rounded-md px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
          />
          <button
            onClick={handleExtractYouTube}
            disabled={isExtractingTranscript}
            className="px-3 py-1.5 text-xs rounded-md bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 border border-rose-500/40 flex items-center gap-1.5 transition-colors disabled:opacity-50"
          >
            {isExtractingTranscript ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Youtube className="w-3.5 h-3.5" />}
            {isExtractingTranscript ? '提取中...' : '提取字幕'}
          </button>
        </div>
      </div>

      {/* ─── 选项面板 ──────────────────────────────────────────────── */}
      <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-3 space-y-3">
        {/* 改写级别 */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-2 space-y-1.5">
            <label className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider flex items-center gap-1">
              <BarChart3 className="w-3 h-3" /> 改写级别
            </label>
            <div className="grid grid-cols-4 gap-1">
              {REWRITE_LEVELS.map(lv => (
                <button
                  key={lv.id}
                  onClick={() => setLevel(lv.id)}
                  disabled={isWorking}
                  className={`px-2 py-1.5 text-xs rounded-md border transition-all ${
                    level === lv.id
                      ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 font-semibold'
                      : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:border-slate-600'
                  } disabled:opacity-50`}
                  title={lv.desc}
                >
                  {lv.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider flex items-center gap-1">
              <Type className="w-3 h-3" /> 写作风格
            </label>
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value as WritingStyle)}
              disabled={isWorking}
              className="w-full bg-slate-900/70 border border-slate-700 rounded-md px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/50 disabled:opacity-50"
            >
              {WRITING_STYLES.map(s => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider flex items-center gap-1">
              <Globe className="w-3 h-3" /> 目标语言
            </label>
            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              disabled={isWorking}
              className="w-full bg-slate-900/70 border border-slate-700 rounded-md px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/50 disabled:opacity-50"
            >
              {TARGET_LANGUAGES.map(l => (
                <option key={l.id} value={l.id}>{l.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* 保留词 + 隐私模式 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2 space-y-1.5">
            <label className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider flex items-center gap-1">
              <Lock className="w-3 h-3" /> 保留词（不改写）
            </label>
            <input
              type="text"
              value={freezeWordsText}
              onChange={(e) => setFreezeWordsText(e.target.value)}
              placeholder="专有名词 / 术语，用 , 或 换行 分隔"
              disabled={isWorking}
              className="w-full bg-slate-900/70 border border-slate-700 rounded-md px-2 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/50 disabled:opacity-50"
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={privacyMode}
                onChange={(e) => setPrivacyMode(e.target.checked)}
                disabled={isWorking}
                className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500/30"
              />
              <span className="flex items-center gap-1">
                <Lock className="w-3 h-3" /> 隐私模式（仅本地后处理）
              </span>
            </label>
          </div>
        </div>
      </div>

      {/* ─── 主网格：输入 + 输出 ──────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 输入区 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="font-semibold flex items-center gap-1">
              <Type className="w-3 h-3" /> 原文
            </span>
            <span className="text-slate-500">
              {inputText.replace(/\s+/g, '').length} 字
              {beforeReport && (
                <span className={`ml-2 ${getScoreColor(beforeReport.score)}`}>
                  · AI 评分 {beforeReport.score}
                </span>
              )}
            </span>
          </div>
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="粘贴需要洗稿 / 人化的文本，或先从上方 YouTube 提取字幕..."
            disabled={isWorking}
            className="w-full h-72 bg-slate-900/70 border border-slate-700 rounded-lg p-3 text-sm text-slate-200 placeholder-slate-600 resize-none focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 disabled:opacity-50"
          />
        </div>

        {/* 输出区 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="font-semibold flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-emerald-400" /> 改写后
            </span>
            <span className="text-slate-500">
              {outputText.replace(/\s+/g, '').length} 字
              {charDiff && (
                <span className={`ml-2 ${Math.abs(charDiff.pct) <= 15 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  · {charDiff.delta >= 0 ? '+' : ''}{charDiff.pct}%
                </span>
              )}
              {afterReport && (
                <span className={`ml-2 ${getScoreColor(afterReport.score)}`}>
                  · AI 评分 {afterReport.score}
                </span>
              )}
            </span>
          </div>
          {outputText ? (
            <SentenceHeatmap
              text={outputText}
              sentences={afterReport?.sentences}
              onRehumanize={handleRehumanizeSentence}
              rehumanizingIdx={rehumanizingIdx}
              lang={targetLang === 'auto' ? 'auto' : (targetLang as any)}
            />
          ) : (
            <textarea
              value=""
              readOnly
              placeholder="改写后的文本会出现在这里..."
              className="w-full h-72 bg-slate-900/40 border border-slate-800 rounded-lg p-3 text-sm text-slate-500 placeholder-slate-700 resize-none"
            />
          )}
          {outputText && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleCopy}
                className="px-2.5 py-1 text-xs rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 flex items-center gap-1.5 transition-colors"
              >
                <Copy className="w-3 h-3" /> 复制
              </button>
              <button
                onClick={handleExport}
                className="px-2.5 py-1 text-xs rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 flex items-center gap-1.5 transition-colors"
              >
                <Download className="w-3 h-3" /> 导出 .txt
              </button>
              <button
                onClick={handleNinjaAgain}
                disabled={isWorking}
                className="px-2.5 py-1 text-xs rounded-md bg-purple-600/20 hover:bg-purple-600/40 text-purple-300 border border-purple-500/40 flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                <RefreshCw className="w-3 h-3" /> 再洗一遍（Ninja）
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ─── 操作按钮 ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleHumanize}
          disabled={isWorking || !inputText.trim()}
          className="px-4 py-2 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-2 shadow-lg shadow-emerald-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isWorking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
          {privacyMode ? '本地处理' : level === 'ninja' ? '开始 Ninja 改写' : '开始改写'}
        </button>
        <button
          onClick={handleDetectOnly}
          disabled={runningDetection || !inputText.trim()}
          className="px-3 py-2 text-xs rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 flex items-center gap-1.5 transition-colors disabled:opacity-50"
        >
          {runningDetection ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Brain className="w-3.5 h-3.5" />}
          仅检测 AI 度
        </button>
      </div>

      {/* ─── AI 检测报告面板 ───────────────────────────────────────── */}
      {(beforeReport || afterReport) && (
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden">
          <button
            onClick={() => setShowReport(s => !s)}
            className="w-full px-4 py-2.5 flex items-center justify-between text-sm text-slate-300 hover:bg-slate-800/40 transition-colors"
          >
            <span className="flex items-center gap-2 font-semibold">
              <Brain className="w-4 h-4 text-purple-400" /> AI 检测报告
              {beforeReport && (
                <span className={`text-xs ${getScoreColor(beforeReport.score)}`}>
                  原文 {beforeReport.score} 分
                </span>
              )}
              {afterReport && (
                <span className={`text-xs ${getScoreColor(afterReport.score)}`}>
                  改写 {afterReport.score} 分
                </span>
              )}
              {beforeReport && afterReport && (afterReport.score - beforeReport.score) !== 0 && (
                <span className={`text-xs ${afterReport.score > beforeReport.score ? 'text-emerald-400' : 'text-rose-400'}`}>
                  ({afterReport.score > beforeReport.score ? '+' : ''}{afterReport.score - beforeReport.score})
                </span>
              )}
            </span>
            {showReport ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {showReport && (afterReport || beforeReport) && (
            <ReportPanel report={afterReport || beforeReport!} before={beforeReport} after={afterReport} />
          )}
        </div>
      )}

      {/* ─── 终端日志 ─────────────────────────────────────────────── */}
      <div className="bg-slate-950/80 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-3 py-1.5 border-b border-slate-800/80 flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-500">
          <Eye className="w-3 h-3" /> 终端日志
        </div>
        <div
          ref={terminalRef}
          className="p-3 max-h-40 overflow-y-auto text-[11px] text-slate-400 font-mono whitespace-pre-wrap leading-relaxed"
        >
          {terminalLog}
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// 子组件：句子级热图
// ─────────────────────────────────────────────────────────────────────────────

interface HeatmapProps {
  text: string;
  sentences?: DetectorReport['sentences'];
  onRehumanize?: (idx: number) => void;
  rehumanizingIdx?: number | null;
  lang?: string;
}

const SentenceHeatmap: React.FC<HeatmapProps> = ({ text, sentences, onRehumanize, rehumanizingIdx, lang }) => {
  // 若没有 sentence 数据，直接展示纯文本
  if (!sentences || sentences.length === 0) {
    return (
      <textarea
        value={text}
        readOnly
        className="w-full h-72 bg-slate-900/40 border border-slate-800 rounded-lg p-3 text-sm text-slate-200 resize-none"
      />
    );
  }

  return (
    <div className="w-full h-72 bg-slate-900/40 border border-slate-800 rounded-lg p-3 text-sm text-slate-200 overflow-y-auto leading-relaxed">
      {sentences.map((s, idx) => (
        <span
          key={idx}
          className={`${getClassificationColor(s.classification)} border rounded-sm px-1 py-0.5 mx-0.5 inline cursor-pointer transition-all hover:brightness-125`}
          title={s.issues.join('\n') || `${s.score} 分`}
          onClick={() => onRehumanize?.(idx)}
        >
          {s.text}
          {rehumanizingIdx === idx && <Loader2 className="w-3 h-3 inline ml-1 animate-spin" />}
        </span>
      ))}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// 子组件：检测报告面板
// ─────────────────────────────────────────────────────────────────────────────

const ReportPanel: React.FC<{ report: DetectorReport; before?: DetectorReport | null; after?: DetectorReport | null }> = ({ report, after }) => {
  const metrics: Array<{ key: keyof DetectorReport['analysis']; label: string; format?: (v: number) => string }> = [
    { key: 'perplexity', label: '词汇多样性' },
    { key: 'burstiness', label: '突发性' },
    { key: 'vocabularyDiversity', label: '词汇丰富度' },
    { key: 'sentenceLengthVariation', label: '句长方差' },
    { key: 'transitionFrequency', label: '转换词频率', format: v => `${v}（越低越自然）` },
    { key: 'passiveVoiceRatio', label: '被动语态', format: v => `${v}（越低越自然）` },
    { key: 'aiPhraseDensity', label: 'AI 短语密度', format: v => `${v}（越低越自然）` },
    { key: 'sentenceStartDiversity', label: '句首多样性' },
    { key: 'pronounUsage', label: '代词使用' },
    { key: 'hedgingFrequency', label: '模糊语频率', format: v => `${v}（越低越自然）` },
    { key: 'quantifierOveruse', label: '量词过度', format: v => `${v}（越低越自然）` },
    { key: 'emDashDensity', label: 'em-dash 密度', format: v => `${v}（越低越自然）` },
  ];

  return (
    <div className="p-4 space-y-4 border-t border-slate-800/80">
      {/* 总分 + 置信区间 */}
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <div className="text-[10px] text-slate-500 uppercase">总分</div>
          <div className={`text-3xl font-bold ${getScoreColor(report.score)}`}>
            {report.score}
            <span className="text-sm text-slate-500 ml-1">/ 100</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] text-slate-500 uppercase">置信区间</div>
          <div className="text-sm text-slate-300">
            {report.confidenceInterval.lower} ~ {report.confidenceInterval.upper}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-slate-500 uppercase">判定</div>
          <div className={`text-sm font-semibold ${getScoreColor(report.score)}`}>
            {getVerdictLabel(report.verdict)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-slate-500 uppercase">语言</div>
          <div className="text-sm text-slate-300">{report.language === 'zh' ? '中文' : 'English'}</div>
        </div>
      </div>

      {/* 指标网格（含权重占比与对总分的贡献） */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {metrics.map(m => {
          const v = report.analysis[m.key];
          const w = report.weights?.[
            m.key === 'vocabularyDiversity' ? 'vocabulary'
            : m.key === 'sentenceLengthVariation' ? 'sentenceVariation'
            : m.key === 'transitionFrequency' ? 'transitions'
            : m.key === 'passiveVoiceRatio' ? 'passive'
            : m.key === 'aiPhraseDensity' ? 'aiPhrases'
            : m.key === 'sentenceStartDiversity' ? 'sentenceStart'
            : m.key === 'pronounUsage' ? 'pronoun'
            : m.key === 'hedgingFrequency' ? 'hedging'
            : m.key === 'quantifierOveruse' ? 'quantifier'
            : m.key === 'emDashDensity' ? 'emDash'
            : m.key === 'burstiness' ? 'burstiness'
            : 'perplexity'
          ] ?? 0;
          const contrib = report.weightedContributions?.[m.key] ?? 0;
          // 进度条：负向指标按 100-v 渲染（让"越好"显示越长）
          const barValue = m.key === 'transitionFrequency'
            || m.key === 'passiveVoiceRatio'
            || m.key === 'aiPhraseDensity'
            || m.key === 'hedgingFrequency'
            || m.key === 'quantifierOveruse'
            || m.key === 'emDashDensity'
            ? 100 - v : v;
          return (
            <div key={m.key as string} className="bg-slate-900/50 border border-slate-800 rounded-lg p-2">
              <div className="flex items-center justify-between gap-1">
                <div className="text-[10px] text-slate-500 truncate">{m.label}</div>
                <div className="text-[9px] text-slate-600 shrink-0">权重 {(w * 100).toFixed(0)}%</div>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <div className="text-base font-bold text-slate-200">{v}</div>
                <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div className={`h-full ${getScoreBgColor(barValue)}`} style={{ width: `${barValue}%` }} />
                </div>
              </div>
              <div className="flex items-center justify-between mt-1">
                <div className="text-[9px] text-slate-600">→ 贡献 {contrib.toFixed(1)} 分</div>
                <div className="text-[9px] text-slate-600">{m.format ? '' : '正向'}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 句子级均分的单独贡献卡（权重最高） */}
      <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] text-slate-500 uppercase">句子级均分（最重权重）</div>
            <div className="text-sm text-slate-300 mt-0.5">
              {report.sentences.length > 0
                ? `共 ${report.sentences.length} 句，平均分 ${(report.sentences.reduce((s, r) => s + r.score, 0) / report.sentences.length).toFixed(1)}`
                : '—'}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-slate-500">权重 {(report.weights?.sentenceAvg * 100).toFixed(0)}%</div>
            <div className="text-sm font-semibold text-emerald-400">
              → 贡献 {((report as any).sentenceAvgContribution ?? 0).toFixed(1)} 分
            </div>
          </div>
        </div>
      </div>

      {/* AI 短语 */}
      {report.foundAiPhrases.length > 0 && (
        <div>
          <div className="text-[10px] text-slate-500 uppercase mb-1">检测到的 AI 短语</div>
          <div className="flex flex-wrap gap-1">
            {report.foundAiPhrases.slice(0, 12).map((p, i) => (
              <span key={i} className="px-2 py-0.5 text-[11px] rounded bg-rose-500/10 text-rose-300 border border-rose-500/30">
                {p}
              </span>
            ))}
            {report.foundAiPhrases.length > 12 && (
              <span className="px-2 py-0.5 text-[11px] text-slate-500">+{report.foundAiPhrases.length - 12} 更多</span>
            )}
          </div>
        </div>
      )}

      {/* 建议 */}
      {report.recommendations.length > 0 && (
        <div>
          <div className="text-[10px] text-slate-500 uppercase mb-1">改进建议</div>
          <ul className="space-y-1 text-xs text-slate-300">
            {report.recommendations.slice(0, 6).map((r, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="text-emerald-400 mt-0.5">•</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Top AI 句 */}
      {report.topAiSentences.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-400 hover:text-slate-300 select-none">
            最 AI 的 5 句（点击查看）
          </summary>
          <ol className="mt-2 space-y-1 list-decimal list-inside">
            {report.topAiSentences.map((s, i) => (
              <li key={i} className="text-rose-300/80">
                <span className="text-slate-400">{s.score} 分 ·</span> {s.text}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
};
