import React, { useState, useEffect } from 'react';
import { Layout } from './components/Layout';
import { Generator } from './components/Generator';
import { Tools } from './components/Tools';
import { MediaGenerator } from './components/MediaGenerator';
import { OneClickDubbing } from './components/OneClickDubbing';
import { CoverDesign } from './components/CoverDesign';
import { YouTubeMonitor } from './components/YouTubeMonitor';
import { QueueTaskViewer } from './components/QueueTaskViewer';
import { ChannelGenerator } from './components/ChannelGenerator';
import { initializeGemini } from './services/geminiService';
import { ApiProvider } from './types';
import { ToastContainer, useToast } from './components/Toast';
import { Rss } from 'lucide-react';
import { cleanExpiredAndOversizedCache, getCacheStats } from './services/videoCacheService';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'generate' | 'tools' | 'media' | 'dubbing' | 'cover' | 'monitor' | 'channel'>('generate');
  const toast = useToast();

  // 应用启动时清理过期和过大的视频缓存
  useEffect(() => {
    const initCacheCleanup = async () => {
      try {
        await cleanExpiredAndOversizedCache();
      } catch {
        // 静默忽略
      }
    };
    void initCacheCleanup();
  }, []);

  // 按 provider 获取 API Key 的 localStorage key
  const getApiKeyStorageKey = (provider: ApiProvider): string => {
    return `API_KEY_${provider}`;
  };

  // 从 localStorage 加载指定 provider 的 API Key
  const loadApiKeyForProvider = (provider: ApiProvider): string => {
    const storageKey = getApiKeyStorageKey(provider);
    const storedKey = localStorage.getItem(storageKey);
    
    // 兼容旧版本：如果新格式没有，尝试从旧格式加载
    if (!storedKey && provider !== 'runninghub') {
      const oldKey = localStorage.getItem('GEMINI_API_KEY');
      if (oldKey) {
        // 迁移旧数据到新格式
        localStorage.setItem(storageKey, oldKey);
        return oldKey;
      }
    }
    
    // 如果是 google 或 yunwu，也检查环境变量
    if (!storedKey && (provider === 'google' || provider === 'yunwu')) {
      const envApiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
      if (envApiKey) {
        return envApiKey;
      }
    }
    
    return storedKey || '';
  };

  const detectProvider = (key: string): ApiProvider => {
    const trimmed = key.trim();
    if (trimmed.startsWith('AIza')) return 'google';
    if (trimmed.startsWith('sk-')) return 'yunwu';
    // runninghub需要手动选择，不自动检测
    return 'yunwu'; // 默认
  };

  const [provider, setProvider] = useState<ApiProvider>(() => {
    const stored = localStorage.getItem('GEMINI_PROVIDER') as ApiProvider | null;
    if (stored === 'google' || stored === 'yunwu' || stored === 'runninghub') return stored;
    // 尝试从旧格式检测
    const oldKey = localStorage.getItem('GEMINI_API_KEY') || '';
    return detectProvider(oldKey);
  });

  // API Key State - 根据当前 provider 加载对应的 Key
  const [apiKey, setApiKey] = useState(() => {
    return loadApiKeyForProvider(provider);
  });

  /** RunningHub Key 独立持久化：媒体页/轮询不依赖当前「API 服务」是否为 runninghub */
  const [runningHubApiKey, setRunningHubApiKey] = useState(() => loadApiKeyForProvider('runninghub'));

  useEffect(() => {
    if (runningHubApiKey) {
      localStorage.setItem(getApiKeyStorageKey('runninghub'), runningHubApiKey);
    }
  }, [runningHubApiKey]);

  useEffect(() => {
    if (provider === 'runninghub' && apiKey.trim()) {
      setRunningHubApiKey(apiKey);
    }
  }, [provider, apiKey]);

  // 当 provider 切换时，自动加载对应的 API Key
  useEffect(() => {
    const keyForProvider = loadApiKeyForProvider(provider);
    if (keyForProvider && keyForProvider !== apiKey) {
      setApiKey(keyForProvider);
    } else {
      // 如果新 provider 没有缓存的 Key，且当前 Key 是其他 provider 的，清空它
      // 这样可以避免显示错误的 Key（例如切换到 runninghub 时还显示 yunwu 的 Key）
      const currentKeyStorageKey = getApiKeyStorageKey(provider);
      const currentStoredKey = localStorage.getItem(currentKeyStorageKey);
      if (!currentStoredKey && apiKey) {
        // 检查当前 apiKey 是否属于其他 provider
        const isYunwuKey = apiKey.trim().startsWith('sk-');
        const isGoogleKey = apiKey.trim().startsWith('AIza');
        const shouldClear = (provider === 'runninghub' && (isYunwuKey || isGoogleKey)) ||
                           (provider === 'yunwu' && isGoogleKey) ||
                           (provider === 'google' && isYunwuKey);
        
        if (shouldClear) {
          console.log(`[App] ${provider} 没有缓存的 API Key，且当前 Key 属于其他 provider，清空输入框`);
          setApiKey('');
        }
      }
    }
  }, [provider]); // 注意：这里不包含 apiKey，避免循环更新

  // 保存当前 provider 的 API Key 到 localStorage
  useEffect(() => {
    if (apiKey) {
      const storageKey = getApiKeyStorageKey(provider);
      localStorage.setItem(storageKey, apiKey);
      localStorage.setItem(storageKey, apiKey);
    }
  }, [apiKey, provider]);

  const baseUrl = 'https://yunwu.ai';

  // 检查是否为独立任务查看窗口
  const isTaskViewer = new URLSearchParams(window.location.search).has('queueTaskView');

  useEffect(() => {
    if (!apiKey || !apiKey.trim()) {
      console.warn('[App] API Key is empty, skipping initialization');
      return;
    }

    // runninghub不需要初始化Gemini，跳过
    if (provider === 'runninghub') {
      localStorage.setItem('GEMINI_PROVIDER', provider);
      return;
    }

    const detected = detectProvider(apiKey);
    if (provider !== detected && provider !== 'runninghub') {
      // 如果检测到的 provider 与当前不一致，但用户可能手动选择了，不自动切换
    }

    try {
      const actualProvider = provider === 'runninghub' ? detected : provider;
      initializeGemini(apiKey, { provider: actualProvider, baseUrl });
    } catch (error) {
      console.error('[App] Failed to initialize Gemini API:', error);
    }

    localStorage.setItem('GEMINI_PROVIDER', provider);
    localStorage.setItem('GEMINI_BASE_URL', baseUrl);
  }, [apiKey, provider]);

  // 保存当前 provider 到 localStorage
  useEffect(() => {
    localStorage.setItem('GEMINI_PROVIDER', provider);
  }, [provider]);

  // 独立任务查看窗口模式
  if (isTaskViewer) {
    return <QueueTaskViewer />;
  }

  return (
    <>
      <Layout
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        apiKey={apiKey}
        setApiKey={setApiKey}
        provider={provider}
        setProvider={setProvider}
        runningHubApiKey={runningHubApiKey}
        setRunningHubApiKey={setRunningHubApiKey}
      >
        {/* 各主模块同时挂载、用 hidden 切换，避免切页卸载导致状态丢失（进行中任务可继续跑） */}
        <div className={activeTab === 'generate' ? 'block' : 'hidden'} aria-hidden={activeTab !== 'generate'}>
          <Generator apiKey={apiKey} provider={provider} toast={toast} />
        </div>
        <div className={activeTab === 'tools' ? 'block' : 'hidden'} aria-hidden={activeTab !== 'tools'}>
          <Tools apiKey={apiKey} provider={provider} toast={toast} />
        </div>
        <div className={activeTab === 'media' ? 'block' : 'hidden'} aria-hidden={activeTab !== 'media'}>
          <MediaGenerator
            apiKey={apiKey}
            provider={provider}
            toast={toast}
            runningHubApiKey={runningHubApiKey}
            setRunningHubApiKey={setRunningHubApiKey}
          />
        </div>
        <div className={activeTab === 'dubbing' ? 'block' : 'hidden'} aria-hidden={activeTab !== 'dubbing'}>
          <OneClickDubbing
            apiKey={apiKey}
            runningHubApiKey={runningHubApiKey}
            setRunningHubApiKey={setRunningHubApiKey}
            toast={toast}
          />
        </div>
        <div className={activeTab === 'cover' ? 'block' : 'hidden'} aria-hidden={activeTab !== 'cover'}>
          <CoverDesign apiKey={apiKey} provider={provider} toast={toast} />
        </div>
        <div className={activeTab === 'monitor' ? 'block' : 'hidden'} aria-hidden={activeTab !== 'monitor'}>
          <YouTubeMonitor />
        </div>
        <div className={activeTab === 'channel' ? 'block' : 'hidden'} aria-hidden={activeTab !== 'channel'}>
          <ChannelGenerator apiKey={apiKey} provider={provider} toast={toast} />
        </div>
      </Layout>
      <ToastContainer toasts={toast.toasts} onClose={toast.closeToast} />
    </>
  );
};

export default App;
