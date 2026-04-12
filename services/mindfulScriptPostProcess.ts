/**
 * 治愈心理学（英文 TTS）脚本：总字符数（含空格与标点）硬区间与合并后收尾
 */

export const MINDFUL_EN_SCRIPT_CHARS_MIN = 10000;
export const MINDFUL_EN_SCRIPT_CHARS_MAX = 15000;

export function clampMindfulParallelTargetChars(v: number): number {
  return Math.min(
    MINDFUL_EN_SCRIPT_CHARS_MAX,
    Math.max(MINDFUL_EN_SCRIPT_CHARS_MIN, Math.round(Number.isFinite(v) ? v : 12000))
  );
}

/** 合并阶段：按用户选的「全文目标」给出略窄的允许带，且总落在硬区间内 */
export function mindfulMergeCharClamp(totalTarget: number): { min: number; max: number } {
  const T = clampMindfulParallelTargetChars(totalTarget);
  return {
    min: Math.max(MINDFUL_EN_SCRIPT_CHARS_MIN, Math.floor(T * 0.97)),
    max: Math.min(MINDFUL_EN_SCRIPT_CHARS_MAX, Math.ceil(T * 1.03)),
  };
}

/** 将超长终稿截断到上限，保留原文末尾的 CTA（不强制添加英文 CTA） */
export function truncateMindfulScript(raw: string, maxLen: number): string {
  let body = raw.replace(/\r\n/g, '\n').trimEnd();
  if (body.length <= maxLen) {
    return body;
  }
  const budget = maxLen;
  const slice = body.slice(0, budget);
  let cut = -1;
  for (const p of ['.', '!', '?']) {
    const i = slice.lastIndexOf(p);
    if (i > cut) cut = i;
  }
  return cut > budget * 0.65 ? body.slice(0, cut + 1).trimEnd() : slice.trimEnd();
}
