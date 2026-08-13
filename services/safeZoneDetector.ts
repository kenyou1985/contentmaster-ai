/**
 * 字幕安全区检测（M2 #7）
 *
 * 目标：检测图片中适合放字幕的区域，避免字幕压在主体（人脸/物体）上。
 *
 * 策略：分两阶段
 * 1. 【默认·轻量】图像亮度/方差热力图：找出"视觉低信息区"作为字幕候选位置
 *    - 算法：把图分 3x3 / 4x4 网格，每个网格计算亮度方差（方差小 = 平滑区域）
 *    - 平滑区域适合放字幕；高方差区域（边缘密集 = 主体）避开
 * 2. 【可选·MediaPipe】加载 @mediapipe/tasks-vision Face Detector 精准人脸定位
 *    - 用户首次启用时下载模型（约 2MB），结果缓存到 shot.subtitleSafeZone
 *
 * 输出：SafeZone { top: 0~1, bottom: 0~1, left: 0~1, right: 0~1 }
 * - top/bottom/left/right 表示字幕区域的归一化边界（相对图片宽高）
 */

export interface SafeZone {
  /** 字幕区域上边界（0~1，相对图片高度） */
  top: number;
  /** 字幕区域下边界（0~1） */
  bottom: number;
  /** 字幕区域左边界（0~1，相对图片宽度） */
  left: number;
  /** 字幕区域右边界（0~1） */
  right: number;
  /** 推荐位置：top / middle / bottom */
  preferredPosition: 'top' | 'middle' | 'bottom';
  /** 置信度 0~1（基于检测质量） */
  confidence: number;
}

/**
 * 默认安全区（图片中央水平条）
 */
const DEFAULT_SAFE_ZONE: SafeZone = {
  top: 0.4,
  bottom: 0.9,
  left: 0.05,
  right: 0.95,
  preferredPosition: 'bottom',
  confidence: 0.3,
};

/**
 * 把图片加载到 Canvas 并提取像素数据
 */
async function loadImageToCanvas(
  imageUrl: string,
  maxSize = 256
): Promise<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null> {
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('图片加载失败'));
      // 5 秒超时
      setTimeout(() => reject(new Error('图片加载超时')), 5000);
    });
    img.src = imageUrl;

    // 等图片完全加载（处理 src 同步赋值的情况）
    if (!img.complete) {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('图片加载失败'));
      });
    }

    const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return { canvas, ctx };
  } catch (e) {
    console.warn('[safeZone] 加载图片失败:', e);
    return null;
  }
}

/**
 * 轻量算法：分网格计算亮度方差
 * - 找出"最平滑"的水平条作为字幕候选
 * - 计算时考虑纵向连续性（字幕要一段连贯区域，不是散点）
 */
async function detectByBrightnessVariance(imageUrl: string): Promise<SafeZone> {
  const loaded = await loadImageToCanvas(imageUrl, 200);
  if (!loaded) return DEFAULT_SAFE_ZONE;

  const { ctx } = loaded;
  const w = loaded.canvas.width;
  const h = loaded.canvas.height;

  // 分 8 行 × 8 列网格（共 64 块）
  const rows = 8;
  const cols = 8;
  const cellW = Math.floor(w / cols);
  const cellH = Math.floor(h / rows);

  // 每个 cell 的"复杂度"（亮度方差）
  const grid: number[][] = [];
  for (let r = 0; r < rows; r++) {
    grid.push([]);
    for (let c = 0; c < cols; c++) {
      const data = ctx.getImageData(c * cellW, r * cellH, cellW, cellH).data;
      let sum = 0;
      let sumSq = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        // 亮度 (Y' = 0.299R + 0.587G + 0.114B)
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        sum += lum;
        sumSq += lum * lum;
        count++;
      }
      const avg = sum / count;
      const variance = sumSq / count - avg * avg;
      grid[r].push(variance);
    }
  }

  // 计算每一行的"平均复杂度"
  const rowComplexity = grid.map(row => row.reduce((a, b) => a + b, 0) / cols);
  // 计算每一行的"平均亮度"
  const rowBrightness: number[] = [];
  for (let r = 0; r < rows; r++) {
    const data = ctx.getImageData(0, r * cellH, w, cellH).data;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += lum;
      count++;
    }
    rowBrightness.push(sum / count);
  }

  // 找"复杂度最低 + 亮度不太暗"的连续 3 行作为字幕带
  // 字幕可放位置：top（r=0..1）/ middle（r=3..4）/ bottom（r=5..7）
  let bestBandStart = 5; // 默认底部
  let bestScore = -Infinity;

  for (let start = 0; start <= rows - 2; start++) {
    // 连续 2-3 行
    const bandRows = [start, start + 1];
    const complexityScore = -bandRows.reduce((s, r) => s + rowComplexity[r], 0);
    const brightnessScore = bandRows.reduce((s, r) => s + rowBrightness[r], 0) / 2;
    // 字幕要在 30~200 亮度之间（太暗看不清字，太亮对比度不够）
    const brightnessPenalty = brightnessScore < 30 ? -50 : brightnessScore > 200 ? -30 : 0;
    const band = start < 2 ? 'top' : start < 5 ? 'middle' : 'bottom';
    const positionBonus = band === 'bottom' ? 5 : band === 'middle' ? 2 : 0;
    const total = complexityScore + brightnessScore / 10 + brightnessPenalty + positionBonus;
    if (total > bestScore) {
      bestScore = total;
      bestBandStart = start;
    }
  }

  const top = bestBandStart / rows;
  const bottom = Math.min(1, (bestBandStart + 2) / rows);
  const preferredPosition: 'top' | 'middle' | 'bottom' =
    bestBandStart < 2 ? 'top' : bestBandStart < 5 ? 'middle' : 'bottom';

  return {
    top,
    bottom,
    left: 0.05,
    right: 0.95,
    preferredPosition,
    confidence: 0.5,
  };
}

/**
 * 检测单张图片的安全区（异步）
 */
export async function detectSafeZone(imageUrl: string, useMediaPipe = false): Promise<SafeZone> {
  if (!imageUrl || imageUrl.startsWith('blob:') || imageUrl.startsWith('data:') === false && !imageUrl.startsWith('http')) {
    return DEFAULT_SAFE_ZONE;
  }

  if (useMediaPipe) {
    // 高级检测：留给未来扩展（需要动态加载 @mediapipe/tasks-vision）
    // 当前降级为基础检测
    return detectByBrightnessVariance(imageUrl);
  }

  return detectByBrightnessVariance(imageUrl);
}

/**
 * 批量检测多个 shot 的安全区
 */
export async function detectSafeZonesForShots(
  shots: Array<{ id: string; imageUrl?: string; imageUrls?: string[] }>,
  onProgress?: (done: number, total: number, current: string) => void
): Promise<Record<string, SafeZone>> {
  const results: Record<string, SafeZone> = {};
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const img = shot.imageUrl || shot.imageUrls?.[0];
    onProgress?.(i, shots.length, shot.id);
    if (img) {
      try {
        results[shot.id] = await detectSafeZone(img);
      } catch {
        results[shot.id] = DEFAULT_SAFE_ZONE;
      }
    } else {
      results[shot.id] = DEFAULT_SAFE_ZONE;
    }
  }
  return results;
}

/**
 * 默认安全区（图片底部水平条带）
 */
export function getDefaultSafeZone(): SafeZone {
  return { ...DEFAULT_SAFE_ZONE };
}
