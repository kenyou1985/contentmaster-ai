import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * 错误边界组件 - 捕获子组件的渲染错误
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // 输出错误到控制台
    console.error('ErrorBoundary 捕获到错误:', error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="p-6 bg-red-900/20 border border-red-700 rounded-lg">
          <h2 className="text-lg font-semibold text-red-400 mb-2">组件渲染错误</h2>
          <p className="text-sm text-red-300 mb-4">
            频道生成器遇到问题，请刷新页面重试。
          </p>
          <details className="text-xs text-slate-400">
            <summary className="cursor-pointer hover:text-slate-300">
              查看错误详情
            </summary>
            <pre className="mt-2 p-3 bg-slate-900 rounded overflow-auto max-h-60">
              {this.state.error?.toString()}
            </pre>
          </details>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
            className="mt-4 px-4 py-2 bg-red-700 hover:bg-red-600 text-white text-sm rounded transition-colors"
          >
            刷新页面
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
