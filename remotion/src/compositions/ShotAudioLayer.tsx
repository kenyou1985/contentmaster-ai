import {
  Sequence,
  Audio,
  useCurrentFrame,
  interpolate,
  staticFile,
} from 'remotion';

interface ShotAudioLayerProps {
  url: string;
  /** 音频开始帧（绝对时间轴）—— 由 MyVideo 计算，
   *  保证每个镜头音频在前一个镜头音频结束后立即开始（不重叠） */
  startFrame: number;
  /** 音频应该播完的帧数 */
  audioDurationFrames: number;
}

/**
 * 镜头音频层（严格不重叠方案）
 *
 * 设计原则：
 * - 音频 Sequence from = startFrame（由 MyVideo 计算，前一个音频结束的位置）
 * - duration = audioDurationFrames（不延长，让音频完整播完）
 * - 不做 crossfade，不提前进入下一个镜头
 *
 * 解决的问题：
 *   1. 音频文件开头/末尾完整保留（"今天"等字不能丢）
 *   2. 镜头切换时不会出现末尾音频和开头音频重叠（用户反馈的核心问题）
 *
 * 副作用：
 *   - B 镜头音频比 B 镜头视频晚 leadIn 帧开始（视频视觉转场期间先静音）
 *   - 听感：B 视频画面先出现 ~0.4s 后才有新音频，可接受
 *
 * 末尾 fadeOut：
 *   - 仅在最后 3 帧做微幅 fadeOut（1 → 0.85），防止 pop 噪音
 *   - 不切掉任何内容，只是音量微降
 */
export const ShotAudioLayer: React.FC<ShotAudioLayerProps> = ({
  url,
  startFrame,
  audioDurationFrames,
}) => {
  const src = resolveMediaUrl(url);

  return (
    <Sequence from={startFrame} durationInFrames={audioDurationFrames}>
      <ShotAudioVolume
        src={src}
        audioDurationFrames={audioDurationFrames}
        fadeOutFrames={Math.min(3, Math.max(1, Math.floor(audioDurationFrames * 0.05)))}
      />
    </Sequence>
  );
};

const ShotAudioVolume: React.FC<{
  src: string;
  audioDurationFrames: number;
  fadeOutFrames: number;
}> = ({ src, audioDurationFrames, fadeOutFrames }) => {
  const frame = useCurrentFrame();

  let volume = 1;

  // 末尾短 fadeOut：音量从 1 → 0.85（不是 0！）避免 pop 噪音
  if (frame >= audioDurationFrames - fadeOutFrames) {
    volume = interpolate(
      frame,
      [audioDurationFrames - fadeOutFrames, audioDurationFrames],
      [1, 0.85],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
    );
  }

  return <Audio src={src} volume={Math.max(0, Math.min(1, volume))} />;
};

function resolveMediaUrl(url: string): string {
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
