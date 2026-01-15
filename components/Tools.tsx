import React, { useState } from 'react';
import { ToolMode, NicheType, ApiProvider } from '../types';
import { NICHES } from '../constants';
import { streamContentGeneration } from '../services/geminiService';
import { FileText, Maximize2, RefreshCw, Scissors, ArrowRight, Copy, ChevronDown } from 'lucide-react';

interface ToolsProps {
  apiKey: string;
  provider: ApiProvider;
}

export const Tools: React.FC<ToolsProps> = ({ apiKey, provider }) => {
  const [mode, setMode] = useState<ToolMode>(ToolMode.REWRITE);
  const [niche, setNiche] = useState<NicheType>(NicheType.TCM_METAPHYSICS); // Niche awareness
  const [inputText, setInputText] = useState('');
  const [outputText, setOutputText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);

  const handleAction = async () => {
    if (!apiKey || !inputText) return;
    setIsGenerating(true);
    setOutputText('');

    const nicheConfig = NICHES[niche];
    let prompt = '';
    
    // Inject Niche Persona into the system instruction, enforce Chinese
    const systemInstruction = `${nicheConfig.systemInstruction}\n你也是一位專業的內容編輯。請務必使用繁體中文輸出。`;

    switch (mode) {
        case ToolMode.REWRITE:
            prompt = `請重寫以下文本。\n風格：模仿 ${nicheConfig.name} 的風格。\n目標：使其更具吸引力、病毒傳播性，並更易於閱讀。保留核心含義但改善流暢度。\n\n原文：\n${inputText}`;
            break;
        case ToolMode.EXPAND:
            prompt = `請將以下文本擴寫為更深度、更詳細的解釋。\n語境：使用 ${nicheConfig.name} 的知識。\n目標：添加例子、類比和邏輯推理，使其長度至少增加 2 倍。\n\n原文：\n${inputText}`;
            break;
        case ToolMode.SUMMARIZE:
            prompt = `請將以下文本總結為 3 個關鍵要點，有力且令人難忘。\n目標受眾：${nicheConfig.name} 愛好者。\n\n原文：\n${inputText}`;
            break;
        case ToolMode.POLISH:
            prompt = `請潤色以下文本。修正語法，提升詞彙（使用更強有力的動詞），使其在 ${nicheConfig.name} 領域聽起來專業且權威。\n\n原文：\n${inputText}`;
            break;
    }

    try {
        const { initializeGemini } = await import('../services/geminiService');
        initializeGemini(apiKey, { provider });
        await streamContentGeneration(prompt, systemInstruction, (chunk) => {
            setOutputText(prev => prev + chunk);
        });
    } catch (e) {
        setOutputText("生成內容時發生錯誤。請檢查 API Key。");
    } finally {
        setIsGenerating(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(outputText);
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
       
       {/* Settings Bar */}
       <div className="flex flex-col md:flex-row gap-4 justify-between items-center bg-slate-800/50 p-4 rounded-xl border border-slate-800">
           <div className="flex gap-2 overflow-x-auto pb-2 md:pb-0 w-full md:w-auto">
                {/* Tool Modes */}
                {[
                    { id: ToolMode.REWRITE, label: '改寫/洗稿', icon: <RefreshCw size={16} /> },
                    { id: ToolMode.EXPAND, label: '深度擴寫', icon: <Maximize2 size={16} /> },
                    { id: ToolMode.SUMMARIZE, label: '摘要總結', icon: <Scissors size={16} /> },
                    { id: ToolMode.POLISH, label: '潤色優化', icon: <FileText size={16} /> },
                ].map((tool) => (
                    <button
                        key={tool.id}
                        onClick={() => setMode(tool.id as ToolMode)}
                        className={`px-4 py-2 rounded-lg border flex items-center gap-2 transition-all whitespace-nowrap text-sm font-medium ${
                            mode === tool.id 
                            ? 'bg-indigo-600 text-white border-indigo-500 shadow-md' 
                            : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
                        }`}
                    >
                        {tool.icon}
                        <span>{tool.label}</span>
                    </button>
                ))}
           </div>

           {/* Niche Context Selector */}
           <div className="relative group min-w-[200px]">
               <label className="text-[10px] uppercase font-bold text-slate-500 mb-1 ml-1 tracking-wider">語氣 / 賽道</label>
               <select 
                    value={niche} 
                    onChange={(e) => setNiche(e.target.value as NicheType)}
                    className="w-full appearance-none bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
               >
                   {Object.values(NICHES).map(n => (
                       <option key={n.id} value={n.id}>{n.icon} {n.name}</option>
                   ))}
               </select>
               <ChevronDown className="absolute right-3 top-8 text-slate-500 pointer-events-none" size={14} />
           </div>
       </div>

       <div className="grid grid-cols-1 md:grid-cols-2 gap-6 h-[600px]">
            {/* Input */}
            <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-slate-400">原始文本</label>
                <textarea 
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder="請在此粘貼您的內容..."
                    className="flex-1 bg-slate-800/50 border border-slate-700 rounded-xl p-4 text-slate-200 resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500 leading-relaxed custom-scrollbar"
                />
            </div>

            {/* Output */}
            <div className="flex flex-col gap-2 relative">
                <label className="text-sm font-medium text-slate-400 flex justify-between items-center">
                    <span>生成結果</span>
                    {outputText && (
                        <button onClick={copyToClipboard} className="text-xs flex items-center gap-1 text-indigo-400 hover:text-indigo-300">
                            <Copy size={12} /> 複製
                        </button>
                    )}
                </label>
                <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl p-4 text-slate-200 overflow-y-auto whitespace-pre-wrap leading-relaxed relative custom-scrollbar">
                    {outputText}
                    {isGenerating && <span className="inline-block w-2 h-4 bg-indigo-500 ml-1 animate-pulse" />}
                    {!outputText && !isGenerating && <div className="absolute inset-0 flex items-center justify-center text-slate-600 text-sm">結果將顯示於此</div>}
                </div>

                <div className="absolute top-1/2 -left-3 md:-left-3 transform -translate-y-1/2 z-10 hidden md:block">
                     <button 
                        onClick={handleAction}
                        disabled={isGenerating || !inputText}
                        className="bg-indigo-600 hover:bg-indigo-500 text-white p-3 rounded-full shadow-xl shadow-indigo-900/50 disabled:opacity-50 transition-all hover:scale-110 active:scale-95"
                    >
                        <ArrowRight size={20} />
                    </button>
                </div>
                {/* Mobile FAB */}
                 <button 
                        onClick={handleAction}
                        disabled={isGenerating || !inputText}
                        className="md:hidden absolute bottom-4 right-4 bg-indigo-600 hover:bg-indigo-500 text-white p-4 rounded-full shadow-xl shadow-indigo-900/50 disabled:opacity-50"
                    >
                        <ArrowRight size={24} />
                    </button>
            </div>
       </div>
    </div>
  );
};