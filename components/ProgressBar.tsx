/**
 * 进度条组件
 * 用于显示批量操作的进度
 */

import React from 'react';
import { Loader2 } from 'lucide-react';

interface ProgressBarProps {
  current: number; // 当前进度
  total: number; // 总数
  label?: string; // 标签文本
  showPercentage?: boolean; // 是否显示百分比
  showCount?: boolean; // 是否显示数量
  color?: 'emerald' | 'blue' | 'amber'; // 颜色主题
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  current,
  total,
  label,
  showPercentage = true,
  showCount = true,
  color = 'emerald',
}) => {
  const percentage = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const isComplete = current >= total;

  const colorClasses = {
    emerald: 'bg-emerald-500',
    blue: 'bg-blue-500',
    amber: 'bg-amber-500',
  };

  const bgColorClasses = {
    emerald: 'bg-emerald-500/20',
    blue: 'bg-blue-500/20',
    amber: 'bg-amber-500/20',
  };

  return (
    <div className="w-full space-y-2">
      {(label || showCount || showPercentage) && (
        <div className="flex items-center justify-between text-sm">
          {label && (
            <span className="text-slate-300 font-medium">{label}</span>
          )}
          <div className="flex items-center gap-3">
            {showCount && (
              <span className="text-slate-400">
                {current} / {total}
              </span>
            )}
            {showPercentage && (
              <span className="text-slate-400 font-medium">{percentage}%</span>
            )}
            {!isComplete && (
              <Loader2 className="w-4 h-4 text-emerald-400 animate-spin" />
            )}
          </div>
        </div>
      )}
      <div className={`w-full h-2 rounded-full overflow-hidden ${bgColorClasses[color]}`}>
        <div
          className={`h-full transition-all duration-300 ease-out ${colorClasses[color]} ${
            isComplete ? 'rounded-full' : ''
          }`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
};
