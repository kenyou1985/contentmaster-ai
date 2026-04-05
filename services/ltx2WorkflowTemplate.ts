/**
 * LTX-2 图生视频工作流模板（RunningHub workflow JSON）
 * 模板ID: 2033053099966865410
 * 说明：
 *   - 节点 269 (LoadImage):  运行时替换为上传后的图片路径
 *   - 节点 325 (Prompt):     运行时替换为视频提示词
 *   - 节点 301 (Length/帧数): 运行时可按 duration × 24 替换
 *
 * 生成请求体时，使用 `workflow: JSON.stringify(LTX2_WORKFLOW_TEMPLATE)`
 * 服务端会自动 merge workflow + nodeInfoList 中的节点覆盖，无需手动注入。
 */
export const LTX2_WORKFLOW_TEMPLATE: Record<string, any> = {
  "273": {
    "class_type": "SaveVideo",
    "inputs": {
      "codec": "auto",
      "filename_prefix": "video/LTX_2.3_i2v",
      "fw_video_preview": "",
      "format": "auto",
      "video": ["312", 0],
      "video-preview": ""
    },
    "_meta": { "title": "💾 Save Video" }
  },
  "274": {
    "class_type": "RandomNoise",
    "inputs": { "noise_seed": 62039387 },
    "_meta": { "title": "随机噪波" }
  },
  "275": {
    "class_type": "RandomNoise",
    "inputs": { "noise_seed": 62039387 },
    "_meta": { "title": "随机噪波" }
  },
  "276": {
    "class_type": "LTXVConcatAVLatent",
    "inputs": {
      "audio_latent": ["309", 1],
      "video_latent": ["288", 0]
    },
    "_meta": { "title": "LTXVConcatAVLatent" }
  },
  "277": {
    "class_type": "LTXVAudioVAELoader",
    "inputs": { "ckpt_name": "ltx-2.3-22b-dev.safetensors" },
    "_meta": { "title": "LTXV Audio VAE Loader" }
  },
  "310": {
    "class_type": "SamplerCustomAdvanced",
    "inputs": {
      "guider": ["282", 0],
      "latent_image": ["276", 0],
      "noise": ["274", 0],
      "sigmas": ["280", 0],
      "sampler": ["279", 0]
    },
    "_meta": { "title": "自定义采样器(高级)" }
  },
  "278": {
    "class_type": "LTXAVTextEncoderLoader",
    "inputs": {
      "ckpt_name": "ltx-2.3-22b-dev.safetensors",
      "text_encoder": "gemma_3_12B_it.safetensors",
      "device": "default"
    },
    "_meta": { "title": "LTXV Audio Text Encoder Loader" }
  },
  "311": {
    "class_type": "LTXVSeparateAVLatent",
    "inputs": { "av_latent": ["310", 0] },
    "_meta": { "title": "LTXVSeparateAVLatent" }
  },
  "279": {
    "class_type": "KSamplerSelect",
    "inputs": { "sampler_name": "euler_cfg_pp" },
    "_meta": { "title": "K采样器选择" }
  },
  "312": {
    "class_type": "CreateVideo",
    "inputs": {
      "images": ["317", 0],
      "fps": ["298", 0],
      "audio": ["297", 0]
    },
    "_meta": { "title": "Create Video" }
  },
  "313": {
    "class_type": "LatentUpscaleModelLoader",
    "inputs": { "model_name": "ltx-2.3-spatial-upscaler-x2-1.0.safetensors" },
    "_meta": { "title": "Load Latent Upscale Model" }
  },
  "314": {
    "class_type": "PrimitiveInt",
    "inputs": { "value": 1280 },
    "_meta": { "title": "最长边" }
  },
  "315": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "text": "pc game, console game, video game, cartoon, childish, ugly, subtitles, captions, on-screen text, written text, letters, words, Chinese characters, English text, random text, garbled text, watermark, logo, title overlay, lower third text, UI text, interface text",
      "clip": ["278", 0]
    },
    "_meta": { "title": "CLIP文本编码器" }
  },
  "316": {
    "class_type": "CFGGuider",
    "inputs": {
      "negative": ["305", 1],
      "cfg": 1,
      "model": ["285", 0],
      "positive": ["305", 0]
    },
    "_meta": { "title": "CFG引导" }
  },
  "317": {
    "class_type": "VAEDecodeTiled",
    "inputs": {
      "overlap": 64,
      "tile_size": 768,
      "temporal_overlap": 4,
      "vae": ["281", 2],
      "samples": ["311", 0],
      "temporal_size": 4096
    },
    "_meta": { "title": "VAE分块解码" }
  },
  "280": {
    "class_type": "ManualSigmas",
    "inputs": { "sigmas": "0.85, 0.7250, 0.4219, 0.0" },
    "_meta": { "title": "ManualSigmas" }
  },
  "281": {
    "class_type": "CheckpointLoaderSimple",
    "inputs": { "ckpt_name": "ltx-2.3-22b-dev.safetensors" },
    "_meta": { "title": "Checkpoint加载器(简易)" }
  },
  "282": {
    "class_type": "CFGGuider",
    "inputs": {
      "negative": ["284", 1],
      "cfg": 1,
      "model": ["285", 0],
      "positive": ["284", 0]
    },
    "_meta": { "title": "CFG引导" }
  },
  "283": {
    "class_type": "SamplerCustomAdvanced",
    "inputs": {
      "guider": ["316", 0],
      "latent_image": ["306", 0],
      "noise": ["275", 0],
      "sigmas": ["308", 0],
      "sampler": ["291", 0]
    },
    "_meta": { "title": "自定义采样器(高级)" }
  },
  "284": {
    "class_type": "LTXVCropGuides",
    "inputs": {
      "negative": ["305", 1],
      "latent": ["309", 0],
      "positive": ["305", 0]
    },
    "_meta": { "title": "LTXVCropGuides" }
  },
  "285": {
    "class_type": "LoraLoaderModelOnly",
    "inputs": {
      "lora_name": "ltx-2.3-22b-distilled-lora-384.safetensors",
      "strength_model": 0.5,
      "model": ["331", 0]
    },
    "_meta": { "title": "LoRA加载器(仅模型)" }
  },
  "286": {
    "class_type": "ResizeImagesByLongerEdge",
    "inputs": {
      "images": ["290", 0],
      "longer_edge": 1536
    },
    "_meta": { "title": "Resize Images by Longer Edge" }
  },
  "287": {
    "class_type": "LTXVLatentUpsampler",
    "inputs": {
      "upscale_model": ["313", 0],
      "vae": ["281", 2],
      "samples": ["309", 0]
    },
    "_meta": { "title": "LTXVLatentUpsampler" }
  },
  "288": {
    "class_type": "LTXVImgToVideoInplace",
    "inputs": {
      "bypass": ["302", 0],
      "image": ["289", 0],
      "strength": 1,
      "latent": ["287", 0],
      "vae": ["281", 2]
    },
    "_meta": { "title": "LTXVImgToVideoInplace" }
  },
  "289": {
    "class_type": "LTXVPreprocess",
    "inputs": {
      "img_compression": 18,
      "image": ["286", 0]
    },
    "_meta": { "title": "LTXVPreprocess" }
  },
  "324": {
    "class_type": "RH_LLMAPI_Pro_Node",
    "inputs": {
      "role": ["334", 0],
      "seed": 62039387,
      "temperature": 0.6,
      "model": "gemini-3-flash-preview",
      "image1": ["269", 0],
      "prompt": ["325", 0]
    },
    "_meta": { "title": "Runninghub LLM API Pro Node" }
  },
  "325": {
    "class_type": "PrimitiveStringMultiline",
    "inputs": { "value": "请在运行时替换为视频提示词" },
    "_meta": { "title": "Prompt" }
  },
  "326": {
    "class_type": "easy showAnything",
    "inputs": {
      "text": ["324", 0],
      "anything": ["325", 0]
    },
    "_meta": { "title": "展示任何" }
  },
  "290": {
    "class_type": "ResizeImageMaskNode",
    "inputs": {
      "input": ["269", 0],
      "resize_type.height": ["330", 4],
      "resize_type": "scale dimensions",
      "resize_type.width": ["330", 3],
      "scale_method": "lanczos",
      "resize_type.crop": "center"
    },
    "_meta": { "title": "Resize Image/Mask" }
  },
  "291": {
    "class_type": "KSamplerSelect",
    "inputs": { "sampler_name": "euler_ancestral_cfg_pp" },
    "_meta": { "title": "K采样器选择" }
  },
  "292": {
    "class_type": "ComfyMathExpression",
    "inputs": {
      "expression": "a/2",
      "values.a": ["330", 3]
    },
    "_meta": { "title": "Math Expression" }
  },
  "294": {
    "class_type": "ComfyMathExpression",
    "inputs": {
      "expression": "a/2",
      "values.a": ["330", 4]
    },
    "_meta": { "title": "Math Expression" }
  },
  "295": {
    "class_type": "EmptyLTXVLatentVideo",
    "inputs": {
      "batch_size": 1,
      "width": ["292", 1],
      "length": ["301", 0],
      "height": ["294", 1]
    },
    "_meta": { "title": "EmptyLTXVLatentVideo" }
  },
  "296": {
    "class_type": "LTXVImgToVideoInplace",
    "inputs": {
      "bypass": ["302", 0],
      "image": ["289", 0],
      "strength": 0.7,
      "latent": ["295", 0],
      "vae": ["281", 2]
    },
    "_meta": { "title": "LTXVImgToVideoInplace" }
  },
  "297": {
    "class_type": "LTXVAudioVAEDecode",
    "inputs": {
      "audio_vae": ["277", 0],
      "samples": ["311", 1]
    },
    "_meta": { "title": "LTXV Audio VAE Decode" }
  },
  "330": {
    "class_type": "LayerUtility: ImageScaleByAspectRatio V2",
    "inputs": {
      "fit": "letterbox",
      "aspect_ratio": "original",
      "image": ["269", 0],
      "method": "lanczos",
      "background_color": "#000000",
      "round_to_multiple": "8",
      "scale_to_side": "longest",
      "proportional_height": 1,
      "proportional_width": 1,
      "scale_to_length": ["314", 0]
    },
    "_meta": { "title": "按宽高比缩放_V2" }
  },
  "298": {
    "class_type": "ComfyMathExpression",
    "inputs": {
      "expression": "a",
      "values.a": ["300", 0]
    },
    "_meta": { "title": "Math Expression" }
  },
  "331": {
    "class_type": "LoraLoaderModelOnly",
    "inputs": {
      "lora_name": "仙侠风格.safetensors",
      "strength_model": 0.5,
      "model": ["281", 0]
    },
    "_meta": { "title": "LoRA加载器(仅模型)" }
  },
  "332": {
    "class_type": "CR Text",
    "inputs": {
      "text": "Role\n\n你是一个 LTX-2 提示词专家……（完整内容略，见用户提供的日志）"
    },
    "_meta": { "title": "文本" }
  },
  "333": {
    "class_type": "CR Text",
    "inputs": {
      "text": "# Role\n你是一名好莱坞级别的图生视频导演……（完整内容略，见用户提供的日志）"
    },
    "_meta": { "title": "文本" }
  },
  "334": {
    "class_type": "CR Text",
    "inputs": {
      "text": "# Role\n你是一名好莱坞级别的首尾帧视频导演……（完整内容略，见用户提供的日志）"
    },
    "_meta": { "title": "文本" }
  },
  "300": {
    "class_type": "PrimitiveInt",
    "inputs": { "value": 24 },
    "_meta": { "title": "Frame Rate" }
  },
  "301": {
    "class_type": "PrimitiveInt",
    "inputs": { "value": 241 },
    "_meta": { "title": "Length" }
  },
  "269": {
    "class_type": "LoadImage",
    "inputs": { "image": "请在运行时替换为上传后的图片路径" },
    "_meta": { "title": "加载图像" }
  },
  "302": {
    "class_type": "PrimitiveBoolean",
    "inputs": { "value": false },
    "_meta": { "title": "是否切换为文生视频（默认为否图生视频）" }
  },
  "303": {
    "class_type": "PrimitiveStringMultiline",
    "inputs": { "value": ["326", 0] },
    "_meta": { "title": "Prompt" }
  },
  "304": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "text": ["303", 0],
      "clip": ["278", 0]
    },
    "_meta": { "title": "CLIP文本编码器" }
  },
  "305": {
    "class_type": "LTXVConditioning",
    "inputs": {
      "negative": ["315", 0],
      "positive": ["304", 0],
      "frame_rate": ["298", 0]
    },
    "_meta": { "title": "LTXVConditioning" }
  },
  "306": {
    "class_type": "LTXVConcatAVLatent",
    "inputs": {
      "audio_latent": ["307", 0],
      "video_latent": ["296", 0]
    },
    "_meta": { "title": "LTXVConcatAVLatent" }
  },
  "307": {
    "class_type": "LTXVEmptyLatentAudio",
    "inputs": {
      "batch_size": 1,
      "frame_rate": ["298", 1],
      "audio_vae": ["277", 0],
      "frames_number": ["301", 0]
    },
    "_meta": { "title": "LTXV Empty Latent Audio" }
  },
  "308": {
    "class_type": "ManualSigmas",
    "inputs": { "sigmas": "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0" },
    "_meta": { "title": "ManualSigmas" }
  },
  "309": {
    "class_type": "LTXVSeparateAVLatent",
    "inputs": { "av_latent": ["283", 0] },
    "_meta": { "title": "LTXVSeparateAVLatent" }
  }
};
