import React from 'react';
import { Settings, Cpu, PenTool, Layout as LayoutIcon, ExternalLink, Zap } from 'lucide-react';
import { ApiProvider } from '../types';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: 'generate' | 'tools';
  setActiveTab: (tab: 'generate' | 'tools') => void;
  apiKey: string;
  setApiKey: (key: string) => void;
  provider: ApiProvider;
  setProvider: (provider: ApiProvider) => void;
}

export const Layout: React.FC<LayoutProps> = ({ 
  children, 
  activeTab, 
  setActiveTab, 
  apiKey, 
  setApiKey,
  provider,
  setProvider
}) => {
  const [showKeyInput, setShowKeyInput] = React.useState(!apiKey);
  const isYunwuKey = apiKey?.trim().startsWith('sk-');
  const isGoogleKey = apiKey?.trim().startsWith('AIza');

  return (
    <div className="min-h-screen flex flex-col bg-[#020617] text-slate-100 relative overflow-x-hidden">
      {/* Ambient Background Effects */}
      <div className="fixed inset-0 pointer-events-none z-0">
          <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-900/10 rounded-full blur-[120px]" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-emerald-900/10 rounded-full blur-[120px]" />
      </div>

      {/* Header */}
      <header className="border-b border-slate-800/60 bg-slate-950/70 backdrop-blur-xl sticky top-0 z-50 shadow-sm shadow-black/20">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-500/10 p-2 rounded-lg border border-indigo-500/20">
                <Cpu className="w-5 h-5 text-indigo-400" />
            </div>
            <span className="font-bold text-lg tracking-tight text-slate-100">Content<span className="text-indigo-500">Master</span> AI</span>
          </div>
          
          <div className="flex items-center gap-4">
             {/* Tab Navigation */}
            <nav className="flex bg-slate-900/50 p-1 rounded-lg border border-slate-800">
              <button
                onClick={() => setActiveTab('generate')}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
                  activeTab === 'generate' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center gap-2">
                    <LayoutIcon size={14} />
                    自動生成
                </div>
              </button>
              <button
                onClick={() => setActiveTab('tools')}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
                  activeTab === 'tools' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center gap-2">
                    <PenTool size={14} />
                    改寫工具
                </div>
              </button>
            </nav>

            <button 
                onClick={() => setShowKeyInput(!showKeyInput)}
                className={`p-2 rounded-lg transition-all border ${!apiKey ? 'bg-amber-500/10 border-amber-500/50 text-amber-400 animate-pulse' : 'border-transparent text-slate-400 hover:text-indigo-400 hover:bg-slate-800'}`}
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
          <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
            
            {/* Provider + API Key */}
            <div className="flex-1 space-y-3">
                <div className="space-y-1">
                    <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider flex items-center gap-1">
                        <Settings size={12} /> API 服務
                    </label>
                    <select
                        value={provider}
                        onChange={(e) => setProvider(e.target.value as ApiProvider)}
                        className="w-full bg-slate-900/50 border border-slate-700/60 rounded-md px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20"
                    >
                        <option value="yunwu">Yunwu.ai（sk- 開頭）</option>
                        <option value="google">Google Gemini（AIza 開頭）</option>
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
                            <span className="ml-2 bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1 inline-block border border-indigo-500/30">
                               <Zap size={8} fill="currentColor" /> Google Gemini Auto-Config
                            </span>
                        )}
                    </label>
                    <input 
                        type="password" 
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={provider === 'google' ? '輸入 Google Key (AIza 開頭)' : '輸入 Yunwu Key (sk- 開頭)'}
                        className={`w-full bg-slate-900/50 border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 transition-all ${
                            isYunwuKey 
                            ? 'border-emerald-500/50 focus:border-emerald-500/80 focus:ring-emerald-500/20 text-emerald-100'
                            : isGoogleKey
                                ? 'border-indigo-500/50 focus:border-indigo-500/80 focus:ring-indigo-500/20 text-indigo-100'
                                : 'border-slate-700/60 focus:border-amber-500/50 focus:ring-amber-500/20 text-slate-200'
                        }`}
                    />
                </div>
            </div>

            <div className="flex-1 flex flex-col items-end gap-3 justify-end">
                <div className="text-xs text-slate-500 flex justify-end gap-4 flex-wrap">
                    <a href="https://yunwu.apifox.cn/" target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1">
                        Yunwu API 文檔 <ExternalLink size={10} />
                    </a>
                    <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1">
                        獲取官方 Key <ExternalLink size={10} />
                    </a>
                </div>
                <button 
                    onClick={() => setShowKeyInput(false)}
                    className="h-[38px] px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md text-sm border border-slate-700 transition-colors whitespace-nowrap"
                >
                    完成
                </button>
            </div>

          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 lg:p-8 relative z-10">
        {children}
      </main>
      
      {/* Footer */}
      <footer className="border-t border-slate-800/50 py-8 text-center text-slate-500 text-sm relative z-10 bg-slate-950/30">
        <p className="flex items-center justify-center gap-2">
            <span>Powered by Gemini 3</span>
            <span className="w-1 h-1 rounded-full bg-slate-600" />
            <span>2026 Edition (Traditional Chinese)</span>
        </p>
      </footer>
    </div>
  );
};
