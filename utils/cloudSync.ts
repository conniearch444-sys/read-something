// no-alert-v2
import {
  createAppArchivePayload,
  restoreAppArchivePayload,
} from './appArchive';
import { getChatStoreDigest } from './readerChatRuntime';

const API_BASE = '/read-something/api';
const TOKEN_KEY = 'app_cloud_token';
const VERSION_KEY = 'app_cloud_sync_version';
const LAST_UPLOAD_KEY = 'app_cloud_last_upload';
const AUTO_SYNC_INTERVAL = 30 * 1000; // 30 秒自动备份（调试中）

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
    console.warn('[云同步] 401 认证失败，保留 token 不清除');
    throw new Error('认证失败');
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

export async function uploadArchive(since?: number): Promise<number> {
  const payload = await createAppArchivePayload(since);
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

export async function syncChatToHermes(): Promise<number> {
  /** Tell the server to push chat history from the latest archive to hermes.
   *  Uses the server-side API to avoid browser crypto.subtle (requires HTTPS). */
  if (!isLoggedIn()) {
    console.log('[Hermes同步] 跳过：未登录');
    return 0;
  }
  try {
    const token = getToken();
    const res = await fetch(`${API_BASE}/sync/chat-to-hermes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const text = await res.text();
    console.log(`[Hermes同步] HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (!res.ok) return 0;
    const data = JSON.parse(text);
    return (data as any).conversation_count || 1;
  } catch (e: any) {
    console.log(`[Hermes同步] 异常: ${e.message || e}`);
    return 0;
  }
}

function appendSyncLog(entry: string): void {
  const key = 'sync_diag_log';
  try {
    const prev = JSON.parse(localStorage.getItem(key) || '[]');
    prev.push({ t: new Date().toISOString(), msg: entry });
    if (prev.length > 20) prev.shift();
    localStorage.setItem(key, JSON.stringify(prev));
  } catch {}
}

async function autoUpload(): Promise<void> {
  if (uploadingLock) { appendSyncLog('跳过：上一次上传未完成'); return; }
  if (!isLoggedIn()) { appendSyncLog('跳过：未登录'); return; }
  uploadingLock = true;
  try {
    const digest = await getChatStoreDigest();
    const lastDigest = localStorage.getItem('last_upload_digest');
    const localVer = getLocalSyncVersion();
    appendSyncLog('检查: digest=' + digest + ' last=' + lastDigest + ' localVer=' + localVer);
    if (digest !== lastDigest) {
      const since = lastDigest ? Number(lastDigest.split('-')[1]) || 0 : 0;
      appendSyncLog('上传中 since=' + since + ' ...');
      const newVer = await uploadArchive(since);
      appendSyncLog('上传成功 ver=' + newVer);
      localStorage.setItem('last_upload_digest', digest);
    } else {
      appendSyncLog('跳过：digest 未变');
    }
    await syncChatToHermes();
    localStorage.setItem(LAST_UPLOAD_KEY, String(Date.now()));
  } catch (e: any) {
    var errMsg = '失败: ' + (e?.message || String(e));
    appendSyncLog(errMsg);
  } finally {
    uploadingLock = false;
  }
}

export function startAutoSync(): void {
  var started = 'startAutoSync 调用, loggedIn=' + isLoggedIn();
  appendSyncLog(started);
  if (!isLoggedIn()) {
    var skipMsg = 'startAutoSync 跳过：未登录';
    appendSyncLog(skipMsg);
    return;
  }
  appendSyncLog('自动同步已启动, 间隔30s');

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
