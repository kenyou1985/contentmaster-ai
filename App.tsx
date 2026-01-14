import React, { useState, useEffect } from 'react';
import { Layout } from './components/Layout';
import { Generator } from './components/Generator';
import { Tools } from './components/Tools';
import { initializeGemini } from './services/geminiService';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'generate' | 'tools'>('generate');
  
  // API Key State
  const [apiKey, setApiKey] = useState(() => {
    const envApiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
    return localStorage.getItem('GEMINI_API_KEY') || envApiKey || '';
  });

  // Base URL State - Default to Yunwu AI
  const [baseUrl, setBaseUrl] = useState(() => {
    const envBaseUrl = (import.meta as any).env?.VITE_GEMINI_BASE_URL;
    const storedUrl = localStorage.getItem('GEMINI_BASE_URL');
    // Default to Yunwu AI if no URL is set (try without api subdomain first)
    return storedUrl || envBaseUrl || 'https://yunwu.ai';
  });

  useEffect(() => {
    if (apiKey && apiKey.trim()) {
      // Re-initialize whenever Key or URL changes
      try {
        initializeGemini(apiKey, baseUrl);
        console.log('[App] Gemini API initialized successfully');
      } catch (error) {
        console.error('[App] Failed to initialize Gemini API:', error);
      }

      // Persist API Key
      const envApiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
      if (apiKey !== envApiKey) {
        localStorage.setItem('GEMINI_API_KEY', apiKey);
      }
      
      // Persist Base URL
      const envBaseUrl = (import.meta as any).env?.VITE_GEMINI_BASE_URL;
      if (baseUrl !== envBaseUrl) {
        localStorage.setItem('GEMINI_BASE_URL', baseUrl);
      }
    } else {
      console.warn('[App] API Key is empty, skipping initialization');
    }
  }, [apiKey, baseUrl]);

  return (
    <Layout 
      activeTab={activeTab} 
      setActiveTab={setActiveTab}
      apiKey={apiKey}
      setApiKey={setApiKey}
      baseUrl={baseUrl}
      setBaseUrl={setBaseUrl}
    >
      {activeTab === 'generate' ? (
        <Generator apiKey={apiKey} />
      ) : (
        <Tools apiKey={apiKey} />
      )}
    </Layout>
  );
};

export default App;
