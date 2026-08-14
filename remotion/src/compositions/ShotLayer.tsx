import {
  AbsoluteFill,
  Img,
  Video,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Audio,
  staticFile,
} from 'remotion';
import { RemotionInputShot, RemotionInputVideoFilter } from '../types';

interface ShotLayerProps {
  shot: RemotionInputShot;
  durationInFrames: number;
  /** 全局运动预设（来自 config.motion），优先级低于 shot.motion */
  globalMotion?: string;
  /** 全局滤镜配置（来自 config.videoFilter） */
  globalFilter?: RemotionInputVideoFilter;
}

// ── 工具函数 ───────────────────────────────────────────────────────────────

/**
 * 把 mmedia/... 路径转换为 staticFile URL
 */
function resolveMediaUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (
    url.startsWith('data:') ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('blob:')
  ) {
    return url;
  }
  try {
    return staticFile(url);
  } catch {
    return url;
  }
}

/**
 * 合并全局 + 镜头级滤镜，镜头级优先覆盖
 */
function mergeFilter(
  global: RemotionInputVideoFilter | undefined,
  shot: RemotionInputVideoFilter | undefined,
): RemotionInputVideoFilter | undefined {
  if (!global && !shot) return undefined;
  return { ...global, ...shot };
}

// ── CSS Filter 字符串构建 ─────────────────────────────────────────────────

/**
 * 根据滤镜配置构建 CSS filter 字符串
 * 用于 Img.style.filter 和 Video.style.filter
 */
function buildCssFilter(filter: RemotionInputVideoFilter | undefined): string | undefined {
  if (!filter) return undefined;

  const parts: string[] = [];

  if (filter.brightness != null && filter.brightness !== 1) {
    parts.push(`brightness(${filter.brightness})`);
  }
  if (filter.contrast != null && filter.contrast !== 1) {
    parts.push(`contrast(${filter.contrast})`);
  }
  if (filter.saturation != null && filter.saturation !== 1) {
    parts.push(`saturate(${filter.saturation})`);
  }
  if (filter.exposure != null && filter.exposure !== 0) {
    // CSS exposure: stops = EV * 100%
    parts.push(`exposure(${1 + filter.exposure})`);
  }
  if (filter.grayscale != null && filter.grayscale > 0) {
    parts.push(`grayscale(${filter.grayscale})`);
  }
  if (filter.blur != null && filter.blur > 0) {
    parts.push(`blur(${filter.blur}px)`);
  }
  if (filter.hue != null && filter.hue !== 0) {
    parts.push(`hue-rotate(${filter.hue}deg)`);
  }

  return parts.length > 0 ? parts.join(' ') : undefined;
}

// ── 运动类型定义 ──────────────────────────────────────────────────────────

type MotionKey =
  | 'none'
  | 'kenBurns'
  | 'kenBurnsStrong'
  | 'kenBurnsSlow'
  | 'kenBurnsLinear'
  | 'zoomIn'
  | 'zoomOut'
  | 'panLeft'
  | 'panRight'
  | 'panUp'
  | 'panDown'
  | 'push'
  | 'pull'
  | 'rotateCW'
  | 'rotateCCW';

interface MotionParams {
  scaleFrom: number;
  scaleTo: number;
  rotateFrom: number;
  rotateTo: number;
  panXFrom: number;
  panXTo: number;
  panYFrom: number;
  panYTo: number;
}

/**
 * 返回运动插值参数
 * 所有运动全程覆盖镜头时长：帧 0 → from，帧 duration → to
 * 通过 interpolate([0, duration], [from, to]) 实现
 */
