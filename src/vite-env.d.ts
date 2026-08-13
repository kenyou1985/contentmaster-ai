/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_YOUTUBE_API_KEY?: string;
  readonly VITE_IMAGE_PROXY_URL?: string;
  readonly VITE_VIDEO_CACHE_SIZE_MB?: string;
  readonly VITE_METUBE_PUBLIC_URL?: string;
  readonly VITE_JIANYING_API_BASE?: string;
  readonly VITE_JIANYING_FORCE_LOCAL?: string;
  readonly VITE_JIANYING_FORCE_ZIP?: string;
  readonly VITE_JIANYING_DISABLE_BATCH?: string;
  readonly VITE_REMITION_API_BASE?: string;
  readonly VITE_REMITION_FORCE_LOCAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
