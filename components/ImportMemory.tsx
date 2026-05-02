import { useState, useRef } from 'react';
import { ApiConfig } from './settings/types';

interface Message {
  sender: string;
  text: string;
  timestamp?: number;
}

export default function ImportMemory() {
  const [status, setStatus] = useState<string>('');
  const [characterName, setCharacterName] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const getApiConfig = (): ApiConfig | null => {
    try {
      const raw = localStorage.getItem('app_api_config');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.apiKey && parsed.endpoint) {
          return parsed as ApiConfig;
        }
      }
    } catch {}
    return null;
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
    const apiConfig = getApiConfig();
    if (!apiConfig || !apiConfig.apiKey) {
      throw new Error('未找到 API 配置，请先在“设置”中保存 API Key。');
    }

    const endpoint = apiConfig.endpoint.replace(/\/+$/, '');
    const model = apiConfig.model || 'claude-sonnet-4-6';

    const chunkSize = 150;
    const chunks: string[] = [];
    for (let i = 0; i < messages.length; i += chunkSize) {
      const slice = messages.slice(i, i + chunkSize);
      chunks.push(
        slice
          .map(msg => `${msg.sender === 'user' ? '用户' : 'AI'}：${msg.text}`)
          .join('\n')
      );
    }

    // 只有一段
    if (chunks.length === 1) {
      const prompt = `以下是一段用户与AI角色的对话记录。请写一段不超过500字的记忆总结，包含具体话题、用户分享的个人信息（地点/心情/计划等）、角色的情感反应、值得记住的细节。

对话记录：
${chunks[0]}

请输出总结：`;

      const response = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiConfig.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1500,
          temperature: 0.7,
        }),
      });
      const data = await response.json();
      return (data?.choices?.[0]?.message?.content || '').trim();
    }

    // 多段：各自总结，直接拼接，不二次合并
    const partSummaries: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      setStatus(`正在总结第 ${i + 1}/${chunks.length} 部分...`);

      const prompt = `以下是一段用户与AI角色的对话记录（第${i + 1}部分，共${chunks.length}部分）。请写一段不超过300字的要点总结，包含具体话题、关键细节、用户分享的个人信息、角色的情感反应。

对话记录：
${chunks[i]}

请输出要点总结：`;

      const response = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiConfig.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1000,
          temperature: 0.7,
        }),
      });
      const data = await response.json();
      const partText = (data?.choices?.[0]?.message?.content || '').trim();
      if (partText) {
        partSummaries.push(`【第${i + 1}部分】${partText}`);
      }
    }

    // 直接拼接，保留完整信息
    return partSummaries.join('\n\n');
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
        setStatus(`提取了 ${messages.length} 条对话，开始分段总结...`);
        
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
          
          setStatus(`✅ 成功！已为「${detectedName}」存储记忆（共 ${summary.length} 字）。摘要预览：${summary.slice(0, 150)}...`);
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
      <p style={{ fontSize: '0.9em', color: '#aaa', marginBottom: '20px' }}>把小手机（EVE/兔K机等）导出的聊天记录JSON文件上传，自动分段总结并存入对应角色的跨场景记忆库。</p>

      <div style={{ background: '#2a2a2a', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '1em', margin: '0 0 12px 0', color: '#a0d2f0' }}>⚙️ 状态</h3>
        <p style={{ fontSize: '0.85em', color: getApiConfig() ? '#90c890' : '#d9a0a0' }}>
          {getApiConfig() ? '✅ 已读取到网站API配置，可直接上传文件' : '❌ 未读取到配置，请先在网站“设置”中保存API Key'}
        </p>
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
