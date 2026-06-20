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
    label: '像素复古风（Retro Pixel）',
    promptEn:
      'Retro 8-bit/16-bit pixel art: limited color palette, chunky crisp pixels, pixelated character and props, nostalgic vintage video game aesthetic, storyboard frame composition, no anti-aliasing, dithering and scanline accents.',
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
      '完美构图、杰作、精细手绘线稿和阴影，80年代老日本漫画手绘风格，复古未来主义美学、浪漫主义美学，古早漫画，低保真、高饱和度、高对比度质感，赛璐璐上色，自然噪点、轻微失真与印刷网点效果，复古模糊氛围，极繁复杂手绘线条，手绘漫画粗犷质感，80年代老日本漫画手绘风格。画面中涉及的任何文字部分，必须使用简体中文，禁止出现日文、英文或其他语言文字。',
  },
  {
    id: 'anime_aesthetics',
    label: '美式漫画（American Comics）',
    promptEn:
      '美式漫画风格，用浓重、清晰的黑色轮廓线勾勒人物和场景，线条富有粗细变化，增强画面的立体感与动感；色彩采用平涂与渐变结合的方式，既保留手绘的质感，又通过色彩层次突出画面重点；人物表情和动作极度夸张，强化情绪表达，强调戏剧冲突与个性，同时也借鉴了日式漫画对服饰、场景道具等细节的刻画方式，整体呈现出写实基底上的夸张幽默效果。画面中涉及的任何文字部分，必须使用简体中文，禁止出现英文或其他语言文字。',
  },
  {
    id: 'colored_pencil',
    label: '彩色铅笔手绘（Beatrice Alemagna）',
    promptEn:
      'Hand-drawn with colored pencils: twisted exaggerated lines, clumsy naive texture, childlike brushwork in Beatrice Alemagna style, depicting everyday life scenes, mischievous and irreverent, tension and quirky charm, humorous and sarcastic tone, panoramic composition, monochrome gradient background, full-frame storybook illustration.',
  },
  {
    id: 'ink_line',
    label: '手绘线稿（Ralph Steadman）',
    promptEn:
      'Hand-drawn ink line art, minimal and bold, expressive color-line contours, Ralph Steadman style, a big-eyed little girl subject, chaotic scribbled lines, grotesque and absurd, strong visual impact, rough aggressive brushwork, de-emphasized 3D, bright and lively palette, playful and humorous, masterwork composition, soul of an illustrator, solid purple background, storyboard frame.',
  },
  {
    id: 'wet_plate',
    label: '湿版火棉胶摄影（Wet Plate Collodion）',
    promptEn:
      'Wet plate collodion photography, 19th-century classical silver halide process, fine silver grain texture, natural edge vignetting, subtle scratches and patina, soft tones with high contrast, dreamy softened highlights, rich deep shadow gradation, cinematic quiet weight of time, shallow depth of field, storyboard frame.',
  },
  {
    id: 'technicolor',
    label: '特艺彩三色染印（3-Strip Technicolor）',
    promptEn:
      '3-strip Technicolor film, dye transfer print process, rich saturated but tasteful color, clear separation of three primary color layers, subtle edge chromatic misalignment in red/green/blue, naturally saturated transitions, dreamy coarse film grain, 1950s Hollywood golden-age cinema palette, storyboard frame composition.',
  },
  {
    id: 'stylized_3d',
    label: '风格化 3D 动画（Stylized 3D）',
    promptEn:
      'Stylized 3D animation, bold character design with strong silhouette, vibrant saturated colors, cinematic three-point lighting, dynamic storyboard frame composition, exaggerated proportions, Pixar-meets-cel-shaded aesthetic, clean render with subtle texture, dramatic depth and atmosphere.',
  },
  {
    id: 'pixar',
    label: '皮克斯动画风（Pixar）',
    promptEn:
      'Pixar animation style, highly detailed 3D character with subsurface scattering skin, realistic cinematic lighting, expressive emotional performance, rich color grading, cinematic storyboard frame composition, hero shot framing, depth of field, premium 3D render quality.',
  },
  {
    id: 'ghibli',
    label: '吉卜力动画风（Studio Ghibli）',
    promptEn:
      'Studio Ghibli animation style, hand-drawn aesthetic with watercolor softness, warm nostalgic color palette, detailed lush background, whimsical and heartwarming mood, storyboard frame composition, gentle natural lighting, Hayao Miyazaki signature atmosphere, cel animation texture.',
  },
  {
    id: 'digital_paint',
    label: '板绘动画风（Digital Painting）',
    promptEn:
      'Digital painting animation style, textured brushstrokes, vibrant high-saturation color scheme, dynamic composition, cinematic storyboard frame, painterly rendering with visible brushwork, modern animation cel aesthetic, energetic and polished.',
  },
  {
    id: 'minimalist',
    label: '极简风格（Minimalist）',
    promptEn:
      'Minimalist flat illustration, clean simple design, tidy composition, generous negative space, low detail, soft low-saturation palette, Morandi tones, unified color scheme, black outlines, simplified geometric shapes, smooth lines, refined premium look, modern internet-style illustration,',
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
