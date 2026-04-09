import React from 'react';
import { Settings, Cpu, PenTool, Layout as LayoutIcon, ExternalLink, Zap, Video, ImagePlus } from 'lucide-react';
import { ApiProvider } from '../types';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: 'generate' | 'tools' | 'media' | 'cover';
  setActiveTab: (tab: 'generate' | 'tools' | 'media' | 'cover') => void;
  apiKey: string;
  setApiKey: (key: string) => void;
  provider: ApiProvider;
  setProvider: (provider: ApiProvider) => void;
  runningHubApiKey: string;
  setRunningHubApiKey: (key: string) => void;
}

export const Layout: React.FC<LayoutProps> = ({ 
  children, 
  activeTab, 
  setActiveTab, 
  apiKey, 
  setApiKey,
  provider,
  setProvider,
  runningHubApiKey,
  setRunningHubApiKey,
}) => {
  const [showKeyInput, setShowKeyInput] = React.useState(!apiKey);
  const isYunwuKey = apiKey?.trim().startsWith('sk-');
  const isGoogleKey = apiKey?.trim().startsWith('AIza');
  const isRunningHubKey = provider === 'runninghub';

  return (
    <div className="min-h-screen flex flex-col bg-[#020617] text-slate-100 relative overflow-x-hidden">
      {/* Ambient Background Effects */}
      <div className="fixed inset-0 pointer-events-none z-0">
          <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-900/10 rounded-full blur-[120px]" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-emerald-900/10 rounded-full blur-[120px]" />
      </div>

      {/* Header */}
      <header className="flex-shrink-0 border-b border-slate-800/60 bg-slate-950/70 backdrop-blur-xl sticky top-0 z-50 shadow-sm shadow-black/20">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20">
                <Cpu className="w-5 h-5 text-emerald-400" />
            </div>
            <span className="font-bold text-lg tracking-tight text-slate-100">Content<span className="text-emerald-500">Master</span> AI</span>
          </div>
          
          <div className="flex items-center gap-4">
             {/* Tab Navigation */}
            <nav className="flex flex-wrap gap-1 bg-slate-900/50 p-1 rounded-lg border border-slate-800">
              <button
                onClick={() => setActiveTab('generate')}
                className={`px-3 sm:px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
                  activeTab === 'generate' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center gap-2">
                    <LayoutIcon size={14} />
                    自动生成
                </div>
              </button>
              <button
                onClick={() => setActiveTab('tools')}
                className={`px-3 sm:px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
                  activeTab === 'tools' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center gap-2">
                    <PenTool size={14} />
                    深度洗稿
                </div>
              </button>
              <button
                onClick={() => setActiveTab('media')}
                className={`px-3 sm:px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
                  activeTab === 'media' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center gap-2">
                    <Video size={14} />
                    一键成片
                </div>
              </button>
              <button
                onClick={() => setActiveTab('cover')}
                className={`px-3 sm:px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
                  activeTab === 'cover' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center gap-2">
                    <ImagePlus size={14} />
                    封面设计
                </div>
              </button>
            </nav>

            <button 
                onClick={() => setShowKeyInput(!showKeyInput)}
                className={`p-2 rounded-lg transition-all border ${!apiKey ? 'bg-amber-500/10 border-amber-500/50 text-amber-400 animate-pulse' : 'border-transparent text-slate-400 hover:text-emerald-400 hover:bg-slate-800'}`}
                title="API 設定"
            >
                <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* API Key Modal */}
      {showKeyInput && (
        <div className="bg-gradient-to-r from-amber-950/40 to-slate-950 border-b border-amber-500/20 px-4 py-4 backdrop-blur-md relative z-40 animate-in fade-in slide-in-from-top-2">
          <div className="max-w-7xl mx-auto space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
            
            {/* Provider + API Key */}
            <div className="flex-1 space-y-3">
                <div className="space-y-1">
                    <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider flex items-center gap-1">
                        <Settings size={12} /> API 服务
                    </label>
                    <select
                        value={provider}
                        onChange={(e) => setProvider(e.target.value as ApiProvider)}
                        className="w-full bg-slate-900/50 border border-slate-700/60 rounded-md px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20"
                    >
                        <option value="yunwu">Yunwu.ai（sk- 開頭）</option>
                        <option value="google">Google Gemini（AIza 開頭）</option>
                        <option value="runninghub">RunningHub（開源模型）</option>
                    </select>
                </div>

                <div className="space-y-1">
                    <label className="text-xs text-amber-500/80 font-semibold uppercase tracking-wider flex items-center gap-1">
                        <Settings size={12} /> API Key
                        {isYunwuKey && (
                            <span className="ml-2 bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1 inline-block border border-emerald-500/30">
                               <Zap size={8} fill="currentColor" /> Yunwu AI Auto-Config
                            </span>
                        )}
                        {isGoogleKey && (
                            <span className="ml-2 bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1 inline-block border border-emerald-500/30">
                               <Zap size={8} fill="currentColor" /> Google Gemini Auto-Config
                            </span>
                        )}
                        {isRunningHubKey && (
                            <span className="ml-2 bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1 inline-block border border-blue-500/30">
                               <Zap size={8} fill="currentColor" /> RunningHub 開源模型
                            </span>
                        )}
                    </label>
                    <input 
                        type="password" 
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={
                            provider === 'google' 
                                ? '输入 Google Key (AIza 开头)' 
                                : provider === 'runninghub'
                                ? '输入 RunningHub API Key'
                                : '输入 Yunwu Key (sk- 开头)'
                        }
                        className={`w-full bg-slate-900/50 border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 transition-all ${
                            isYunwuKey 
                            ? 'border-emerald-500/50 focus:border-emerald-500/80 focus:ring-emerald-500/20 text-emerald-100'
                            : isGoogleKey
                                ? 'border-emerald-500/50 focus:border-emerald-500/80 focus:ring-emerald-500/20 text-emerald-100'
                                : isRunningHubKey
                                ? 'border-blue-500/50 focus:border-blue-500/80 focus:ring-blue-500/20 text-blue-100'
                                : 'border-slate-700/60 focus:border-amber-500/50 focus:ring-amber-500/20 text-slate-200'
                        }`}
                    />
                </div>
            </div>

            <div className="flex-1 flex flex-col items-end gap-3 justify-end">
                <div className="text-xs text-slate-500 flex justify-end gap-4 flex-wrap">
                    {provider === 'yunwu' && (
                        <a href="https://yunwu.apifox.cn/" target="_blank" rel="noreferrer" className="text-emerald-400 hover:text-emerald-300 flex items-center gap-1">
                            Yunwu API 文檔 <ExternalLink size={10} />
                        </a>
                    )}
                    {provider === 'google' && (
                        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-emerald-400 hover:text-emerald-300 flex items-center gap-1">
                            獲取官方 Key <ExternalLink size={10} />
                        </a>
                    )}
                    {provider === 'runninghub' && (
                        <a href="https://www.runninghub.cn/runninghub-api-doc-cn/" target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 flex items-center gap-1">
                            RunningHub API 文檔 <ExternalLink size={10} />
                        </a>
                    )}
                </div>
                <button 
                    onClick={() => setShowKeyInput(false)}
                    className="h-[38px] px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md text-sm border border-slate-700 transition-colors whitespace-nowrap"
                >
                    完成
                </button>
            </div>

          </div>

            <div className="space-y-1">
                <label className="text-xs text-blue-400/90 font-semibold uppercase tracking-wider flex items-center gap-1 flex-wrap">
                    <Settings size={12} /> RunningHub API Key
                    <span className="text-slate-500 font-normal normal-case text-[11px]">（一键成片 / 开源图视频，独立保存）</span>
                </label>
                <input
                    type="password"
                    value={runningHubApiKey}
                    onChange={(e) => setRunningHubApiKey(e.target.value)}
                    placeholder="与上方「API 服务」无关，填一次即可用于 RunningHub 图/视频"
                    className="w-full bg-slate-900/50 border border-blue-700/40 rounded-md px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/20"
                />
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 flex-shrink-0 max-w-7xl w-full mx-auto p-4 md:p-6 lg:p-8 relative z-10">
        {children}
      </main>
    </div>
  );
};
