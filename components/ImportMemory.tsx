import { useState, useRef, useEffect } from 'react';
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

  const generateSummaries = async (messages: Message[]): Promise<string[]> => {
    const apiConfig = getApiConfig();
    if (!apiConfig || !apiConfig.apiKey) {
      throw new Error('未找到 API 配置，请先在"设置"中保存 API Key。');
    }

    const endpoint = apiConfig.endpoint.replace(/\/+$/, '');
    const model = apiConfig.model || 'claude-sonnet-4-6';

    const chunkSize = 150;
    const chunks: string[] = [];
    for (let i = 0; i < messages.length; i += chunkSize) {
      const slice = messages.slice(i, i + chunkSize);
      const firstTime = slice[0]?.timestamp
        ? new Date(slice[0].timestamp).toLocaleString('zh-CN')
        : '未知时间';
      const lastTime = slice[slice.length - 1]?.timestamp
        ? new Date(slice[slice.length - 1].timestamp).toLocaleString('zh-CN')
        : '未知时间';
      chunks.push(
        `[时间段：${firstTime} 至 ${lastTime}]\n` +
        slice
          .map(msg => `${msg.sender === 'user' ? '用户' : 'AI'}：${msg.text}`)
          .join('\n')
      );
    }

    if (chunks.length === 0) return [];

    const results: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      setStatus(`正在总结第 ${i + 1}/${chunks.length} 部分...`);

      const prompt = `你是${characterName || '角色'}，正在回顾和用户的聊天。

【任务】把下面这段聊天记录浓缩成一小段回忆。

【格式要求】
- 开头固定写：[YYYY/MM/DD HH:mm - YYYY/MM/DD HH:mm]（使用对话记录前面的时间段标注）
- 紧接一段中文总结（150-250字），用「我」指代自己，用「用户」指代对方
- 写成一段连贯的话，不要用列表、编号或分点
- 只写聊天里真实出现过的内容，禁止编造事实妄加揣测
- 回答必须完整地结束，禁止写一半就停下
- 禁止重复相同的句子或段落

【内容要求】
- 按时间顺序描述对话推进过程
- 记录用户分享的具体个人信息（地点、心情、计划、状态变化），并用引号标注用户原话
- 记录你自己的回应方式和情感反应
- 捕捉这段对话中最独特的情感瞬间

对话记录：
${chunks[i]}

你的回忆：`;

      try {
        const response = await fetch(`${endpoint}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiConfig.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 3000,
            temperature: 0.7,
          }),
        });
        const data = await response.json();
        const partText = (data?.choices?.[0]?.message?.content || '').trim();
        if (partText) {
          results.push(partText);
        }
      } catch (e) {
        console.error(`分段总结失败: ${i + 1}`, e);
      }
    }

    return results;
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
          const summaries = await generateSummaries(messages);
          if (summaries.length === 0) { setStatus('错误：AI没有返回有效的摘要'); return; }
          
          const existingMemories = JSON.parse(localStorage.getItem('cross_book_memories_v1') || '[]');
          summaries.forEach((summary) => {
            existingMemories.push({
              characterName: detectedName,
              summary: `[来自小手机的记忆] ${summary}`,
              updatedAt: Date.now(),
            });
          });
          const forThisChar = existingMemories.filter((m: any) => m.characterName === detectedName).slice(-100);
          const forOthers = existingMemories.filter((m: any) => m.characterName !== detectedName);
          localStorage.setItem('cross_book_memories_v1', JSON.stringify([...forOthers, ...forThisChar]));
          
          setStatus(`✅ 成功！已为「${detectedName}」存储 ${summaries.length} 条记忆。`);
        } catch (apiError) {
          setStatus(`调用AI失败：${apiError instanceof Error ? apiError.message : '请检查API配置'}`);
        }
      };
      reader.readAsText(file);
    } catch (error) {
      setStatus(`解析失败：${error instanceof Error ? error.message : '请确认上传的是有效的JSON文件'}`);
    }
  };

  // 记忆管理器交互逻辑
  useEffect(() => {
    const KEY = 'cross_book_memories_v1';
    const listEl = document.getElementById('memory-list');
    const statusEl = document.getElementById('memory-status');
    const refreshBtn = document.getElementById('memory-refresh-btn');
    const deleteSelectedBtn = document.getElementById('memory-delete-selected-btn');
    const clearAllBtn = document.getElementById('memory-clear-all-btn');
    if (!listEl || !statusEl || !refreshBtn || !deleteSelectedBtn || !clearAllBtn) return;

    const load = () => {
      let memories = [];
      try { memories = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch {}
      if (!memories.length) {
        listEl.innerHTML = '<div style="color:#888; padding:8px;">暂无记忆</div>';
        return memories;
      }
      listEl.innerHTML = memories.map((m, i) => `
        <div style="padding:6px 0; border-bottom:1px solid #333; font-size:10px;">
          <div style="display:flex; align-items:flex-start; gap:8px; cursor:pointer;" data-memory-index="${i}">
            <input type="checkbox" id="mm_${i}" style="margin-top:3px; flex-shrink:0;" onclick="event.stopPropagation();" />
            <div style="flex:1; min-width:0;">
              <div><b>${m.characterName || '未知'}</b> · ${new Date(m.updatedAt).toLocaleString('zh-CN')}</div>
              <div id="memory-content-${i}" class="memory-text" style="color:#aaa; word-break:break-all; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden;">
                ${m.summary || '(空)'}
              </div>
              <div id="memory-content-full-${i}" class="memory-text-full" style="color:#aaa; word-break:break-all; display:none; max-height:200px; overflow-y:auto; WebkitOverflowScrolling:touch; margin-top:4px;">
                ${m.summary || '(空)'}
              </div>
            </div>
          </div>
        </div>
      `).join('');

      // 绑定展开/收起事件
      listEl.querySelectorAll('[data-memory-index]').forEach((el) => {
        el.addEventListener('click', () => {
          const index = parseInt(el.getAttribute('data-memory-index') || '0', 10);
          const shortEl = document.getElementById('memory-content-' + index);
          const fullEl = document.getElementById('memory-content-full-' + index);
          if (!shortEl || !fullEl) return;
          if (fullEl.style.display === 'none') {
            shortEl.style.display = 'none';
            fullEl.style.display = 'block';
          } else {
            shortEl.style.display = '-webkit-box';
            fullEl.style.display = 'none';
          }
        });
      });

      return memories;
    };

    let currentMemories = load();

    const refresh = () => {
      currentMemories = load();
      statusEl.textContent = '';
    };
    refreshBtn.addEventListener('click', refresh);

    const getSelectedIndices = () => {
      const indices = [];
      for (let i = 0; i < currentMemories.length; i++) {
        const cb = document.getElementById('mm_' + i);
        if (cb?.checked) indices.push(i);
      }
      return indices.sort((a, b) => b - a);
    };

    deleteSelectedBtn.addEventListener('click', () => {
      const selected = getSelectedIndices();
      if (!selected.length) { statusEl.textContent = '请先勾选条目'; return; }
      if (!confirm(`确认删除 ${selected.length} 条记忆？`)) return;
      for (const i of selected) currentMemories.splice(i, 1);
      localStorage.setItem(KEY, JSON.stringify(currentMemories));
      statusEl.textContent = `✅ 已删除 ${selected.length} 条`;
      refresh();
    });

    clearAllBtn.addEventListener('click', () => {
      if (!confirm('清空所有跨书记忆？此操作不可恢复。')) return;
      localStorage.setItem(KEY, '[]');
      currentMemories = [];
      statusEl.textContent = '✅ 已清空';
      refresh();
    });

    return () => {
      refreshBtn.removeEventListener('click', refresh);
    };
  }, []);

  return (
    <div style={{ padding: '20px', maxWidth: '600px', margin: '0 auto', fontFamily: '-apple-system, sans-serif', color: '#e0e0e0' }}>
      <h2 style={{ color: '#fff', fontSize: '1.2em', marginBottom: '16px' }}>📱 → 📖 跨APP记忆导入</h2>
      <p style={{ fontSize: '0.9em', color: '#aaa', marginBottom: '20px' }}>把小手机（EVE/兔K机等）导出的聊天记录JSON文件上传，自动分段总结，每段独立存储为一条记忆卡片。</p>

      <div style={{ background: '#2a2a2a', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '1em', margin: '0 0 12px 0', color: '#a0d2f0' }}>⚙️ 状态</h3>
        <p style={{ fontSize: '0.85em', color: getApiConfig() ? '#90c890' : '#d9a0a0' }}>
          {getApiConfig() ? '✅ 已读取到网站API配置，可直接上传文件' : '❌ 未读取到配置，请先在网站"设置"中保存API Key'}
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
        <div style={{ background: status.startsWith('✅') ? '#2a352a' : '#2a2a2a', borderRadius: '12px', padding: '16px', color: status.startsWith('✅') ? '#90c890' : status.startsWith('错误') ? '#d9a0a0' : '#e0e0e0', fontSize: '0.9em', marginBottom: '16px' }}>{status}</div>
      )}

      {/* 跨书记忆管理器 */}
      <div id="memory-manager" style={{
        background: '#2a2a2a', borderRadius: '12px', padding: '14px',
        fontSize: '11px', fontFamily: '-apple-system, sans-serif',
        marginTop: '8px'
      }}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'8px'}}>
          <strong style={{color:'#a0d2f0', fontSize:'1em'}}>🧠 跨书记忆管理</strong>
          <button id="memory-refresh-btn" style={{background:'#333', color:'#ccc', border:'none', borderRadius:'6px', padding:'4px 8px', fontSize:'10px', cursor:'pointer'}}>刷新</button>
        </div>
        <div id="memory-list" style={{maxHeight:'400px', overflowY:'auto', WebkitOverflowScrolling:'touch', touchAction:'pan-y', marginBottom:'8px', border:'1px solid #333', borderRadius:'6px', padding:'4px'}}>加载中...</div>
        <div style={{display:'flex', gap:'8px'}}>
          <button id="memory-delete-selected-btn" style={{background:'#d94a4a', color:'#fff', border:'none', borderRadius:'6px', padding:'4px 8px', fontSize:'10px', cursor:'pointer'}}>删除选中</button>
          <button id="memory-clear-all-btn" style={{background:'#555', color:'#fff', border:'none', borderRadius:'6px', padding:'4px 8px', fontSize:'10px', cursor:'pointer'}}>清空全部</button>
        </div>
        <div id="memory-status" style={{marginTop:'6px', fontSize:'10px', color:'#888'}}></div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px', margin: '6px 0', background: '#333',
  border: '1px solid #555', borderRadius: '8px', color: '#e0e0e0',
  fontSize: '0.9em', boxSizing: 'border-box',
};
