import { AbsoluteFill, Img, Video, useCurrentFrame, useVideoConfig, interpolate, spring, Audio, staticFile } from 'remotion';
import { RemotionInputShot } from '../types';

interface ShotLayerProps {
  shot: RemotionInputShot;
  durationInFrames: number;
  /** 全局运动预设（来自 config.motion），优先级低于 shot.motion */
  globalMotion?: string;
}

/**
 * 把 mmedia/... 路径转换为 staticFile URL
 * - data: URL 保持不变（Remotion 不需要转）
 * - http/https URL 保持不变
 * - 其他 → 尝试 staticFile()
 */
function resolveMediaUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:')) {
    return url;
  }
  try {
    return staticFile(url);
  } catch {
    return url;
  }
}

/**
 * 单镜头渲染层
 * - 优先使用视频（videoUrl）
 * - 否则使用图片（imageUrl / imageUrls[0]）并叠加运动动画
 * - 运动优先级：shot.motion > globalMotion > 'kenBurns'
 */
export const ShotLayer: React.FC<ShotLayerProps> = ({ shot, durationInFrames, globalMotion }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 运动优先级：镜头级 > 全局级 > 默认 push（推入）
  const rawMotion = shot.motion || globalMotion || 'push';
  // 统一映射：把 kenBurnsStrong/kenBurnsSlow 映射为内部 key
  const motionBase: string = rawMotion;

  // 视频优先（视频镜头忽略运动）
  if (shot.videoUrl) {
    return (
      <AbsoluteFill>
        <Video
          src={resolveMediaUrl(shot.videoUrl)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
          muted={false}
          volume={0}
        />
      </AbsoluteFill>
    );
  }

  // 图片：运动动画
  const imageUrl = resolveMediaUrl(shot.imageUrl || shot.imageUrls?.[0]);
  if (!imageUrl) {
    return (
      <AbsoluteFill style={{ backgroundColor: '#111' }}>
        <div style={{ color: '#666', padding: 24 }}>Empty shot</div>
      </AbsoluteFill>
    );
  }

  // ── 运动参数 ──────────────────────────────────────────────
  // scaleFrom / scaleTo 由运动类型决定
  let scaleFrom = 1.0;
  let scaleTo = 1.08; // 标准 Ken Burns
  let springConfig = { damping: 14, stiffness: 100, mass: 1 }; // 标准 ~0.3s
  let panDist = 40;

  switch (motionBase) {
    // 强力 Ken Burns：1.0→1.3，放大感更明显
    case 'kenBurnsStrong':
      scaleTo = 1.3;
      break;
    // 慢速 Ken Burns：更平滑的弹性（约 1s 完成）
    case 'kenBurnsSlow':
      scaleTo = 1.15;
      springConfig = { damping: 20, stiffness: 60, mass: 1.2 };
      break;
    // 单方向持续放大/缩小
    case 'zoomIn':
      scaleTo = 1.3;
      break;
    case 'zoomOut':
      scaleFrom = 1.3;
      scaleTo = 1.0;
      break;
    // 推：从局部放大到全图（逐渐拉远）
    case 'push':
      scaleFrom = 1.12;
      scaleTo = 1.0;
      break;
    // 拉：从全图缩小（逐渐拉近）
    case 'pull':
      scaleTo = 1.12;
      break;
    // 平移
    case 'panUp':
      scaleFrom = 1.05;
      scaleTo = 1.05;
      panDist = 60;
      break;
    case 'panDown':
      scaleFrom = 1.05;
      scaleTo = 1.05;
      panDist = 60;
      break;
    case 'panLeft':
      scaleFrom = 1.05;
      scaleTo = 1.05;
      panDist = 60;
      break;
    case 'panRight':
      scaleFrom = 1.05;
      scaleTo = 1.05;
      panDist = 60;
      break;
    // 无运动 / 默认
    case 'none':
    default:
      scaleFrom = 1.0;
      scaleTo = 1.0;
      break;
  }

  // 弹性进度（0→1）
  const springProgress = spring({ frame, fps, config: springConfig });
  const t = interpolate(springProgress, [0, 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const scaleVal = interpolate(t, [0, 1], [scaleFrom, scaleTo]);

  // 构建 transform
  let transform = `scale(${scaleVal})`;
  if (motionBase === 'panUp') {
    transform = `scale(1.05) translateY(${interpolate(t, [0, 1], [panDist, 0])}px)`;
  } else if (motionBase === 'panDown') {
    transform = `scale(1.05) translateY(${interpolate(t, [0, 1], [-panDist, 0])}px)`;
  } else if (motionBase === 'panLeft') {
    transform = `scale(1.05) translateX(${interpolate(t, [0, 1], [panDist, 0])}px)`;
  } else if (motionBase === 'panRight') {
    transform = `scale(1.05) translateX(${interpolate(t, [0, 1], [-panDist, 0])}px)`;
  }

  return (
    <AbsoluteFill>
      <Img
        src={imageUrl}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform,
          transformOrigin: 'center center',
        }}
      />
      {/* 音频：优先 audioUrl，否则 voiceoverAudioUrl */}
      {shot.audioUrl && <ShotAudio url={shot.audioUrl} />}
    </AbsoluteFill>
  );
};

const ShotAudio: React.FC<{ url: string }> = ({ url }) => {
  return <Audio src={resolveMediaUrl(url) || url} volume={1} />;
};
