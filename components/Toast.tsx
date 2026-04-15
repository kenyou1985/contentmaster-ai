/**
 * Toast 通知组件
 * 用于显示成功、错误、警告等信息提示
 */

import React, { useEffect } from 'react';
import { CheckCircle, XCircle, AlertCircle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number; // 自动关闭时间（毫秒），0 表示不自动关闭
}

interface ToastProps {
  toast: Toast;
  onClose: (id: string) => void;
}

const ToastItem: React.FC<ToastProps> = ({ toast, onClose }) => {
  useEffect(() => {
    if (toast.duration !== undefined && toast.duration > 0) {
      const timer = setTimeout(() => {
        onClose(toast.id);
      }, toast.duration);
      return () => clearTimeout(timer);
    }
  }, [toast.id, toast.duration, onClose]);

  const icons = {
    success: CheckCircle,
    error: XCircle,
    warning: AlertCircle,
    info: Info,
  };

  const colors = {
    success: 'bg-slate-900 border-2 border-emerald-500 text-emerald-300',
    error: 'bg-slate-900 border-2 border-red-500 text-red-300',
    warning: 'bg-slate-900 border-2 border-amber-500 text-amber-300',
    info: 'bg-slate-900 border-2 border-blue-500 text-blue-300',
  };

  const Icon = icons[toast.type];

  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-lg backdrop-blur-xl shadow-2xl min-w-[300px] max-w-[500px] ${colors[toast.type]}`}
      style={{
        animation: 'slideInRight 0.3s ease-out, fadeIn 0.3s ease-out',
        zIndex: 100000,
        position: 'relative',
        opacity: 1,
        visibility: 'visible',
      }}
    >
      <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" fill="currentColor" />
      <div className="flex-1 text-sm font-medium">
        <p className="whitespace-pre-wrap break-words leading-relaxed">{toast.message}</p>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose(toast.id);
        }}
        className="flex-shrink-0 text-slate-400 hover:text-slate-200 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};

interface ToastContainerProps {
  toasts: Toast[];
  onClose: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onClose }) => {
  if (!toasts || toasts.length === 0) {
    return null;
  }

  return (
    <div 
      className="fixed flex flex-col gap-2 pointer-events-none" 
      style={{ 
        zIndex: 999999,
        position: 'fixed',
        top: '80px',
        right: '16px',
        left: 'auto',
        bottom: 'auto',
      }}
    >
      {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto">
            <ToastItem toast={toast} onClose={onClose} />
          </div>
        ))}
    </div>
  );
};

// Toast 管理 Hook
export const useToast = () => {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const showToast = (
    type: ToastType,
    message: string,
    duration: number = 6000
  ) => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    const newToast: Toast = { id, type, message, duration };
    setToasts((prev) => [...prev, newToast]);
    return id;
  };

  const closeToast = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  const success = (message: string, duration?: number) =>
    showToast('success', message, duration);
  const error = (message: string, duration?: number) =>
    showToast('error', message, duration);
  const warning = (message: string, duration?: number) =>
    showToast('warning', message, duration);
  const info = (message: string, duration?: number) =>
    showToast('info', message, duration);

  return {
    toasts,
    success,
    error,
    warning,
    info,
    closeToast,
  };
};
