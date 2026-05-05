import React, { useState, useRef, useEffect } from 'react';
import {
  Settings, Cpu, PenTool, Layout as LayoutIcon, ExternalLink, Zap,
  Video, ImagePlus, Rss, Mic, Youtube, User, MoreHorizontal, PlusSquare,
} from 'lucide-react';
import { ApiProvider } from '../types';

type TabId = 'generate' | 'tools' | 'media' | 'dubbing' | 'digitalHuman' | 'cover' | 'monitor' | 'channel';

interface TabConfig {
  id: TabId;
  label: string;
  icon: React.ReactNode;
  color: string;
  activeColor: string;
  showOnBottom: boolean;
}

const TABS: TabConfig[] = [
  { id: 'generate', label: '原创', icon: <LayoutIcon size={18} />, color: 'text-slate-400', activeColor: 'bg-emerald-600 text-white', showOnBottom: true },
  { id: 'tools', label: '洗稿', icon: <PenTool size={18} />, color: 'text-slate-400', activeColor: 'bg-emerald-600 text-white', showOnBottom: true },
  { id: 'media', label: '成片', icon: <Video size={18} />, color: 'text-slate-400', activeColor: 'bg-emerald-600 text-white', showOnBottom: true },
  { id: 'dubbing', label: '配音', icon: <Mic size={18} />, color: 'text-slate-400', activeColor: 'bg-emerald-600 text-white', showOnBottom: true },
  { id: 'digitalHuman', label: '数字人', icon: <User size={18} />, color: 'text-slate-400', activeColor: 'bg-blue-600 text-white', showOnBottom: true },
  { id: 'cover', label: '封面', icon: <ImagePlus size={18} />, color: 'text-slate-400', activeColor: 'bg-emerald-600 text-white', showOnBottom: false },
  { id: 'monitor', label: '监控', icon: <Rss size={18} />, color: 'text-slate-400', activeColor: 'bg-emerald-600 text-white', showOnBottom: false },
  { id: 'channel', label: '频道', icon: <Youtube size={18} />, color: 'text-slate-400', activeColor: 'bg-emerald-600 text-white', showOnBottom: false },
];

const BOTTOM_TABS = TABS.filter(t => t.showOnBottom);
const MORE_TABS = TABS.filter(t => !t.showOnBottom);

