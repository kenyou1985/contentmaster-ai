/**
 * 一键配音页：与一键成片镜头配音共用 RunningHub TTS + 可选云雾 gpt-5.4-mini 口播优化
 */

import {
  generateAudio,
  uploadAudioToRunningHub,
  resolveRunningHubOutputUrl,
} from './runninghubService';
import { polishTextForTtsSpeech, polishTextForTtsSpeechWithStyle } from './yunwuService';
import { getSelectedVoice, updateVoice } from './voiceLibraryService';

function isTextPrimarilyEnglish(text: string): boolean {
  if (!text || !text.trim()) return false;
  const latinChars = (text.match(/[A-Za-z]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;
  return totalChars > 0 && latinChars / totalChars > 0.3;
}

export type OneClickTtsProgressStage = 'polish' | 'tts';

export interface OneClickTtsOptions {
  yunwuApiKey?: string;
  skipLlmPolish?: boolean;
  trackPersona?: string;
  customHint?: string;
  speed?: number;
  emphasisStrength?: number;
  pitch?: number;
  /** 口播优化开始 / 进入 TTS 合成前回调，便于 UI 展示阶段与耗时 */
  onProgress?: (stage: OneClickTtsProgressStage) => void;
  /** 全流程日志（终端 UI），并行任务请在外部加任务名前缀 */
  onLog?: (message: string) => void;
}

/** @returns 可播放的绝对音频 URL */
export async function runOneClickTts(
  runningHubApiKey: string,
  rawText: string,
  opts?: OneClickTtsOptions
): Promise<{ audioUrl: string; speakText: string; englishWarn: boolean }> {
  const log = (msg: string) => {
    opts?.onLog?.(msg);
  };

  const textIn = rawText.trim();
  if (!textIn) throw new Error('正文为空');
  const rh = runningHubApiKey.trim();
  if (!rh) throw new Error('请先配置 RunningHub API Key');

  log(`接收口播正文 ${textIn.length} 字 · RunningHub 已连接`);

  const yunwu = opts?.yunwuApiKey?.trim();
  let text = textIn;
  const willPolish = !opts?.skipLlmPolish && !!yunwu;

  if (!willPolish) {
    if (opts?.skipLlmPolish) {
      log('跳过口播润色：已勾选「跳过口播优化」');
    } else if (!yunwu) {
      log('跳过口播润色：未配置云雾 API Key');
    }
  }

  if (willPolish) {
    opts?.onProgress?.('polish');
    const hasStyle = !!(opts?.trackPersona?.trim() || opts?.customHint?.trim());
    log(
      hasStyle
        ? '口播润色：云雾 gpt-5.4-mini（赛道人设 + 自定义补充）…'
        : '口播润色：云雾 gpt-5.4-mini（默认朗读友好化）…'
    );
    if (opts?.trackPersona?.trim() || opts?.customHint?.trim()) {
      text = await polishTextForTtsSpeechWithStyle(yunwu, text, {
        trackPersona: opts?.trackPersona,
        customHint: opts?.customHint,
      });
    } else {
      text = await polishTextForTtsSpeech(yunwu, text);
    }
  }

  const speakText = text.trim();
  if (!speakText) throw new Error('优化后无可朗读正文');

  if (willPolish) {
    const preview =
      speakText.length > 120 ? `${speakText.slice(0, 120)}…` : speakText;
    log(`润色完成 → ${speakText.length} 字 · 预览：${preview.replace(/\s+/g, ' ')}`);
  }

  opts?.onProgress?.('tts');
  log('进入 TTS：准备参考音色与合成参数…');

  const selected = getSelectedVoice();
  const usingDefaultRef = !selected?.runningHubAudioPath?.trim() && !selected?.audioDataUrl?.trim();
  const englishWarn = usingDefaultRef && isTextPrimarilyEnglish(speakText);

  if (selected?.name) {
    log(`参考音色：${selected.name}`);
  } else {
    log('参考音色：未在语音库选择 · 将用系统默认参考音');
  }

  let refPath: string | undefined = selected?.runningHubAudioPath?.trim();
  if (selected && !refPath && selected.audioDataUrl?.trim()) {
    log('本地上传参考音 → 正在上传至 RunningHub …');
    refPath = await uploadAudioToRunningHub(rh, selected.audioDataUrl);
    updateVoice(selected.id, { runningHubAudioPath: refPath });
    const short = refPath.length > 64 ? `${refPath.slice(0, 64)}…` : refPath;
    log(`参考音路径已登记：${short}`);
  } else if (refPath) {
    const short = refPath.length > 64 ? `${refPath.slice(0, 64)}…` : refPath;
    log(`使用语音库已绑定的参考音：${short}`);
  }

  const sp = opts?.speed ?? 1;
  const em = opts?.emphasisStrength ?? 0.5;
  const pi = opts?.pitch ?? 0;
  log(
    `请求 RunningHub TTS · 语速 ${sp.toFixed(2)} · 轻重读 ${em.toFixed(2)} · 音高 ${pi.toFixed(2)} · 韵律增强 / 呼吸 / 停顿`
  );

  const r = await generateAudio(rh, {
    text: speakText,
    referenceAudioPath: refPath,
    speed: sp,
    prosodyEnhance: true,
    breath: true,
    autoPause: true,
    pauseStrength: 0.7,
    emphasisStrength: em,
    pitch: pi,
    volume: 1,
  });

  if (!r.success) throw new Error(r.error || 'TTS 请求失败');
  const url = r.url;
  if (!url) throw new Error('未获取到音频地址');
  const audioUrl = resolveRunningHubOutputUrl(url);
  const urlShort = audioUrl.length > 96 ? `${audioUrl.slice(0, 96)}…` : audioUrl;
  log(`TTS 成功 · 输出 URL：${urlShort}`);
  if (englishWarn) {
    log('提示：正文偏英文且使用默认中文参考音，听感可能不符');
  }
  log('── 本任务流程结束 ──');

  return {
    audioUrl,
    speakText,
    englishWarn,
  };
}
