/**
 * 角色库服务
 * 用于管理角色图片和名字，底层存储：IndexedDB（storageService） + localStorage 兼容层
 */

import { lsGetItem, lsSetItem } from './storageService';

export interface Character {
  id: string;
  type: 'character' | 'scene'; // 类型：角色 或 场景
  name: string; // 名字
  aliases?: string[]; // 别名列表
  /** 图片 URL（可为空：仅名字无图时列表不显示破图） */
  imageUrl: string;
  imageFile?: File; // 原始图片文件（可选，用于上传）
  prompt?: string; // 自定义提示词（用于生成图片）
  description?: string; // 描述信息（用于场景）
  /** 生图风格 id（与 COVER_STYLE_PRESETS / MediaGenerator 一致） */
  imageStyleId?: string;
  createdAt: number; // 创建时间戳
  updatedAt: number; // 更新时间戳
}

const STORAGE_KEY = 'CHARACTER_LIBRARY';

/** 名称以「场景-」「场景：」等开头时视为场景（修正误记在角色块下的条目） */
export function inferSceneTypeFromName(name: string): 'character' | 'scene' {
  const t = (name || '').trim();
  if (/^场景[-：:]/.test(t) || t.startsWith('场景-')) return 'scene';
  return 'character';
}

function normalizeCharacterRecord(c: Character): Character {
  const looks = inferSceneTypeFromName(c.name);
  if (!c.type) {
    return { ...c, type: looks };
  }
  if (looks === 'scene' && c.type === 'character') {
    return { ...c, type: 'scene' };
  }
  return c;
}

/**
 * 获取所有角色（包括角色和场景）
 */
export function getAllCharacters(): Character[] {
  const stored = lsGetItem<Character[]>(STORAGE_KEY, []);
  if (!stored || !stored.length) return [];
  console.debug('[CharacterLibrary] 读取角色库，数量:', stored.length);
  const filtered = stored.filter(char => char.id && char.name);
  console.debug('[CharacterLibrary] 过滤后数量:', filtered.length);
  const normalized = filtered.map(normalizeCharacterRecord);
  const dirty = normalized.some((c, i) => {
    const prev = filtered[i];
    return c.type !== prev.type;
  });
  if (dirty) {
    saveAllCharacters(normalized);
  }
  return normalized;
}

/**
 * 获取所有角色（仅角色类型）
 */
export function getAllCharactersOnly(): Character[] {
  return getAllCharacters().filter(char => char.type === 'character');
}

/**
 * 获取所有场景（仅场景类型）
 */
export function getAllScenes(): Character[] {
  return getAllCharacters().filter(char => char.type === 'scene');
}

/**
 * 保存所有角色
 */
function saveAllCharacters(characters: Character[]): void {
  // 移除不能序列化的字段（如File对象）
  const serializableCharacters = characters.map(char => {
    const { imageFile, ...rest } = char;
    return rest;
  });
  lsSetItem(STORAGE_KEY, serializableCharacters);
}

/**
 * 添加角色或场景
 */
