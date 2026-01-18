/**
 * 历史记录选择器组件
 * 用于显示和选择历史记录
 */

import React, { useState, useEffect } from 'react';
import { HistoryRecord } from '../services/historyService';
import { Clock, X, FileText, Trash2, Check } from 'lucide-react';

interface HistorySelectorProps {
  records: HistoryRecord[];
  onSelect: (record: HistoryRecord) => void;
  onClose: () => void;
  onDelete?: (timestamp: number) => void;
  title?: string;
}

export const HistorySelector: React.FC<HistorySelectorProps> = ({
  records,
  onSelect,
  onClose,
  onDelete,
  title = '歷史記錄',
}) => {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getPreview = (content: string, maxLength: number = 100): string => {
    if (content.length <= maxLength) {
      return content;
    }
    return content.substring(0, maxLength) + '...';
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-slate-800 border border-slate-700 rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <h3 className="text-lg font-semibold text-slate-200 flex items-center gap-2">
            <Clock size={20} />
            {title} ({records.length})
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* 历史记录列表 */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-2">
          {records.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <FileText size={48} className="mx-auto mb-4 opacity-50" />
              <p>暫無歷史記錄</p>
            </div>
          ) : (
            records.map((record, index) => (
              <div
                key={record.timestamp}
                className={`bg-slate-900/50 border rounded-lg p-3 cursor-pointer transition-all ${
                  selectedIndex === index
                    ? 'border-emerald-500 bg-emerald-500/10'
                    : 'border-slate-700 hover:border-slate-600'
                }`}
                onClick={() => setSelectedIndex(index)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs text-slate-500">
                        {formatTime(record.timestamp)}
                      </span>
                      {record.metadata?.topic && (
                        <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded">
                          {record.metadata.topic}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-300 line-clamp-2">
                      {getPreview(record.content)}
                    </p>
                    {record.metadata?.input && (
                      <p className="text-xs text-slate-500 mt-1">
                        輸入: {getPreview(record.metadata.input, 50)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {onDelete && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm('確定要刪除這條歷史記錄嗎？')) {
                            onDelete(record.timestamp);
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
          <div className="flex items-center justify-between p-4 border-t border-slate-700">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium rounded transition-all"
            >
              取消
            </button>
            <button
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
              加載選中記錄
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
