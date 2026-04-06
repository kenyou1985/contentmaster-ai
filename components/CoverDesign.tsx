import React, { useState, useCallback, useRef, useEffect } from 'react';
import { NicheType, ApiProvider } from '../types';
import { NICHES } from '../constants';
import { streamContentGeneration } from '../services/geminiService';
import { generateImage, COVER_GEMINI_IMAGE_MODEL } from '../services/yunwuService';
import {
  COVER_NICHE_ORDER,
  getCoverNicheProfile,
  getCoverReferenceMultimodalPreamble,
} from '../services/coverDesignProfiles';
import { COVER_STYLE_PRESETS } from '../services/coverStylePresets';
import { useToast } from './Toast';
import { Copy, Check, Loader2, Upload, Sparkles, Image as ImageIcon, X, Download } from 'lucide-react';

const MAX_REFERENCE_IMAGES = 12;

type CoverAspectId = '16:9' | '9:16' | '1:1' | '4:3' | '3:4';

const COVER_ASPECT_OPTIONS: {
  id: CoverAspectId;
  label: string;
  size: string;
  /** Tailwind aspect ratio for preview frame */
  ratioClass: string;
}[] = [
  { id: '16:9', label: '16:9 横屏', size: '1920x1080', ratioClass: 'aspect-video' },
  { id: '9:16', label: '9:16 竖屏', size: '1080x1920', ratioClass: 'aspect-[9/16]' },
  { id: '1:1', label: '1:1 方图', size: '1080x1080', ratioClass: 'aspect-square' },
  { id: '4:3', label: '4:3', size: '1440x1080', ratioClass: 'aspect-[4/3]' },
  { id: '3:4', label: '3:4 竖图', size: '1080x1440', ratioClass: 'aspect-[3/4]' },
];

function newRefId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

interface RefImageItem {
  id: string;
  dataUrl: string;
}

interface CoverDesignProps {
  apiKey: string;
  provider: ApiProvider;
  toast?: ReturnType<typeof useToast>;
}

export interface CoverBundle {
  titles_warning: string;
  titles_anti_truth: string;
  titles_stop_doing: string;
  golden_description: string;
  seo_tags: string;
  visual_emotion_lock: string;
  target_phrase_badge: string;
  /** 2–3 句，SEO/长尾风格，供长句封面分层排版 */
  target_phrase_multi: string;
  var_a: string;
  var_b: string;
  var_c: string;
}

function parseCoverBundle(raw: string): CoverBundle | null {
  const t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : t;
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try {
    const o = JSON.parse(body.slice(s, e + 1)) as Record<string, string>;
    return {
      titles_warning: o.titles_warning || o.warning || '',
      titles_anti_truth: o.titles_anti_truth || o.anti_truth || '',
      titles_stop_doing: o.titles_stop_doing || o.stop_doing || '',
      golden_description: o.golden_description || o.description || '',
      seo_tags: o.seo_tags || o.seo_tags_csv || '',
      visual_emotion_lock: o.visual_emotion_lock || o.emotion_lock || '',
      target_phrase_badge: o.target_phrase_badge || o.badge || '',
      target_phrase_multi:
        o.target_phrase_multi || o.target_phrase_long || o.multi_hook || '',
      var_a: o.var_a_prompt_en || o.var_a || '',
      var_b: o.var_b_prompt_en || o.var_b || '',
      var_c: o.var_c_prompt_en || o.var_c || '',
    };
  } catch {
    return null;
  }
}

function detectTopicLang(text: string): 'en' | 'zh' {
  const zh = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = (text.match(/[a-zA-Z]/g) || []).length;
  if (en > zh * 1.5) return 'en';
  return 'zh';
}

