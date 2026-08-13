#!/usr/bin/env node
/**
 * 长视频分批渲染 + ffmpeg 拼接（M2 #12）
 *
 * 工作流：
 * 1. 接收完整 shots + config
 * 2. 估算视频总时长（shots 总和 / fps）
 * 3. 若总时长 > 阈值（默认 30 分钟 = 1800 秒），按每段不超过阈值的时间切分 shots
 * 4. 循环渲染每段，得到 N 个独立 MP4
 * 5. 用 ffmpeg -f concat 把 N 个 MP4 拼成最终 MP4（stream copy，无损秒级）
 *
 * 设计目标：
 * - 规避 Chrome 单次渲染时长 > 30 分钟时的 OOM / 崩溃
 * - 用户无感：只需调用一次接口，进度仍按帧推进
 * - 失败时已渲染的部分保留到 output/_parts/，便于排查
 */

import { spawn, execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';

const execFile = promisify(execFileCb);

interface Shot {
  id: string;
  caption?: string;
  text?: string;
  audioDurationSec?: number;
  audioDurationExact?: number;
  duration?: number;
}

interface BatchOptions {
  /** 每段最大时长（秒），默认 1800（30 分钟） */
  maxSegmentDurationSec?: number;
  /** 输出目录 */
  outputDir: string;
  /** 帧率 */
  fps: number;
  /** 用于调试的日志函数 */
  onLog?: (msg: string) => void;
}

interface BatchResult {
  /** 分段数量 */
  segmentCount: number;
  /** 各段信息 */
  segments: Array<{ index: number; shots: Shot[]; path: string; durationSec: number }>;
  /** 拼接后的最终路径 */
  finalPath: string;
  /** 总时长（秒） */
  totalDurationSec: number;
}

/**
 * 估算单段时长（秒）：优先取 audioDurationExact，否则 audioDurationSec，否则 duration
 */
function estimateShotDuration(shot: Shot): number {
  return (
    shot.audioDurationExact ??
    shot.audioDurationSec ??
    shot.duration ??
    4 // 默认 4 秒
  );
}

/**
 * 估算视频总时长
 */
function estimateTotalDuration(shots: Shot[]): number {
  return shots.reduce((sum, s) => sum + estimateShotDuration(s), 0);
}

/**
 * 把 shots 按目标段时长切片
 */
function splitShotsIntoSegments(shots: Shot[], maxDurationSec: number): Shot[][] {
  const segments: Shot[][] = [];
  let current: Shot[] = [];
  let currentDur = 0;
  for (const shot of shots) {
    const dur = estimateShotDuration(shot);
    // 切分策略：当前段累计时长 + 当前镜头时长 超过阈值时，切新段
    // 强制避免单个镜头被切分（让镜头完整连续显示）
    if (currentDur + dur > maxDurationSec && current.length > 0) {
      segments.push(current);
      current = [];
      currentDur = 0;
    }
    current.push(shot);
    currentDur += dur;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * 检查 ffmpeg 是否可用
 */
async function checkFfmpeg(): Promise<boolean> {
  try {
    await execFile('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * 用 ffmpeg -f concat 拼接多个 MP4（stream copy，无损秒级）
 */
async function concatMp4(parts: string[], finalPath: string, onLog?: (msg: string) => void): Promise<void> {
  const listFile = `${finalPath}.concat.txt`;
  const listContent = parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  writeFileSync(listFile, listContent);
  if (onLog) onLog(`[concat] 拼接列表:\n${listContent}`);

  try {
    await execFile('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-movflags', '+faststart',
      finalPath,
    ]);
    // 清理 list file
    rmSync(listFile, { force: true });
  } catch (e: any) {
    rmSync(listFile, { force: true });
    throw new Error(`ffmpeg 拼接失败: ${e.message}`);
  }
}

/**
 * 主入口：由调用方控制每段的实际渲染（复用 runRenderWorker）
 *
 * @param renderSegment - 异步函数：(shots, outputPath) => Promise<{ durationSec: number }>
 * @param payload - 完整 payload
 * @param opts
 */
export async function renderLongVideoBatch(
  payload: any,
  renderSegment: (shots: Shot[], outputPath: string) => Promise<{ durationSec: number }>,
  opts: BatchOptions,
): Promise<BatchResult> {
  const fps = opts.fps || 30;
  const maxDur = opts.maxSegmentDurationSec || 1800;
  const shots: Shot[] = payload.shots || [];

  const totalDuration = estimateTotalDuration(shots);
  opts.onLog?.(`[batch] 估算总时长: ${(totalDuration / 60).toFixed(1)} 分钟`);

  // 短于阈值：直接单段渲染（不切分）
  if (totalDuration <= maxDur) {
    opts.onLog?.(`[batch] 视频短于 ${maxDur}s，无需分批`);
    const outputPath = join(opts.outputDir, `${payload._taskId || 'batch'}.mp4`);
    const result = await renderSegment(shots, outputPath);
    return {
      segmentCount: 1,
      segments: [{ index: 0, shots, path: outputPath, durationSec: result.durationSec }],
      finalPath: outputPath,
      totalDurationSec: result.durationSec,
    };
  }

  // 长视频：分批
  const segments = splitShotsIntoSegments(shots, maxDur);
  opts.onLog?.(`[batch] 长视频分批: 总长 ${(totalDuration / 60).toFixed(1)} 分钟 → ${segments.length} 段（每段 ≤ ${maxDur / 60} 分钟）`);

  // 检查 ffmpeg
  const hasFfmpeg = await checkFfmpeg();
  if (!hasFfmpeg) {
    throw new Error('ffmpeg 不可用，无法拼接长视频。请安装 ffmpeg (brew install ffmpeg)');
  }

  const taskId = payload._taskId || `batch_${Date.now()}`;
  const partsDir = join(opts.outputDir, `${taskId}_parts`);
  if (!existsSync(partsDir)) mkdirSync(partsDir, { recursive: true });

  // 渲染每段
  const renderedParts: Array<{ path: string; durationSec: number }> = [];
  for (let i = 0; i < segments.length; i++) {
    const segShots = segments[i];
    const partPath = join(partsDir, `part_${String(i + 1).padStart(3, '0')}.mp4`);
    opts.onLog?.(`[batch] 第 ${i + 1}/${segments.length} 段: ${segShots.length} 个镜头 → ${partPath}`);
    try {
      const result = await renderSegment(segShots, partPath);
      renderedParts.push({ path: partPath, durationSec: result.durationSec });
    } catch (e: any) {
      opts.onLog?.(`[batch] 第 ${i + 1} 段失败: ${e.message}`);
      throw new Error(`分批渲染第 ${i + 1}/${segments.length} 段失败: ${e.message}`);
    }
  }

  // 拼接
  const finalPath = join(opts.outputDir, `${taskId}.mp4`);
  opts.onLog?.(`[batch] 拼接 ${renderedParts.length} 段 → ${finalPath}`);
  await concatMp4(renderedParts.map((p) => p.path), finalPath, opts.onLog);

  // 清理 parts（保留最近 1 段用于排查）
  try {
    for (let i = 0; i < renderedParts.length - 1; i++) {
      rmSync(renderedParts[i].path, { force: true });
    }
  } catch {
    /* ignore */
  }

  return {
    segmentCount: renderedParts.length,
    segments: renderedParts.map((p, i) => ({
      index: i,
      shots: segments[i],
      path: p.path,
      durationSec: p.durationSec,
    })),
    finalPath,
    totalDurationSec: renderedParts.reduce((sum, p) => sum + p.durationSec, 0),
  };
}

export { splitShotsIntoSegments, estimateTotalDuration, estimateShotDuration, checkFfmpeg };
