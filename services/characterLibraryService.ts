/**
 * 角色库服务
 * 用于管理角色图片和名字，支持本地存储
 */

export interface Character {
  id: string;
  name: string; // 角色名字
  aliases?: string[]; // 别名列表
  imageUrl: string; // 角色图片URL（base64或blob URL）
  imageFile?: File; // 原始图片文件（可选，用于上传）
  prompt?: string; // 自定义提示词（用于生成角色图片）
  createdAt: number; // 创建时间戳
  updatedAt: number; // 更新时间戳
}

const STORAGE_KEY = 'CHARACTER_LIBRARY';

/**
 * 获取所有角色
 */
export function getAllCharacters(): Character[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    
    const characters = JSON.parse(stored) as Character[];
    // 过滤掉无效的角色（缺少必要字段）
    return characters.filter(char => char.id && char.name && char.imageUrl);
  } catch (error) {
    console.error('[CharacterLibrary] 读取角色库失败:', error);
    return [];
  }
}

/**
 * 保存所有角色
 */
function saveAllCharacters(characters: Character[]): void {
  try {
    // 移除不能序列化的字段（如File对象）
    const serializableCharacters = characters.map(char => {
      const { imageFile, ...rest } = char;
      return rest;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializableCharacters));
  } catch (error) {
    console.error('[CharacterLibrary] 保存角色库失败:', error);
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new Error('存储空间不足，请删除一些角色或清理浏览器缓存');
    }
    throw new Error('保存角色库失败，可能是存储空间不足');
  }
}

/**
 * 添加角色
 */
export function addCharacter(character: Omit<Character, 'id' | 'createdAt' | 'updatedAt'>): Character {
  const characters = getAllCharacters();
  
  // 检查名字是否已存在
  const existing = characters.find(
    char => char.name.toLowerCase() === character.name.toLowerCase()
  );
  if (existing) {
    throw new Error(`角色 "${character.name}" 已存在`);
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
  
  // 将提示词转换为小写以便匹配
  const lowerPrompt = prompt.toLowerCase();
  
  for (const char of characters) {
    // 检查主名字
    if (lowerPrompt.includes(char.name.toLowerCase())) {
      matched.push(char);
      continue;
    }
    
    // 检查别名
    if (char.aliases && char.aliases.length > 0) {
      const hasAlias = char.aliases.some(alias => 
        lowerPrompt.includes(alias.toLowerCase())
      );
      if (hasAlias) {
        matched.push(char);
      }
    }
  }
  
  return matched;
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
