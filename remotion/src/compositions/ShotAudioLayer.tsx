import {
  Sequence,
  Audio,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  staticFile,
} from 'remotion';

interface ShotAudioLayerProps {
  url: string;
  /** 音频真正的开始帧（绝对时间轴） */
  startFrame: number;
  /** leadIn 帧数：本镜头末尾被下一镜头覆盖的帧数；当前镜头音频在这段做 fadeOut */
  leadInFrames: number;
  /** leadOut 帧数：本镜头开头被上一镜头覆盖的帧数；本镜头音频用 leadOut 帧做 fadeIn */
  leadOutFrames?: number;
  /** 总时长（音频应该播完的帧数） */
  audioDurationFrames: number;
}

/**
 * 镜头音频层
 *
 * 关键设计：音频 Sequence 必须从 startFrame 开始播放音频文件 0 帧，
 * 这样音频文件开头不丢失任何内容（用户反馈："今天"两个字不能丢）。
 *
 * 实现方案（最保守、最稳）：
 * - 音频 Sequence from = startFrame（严格与视频画面同步）
 * - duration = audioDurationFrames + leadInFrames（让音频在 leadIn 区段继续播）
 * - 第一镜头：从 frame 0 全音量 1.0，不做任何 fadeIn
 * - 中间镜头：在 leadIn 区段（Sequence 内最后 leadIn 帧）做 fadeOut（音量 1→0）
 * - 最后一镜头：末尾做 fadeOut 防止突然结束
 *
 * 不做音频 crossfade（不重叠、不提前下一镜头音频）：
 * - 镜头切换时音频硬切，听感可能有"咔哒"，但音频文件完整播放
 * - 如需更平滑的听感，可调整：让下一个镜头的 BGM 音量在转场期间降下来
 */
export const ShotAudioLayer: React.FC<ShotAudioLayerProps> = ({
  url,
  startFrame,
  leadInFrames,
  leadOutFrames = 0,
  audioDurationFrames,
}) => {
  const { fps } = useVideoConfig();

  // Sequence duration：含主体 + leadIn（让音频在末尾 leadIn 区段继续播完）
  const sequenceDuration = audioDurationFrames + leadInFrames;
  const src = resolveMediaUrl(url);

  return (
    <Sequence from={startFrame} durationInFrames={sequenceDuration}>
      <ShotAudioVolume
        src={src}
        audioDurationFrames={audioDurationFrames}
        leadInFrames={leadInFrames}
        crossfadeFrames={Math.max(6, Math.min(Math.round(fps * 1.0), Math.round(leadInFrames * 0.4)))}
        isFirstShot
        isLastShot={leadInFrames === 0}
      />
    </Sequence>
  );
};

const ShotAudioVolume: React.FC<{
  src: string;
  audioDurationFrames: number;
  leadInFrames: number;
  crossfadeFrames: number;
  isFirstShot: boolean;
  isLastShot: boolean;
}> = ({ src, audioDurationFrames, leadInFrames, crossfadeFrames, isFirstShot, isLastShot }) => {
  const frame = useCurrentFrame();

  let volume = 1;

  // 主区段 [0, audioDurationFrames)：全音量 1
  // leadIn 区段 [audioDurationFrames, audioDurationFrames + leadInFrames)：fadeOut
  if (frame >= audioDurationFrames && leadInFrames > 0 && !isLastShot) {
    volume = interpolate(frame, [audioDurationFrames, audioDurationFrames + leadInFrames], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  } else if (isLastShot && !isFirstShot && audioDurationFrames - frame < crossfadeFrames) {
    // 最后一镜头：末尾 fadeOut
    volume = interpolate(
      frame,
      [audioDurationFrames - crossfadeFrames, audioDurationFrames],
      [1, 0],
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