function getMotionParams(key: MotionKey): MotionParams {
  switch (key) {
    // 标准 Ken Burns：全程线性放大
    case 'kenBurns':
      return { scaleFrom: 1.0, scaleTo: 1.08, rotateFrom: 0, rotateTo: 0, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0 };
    // 强力 Ken Burns：全程明显放大
    case 'kenBurnsStrong':
      return { scaleFrom: 1.0, scaleTo: 1.35, rotateFrom: 0, rotateTo: 0, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0 };
    // 慢速 Ken Burns：全程超平滑放大
    case 'kenBurnsSlow':
      return { scaleFrom: 1.0, scaleTo: 1.12, rotateFrom: 0, rotateTo: 0, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0 };
    // 线性 Ken Burns：全程均匀线性放大（最纯粹的 interpolate）
    case 'kenBurnsLinear':
      return { scaleFrom: 1.0, scaleTo: 1.15, rotateFrom: 0, rotateTo: 0, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0 };
    // 持续放大
    case 'zoomIn':
      return { scaleFrom: 1.0, scaleTo: 1.4, rotateFrom: 0, rotateTo: 0, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0 };
    // 持续缩小
    case 'zoomOut':
      return { scaleFrom: 1.4, scaleTo: 1.0, rotateFrom: 0, rotateTo: 0, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0 };
    // 推入：从局部放大到全图，逐渐拉远
    case 'push':
      return { scaleFrom: 1.18, scaleTo: 1.0, rotateFrom: 0, rotateTo: 0, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0 };
    // 拉远：从全图缩小，逐渐拉近
    case 'pull':
      return { scaleFrom: 1.0, scaleTo: 1.18, rotateFrom: 0, rotateTo: 0, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0 };
    // 向上平移
    case 'panUp':
      return { scaleFrom: 1.08, scaleTo: 1.08, rotateFrom: 0, rotateTo: 0, panXFrom: 0, panXTo: 0, panYFrom: 60, panYTo: -60 };
    // 向下平移
    case 'panDown':
      return { scaleFrom: 1.08, scaleTo: 1.08, rotateFrom: 0, rotateTo: 0, panXFrom: 0, panXTo: 0, panYFrom: -60, panYTo: 60 };
    // 向左平移
    case 'panLeft':
      return { scaleFrom: 1.08, scaleTo: 1.08, rotateFrom: 0, rotateTo: 0, panXFrom: 60, panXTo: -60, panYFrom: 0, panYTo: 0 };
    // 向右平移
    case 'panRight':
      return { scaleFrom: 1.08, scaleTo: 1.08, rotateFrom: 0, rotateTo: 0, panXFrom: -60, panXTo: 60, panYFrom: 0, panYTo: 0 };
    // 顺时针持续旋转（全程 0°→5°）
    case 'rotateCW':
      return { scaleFrom: 1.05, scaleTo: 1.05, rotateFrom: 0, rotateTo: 5, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0 };
    // 逆时针持续旋转
    case 'rotateCCW':
      return { scaleFrom: 1.05, scaleTo: 1.05, rotateFrom: 0, rotateTo: -5, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0 };
    // 无运动 / 默认
    case 'none':
    default:
      return { scaleFrom: 1.0, scaleTo: 1.0, rotateFrom: 0, rotateTo: 0, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0 };
  }
}

// ── 单镜头渲染层 ────────────────────────────────────────────────────────

export const ShotLayer: React.FC<ShotLayerProps> = ({
  shot,
  durationInFrames,
  globalMotion,
  globalFilter,
}) => {
  const frame = useCurrentFrame();

  // 运动优先级：镜头级 > 全局级 > 默认 push
  const motionKey = (shot.motion as MotionKey) || (globalMotion as MotionKey) || 'push';

  // 合并滤镜（镜头级优先）
  const filter = mergeFilter(globalFilter, shot.videoFilter);
  const cssFilter = buildCssFilter(filter);

  // ── 运动插值（全程覆盖，不限 0..1）────────────────────────────────
  // interpolate([0, duration], [from, to])：帧 0 → from，帧 duration → to
  const params = getMotionParams(motionKey);
  const duration = durationInFrames;

  const scale = interpolate(
    frame,
    [0, duration],
    [params.scaleFrom, params.scaleTo],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  const rotateDeg = interpolate(
    frame,
    [0, duration],
    [params.rotateFrom, params.rotateTo],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  const panX = interpolate(
    frame,
    [0, duration],
    [params.panXFrom, params.panXTo],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  const panY = interpolate(
    frame,
    [0, duration],
    [params.panYFrom, params.panYTo],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  const transform = [
    `scale(${scale})`,
    rotateDeg !== 0 ? `rotate(${rotateDeg}deg)` : '',
    panX !== 0 ? `translateX(${panX}px)` : '',
    panY !== 0 ? `translateY(${panY}px)` : '',
  ]
    .filter(Boolean)
    .join(' ');

  // ── 视频镜头：滤镜 + 无运动 ────────────────────────────────────
  if (shot.videoUrl) {
    return (
      <AbsoluteFill>
        <Video
          src={resolveMediaUrl(shot.videoUrl)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: cssFilter,
          }}
          muted={false}
          volume={0}
        />
        {shot.audioUrl && <ShotAudio url={shot.audioUrl} />}
      </AbsoluteFill>
    );
  }

  // ── 图片镜头：运动动画 + 滤镜 ───────────────────────────────────
  const imageUrl = resolveMediaUrl(shot.imageUrl || shot.imageUrls?.[0]);
  if (!imageUrl) {
    return (
      <AbsoluteFill style={{ backgroundColor: '#111' }}>
        <div style={{ color: '#666', padding: 24 }}>Empty shot</div>
      </AbsoluteFill>
    );
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
          filter: cssFilter,
        }}
      />
      {shot.audioUrl && <ShotAudio url={shot.audioUrl} />}
    </AbsoluteFill>
  );
};

const ShotAudio: React.FC<{ url: string }> = ({ url }) => {
  return <Audio src={resolveMediaUrl(url) || url} volume={1} />;
};
