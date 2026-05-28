import { Book, Chapter, ReaderBookState, ReaderSummaryCard } from '../types';

const BOOK_CONTENT_DB_NAME = 'app_book_content_v1';
const BOOK_CONTENT_STORE = 'book_contents';
const BOOK_CONTENT_DB_VERSION = 2;

export interface StoredBookContent {
  fullText: string;
  chapters: Chapter[];
  readerState?: ReaderBookState;
  bookSummaryCards?: ReaderSummaryCard[];
  bookAutoSummaryLastEnd?: number;
}

const normalizeSummaryCard = (value: unknown): ReaderSummaryCard | null => {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<ReaderSummaryCard>;
  const id = typeof source.id === 'string' && source.id.trim() ? source.id : '';
  const content = typeof source.content === 'string' ? source.content.trim() : '';
  const start = Number(source.start);
  const end = Number(source.end);
  if (!id || !content || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const safeStart = Math.max(0, Math.floor(start));
  const safeEnd = Math.max(safeStart, Math.floor(end));
  const createdAt = Number(source.createdAt);
  const updatedAt = Number(source.updatedAt);
  return {
    id,
    content,
    start: safeStart,
    end: safeEnd,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
};

const normalizeChapterBlocks = (value: unknown): Chapter['blocks'] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const blocks = value.reduce<NonNullable<Chapter['blocks']>>((acc, item) => {
    if (!item || typeof item !== 'object') return acc;
    const source = item as Partial<NonNullable<Chapter['blocks']>[number]>;

    if (source.type === 'text') {
      if (typeof (source as { text?: unknown }).text !== 'string') return acc;
      acc.push({
        type: 'text',
        text: (source as { text: string }).text,
      });
      return acc;
    }

    if (source.type === 'image') {
      const imageRef = typeof (source as { imageRef?: unknown }).imageRef === 'string'
        ? (source as { imageRef: string }).imageRef.trim()
        : '';
      if (!imageRef) return acc;
      const width = Number((source as { width?: unknown }).width);
      const height = Number((source as { height?: unknown }).height);
      acc.push({
        type: 'image',
        imageRef,
        alt: typeof (source as { alt?: unknown }).alt === 'string'
          ? (source as { alt: string }).alt
          : undefined,
        title: typeof (source as { title?: unknown }).title === 'string'
          ? (source as { title: string }).title
          : undefined,
        width: Number.isFinite(width) && width > 0 ? Math.round(width) : undefined,
        height: Number.isFinite(height) && height > 0 ? Math.round(height) : undefined,
      });
    }

    return acc;
  }, []);

  return blocks.length > 0 ? blocks : undefined;
};

const normalizeChapter = (value: unknown): Chapter | null => {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<Chapter>;
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const content = typeof source.content === 'string' ? source.content : '';
  if (!title && !content) return null;
  const blocks = normalizeChapterBlocks((source as { blocks?: unknown }).blocks);
  return {
    title: title || '未命名章节',
    content,
    ...(blocks ? { blocks } : {}),
  };
};

const normalizeReaderState = (value: unknown): ReaderBookState | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const cleaned = JSON.parse(JSON.stringify(value));
    if (!cleaned || typeof cleaned !== 'object' || Array.isArray(cleaned)) return undefined;
    return cleaned as ReaderBookState;
  } catch {
    return undefined;
  }
};

const normalizeStoredBookContent = (value: unknown): StoredBookContent | null => {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<StoredBookContent>;
  const fullText = typeof source.fullText === 'string' ? source.fullText : '';
  const chapters = Array.isArray(source.chapters)
    ? source.chapters
        .map((item) => normalizeChapter(item))
        .filter((item): item is Chapter => Boolean(item))
    : [];
  const bookSummaryCards = Array.isArray(source.bookSummaryCards)
    ? source.bookSummaryCards
        .map((item) => normalizeSummaryCard(item))
        .filter((item): item is ReaderSummaryCard => Boolean(item))
    : [];
  const bookAutoSummaryLastEnd = Number.isFinite(Number(source.bookAutoSummaryLastEnd))
    ? Math.max(0, Math.floor(Number(source.bookAutoSummaryLastEnd)))
    : 0;
  return {
    fullText,
    chapters,
    ...(source.readerState != null ? { readerState: normalizeReaderState(source.readerState) } : {}),
    bookSummaryCards,
    bookAutoSummaryLastEnd,
  };
};

