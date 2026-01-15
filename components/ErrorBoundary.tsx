import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#020617] text-slate-100 p-4">
          <div className="max-w-2xl w-full bg-slate-900/50 border border-red-500/50 rounded-xl p-6">
            <h1 className="text-2xl font-bold text-red-400 mb-4">⚠️ 页面加载错误</h1>
            <p className="text-slate-300 mb-4">
              页面加载时发生错误。请尝试：
            </p>
            <ul className="list-disc list-inside text-slate-400 space-y-2 mb-4">
              <li>刷新页面（按 F5 或 Ctrl+R）</li>
              <li>清除浏览器缓存</li>
              <li>检查浏览器控制台（F12）查看详细错误</li>
            </ul>
            {this.state.error && (
              <details className="mt-4">
                <summary className="text-sm text-slate-500 cursor-pointer">错误详情</summary>
                <pre className="mt-2 text-xs text-red-300 bg-slate-950 p-3 rounded overflow-auto">
                  {this.state.error.toString()}
                </pre>
              </details>
            )}
            <button
              onClick={() => window.location.reload()}
              className="mt-4 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
