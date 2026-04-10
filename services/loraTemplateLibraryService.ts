/**
 * LoRA 模库：本地保存角色/场景信息模板，供角色库一键套用
 * 底层存储：IndexedDB（storageService） + localStorage 兼容层
 */

import { lsGetItem, lsSetItem } from './storageService';

export interface LoraTemplate {
  id: string;
  type: 'character' | 'scene';
  name: string;
  aliases?: string[];
  description?: string;
  prompt?: string;
  /** 与封面/媒体生成一致的风格 id，无则省略 */
  imageStyleId?: string;
  /** 可选参考图（base64 或 URL，体积大时慎用） */
  imageUrl?: string;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'LORA_TEMPLATE_LIBRARY';

function saveAll(templates: LoraTemplate[]): void {
  lsSetItem(STORAGE_KEY, templates);
}

export function getAllLoraTemplates(): LoraTemplate[] {
  const list = lsGetItem<LoraTemplate[]>(STORAGE_KEY, []);
  return Array.isArray(list) ? list.filter((t) => t && t.id && t.name) : [];
}

export function addLoraTemplate(
  data: Omit<LoraTemplate, 'id' | 'createdAt' | 'updatedAt'>
): LoraTemplate {
  const list = getAllLoraTemplates();
  const t: LoraTemplate = {
    ...data,
    id: `lora_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  list.push(t);
  saveAll(list);
  return t;
}

export function updateLoraTemplate(
  id: string,
  updates: Partial<Omit<LoraTemplate, 'id' | 'createdAt'>>
): LoraTemplate {
  const list = getAllLoraTemplates();
  const i = list.findIndex((x) => x.id === id);
  if (i === -1) throw new Error('模板不存在');
  list[i] = { ...list[i], ...updates, updatedAt: Date.now() };
  saveAll(list);
  return list[i];
}

export function deleteLoraTemplate(id: string): void {
  const list = getAllLoraTemplates().filter((x) => x.id !== id);
  saveAll(list);
}