let dbPromise: Promise<IDBDatabase> | null = null;

const isVersionError = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'VersionError');

const openBookContentDbRequest = (version?: number): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = typeof version === 'number'
      ? indexedDB.open(BOOK_CONTENT_DB_NAME, version)
      : indexedDB.open(BOOK_CONTENT_DB_NAME);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BOOK_CONTENT_STORE)) {
        db.createObjectStore(BOOK_CONTENT_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开书籍内容数据库失败'));
  });

const openBookContentDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  dbPromise = openBookContentDbRequest(BOOK_CONTENT_DB_VERSION)
    .catch((error) => {
      if (isVersionError(error)) {
        return openBookContentDbRequest();
      }
      throw error;
    })
    .catch((error) => {
      dbPromise = null;
      throw error;
    });

  return dbPromise;
};

export const saveBookContent = async (bookId: string, fullText: string, chapters: Chapter[]): Promise<void> => {
  const db = await openBookContentDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BOOK_CONTENT_STORE, 'readwrite');
    const store = tx.objectStore(BOOK_CONTENT_STORE);

    const getRequest = store.get(bookId);
    getRequest.onsuccess = () => {
      const existing = normalizeStoredBookContent(getRequest.result);
      const payload: StoredBookContent = {
        fullText,
        chapters,
        readerState: existing?.readerState,
        bookSummaryCards: existing?.bookSummaryCards || [],
        bookAutoSummaryLastEnd: existing?.bookAutoSummaryLastEnd || 0,
      };
      store.put(payload, bookId);
    };
    getRequest.onerror = () => reject(getRequest.error || new Error('读取已有书籍内容失败'));

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('保存书籍内容失败'));
    tx.onabort = () => reject(tx.error || new Error('保存书籍内容失败'));
  });

  // 写入成功后同步更新当前摘要，使后续增量上传能从 localStorage 直接读取
  try {
    updateCurrentBookDigest(bookId, { fullText, chapters });
  } catch { /* localStorage 满或不可用时静默跳过 */ }
};

export const saveBookReaderState = async (bookId: string, readerState: ReaderBookState): Promise<void> => {
  const db = await openBookContentDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BOOK_CONTENT_STORE, 'readwrite');
    const store = tx.objectStore(BOOK_CONTENT_STORE);

    const getRequest = store.get(bookId);
    getRequest.onsuccess = () => {
      const existing = normalizeStoredBookContent(getRequest.result) || { fullText: '', chapters: [] };
      const payload: StoredBookContent = {
        fullText: existing.fullText || '',
        chapters: existing.chapters || [],
        readerState,
        bookSummaryCards: existing.bookSummaryCards || [],
        bookAutoSummaryLastEnd: existing.bookAutoSummaryLastEnd || 0,
      };
      store.put(payload, bookId);
    };
    getRequest.onerror = () => reject(getRequest.error || new Error('读取已有阅读状态失败'));

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('保存阅读状态失败'));
    tx.onabort = () => reject(tx.error || new Error('保存阅读状态失败'));
  });
};

export const saveBookSummaryState = async (
  bookId: string,
  summary: {
    bookSummaryCards?: ReaderSummaryCard[];
    bookAutoSummaryLastEnd?: number;
  }
): Promise<void> => {
  const db = await openBookContentDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BOOK_CONTENT_STORE, 'readwrite');
    const store = tx.objectStore(BOOK_CONTENT_STORE);

    const getRequest = store.get(bookId);
    getRequest.onsuccess = () => {
      const existing = normalizeStoredBookContent(getRequest.result) || { fullText: '', chapters: [] };
      const payload: StoredBookContent = {
        fullText: existing.fullText || '',
        chapters: existing.chapters || [],
        readerState: existing.readerState,
        bookSummaryCards: summary.bookSummaryCards || existing.bookSummaryCards || [],
        bookAutoSummaryLastEnd:
          typeof summary.bookAutoSummaryLastEnd === 'number'
            ? Math.max(0, Math.floor(summary.bookAutoSummaryLastEnd))
            : existing.bookAutoSummaryLastEnd || 0,
      };
      store.put(payload, bookId);
    };
    getRequest.onerror = () => reject(getRequest.error || new Error('读取已有摘要状态失败'));

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('保存摘要状态失败'));
    tx.onabort = () => reject(tx.error || new Error('保存摘要状态失败'));
  });
};

