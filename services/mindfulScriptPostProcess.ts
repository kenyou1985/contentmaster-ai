/**
 * 治愈心理学（英文 TTS）脚本：总字符数（含空格与标点）硬区间与合并后收尾
 *
 * ⚠️ 重要：内容完整性优先，禁止截断！
 * 如果需要控制字数，应在分段生成阶段控制，不应在后期截断。
 */

export const MINDFUL_EN_SCRIPT_CHARS_MIN = 18000;
export const MINDFUL_EN_SCRIPT_CHARS_MAX = 20000;
export const MINDFUL_ZH_SCRIPT_CHARS_MIN = 5500;
export const MINDFUL_ZH_SCRIPT_CHARS_MAX = 6500;

export function clampMindfulParallelTargetChars(v: number, isZhOutput: boolean = false): number {
  if (isZhOutput) {
    return Math.min(
      MINDFUL_ZH_SCRIPT_CHARS_MAX,
      Math.max(MINDFUL_ZH_SCRIPT_CHARS_MIN, Math.round(Number.isFinite(v) ? v : 6000))
    );
  }
  return Math.min(
    MINDFUL_EN_SCRIPT_CHARS_MAX,
    Math.max(MINDFUL_EN_SCRIPT_CHARS_MIN, Math.round(Number.isFinite(v) ? v : 19000))
  );
}

/** 合并阶段：给出宽松的字数范围提示，内容完整性优先 */
export function mindfulMergeCharClamp(totalTarget: number, isZhOutput: boolean = false): { min: number; max: number } {
  if (isZhOutput) {
    return {
      min: 5000,   // 中文宽松下限
      max: 7000,   // 中文宽松上限
    };
  }
  return {
    min: 16000,   // 英文宽松下限
    max: 24000,   // 英文宽松上限
  };
}

/**
 * ⚠️ 禁止截断！
 * 此函数不再截断内容，内容完整性优先。
 * 字数控制应在分段生成阶段完成。
 */
export function truncateMindfulScript(raw: string, maxLen: number): string {
  // 直接返回原文，禁止任何截断
  return raw;
}
