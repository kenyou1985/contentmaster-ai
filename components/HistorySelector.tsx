/**
 * 历史记录选择器组件
 * 用于显示和选择历史记录
 */

import React, { useState } from 'react';
import { HistoryRecord } from '../services/historyService';
import { Clock, X, FileText, Trash2, Check } from 'lucide-react';

interface HistorySelectorProps {
  records: HistoryRecord[];
  onSelect: (record: HistoryRecord) => void;
  onClose: () => void;
  /** 删除单条（需由父组件写入 localStorage 等持久层） */
  onDelete?: (record: HistoryRecord) => void;
  /** 一键清空当前列表对应的持久化数据 */
  onClearAll?: () => void;
  title?: string;
  /** 主按钮文案，默认「加载选中记录」 */
  primarySelectLabel?: string;
  /**
   * 媒体历史等：仅打开只读预览标签（与队列「查看任务」一致），不覆盖主编辑区
   */
  onViewSnapshot?: (record: HistoryRecord) => void;
  viewSnapshotLabel?: string;
}

export const HistorySelector: React.FC<HistorySelectorProps> = ({
  records,
  onSelect,
  onClose,
  onDelete,
  onClearAll,
  title = '历史记录',
  primarySelectLabel = '加载选中记录',
  onViewSnapshot,
  viewSnapshotLabel = '查看快照',
}) => {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const formatTime = (timestamp: number | undefined): string => {
    const t =
      typeof timestamp === 'number' && !Number.isNaN(timestamp) ? timestamp : Date.now();
    const date = new Date(t);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getPreview = (content: string | undefined | null, maxLength: number = 100): string => {
    const s = content == null ? '' : String(content);
    if (s.length <= maxLength) return s;
    return s.substring(0, maxLength) + '...';
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-slate-800 border border-slate-700 rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700 gap-2">
          <h3 className="text-lg font-semibold text-slate-200 flex items-center gap-2 min-w-0">
            <Clock size={20} className="shrink-0" />
            <span className="truncate">{title} ({records.length})</span>
          </h3>
          <div className="flex items-center gap-2 shrink-0">
            {onClearAll && records.length > 0 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`确定清空全部 ${records.length} 条记录吗？此操作不可恢复。`)) {
                    onClearAll();
                  }
                }}
                className="text-xs px-2 py-1.5 rounded bg-red-900/50 text-red-200 hover:bg-red-800/60 border border-red-700/50"
              >
                清空全部
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 transition-colors p-1"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* 历史记录列表 */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-2">
          {records.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <FileText size={48} className="mx-auto mb-4 opacity-50" />
              <p>暂无历史记录</p>
            </div>
          ) : (
            records.map((record, index) => (
              <div
                key={`${record.timestamp}-${index}`}
                className={`bg-slate-900/50 border rounded-lg p-3 cursor-pointer transition-all ${
                  selectedIndex === index
                    ? 'border-emerald-500 bg-emerald-500/10'
                    : 'border-slate-700 hover:border-slate-600'
                }`}
                onClick={() => setSelectedIndex(index)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-xs text-slate-500">
                        {formatTime(record.timestamp)}
                      </span>
                      {record.metadata?.topic && (
                        <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded inline-flex items-center gap-1.5 max-w-full">
                          {record.metadata?.thumbUrl && (
                            <img
                              src={record.metadata.thumbUrl as string}
                              alt=""
                              className="h-6 w-6 rounded object-cover shrink-0 border border-emerald-500/30"
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display = 'none';
                              }}
                            />
                          )}
                          <span className="truncate">{record.metadata.topic}</span>
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-300 line-clamp-2">
                      {getPreview(record.content)}
                    </p>
                    {record.metadata?.input && (
                      <p className="text-xs text-slate-500 mt-1">
                        输入: {getPreview(record.metadata.input, 50)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {onDelete && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm('确定要删除这条历史记录吗？')) {
                            onDelete(record);
                          }
                        }}
                        className="text-red-400 hover:text-red-300 p-1"
                        title="刪除"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* 底部操作 */}
        {records.length > 0 && (
          <div className="flex items-center justify-between gap-2 flex-wrap p-4 border-t border-slate-700">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium rounded transition-all"
            >
              取消
            </button>
            <div className="flex items-center gap-2 flex-wrap justify-end flex-1 min-w-0">
              {onViewSnapshot && (
                <button
                  type="button"
                  onClick={() => {
                    if (selectedIndex === null || !records[selectedIndex]) return;
                    onViewSnapshot(records[selectedIndex]);
                  }}
                  disabled={selectedIndex === null}
                  className="px-4 py-2 bg-slate-600 hover:bg-slate-500 text-white text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {viewSnapshotLabel}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (selectedIndex !== null && records[selectedIndex]) {
                    onSelect(records[selectedIndex]);
                    onClose();
                  }
                }}
                disabled={selectedIndex === null}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <Check size={16} />
                {primarySelectLabel}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