export function addCharacter(character: Omit<Character, 'id' | 'createdAt' | 'updatedAt'>): Character {
  const characters = getAllCharacters();

  // 检查名字是否已存在（不区分大小写）
  const existing = characters.find(
    char => char.name.toLowerCase() === character.name.toLowerCase()
  );
  if (existing) {
    throw new Error(`"${character.name}" 已存在`);
  }

  // 检查别名是否已存在
  if (character.aliases && character.aliases.length > 0) {
    for (const alias of character.aliases) {
      const aliasExists = characters.find(
        char => char.aliases?.some(a => a.toLowerCase() === alias.toLowerCase())
      );
      if (aliasExists) {
        throw new Error(`别名 "${alias}" 已被 "${aliasExists.name}" 使用`);
      }
    }
  }

  const newCharacter: Character = {
    ...character,
    id: `char_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  characters.push(newCharacter);
  saveAllCharacters(characters);

  return newCharacter;
}

/**
 * 更新角色
 */
export function updateCharacter(id: string, updates: Partial<Omit<Character, 'id' | 'createdAt'>>): Character {
  const characters = getAllCharacters();
  const index = characters.findIndex(char => char.id === id);
  
  if (index === -1) {
    throw new Error(`角色 ID "${id}" 不存在`);
  }
  
  // 如果更新名字，检查是否与其他角色冲突
  if (updates.name) {
    const existing = characters.find(
      (char, i) => i !== index && char.name.toLowerCase() === updates.name!.toLowerCase()
    );
    if (existing) {
      throw new Error(`角色 "${updates.name}" 已存在`);
    }
  }
  
  characters[index] = {
    ...characters[index],
    ...updates,
    updatedAt: Date.now(),
  };
  
  saveAllCharacters(characters);
  
  return characters[index];
}

/**
 * 删除角色
 */
export function deleteCharacter(id: string): void {
  const characters = getAllCharacters();
  const filtered = characters.filter(char => char.id !== id);
  
  if (filtered.length === characters.length) {
    throw new Error(`角色 ID "${id}" 不存在`);
  }
  
  saveAllCharacters(filtered);
}

/**
 * 根据ID获取角色
 */
export function getCharacterById(id: string): Character | null {
  const characters = getAllCharacters();
  return characters.find(char => char.id === id) || null;
}

/**
 * 根据名字查找角色（支持别名匹配）
 */
export function findCharacterByName(name: string): Character | null {
  const characters = getAllCharacters();
  const lowerName = name.toLowerCase().trim();
  
  return characters.find(char => {
    // 匹配主名字
    if (char.name.toLowerCase() === lowerName) {
      return true;
    }
    
    // 匹配别名
    if (char.aliases && char.aliases.length > 0) {
      return char.aliases.some(alias => alias.toLowerCase() === lowerName);
    }
    
    return false;
  }) || null;
}

/**
 * 检测提示词中是否包含角色库中的名字
 * 返回匹配的角色列表
 */
export function detectCharactersInPrompt(prompt: string): Character[] {
  const characters = getAllCharacters();
  const matched: Character[] = [];

  console.debug('[CharacterLibrary] detectCharactersInPrompt:', {
    prompt: prompt.slice(0, 100),
    characterCount: characters.length,
  });

  // 将提示词转换为小写以便匹配
  const lowerPrompt = prompt.toLowerCase();

  for (const char of characters) {
    // 检查主名字
    if (lowerPrompt.includes(char.name.toLowerCase())) {
      console.debug('[CharacterLibrary] 匹配成功（主名字）:', char.name);
      matched.push(char);
      continue;
    }

    // 检查别名
    if (char.aliases && char.aliases.length > 0) {
      const hasAlias = char.aliases.some(alias =>
        lowerPrompt.includes(alias.toLowerCase())
      );
      if (hasAlias) {
        console.debug('[CharacterLibrary] 匹配成功（别名）:', char.name, char.aliases);
        matched.push(char);
      }
    }
  }

  console.debug('[CharacterLibrary] detectCharactersInPrompt 结果:', matched.map(c => c.name));
  return matched;
}

/**
 * 多个角色同时命中时，优先选「匹配词更长」的角色（如同时命中「狗」与「伴侣犬」时选伴侣犬），避免短词抢参考图。
 */
export function pickPrimaryCharacterForPrompt(prompt: string, matched: Character[]): Character | null {
  if (matched.length === 0) return null;
  if (matched.length === 1) return matched[0];
  const lower = prompt.toLowerCase();

  const bestTermLength = (char: Character): number => {
    const terms = [char.name, ...(char.aliases || [])]
      .map((t) => String(t).toLowerCase().trim())
      .filter(Boolean);
    let max = 0;
    for (const t of terms) {
      if (lower.includes(t)) max = Math.max(max, t.length);
    }
    return max;
  };

  const firstIndex = (char: Character): number => {
    const terms = [char.name, ...(char.aliases || [])]
      .map((t) => String(t).toLowerCase().trim())
      .filter(Boolean);
    let min = Infinity;
    for (const t of terms) {
      const i = lower.indexOf(t);
      if (i !== -1) min = Math.min(min, i);
    }
    return min === Infinity ? 999999 : min;
  };

  const sorted = [...matched].sort((a, b) => {
    const lenDiff = bestTermLength(b) - bestTermLength(a);
    if (lenDiff !== 0) return lenDiff;
    return firstIndex(a) - firstIndex(b);
  });
  return sorted[0];
}

/**
 * 将图片文件转换为base64 URL
 */
export function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('无法读取图片文件'));
      }
    };
    reader.onerror = () => reject(new Error('读取图片文件失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 将base64 URL转换为Blob URL（用于显示）
 */
export function dataURLToBlobURL(dataURL: string): string {
  try {
    const blob = dataURLToBlob(dataURL);
    return URL.createObjectURL(blob);
  } catch (error) {
    console.error('[CharacterLibrary] 转换Blob URL失败:', error);
    return dataURL; // 如果转换失败，返回原始dataURL
  }
}

/**
 * 将base64 URL转换为Blob对象
 */
function dataURLToBlob(dataURL: string): Blob {
  const arr = dataURL.split(',');
  const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/png';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

/**
 * 验证图片文件
 */
export function validateImageFile(file: File): { valid: boolean; error?: string } {
  // 检查文件类型
  const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
  if (!validTypes.includes(file.type)) {
    return {
      valid: false,
      error: `不支持的图片格式。支持的格式：${validTypes.join(', ')}`
    };
  }
  
  // 检查文件大小（最大10MB）
  const maxSize = 10 * 1024 * 1024; // 10MB
  if (file.size > maxSize) {
    return {
      valid: false,
      error: `图片文件过大。最大支持：${(maxSize / 1024 / 1024).toFixed(0)}MB`
    };
  }
  
  return { valid: true };
}
