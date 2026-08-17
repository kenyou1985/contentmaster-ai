/**
 * Remotion 注册入口
 * - Vite/Renderer 通过 bundle 此文件来发现所有 compositions
 * - 这里把所有 Shot[] 转交给 MyVideo 组件，动态计算总帧数
 */
import { Composition, CalculateMetadataFunction, registerRoot } from 'remotion';
import { MyVideo } from './compositions/MyVideo';
import {
  RemotionInputProps,
  getShotDuration,
  parseResolution,
} from './types';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MyVideo"
        component={MyVideo}
        durationInFrames={300} // 由 calculateMetadata 动态替换
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          shots: [],
          config: {
            template: { id: 'default', name: '默认' },
            resolution: '1920x1080',
            fps: 30,
            codec: 'h264',
            bgm: { enabled: false, volume: 0.3, fadeIn: 1, fadeOut: 1, loop: true },
            subtitle: { enabled: true, style: 'default', position: 'bottom' },
            transition: { type: 'fade', duration: 0.5 },
            output: { target: 'browser' },
          },
        } as RemotionInputProps}
        calculateMetadata={calculateMetadata}
      />
    </>
  );
};

/**
 * 动态计算每条合成的帧数与分辨率
 * - 根据 shots 累加时长（考虑转场重叠 → 视觉时长 = Σaudio - Σoverlap）
 * - 根据 config.resolution 调整 width/height/fps
 * - 片头时长独立加在镜头序列之前
 */
const calculateMetadata: CalculateMetadataFunction<RemotionInputProps> = async ({
  props,
}) => {
  const { shots, config } = props;
  const fps = config?.fps || 30;

  // ── 片头时长 ──
  const intro = config?.intro;
  const introStyle = intro?.style;
  if (!introStyle || introStyle === 'none') {
    var introDurationSec = 0;
  } else {
    var introDurationSec: number;
    const PRESET_DURATIONS: Record<string, number> = {
      fade_in: 2.5,
      slide_up: 2.0,
      typewriter: 3.5,
      glitch: 2.0,
      zoom_in: 2.0,
      split: 2.5,
      slide_left: 2.0,
      rotate_in: 2.2,
      blur_focus: 2.4,
      flash_white: 1.8,
    };
    introDurationSec = intro?.duration ?? PRESET_DURATIONS[introStyle] ?? 2.0;
  }

  const totalAudioSec = shots.reduce((sum, s) => sum + getShotDuration(s), 0);
  const transitionGlobal = config?.transition?.type ?? 'fade';
  const transitionSec = config?.transition?.duration ?? 0.4;
  const transitionFrames = transitionGlobal !== 'none' ? Math.round(transitionSec * fps) : 0;
  // 视觉重叠：相邻镜头各失去 transitionFrames，最后一个镜头不受影响（全部时长保留）
  // 修正：原来算 (N-1)*frames，导致最后一个镜头时长被错误截断 → 音频截断
  const overlapFrames = transitionFrames > 0 && shots.length > 1
    ? Math.max(0, shots.length - 1) * transitionFrames
    : 0;
  const overlapSec = overlapFrames / fps;
  const shotsDurationSec = Math.max(0, totalAudioSec - overlapSec) + overlapSec;
  // ★ 关键修复：片头时长必须加进去，否则片头期间音频不播放 + 总时长短于实际
  const totalDurationSec = introDurationSec + shotsDurationSec;
  const { width, height } = parseResolution(config?.resolution || '1920x1080');

  return {
    durationInFrames: Math.max(1, Math.ceil(totalDurationSec * fps)),
    fps,
    width,
    height,
  };
};

// 注册根组件（Remotion 4.x 强制要求）
registerRoot(RemotionRoot);

