/**
 * 历史选题记录面板
 * 按赛道 key 显示最近 50 条已生成的选题，避免跨次重复。
 * 折叠式 UI，默认收起。展示选题 + 生成时间，支持一键复制。
 * v10.3 增强：始终显示（含空状态）；支持 localStorage 跨刷新持久化。
 */

import React, { useState, useEffect } from 'react';
import { History, ChevronDown, ChevronRight, Copy, Check, Inbox } from 'lucide-react';

export interface TopicHistoryEntry {
  title: string;
  generatedAt: number;
}

interface TopicHistoryPanelProps {
  /** 全部历史（按赛道 key） */
  history: Record<string, TopicHistoryEntry[]>;
  /** 当前赛道 key（高亮显示） */
  currentNicheKey: string;
  onCopyTitle?: (title: string) => void;
  /** 一键清空某赛道历史 */
  onClearNiche?: (key: string) => void;
}

/** localStorage key 前缀，避免与其他存储冲突 */
const LS_KEY_PREFIX = 'topicHistory:v10.3:';

function loadFromLocalStorage(): Record<string, TopicHistoryEntry[]> {
  if (typeof window === 'undefined') return {};
  try {
    const out: Record<string, TopicHistoryEntry[]> = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k || !k.startsWith(LS_KEY_PREFIX)) continue;
      const raw = window.localStorage.getItem(k);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const realKey = k.slice(LS_KEY_PREFIX.length);
        out[realKey] = Array.isArray(parsed) ? parsed : [];
      }
    }
    return out;
  } catch {
    return {};
  }
}

export const TopicHistoryPanel: React.FC<TopicHistoryPanelProps> = ({
  history,
  currentNicheKey,
  onCopyTitle,
  onClearNiche,
}) => {
  const [expanded, setExpanded] = useState(false);
  /** 首次挂载时尝试从 localStorage 恢复历史快照（用于 UI 初次渲染） */
  const [initialSnapshot] = useState(() => loadFromLocalStorage());

  // 合并 props 传入与本地快照（去重）
  const mergedHistory: Record<string, TopicHistoryEntry[]> = {};
  const allKeys = new Set([...Object.keys(history), ...Object.keys(initialSnapshot)]);
  for (const k of allKeys) {
    const a = history[k] ?? [];
    const b = initialSnapshot[k] ?? [];
    const seen = new Set<string>();
    const merged: TopicHistoryEntry[] = [];
    for (const e of [...a, ...b]) {
      if (seen.has(e.title)) continue;
      seen.add(e.title);
      merged.push(e);
    }
    mergedHistory[k] = merged.slice(-50).sort((x, y) => x.generatedAt - y.generatedAt);
  }

  // 找出所有 key 的并集，逆序排序（最新在前）
  const allEntries: { key: string; entry: TopicHistoryEntry }[] = [];
  for (const [key, entries] of Object.entries(mergedHistory)) {
    for (const e of entries) {
      allEntries.push({ key, entry: e });
    }
  }
  allEntries.sort((a, b) => b.entry.generatedAt - a.entry.generatedAt);

  // 只显示当前赛道的记录
  const currentEntries = (mergedHistory[currentNicheKey] ?? []).slice().reverse();
  const currentCount = currentEntries.length;
  const totalCount = allEntries.length;

  // 同步写入 localStorage（在 history 变化时持久化）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      // 仅持久化有内容的赛道，避免污染
      for (const [k, entries] of Object.entries(history)) {
        if (entries.length === 0) continue;
        window.localStorage.setItem(
          `${LS_KEY_PREFIX}${k}`,
          JSON.stringify(entries.slice(-50))
        );
      }
    } catch {
      // localStorage 可能被禁用或超限，忽略
    }
  }, [history]);

  const formatTime = (ts: number): string => {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="mt-6 rounded-xl border border-slate-700/70 bg-slate-900/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-800/50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? (
            <ChevronDown size={16} className="text-slate-400 shrink-0" />
          ) : (
            <ChevronRight size={16} className="text-slate-400 shrink-0" />
          )}
          <History size={16} className="text-amber-400 shrink-0" />
          <span className="text-sm font-semibold text-slate-200">历史选题记录</span>
          <span className="text-xs text-slate-500 shrink-0">
            （当前赛道 {currentCount}/50 · 全部赛道 {totalCount}）
          </span>
        </div>
        <span className="text-[10px] text-slate-500 hidden sm:inline">
          {totalCount > 0 ? '点击展开 / 收起' : '跨刷新自动保存到 localStorage'}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-slate-700/70 px-4 py-3 max-h-[400px] overflow-y-auto custom-scrollbar">
          {currentEntries.length === 0 ? (
            <div className="text-center py-10 text-slate-500 text-sm">
              <Inbox size={40} className="mx-auto mb-3 opacity-50" />
              <p className="mb-1 text-slate-400">当前赛道暂无历史选题</p>
              <p className="text-[10px] text-slate-500 leading-relaxed">
                点击「一键生成爆款选题 / Hooks」后，本面板将自动记录最近 50 条选题，
                用于下次跨次生成去重（避免相似标题重复出现）。
              </p>
              {totalCount > 0 && (
                <p className="text-[10px] text-amber-400 mt-2">
                  💡 当前赛道无历史，但其它赛道累计 {totalCount} 条记录。
                </p>
              )}
            </div>
          ) : (
            <ul className="space-y-2">
              {currentEntries.map((entry, idx) => {
                const isCurrentKey = true; // currentEntries 都是当前赛道
                return (
                  <li
                    key={`${entry.generatedAt}-${idx}`}
                    className={`group flex items-start gap-3 rounded-md px-3 py-2 text-sm transition-colors border ${
                      isCurrentKey
                        ? 'bg-slate-950/50 border-slate-800 hover:border-amber-500/40'
                        : 'bg-slate-900/30 border-slate-800/50 opacity-60'
                    }`}
                  >
                    <span className="text-[10px] text-slate-500 font-mono shrink-0 mt-1 w-[60px]">
                      {formatTime(entry.generatedAt)}
                    </span>
                    <span className="flex-1 min-w-0 text-slate-300 break-words leading-relaxed">
                      {entry.title}
                    </span>
                    {onCopyTitle && (
                      <button
                        type="button"
                        onClick={() => onCopyTitle(entry.title)}
                        className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-emerald-400 transition-all shrink-0"
                        title="复制此选题"
                      >
                        <Copy size={14} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-3 pt-3 border-t border-slate-800 text-[10px] text-slate-500 leading-relaxed">
            💡 历史选题用于跨次生成去重，本次生成会自动避开最近 50 条内的相似标题。
            {currentCount > 0 && onClearNiche && (
              <button
                type="button"
                onClick={() => {
                  if (confirm(`确定清空当前赛道（${currentNicheKey}）的全部 ${currentCount} 条历史？此操作不可恢复。`)) {
                    onClearNiche(currentNicheKey);
                  }
                }}
                className="ml-3 text-red-400 hover:text-red-300 underline"
              >
                清空当前赛道历史
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
