import { interpolate, useCurrentFrame, useVideoConfig, AbsoluteFill } from 'remotion';
import type { CSSProperties, ReactNode } from 'react';
import { ShotLayer } from './ShotLayer';
import { RemotionInputShot } from '../types';

export type TransitionType = 'none' | 'fade' | 'slide' | 'zoom';

export interface ShotSequenceProps {
  shot: RemotionInputShot;
  durationInFrames: number;
  transitionIn: TransitionType;
  transitionOut: TransitionType;
  transitionFrames: number;     // 半个转场占多少帧（重叠 = 2x）
  /** 全局运动预设（来自 config.motion） */
  globalMotion?: string;
}

/**
 * 计算从父级传入的相对 frame 与镜头内 phase
 * - 当父级 Sequence 重叠时，本组件的 useCurrentFrame 会从 -overlap 开始递增
 * - 我们用它来判断：phase 是 enter / normal / exit
 */
function useShotPhase(durationInFrames: number, overlap: number) {
  const frame = useCurrentFrame();
  const { durationInFrames: parent } = useVideoConfig();

  // 相对镜头自身的 0 .. durationInFrames
  const local = frame;

  if (local < 0) return { phase: 'before' as const, local, t: 0 };
  if (local >= durationInFrames) return { phase: 'after' as const, local, t: 1 };

  // 入场（仅最前 overlap 帧内做效果）
  if (local < overlap) {
    return { phase: 'enter' as const, local, t: local / overlap };
  }
  // 出场
  if (local > durationInFrames - overlap) {
    const tExit = (durationInFrames - local) / overlap;
    return { phase: 'exit' as const, local, t: tExit };
  }
  return { phase: 'normal' as const, local, t: 1 };
}

/**
 * 通用转场样式：fade / slide / zoom
 * 输入：phase（enter/exit）、transition 类型、t（0..1 进度）
 */
function buildTransitionStyle(
  transition: TransitionType,
  phase: 'enter' | 'exit' | 'normal' | 'before' | 'after',
  t: number,
  width: number,
  height: number,
): CSSProperties {
  if (transition === 'none') return {};
  if (phase !== 'enter' && phase !== 'exit') return {};

  // enter: t 0→1 表示进入进度；exit: t 1→0 表示保持进度
  const p = phase === 'enter' ? t : 1 - t;
  const clamped = Math.max(0, Math.min(1, p));

  if (transition === 'fade') {
    return { opacity: clamped };
  }
  if (transition === 'slide') {
    const dir = phase === 'enter' ? 1 : -1;
    return {
      opacity: clamped,
      transform: `translateX(${(1 - clamped) * dir * width * 0.08}px)`,
    };
  }
  if (transition === 'zoom') {
    const scale = 0.92 + clamped * 0.08;
    return {
      opacity: clamped,
      transform: `scale(${scale})`,
    };
  }
  return {};
}

/**
 * 单镜头 Sequence（含转场）
 * - 父级应当重叠放置（overlap = transitionFrames * 2）
 * - 本组件根据 local frame 自动判断 enter/normal/exit
 */
export const ShotSequence: React.FC<ShotSequenceProps> = ({
  shot,
  durationInFrames,
  transitionIn,
  transitionOut,
  transitionFrames,
  globalMotion,
}) => {
  const { width, height } = useVideoConfig();
  const overlap = Math.max(0, Math.min(transitionFrames, Math.floor(durationInFrames / 2)));

  // 注：transitionIn/out 在 overlap 区域生效
  // 我们取两种转场的"合并"transform 简化为：进、出各占一半 overlap
  const { phase, t } = useShotPhase(durationInFrames, overlap);

  // 在前 overlap 区段：apply transitionIn（enter 方向）
  // 在后 overlap 区段：apply transitionOut（exit 方向）
  let effective: TransitionType = 'none';
  let styleT = t;
  let stylePhase: 'enter' | 'exit' | 'normal' = 'normal';
  if (phase === 'enter' && transitionIn !== 'none') {
    effective = transitionIn;
    stylePhase = 'enter';
    styleT = t;
  } else if (phase === 'exit' && transitionOut !== 'none') {
    effective = transitionOut;
    stylePhase = 'exit';
    styleT = t;
  }

  const transitionStyle = buildTransitionStyle(effective, stylePhase, styleT, width, height);

  return (
    <AbsoluteFill style={transitionStyle}>
      <ShotLayer shot={shot} durationInFrames={durationInFrames} globalMotion={globalMotion} />
    </AbsoluteFill>
  );
};