/** 多句靶点拆行（换行优先，否则按句末标点切） */
function splitMultiHookLines(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const byNl = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (byNl.length > 1) return byNl;
  return t
    .split(/(?<=[。！？!?])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 行内色值（避免 Tailwind 扫描不到模板字符串里的 text-* 类） */
const MULTI_HOOK_LINE_HEX = ['#fcd34d', '#7dd3fc', '#f0abfc', '#6ee7b7', '#fdba74'] as const;

/** SEO 标签：展示/复制时去掉逗号、顿号与引号，仅用空格分隔 */
function formatSeoTagsForDisplay(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  return t
    .split(/[，,、;；]+|\s+/u)
    .map((s) =>
      s
        .trim()
        .replace(/^["'"「」『』]/u, '')
        .replace(/["'"「」『』]$/u, '')
        .trim()
    )
    .filter(Boolean)
    .join(' ');
}

async function downloadCoverImage(src: string, filename: string): Promise<void> {
  if (src.startsWith('data:')) {
    const a = document.createElement('a');
    a.href = src;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const res = await fetch(src);
  if (!res.ok) throw new Error('fetch failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const CoverDesign: React.FC<CoverDesignProps> = ({
  apiKey,
  provider,
  toast: externalToast,
}) => {
  const internalToast = useToast();
  const toast = externalToast || internalToast;

  const [niche, setNiche] = useState<NicheType | null>(null);
  const [nicheModalOpen, setNicheModalOpen] = useState(false);
  const [coreTopic, setCoreTopic] = useState('');
  const [refPreviews, setRefPreviews] = useState<RefImageItem[]>([]);
  const [refLocked, setRefLocked] = useState(false);
  const [rawOut, setRawOut] = useState('');
  const [bundle, setBundle] = useState<CoverBundle | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const [schemeUrls, setSchemeUrls] = useState<Record<'A' | 'B' | 'C', string | null>>({
    A: null,
    B: null,
    C: null,
  });
  const [schemeLoading, setSchemeLoading] = useState<Record<'A' | 'B' | 'C', boolean>>({
    A: false,
    B: false,
    C: false,
  });
  const [copied, setCopied] = useState<string | null>(null);
  const [coverAspect, setCoverAspect] = useState<CoverAspectId>('16:9');
  /** 出图时采用一句话或多句极限靶点 */
  const [coverHookSource, setCoverHookSource] = useState<'one' | 'multi'>('one');
  const [coverStyleId, setCoverStyleId] = useState<string>('minimal_flat');

  /** 与 refPreviews 同步，避免在 setState updater 里启动异步（Strict Mode 会双次调用 updater 导致重复追加） */
  const refPreviewsRef = useRef<RefImageItem[]>([]);
  useEffect(() => {
    refPreviewsRef.current = refPreviews;
  }, [refPreviews]);

  const nicheRef = useRef<NicheType | null>(niche);
  useEffect(() => {
    nicheRef.current = niche;
  }, [niche]);

  const canYunwuImage = apiKey.trim().startsWith('sk-');

  const onRefFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const files = input.files;
    if (!files?.length) return;
    const filtered = Array.from(files).filter((f) => f.type.startsWith('image/'));
    input.value = '';
    if (!filtered.length) return;

    const prev = refPreviewsRef.current;
    const room = MAX_REFERENCE_IMAGES - prev.length;
    if (room <= 0) {
      toast.warning(`最多 ${MAX_REFERENCE_IMAGES} 张参考图`);
      return;
    }
    const toRead = filtered.slice(0, room);
    if (filtered.length > room) {
      toast.warning(`本次仅添加 ${room} 张（总数上限 ${MAX_REFERENCE_IMAGES}）`);
    }

    void (async () => {
      try {
        const urls = await Promise.all(
          toRead.map(
            (f) =>
              new Promise<string>((resolve, reject) => {
                const r = new FileReader();
                r.onload = () =>
                  typeof r.result === 'string' ? resolve(r.result) : reject(new Error('read'));
                r.onerror = () => reject(new Error('read'));
                r.readAsDataURL(f);
              })
          )
        );
        setRefPreviews((p) => {
          const remaining = MAX_REFERENCE_IMAGES - p.length;
          if (remaining <= 0) return p;
          const add = urls.slice(0, remaining).map((dataUrl) => ({ id: newRefId(), dataUrl }));
          return [...p, ...add].slice(0, MAX_REFERENCE_IMAGES);
        });
        if (urls.length > 0) {
          setRefLocked(true);
          if (nicheRef.current === null) {
            setNicheModalOpen(true);
          }
        }
      } catch {
        toast.error('读取图片失败');
      }
    })();
  };

  const removeRefById = (id: string) => {
    setRefPreviews((prev) => prev.filter((x) => x.id !== id));
  };

  useEffect(() => {
    if (refPreviews.length === 0) {
      setRefLocked(false);
    }
  }, [refPreviews.length]);

  const clearAllRefs = () => {
    setRefPreviews([]);
    setRefLocked(false);
  };

  const copy = useCallback(
    (key: string, text: string) => {
      if (!text?.trim()) return;
      navigator.clipboard.writeText(text).then(() => {
        setCopied(key);
        toast.success('已复制');
        setTimeout(() => setCopied(null), 2000);
      });
    },
    [toast]
  );

  const buildPrompts = useCallback(() => {
    if (niche === null) {
      return { system: '', user: '' };
    }
    const profile = getCoverNicheProfile(niche);
    const nicheName = NICHES[niche].name;
    const lang = detectTopicLang(coreTopic);
    const aspectOpt =
      COVER_ASPECT_OPTIONS.find((o) => o.id === coverAspect) ?? COVER_ASPECT_OPTIONS[0];

    const langRule =
      lang === 'en'
        ? '文案类字段（titles_*、golden_description、seo_tags、visual_emotion_lock、target_phrase_badge、target_phrase_multi）使用英文。'
        : '文案类字段（titles_*、golden_description、visual_emotion_lock、target_phrase_badge、target_phrase_multi）使用简体中文；seo_tags 见下条单独规则。';

    const seoTagsRule =
      lang === 'en'
        ? 'seo_tags：约 12 个英文主题标签，每个以 # 开头；**标签之间仅用单个空格分隔**，禁止使用逗号、分号或引号包裹；不要输出 "#tag1, #tag2" 这种格式。'
        : 'seo_tags：约 12 个标签，每个以 # 开头，**标签主体必须为中文词语**（可含必要数字）；**标签之间仅用单个空格分隔**，禁止使用英文逗号、中文逗号、顿号或引号「」"" 包裹或分隔；禁止整串英文驼峰式标签（如 #TraditionalChineseMedicine）。';

    const imageTextRule =
      lang === 'en'
        ? '【画面内文字·最高优先级】三条 var_*_prompt_en 用英文撰写（供文生图模型阅读），每条都必须包含明确指令：画面上所有可见文字（主标题、副标、角标、装饰字等）必须为英文，不得出现中文或其它文字（用户原文专有名词除外）。'
        : '【画面内文字·最高优先级】三条 var_*_prompt_en 用英文撰写（供文生图模型阅读），每条都必须包含明确指令：画面上所有可见中文（主标题、副标、角标、印章字、小字等）须为**繁体中文（Traditional Chinese）**字形呈现；语义可与 target_phrase_badge / target_phrase_multi 的简体草稿一致，但字形须繁体；不得出现英文或其它外文（用户明确给出的品牌拉丁缩写除外）。';

    const hookRule =
      '【一句话靶点】须填写 target_phrase_badge（单句极限 Hook）。\n【多句靶点】须填写 target_phrase_multi：共 2–3 句，风格参考本页「SEO 标题库 & 长尾标签库」：信息密度高，可含数字、禁忌/悬念、身份指向、结果承诺、搜索长尾组合；与 target_phrase_badge 同一主题但分层展开，供封面副标题/条带/小字使用。\n【主标题铁律】三条 var_*_prompt_en 须把 target_phrase_badge 的语义做成画面最醒目、最大字号主标题；若构图需要副文案，可融入 target_phrase_multi 中的句子且不矛盾。';

    const aspectRule = `【画幅】界面当前选定的缩略图比例为 **${aspectOpt.label}（${aspectOpt.id}）**。三条 var_* 英文提示词须按该比例描述构图与留白；开头请使用 "YouTube thumbnail, ${aspectOpt.id} aspect ratio"（或等价英文），禁止默认写 16:9，除非当前选择就是 16:9。`;

    const crossNicheBan =
      niche === NicheType.MINDFUL_PSYCHOLOGY
        ? ''
        : '【跨赛道禁令】当前非「治愈心理学」赛道：var_* 中禁止无故加入狗、宠物犬、hound、puppy、canine 等与核心议题及风格 DNA 无关的犬类或「治愈宠物」符号，除非用户「核心议题」原文明确提到宠物/狗且与视频内容一致。画面元素须严格服务于该赛道风格 DNA。';

    const refSystemNote =
      refLocked && refPreviews.length > 0
        ? niche === NicheType.MINDFUL_PSYCHOLOGY
          ? `\n\n⚠️ 参考图已锁定（${refPreviews.length} 张）：var_*_prompt_en 须描述参考图中人物外形（发型、服饰）、若图中有宠物则写清品种与毛色花纹耳朵等、以及画风特征，不得写通用模糊描述。`
          : `\n\n⚠️ 参考图已锁定（${refPreviews.length} 张）：var_*_prompt_en 须忠实描述参考图中实际出现的人物、服饰、道具、场景与画风；禁止编造图中不存在的动物（尤其禁止无故加入狗/宠物），禁止混入其它赛道的代表元素。`
        : '';

    const system = `你是 YouTube 高转化缩略图与标题总监，熟悉 ${nicheName} 赛道视觉包装。
只输出一个 JSON 对象，禁止 Markdown 代码块、禁止前言后记。
JSON 的键必须完全一致（字符串值）：titles_warning, titles_anti_truth, titles_stop_doing, golden_description, seo_tags, visual_emotion_lock, target_phrase_badge, target_phrase_multi, var_a_prompt_en, var_b_prompt_en, var_c_prompt_en。
titles_* 为「60 字内极简标题」风格的三类：THE WARNING / THE ANTI-TRUTH / THE STOP DOING（各一条，${lang === 'en' ? '英文' : '中文'}）。
golden_description 为黄金两行视频简介。${seoTagsRule}
visual_emotion_lock 描述画面情绪弧线。target_phrase_badge 为封面一句话极限靶点（${lang === 'en' ? '英文 Hook 短语' : '中文单句 Hook，可简体'}）。target_phrase_multi 为 2–3 句多句靶点（${lang === 'en' ? '英文' : '中文'}），写法参考爆款 SEO 标题与长尾标签组合。
var_*_prompt_en 每条 80–180 词，用英文撰写（供文生图），须包含：构图、光线、配色、字体排版、点击率元素（箭头/高亮框等）。
${aspectRule}
${hookRule}
${imageTextRule}
${crossNicheBan}${refSystemNote}
${langRule}`;

    const user = `## 赛道：${nicheName}
## 风格 DNA
${profile.styleDna}

## A/B/C 方案方向（写入对应 var 提示词）
- 方案 A（场景沉浸）：${profile.schemeAHint}
- 方案 B（极简底）：${profile.schemeBHint}
- 方案 C（高反差特写）：${profile.schemeCHint}

## 核心议题（视频在讲什么）
${coreTopic || '（未填写，请根据赛道生成占位级示例，并提醒用户补充）'}

## 语言（文案类字段）
${langRule}

请严格输出 JSON。`;

    return { system, user };
  }, [niche, coreTopic, refLocked, refPreviews.length, coverAspect]);

  const runGenerateBundle = async () => {
    if (!apiKey.trim()) {
      toast.error('请先配置 API Key');
      return;
    }
    if (niche === null) {
      toast.error('请先选择赛道');
      return;
    }
    if (provider === 'runninghub') {
      toast.error('封面文案生成需要 Yunwu 或 Google 文本模型，请切换 API 服务');
      return;
    }
    setLoadingText(true);
    setRawOut('');
    setBundle(null);
    const { system, user } = buildPrompts();
    let acc = '';
    const refForJson =
      refLocked && refPreviews.length > 0
        ? refPreviews.map((x) => x.dataUrl)
        : undefined;
    try {
      await streamContentGeneration(
        user,
        system,
        (chunk) => {
          acc += chunk;
          setRawOut(acc);
        },
        undefined,
        {
          temperature: 0.75,
          maxTokens: 8192,
          referenceDataUrls: refForJson,
          referenceMultimodalPreamble: refForJson?.length
            ? getCoverReferenceMultimodalPreamble(niche)
            : undefined,
        }
      );
      const parsed = parseCoverBundle(acc);
      if (parsed) {
        setBundle(parsed);
        toast.success('文案与 A/B/C 指令已生成');
      } else {
        toast.error('无法解析 JSON，请查看原始输出或重试');
      }
    } catch (err: any) {
      toast.error(err?.message || '生成失败');
    } finally {
      setLoadingText(false);
    }
  };

  const runSchemeImage = async (key: 'A' | 'B' | 'C') => {
    if (!canYunwuImage) {
      toast.error('缩略图生成需 Yunwu（sk-）Key，请在设置中配置');
      return;
    }
    const prompt =
      key === 'A' ? bundle?.var_a : key === 'B' ? bundle?.var_b : bundle?.var_c;
    if (!prompt?.trim()) {
      toast.error('请先生成 A/B/C 指令');
      return;
    }
    if (coverHookSource === 'multi' && !bundle?.target_phrase_multi?.trim()) {
      toast.error('多句极限靶点为空，请重新生成文案，或改选「一句话极限靶点」');
      return;
    }
    const aspectOpt =
      COVER_ASPECT_OPTIONS.find((o) => o.id === coverAspect) ?? COVER_ASPECT_OPTIONS[0];
    const topicLang = detectTopicLang(coreTopic);
    const imageTextEnforcement =
      topicLang === 'zh'
        ? '\n\nMandatory: all Chinese characters on the thumbnail (titles, subtitles, stamps, badges) must be in Traditional Chinese (繁體中文) script only; no simplified Chinese forms. No English except user-provided proper nouns if any.'
        : '\n\nMandatory: all on-image text must be English only; no Chinese or other scripts on the thumbnail.';
    const useMulti =
      coverHookSource === 'multi' && bundle?.target_phrase_multi?.trim();
    const hookOne = bundle?.target_phrase_badge?.trim() || '';
    const hookMulti = bundle?.target_phrase_multi?.trim() || '';
    const hookEnforcement = useMulti
      ? topicLang === 'zh'
        ? `\n\nLayered thumbnail copy (render all Chinese on-image text in Traditional Chinese 繁體):\n${hookMulti}\nUse the strongest line as the largest dominant title; place remaining 1–2 sentences as secondary strips or subtitles without clutter.`
        : `\n\nLayered thumbnail copy from multi-sentence hook:\n${hookMulti}\nUse the strongest line as the largest dominant title; place remaining 1–2 sentences as secondary strips or subtitles without clutter.`
      : hookOne
        ? `\n\nThe largest, most dominant title text on the thumbnail must express this hook meaning: "${hookOne}".`
        : '';
    const stylePreset =
      COVER_STYLE_PRESETS.find((s) => s.id === coverStyleId) ??
      COVER_STYLE_PRESETS.find((s) => s.id === 'minimal_flat')!;
    const styleEnforcement = `\n\nVisual style preset (must match): ${stylePreset.promptEn}`;

    setSchemeLoading((m) => ({ ...m, [key]: true }));
    try {
      const res = await generateImage(apiKey, {
        model: COVER_GEMINI_IMAGE_MODEL,
        prompt: `${prompt}\n\nYouTube thumbnail, ${aspectOpt.id} aspect ratio, bold readable main title, high CTR composition.${styleEnforcement}${hookEnforcement}${imageTextEnforcement}`,
        size: aspectOpt.size,
        quality: 'high',
        referenceDataUrls:
          refLocked && refPreviews.length > 0
            ? refPreviews.map((x) => x.dataUrl)
            : undefined,
      });
      if (res.success && res.url) {
        setSchemeUrls((m) => ({ ...m, [key]: res.url || null }));
        toast.success(`方案 ${key} 已生成`);
      } else {
        toast.error(res.error || '图片生成失败');
      }
    } catch (e: any) {
      toast.error(e?.message || '图片生成失败');
    } finally {
      setSchemeLoading((m) => ({ ...m, [key]: false }));
    }
  };

  const profile = niche !== null ? getCoverNicheProfile(niche) : null;

  const onDownloadScheme = async (key: 'A' | 'B' | 'C', src: string) => {
    try {
      await downloadCoverImage(src, `cover-scheme-${key}-${coverAspect}-${Date.now()}.png`);
      toast.success('已开始下载');
    } catch {
      toast.error('下载失败，可右键图片另存为');
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-16">
      <div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-emerald-400/90 font-mono uppercase tracking-wider mb-2">
          <span className="px-2 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10">
            MULTI-NICHE COVER
          </span>
        </div>
        <h1 className="text-2xl font-bold text-slate-100">YouTube 封面设计</h1>
      </div>

      {/* 赛道 */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {COVER_NICHE_ORDER.map((id) => {
            const n = NICHES[id];
            const on = niche === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setNiche(id)}
                className={`px-3 py-1.5 rounded-lg text-sm border transition-all flex items-center gap-1.5 ${
                  on
                    ? 'bg-emerald-600 text-white border-emerald-500 shadow-lg shadow-emerald-500/20'
                    : 'bg-slate-900/60 text-slate-400 border-slate-700 hover:border-slate-600'
                }`}
              >
                <span>{n.icon}</span>
                <span className="max-w-[140px] truncate">{n.name}</span>
              </button>
            );
          })}
        </div>
        {niche === null && (
          <p className="text-xs text-amber-500/90">请选择一个赛道后再生成文案；上传参考图时也会弹出快捷选择。</p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-emerald-400 flex items-center gap-2">
            <span className="w-6 h-6 rounded bg-emerald-500/20 flex items-center justify-center text-xs text-emerald-300">
              1
            </span>
            参考图（可选，支持多张）
          </h2>
          <p className="text-xs text-slate-500">
            {profile?.refUploadHint ??
              '上传前可先选赛道；若尚未选择，上传成功后会弹出赛道选择。'}
          </p>
          <p className="text-xs text-slate-600">
            已选 {refPreviews.length} / {MAX_REFERENCE_IMAGES} 张 · 可多次选择累加 · 上传成功后会自动锁定参考（可点击按钮取消）
          </p>
          <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-700 rounded-xl p-8 cursor-pointer hover:border-emerald-500/40 transition-colors">
            <Upload className="w-8 h-8 text-slate-500 mb-2" />
            <span className="text-sm text-slate-400">点击选择一张或多张参考图</span>
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={onRefFiles}
            />
          </label>
          {refPreviews.length > 0 && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {refPreviews.map((item) => (
                  <div
                    key={item.id}
                    className="relative group rounded-lg border border-slate-800 bg-black/40 overflow-hidden aspect-video"
                  >
                    <img src={item.dataUrl} alt="" className="w-full h-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removeRefById(item.id)}
                      className="absolute top-1 right-1 p-1 rounded-md bg-black/70 text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-label="移除"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setRefLocked((v) => !v)}
                  className={`flex-1 min-w-[140px] py-2 rounded-lg text-sm font-medium border transition-colors ${
                    refLocked
                      ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-300'
                      : 'bg-slate-800 border-slate-700 text-slate-300'
                  }`}
                >
                  {refLocked ? '取消锁定（文案/生图暂不带参考图）' : '锁定参考（写入文案 + 生图多模态）'}
                </button>
                <button
                  type="button"
                  onClick={clearAllRefs}
                  className="py-2 px-3 rounded-lg text-sm border border-slate-700 text-slate-400 hover:bg-slate-800"
                >
                  清空全部
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-4 flex flex-col">
          <h2 className="text-sm font-semibold text-emerald-400 flex items-center gap-2">
            <span className="w-6 h-6 rounded bg-emerald-500/20 flex items-center justify-center text-xs text-emerald-300">
              2
            </span>
            核心观点（视频核心议题）
          </h2>
          <textarea
            value={coreTopic}
            onChange={(e) => setCoreTopic(e.target.value)}
            placeholder="例如：How the quiet presence of a dog can help rewire your nervous system..."
            className="flex-1 min-h-[220px] w-full bg-slate-950/80 border border-slate-800 rounded-lg p-4 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 resize-y"
          />
        </div>
      </div>

      <button
        type="button"
        disabled={loadingText || niche === null}
        onClick={runGenerateBundle}
        className="w-full py-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-sm shadow-lg shadow-emerald-900/30 flex items-center justify-center gap-2"
      >
        {loadingText ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <Sparkles className="w-5 h-5" />
        )}
        生成高转化文案与 A/B/C 矩阵指令
      </button>

      {!bundle && rawOut && (
        <pre className="text-xs text-slate-500 whitespace-pre-wrap break-words max-h-48 overflow-y-auto border border-slate-800 rounded-lg p-3 bg-slate-950/60">
          {rawOut}
        </pre>
      )}

      {bundle && (
        <>
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-emerald-400 flex items-center gap-2">
              <span className="w-6 h-6 rounded bg-emerald-500/20 flex items-center justify-center text-xs text-emerald-300">
                3
              </span>
              SEO 标题库 &amp; 长尾标签库
            </h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 min-w-0">
              <div className="space-y-4 min-w-0">
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-2 relative">
                  <button
                    type="button"
                    onClick={() => copy('tw', bundle.titles_warning)}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400 z-10"
                  >
                    {copied === 'tw' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="text-xs text-slate-500 pr-10">THE WARNING</div>
                  <p className="text-sm text-slate-200 pr-10">{bundle.titles_warning}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-2 relative">
                  <button
                    type="button"
                    onClick={() => copy('tat', bundle.titles_anti_truth)}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400 z-10"
                  >
                    {copied === 'tat' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="text-xs text-slate-500 pr-10">THE ANTI-TRUTH</div>
                  <p className="text-sm text-slate-200 pr-10">{bundle.titles_anti_truth}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-2 relative">
                  <button
                    type="button"
                    onClick={() => copy('tsd', bundle.titles_stop_doing)}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400 z-10"
                  >
                    {copied === 'tsd' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="text-xs text-slate-500 pr-10">THE STOP DOING</div>
                  <p className="text-sm text-slate-200 pr-10">{bundle.titles_stop_doing}</p>
                </div>
                <div className="rounded-xl border border-emerald-900/40 bg-emerald-950/20 p-4 relative">
                  <button
                    type="button"
                    onClick={() => copy('gd', bundle.golden_description)}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400"
                  >
                    {copied === 'gd' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="text-xs text-emerald-500/80 mb-2">黄金两行描述</div>
                  <p className="text-sm text-slate-200 pr-10">{bundle.golden_description}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 relative min-w-0 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => copy('tags', formatSeoTagsForDisplay(bundle.seo_tags))}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400 z-10"
                  >
                    {copied === 'tags' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="text-xs text-slate-500 mb-2 pr-10">SEO 热门标签</div>
                  <p className="text-sm text-slate-300 break-words [overflow-wrap:anywhere] whitespace-pre-wrap pr-10 max-w-full">
                    {formatSeoTagsForDisplay(bundle.seo_tags)}
                  </p>
                </div>
              </div>
              <div className="space-y-4 min-w-0">
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                  <div className="text-xs text-slate-500 mb-2">系统锁定视觉情绪</div>
                  <p className="text-sm text-slate-200">{bundle.visual_emotion_lock}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 relative">
                  <button
                    type="button"
                    onClick={() => copy('badge', bundle.target_phrase_badge)}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400"
                  >
                    {copied === 'badge' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="text-xs text-slate-500 mb-2 pr-10">一句话极限靶点</div>
                  <p className="text-lg font-bold text-emerald-400 tracking-tight break-words pr-10">
                    {bundle.target_phrase_badge}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 relative min-w-0 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => copy('multi', bundle.target_phrase_multi)}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400 z-10"
                  >
                    {copied === 'multi' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <div className="text-xs text-slate-500 mb-2 pr-10">多句极限靶点（2–3 句 · SEO/长尾风格）</div>
                  {bundle.target_phrase_multi?.trim() ? (
                    <div className="space-y-2 pr-10">
                      {splitMultiHookLines(bundle.target_phrase_multi).map((line, i) => (
                        <p
                          key={i}
                          className="text-sm font-semibold break-words [overflow-wrap:anywhere] leading-relaxed"
                          style={{ color: MULTI_HOOK_LINE_HEX[i % MULTI_HOOK_LINE_HEX.length] }}
                        >
                          {line}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500 pr-10">
                      （本批 JSON 未包含该字段，请点击上方「生成」重新拉取。）
                    </p>
                  )}
                </div>
                {(['var_a', 'var_b', 'var_c'] as const).map((k, i) => {
                  const label = ['VAR A · 场景构图', 'VAR B · 极简白底', 'VAR C · 高反差特写'][i];
                  const border = ['border-l-red-500', 'border-l-white', 'border-l-blue-500'][i];
                  const val = bundle[k];
                  return (
                    <div
                      key={k}
                      className={`rounded-xl border border-slate-800 bg-slate-900/40 p-4 border-l-4 ${border} relative`}
                    >
                      <button
                        type="button"
                        onClick={() => copy(k, val)}
                        className="absolute top-3 right-3 p-1.5 rounded-md bg-slate-800 text-slate-400 hover:text-emerald-400"
                      >
                        {copied === k ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                      </button>
                      <div className="text-xs text-slate-500 mb-2">{label}</div>
                      <p className="text-xs text-slate-400 whitespace-pre-wrap pr-10 leading-relaxed">{val}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-emerald-400 flex items-center gap-2">
              <span className="w-6 h-6 rounded bg-emerald-500/20 flex items-center justify-center text-xs text-emerald-300">
                4
              </span>
              缩略图设计区
            </h2>
            {!canYunwuImage && (
              <p className="text-xs text-amber-500/90">
                当前 Key 非 Yunwu（sk-），无法直接出图；可复制 VAR 提示词到「一键成片」或其它工具。
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500 shrink-0">封面比例：</span>
              {COVER_ASPECT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setCoverAspect(opt.id)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                    coverAspect === opt.id
                      ? 'bg-emerald-600/30 border-emerald-500/60 text-emerald-200'
                      : 'bg-slate-900/80 border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:gap-3">
              <span className="text-xs text-slate-500 shrink-0">主文案来源：</span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setCoverHookSource('one')}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                    coverHookSource === 'one'
                      ? 'bg-emerald-600/30 border-emerald-500/60 text-emerald-200'
                      : 'bg-slate-900/80 border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  一句话极限靶点（默认）
                </button>
                <button
                  type="button"
                  disabled={!bundle.target_phrase_multi?.trim()}
                  onClick={() => setCoverHookSource('multi')}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    coverHookSource === 'multi'
                      ? 'bg-emerald-600/30 border-emerald-500/60 text-emerald-200'
                      : 'bg-slate-900/80 border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  多句极限靶点
                </button>
              </div>
              <p className="text-[11px] text-slate-600 w-full sm:w-auto sm:ml-1">
                中文赛道出图时画面汉字以繁体为准；与左侧靶点文案可不同字形但需同义。
              </p>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 min-w-0">
              <label className="text-xs text-slate-500 shrink-0 sm:pt-0.5" htmlFor="cover-style-preset">
                画面风格：
              </label>
              <select
                id="cover-style-preset"
                value={coverStyleId}
                onChange={(e) => setCoverStyleId(e.target.value)}
                className="flex-1 min-w-0 max-w-xl bg-slate-950/90 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
              >
                {COVER_STYLE_PRESETS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 min-w-0">
              {(
                [
                  { k: 'A' as const, title: '方案 A：场景沉浸', bar: 'bg-red-500' },
                  { k: 'B' as const, title: '方案 B：极简/单色底', bar: 'bg-slate-200' },
                  { k: 'C' as const, title: '方案 C：高反差/特写', bar: 'bg-blue-500' },
                ] as const
              ).map(({ k, title, bar }) => {
                const ratioClass =
                  COVER_ASPECT_OPTIONS.find((o) => o.id === coverAspect)?.ratioClass ?? 'aspect-video';
                return (
                  <div
                    key={k}
                    className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden flex flex-col min-w-0"
                  >
                    <div className="p-3 flex items-center gap-2 border-b border-slate-800">
                      <span className={`w-1 h-5 rounded ${bar}`} />
                      <span className="text-sm text-slate-200 flex-1 truncate">{title}</span>
                    </div>
                    <div className="p-3 flex-1 flex flex-col gap-3">
                      <button
                        type="button"
                        disabled={!canYunwuImage || schemeLoading[k]}
                        onClick={() => runSchemeImage(k)}
                        className="w-full py-2 rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 text-sm hover:bg-emerald-600/30 disabled:opacity-40"
                      >
                        {schemeLoading[k] ? '生成中…' : '点击生成'}
                      </button>
                      <div
                        className={`${ratioClass} group relative w-full max-h-[min(420px,70vh)] rounded-lg bg-black/50 border border-slate-800 flex items-center justify-center overflow-hidden mx-auto`}
                      >
                        {schemeUrls[k] ? (
                          <>
                            <img src={schemeUrls[k]!} alt="" className="w-full h-full object-cover" />
                            <button
                              type="button"
                              onClick={() => void onDownloadScheme(k, schemeUrls[k]!)}
                              className="absolute bottom-2 right-2 z-10 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-black/80 text-white text-xs font-medium border border-slate-600 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity hover:bg-emerald-700/90 hover:border-emerald-500/60"
                            >
                              <Download className="w-3.5 h-3.5 shrink-0" />
                              下载
                            </button>
                          </>
                        ) : (
                          <span className="text-slate-600 text-sm flex flex-col items-center gap-2 px-2 text-center">
                            <ImageIcon className="w-8 h-8 opacity-40" />
                            待生成
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {nicheModalOpen && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/75"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cover-niche-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setNicheModalOpen(false);
          }}
        >
          <div
            className="max-w-lg w-full max-h-[85vh] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="cover-niche-modal-title" className="text-base font-semibold text-slate-100">
              请选择参考图对应的赛道
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              不同赛道的封面 DNA、参考图说明与禁忌不同（例如非治愈赛道不会默认强调宠物）。上传参考图后请先选定垂类。
            </p>
            <div className="flex flex-wrap gap-2">
              {COVER_NICHE_ORDER.map((id) => {
                const n = NICHES[id];
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setNiche(id);
                      setNicheModalOpen(false);
                    }}
                    className="px-3 py-1.5 rounded-lg text-sm border border-slate-600 bg-slate-800/80 text-slate-200 hover:border-emerald-500/50 hover:bg-emerald-950/40 transition-colors flex items-center gap-1.5"
                  >
                    <span>{n.icon}</span>
                    <span className="max-w-[140px] truncate">{n.name}</span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => setNicheModalOpen(false)}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              稍后再选（可关闭弹窗后在上方手动选择赛道）
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
