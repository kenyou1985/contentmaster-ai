import React, { useState, useEffect } from 'react';
import { Cpu } from 'lucide-react';
import { ApiProvider } from '../types';
import { YUNWU_MODELS, GOOGLE_MODELS, RUNNINGHUB_MODELS } from '../services/geminiService';

interface ModelSelectorProps {
  /** 当前选中的 provider（从父组件传入） */
  provider?: ApiProvider;
}

/**
 * 模型选择器：放在"一键生成爆款"按钮下方。
 * 根据当前 provider 显示对应模型列表，用户选择后存到 localStorage。
 */
export const ModelSelector: React.FC<ModelSelectorProps> = ({ provider }) => {
  const [currentProvider, setCurrentProvider] = useState<ApiProvider>(() => {
    return (localStorage.getItem('GEMINI_PROVIDER') as ApiProvider) || 'yunwu';
  });
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    const key = `GEMINI_${currentProvider === 'google' ? 'GOOGLE' : currentProvider === 'runninghub' ? 'RUNNINGHUB' : 'YUNWU'}_MODEL`;
    return localStorage.getItem(key) || 'default';
  });

  // 同步 provider 变化
  useEffect(() => {
    if (provider) setCurrentProvider(provider);
  }, [provider]);

  const getModelOptions = () => {
    switch (currentProvider) {
      case 'google':    return GOOGLE_MODELS;
      case 'runninghub': return RUNNINGHUB_MODELS;
      default:          return YUNWU_MODELS;
    }
  };

  const handleChange = (modelId: string) => {
    setSelectedModel(modelId);
    const key = `GEMINI_${currentProvider === 'google' ? 'GOOGLE' : currentProvider === 'runninghub' ? 'RUNNINGHUB' : 'YUNWU'}_MODEL`;
    localStorage.setItem(key, modelId);
    // 通知 geminiService 重新初始化
    const storedKey = localStorage.getItem('GEMINI_API_KEY') || '';
    import('../services/geminiService').then(({ initializeGemini }) => {
      initializeGemini(storedKey, { provider: currentProvider });
    });
  };

  const modelOptions = getModelOptions();

  return (
    <div className="mb-4 animate-in fade-in duration-300">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-slate-900/50 border border-slate-700/60 rounded-lg px-4 py-3">
        <div className="flex items-center gap-2 shrink-0">
          <Cpu size={14} className="text-slate-400" />
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            模型
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          <select
            value={selectedModel}
            onChange={(e) => handleChange(e.target.value)}
            className="bg-slate-800 border border-slate-600/80 rounded-md px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/20 cursor-pointer"
          >
            <option value="default">默认（系统自动）</option>
            {modelOptions.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>

          {/* 快捷标签 */}
          {currentProvider === 'yunwu' && (
            <div className="flex flex-wrap gap-1.5 items-center">
              {[
                { id: 'gpt-5.6-luna', label: 'GPT-5.6', color: 'emerald' },
                { id: 'claude-opus-5', label: 'Opus-5', color: 'orange' },
                { id: 'gemini-3.1-pro-preview', label: 'Gemini-3.1', color: 'blue' },
                { id: 'grok-4.3', label: 'Grok-4', color: 'purple' },
              ].map(btn => (
                <button
                  key={btn.id}
                  onClick={() => handleChange(btn.id)}
                  className={`px-2 py-1 rounded text-[11px] border transition-all ${
                    selectedModel === btn.id
                      ? btn.color === 'emerald' ? 'bg-emerald-600 text-white border-emerald-500' :
                        btn.color === 'orange' ? 'bg-orange-600 text-white border-orange-500' :
                        btn.color === 'blue' ? 'bg-blue-600 text-white border-blue-500' :
                        'bg-purple-600 text-white border-purple-500'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                  }`}
                >
                  {btn.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
