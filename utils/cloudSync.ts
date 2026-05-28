import {
  createAppArchivePayload,
  restoreAppArchivePayload,
} from './appArchive';
import { getChatStoreDigest, hydrateReaderChatStore } from './readerChatRuntime';

const API_BASE = '/read-something/api';
const TOKEN_KEY = 'app_cloud_token';
const VERSION_KEY = 'app_cloud_sync_version';
const LAST_UPLOAD_KEY = 'app_cloud_last_upload';
const AUTO_SYNC_INTERVAL = 5 * 60 * 1000; // 5 分钟自动备份

let autoSyncTimer: ReturnType<typeof setInterval> | null = null;
let autoUploadTimer: ReturnType<typeof setTimeout> | null = null;
let uploadingLock = false;
let beforeunloadRegistered = false;

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

async function autoUpload(force?: boolean): Promise<void> {
  if (uploadingLock) {
    console.log('[云同步] autoUpload 跳过：上传锁已被持有');
    return;
  }
  if (!isLoggedIn()) {
    console.log('[云同步] autoUpload 跳过：未登录');
    return;
  }

  // 清理定时器引用（来自 setTimeout 的单次调用已触发，清除引用）
  if (autoUploadTimer) {
    autoUploadTimer = null;
  }

  // ?force=1 参数：清除上次摘要，强制触发全量上传（无论 digest 是否变化）
  if (force) {
    localStorage.removeItem('last_upload_digest');
    console.log('[云同步] force=1 检测到，清除摘要缓存，即将强制全量上传');
  }

  uploadingLock = true;
  try {
    // 等待聊天记录水合完成，确保 digest 计算准确（避免缓存未就绪时 digest='0-0'）
    await hydrateReaderChatStore();
    const chatDigest = getChatStoreDigest();
    const booksRaw = localStorage.getItem('app_books') || '';
    const digest = chatDigest + '|' + (booksRaw.length > 0 ? String(booksRaw.length) + '-' + String(booksRaw.split('"id"').length) : '0');
    const lastDigest = localStorage.getItem('last_upload_digest');
    console.log('[云同步] 摘要对比: current=' + digest + ' last=' + (lastDigest || '(null)') + ' force=' + !!force);
    if (force || digest !== lastDigest) {
      const since = force ? 0 : (lastDigest ? Number(lastDigest.split('-')[1]) || 0 : 0);
      console.log('[云同步] 开始上传, since=' + since);
      await uploadArchive(since);
      console.log('[云同步] 上传完成' + (force ? '（强制全量）' : '（增量）'));
      localStorage.setItem('last_upload_digest', digest);
    } else {
      console.log('[云同步] 跳过上传：摘要无变化 (digest=' + digest + ')');
    }
    await syncChatToHermes();
    localStorage.setItem(LAST_UPLOAD_KEY, String(Date.now()));
  } catch (err: any) {
    console.error('[云同步] 自动上传失败:', err?.message || err, err?.stack || '');
  } finally {
    uploadingLock = false;
  }
}

export function startAutoSync(): void {
  console.log('[Hermes同步] startAutoSync 调用, loggedIn=' + isLoggedIn());
  if (!isLoggedIn()) {
    console.log('[Hermes同步] startAutoSync 跳过：未登录');
    return;
  }

  // Auto-upload every AUTO_SYNC_INTERVAL
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  autoSyncTimer = setInterval(autoUpload, AUTO_SYNC_INTERVAL);

  // Auto-upload on page close (只注册一次)
  if (!beforeunloadRegistered) {
    beforeunloadRegistered = true;
    window.addEventListener('beforeunload', () => {
      if (!isLoggedIn()) return;
      const data = JSON.stringify({ closing: true, ts: Date.now() });
      try {
        navigator.sendBeacon(`${API_BASE}/api/health`, data);
      } catch {
        // ignore
      }
    });
  }

  // 清除之前的单次上传定时器，防止多次调用堆积
  if (autoUploadTimer) {
    clearTimeout(autoUploadTimer);
    autoUploadTimer = null;
  }

  // Do an initial upload if never done or last upload was > 30 min ago
  const forceUpload = new URLSearchParams(window.location.search).get('force') === '1';
  const lastUpload = Number(localStorage.getItem(LAST_UPLOAD_KEY) || '0');
  if (forceUpload || !lastUpload || Date.now() - lastUpload > 30 * 60 * 1000) {
    console.log('[云同步] 调度首次上传, force=' + forceUpload + ' 延时3秒');
    // 通过闭包捕获 force，不依赖执行时 URL
    autoUploadTimer = setTimeout(() => autoUpload(forceUpload), 3000);
  }
}

export function stopAutoSync(): void {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
  if (autoUploadTimer) {
    clearTimeout(autoUploadTimer);
    autoUploadTimer = null;
  }
}

export async function initCloudAutoRestore(): Promise<boolean> {
  /** Auto-restore on app startup if local is empty and cloud has data. */
  if (!isLoggedIn()) return false;
  if (new URLSearchParams(window.location.search).get('force') === '1') return false;
  // 本地已有书籍 → 不覆盖
  try { const raw = localStorage.getItem('app_books'); if (raw) { const b = JSON.parse(raw); if (Array.isArray(b) && b.length > 0) return false; } } catch {}
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
