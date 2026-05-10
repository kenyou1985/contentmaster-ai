/**
 * 语音库：多音色管理，供 IndexTTS2 / RunningHub 配音参考音使用
 * 底层存储：IndexedDB（storageService） + localStorage 兼容层
 */

import { lsGetItem, lsSetItem, lsRemoveItem } from './storageService';

export interface VoiceProfile {
  id: string;
  name: string;
  /** 本地预览用（base64 data URL） */
  audioDataUrl: string;
  /** 上传到 RunningHub 后的路径，如 api/xxx.wav（有则制作配音时优先用，免重复上传） */
  runningHubAudioPath?: string;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'VOICE_LIBRARY';
const SELECTED_ID_KEY = 'VOICE_LIBRARY_SELECTED_ID';

export function getAllVoices(): VoiceProfile[] {
  return lsGetItem<VoiceProfile[]>(STORAGE_KEY, []).filter(
    (v) => v?.id && v?.name && typeof v.audioDataUrl === 'string'
  );
}

function saveVoices(list: VoiceProfile[]): void {
  lsSetItem(STORAGE_KEY, list);
}

export function getSelectedVoiceId(): string | null {
  const id = lsGetItem<string | null>(SELECTED_ID_KEY, null);
  return id && id.trim() ? id.trim() : null;
}

export function setSelectedVoiceId(id: string | null): void {
  if (!id) {
    lsRemoveItem(SELECTED_ID_KEY);
    return;
  }
  lsSetItem(SELECTED_ID_KEY, id);
}

export function getVoiceById(id: string): VoiceProfile | null {
  const list = getAllVoices();
  return list.find((v) => v.id === id) || null;
}

export function getSelectedVoice(): VoiceProfile | null {
  const id = getSelectedVoiceId();
  if (!id) return null;
  return getVoiceById(id);
}

export function addVoice(entry: Omit<VoiceProfile, 'id' | 'createdAt' | 'updatedAt'>): VoiceProfile {
  const list = getAllVoices();
  const dup = list.find((v) => v.name.toLowerCase() === entry.name.toLowerCase().trim());
  if (dup) throw new Error(`音色「${entry.name}」已存在`);

  const voice: VoiceProfile = {
    ...entry,
    name: entry.name.trim(),
    id: `voice_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  list.push(voice);
  saveVoices(list);
  if (!getSelectedVoiceId()) setSelectedVoiceId(voice.id);
  return voice;
}

export function updateVoice(id: string, updates: Partial<Omit<VoiceProfile, 'id' | 'createdAt'>>): VoiceProfile {
  const list = getAllVoices();
  const i = list.findIndex((v) => v.id === id);
  if (i === -1) throw new Error('音色不存在');

  if (updates.name) {
    const conflict = list.find(
      (v, j) => j !== i && v.name.toLowerCase() === updates.name!.toLowerCase().trim()
    );
    if (conflict) throw new Error(`音色「${updates.name}」已存在`);
  }

  list[i] = {
    ...list[i],
    ...updates,
    updatedAt: Date.now(),
  };
  saveVoices(list);
  return list[i];
}

export function deleteVoice(id: string): void {
  const list = getAllVoices();
  const filtered = list.filter((v) => v.id !== id);
  if (filtered.length === list.length) throw new Error('音色不存在');
  saveVoices(filtered);
  if (getSelectedVoiceId() === id) {
    setSelectedVoiceId(filtered[0]?.id ?? null);
  }
}

/** 验证参考音频文件 */
export function validateAudioFile(file: File): { valid: boolean; error?: string } {
  const ok = ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a'];
  const ext = file.name.toLowerCase();
  const byExt = /\.(wav|mp3|m4a)$/i.test(ext);
  if (!ok.includes(file.type) && !byExt) {
    return { valid: false, error: '请上传 wav / mp3 / m4a 格式' };
  }
  const max = 12 * 1024 * 1024;
  if (file.size > max) {
    return { valid: false, error: '文件过大（最大 12MB）' };
  }
  return { valid: true };
}

export function fileToAudioDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      if (typeof r.result === 'string') resolve(r.result);
      else reject(new Error('读取失败'));
    };
    r.onerror = () => reject(new Error('读取失败'));
    r.readAsDataURL(file);
  });
}
