/**
 * 睡前历史人物脚本：字数硬区间与合并后处理
 */
export const HISTORICAL_EN_SCRIPT_CHARS_MIN = 10000;
export const HISTORICAL_EN_SCRIPT_CHARS_MAX = 18000;
export const HISTORICAL_ZH_SCRIPT_CHARS_MIN = 10000;
export const HISTORICAL_ZH_SCRIPT_CHARS_MAX = 18000;

export function clampHistoricalParallelTargetChars(v: number, isZhOutput: boolean = false): number {
  if (isZhOutput) {
    return Math.min(
      HISTORICAL_ZH_SCRIPT_CHARS_MAX,
      Math.max(HISTORICAL_ZH_SCRIPT_CHARS_MIN, Math.round(Number.isFinite(v) ? v : 12000))
    );
  }
  return Math.min(
    HISTORICAL_EN_SCRIPT_CHARS_MAX,
    Math.max(HISTORICAL_EN_SCRIPT_CHARS_MIN, Math.round(Number.isFinite(v) ? v : 14000))
  );
}

export function historicalMergeCharClamp(totalTarget: number, isZhOutput: boolean = false): { min: number; max: number } {
  return { min: 9000, max: 20000 };
}

export function truncateHistoricalScript(raw: string, maxLen: number): string {
  return raw;
}
