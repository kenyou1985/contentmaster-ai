/**
 * 语音库：管理多条参考音色，供「制作配音」时 IndexTTS2 LoadAudio 使用
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
}

export const VoiceLibrary: React.FC<VoiceLibraryProps> = ({ onClose, onVoicesChange }) => {
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

  const pickSelected = (id: string) => {
    setSelectedVoiceId(id);
    setSelectedId(id);
    onVoicesChange?.();
    toast.success('已设为默认配音音色', 2500);
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
          选中音色作为 <span className="text-slate-400">RunningHub</span> 的参考音频：有路径时走 IndexTTS2
          工作流；否则走 TTS 快捷应用并在 node 13/15 填入同一参考文件。均使用媒体生成页填写的 RunningHub API
          Key。首次成功配音会把上传后的路径缓存在该音色上。
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {voices.length === 0 && !showAdd && (
            <p className="text-sm text-slate-500 text-center py-6">暂无音色，请点击下方添加</p>
          )}

          {voices.map((v) => (
            <div
              key={v.id}
              className={`flex items-center gap-2 p-2 rounded-lg border ${
                selectedId === v.id ? 'border-amber-500/60 bg-amber-950/20' : 'border-slate-700 bg-slate-800/40'
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
