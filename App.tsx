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
  
  // API Key State
  const [apiKey, setApiKey] = useState(() => {
    const envApiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
    return localStorage.getItem('GEMINI_API_KEY') || envApiKey || '';
  });

  const detectProvider = (key: string): ApiProvider => {
    const trimmed = key.trim();
    if (trimmed.startsWith('AIza')) return 'google';
    return 'yunwu';
  };

  const [provider, setProvider] = useState<ApiProvider>(() => {
    const stored = localStorage.getItem('GEMINI_PROVIDER') as ApiProvider | null;
    if (stored === 'google' || stored === 'yunwu') return stored;
    return detectProvider(localStorage.getItem('GEMINI_API_KEY') || '');
  });

  const baseUrl = 'https://yunwu.ai';

  useEffect(() => {
    if (!apiKey || !apiKey.trim()) {
      console.warn('[App] API Key is empty, skipping initialization');
      return;
    }

    const detected = detectProvider(apiKey);
    if (provider !== detected) {
      setProvider(detected);
    }

    try {
      initializeGemini(apiKey, { provider: detected, baseUrl });
      console.log('[App] Gemini API initialized successfully');
    } catch (error) {
      console.error('[App] Failed to initialize Gemini API:', error);
    }

    const envApiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
    if (apiKey !== envApiKey) {
      localStorage.setItem('GEMINI_API_KEY', apiKey);
    }

    localStorage.setItem('GEMINI_PROVIDER', detected);
    localStorage.setItem('GEMINI_BASE_URL', baseUrl);
  }, [apiKey]);

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
          <MediaGenerator apiKey={apiKey} provider={provider} toast={toast} />
        )}
      </Layout>
      <ToastContainer toasts={toast.toasts} onClose={toast.closeToast} />
    </>
  );
};

export default App;
