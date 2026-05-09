/**
 * 语音库：管理多条参考音色；未上传或未选中时使用 RunningHub 侧与 IndexTTS2 一致的系统默认参考音
 */

import React, { useState, useEffect, useRef } from 'react';
import { X, Upload, Trash2, Plus, Mic, Volume2 } from 'lucide-react';
import { useToast } from './Toast';
import {
  getAllVoices,
  addVoice,
  deleteVoice,
  getSelectedVoiceId,
  setSelectedVoiceId,
  validateAudioFile,
  fileToAudioDataURL,
  type VoiceProfile,
} from '../services/voiceLibraryService';

interface VoiceLibraryProps {
  onClose: () => void;
  /** 列表或选中项变化时通知父组件刷新摘要文案 */
  onVoicesChange?: () => void;
  /** 可选：选中语音时触发回调（用于不设置默认语音的情况） */
  onVoiceSelect?: (voice: VoiceProfile | null) => void;
}

export const VoiceLibrary: React.FC<VoiceLibraryProps> = ({ onClose, onVoicesChange, onVoiceSelect }) => {
  const toast = useToast();
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(getSelectedVoiceId());
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    setVoices(getAllVoices());
    setSelectedId(getSelectedVoiceId());
  };

  useEffect(() => {
    load();
  }, []);

  const pickSelected = (id: string | null) => {
    // 先更新本地选中状态，确保 UI 显示正确
    setSelectedId(id);

    // 如果有 onVoiceSelect 回调，只通知父组件，不设置默认
    if (onVoiceSelect) {
      const voice = id ? voices.find(v => v.id === id) || null : null;
      onVoiceSelect(voice);
    } else {
      // 原有的默认语音设置逻辑
      setSelectedVoiceId(id);
      onVoicesChange?.();
      toast.success(id ? '已设为默认配音音色' : '已切换为系统默认音色', 2500);
    }
  };

  const handleFile = async (file: File) => {
    const v = validateAudioFile(file);
    if (!v.valid) {
      toast.error(v.error || '文件无效');
      return;
    }
    if (!newName.trim()) {
      toast.error('请先填写音色名称');
      return;
    }
    try {
      const dataUrl = await fileToAudioDataURL(file);
      addVoice({ name: newName.trim(), audioDataUrl: dataUrl });
      toast.success('音色已添加');
      setNewName('');
      setShowAdd(false);
      load();
      onVoicesChange?.();
    } catch (e: any) {
      toast.error(e?.message || '添加失败');
    }
  };

  const handleDelete = (id: string, name: string) => {
    if (!confirm(`删除音色「${name}」？`)) return;
    try {
      deleteVoice(id);
      load();
      onVoicesChange?.();
      toast.success('已删除');
    } catch (e: any) {
      toast.error(e?.message || '删除失败');
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <div className="flex items-center gap-2 text-slate-100 font-semibold">
            <Mic size={18} className="text-amber-400" />
            语音库
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="关闭"
          >
            <X size={20} />
          </button>
        </div>

        <div className="px-4 py-2 text-[11px] text-slate-500 border-b border-slate-800 leading-relaxed">
          选中音色作为 <span className="text-slate-400">RunningHub</span> 的参考音频。未添加或未选中音色时，一键/单镜配音会使用<strong className="text-slate-400">系统默认参考音</strong>（与
          IndexTTS2 模板内置文件一致），无需强制上传。有自选参考音时走 TTS 并在 node 13/15
          填入；均使用媒体生成页的 RunningHub API Key。首次成功上传会把路径缓存在该音色上。
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          <div
            className={`flex items-center gap-2 p-2 rounded-lg border transition-all ${
              selectedId == null
                ? 'border-emerald-500/80 bg-emerald-950/25 shadow-[0_0_0_1px_rgba(16,185,129,0.3)]'
                : 'border-slate-700 bg-slate-800/40'
            }`}
          >
            <input
              type="radio"
              name="voice-pick"
              checked={selectedId == null}
              onChange={() => pickSelected(null)}
              className="accent-emerald-500"
              title="使用系统默认音色"
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-slate-200 font-medium truncate">不选择（系统默认音色）</div>
              <div className="text-[10px] text-slate-500 truncate">与 IndexTTS2 模板内置参考音一致</div>
            </div>
          </div>

          {voices.length === 0 && !showAdd && (
            <p className="text-sm text-slate-500 text-center py-6">暂无音色，请点击下方添加</p>
          )}

          {voices.map((v) => (
            <div
              key={v.id}
              className={`flex items-center gap-2 p-2 rounded-lg border transition-all ${
                selectedId === v.id
                  ? 'border-amber-500/80 bg-amber-950/25 shadow-[0_0_0_1px_rgba(245,158,11,0.3)]'
                  : 'border-slate-700 bg-slate-800/40'
              }`}
            >
              <input
                type="radio"
                name="voice-pick"
                checked={selectedId === v.id}
                onChange={() => pickSelected(v.id)}
                className="accent-amber-500"
                title="设为默认配音音色"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-slate-200 font-medium truncate">{v.name}</div>
                {v.runningHubAudioPath && (
                  <div className="text-[10px] text-slate-500 truncate">已同步 RunningHub</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  const a = new Audio(v.audioDataUrl);
                  a.play().catch(() => toast.error('无法播放'));
                }}
                className="p-1.5 rounded text-slate-300 hover:bg-slate-700"
                title="试听"
              >
                <Volume2 size={16} />
              </button>
              <button
                type="button"
                onClick={() => handleDelete(v.id, v.name)}
                className="p-1.5 rounded text-red-400 hover:bg-slate-700"
                title="删除"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>

        <div className="border-t border-slate-700 p-4 space-y-3">
          {!showAdd ? (
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium"
            >
              <Plus size={16} />
              添加音色
            </button>
          ) : (
            <div className="space-y-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="音色名称（如：主讲女声）"
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200"
              />
              <input
                ref={fileRef}
                type="file"
                accept=".wav,.mp3,.m4a,audio/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void handleFile(f);
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
              >
                <Upload size={16} />
                选择 wav / mp3 / m4a
              </button>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="w-full py-1.5 text-xs text-slate-500 hover:text-slate-300"
              >
                取消
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
