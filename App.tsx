import React, { useState, useEffect } from 'react';
import { Layout } from './components/Layout';
import { Generator } from './components/Generator';
import { Tools } from './components/Tools';
import { MediaGenerator } from './components/MediaGenerator';
import { initializeGemini } from './services/geminiService';
import { ApiProvider } from './types';
import { ToastContainer, useToast } from './components/Toast';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'generate' | 'tools' | 'media'>('generate');
  const toast = useToast();
  
  // 调试：检查 toast 状态
  React.useEffect(() => {
    console.log('[App] Toast 状态检查:', {
      toastsLength: toast.toasts.length,
      toasts: toast.toasts,
      hasSuccess: typeof toast.success === 'function',
    });
  }, [toast.toasts]);
  
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
  
  // 大洋芋 API Key State（用于视频生成）
  const [dayuApiKey, setDayuApiKey] = useState(() => {
    return localStorage.getItem('DAYU_API_KEY') || '';
  });
  
  // 保存大洋芋 API Key 到 localStorage
  useEffect(() => {
    if (dayuApiKey) {
      localStorage.setItem('DAYU_API_KEY', dayuApiKey);
    }
  }, [dayuApiKey]);

  // 当 provider 切换时，自动加载对应的 API Key
  useEffect(() => {
    const keyForProvider = loadApiKeyForProvider(provider);
    if (keyForProvider) {
      // 如果新 provider 有缓存的 Key，加载它
      if (keyForProvider !== apiKey) {
        console.log(`[App] 切换 provider 到 ${provider}，加载缓存的 API Key`);
        setApiKey(keyForProvider);
      }
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
      console.log(`[App] 已保存 ${provider} 的 API Key 到 ${storageKey}`);
    }
  }, [apiKey, provider]);

  const baseUrl = 'https://yunwu.ai';

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
      // 只在用户没有手动选择时自动切换
      console.log(`[App] 检测到 provider 为 ${detected}，但当前选择为 ${provider}，保持用户选择`);
    }

    try {
      const actualProvider = provider === 'runninghub' ? detected : provider;
      initializeGemini(apiKey, { provider: actualProvider, baseUrl });
      console.log('[App] Gemini API initialized successfully');
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

  return (
    <>
      <Layout 
        activeTab={activeTab} 
        setActiveTab={setActiveTab}
        apiKey={apiKey}
        setApiKey={setApiKey}
        provider={provider}
        setProvider={setProvider}
      >
        {activeTab === 'generate' ? (
          <Generator apiKey={apiKey} provider={provider} toast={toast} />
        ) : activeTab === 'tools' ? (
          <Tools apiKey={apiKey} provider={provider} toast={toast} />
        ) : (
          <MediaGenerator 
            apiKey={apiKey} 
            provider={provider} 
            toast={toast}
            dayuApiKey={dayuApiKey}
            setDayuApiKey={setDayuApiKey}
          />
        )}
      </Layout>
      <ToastContainer toasts={toast.toasts} onClose={toast.closeToast} />
    </>
  );
};

export default App;
