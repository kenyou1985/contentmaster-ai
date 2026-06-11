/**
 * 封面设计 / 一键成片 共用的缩略图与配图风格预设（英文写入 prompt，中文为 UI）
 */
export interface CoverStylePreset {
  id: string;
  label: string;
  promptEn: string;
}

export const MEDIA_IMAGE_STYLE_STORAGE_KEY = 'MEDIA_IMAGE_STYLE_ID';

export const COVER_STYLE_PRESETS: CoverStylePreset[] = [
  {
    id: 'realistic',
    label: '写实照片（Realistic）',
    promptEn:
      'Photorealistic YouTube thumbnail look: lifelike, high detail, natural lighting and texture as from a professional camera.',
  },
  {
    id: 'cartoon',
    label: '卡通 / 插画（Cartoon）',
    promptEn:
      'Bold cartoon / flat illustration: clean outlines, vibrant flat colors, cute expressive characters, playful poster feel.',
  },
  {
    id: 'anime',
    label: '动漫 / 二次元（Anime）',
    promptEn:
      'Japanese anime style: large expressive eyes, polished cel shading, bright crisp colors, glossy 2D anime illustration.',
  },
  {
    id: 'chinese_style',
    label: '国潮 / 古风（Chinese Style）',
    promptEn:
      'Modern Chinese guochao / classical mood: hanfu or traditional motifs, red walls and tiles, ink accents, elegant poster layout.',
  },
  {
    id: 'pixel',
    label: '像素风（Pixel Art）',
    promptEn:
      'Retro pixel art: crisp 8-bit/16-bit game aesthetic, limited palette, chunky pixels, nostalgic arcade poster.',
  },
  {
    id: '3d',
    label: '3D 建模（3D Modeling）',
    promptEn:
      '3D rendered look: smooth C4D-style modeling, soft studio lighting, clean materials, strong depth and volume.',
  },
  {
    id: 'minimal_flat',
    label: '二维扁平（Two-dimensional flat）',
    promptEn:
      'Ultra minimal flat design: simple geometric shapes, solid color blocks, no gradients, modern clean Swiss-style layout.',
  },
  {
    id: 'historical_figure',
    label: '日本80年代OVA（Japanese 80s OVA）',
    promptEn:
      '怀旧动画电影胶片质感，手绘巅峰之作，精致线条手绘，色彩饱满浓郁，最高精细度作画，540p粗粝质感，刻意的不清晰感，经典日本80年代OVA画风。画面呈现低保真、高饱和度、低对比度色调，自带复古胶片颗粒与自然噪点，轻微画面失真，叠加印刷网点效果，营造出复古朦胧的视觉氛围与柔焦感。赛博朋克，复古未来。',
  },
  {
    id: 'anime_aesthetics',
    label: '美式漫画（American Comics）',
    promptEn:
      '美式漫画风格，用浓重、清晰的黑色轮廓线勾勒人物和场景，线条富有粗细变化，增强画面的立体感与动感；色彩采用平涂与渐变结合的方式，既保留手绘的质感，又通过色彩层次突出画面重点；人物表情和动作极度夸张，强化情绪表达，强调戏剧冲突与个性，同时也借鉴了日式漫画对服饰、场景道具等细节的刻画方式，整体呈现出写实基底上的夸张幽默效果。',
  },
  {
    id: 'beatrice_alemagna',
    label: 'Beatrice Alemagna 风格',
    promptEn:
      '以彩色铅笔绘制，线条扭曲夸张纹理笨拙笔意，呈现Beatrice Alemagna风格，运用稚拙笔触，描绘出日常生活场景，乖张快意，张力另类，吐槽感，幽默趣味儿，全景，单色渐变背景。',
  },
  {
    id: 'minimalist',
    label: '极简风格（Minimalist）',
    promptEn:
      'Minimalist flat illustration, clean simple design, tidy composition, generous negative space, low detail, soft low-saturation palette, Morandi tones, unified color scheme, black outlines, simplified geometric shapes, smooth lines, refined premium look, modern internet-style illustration,',
  },
  {
    id: 'historical_narrative',
    label: '睡前历史人物（Historical Narrative）',
    promptEn:
      'Historical narrative illustration, storybook aesthetic, warm muted tones, atmospheric lighting, emotional depth, classical meets contemporary style, cinematic composition, soft gradients, gentle palette, elegant and contemplative mood.',
  },
];

/** 媒体生成 / 一键动画分镜 下拉共用（id 与 localStorage 一致） */
export const MEDIA_IMAGE_STYLE_SELECT_OPTIONS: { id: string; label: string }[] = [
  { id: 'none', label: '无风格（使用原提示词）' },
  ...COVER_STYLE_PRESETS.map((s) => ({ id: s.id, label: s.label })),
];

/** 媒体页「风格设置」与一键动画分镜共用：按 id 取英文写入提示词 */
export function getMediaImageStylePromptEn(styleId: string | null | undefined): string {
  if (!styleId || styleId === 'none') return '';
  const preset = COVER_STYLE_PRESETS.find((s) => s.id === styleId);
  return preset?.promptEn?.trim() ?? '';
}
