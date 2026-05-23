import {
  createAppArchivePayload,
  restoreAppArchivePayload,
} from './appArchive';

const API_BASE = '/read-something/api';
const TOKEN_KEY = 'app_cloud_token';
const VERSION_KEY = 'app_cloud_sync_version';
const LAST_UPLOAD_KEY = 'app_cloud_last_upload';
const AUTO_SYNC_INTERVAL = 5 * 60 * 1000; // 5 分钟自动备份

let autoSyncTimer: ReturnType<typeof setInterval> | null = null;
let uploadingLock = false;

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function getLocalSyncVersion(): number {
  return Number(localStorage.getItem(VERSION_KEY) || '0');
}

function setLocalSyncVersion(version: number): void {
  localStorage.setItem(VERSION_KEY, String(version));
}

async function api(path: string, options: RequestInit = {}): Promise<any> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    throw new Error('登录已过期，请重新输入密码');
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

export async function isCloudConfigured(): Promise<boolean> {
  try {
    const data = await api('/auth/status');
    return data.configured === true;
  } catch {
    return false;
  }
}

export async function setupPassphrase(passphrase: string): Promise<void> {
  const data = await api('/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ passphrase }),
  });
  setToken(data.token);
}

export async function loginWithPassphrase(passphrase: string): Promise<void> {
  const data = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ passphrase }),
  });
  setToken(data.token);
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

export function logout(): void {
  clearToken();
}

export interface SyncStatus {
  latest_version: number;
  total_snapshots: number;
  total_size_bytes: number;
  payload_size_bytes: number;
  created_at: string | null;
}

export async function getServerSyncStatus(): Promise<SyncStatus> {
  return api('/sync/status');
}

export async function uploadArchive(): Promise<number> {
  const payload = await createAppArchivePayload();
  const localVersion = getLocalSyncVersion();
  const data = await api('/sync/upload', {
    method: 'POST',
    body: JSON.stringify({ payload, local_version: localVersion }),
  });
  setLocalSyncVersion(data.version);
  return data.version;
}

export async function downloadAndRestoreArchive(): Promise<number> {
  const data = await api('/sync/download');
  await restoreAppArchivePayload(data.payload);
  setLocalSyncVersion(data.version);
  return data.version;
}

// ─── Auto Sync ────────────────────────────────────────────────

const HERMES_WEBHOOK_URL = '/read-something/hermes-sync';
const HERMES_WEBHOOK_SECRET = '0e06aefc3bf032fa0214d5e5794b1f1dff378c1027d9655bb2dde93f989fd0cc';

async function hmacSign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return 'sha256=' + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function syncChatToHermes(targetChar = '沈季白'): Promise<number> {
  /** Extract conversations with targetChar and push to hermes webhook. */
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('app_reader_chat_history_db_v1', 1);
    req.onsuccess = async () => {
      const db = req.result;
      const tx = db.transaction('chat_history_store', 'readonly');
      const store = tx.objectStore('chat_history_store');
      const getReq = store.get('chat_store_v1');
      getReq.onsuccess = async () => {
        db.close();
        const chatStore = getReq.result || {};
        const matched: any[] = [];
        for (const [key, bucket] of Object.entries(chatStore)) {
          if (!bucket || typeof bucket !== 'object') continue;
          const b = bucket as any;
          const charName = b.characterName || '';
          const personaName = b.personaName || '';
          if (!charName.includes(targetChar) && !personaName.includes(targetChar)) continue;
          const msgs = (b.messages || []).slice(-30);
          matched.push({
            conversation_key: key,
            character: charName,
            persona: personaName,
            message_count: msgs.length,
            messages: msgs.map((m: any) => ({
              sender: m.sender,
              content: m.content,
              time: new Date(m.timestamp).toISOString(),
            })),
          });
        }

        if (matched.length === 0) {
          resolve(0);
          return;
        }

        const payload = {
          source: 'read-something',
          synced_at: new Date().toISOString(),
          conversations: matched,
        };

        try {
          const body = JSON.stringify(payload);
          const sig = await hmacSign(HERMES_WEBHOOK_SECRET, body);
          const resp = await fetch(HERMES_WEBHOOK_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Hub-Signature-256': sig,
            },
            body,
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error((err as any).error || `HTTP ${resp.status}`);
          }
          resolve(matched.length);
        } catch (e: any) {
          reject(e);
        }
      };
      getReq.onerror = () => { db.close(); reject(new Error('读取聊天记录失败')); };
    };
    req.onerror = () => reject(new Error('打开数据库失败'));
  });
}

async function autoUpload(): Promise<void> {
  if (uploadingLock) return;
  if (!isLoggedIn()) return;
  uploadingLock = true;
  try {
    const status = await getServerSyncStatus();
    const localVer = getLocalSyncVersion();
    // Sync chat to hermes regardless of version match
    syncChatToHermes().catch(() => {});
    if (localVer >= status.latest_version) return; // already in sync
    await uploadArchive();
    localStorage.setItem(LAST_UPLOAD_KEY, String(Date.now()));
  } catch {
    // Network error, ignore silently
  } finally {
    uploadingLock = false;
  }
}

export function startAutoSync(): void {
  if (!isLoggedIn()) return;

  // Auto-upload every AUTO_SYNC_INTERVAL
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  autoSyncTimer = setInterval(autoUpload, AUTO_SYNC_INTERVAL);

  // Auto-upload on page close
  window.addEventListener('beforeunload', () => {
    if (!isLoggedIn()) return;
    // Use sendBeacon for fire-and-forget when possible
    const data = JSON.stringify({ closing: true, ts: Date.now() });
    try {
      navigator.sendBeacon(`${API_BASE}/api/health`, data);
    } catch {
      // ignore
    }
  });

  // Do an initial upload if never done or last upload was > 30 min ago
  const lastUpload = Number(localStorage.getItem(LAST_UPLOAD_KEY) || '0');
  if (!lastUpload || Date.now() - lastUpload > 30 * 60 * 1000) {
    setTimeout(autoUpload, 3000); // Delay to let app finish init
  }
}

export function stopAutoSync(): void {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
}

export async function initCloudAutoRestore(): Promise<boolean> {
  /** Auto-restore on app startup if local is empty and cloud has data. */
  if (!isLoggedIn()) return false;
  try {
    const status = await getServerSyncStatus();
    if (status.latest_version === 0) return false;

    const localVer = getLocalSyncVersion();
    if (localVer >= status.latest_version) return false;

    // local version is behind — auto-pull from cloud
    await downloadAndRestoreArchive();
    return true;
  } catch {
    return false;
  }
}
