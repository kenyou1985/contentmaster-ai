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
    id: 'ink_wash',
    label: '水墨风（Ink Wash）',
    promptEn:
      'Chinese ink wash painting: black-gray ink on rice-paper texture, wet brush strokes, generous negative space, expressive xieyi mood.',
  },
  {
    id: 'oil',
    label: '油画（Oil Painting）',
    promptEn:
      'Classical oil painting: thick impasto brushwork, rich saturated pigments, fine-art canvas texture, dramatic chiaroscuro.',
  },
  {
    id: 'watercolor',
    label: '水彩（Watercolor）',
    promptEn:
      'Soft watercolor illustration: transparent washes, gentle bleeding edges, dreamy pastel atmosphere, light paper grain.',
  },
  {
    id: 'cyberpunk',
    label: '赛博朋克（Cyberpunk）',
    promptEn:
      'Cyberpunk neon city: magenta and cyan glow, dark futuristic streets, holographic UI accents, sci-fi cinematic lighting.',
  },
  {
    id: 'steampunk',
    label: '蒸汽朋克（Steampunk）',
    promptEn:
      'Steampunk aesthetic: brass gears, steam pipes, Victorian retro-futurism, warm metal and leather textures.',
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
    label: '极简扁平（Minimal Flat）',
    promptEn:
      'Ultra minimal flat design: simple geometric shapes, solid color blocks, no gradients, modern clean Swiss-style layout.',
  },
  {
    id: 'minimalist',
    label: '极简风格（Minimalist）',
    promptEn:
      'Minimalist flat illustration, clean simple design, tidy composition, generous negative space, low detail, soft low-saturation palette, Morandi tones, unified color scheme, black outlines, simplified geometric shapes, smooth lines, refined premium look, modern internet-style illustration,',
  },
  {
    id: 'mindful_paws',
    label: '治愈心理学(MindfulPaws)',
    promptEn:
      'Minimalist flat illustration, clean simple design, tidy composition, generous negative space, low detail, soft low-saturation palette, Morandi tones, unified color scheme, black outlines, simplified geometric shapes, smooth lines, refined premium look, modern internet-style illustration.',
  },
  {
    id: 'surreal',
    label: '超现实主义（Surrealism）',
    promptEn:
      'Surreal dreamlike collage: impossible juxtaposition, distorted perspective, bold symbolic imagery, high visual impact.',
  },
  {
    id: 'film_retro',
    label: '胶片 / 复古（Film/Retro）',
    promptEn:
      'Analog film / retro photo: visible grain, faded colors, light leaks, vintage filter, nostalgic mood.',
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