interface LayoutProps {
  children: React.ReactNode;
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
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
  const [showKeyInput, setShowKeyInput] = useState(!apiKey);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const isYunwuKey = apiKey?.trim().startsWith('sk-');
  const isGoogleKey = apiKey?.trim().startsWith('AIza');
  const isRunningHubKey = provider === 'runninghub';

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const getTabStyle = (tab: TabConfig, isActive: boolean) => {
    if (isActive) {
      return `${tab.activeColor} shadow-lg shadow-emerald-500/20`;
    }
    return 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60';
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#020617] text-slate-100 relative overflow-x-hidden pb-16 md:pb-0">
      {/* Ambient Background Effects */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-900/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-emerald-900/10 rounded-full blur-[120px]" />
      </div>

      {/* Header - Desktop only */}
      <header className="hidden md:flex flex-shrink-0 border-b border-slate-800/60 bg-slate-950/70 backdrop-blur-xl sticky top-0 z-50 shadow-sm shadow-black/20">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between w-full">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20">
              <Cpu className="w-5 h-5 text-emerald-400" />
            </div>
            <span className="font-bold text-lg tracking-tight text-slate-100">
              Content<span className="text-emerald-500">Master</span> AI
            </span>
          </div>

          <div className="flex items-center gap-3">
            {/* Tab Navigation - desktop */}
            <nav className="flex flex-wrap gap-1 bg-slate-900/50 p-1 rounded-lg border border-slate-800">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 flex items-center gap-2 ${getTabStyle(tab, activeTab === tab.id)}`}
                >
                  {tab.icon}
                  <span className="hidden lg:inline">{tab.label}</span>
                </button>
              ))}
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

      {/* Mobile Header */}
      <header className="md:hidden flex-shrink-0 bg-slate-950/90 backdrop-blur-xl sticky top-0 z-50 border-b border-slate-800/60 px-4 h-14">
        <div className="h-full flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-emerald-500/10 p-1.5 rounded-lg border border-emerald-500/20">
              <Cpu className="w-4 h-4 text-emerald-400" />
            </div>
            <span className="font-bold text-base tracking-tight text-slate-100">
              Content<span className="text-emerald-500">Master</span>
            </span>
          </div>
          <button
            onClick={() => setShowKeyInput(!showKeyInput)}
            className={`p-2 rounded-lg transition-all border ${!apiKey ? 'bg-amber-500/10 border-amber-500/50 text-amber-400 animate-pulse' : 'border-transparent text-slate-400 hover:text-emerald-400'}`}
            title="API 設定"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* API Key Panel */}
      {showKeyInput && (
        <div className="bg-gradient-to-r from-amber-950/40 to-slate-950 border-b border-amber-500/20 px-4 py-4 backdrop-blur-md relative z-40 animate-in fade-in slide-in-from-top-2">
          <div className="max-w-7xl mx-auto space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">

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
                  <label className="text-xs text-amber-500/80 font-semibold uppercase tracking-wider flex items-center gap-1 flex-wrap">
                    <Settings size={12} /> API Key
                    {isYunwuKey && (
                      <span className="ml-2 bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1 border border-emerald-500/30">
                        <Zap size={8} fill="currentColor" /> Yunwu Auto-Config
                      </span>
                    )}
                    {isGoogleKey && (
                      <span className="ml-2 bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1 border border-emerald-500/30">
                        <Zap size={8} fill="currentColor" /> Google Auto-Config
                      </span>
                    )}
                    {isRunningHubKey && (
                      <span className="ml-2 bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1 border border-blue-500/30">
                        <Zap size={8} fill="currentColor" /> RunningHub 开源模型
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
                      isYunwuKey || isGoogleKey
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
      <main className="flex-1 flex-shrink-0 max-w-7xl w-full mx-auto px-3 sm:px-4 md:px-6 lg:px-8 py-4 md:py-6 relative z-10">
        {children}
      </main>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-slate-950/95 backdrop-blur-xl border-t border-slate-800/60 safe-area-pb">
        <div className="flex items-center justify-around h-16 px-1">
          {BOTTOM_TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 rounded-xl transition-all duration-200 min-w-[56px] ${
                  isActive
                    ? `${tab.id === 'digitalHuman' ? 'bg-blue-600/20' : 'bg-emerald-600/20'} text-white`
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <div className={`${isActive ? (tab.id === 'digitalHuman' ? 'text-blue-400' : 'text-emerald-400') : ''}`}>
                  {tab.icon}
                </div>
                <span className={`text-[10px] font-medium leading-none ${isActive ? (tab.id === 'digitalHuman' ? 'text-blue-400' : 'text-emerald-400') : ''}`}>
                  {tab.label}
                </span>
              </button>
            );
          })}

          {/* More button */}
          <div className="relative" ref={moreMenuRef}>
            <button
              onClick={() => setShowMoreMenu(!showMoreMenu)}
              className="flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 rounded-xl transition-all duration-200 min-w-[56px] text-slate-500 hover:text-slate-300"
            >
              <div className={showMoreMenu ? 'text-emerald-400' : ''}>
                <MoreHorizontal size={18} />
              </div>
              <span className="text-[10px] font-medium leading-none">更多</span>
            </button>

            {showMoreMenu && (
              <div className="absolute bottom-full right-0 mb-2 bg-slate-900/95 backdrop-blur-xl border border-slate-700/60 rounded-xl shadow-2xl shadow-black/60 overflow-hidden min-w-[140px]">
                {MORE_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => {
                      setActiveTab(tab.id);
                      setShowMoreMenu(false);
                    }}
                    className={`w-full flex items-center gap-3 px-4 py-3 text-sm transition-colors ${
                      activeTab === tab.id
                        ? 'bg-emerald-600/20 text-emerald-400'
                        : 'text-slate-300 hover:bg-slate-800/60'
                    }`}
                  >
                    <span className={activeTab === tab.id ? 'text-emerald-400' : 'text-slate-400'}>
                      {tab.icon}
                    </span>
                    {tab.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </nav>
    </div>
  );
};
