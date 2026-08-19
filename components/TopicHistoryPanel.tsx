/**
 * 历史选题记录面板
 * 按赛道 key 显示最近 50 条已生成的选题，避免跨次重复。
 * 折叠式 UI，默认收起。展示选题 + 生成时间，支持一键复制。
 */

import React, { useState } from 'react';
import { History, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';

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
}

export const TopicHistoryPanel: React.FC<TopicHistoryPanelProps> = ({
  history,
  currentNicheKey,
  onCopyTitle,
}) => {
  const [expanded, setExpanded] = useState(false);

  // 找出所有 key 的并集，逆序排序（最新在前）
  const allEntries: { key: string; entry: TopicHistoryEntry }[] = [];
  for (const [key, entries] of Object.entries(history)) {
    for (const e of entries) {
      allEntries.push({ key, entry: e });
    }
  }
  allEntries.sort((a, b) => b.entry.generatedAt - a.entry.generatedAt);

  // 只显示当前赛道的记录
  const currentEntries = (history[currentNicheKey] ?? []).slice().reverse();
  const currentCount = currentEntries.length;
  const totalCount = allEntries.length;

  if (totalCount === 0) return null;

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
          收起后下次默认折叠 · 点击展开
        </span>
      </button>

      {expanded && (
        <div className="border-t border-slate-700/70 px-4 py-3 max-h-[400px] overflow-y-auto custom-scrollbar">
          {currentEntries.length === 0 ? (
            <div className="text-center py-8 text-slate-500 text-sm">
              当前赛道暂无历史选题。
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
          </div>
        </div>
      )}
    </div>
  );
};
