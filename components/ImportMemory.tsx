import { useState, useRef } from 'react';

interface Message {
  sender: string;
  text: string;
  timestamp?: number;
}

export default function ImportMemory() {
  const [status, setStatus] = useState<string>('');
  const [characterName, setCharacterName] = useState<string>('');
  const [apiEndpoint, setApiEndpoint] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [modelName, setModelName] = useState<string>('claude-sonnet-4-6');
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        <input type="text" placeholder="模型名称 (如 claude-sonnet-4-6)" value={modelName} onChange={(e) => setModelName(e.target.value)} style={inputStyle} />
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
