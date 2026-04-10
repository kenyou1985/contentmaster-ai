/**
 * 角色库管理组件
 * 用于管理角色图片和名字
 */

import React, { useState, useEffect, useRef } from 'react';
import { X, Upload, Edit2, Trash2, Plus, Image as ImageIcon, Save, Sparkles, Loader2, Mountain, Users } from 'lucide-react';
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
}

type ItemType = 'character' | 'scene';

export const CharacterLibrary: React.FC<CharacterLibraryProps> = ({
  onClose,
  onCharacterSelect,
}) => {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [filterType, setFilterType] = useState<ItemType | 'all'>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingAliases, setEditingAliases] = useState('');
  const [editingImageUrl, setEditingImageUrl] = useState('');
  const [editingPrompt, setEditingPrompt] = useState('');
  const [editingDescription, setEditingDescription] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newItemType, setNewItemType] = useState<ItemType>('character');
  const [newCharacterName, setNewCharacterName] = useState('');
  const [newCharacterAliases, setNewCharacterAliases] = useState('');
  const [newCharacterPrompt, setNewCharacterPrompt] = useState('');
  const [newCharacterDescription, setNewCharacterDescription] = useState('');
  const [newCharacterImage, setNewCharacterImage] = useState<File | null>(null);
  const [newCharacterImagePreview, setNewCharacterImagePreview] = useState<string>('');
  const [generatingImage, setGeneratingImage] = useState(false);
  const [generatingForEdit, setGeneratingForEdit] = useState(false);
  // 多张生成图片预览
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  // 风格选择
  const [selectedStyle, setSelectedStyle] = useState('none');
  // 即梦 SESSION_ID（从 localStorage 读取，与 MediaGenerator 共享配置）
  const jimengSessionId = localStorage.getItem('JIMENG_SESSION_ID') || '';
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  // 风格选项（与 MediaGenerator 保持一致）
  const STYLE_OPTIONS = [
    { id: 'none', label: '无风格（使用原提示词）' },
    { id: 'realistic', label: '写实照片（Realistic）' },
    { id: 'cartoon', label: '卡通 / 插画（Cartoon）' },
    { id: 'anime', label: '动漫 / 二次元（Anime）' },
    { id: 'chinese', label: '国潮 / 古风（Chinese Style）' },
    { id: 'inkwash', label: '水墨风（Ink Wash）' },
    { id: 'oilpainting', label: '油画（Oil Painting）' },
    { id: 'watercolor', label: '水彩（Watercolor）' },
    { id: 'cyberpunk', label: '赛博朋克（Cyberpunk）' },
    { id: 'steampunk', label: '蒸汽朋克（Steampunk）' },
    { id: 'pixel', label: '像素风（Pixel Art）' },
    { id: '3d', label: '3D 建模（3D Modeling）' },
    { id: 'flat2d', label: '二维扁平（Flat 2D）' },
  ];

  // 风格后缀提示词
  const STYLE_PROMPTS: Record<string, string> = {
    realistic: ', realistic photo style, high quality, 8k',
    cartoon: ', cartoon style, illustration, vibrant colors',
    anime: ', anime style, Japanese animation, high quality',
    chinese: ', Chinese traditional style, Chinese art, ancient style',
    inkwash: ', Chinese ink wash painting style, traditional art',
    oilpainting: ', oil painting style, classical art technique',
    watercolor: ', watercolor painting style, soft colors',
    cyberpunk: ', cyberpunk style, neon lights, futuristic',
    steampunk: ', steampunk style, Victorian era, mechanical',
    pixel: ', pixel art style, retro game graphics',
    '3d': ', 3D render, 3D modeling, CGI',
    flat2d: ', flat 2D illustration, minimalist design',
  };

  // 加载角色列表
  useEffect(() => {
    console.log('[CharacterLibrary] 组件挂载，加载角色列表');
    loadCharacters();
  }, []);

  // 监听 characters 变化
  useEffect(() => {
    console.log('[CharacterLibrary] characters 状态变化:', characters.length, characters.map(c => c.name));
  }, [characters]);

  const loadCharacters = () => {
    console.log('[CharacterLibrary] loadCharacters 被调用');
    const allCharacters = getAllCharacters();
    console.log('[CharacterLibrary] 从存储读取的角色数量:', allCharacters.length);
    console.log('[CharacterLibrary] 当前状态:', { characters: allCharacters });
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

  const handleEditFileSelect = async (file: File) => {
    const validation = validateImageFile(file);
    if (!validation.valid) {
      toast.error(validation.error || '图片文件无效');
      return;
    }
    try {
      const dataURL = await fileToDataURL(file);
      setEditingImageUrl(dataURL);
      toast.success('图片已上传');
    } catch (error: any) {
      toast.error(`读取图片失败: ${error.message || '未知错误'}`);
    }
  };

  // 使用即梦API生成图片（默认使用即梦4.0）
  const handleGenerateImage = async (isEdit: boolean = false) => {
    const basePrompt = isEdit
      ? editingPrompt.trim() || editingDescription.trim()
      : newCharacterPrompt.trim() || newCharacterDescription.trim();

    if (!basePrompt.trim()) {
      toast.error('请先填写描述或提示词（提取的描述会作为默认生图提示词）');
      return;
    }

    // 检查 SESSION_ID 配置
    if (!jimengSessionId) {
      toast.error('请先配置即梦 SESSION_ID（在即梦设置中）');
      return;
    }

    // 应用风格后缀
    const styleSuffix = selectedStyle !== 'none' ? (STYLE_PROMPTS[selectedStyle] || '') : '';
    const finalPrompt = basePrompt.trim() + styleSuffix;

    if (isEdit) {
      setGeneratingForEdit(true);
    } else {
      setGeneratingImage(true);
    }
    // 清空之前的选择
    setGeneratedImages([]);
    setSelectedImageIndex(0);

    try {
      toast.info('正在生成图片，请稍候...', 3000);

      // 生成1张图片
      const result = await generateJimengImages(
        {
          prompt: finalPrompt,
          num_images: 1,
          model: 'jimeng-4.0',
          width: 1080,
          height: 1080,
          ratio: '1:1',
          resolution: '2k',
        },
        { sessionId: jimengSessionId }
      );

      if (result.success && result.data && result.data.length > 0) {
        // 获取所有生成的图片
        const allImages = result.data.map(item => item.url);
        setGeneratedImages(allImages);

        // 默认选中第一张
        const firstImage = allImages[0];
        if (isEdit) {
          setEditingImageUrl(firstImage);
        } else {
          setNewCharacterImagePreview(firstImage);
        }
        toast.success(`图片生成成功！共 ${allImages.length} 张，已选中第1张`);
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

  // 选择图片
  const handleSelectImage = (imageUrl: string, index: number, isEdit: boolean) => {
    setSelectedImageIndex(index);
    if (isEdit) {
      setEditingImageUrl(imageUrl);
    } else {
      setNewCharacterImagePreview(imageUrl);
    }
  };

  // 添加角色或场景
  const handleAddCharacter = async () => {
    console.log('[CharacterLibrary] handleAddCharacter 被调用');
    console.log('[CharacterLibrary] 当前状态 - characters:', characters.length, 'newCharacterName:', newCharacterName, 'newCharacterImagePreview:', newCharacterImagePreview ? '有' : '无');

    const itemLabel = newItemType === 'scene' ? '场景' : '角色';
    console.log(`[CharacterLibrary] 开始添加${itemLabel}...`);
    console.log(`[CharacterLibrary] 类型: ${newItemType}`);
    console.log(`[CharacterLibrary] 名字:`, newCharacterName);
    console.log(`[CharacterLibrary] 别名:`, newCharacterAliases);
    console.log(`[CharacterLibrary] 图片预览:`, newCharacterImagePreview ? '已设置' : '未设置');

    if (!newCharacterName.trim()) {
      toast.error(`请输入${itemLabel}名字`);
      return;
    }

    if (!newCharacterImagePreview) {
      toast.error(`请上传${itemLabel}图片`);
      return;
    }

    try {
      const aliases = newCharacterAliases
        .split(',')
        .map(a => a.trim())
        .filter(a => a.length > 0);

      console.log('[CharacterLibrary] 调用addCharacter...');
      const newItem = addCharacter({
        type: newItemType,
        name: newCharacterName.trim(),
        aliases: aliases.length > 0 ? aliases : undefined,
        imageUrl: newCharacterImagePreview,
        imageFile: newCharacterImage || undefined,
        prompt: newCharacterPrompt.trim() || undefined,
        description: newCharacterDescription.trim() || undefined,
      });

      console.log(`[CharacterLibrary] ${itemLabel}添加成功:`, newItem.id);

      toast.success(`${itemLabel} "${newCharacterName}" 添加成功`);

      // 重置表单
      setNewCharacterName('');
      setNewCharacterAliases('');
      setNewCharacterPrompt('');
      setNewCharacterDescription('');
      setNewCharacterImage(null);
      setNewCharacterImagePreview('');
      setGeneratedImages([]);
      setSelectedImageIndex(0);
      setShowAddForm(false);

      // 重新加载列表
      loadCharacters();
    } catch (error: any) {
      console.error(`[CharacterLibrary] 添加${itemLabel}失败:`, error);
      toast.error(error.message || `添加${itemLabel}失败`);
    }
  };

  // 开始编辑
  const handleStartEdit = (character: Character) => {
    setEditingId(character.id);
    setEditingName(character.name);
    setEditingAliases(character.aliases?.join(', ') || '');
    setEditingImageUrl(character.imageUrl);
    setEditingDescription(character.description || '');
    setEditingPrompt(character.prompt || character.description || '');
  };

  // 保存编辑
  const handleSaveEdit = async () => {
    if (!editingId) return;

    const character = characters.find(c => c.id === editingId);
    const itemLabel = character?.type === 'scene' ? '场景' : '角色';

    if (!editingName.trim()) {
      toast.error(`请输入${itemLabel}名字`);
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
        description: editingDescription.trim() || undefined,
      });

      toast.success(`${itemLabel} "${editingName}" 更新成功`);

      // 重置编辑状态
      setEditingId(null);
      setEditingName('');
      setEditingAliases('');
      setEditingImageUrl('');
      setEditingPrompt('');
      setEditingDescription('');

      // 重新加载列表
      loadCharacters();
    } catch (error: any) {
      toast.error(error.message || `更新${itemLabel}失败`);
    }
  };

  // 取消编辑
  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingName('');
    setEditingAliases('');
    setEditingImageUrl('');
    setEditingPrompt('');
    setEditingDescription('');
    if (editFileInputRef.current) {
      editFileInputRef.current.value = '';
    }
  };

  // 删除角色或场景
  const handleDeleteCharacter = async (id: string, name: string, type?: 'character' | 'scene') => {
    const itemLabel = type === 'scene' ? '场景' : '角色';
    if (!confirm(`确定要删除${itemLabel} "${name}" 吗？`)) {
      return;
    }

    try {
      await deleteCharacter(id);
      toast.success(`${itemLabel} "${name}" 已删除`);
      loadCharacters();
    } catch (error: any) {
      toast.error(error.message || '删除失败');
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
              添加
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
          {/* 类型筛选 */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setFilterType('all')}
              className={`px-3 py-1 rounded text-sm transition-colors ${
                filterType === 'all'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              全部
            </button>
            <button
              onClick={() => setFilterType('character')}
              className={`px-3 py-1 rounded text-sm transition-colors flex items-center gap-1 ${
                filterType === 'character'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              <Users size={14} />
              角色
            </button>
            <button
              onClick={() => setFilterType('scene')}
              className={`px-3 py-1 rounded text-sm transition-colors flex items-center gap-1 ${
                filterType === 'scene'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              <Mountain size={14} />
              场景
            </button>
          </div>

          {/* 添加角色/场景表单 */}
          {showAddForm && (
            <div className="mb-4 p-4 bg-slate-900/50 rounded-lg border border-slate-700">
              <h3 className="font-semibold mb-3 text-slate-100">添加新项目</h3>
              {/* 类型选择 */}
              <div className="flex gap-2 mb-3">
                <button
                  type="button"
                  onClick={() => setNewItemType('character')}
                  className={`px-3 py-1.5 rounded text-sm flex items-center gap-1 transition-colors ${
                    newItemType === 'character'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  <Users size={14} />
                  角色
                </button>
                <button
                  type="button"
                  onClick={() => setNewItemType('scene')}
                  className={`px-3 py-1.5 rounded text-sm flex items-center gap-1 transition-colors ${
                    newItemType === 'scene'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  <Mountain size={14} />
                  场景
                </button>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1 text-slate-300">
                    {newItemType === 'scene' ? '场景' : '角色'}名字 *
                  </label>
                  <input
                    type="text"
                    value={newCharacterName}
                    onChange={(e) => setNewCharacterName(e.target.value)}
                    placeholder={newItemType === 'scene' ? '例如：温馨室内空间' : '例如：小明'}
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1 text-slate-300">别名（用逗号分隔）</label>
                  <input
                    type="text"
                    value={newCharacterAliases}
                    onChange={(e) => setNewCharacterAliases(e.target.value)}
                    placeholder="例如：角色1, 人物A"
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
                  />
                </div>
                {newItemType === 'scene' && (
                  <div>
                    <label className="block text-sm font-medium mb-1 text-slate-300">描述（场景说明）</label>
                    <textarea
                      value={newCharacterDescription}
                      onChange={(e) => setNewCharacterDescription(e.target.value)}
                      placeholder="例如：简约治愈的室内环境，米白墙地，柔和光线"
                      rows={2}
                      className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 resize-none"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium mb-1 text-slate-300">风格</label>
                  <select
                    value={selectedStyle}
                    onChange={(e) => setSelectedStyle(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
                  >
                    {STYLE_OPTIONS.map((style) => (
                      <option key={style.id} value={style.id}>{style.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1 text-slate-300">
                    提示词（用于生成图片）
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
                      disabled={generatingImage}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded-lg flex items-center gap-2 text-sm font-medium transition-all"
                      title="使用即梦线上服务生成图片"
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
                  <label className="block text-sm font-medium mb-1 text-slate-300">
                    图片 *
                    {generatedImages.length > 0 && <span className="text-xs text-emerald-400 ml-1">（已生成{generatedImages.length}张，点击选择）</span>}
                  </label>
                  <div className="flex flex-wrap gap-3">
                    {/* 生成的多张图片预览 */}
                    {generatedImages.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {generatedImages.map((imgUrl, index) => (
                          <div
                            key={index}
                            className={`relative cursor-pointer rounded border-2 transition-all ${
                              selectedImageIndex === index
                                ? 'border-emerald-500 ring-2 ring-emerald-500/50'
                                : 'border-slate-600 hover:border-emerald-400'
                            }`}
                            onClick={() => handleSelectImage(imgUrl, index, false)}
                          >
                            <img
                              src={imgUrl}
                              alt={`生成图片 ${index + 1}`}
                              className="w-20 h-20 object-cover rounded"
                              onError={(e) => {
                                console.error(`[CharacterLibrary] 生成图片${index + 1}加载失败`);
                                (e.target as HTMLImageElement).style.display = 'none';
                              }}
                            />
                            <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[10px] text-center py-0.5 rounded-b">
                              {index + 1}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* 上传的图片预览 */}
                    {newCharacterImagePreview && !generatedImages.includes(newCharacterImagePreview) && (
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
                    )}
                    {/* 上传按钮 */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          handleFileSelect(file);
                        }
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
                        if (fileInputRef.current) {
                          fileInputRef.current.click();
                        } else {
                          toast.error('文件选择器未初始化，请刷新页面重试');
                        }
                      }}
                      className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg flex items-center gap-2 text-sm font-medium transition-all border border-slate-600"
                    >
                      <Upload size={16} />
                      上传图片
                    </button>
                    {!newCharacterImagePreview && generatedImages.length === 0 && (
                      <span className="text-sm text-slate-500">或生成图片</span>
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
                      setNewCharacterDescription('');
                      setNewCharacterImage(null);
                      setNewCharacterImagePreview('');
                      setGeneratedImages([]);
                      setSelectedImageIndex(0);
                    }}
                    className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg border border-slate-600 text-sm font-medium transition-all"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 角色/场景列表 */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {(() => {
              const filtered = filterType === 'all' ? characters : characters.filter(c => c.type === filterType);
              console.log('[CharacterLibrary] 渲染列表 - filterType:', filterType, 'characters:', characters.length, 'filtered:', filtered.length, 'filteredItems:', filtered.map(c => c.name));
              if (filtered.length === 0) {
                return (
                  <div className="col-span-full text-center py-8 text-slate-500">
                    <ImageIcon size={48} className="mx-auto mb-2 opacity-50 text-slate-600" />
                    <p className="text-slate-400">
                      {filterType === 'scene' ? '暂无场景' : filterType === 'character' ? '暂无角色' : '暂无数据，点击"添加"开始创建'}
                    </p>
                  </div>
                );
              }
              const items = filtered.map((character) => {
                console.log('[CharacterLibrary] 渲染角色:', character.name, character.type, character.id);
                return (
                <div
                  key={character.id}
                  className="border border-slate-700 rounded-lg p-3 hover:border-slate-600 bg-slate-900/50 transition-all"
                >
                  {/* 类型标签 */}
                  <div className="flex items-center gap-1 mb-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                      character.type === 'scene'
                        ? 'bg-blue-500/20 text-blue-300'
                        : 'bg-emerald-500/20 text-emerald-300'
                    }`}>
                      {character.type === 'scene' ? '场景' : '角色'}
                    </span>
                  </div>
                  {editingId === character.id ? (
                    // 编辑模式
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        className="w-full px-2 py-1 bg-slate-900 border border-slate-700 rounded text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
                        placeholder={character.type === 'scene' ? '场景名字' : '角色名字'}
                      />
                      <input
                        type="text"
                        value={editingAliases}
                        onChange={(e) => setEditingAliases(e.target.value)}
                        className="w-full px-2 py-1 bg-slate-900 border border-slate-700 rounded text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
                        placeholder="别名（用逗号分隔）"
                      />
                      <textarea
                        value={editingDescription}
                        onChange={(e) => setEditingDescription(e.target.value)}
                        className="w-full px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 resize-none"
                        placeholder={character.type === 'scene' ? '场景描述（提取的「描述」会作为默认生图提示词）' : '描述（可选，提取的「描述」会作为默认生图提示词）'}
                        rows={2}
                      />
                      <div className="space-y-1">
                        <span className="text-[10px] text-slate-500">生图提示词（默认同描述；留空生成时用上方描述）</span>
                        <div className="flex gap-2 flex-wrap">
                          <input
                            type="text"
                            value={editingPrompt}
                            onChange={(e) => setEditingPrompt(e.target.value)}
                            className="flex-1 min-w-[120px] px-2 py-1 bg-slate-900 border border-slate-700 rounded text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
                            placeholder="提示词"
                          />
                          <button
                            type="button"
                            onClick={() => handleGenerateImage(true)}
                            disabled={generatingForEdit}
                            className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-all flex items-center gap-1 shrink-0"
                            title="使用即梦线上服务生成图片"
                          >
                            {generatingForEdit ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Sparkles size={14} />
                            )}
                          </button>
                          <input
                            ref={editFileInputRef}
                            type="file"
                            accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) {
                                void handleEditFileSelect(file);
                              }
                              e.target.value = '';
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => editFileInputRef.current?.click()}
                            className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-sm font-medium transition-all flex items-center gap-1 border border-slate-600 shrink-0"
                            title="从本地上传图片"
                          >
                            <Upload size={14} />
                            上传
                          </button>
                        </div>
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
                        {character.type === 'scene' && character.description && (
                          <p className="text-xs text-slate-400 mt-1 line-clamp-2" title={character.description}>
                            描述: {character.description}
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
                          onClick={() => handleDeleteCharacter(character.id, character.name, character.type)}
                          className="flex-1 px-2 py-1 bg-slate-700 hover:bg-red-600 text-red-400 hover:text-white rounded text-sm font-medium flex items-center justify-center gap-1 transition-all border border-slate-600 hover:border-red-600"
                        >
                          <Trash2 size={14} />
                          删除
                        </button>
                      </div>
                    </>
                  )}
                </div>
                );
              });
              return items;
            })()}
          </div>
        </div>
      </div>
    </div>
  );
};
