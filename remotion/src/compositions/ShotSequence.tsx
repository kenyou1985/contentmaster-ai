import { interpolate, useCurrentFrame, useVideoConfig, AbsoluteFill } from 'remotion';
import type { CSSProperties, ReactNode } from 'react';
import { ShotLayer } from './ShotLayer';
import { RemotionInputShot, RemotionInputVideoFilter, TransitionType } from '../types';

export type { TransitionType } from '../types';

export interface ShotSequenceProps {
  shot: RemotionInputShot;
  durationInFrames: number;
  transitionIn: TransitionType;
  transitionOut: TransitionType;
  transitionFrames: number;     // 半个转场占多少帧（重叠 = 2x）
  /** 全局运动预设（来自 config.motion） */
  globalMotion?: string;
  /** 全局滤镜配置（来自 config.videoFilter） */
  globalFilter?: RemotionInputVideoFilter;
}

/**
 * 计算从父级传入的相对 frame 与镜头内 phase
 * - 当父级 Sequence 重叠时，本组件的 useCurrentFrame 会从 -overlap 开始递增
 * - 我们用它来判断：phase 是 enter / normal / exit
 */
function useShotPhase(durationInFrames: number, overlap: number) {
  const frame = useCurrentFrame();

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
 * 构建转场效果样式
 * 返回 { containerStyle, overlayStyle }：
 * - containerStyle: 应用于 AbsoluteFill 容器（透明度/整体缩放）
 * - overlayStyle: 应用于上方覆盖层（黑色遮罩/方向光圈/水波纹等）
 */
function buildTransitionStyle(
  transition: TransitionType,
  phase: 'enter' | 'exit' | 'normal' | 'before' | 'after',
  t: number,
  width: number,
  height: number,
): { containerStyle: CSSProperties; overlayStyle: CSSProperties | null } {
  if (transition === 'none') return { containerStyle: {}, overlayStyle: null };
  if (phase !== 'enter' && phase !== 'exit') return { containerStyle: {}, overlayStyle: null };

  // enter: t 0→1 表示进入进度；exit: t 1→0 表示保持进度
  // 让所有转场都遵循"覆盖关系"语义：入场 (phase=enter) 时本镜头从无到有
  const p = phase === 'enter' ? t : 1 - t;
  const clamped = Math.max(0, Math.min(1, p));

  // ────────── 基础：淡入淡出 / 滑动 / 缩放 ──────────
  if (transition === 'fade') {
    return { containerStyle: { opacity: clamped }, overlayStyle: null };
  }
  if (transition === 'slide') {
    const dir = phase === 'enter' ? 1 : -1;
    return {
      containerStyle: {
        opacity: clamped,
        transform: `translateX(${(1 - clamped) * dir * width * 0.15}px)`,
      },
      overlayStyle: null,
    };
  }

  // ────────── 新增：擦除（Wipe） ──────────
  // 入场：黑色遮罩从一侧擦除，露出新画面
  if (transition === 'wipe') {
    // 用 clip-path 实现（enter：从右→左，exit：从左→右）
    const side = phase === 'enter' ? 'right' : 'left';
    return {
      containerStyle: { opacity: 1 },
      overlayStyle: {
        background: '#000',
        position: 'absolute',
        inset: 0,
        clipPath:
          side === 'right'
            ? `inset(0 0 0 ${clamped * 100}%)`
            : `inset(0 ${(1 - clamped) * 100}% 0 0)`,
      },
    };
  }

  // ────────── 新增：3D 翻转（Flip） ──────────
  if (transition === 'flip') {
    const rotateY = phase === 'enter' ? (1 - clamped) * 90 : -(1 - clamped) * 90;
    return {
      containerStyle: {
        opacity: clamped > 0.1 ? 1 : 0,
        transform: `perspective(${width}px) rotateY(${rotateY}deg)`,
        transformOrigin: 'center center',
      },
      overlayStyle: null,
    };
  }

  // ────────── 新增：时钟擦除（ClockWipe） ──────────
  // 入场：黑色圆饼从 0° 顺时针扫到 360°，露出画面
  if (transition === 'clockWipe') {
    const angle = clamped * 360;
    return {
      containerStyle: { opacity: 1 },
      overlayStyle: {
        background: '#000',
        position: 'absolute',
        inset: 0,
        clipPath: `inset(0 0 0 0)`,
        backgroundImage: `conic-gradient(from -90deg, #000 0deg, #000 ${angle}deg, transparent ${angle}deg)`,
      },
    };
  }

  // ────────── 新增：光圈揭开（Iris） ──────────
  // 入场：从中心 0% 放大到 100%，圆形展开新画面
  if (transition === 'iris') {
    const radius = clamped * 150;
    return {
      containerStyle: {
        opacity: 1,
        clipPath: `circle(${radius}% at 50% 50%)`,
      },
      overlayStyle: null,
    };
  }

  // ────────── 新增：缩放模糊（ZoomBlur） ──────────
  // 入场：从模糊大尺寸快速聚焦到清晰
  if (transition === 'zoomBlur') {
    const scale = 1.4 - clamped * 0.4;
    const blur = (1 - clamped) * 18;
    return {
      containerStyle: {
        opacity: clamped,
        transform: `scale(${scale})`,
        filter: `blur(${blur}px)`,
      },
      overlayStyle: null,
    };
  }

  // ────────── 新增：梦幻缩放（DreamyZoom） ──────────
  // 入场：白光闪烁 + 缩放聚焦
  if (transition === 'dreamyZoom') {
    const scale = 0.5 + clamped * 0.5;
    // 闪烁：在中间点达到峰值白光
    const flash = Math.sin(clamped * Math.PI);
    return {
      containerStyle: {
        opacity: clamped,
        transform: `scale(${scale})`,
      },
      overlayStyle: {
        position: 'absolute',
        inset: 0,
        background: '#fff',
        opacity: flash * 0.55,
        pointerEvents: 'none',
      },
    };
  }

  // ────────── 新增：交叉缩放（CrossZoom） ──────────
  // 入场：旧画面缩小 + 新画面放大同时发生（用 scale 实现）
  if (transition === 'crossZoom') {
    const scale = 0.4 + clamped * 0.6;
    return {
      containerStyle: {
        opacity: clamped,
        transform: `scale(${scale})`,
      },
      overlayStyle: null,
    };
  }

  // ────────── 新增：电影灼烧（FilmBurn） ──────────
  // 入场：橙红色火光从中心燃烧扩散开来
  if (transition === 'filmBurn') {
    const fadeAlpha = Math.sin(clamped * Math.PI);
    return {
      containerStyle: { opacity: clamped },
      overlayStyle: {
        position: 'absolute',
        inset: 0,
        background:
          'radial-gradient(circle at 50% 50%, rgba(255,140,40,0.85) 0%, rgba(255,80,0,0.5) 30%, transparent 70%)',
        opacity: fadeAlpha,
        mixBlendMode: 'screen',
        pointerEvents: 'none',
      },
    };
  }

  // ────────── 新增：水波纹（Ripple） ──────────
  // 入场：从中心向外的环形涟漪，模拟水波扩散
  if (transition === 'ripple') {
    const waveSize = (1 - clamped) * 200;
    return {
      containerStyle: { opacity: clamped },
      overlayStyle: {
        position: 'absolute',
        inset: 0,
        background: `radial-gradient(circle at 50% 50%, transparent ${waveSize}%, rgba(0,0,0,0.4) ${waveSize + 5}%, transparent ${waveSize + 10}%)`,
        opacity: 1 - clamped,
        pointerEvents: 'none',
      },
    };
  }

  // ────────── 新增：推切（PushCut） ──────────
  // 入场：硬切带闪光冲击
  if (transition === 'pushCut') {
    const flash = Math.sin(clamped * Math.PI);
    return {
      containerStyle: { opacity: clamped },
      overlayStyle: {
        position: 'absolute',
        inset: 0,
        background: '#fff',
        opacity: flash * 0.7,
        mixBlendMode: 'screen',
        pointerEvents: 'none',
      },
    };
  }

  // ────────── 新增：像素溶解（Dissolve） ──────────
  // 入场：噪点化消散，逐渐显形
  if (transition === 'dissolve') {
    return {
      containerStyle: { opacity: clamped },
      overlayStyle: {
        position: 'absolute',
        inset: 0,
        backdropFilter: `contrast(${(1 - clamped) * 200}%)`,
        background: `repeating-radial-gradient(circle at 50% 50%, rgba(255,255,255,${(1 - clamped) * 0.7}) 0 1px, transparent 1px ${4 + clamped * 8}px)`,
        mixBlendMode: 'overlay',
        opacity: 1 - clamped,
        pointerEvents: 'none',
      },
    };
  }

  // ────────── 兼容性：zoom 视为 crossZoom 别名 ──────────
  if (transition === 'zoom') {
    const scale = 0.92 + clamped * 0.08;
    return {
      containerStyle: { opacity: clamped, transform: `scale(${scale})` },
      overlayStyle: null,
    };
  }

  return { containerStyle: { opacity: clamped }, overlayStyle: null };
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
  globalFilter,
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

  const { containerStyle, overlayStyle } = buildTransitionStyle(
    effective,
    stylePhase,
    styleT,
    width,
    height,
  );

  return (
    <AbsoluteFill style={containerStyle}>
      <ShotLayer
        shot={shot}
        durationInFrames={durationInFrames}
        globalMotion={globalMotion}
        globalFilter={globalFilter}
      />
      {overlayStyle && <div style={overlayStyle} />}
    </AbsoluteFill>
  );
};
