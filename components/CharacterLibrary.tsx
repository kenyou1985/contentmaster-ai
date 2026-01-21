/**
 * 角色库管理组件
 * 用于管理角色图片和名字
 */

import React, { useState, useEffect, useRef } from 'react';
import { X, Upload, Edit2, Trash2, Plus, Image as ImageIcon, Save, Sparkles, Loader2 } from 'lucide-react';
import {
  getAllCharacters,
  addCharacter,
  updateCharacter,
  deleteCharacter,
  Character,
  fileToDataURL,
  validateImageFile,
  type Character as CharacterType
} from '../services/characterLibraryService';
import { generateJimengImages } from '../services/jimengService';
import { useToast } from './Toast';

interface CharacterLibraryProps {
  onClose: () => void;
  onCharacterSelect?: (character: CharacterType) => void;
  jimengApiBaseUrl?: string; // 即梦API地址
  jimengSessionId?: string; // 即梦SESSION_ID
}

export const CharacterLibrary: React.FC<CharacterLibraryProps> = ({ 
  onClose, 
  onCharacterSelect,
  jimengApiBaseUrl,
  jimengSessionId
}) => {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingAliases, setEditingAliases] = useState('');
  const [editingImageUrl, setEditingImageUrl] = useState('');
  const [editingPrompt, setEditingPrompt] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newCharacterName, setNewCharacterName] = useState('');
  const [newCharacterAliases, setNewCharacterAliases] = useState('');
  const [newCharacterPrompt, setNewCharacterPrompt] = useState('');
  const [newCharacterImage, setNewCharacterImage] = useState<File | null>(null);
  const [newCharacterImagePreview, setNewCharacterImagePreview] = useState<string>('');
  const [generatingImage, setGeneratingImage] = useState(false);
  const [generatingForEdit, setGeneratingForEdit] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  // 从localStorage获取即梦配置（如果props未提供）
  const apiBaseUrl = jimengApiBaseUrl || localStorage.getItem('JIMENG_API_BASE_URL') || 'http://localhost:3030';
  const sessionId = jimengSessionId || localStorage.getItem('JIMENG_SESSION_ID') || '';

  // 加载角色列表
  useEffect(() => {
    loadCharacters();
  }, []);

  const loadCharacters = () => {
    const allCharacters = getAllCharacters();
    setCharacters(allCharacters);
  };

  // 处理文件选择
  const handleFileSelect = async (file: File) => {
    console.log('[CharacterLibrary] 选择文件:', file.name, file.type, file.size);
    
    const validation = validateImageFile(file);
    if (!validation.valid) {
      console.error('[CharacterLibrary] 文件验证失败:', validation.error);
      toast.error(validation.error || '图片文件无效');
      return;
    }

    try {
      console.log('[CharacterLibrary] 开始读取文件...');
      const dataURL = await fileToDataURL(file);
      console.log('[CharacterLibrary] 文件读取成功，dataURL长度:', dataURL.length);
      setNewCharacterImage(file);
      setNewCharacterImagePreview(dataURL);
      toast.success('图片上传成功');
    } catch (error: any) {
      console.error('[CharacterLibrary] 读取图片失败:', error);
      toast.error(`读取图片失败: ${error.message || '未知错误'}`);
    }
  };

  // 使用即梦API生成角色图片
  const handleGenerateImage = async (isEdit: boolean = false) => {
    const prompt = isEdit ? editingPrompt : newCharacterPrompt;
    
    if (!prompt.trim()) {
      toast.error('请输入提示词');
      return;
    }

    if (!sessionId) {
      toast.error('请先配置即梦 SESSION_ID');
      return;
    }

    if (isEdit) {
      setGeneratingForEdit(true);
    } else {
      setGeneratingImage(true);
    }

    try {
      toast.info('正在生成图片，请稍候...', 3000);
      
      const result = await generateJimengImages(
        apiBaseUrl,
        sessionId,
        {
          prompt: prompt.trim(),
          num_images: 1,
          width: 1080,
          height: 1080, // 使用1:1比例生成角色图片
          ratio: '1:1',
          resolution: '2k'
        }
      );

      if (result.success && result.data && result.data.length > 0) {
        const imageUrl = result.data[0].url;
        
        if (isEdit) {
          setEditingImageUrl(imageUrl);
          toast.success('图片生成成功！');
        } else {
          setNewCharacterImagePreview(imageUrl);
          toast.success('图片生成成功！');
        }
      } else {
        throw new Error(result.error || '图片生成失败');
      }
    } catch (error: any) {
      console.error('[CharacterLibrary] 生成图片失败:', error);
      toast.error(`生成图片失败: ${error.message || '未知错误'}`);
    } finally {
      if (isEdit) {
        setGeneratingForEdit(false);
      } else {
        setGeneratingImage(false);
      }
    }
  };

  // 添加角色
  const handleAddCharacter = async () => {
    console.log('[CharacterLibrary] 开始添加角色...');
    console.log('[CharacterLibrary] 名字:', newCharacterName);
    console.log('[CharacterLibrary] 别名:', newCharacterAliases);
    console.log('[CharacterLibrary] 图片预览:', newCharacterImagePreview ? '已设置' : '未设置');
    
    if (!newCharacterName.trim()) {
      toast.error('请输入角色名字');
      return;
    }

    if (!newCharacterImagePreview) {
      toast.error('请上传角色图片');
      return;
    }

    try {
      const aliases = newCharacterAliases
        .split(',')
        .map(a => a.trim())
        .filter(a => a.length > 0);

      console.log('[CharacterLibrary] 调用addCharacter...');
      const newCharacter = addCharacter({
        name: newCharacterName.trim(),
        aliases: aliases.length > 0 ? aliases : undefined,
        imageUrl: newCharacterImagePreview,
        imageFile: newCharacterImage || undefined,
        prompt: newCharacterPrompt.trim() || undefined,
      });
      
      console.log('[CharacterLibrary] 角色添加成功:', newCharacter.id);

      toast.success(`角色 "${newCharacterName}" 添加成功`);
      
      // 重置表单
      setNewCharacterName('');
      setNewCharacterAliases('');
      setNewCharacterPrompt('');
      setNewCharacterImage(null);
      setNewCharacterImagePreview('');
      setShowAddForm(false);
      
      // 重新加载列表
      loadCharacters();
    } catch (error: any) {
      console.error('[CharacterLibrary] 添加角色失败:', error);
      toast.error(error.message || '添加角色失败');
    }
  };

  // 开始编辑
  const handleStartEdit = (character: Character) => {
    setEditingId(character.id);
    setEditingName(character.name);
    setEditingAliases(character.aliases?.join(', ') || '');
    setEditingImageUrl(character.imageUrl);
    setEditingPrompt(character.prompt || '');
  };

  // 保存编辑
  const handleSaveEdit = async () => {
    if (!editingId) return;

    if (!editingName.trim()) {
      toast.error('请输入角色名字');
      return;
    }

    try {
      const aliases = editingAliases
        .split(',')
        .map(a => a.trim())
        .filter(a => a.length > 0);

      await updateCharacter(editingId, {
        name: editingName.trim(),
        aliases: aliases.length > 0 ? aliases : undefined,
        imageUrl: editingImageUrl,
        prompt: editingPrompt.trim() || undefined,
      });

      toast.success(`角色 "${editingName}" 更新成功`);
      
      // 重置编辑状态
      setEditingId(null);
      setEditingName('');
      setEditingAliases('');
      setEditingImageUrl('');
      setEditingPrompt('');
      
      // 重新加载列表
      loadCharacters();
    } catch (error: any) {
      toast.error(error.message || '更新角色失败');
    }
  };

  // 取消编辑
  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingName('');
    setEditingAliases('');
    setEditingImageUrl('');
    setEditingPrompt('');
  };

  // 删除角色
  const handleDeleteCharacter = async (id: string, name: string) => {
    if (!confirm(`确定要删除角色 "${name}" 吗？`)) {
      return;
    }

    try {
      await deleteCharacter(id);
      toast.success(`角色 "${name}" 已删除`);
      loadCharacters();
    } catch (error: any) {
      toast.error(error.message || '删除角色失败');
    }
  };

  // 选择角色
  const handleSelectCharacter = (character: Character) => {
    if (onCharacterSelect) {
      onCharacterSelect(character);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-slate-800 rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col border border-slate-700">
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <h2 className="text-xl font-bold text-slate-100">角色库管理</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-1 text-sm font-medium transition-all"
            >
              <Plus size={16} />
              添加角色
            </button>
            <button
              onClick={onClose}
              className="p-2 hover:bg-slate-700 rounded text-slate-400 hover:text-slate-200 transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto p-4 bg-slate-800/50">
          {/* 添加角色表单 */}
          {showAddForm && (
            <div className="mb-4 p-4 bg-slate-900/50 rounded-lg border border-slate-700">
              <h3 className="font-semibold mb-3 text-slate-100">添加新角色</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1 text-slate-300">角色名字 *</label>
                  <input
                    type="text"
                    value={newCharacterName}
                    onChange={(e) => setNewCharacterName(e.target.value)}
                    placeholder="例如：小明"
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1 text-slate-300">别名（用逗号分隔）</label>
                  <input
                    type="text"
                    value={newCharacterAliases}
                    onChange={(e) => setNewCharacterAliases(e.target.value)}
                    placeholder="例如：小明明, 明哥"
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1 text-slate-300">
                    提示词（用于生成角色图片）
                    <span className="text-xs text-slate-500 ml-1">（可选）</span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newCharacterPrompt}
                      onChange={(e) => setNewCharacterPrompt(e.target.value)}
                      placeholder="例如：一只可爱的小猫，卡通风格，高清"
                      className="flex-1 px-3 py-2 bg-slate-900 border border-slate-700 rounded text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
                    />
                    <button
                      type="button"
                      onClick={() => handleGenerateImage(false)}
                      disabled={generatingImage || !sessionId}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded-lg flex items-center gap-2 text-sm font-medium transition-all"
                      title={!sessionId ? '请先配置即梦 SESSION_ID' : '使用即梦API生成图片'}
                    >
                      {generatingImage ? (
                        <>
                          <Loader2 size={16} className="animate-spin" />
                          生成中
                        </>
                      ) : (
                        <>
                          <Sparkles size={16} />
                          生成
                        </>
                      )}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1 text-slate-300">角色图片 *</label>
                  <div className="flex items-center gap-3">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                      onChange={(e) => {
                        console.log('[CharacterLibrary] 文件选择事件触发');
                        const file = e.target.files?.[0];
                        console.log('[CharacterLibrary] 选择的文件:', file?.name, file?.type, file?.size);
                        if (file) {
                          handleFileSelect(file);
                        } else {
                          console.warn('[CharacterLibrary] 未选择文件');
                        }
                        // 重置input，允许重复选择同一文件
                        if (e.target) {
                          e.target.value = '';
                        }
                      }}
                      style={{ display: 'none' }}
                    />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log('[CharacterLibrary] 点击选择图片按钮, fileInputRef.current:', fileInputRef.current);
                        if (fileInputRef.current) {
                          fileInputRef.current.click();
                        } else {
                          console.error('[CharacterLibrary] fileInputRef.current 为 null');
                          toast.error('文件选择器未初始化，请刷新页面重试');
                        }
                      }}
                      className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg flex items-center gap-2 text-sm font-medium transition-all border border-slate-600"
                    >
                      <Upload size={16} />
                      选择图片
                    </button>
                    {newCharacterImagePreview ? (
                      <div className="relative">
                        <img
                          src={newCharacterImagePreview}
                          alt="预览"
                          className="w-20 h-20 object-cover rounded border-2 border-slate-600"
                          onError={(e) => {
                            console.error('[CharacterLibrary] 图片加载失败');
                            toast.error('图片预览失败，请重新选择图片');
                            setNewCharacterImagePreview('');
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            setNewCharacterImage(null);
                            setNewCharacterImagePreview('');
                            if (fileInputRef.current) {
                              fileInputRef.current.value = '';
                            }
                          }}
                          className="absolute -top-2 -right-2 bg-red-600 hover:bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs transition-colors"
                          title="移除图片"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <span className="text-sm text-slate-500">未选择图片</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleAddCharacter}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-2 text-sm font-medium transition-all"
                  >
                    <Save size={16} />
                    保存
                  </button>
                  <button
                    onClick={() => {
                      setShowAddForm(false);
                      setNewCharacterName('');
                      setNewCharacterAliases('');
                      setNewCharacterPrompt('');
                      setNewCharacterImage(null);
                      setNewCharacterImagePreview('');
                    }}
                    className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg border border-slate-600 text-sm font-medium transition-all"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 角色列表 */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {characters.length === 0 ? (
              <div className="col-span-full text-center py-8 text-slate-500">
                <ImageIcon size={48} className="mx-auto mb-2 opacity-50 text-slate-600" />
                <p className="text-slate-400">暂无角色，点击"添加角色"开始创建</p>
              </div>
            ) : (
              characters.map((character) => (
                <div
                  key={character.id}
                  className="border border-slate-700 rounded-lg p-3 hover:border-slate-600 bg-slate-900/50 transition-all"
                >
                  {editingId === character.id ? (
                    // 编辑模式
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        className="w-full px-2 py-1 bg-slate-900 border border-slate-700 rounded text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
                        placeholder="角色名字"
                      />
                      <input
                        type="text"
                        value={editingAliases}
                        onChange={(e) => setEditingAliases(e.target.value)}
                        className="w-full px-2 py-1 bg-slate-900 border border-slate-700 rounded text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
                        placeholder="别名（用逗号分隔）"
                      />
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={editingPrompt}
                          onChange={(e) => setEditingPrompt(e.target.value)}
                          className="flex-1 px-2 py-1 bg-slate-900 border border-slate-700 rounded text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
                          placeholder="提示词（用于生成图片）"
                        />
                        <button
                          type="button"
                          onClick={() => handleGenerateImage(true)}
                          disabled={generatingForEdit || !sessionId}
                          className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-all flex items-center gap-1"
                          title={!sessionId ? '请先配置即梦 SESSION_ID' : '使用即梦API生成图片'}
                        >
                          {generatingForEdit ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Sparkles size={14} />
                          )}
                        </button>
                      </div>
                      {editingImageUrl && (
                        <div className="relative bg-slate-900 rounded border-2 border-slate-600 overflow-hidden" style={{ minHeight: '120px', maxHeight: '200px' }}>
                          <img
                            src={editingImageUrl}
                            alt="预览"
                            className="w-full h-auto max-h-[200px] object-contain mx-auto block"
                            style={{ maxWidth: '100%' }}
                            onError={(e) => {
                              console.error('[CharacterLibrary] 编辑图片加载失败:', editingImageUrl);
                              const target = e.target as HTMLImageElement;
                              target.style.display = 'none';
                            }}
                          />
                        </div>
                      )}
                      <div className="flex gap-2">
                        <button
                          onClick={handleSaveEdit}
                          className="flex-1 px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-sm font-medium transition-all"
                        >
                          保存
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          className="flex-1 px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-sm font-medium transition-all border border-slate-600"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    // 显示模式
                    <>
                      <div className="relative mb-2 bg-slate-900 rounded border-2 border-slate-700 overflow-hidden" style={{ minHeight: '120px', maxHeight: '200px' }}>
                        <img
                          src={character.imageUrl}
                          alt={character.name}
                          className="w-full h-auto max-h-[200px] object-contain mx-auto block"
                          style={{ maxWidth: '100%' }}
                          onError={(e) => {
                            console.error('[CharacterLibrary] 图片加载失败:', character.imageUrl);
                            const target = e.target as HTMLImageElement;
                            target.style.display = 'none';
                          }}
                        />
                        {onCharacterSelect && (
                          <button
                            onClick={() => handleSelectCharacter(character)}
                            className="absolute inset-0 bg-black bg-opacity-0 hover:bg-opacity-40 transition-all flex items-center justify-center text-white text-sm font-medium rounded z-10"
                          >
                            选择此角色
                          </button>
                        )}
                      </div>
                      <div className="mb-2">
                        <h4 className="font-semibold text-sm text-slate-100">{character.name}</h4>
                        {character.aliases && character.aliases.length > 0 && (
                          <p className="text-xs text-slate-500 mt-1">
                            别名: {character.aliases.join(', ')}
                          </p>
                        )}
                        {character.prompt && (
                          <p className="text-xs text-slate-400 mt-1 italic line-clamp-2" title={character.prompt}>
                            提示词: {character.prompt}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleStartEdit(character)}
                          className="flex-1 px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-sm font-medium flex items-center justify-center gap-1 transition-all border border-slate-600"
                        >
                          <Edit2 size={14} />
                          编辑
                        </button>
                        <button
                          onClick={() => handleDeleteCharacter(character.id, character.name)}
                          className="flex-1 px-2 py-1 bg-slate-700 hover:bg-red-600 text-red-400 hover:text-white rounded text-sm font-medium flex items-center justify-center gap-1 transition-all border border-slate-600 hover:border-red-600"
                        >
                          <Trash2 size={14} />
                          删除
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
