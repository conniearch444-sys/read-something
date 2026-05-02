import { useState, useRef, useEffect } from 'react';
import { RefreshCw, Check, ChevronDown } from 'lucide-react';

interface Message {
  sender: string;
  text: string;
  timestamp?: number;
}

const PROVIDERS_ENDPOINTS: Record<string, string> = {
  'OPENAI': 'https://api.openai.com/v1',
  'DEEPSEEK': 'https://api.deepseek.com',
  'GEMINI': 'https://generativelanguage.googleapis.com/v1beta',
  'CLAUDE': 'https://api.anthropic.com',
  'CUSTOM': '',
};

const MODEL_CACHE_KEY = 'app_api_models_cache_v1';

interface OptionItem {
  value: string;
  label: string;
}

export default function ImportMemory() {
  const [status, setStatus] = useState<string>('');
  const [characterName, setCharacterName] = useState<string>('');
  const [apiEndpoint, setApiEndpoint] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [modelName, setModelName] = useState<string>('claude-sonnet-4-6');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const buildModelCacheKey = () => {
    if (!apiKey.trim()) return '';
    const normalizedEndpoint = apiEndpoint.trim().replace(/\/+$/, '') || 'default';
    let hash = 2166136261;
    const fingerprint = apiKey.trim();
    for (let i = 0; i < fingerprint.length; i++) {
      hash ^= fingerprint.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${normalizedEndpoint}::${(hash >>> 0).toString(36)}`;
  };

  const loadCachedModels = () => {
    const cacheKey = buildModelCacheKey();
    if (!cacheKey) return [];
    try {
      const raw = localStorage.getItem(MODEL_CACHE_KEY);
      if (!raw) return [];
      const cache = JSON.parse(raw);
      const entry = cache[cacheKey];
      if (entry && Array.isArray(entry.models) && entry.models.length > 0) {
        return entry.models;
      }
    } catch {}
    return [];
  };

  const saveModelsToCache = (models: string[]) => {
    const cacheKey = buildModelCacheKey();
    if (!cacheKey) return;
    try {
      const raw = localStorage.getItem(MODEL_CACHE_KEY);
      const cache = raw ? JSON.parse(raw) : {};
      cache[cacheKey] = { models, updatedAt: Date.now() };
      localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify(cache));
    } catch {}
  };

  const fetchModels = async () => {
    if (!apiKey.trim()) {
      setStatus('错误：请先填写 API Key');
      return;
    }
    setIsFetchingModels(true);
    try {
      const endpoint = apiEndpoint.trim().replace(/\/+$/, '');
      let models: string[] = [];

      if (endpoint.includes('generativelanguage.googleapis.com')) {
        const resp = await fetch(`${endpoint}/models?key=${apiKey.trim()}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.models) models = data.models.map((m: any) => m.name.replace('models/', ''));
      } else {
        const resp = await fetch(`${endpoint}/models`, {
          headers: {
            'Authorization': `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
          },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (Array.isArray(data.data)) models = data.data.map((m: any) => m.id);
      }

      const normalized = [...new Set(models.map((m: string) => m.trim()).filter(Boolean))];
      if (normalized.length === 0) throw new Error('API 返回了空模型列表');

      saveModelsToCache(normalized);
      setAvailableModels(normalized);
      if (!modelName || !normalized.includes(modelName)) {
        setModelName(normalized[0]);
      }
      setStatus('✅ 模型列表拉取成功');
    } catch (err: any) {
      setStatus(`拉取模型失败：${err.message}`);
    } finally {
      setIsFetchingModels(false);
    }
  };

  const extractMessages = (jsonData: any): Message[] => {
    const messages = jsonData?.messages || jsonData?.chat_log || jsonData?.conversation || [];
    return messages
      .filter((msg: any) => msg.text && typeof msg.text === 'string')
      .map((msg: any) => ({
        sender: msg.sender === 'user' || msg.role === 'user' ? 'user' : 'them',
        text: msg.text.trim(),
        timestamp: msg.timestamp || msg.createdAt || 0,
      }));
  };

  const generateSummary = async (messages: Message[]): Promise<string> => {
    if (!apiEndpoint || !apiKey) throw new Error('请先填写 API 地址和 Key');

    const conversationText = messages
      .slice(-200)
      .map(msg => `${msg.sender === 'user' ? '用户' : 'AI'}：${msg.text}`)
      .join('\n');

    const prompt = `以下是一段用户与AI角色的对话记录。请仔细阅读后，写一段不超过300字的总结。只记录最重要的情感瞬间、关键话题、以及角色展现出的性格特质。不要罗列细节，只留精华。

对话记录：
${conversationText}

请输出总结（不超过300字）：`;

    const response = await fetch(`${apiEndpoint.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0.7,
      }),
    });

    const data = await response.json();
    return (data?.choices?.[0]?.message?.content || '').trim();
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatus('正在解析文件...');
    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const rawText = e.target?.result as string;
        const jsonData = JSON.parse(rawText);
        const messages = extractMessages(jsonData);
        if (messages.length === 0) { setStatus('错误：没找到可用的对话记录'); return; }
        setStatus(`提取了 ${messages.length} 条对话，正在调用AI生成摘要...`);
        
        let detectedName = characterName;
        if (!detectedName && jsonData?.character?.name) detectedName = jsonData.character.name;
        if (!detectedName && jsonData?.character?.nickname) detectedName = jsonData.character.nickname;
        if (!detectedName) detectedName = '未知角色';

        try {
          const summary = await generateSummary(messages);
          if (!summary) { setStatus('错误：AI没有返回有效的摘要'); return; }
          
          const existingMemories = JSON.parse(localStorage.getItem('cross_book_memories_v1') || '[]');
          existingMemories.push({
            characterName: detectedName,
            summary: `[来自小手机的记忆] ${summary}`,
            updatedAt: Date.now(),
          });
          const forThisChar = existingMemories.filter((m: any) => m.characterName === detectedName).slice(-100);
          const forOthers = existingMemories.filter((m: any) => m.characterName !== detectedName);
          localStorage.setItem('cross_book_memories_v1', JSON.stringify([...forOthers, ...forThisChar]));
          
          setStatus(`✅ 成功！已为「${detectedName}」存储记忆。摘要预览：${summary.slice(0, 100)}...`);
        } catch (apiError) {
          setStatus(`调用AI失败：${apiError instanceof Error ? apiError.message : '请检查API配置'}`);
        }
      };
      reader.readAsText(file);
    } catch (error) {
      setStatus(`解析失败：${error instanceof Error ? error.message : '请确认上传的是有效的JSON文件'}`);
    }
  };

  return (
    <div style={{ padding: '20px', maxWidth: '600px', margin: '0 auto', fontFamily: '-apple-system, sans-serif', color: '#e0e0e0' }}>
      <h2 style={{ color: '#fff', fontSize: '1.2em', marginBottom: '16px' }}>📱 → 📖 跨APP记忆导入</h2>
      <p style={{ fontSize: '0.9em', color: '#aaa', marginBottom: '20px' }}>把小手机（EVE/兔K机等）导出的聊天记录JSON文件上传，自动生成摘要并存入对应角色的跨场景记忆库。</p>

      <div style={{ background: '#2a2a2a', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '1em', margin: '0 0 12px 0', color: '#a0d2f0' }}>⚙️ API 配置</h3>
        <input type="text" placeholder="API地址 (如 https://api.xxx.com)" value={apiEndpoint} onChange={(e) => setApiEndpoint(e.target.value)} style={inputStyle} />
        <input type="password" placeholder="API Key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={inputStyle} />
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' }}>
          <div ref={modelDropdownRef} style={{ flex: 1, position: 'relative' }}>
            <div
              onClick={() => availableModels.length > 0 && setModelDropdownOpen(!modelDropdownOpen)}
              style={{
                ...inputStyle,
                margin: '0',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: availableModels.length > 0 ? 'pointer' : 'text',
              }}
            >
              <input
                type="text"
                placeholder="模型名称"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: '#e0e0e0',
                  fontSize: '0.9em',
                  width: '100%',
                  padding: 0,
                  margin: 0,
                }}
              />
              {availableModels.length > 0 && (
                <ChevronDown size={14} style={{ flexShrink: 0, marginLeft: '8px', color: '#888' }} />
              )}
            </div>
            {modelDropdownOpen && availableModels.length > 0 && (
              <div style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                zIndex: 50,
                maxHeight: '200px',
                overflowY: 'auto',
                background: '#333',
                border: '1px solid #555',
                borderRadius: '8px',
                marginTop: '4px',
              }}>
                {availableModels.map(m => (
                  <div
                    key={m}
                    onClick={() => { setModelName(m); setModelDropdownOpen(false); }}
                    style={{
                      padding: '8px 12px',
                      cursor: 'pointer',
                      fontSize: '0.85em',
                      color: m === modelName ? '#90c890' : '#ccc',
                      background: m === modelName ? '#2a352a' : 'transparent',
                    }}
                  >
                    {m === modelName && <Check size={12} style={{ marginRight: '6px', display: 'inline' }} />}
                    {m}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={fetchModels}
            disabled={isFetchingModels}
            style={{
              background: '#4a90d9',
              color: '#fff',
              border: 'none',
              padding: '8px 12px',
              borderRadius: '8px',
              fontSize: '0.8em',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              flexShrink: 0,
            }}
          >
            <RefreshCw size={12} className={isFetchingModels ? 'animate-spin' : ''} />
            拉取模型
          </button>
        </div>
      </div>

      <div style={{ background: '#2a2a2a', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '1em', margin: '0 0 12px 0', color: '#a0d2f0' }}>👤 角色名</h3>
        <input type="text" placeholder="留空则自动识别 (如温时序)" value={characterName} onChange={(e) => setCharacterName(e.target.value)} style={inputStyle} />
        <p style={{ fontSize: '0.8em', color: '#888', margin: '8px 0 0 0' }}>如果JSON里有角色名会自动识别，也可以手动填写</p>
      </div>

      <div style={{ background: '#2a2a2a', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '1em', margin: '0 0 12px 0', color: '#a0d2f0' }}>📂 上传文件</h3>
        <input type="file" accept=".json" ref={fileInputRef} onChange={handleFileUpload} style={{ display: 'none' }} />
        <button onClick={() => fileInputRef.current?.click()} style={{ background: '#4a90d9', color: '#fff', border: 'none', padding: '12px 20px', borderRadius: '8px', fontSize: '1em', cursor: 'pointer' }}>选择JSON文件并开始导入</button>
      </div>

      {status && (
        <div style={{ background: status.startsWith('✅') ? '#2a352a' : '#2a2a2a', borderRadius: '12px', padding: '16px', color: status.startsWith('✅') ? '#90c890' : status.startsWith('错误') ? '#d9a0a0' : '#e0e0e0', fontSize: '0.9em' }}>{status}</div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px', margin: '6px 0', background: '#333',
  border: '1px solid #555', borderRadius: '8px', color: '#e0e0e0',
  fontSize: '0.9em', boxSizing: 'border-box',
};
