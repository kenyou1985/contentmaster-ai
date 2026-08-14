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
  /** leadIn 帧数（视觉提前进的帧）；音频在此区段做淡出，给下一镜头让位 */
  leadInFrames: number;
  /** 后置 leadOut 帧数（视觉延迟的帧）；音频在此区段做淡入 */
  leadOutFrames?: number;
  /** 总时长（音频应该播完的帧数） */
  audioDurationFrames: number;
}

/**
 * 镜头音频层（独立 Sequence，不受视频 leadIn 重叠影响）
 *
 * 问题背景：
 * - 视频镜头 Sequence 会向后一个镜头 leadIn 推进（音频序列也跟着）
 *   当后一个镜头也是 Sequence 时，两个 Sequence 在 leadIn 区段都在播各自的音频，
 *   导致末尾声音和开头声音叠加，听感很差
 *
 * 解法：
 * - 音频从视频 Sequence 抽出来，单独挂在顶层 Sequence 上
 * - 音频 Sequence 的 from = startFrame（不提前 leadIn 帧进入音频）
 * - duration = audioDurationFrames + leadInFrames（让音频完整播完，自己的尾段继续播
 *   一会直到下一镜头接管，再做 fadeOut）
 * - 在 leadIn 区段对当前镜头音频做 fadeOut，下一镜头从 leadOut 段做 fadeIn
 *   形成 crossfade
 */
export const ShotAudioLayer: React.FC<ShotAudioLayerProps> = ({
  url,
  startFrame,
  leadInFrames,
  leadOutFrames = 0,
  audioDurationFrames,
}) => {
  const { fps } = useVideoConfig();

  // crossfade 时长：转场长度的 40%（不超过 1s，至少 6 帧）
  const audioCrossfadeFrames = Math.max(
    6,
    Math.min(Math.round(fps * 1.0), Math.round((leadInFrames + leadOutFrames) * 0.4)),
  );

  const sequenceDuration = audioDurationFrames + leadInFrames + leadOutFrames;

  const src = resolveMediaUrl(url);

  return (
    <Sequence from={startFrame - leadOutFrames} durationInFrames={sequenceDuration}>
      <ShotAudioVolume
        src={src}
        audioDurationFrames={audioDurationFrames}
        leadInFrames={leadInFrames}
        leadOutFrames={leadOutFrames}
        crossfadeFrames={audioCrossfadeFrames}
        isFirstShot={leadOutFrames === 0}
        isLastShot={leadInFrames === 0}
      />
    </Sequence>
  );
};

const ShotAudioVolume: React.FC<{
  src: string;
  audioDurationFrames: number;
  leadInFrames: number;
  leadOutFrames: number;
  crossfadeFrames: number;
  isFirstShot: boolean;
  isLastShot: boolean;
}> = ({ src, audioDurationFrames, leadInFrames, leadOutFrames, crossfadeFrames, isFirstShot, isLastShot }) => {
  const frame = useCurrentFrame();

  let volume = 1;

  // ── leadOut 区间 [-leadOutFrames, 0)：从 0 升到 1 ─────────────────
  if (frame < 0) {
    if (leadOutFrames > 0) {
      volume = interpolate(frame, [-leadOutFrames, 0], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
    } else {
      volume = 0;
    }
  }
  // ── leadIn 区间 [audioDurationFrames, audioDurationFrames+leadInFrames)：从 1 降到 0 ──
  else if (frame >= audioDurationFrames) {
    if (leadInFrames > 0) {
      volume = interpolate(frame, [audioDurationFrames, audioDurationFrames + leadInFrames], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
    } else {
      volume = 0;
    }
  }
  // ── 主区间 [0, audioDurationFrames)：完整播放音频 ────────────────
  else {
    volume = 1;
    // 中间镜头（既不是第一也不是最后）做完整 crossfade：
    //   - 头 crossfadeFrames 帧从 0 升到 1（从上一镜头 crossfade 进入）
    //   - 尾 crossfadeFrames 帧从 1 降到 0（向下一镜头 crossfade 出去）
    if (!isFirstShot && !isLastShot && frame < crossfadeFrames) {
      // 头 fadeIn：从 0 升到 1
      volume = interpolate(frame, [0, crossfadeFrames], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
    }
    if (!isFirstShot && !isLastShot && audioDurationFrames - frame < crossfadeFrames) {
      // 尾 fadeOut：从 1 降到 0
      const fadeOut = interpolate(
        frame,
        [audioDurationFrames - crossfadeFrames, audioDurationFrames],
        [1, 0],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
      );
      volume = Math.min(volume, fadeOut);
    }
    // 最后一个镜头：仅做尾部 fadeOut（无下一镜头）
    if (isLastShot && !isFirstShot && audioDurationFrames - frame < crossfadeFrames) {
      const fadeOut = interpolate(
        frame,
        [audioDurationFrames - crossfadeFrames, audioDurationFrames],
        [1, 0],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
      );
      volume = Math.min(volume, fadeOut);
    }
    // 第一个镜头：保持 volume = 1，从 frame 0 就是全音量
    // 不做 fadeIn —— 否则开头音频会被切掉一部分（用户反馈：漏掉"今天"）
    // 如果用户希望有片头 → 第一镜头的渐变效果，请通过 BGM 淡入或镜头淡入实现
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
