/**
 * Remotion Player 入口（仅浏览器端预览使用）
 * - 用 React.lazy 加载，避免主包膨胀
 * - 支持通过 ref.seekToFrame(frame) 和 ref.seekToShot(shotId) 跳转
 */
import { Player, type PlayerRef } from '@remotion/player';
import { useMemo, useRef, useImperativeHandle, forwardRef, type CSSProperties } from 'react';
import { MyVideo } from '../remotion/src/compositions/MyVideo';
import { RemotionInputProps, getShotDuration, parseResolution } from '../remotion/src/types';

interface RemotionPreviewProps {
  shots: RemotionInputProps['shots'];
  config: RemotionInputProps['config'];
  style?: CSSProperties;
}

export interface RemotionPreviewRef {
  seekToFrame: (frame: number) => void;
  /** 跳到指定镜头的起始帧 */
  seekToShot: (shotId: string) => void;
  /** 获取当前播放帧 */
  getCurrentFrame: () => number;
}

interface ShotFrameMap {
  shotId: string;
  startFrame: number;
  durationFrames: number;
}

/**
 * 计算每个镜头在整体时间轴上的帧范围（与 MyVideo.tsx segments 逻辑一致）
 */
function buildShotFrameMap(
  shots: RemotionInputProps['shots'],
  fps: number,
  transitionGlobal: string,
  transitionSec: number,
  introSec: number,
): ShotFrameMap[] {
  const transitionFrames = transitionGlobal !== 'none' ? Math.round(transitionSec * fps) : 0;
  const out: ShotFrameMap[] = [];
  let cursor = 0;
  const introFrames = Math.round(introSec * fps);

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const duration = getShotDuration(shot);
    let durationFrames = Math.max(1, Math.round(duration * fps));

    const ti = (shot.transitionIn as any) || transitionGlobal;
    const to = (shot.transitionOut as any) || transitionGlobal;
    const effTf = Math.min(transitionFrames, Math.floor(durationFrames / 2));

    const prev = i > 0 ? shots[i - 1] : null;
    const prevOut = prev ? ((prev as any).transitionOut as any) || transitionGlobal : 'none';
    const canOverlap = i > 0 && prevOut !== 'none' && ti !== 'none';
    const leadInFrames = canOverlap ? effTf : 0;

    out.push({
      shotId: shot.id,
      startFrame: cursor + introFrames,  // 片头偏移
      durationFrames,
    });
    cursor += Math.max(1, durationFrames - leadInFrames);
  }
  return out;
}

/**
 * 浏览器内预览组件（不渲染 MP4，实时播放）
 * - 支持 ref.seekToFrame() / ref.seekToShot() 跳转
 */
export const RemotionPreview = forwardRef<RemotionPreviewRef, RemotionPreviewProps>(
  ({ shots, config, style }, ref) => {
    const playerRef = useRef<PlayerRef>(null);

    const fps = config.fps || 30;
    const { width, height } = parseResolution(config.resolution);

    // 片头时长
    const INTRO_DURATIONS: Record<string, number> = {
      fade_in: 2.5, slide_up: 2.0, typewriter: 3.5,
      glitch: 2.0, zoom_in: 2.0, split: 2.5,
    };
    const introSec = config.intro?.style && config.intro.style !== 'none'
      ? (config.intro.duration ?? INTRO_DURATIONS[config.intro.style] ?? 2.0)
      : 0;

    // 总视觉时长（与 MyVideo.tsx 一致）
    const totalDurationSec = useMemo(() => {
      const transitionGlobal = config.transition?.type ?? 'fade';
      const transitionSec = config.transition?.duration ?? 0.4;
      const transitionFrames = transitionGlobal !== 'none' ? Math.round(transitionSec * fps) : 0;
      const totalAudio = shots.reduce((sum, s) => sum + getShotDuration(s), 0);
      const overlapFrames = transitionFrames > 0 ? Math.max(0, shots.length - 1) * transitionFrames / fps : 0;
      return introSec + Math.max(0, totalAudio - overlapFrames);
    }, [shots, config.transition, fps, introSec]);

    // 每镜头帧映射（用于 seekToShot）
    const shotFrameMap = useMemo(
      () => buildShotFrameMap(shots, fps, config.transition?.type ?? 'fade', config.transition?.duration ?? 0.4, introSec),
      [shots, fps, config.transition, introSec],
    );

    // 暴露方法给父组件
    useImperativeHandle(ref, () => ({
      seekToFrame(frame: number) {
        playerRef.current?.seekToFrame(frame);
      },
      seekToShot(shotId: string) {
        const entry = shotFrameMap.find(s => s.shotId === shotId);
        if (entry) {
          playerRef.current?.seekToFrame(entry.startFrame);
        }
      },
      getCurrentFrame() {
        return playerRef.current?.getCurrentFrame() ?? 0;
      },
    }), [shotFrameMap]);

    if (totalDurationSec === 0) {
      return (
        <div style={{ background: '#000', color: '#888', padding: 24, ...style }}>
          请先生成镜头后再预览
        </div>
      );
    }

    return (
      <div style={style}>
        <Player
          ref={playerRef}
          component={MyVideo}
          inputProps={{ shots, config }}
          durationInFrames={Math.ceil(totalDurationSec * fps)}
          compositionWidth={width}
          compositionHeight={height}
          fps={fps}
          controls
          style={{ width: '100%', maxWidth: 720 }}
        />
      </div>
    );
  },
);
RemotionPreview.displayName = 'RemotionPreview';