export const getBookContent = async (bookId: string): Promise<StoredBookContent | null> => {
  const db = await openBookContentDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOK_CONTENT_STORE, 'readonly');
    const store = tx.objectStore(BOOK_CONTENT_STORE);
    const request = store.get(bookId);

    request.onsuccess = () => {
      const result = normalizeStoredBookContent(request.result);
      resolve(result || null);
    };
    request.onerror = () => reject(request.error || new Error('读取书籍内容失败'));
  });
};

export const deleteBookContent = async (bookId: string): Promise<void> => {
  const db = await openBookContentDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BOOK_CONTENT_STORE, 'readwrite');
    const store = tx.objectStore(BOOK_CONTENT_STORE);
    store.delete(bookId);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('删除书籍内容失败'));
    tx.onabort = () => reject(tx.error || new Error('删除书籍内容失败'));
  });

  try { removeCurrentBookDigest(bookId); } catch { /* ignore */ }
};

export const getBookTextLength = (book: Partial<Book>): number => {
  if (typeof book.fullTextLength === 'number') return book.fullTextLength;
  if (typeof book.fullText === 'string') return book.fullText.length;
  return 0;
};

const compactBook = (book: Book, fullTextLength: number, chapterCount: number): Book => {
  return {
    ...book,
    fullText: '',
    chapters: [],
    fullTextLength,
    chapterCount,
  };
};

export const migrateInlineBookContent = async (books: Book[]): Promise<Book[]> => {
  let changed = false;

  const migrated = await Promise.all(
    books.map(async (book) => {
      const hasInlineText = typeof book.fullText === 'string' && book.fullText.length > 0;
      const hasInlineChapters = Array.isArray(book.chapters) && book.chapters.length > 0;

      if (!hasInlineText && !hasInlineChapters) {
        const estimatedLength =
          typeof book.fullText === 'string' ? book.fullText.length : (book.fullTextLength || 0);
        const estimatedChapters =
          Array.isArray(book.chapters) ? book.chapters.length : (book.chapterCount || 0);

        if (estimatedLength > 0 || estimatedChapters > 0) {
          return compactBook(book, estimatedLength, estimatedChapters);
        }

        // Backfill old compacted records (length/count were 0) from IndexedDB payload if it exists.
        const stored = await getBookContent(book.id).catch(() => null);
        if (stored) {
          const backfilledLength = stored.fullText?.length || 0;
          const backfilledChapters = stored.chapters?.length || 0;
          if (backfilledLength > 0 || backfilledChapters > 0) {
            changed = true;
            return compactBook(book, backfilledLength, backfilledChapters);
          }
        }

        return compactBook(book, estimatedLength, estimatedChapters);
      }

      const fullText = book.fullText || '';
      const chapters = book.chapters || [];
      await saveBookContent(book.id, fullText, chapters);
      changed = true;
      return compactBook(book, fullText.length, chapters.length);
    })
  );

  if (!changed) {
    const needsCompaction = migrated.some(
      (book, idx) => book.fullText !== books[idx]?.fullText || book.chapters !== books[idx]?.chapters
    );
    return needsCompaction ? migrated : books;
  }

  return migrated;
};

export const compactBookForState = (book: Book): Book => {
  const fullTextLength = typeof book.fullText === 'string' ? book.fullText.length : (book.fullTextLength || 0);
  const chapterCount = Array.isArray(book.chapters) ? book.chapters.length : (book.chapterCount || 0);
  return compactBook(book, fullTextLength, chapterCount);
};

