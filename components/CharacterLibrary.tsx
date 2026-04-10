/**
 * 角色库管理组件
 * 用于管理角色图片和名字
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Upload,
  Edit2,
  Trash2,
  Plus,
  Image as ImageIcon,
  Save,
  Sparkles,
  Loader2,
  Mountain,
  Users,
  Layers,
  CheckSquare,
  Square,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
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
import {
  getAllLoraTemplates,
  addLoraTemplate,
  updateLoraTemplate,
  deleteLoraTemplate,
  type LoraTemplate,
} from '../services/loraTemplateLibraryService';
import { COVER_STYLE_PRESETS, getMediaImageStylePromptEn } from '../services/coverStylePresets';
import { generateJimengImages } from '../services/jimengService';
import { useToast } from './Toast';

/** 列表卡片：无图或加载失败时不显示破图图标 */
function CharacterPreviewBox({
  imageUrl,
  showSelectOverlay,
  onSelect,
}: {
  imageUrl?: string;
  showSelectOverlay?: boolean;
  onSelect?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const url = (imageUrl || '').trim();
  const showImg = url.length > 0 && !failed;

  return (
    <div
      className="relative mb-2 bg-slate-900 rounded border-2 border-slate-700 overflow-hidden"
      style={{ minHeight: '120px', maxHeight: '200px' }}
    >
      {showImg ? (
        <img
          src={url}
          alt=""
          className="w-full h-auto max-h-[200px] object-contain mx-auto block"
          style={{ maxWidth: '100%' }}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="w-full min-h-[120px] max-h-[200px] flex items-center justify-center text-slate-600 text-xs bg-slate-950/50">
          无预览
        </div>
      )}
      {showSelectOverlay && onSelect && (
        <button
          type="button"
          onClick={onSelect}
          className="absolute inset-0 bg-black bg-opacity-0 hover:bg-opacity-40 transition-all flex items-center justify-center text-white text-sm font-medium rounded z-10"
        >
          选择此角色
        </button>
      )}
    </div>
  );
}

/** LoRA 列表小缩略图 */
function LoraTemplateThumb({ imageUrl }: { imageUrl?: string }) {
  const [failed, setFailed] = useState(false);
  const url = (imageUrl || '').trim();
  if (!url || failed) {
    return (
      <div
        className="w-9 h-9 rounded border border-slate-600 bg-slate-800 shrink-0"
        title="无预览图"
      />
    );
  }
  return (
    <img
      src={url}
      alt=""
      className="w-9 h-9 rounded object-cover border border-slate-600 shrink-0"
      onError={() => setFailed(true)}
    />
  );
}

interface CharacterLibraryProps {
  onClose: () => void;
  onCharacterSelect?: (character: CharacterType) => void;
}

type ItemType = 'character' | 'scene';

type ImageFormMode = 'new' | 'edit' | 'lora';

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
  // 风格选择（添加表单）
  const [selectedStyle, setSelectedStyle] = useState('none');
  /** 编辑表单独立风格，避免与添加表单互相覆盖 */
  const [editingStyle, setEditingStyle] = useState('none');
  const [loraTemplates, setLoraTemplates] = useState<LoraTemplate[]>([]);
  /** LoRA 区内「新建模板」草稿（与主添加表单独立） */
  const [showLoraBuilder, setShowLoraBuilder] = useState(false);
  /** 正在二次编辑的模板 id（与新建草稿共用表单） */
  const [editingLoraId, setEditingLoraId] = useState<string | null>(null);
  const [loraDraftType, setLoraDraftType] = useState<ItemType>('character');
  const [loraDraftName, setLoraDraftName] = useState('');
  const [loraDraftAliases, setLoraDraftAliases] = useState('');
  const [loraDraftDescription, setLoraDraftDescription] = useState('');
  const [loraDraftPrompt, setLoraDraftPrompt] = useState('');
  const [loraDraftStyle, setLoraDraftStyle] = useState('none');
  const [loraDraftImagePreview, setLoraDraftImagePreview] = useState('');
  const [loraDraftFile, setLoraDraftFile] = useState<File | null>(null);
  const [loraGenerating, setLoraGenerating] = useState(false);
  const [loraGeneratedImages, setLoraGeneratedImages] = useState<string[]>([]);
  const [loraSelectedImageIndex, setLoraSelectedImageIndex] = useState(0);
  const loraFileInputRef = useRef<HTMLInputElement>(null);
  /** 列表多选（仅 UI，不写库） */
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  /** 编辑表单「从 LoRA 加载」下拉（选后立刻套用并复位） */
  const [editLoraLoadKey, setEditLoraLoadKey] = useState('');
  // 即梦 SESSION_ID（从 localStorage 读取，与 MediaGenerator 共享配置）
  const jimengSessionId = localStorage.getItem('JIMENG_SESSION_ID') || '';
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  // 风格选项（与 MediaGenerator / 封面设计 共用 COVER_STYLE_PRESETS）
  const STYLE_OPTIONS = [
    { id: 'none', label: '无风格（使用原提示词）' },
    ...COVER_STYLE_PRESETS.map((s) => ({ id: s.id, label: s.label })),
  ];

  // 加载角色列表
  useEffect(() => {
    console.log('[CharacterLibrary] 组件挂载，加载角色列表');
    loadCharacters();
  }, []);

  useEffect(() => {
    setLoraTemplates(getAllLoraTemplates());
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
      setGeneratedImages([]);
      setSelectedImageIndex(0);
      toast.success('图片已上传');
    } catch (error: any) {
      toast.error(`读取图片失败: ${error.message || '未知错误'}`);
    }
  };

  // 使用即梦API生成图片（默认使用即梦4.0）
  const handleGenerateImage = async (mode: ImageFormMode) => {
    const basePrompt =
      mode === 'edit'
        ? editingPrompt.trim() || editingDescription.trim()
        : mode === 'lora'
          ? loraDraftPrompt.trim() || loraDraftDescription.trim()
          : newCharacterPrompt.trim() || newCharacterDescription.trim();

    if (!basePrompt.trim()) {
      toast.error('请先填写描述或提示词（提取的描述会作为默认生图提示词）');
      return;
    }

    if (!jimengSessionId) {
      toast.error('请先配置即梦 SESSION_ID（在即梦设置中）');
      return;
    }

    const styleId =
      mode === 'edit' ? editingStyle : mode === 'lora' ? loraDraftStyle : selectedStyle;
    const styleSuffix = getMediaImageStylePromptEn(styleId);
    const finalPrompt = basePrompt.trim() + (styleSuffix ? `, ${styleSuffix}` : '');

    if (mode === 'edit') setGeneratingForEdit(true);
    else if (mode === 'lora') setLoraGenerating(true);
    else setGeneratingImage(true);

    if (mode === 'lora') {
      setLoraGeneratedImages([]);
      setLoraSelectedImageIndex(0);
    } else {
      setGeneratedImages([]);
      setSelectedImageIndex(0);
    }

    try {
      toast.info('正在生成图片，请稍候...', 3000);

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
        const allImages = result.data.map((item) => item.url);
        const firstImage = allImages[0];
        if (mode === 'lora') {
          setLoraGeneratedImages(allImages);
          setLoraDraftImagePreview(firstImage);
          setLoraDraftFile(null);
        } else {
          setGeneratedImages(allImages);
          if (mode === 'edit') setEditingImageUrl(firstImage);
          else setNewCharacterImagePreview(firstImage);
        }
        toast.success(`图片生成成功！共 ${allImages.length} 张，已选中第1张`);
      } else {
        throw new Error(result.error || '图片生成失败');
      }
    } catch (error: any) {
      console.error('[CharacterLibrary] 生成图片失败:', error);
      toast.error(`生成图片失败: ${error.message || '未知错误'}`);
    } finally {
      if (mode === 'edit') setGeneratingForEdit(false);
      else if (mode === 'lora') setLoraGenerating(false);
      else setGeneratingImage(false);
    }
  };

  const handleSelectImage = (imageUrl: string, index: number, mode: ImageFormMode) => {
    if (mode === 'lora') {
      setLoraSelectedImageIndex(index);
      setLoraDraftImagePreview(imageUrl);
      return;
    }
    setSelectedImageIndex(index);
    if (mode === 'edit') setEditingImageUrl(imageUrl);
    else setNewCharacterImagePreview(imageUrl);
  };

  const handleLoraFileSelect = async (file: File) => {
    const validation = validateImageFile(file);
    if (!validation.valid) {
      toast.error(validation.error || '图片文件无效');
      return;
    }
    try {
      const dataURL = await fileToDataURL(file);
      setLoraDraftFile(file);
      setLoraDraftImagePreview(dataURL);
      toast.success('图片已选择');
    } catch (error: any) {
      toast.error(`读取图片失败: ${error.message || '未知错误'}`);
    }
  };

  const resetLoraDraftFields = () => {
    setLoraDraftName('');
    setLoraDraftAliases('');
    setLoraDraftDescription('');
    setLoraDraftPrompt('');
    setLoraDraftStyle('none');
    setLoraDraftImagePreview('');
    setLoraDraftFile(null);
    setLoraGeneratedImages([]);
    setLoraSelectedImageIndex(0);
    if (loraFileInputRef.current) loraFileInputRef.current.value = '';
  };

  const loadLoraTemplateIntoDraft = (t: LoraTemplate) => {
    setEditingLoraId(t.id);
    setShowLoraBuilder(true);
    setLoraDraftType(t.type);
    setLoraDraftName(t.name);
    setLoraDraftAliases(t.aliases?.join(', ') || '');
    setLoraDraftDescription(t.description || '');
    setLoraDraftPrompt(t.prompt || '');
    setLoraDraftStyle(t.imageStyleId && t.imageStyleId !== 'none' ? t.imageStyleId : 'none');
    setLoraDraftImagePreview(t.imageUrl?.trim() || '');
    setLoraDraftFile(null);
    setLoraGeneratedImages([]);
    setLoraSelectedImageIndex(0);
    if (loraFileInputRef.current) loraFileInputRef.current.value = '';
  };

  const saveLoraDraftToLibrary = () => {
    if (!loraDraftName.trim()) {
      toast.error('请输入模板名称');
      return;
    }
    const payload = {
      type: loraDraftType,
      name: loraDraftName.trim(),
      aliases: loraDraftAliases
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      description: loraDraftDescription.trim() || undefined,
      prompt: loraDraftPrompt.trim() || undefined,
      imageStyleId: loraDraftStyle !== 'none' ? loraDraftStyle : undefined,
      imageUrl: loraDraftImagePreview.trim() || undefined,
    };
    try {
      if (editingLoraId) {
        updateLoraTemplate(editingLoraId, payload);
        toast.success('模板已更新');
      } else {
        addLoraTemplate(payload);
        toast.success('已保存到 LoRA 模库');
      }
      refreshLoraTemplates();
      setEditingLoraId(null);
      resetLoraDraftFields();
    } catch (e: any) {
      toast.error(e?.message || '保存失败');
    }
  };

  const clearLoraDraft = () => {
    setEditingLoraId(null);
    resetLoraDraftFields();
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
        imageUrl: newCharacterImagePreview || '',
        imageFile: newCharacterImage || undefined,
        prompt: newCharacterPrompt.trim() || undefined,
        description: newCharacterDescription.trim() || undefined,
        imageStyleId: selectedStyle !== 'none' ? selectedStyle : undefined,
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
    setEditLoraLoadKey('');
    setEditingId(character.id);
    setEditingName(character.name);
    setEditingAliases(character.aliases?.join(', ') || '');
    setEditingImageUrl(character.imageUrl || '');
    setEditingDescription(character.description || '');
    setEditingPrompt(character.prompt || character.description || '');
    setEditingStyle(character.imageStyleId && character.imageStyleId !== 'none' ? character.imageStyleId : 'none');
    setGeneratedImages([]);
    setSelectedImageIndex(0);
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
        imageStyleId: editingStyle !== 'none' ? editingStyle : undefined,
      });

      toast.success(`${itemLabel} "${editingName}" 更新成功`);

      // 重置编辑状态
      setEditLoraLoadKey('');
      setEditingId(null);
      setEditingName('');
      setEditingAliases('');
      setEditingImageUrl('');
      setEditingPrompt('');
      setEditingDescription('');
      setEditingStyle('none');
      setGeneratedImages([]);
      setSelectedImageIndex(0);

      // 重新加载列表
      loadCharacters();
    } catch (error: any) {
      toast.error(error.message || `更新${itemLabel}失败`);
    }
  };

  // 取消编辑
  const handleCancelEdit = () => {
    setEditLoraLoadKey('');
    setEditingId(null);
    setEditingName('');
    setEditingAliases('');
    setEditingImageUrl('');
    setEditingPrompt('');
    setEditingDescription('');
    setEditingStyle('none');
    if (editFileInputRef.current) {
      editFileInputRef.current.value = '';
    }
    setGeneratedImages([]);
    setSelectedImageIndex(0);
  };

  const refreshLoraTemplates = () => setLoraTemplates(getAllLoraTemplates());

  /** 当前筛选下的条目 id（用于多选 / 全选 / 反选） */
  const getFilteredIds = () => {
    const list = filterType === 'all' ? characters : characters.filter((c) => c.type === filterType);
    return list.map((c) => c.id);
  };

  const selectAllFiltered = () => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      getFilteredIds().forEach((id) => next.add(id));
      return next;
    });
  };

  const clearSelectionFiltered = () => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      getFilteredIds().forEach((id) => next.delete(id));
      return next;
    });
  };

  const invertSelectionFiltered = () => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      getFilteredIds().forEach((id) => {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      });
      return next;
    });
  };

  const toggleCardSelected = (id: string) => {
    setSelectedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applyLoraTemplate = (t: LoraTemplate) => {
    if (editingId) {
      const cur = characters.find((c) => c.id === editingId);
      if (cur && cur.type !== t.type) {
        toast.error(`类型不一致：当前编辑为「${cur.type === 'scene' ? '场景' : '角色'}」，模板为「${t.type === 'scene' ? '场景' : '角色'}」`);
        return;
      }
      setEditingName(t.name);
      setEditingAliases(t.aliases?.join(', ') || '');
      setEditingDescription(t.description || '');
      setEditingPrompt(t.prompt || t.description || '');
      setEditingStyle(t.imageStyleId && t.imageStyleId !== 'none' ? t.imageStyleId : 'none');
      if (t.imageUrl?.trim()) setEditingImageUrl(t.imageUrl);
      toast.success('已套用模板到当前编辑');
      return;
    }
    setShowAddForm(true);
    setNewItemType(t.type);
    setNewCharacterName(t.name);
    setNewCharacterAliases(t.aliases?.join(', ') || '');
    setNewCharacterDescription(t.description || '');
    setNewCharacterPrompt(t.prompt || '');
    setSelectedStyle(t.imageStyleId && t.imageStyleId !== 'none' ? t.imageStyleId : 'none');
    if (t.imageUrl?.trim()) {
      setNewCharacterImagePreview(t.imageUrl);
      setNewCharacterImage(null);
    }
    toast.success('已套用模板到「添加」表单');
  };

  const saveFormAsLoraTemplate = () => {
    if (!editingId && !showAddForm) {
      toast.warning('请先打开「添加」或进入「编辑」再保存模板');
      return;
    }
    const defaultName =
      (editingId ? editingName : newCharacterName).trim() || '未命名模板';
    const name = window.prompt('模板名称（将保存当前表单中的角色/场景信息）', defaultName);
    if (!name?.trim()) return;
    const type: ItemType = editingId
      ? characters.find((c) => c.id === editingId)?.type || 'character'
      : newItemType;
    const aliasesStr = editingId ? editingAliases : newCharacterAliases;
    const desc = editingId ? editingDescription : newCharacterDescription;
    const prompt = editingId ? editingPrompt : newCharacterPrompt;
    const style = editingId ? editingStyle : selectedStyle;
    const img = editingId ? editingImageUrl : newCharacterImagePreview;
    try {
      addLoraTemplate({
        type,
        name: name.trim(),
        aliases: aliasesStr
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
        description: desc.trim() || undefined,
        prompt: prompt.trim() || undefined,
        imageStyleId: style !== 'none' ? style : undefined,
        imageUrl: img?.trim() || undefined,
      });
      refreshLoraTemplates();
      toast.success('已保存到 LoRA 模库');
    } catch (e: any) {
      toast.error(e?.message || '保存失败');
    }
  };

  const handleDeleteLoraTemplate = (id: string, label: string) => {
    if (!confirm(`删除模板「${label}」？`)) return;
    deleteLoraTemplate(id);
    if (editingLoraId === id) {
      setEditingLoraId(null);
      resetLoraDraftFields();
    }
    refreshLoraTemplates();
    toast.success('已删除模板');
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
            <span className="mx-1 text-slate-600 self-center">|</span>
            <button
              type="button"
              onClick={selectAllFiltered}
              className="px-2 py-1 rounded text-xs bg-slate-700 text-slate-300 hover:bg-slate-600 flex items-center gap-1"
              title="选中当前筛选列表中的全部"
            >
              <CheckSquare size={12} />
              全选当前
            </button>
            <button
              type="button"
              onClick={clearSelectionFiltered}
              className="px-2 py-1 rounded text-xs bg-slate-700 text-slate-300 hover:bg-slate-600 flex items-center gap-1"
              title="取消当前筛选列表中的选中"
            >
              <Square size={12} />
              取消当前
            </button>
            <button
              type="button"
              onClick={invertSelectionFiltered}
              className="px-2 py-1 rounded text-xs bg-slate-700 text-slate-300 hover:bg-slate-600 flex items-center gap-1"
              title="反选：当前筛选列表中已选变未选，未选变已选"
            >
              <RefreshCw size={12} />
              反选当前
            </button>
            <span className="text-[10px] text-slate-500 self-center ml-1">
              已选 {selectedCardIds.size} 项
            </span>
          </div>

          {/* LoRA 模库 */}
          <div className="mb-4 p-3 rounded-lg border border-amber-500/25 bg-slate-900/50">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 text-amber-200/90">
                <Layers size={16} />
                <span className="text-sm font-medium">LoRA 模库</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowLoraBuilder((v) => !v)}
                  className={`text-[10px] flex items-center gap-0.5 rounded px-2 py-1 transition-all ${
                    showLoraBuilder
                      ? 'text-slate-400 hover:text-amber-200'
                      : 'text-amber-100 bg-amber-500/20 border border-amber-400/55 shadow-[0_0_14px_rgba(251,191,36,0.22)] hover:bg-amber-500/30'
                  }`}
                >
                  {showLoraBuilder ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  {showLoraBuilder ? '收起新建' : '展开新建'}
                </button>
                <button
                  type="button"
                  onClick={refreshLoraTemplates}
                  className="text-[10px] text-slate-500 hover:text-emerald-400"
                >
                  刷新
                </button>
              </div>
            </div>
            <p className="text-[10px] text-slate-500 mb-2">
              提前保存角色/场景文案与风格，一键应用到「添加」或当前「编辑」；大图片模板会占用本地存储，建议以文案为主。
            </p>

            {showLoraBuilder && (
              <div className="mb-3 p-3 rounded-lg border-2 border-amber-500/40 bg-slate-950/40 shadow-[inset_0_0_0_1px_rgba(251,191,36,0.12)] space-y-2">
                {editingLoraId && (
                  <div className="text-[10px] text-amber-200/90 bg-amber-500/10 border border-amber-500/25 rounded px-2 py-1">
                    正在编辑模板「{loraDraftName || '…'}」· 保存后将写回本条
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setLoraDraftType('character')}
                    className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${
                      loraDraftType === 'character'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    <Users size={12} />
                    角色
                  </button>
                  <button
                    type="button"
                    onClick={() => setLoraDraftType('scene')}
                    className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${
                      loraDraftType === 'scene'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    <Mountain size={12} />
                    场景
                  </button>
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500 mb-0.5">
                    {loraDraftType === 'scene' ? '场景' : '角色'}名字 *
                  </label>
                  <input
                    type="text"
                    value={loraDraftName}
                    onChange={(e) => setLoraDraftName(e.target.value)}
                    placeholder={loraDraftType === 'scene' ? '例如：温馨室内空间' : '例如：极简人类'}
                    className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500/50"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500 mb-0.5">别名（逗号分隔）</label>
                  <input
                    type="text"
                    value={loraDraftAliases}
                    onChange={(e) => setLoraDraftAliases(e.target.value)}
                    placeholder="例如：角色1, 人物A"
                    className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500/50"
                  />
                </div>
                {loraDraftType === 'scene' ? (
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">描述（场景说明）</label>
                    <textarea
                      value={loraDraftDescription}
                      onChange={(e) => setLoraDraftDescription(e.target.value)}
                      placeholder="例如：简约治愈的室内环境，米白墙地，柔和光线"
                      rows={2}
                      className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500/50 resize-none"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">描述（可选）</label>
                    <textarea
                      value={loraDraftDescription}
                      onChange={(e) => setLoraDraftDescription(e.target.value)}
                      placeholder="角色设定、外观说明等"
                      rows={2}
                      className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500/50 resize-none"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-[10px] text-slate-500 mb-0.5">风格</label>
                  <select
                    value={loraDraftStyle}
                    onChange={(e) => setLoraDraftStyle(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500/50"
                  >
                    {STYLE_OPTIONS.map((style) => (
                      <option key={style.id} value={style.id}>
                        {style.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500 mb-0.5">
                    提示词（用于生成图片）<span className="text-slate-600">可选</span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={loraDraftPrompt}
                      onChange={(e) => setLoraDraftPrompt(e.target.value)}
                      placeholder="例如：一只可爱的小猫，卡通风格，高清"
                      className="flex-1 min-w-0 px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500/50"
                    />
                    <button
                      type="button"
                      onClick={() => handleGenerateImage('lora')}
                      disabled={loraGenerating}
                      className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded text-xs font-medium flex items-center gap-1 shrink-0"
                    >
                      {loraGenerating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                      生成
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500 mb-0.5">图片（可选）</label>
                  <div className="flex flex-wrap gap-2 items-center">
                    {loraGeneratedImages.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {loraGeneratedImages.map((imgUrl, index) => (
                          <button
                            key={index}
                            type="button"
                            onClick={() => handleSelectImage(imgUrl, index, 'lora')}
                            className={`relative rounded border-2 overflow-hidden ${
                              loraSelectedImageIndex === index
                                ? 'border-amber-400 ring-1 ring-amber-400/50'
                                : 'border-slate-600'
                            }`}
                          >
                            <img src={imgUrl} alt="" className="w-14 h-14 object-cover block" />
                          </button>
                        ))}
                      </div>
                    )}
                    {loraDraftImagePreview &&
                      !loraGeneratedImages.includes(loraDraftImagePreview) && (
                        <div className="relative">
                          <img
                            src={loraDraftImagePreview}
                            alt=""
                            className="w-14 h-14 object-cover rounded border border-slate-600"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              setLoraDraftFile(null);
                              setLoraDraftImagePreview('');
                              if (loraFileInputRef.current) loraFileInputRef.current.value = '';
                            }}
                            className="absolute -top-1 -right-1 bg-red-600 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px]"
                          >
                            ×
                          </button>
                        </div>
                      )}
                    <input
                      ref={loraFileInputRef}
                      type="file"
                      accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleLoraFileSelect(file);
                        e.target.value = '';
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => loraFileInputRef.current?.click()}
                      className="px-2 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-xs flex items-center gap-1 border border-slate-600"
                    >
                      <Upload size={12} />
                      上传图片
                    </button>
                    {!loraDraftImagePreview && loraGeneratedImages.length === 0 && (
                      <span className="text-[10px] text-slate-500">或点「生成」</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={saveLoraDraftToLibrary}
                    className="text-xs px-3 py-1.5 bg-amber-600/25 text-amber-100 border border-amber-500/40 rounded hover:bg-amber-600/35"
                  >
                    {editingLoraId ? '保存修改' : '保存到模库'}
                  </button>
                  <button
                    type="button"
                    onClick={clearLoraDraft}
                    className="text-xs px-3 py-1.5 bg-slate-700 text-slate-300 border border-slate-600 rounded hover:bg-slate-600"
                  >
                    {editingLoraId ? '取消编辑' : '清空草稿'}
                  </button>
                </div>
              </div>
            )}

            {loraTemplates.length === 0 ? (
              <p className="text-xs text-slate-600 mb-2">暂无已存模板。可用上方「新建」或添加/编辑表单后点「保存当前为模板」。</p>
            ) : (
              <div className="flex flex-col gap-1.5 mb-2 max-h-40 overflow-y-auto pr-1">
                {loraTemplates.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded bg-slate-800/90 border border-slate-700 text-[11px]"
                  >
                    <LoraTemplateThumb imageUrl={t.imageUrl} />
                    <span className="text-slate-500 shrink-0">{t.type === 'scene' ? '场景' : '角色'}</span>
                    <span className="text-slate-200 flex-1 min-w-0 truncate" title={t.name}>
                      {t.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => applyLoraTemplate(t)}
                      className="text-emerald-400 hover:text-emerald-300 shrink-0"
                    >
                      应用
                    </button>
                    <button
                      type="button"
                      onClick={() => loadLoraTemplateIntoDraft(t)}
                      className="text-amber-300/90 hover:text-amber-200 shrink-0"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteLoraTemplate(t.id, t.name)}
                      className="text-slate-500 hover:text-red-400 shrink-0"
                    >
                      删
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={saveFormAsLoraTemplate}
              className="text-xs px-3 py-1.5 bg-amber-600/20 text-amber-200 border border-amber-500/35 rounded hover:bg-amber-600/30"
            >
              保存当前为模板
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
                      onClick={() => handleGenerateImage('new')}
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
                            onClick={() => handleSelectImage(imgUrl, index, 'new')}
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
                  {/* 类型标签 + 多选 */}
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                        character.type === 'scene'
                          ? 'bg-blue-500/20 text-blue-300'
                          : 'bg-emerald-500/20 text-emerald-300'
                      }`}
                    >
                      {character.type === 'scene' ? '场景' : '角色'}
                    </span>
                    {editingId !== character.id && (
                      <button
                        type="button"
                        onClick={() => toggleCardSelected(character.id)}
                        className={`p-0.5 rounded border transition-colors ${
                          selectedCardIds.has(character.id)
                            ? 'border-emerald-500 text-emerald-400 bg-emerald-500/10'
                            : 'border-slate-600 text-slate-500 hover:border-slate-500'
                        }`}
                        title={selectedCardIds.has(character.id) ? '取消选中' : '选中'}
                        aria-pressed={selectedCardIds.has(character.id)}
                      >
                        {selectedCardIds.has(character.id) ? (
                          <CheckSquare size={14} />
                        ) : (
                          <Square size={14} />
                        )}
                      </button>
                    )}
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
                      <div>
                        <label className="block text-[10px] text-slate-500 mb-0.5">风格</label>
                        <select
                          value={editingStyle}
                          onChange={(e) => setEditingStyle(e.target.value)}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                        >
                          {STYLE_OPTIONS.map((style) => (
                            <option key={style.id} value={style.id}>
                              {style.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] text-slate-500 mb-0.5">从 LoRA 模库加载</label>
                        <select
                          value={editLoraLoadKey}
                          onChange={(e) => {
                            const id = e.target.value;
                            setEditLoraLoadKey('');
                            if (!id) return;
                            const t = loraTemplates.find((x) => x.id === id);
                            if (t) applyLoraTemplate(t);
                          }}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                        >
                          <option value="">选择模板以填充下方表单…</option>
                          {loraTemplates
                            .filter((t) => t.type === character.type)
                            .map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                        </select>
                      </div>
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
                            onClick={() => handleGenerateImage('edit')}
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
                        {generatedImages.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {generatedImages.map((imgUrl, index) => (
                              <button
                                key={index}
                                type="button"
                                onClick={() => handleSelectImage(imgUrl, index, 'edit')}
                                className={`relative rounded border-2 overflow-hidden ${
                                  selectedImageIndex === index
                                    ? 'border-emerald-500 ring-1 ring-emerald-500/50'
                                    : 'border-slate-600'
                                }`}
                              >
                                <img src={imgUrl} alt="" className="w-12 h-12 object-cover block" />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <CharacterPreviewBox imageUrl={editingImageUrl} />
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
                      <CharacterPreviewBox
                        key={`${character.id}-${character.imageUrl?.slice(0, 32)}`}
                        imageUrl={character.imageUrl}
                        showSelectOverlay={!!onCharacterSelect}
                        onSelect={onCharacterSelect ? () => handleSelectCharacter(character) : undefined}
                      />
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
