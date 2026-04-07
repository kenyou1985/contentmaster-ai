/**
 * RunningHub IndexTTS2 配音工作流模板（与控制台提交参数一致）
 * workflowId 与节点 id 需与 RunningHub 上应用保持一致
 */

/** 平台侧默认参考音（与节点 25 LoadAudio 一致；用户未上传语音库时 TTS ai-app 亦使用此路径） */
export const INDEXTTS2_DEFAULT_REFERENCE_AUDIO_PATH =
  'api/ca5d4142bb545e1e0ca255721717f4282664e359789f17b00b5f9fbbec6de53f.wav';

export const INDEXTTS2_RUNNINGHUB_WORKFLOW_ID = '1930910447648571394';

/** 默认文案占位，运行前由调用方写入节点 29 的 String */
export const INDEXTTS2_WORKFLOW_TEMPLATE: Record<string, unknown> = {
  '24': {
    class_type: 'IndexTTS2Run',
    inputs: {
      use_emo_text_s2: false,
      emo_text_s2: '',
      num_beams: 3,
      max_text_tokens_per_sentence: 120,
      custom_cuda_kernel: false,
      unload_model: true,
      max_mel_tokens: 1500,
      emo_vector_s2: '',
      top_p: 0.8,
      emo_vector: '[0, 0, 0, 0, 0, 0, 0, 0]',
      use_random: false,
      deepspeed: true,
      emo_alpha_s2: 1,
      use_random_s2: false,
      top_k: 30,
      temperature: 0.8,
      use_emo_text: false,
      audio: ['25', 0],
      text: ['29', 0],
      emo_text: '',
      emo_alpha: 1,
    },
    _meta: { title: 'IndexTTS2 Run' },
  },
  '25': {
    class_type: 'LoadAudio',
    inputs: {
      audio: INDEXTTS2_DEFAULT_REFERENCE_AUDIO_PATH,
      audioUI: '',
    },
    _meta: { title: 'Load Audio' },
  },
  '29': {
    class_type: 'KepStringLiteral',
    inputs: {
      String: '',
    },
    _meta: { title: 'String' },
  },
  '30': {
    class_type: 'SaveAudio',
    inputs: {
      filename_prefix: 'ComfyUI',
      audio: ['24', 0],
      audioUI: '',
    },
    _meta: { title: 'Save Audio (FLAC)' },
  },
};