export const getAllBookContents = async (): Promise<Record<string, StoredBookContent>> => {
  const db = await openBookContentDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOK_CONTENT_STORE, 'readonly');
    const store = tx.objectStore(BOOK_CONTENT_STORE);
    const request = store.openCursor();
    const result: Record<string, StoredBookContent> = {};

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(result);
        return;
      }
      const key = typeof cursor.key === 'string' ? cursor.key : `${cursor.key}`;
      const normalized = normalizeStoredBookContent(cursor.value);
      if (normalized) {
        result[key] = normalized;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error('读取全部书籍内容失败'));
  });
};

// ─── 书籍内容摘要（增量上传用）──────────────────────────────────────
// 摘要由 saveBookContent / deleteBookContent / replaceAllBookContents 维护，
// 存入 localStorage（仅几十 KB），上传时无需读取 IndexedDB 即可判断变化。
// 只在摘要变化时才从 IndexedDB 读取完整内容，避免 1GB+ IndexedDB 全量加载导致 OOM。

const CURRENT_DIGESTS_KEY = 'app_book_current_digests';

const computeBookContentDigest = (content: { fullText: string; chapters: Chapter[] }): string => {
  const fullTextLen = content.fullText?.length || 0;
  const chapterCount = content.chapters?.length || 0;
  if (fullTextLen === 0 && chapterCount === 0) return 'empty';
  const head = content.fullText?.slice(0, 200) || '';
  const tail = fullTextLen > 400 ? content.fullText?.slice(-200) || '' : '';
  const chapterTitles = (content.chapters || []).map(c => c.title || '').join('|').slice(0, 500);
  const sample = `${fullTextLen}:${chapterCount}:${head}:${tail}:${chapterTitles}`;
  let hash = 5381;
  for (let i = 0; i < sample.length; i++) {
    hash = ((hash << 5) + hash + sample.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
};

export const getCurrentBookContentDigests = (): Record<string, string> => {
  try {
    const raw = localStorage.getItem(CURRENT_DIGESTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || !parsed) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
};

const updateCurrentBookDigest = (bookId: string, content: { fullText: string; chapters: Chapter[] }): void => {
  const digests = getCurrentBookContentDigests();
  digests[bookId] = computeBookContentDigest(content);
  localStorage.setItem(CURRENT_DIGESTS_KEY, JSON.stringify(digests));
};

const removeCurrentBookDigest = (bookId: string): void => {
  const digests = getCurrentBookContentDigests();
  delete digests[bookId];
  localStorage.setItem(CURRENT_DIGESTS_KEY, JSON.stringify(digests));
};

const storeAllCurrentBookDigests = (digests: Record<string, string>): void => {
  localStorage.setItem(CURRENT_DIGESTS_KEY, JSON.stringify(digests));
};

// 读取上次上传成功时的摘要快照（用于增量对比）
const STORED_DIGESTS_KEY = 'app_book_content_digests';
export const getStoredBookContentDigests = (): Record<string, string> => {
  try {
    const raw = localStorage.getItem(STORED_DIGESTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || !parsed) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
};

export const storeBookContentDigests = (digests: Record<string, string>): void => {
  localStorage.setItem(STORED_DIGESTS_KEY, JSON.stringify(digests));
};

// 获取自上次上传以来内容有变化的书籍（或新增的书籍）。
// 从 localStorage 读取当前摘要（由 saveBookContent 维护），与上次上传快照对比，
// 只在摘要变化时才从 IndexedDB 读完整内容——避免 1GB+ IndexedDB 全量加载导致平板 OOM。
// 首次加载时 currentDigests 为空，做一次全量填充后（一次性代价），后续全部增量。
export const getChangedBookContents = async (): Promise<{
  changed: Record<string, StoredBookContent>;
  allDigests: Record<string, string>;
}> => {
  const currentDigests = getCurrentBookContentDigests();
  const storedDigests = getStoredBookContentDigests();

  // 首次加载：localStorage 中没有当前摘要，需做一次全量 IndexedDB 扫描来填充。
  // 这次扫描有一次性内存成本，但只发生在新代码首次运行或 localStorage 被清空后。
  if (Object.keys(currentDigests).length === 0) {
    const allContents = await getAllBookContents();
    const populated: Record<string, string> = {};
    for (const [bookId, content] of Object.entries(allContents)) {
      populated[bookId] = computeBookContentDigest(content);
    }
    try { storeAllCurrentBookDigests(populated); } catch { /* ignore */ }

    const changed: Record<string, StoredBookContent> = {};
    for (const [bookId, currentDigest] of Object.entries(populated)) {
      if (currentDigest !== storedDigests[bookId]) {
        changed[bookId] = allContents[bookId];
      }
    }
    for (const bookId of Object.keys(storedDigests)) {
      if (!(bookId in populated)) {
        populated[bookId] = 'deleted';
      }
    }
    console.log('[摘要] 首次填充完成: 总数=' + Object.keys(populated).length + ' 变化=' + Object.keys(changed).length);
    return { changed, allDigests: populated };
  }

  // 正常增量模式：从 localStorage 读摘要，只在摘要变化时读 IndexedDB
  const changed: Record<string, StoredBookContent> = {};
  const allDigests: Record<string, string> = { ...currentDigests };
  let checkedCount = 0;
  let changedCount = 0;

  for (const [bookId, currentDigest] of Object.entries(currentDigests)) {
    checkedCount++;
    if (currentDigest !== storedDigests[bookId]) {
      changedCount++;
      try {
        const content = await getBookContent(bookId);
        if (content) {
          changed[bookId] = content;
        }
      } catch (e: any) {
        console.warn('[摘要] 读取变化书籍内容失败:', bookId, e?.message || e);
      }
    }
  }

  for (const bookId of Object.keys(storedDigests)) {
    if (!(bookId in currentDigests)) {
      allDigests[bookId] = 'deleted';
    }
  }

  console.log('[摘要] 增量模式: 检查=' + checkedCount + ' 变化=' + changedCount + ' IndexedDB读取=' + Object.keys(changed).length);
  return { changed, allDigests };
};

export const clearAllBookContents = async (): Promise<void> => {
  const db = await openBookContentDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BOOK_CONTENT_STORE, 'readwrite');
    const store = tx.objectStore(BOOK_CONTENT_STORE);
    store.clear();

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('清空书籍内容失败'));
    tx.onabort = () => reject(tx.error || new Error('清空书籍内容失败'));
  });
};

