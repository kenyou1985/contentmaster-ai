#!/usr/bin/env node
/**
 * 长视频分批渲染 + ffmpeg 拼接（M2 #12）
 *
 * 工作流：
 * 1. 接收完整 shots + config
 * 2. 估算视频总时长
 * 3. 若总时长 > 30 分钟，按每段 ≤ 20 分钟切分 shots
 * 4. 循环渲染每段，得到 N 个独立 MP4
 * 5. 用 ffmpeg -f concat 把 N 个 MP4 拼成最终 MP4（stream copy，无损秒级）
 */

import { spawn, execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import os from 'os';

const execFile = promisify(execFileCb);

/**
 * 估算单段时长（秒）
 */
function estimateShotDuration(shot) {
  return (
    shot.audioDurationExact ??
    shot.audioDurationSec ??
    shot.duration ??
    4
  );
}

/**
 * 估算视频总时长
 */
function estimateTotalDuration(shots) {
  return shots.reduce((sum, s) => sum + estimateShotDuration(s), 0);
}

/**
 * 把 shots 按目标段时长切片
 */
function splitShotsIntoSegments(shots, maxDurationSec) {
  const segments = [];
  let current = [];
  let currentDur = 0;
  for (const shot of shots) {
    const dur = estimateShotDuration(shot);
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
async function checkFfmpeg() {
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
async function concatMp4(parts, finalPath, onLog) {
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
    rmSync(listFile, { force: true });
  } catch (e) {
    rmSync(listFile, { force: true });
    throw new Error(`ffmpeg 拼接失败: ${e.message}`);
  }
}

/**
 * 渲染长视频分批
 *
 * @param {object} payload - 完整 payload（含 shots / config）
 * @param {function} renderSegment - 异步函数：(shots, outputPath) => Promise<{ durationSec: number }>
 * @param {object} opts - { outputDir, fps, maxSegmentDurationSec, onLog }
 */
export async function renderLongVideoBatch(payload, renderSegment, opts) {
  const fps = opts.fps || 30;
  const maxDur = opts.maxSegmentDurationSec || 1800;
  const shots = payload.shots || [];

  const totalDuration = estimateTotalDuration(shots);
  opts.onLog?.(`[batch] 估算总时长: ${(totalDuration / 60).toFixed(1)} 分钟`);

  // 短于阈值：直接单段渲染
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

  const hasFfmpeg = await checkFfmpeg();
  if (!hasFfmpeg) {
    throw new Error('ffmpeg 不可用，无法拼接长视频。请安装 ffmpeg (brew install ffmpeg)');
  }

  const taskId = payload._taskId || `batch_${Date.now()}`;
  const partsDir = join(opts.outputDir, `${taskId}_parts`);
  if (!existsSync(partsDir)) mkdirSync(partsDir, { recursive: true });

  // v1.11：段间并行渲染（受 maxParallelSegments 限制）
  //  - 每个段内 renderMedia 仍开自己的 concurrency=16，CPU 已吃满
  //  - 所以段间并行度不能太高，避免相互抢资源反而变慢
  //  - 公式：保留 ~6 核给系统 + 每段预留 ~3 核作为 chunk 并行预算
  const cpuCount = Math.max(1, os.cpus()?.length || 1);
  const maxParallelSegments = Math.max(
    1,
    Math.min(segments.length, Math.floor((cpuCount - 4) / 3))
  );
  opts.onLog?.(`[batch] 段间并行: cpu=${cpuCount} → maxParallelSegments=${maxParallelSegments}`);

  // 渲染每段（受并发上限限制）
  const renderedParts = new Array(segments.length);
  let nextIdx = 0;
  let failed = null;

  const worker = async (workerId) => {
    while (!failed) {
      const i = nextIdx++;
      if (i >= segments.length) return;
      const segShots = segments[i];
      const partPath = join(partsDir, `part_${String(i + 1).padStart(3, '0')}.mp4`);
      opts.onLog?.(`[batch][w${workerId}] 第 ${i + 1}/${segments.length} 段: ${segShots.length} 个镜头 → ${partPath}`);
      try {
        const result = await renderSegment(segShots, partPath);
        renderedParts[i] = { path: partPath, durationSec: result.durationSec };
      } catch (e) {
        opts.onLog?.(`[batch][w${workerId}] 第 ${i + 1} 段失败: ${e.message}`);
        failed = new Error(`分批渲染第 ${i + 1}/${segments.length} 段失败: ${e.message}`);
        return;
      }
    }
  };

  const workers = Array.from({ length: maxParallelSegments }, (_, k) => worker(k + 1));
  await Promise.all(workers);
  if (failed) throw failed;

  // 过滤掉空槽（防御性，正常情况不会发生）
  const validParts = renderedParts.filter(Boolean);

  // 拼接
  const finalPath = join(opts.outputDir, `${taskId}.mp4`);
  opts.onLog?.(`[batch] 拼接 ${validParts.length} 段 → ${finalPath}`);
  await concatMp4(validParts.map((p) => p.path), finalPath, opts.onLog);

  // 清理 parts（保留最后一段用于排查）
  try {
    for (let i = 0; i < validParts.length - 1; i++) {
      rmSync(validParts[i].path, { force: true });
    }
  } catch {
    /* ignore */
  }

  return {
    segmentCount: validParts.length,
    segments: validParts.map((p, i) => ({
      index: i,
      shots: segments[i],
      path: p.path,
      durationSec: p.durationSec,
    })),
    finalPath,
    totalDurationSec: validParts.reduce((sum, p) => sum + p.durationSec, 0),
  };
}

export { splitShotsIntoSegments, estimateTotalDuration, estimateShotDuration, checkFfmpeg, concatMp4 };