export const replaceAllBookContents = async (nextEntries: Record<string, StoredBookContent>): Promise<void> => {
  const db = await openBookContentDb();
  const entries = Object.entries(nextEntries || {});

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BOOK_CONTENT_STORE, 'readwrite');
    const store = tx.objectStore(BOOK_CONTENT_STORE);
    store.clear();

    entries.forEach(([bookId, payload]) => {
      if (!bookId || typeof bookId !== 'string') return;
      const normalized = normalizeStoredBookContent(payload);
      if (!normalized) return;
      store.put(normalized, bookId);
    });

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('替换书籍内容失败'));
    tx.onabort = () => reject(tx.error || new Error('替换书籍内容失败'));
  });

  // 替换后全量刷新当前摘要
  try {
    const digests: Record<string, string> = {};
    for (const [bookId, payload] of Object.entries(nextEntries || {})) {
      if (!bookId || typeof bookId !== 'string') continue;
      const normalized = normalizeStoredBookContent(payload);
      if (!normalized) continue;
      digests[bookId] = computeBookContentDigest(normalized);
    }
    storeAllCurrentBookDigests(digests);
  } catch { /* ignore */ }
};

export const getBookContentStorageUsageBytes = async (): Promise<{ totalBytes: number; byBookId: Record<string, number> }> => {
  const encoder = new TextEncoder();
  const allContents = await getAllBookContents();
  const byBookId: Record<string, number> = {};

  let totalBytes = 0;
  Object.entries(allContents).forEach(([bookId, payload]) => {
    const serialized = JSON.stringify(payload);
    const bytes = encoder.encode(serialized).length;
    byBookId[bookId] = bytes;
    totalBytes += bytes;
  });

  return { totalBytes, byBookId };
};
