import { ReaderAiUnderlineRange, ReaderSummaryCard } from '../types';
import {
  getStoredChatHistoryStore,
  saveStoredChatHistoryStore,
} from './chatHistoryStorage';

export type ChatSender = 'user' | 'character';

export interface ChatQuotePayload {
  sourceMessageId: string;
  sender: ChatSender;
  senderName: string;
  content: string;
  timestamp: number;
}

export interface ChatBubble {
  id: string;
  sender: ChatSender;
  content: string;
  timestamp: number;
  promptRecord: string;
  sentToAi: boolean;
  quote?: ChatQuotePayload;
  generationId?: string;
  editedAt?: number;
  imageUrls?: string[];
}

export interface ReaderChatBucket {
  updatedAt: number;
  messages: ChatBubble[];
  personaName: string;
  characterName: string;
  chatHistorySummary: string;
  readingPrefixSummaryByBookId: Record<string, string>;
  readingAiUnderlinesByBookId: Record<string, Record<string, ReaderAiUnderlineRange[]>>;
  chatSummaryCards: ReaderSummaryCard[];
  chatAutoSummaryLastEnd: number;
}

export type ReaderChatStore = Record<string, ReaderChatBucket>;
export type GenerationMode = 'manual' | 'proactive';

export interface ChatStoreUpdatedEventDetail {
  conversationKey: string;
  bucket: ReaderChatBucket;
  reason?: string;
}

export interface GenerationStatusEventDetail {
  conversationKey: string;
  isLoading: boolean;
  mode: GenerationMode | null;
  requestId: string | null;
  previousMode?: GenerationMode;
  reason?: string;
}

interface GenerationRecord {
  mode: GenerationMode;
  requestId: string;
  controller: AbortController;
}

const DEFAULT_USER_NAME = 'User';
const DEFAULT_CHAR_NAME = 'Char';

export const CHAT_HISTORY_STORAGE_KEY = 'app_reader_chat_history_v1';
export const CHAT_STORE_UPDATED_EVENT = 'app-reader-chat-store-updated';
export const GENERATION_STATUS_EVENT = 'app-reader-chat-generation-status';

const generationRegistry = new Map<string, GenerationRecord>();
let chatStoreCache: ReaderChatStore = {};
let chatStoreHydrated = false;
let chatStoreHydrationPromise: Promise<void> | null = null;
let chatStorePersistQueue: Promise<void> = Promise.resolve();
let pendingStoreBeforeHydration: ReaderChatStore | null = null;

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const compactText = (value: string) => value.replace(/\s+/g, ' ').trim();
const LEGACY_PROMPT_ROLE_PREFIX_RE = /^\[(?:用户消息|角色消息)\]/;
const MODERN_PROMPT_RECORD_RE = /^\[发送者:[^\]]+\]\[[^\]]+\]\s*/;

const minutePad = (value: number) => `${value}`.padStart(2, '0');

export const formatTimestampMinute = (timestamp: number) => {
  const date = new Date(timestamp);
  const yyyy = date.getFullYear();
  const mm = minutePad(date.getMonth() + 1);
  const dd = minutePad(date.getDate());
  const hh = minutePad(date.getHours());
  const min = minutePad(date.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
};

export const buildConversationKey = (bookId: string | null, personaId: string | null, characterId: string | null) =>
  `book:${bookId || 'none'}::persona:${personaId || 'none'}::character:${characterId || 'none'}`;

interface ParsedConversationKey {
  bookId: string | null;
  personaId: string | null;
  characterId: string | null;
}

const parseConversationKey = (conversationKey: string): ParsedConversationKey | null => {
  const matched = conversationKey.match(/^book:(.+?)::persona:(.+?)::character:(.+)$/);
  if (!matched) return null;
  return {
    bookId: matched[1] === 'none' ? null : matched[1],
    personaId: matched[2] === 'none' ? null : matched[2],
    characterId: matched[3] === 'none' ? null : matched[3],
  };
};

const buildConversationArchiveIdentity = (conversationKey: string, bucket: ReaderChatBucket) => {
  const parsed = parseConversationKey(conversationKey);
  if (!parsed) return '';
  const personaName = compactText(bucket.personaName || '').toLowerCase();
  const characterName = compactText(bucket.characterName || '').toLowerCase();
  if (!personaName || !characterName) return '';
  return `book:${parsed.bookId || 'none'}::persona-name:${personaName}::character-name:${characterName}`;
};

const getBucketScore = (bucket: ReaderChatBucket) => {
  const messageCount = Array.isArray(bucket.messages) ? bucket.messages.length : 0;
  const summaryCount = Array.isArray(bucket.chatSummaryCards) ? bucket.chatSummaryCards.length : 0;
  const updatedAt = Number(bucket.updatedAt) || 0;
  return messageCount * 1_000_000 + summaryCount * 1_000 + updatedAt;
};

const mergeDuplicateBuckets = (left: ReaderChatBucket, right: ReaderChatBucket): ReaderChatBucket => {
  const preferLeft = getBucketScore(left) >= getBucketScore(right);
  const primary = preferLeft ? left : right;
  const secondary = preferLeft ? right : left;
  return normalizeChatBucket({
    ...primary,
    personaName: primary.personaName || secondary.personaName || '',
    characterName: primary.characterName || secondary.characterName || '',
    messages:
      (Array.isArray(primary.messages) ? primary.messages.length : 0) >=
      (Array.isArray(secondary.messages) ? secondary.messages.length : 0)
        ? primary.messages
        : secondary.messages,
    chatHistorySummary: primary.chatHistorySummary || secondary.chatHistorySummary || '',
    readingPrefixSummaryByBookId: {
      ...(secondary.readingPrefixSummaryByBookId || {}),
      ...(primary.readingPrefixSummaryByBookId || {}),
    },
    readingAiUnderlinesByBookId: {
      ...(secondary.readingAiUnderlinesByBookId || {}),
      ...(primary.readingAiUnderlinesByBookId || {}),
    },
    chatSummaryCards:
      (Array.isArray(primary.chatSummaryCards) ? primary.chatSummaryCards.length : 0) >=
      (Array.isArray(secondary.chatSummaryCards) ? secondary.chatSummaryCards.length : 0)
        ? primary.chatSummaryCards
        : secondary.chatSummaryCards,
    chatAutoSummaryLastEnd: Math.max(
      Number(primary.chatAutoSummaryLastEnd) || 0,
      Number(secondary.chatAutoSummaryLastEnd) || 0
    ),
    updatedAt: Math.max(Number(primary.updatedAt) || 0, Number(secondary.updatedAt) || 0),
  });
};

const dedupeConversationStore = (
  sourceStore: ReaderChatStore,
  preferredConversationKey?: string
): { store: ReaderChatStore; changed: boolean } => {
  const store: ReaderChatStore = { ...sourceStore };
  const identityToKey = new Map<string, string>();
  let changed = false;

  Object.keys(store).forEach((conversationKey) => {
    const bucket = store[conversationKey];
    if (!bucket) return;
    const identity = buildConversationArchiveIdentity(conversationKey, bucket);
    if (!identity) return;
    const existingKey = identityToKey.get(identity);
    if (!existingKey) {
      identityToKey.set(identity, conversationKey);
      return;
    }
    const existingBucket = store[existingKey];
    if (!existingBucket) {
      identityToKey.set(identity, conversationKey);
      return;
    }

    const keepKey =
      preferredConversationKey && (existingKey === preferredConversationKey || conversationKey === preferredConversationKey)
        ? preferredConversationKey
        : getBucketScore(existingBucket) >= getBucketScore(bucket)
          ? existingKey
          : conversationKey;
    const dropKey = keepKey === existingKey ? conversationKey : existingKey;
    const keepBucket = store[keepKey];
    const dropBucket = store[dropKey];
    if (!keepBucket || !dropBucket) return;

    store[keepKey] = mergeDuplicateBuckets(keepBucket, dropBucket);
    delete store[dropKey];
    identityToKey.set(identity, keepKey);
    changed = true;
  });

  return { store, changed };
};

export const buildUserPromptRecord = (
  userRealName: string,
  content: string,
  timestamp: number,
  quote?: ChatQuotePayload,
  imageCount?: number,
) => {
  const messageText = compactText(content);
  const imageText = imageCount && imageCount > 0 ? ` [用户发送了${imageCount}张图片，图片已直接展示在上方，请直接看图回应]` : '';
  const quoteText = quote
    ? ` [引用:发送者=${quote.senderName};时间=${formatTimestampMinute(quote.timestamp)};内容=${compactText(quote.content)}]`
    : '';
  return `[发送者:${userRealName}][${formatTimestampMinute(timestamp)}] ${messageText}${imageText}${quoteText}`;
};

export const buildCharacterPromptRecord = (characterRealName: string, content: string, timestamp: number) => {
  const messageText = compactText(content);
  return `[发送者:${characterRealName}][${formatTimestampMinute(timestamp)}] ${messageText}`;
};

const migratePromptRecordFormat = (value: string): string => {
  const compact = compactText(value || '');
  if (!compact) return '';
  return compact
    .replace(LEGACY_PROMPT_ROLE_PREFIX_RE, '')
    .replace(/\[时间:([^\]]+)\]/g, '[$1]');
};

export const defaultChatBucket = (): ReaderChatBucket => ({
  updatedAt: Date.now(),
  messages: [],
  personaName: '',
  characterName: '',
  chatHistorySummary: '',
  readingPrefixSummaryByBookId: {},
  readingAiUnderlinesByBookId: {},
  chatSummaryCards: [],
  chatAutoSummaryLastEnd: 0,
});

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

const normalizeSummaryCards = (value: unknown) => {
  if (!Array.isArray(value)) return [] as ReaderSummaryCard[];
  return value
    .map((item) => normalizeSummaryCard(item))
    .filter((item): item is ReaderSummaryCard => Boolean(item));
};

const normalizeQuotePayload = (value: unknown, fallbackTimestamp: number): ChatQuotePayload | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Partial<ChatQuotePayload>;
  if (source.sender !== 'user' && source.sender !== 'character') return undefined;
  if (typeof source.content !== 'string') return undefined;
  if (typeof source.senderName !== 'string') return undefined;
  const content = compactText(source.content);
  if (!content) return undefined;
  const timestamp = Number(source.timestamp);
  if (!Number.isFinite(timestamp)) return undefined;
  return {
    sourceMessageId:
      typeof source.sourceMessageId === 'string' && source.sourceMessageId.trim()
        ? source.sourceMessageId
        : `quote-${fallbackTimestamp}`,
    sender: source.sender,
    senderName: compactText(source.senderName) || (source.sender === 'user' ? DEFAULT_USER_NAME : DEFAULT_CHAR_NAME),
    content,
    timestamp,
  };
};

const normalizeChatBubble = (value: unknown): ChatBubble | null => {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<ChatBubble>;
  if (source.sender !== 'user' && source.sender !== 'character') return null;
  const content = typeof source.content === 'string' ? compactText(source.content) : '';
  const imageUrls = Array.isArray(source.imageUrls)
    ? source.imageUrls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
    : undefined;
  const timestamp = Number(source.timestamp);
  if (!content && (!imageUrls || imageUrls.length === 0)) return null;
  if (!Number.isFinite(timestamp)) return null;
  const quote = normalizeQuotePayload(source.quote, timestamp);
  const migratedPromptRecord =
    typeof source.promptRecord === 'string'
      ? migratePromptRecordFormat(source.promptRecord)
      : '';
  const fallbackPromptRecord =
    source.sender === 'user'
      ? buildUserPromptRecord(DEFAULT_USER_NAME, content, timestamp, quote)
      : buildCharacterPromptRecord(DEFAULT_CHAR_NAME, content, timestamp);
  return {
    id: typeof source.id === 'string' && source.id.trim() ? source.id : `${timestamp}-${Math.random()}`,
    sender: source.sender,
    content,
    timestamp,
    promptRecord: MODERN_PROMPT_RECORD_RE.test(migratedPromptRecord) ? migratedPromptRecord : fallbackPromptRecord,
    sentToAi: source.sentToAi !== false,
    quote,
    generationId: typeof source.generationId === 'string' ? source.generationId : undefined,
    editedAt: Number.isFinite(Number(source.editedAt)) ? Number(source.editedAt) : undefined,
    imageUrls: imageUrls && imageUrls.length > 0 ? imageUrls : undefined,
  };
};

const normalizeReadingPrefixSummaryByBookId = (value: unknown) => {
  if (!value || typeof value !== 'object') return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [bookId, text]) => {
    if (!bookId || typeof text !== 'string') return acc;
    acc[bookId] = text;
    return acc;
  }, {});
};

const normalizeAiUnderlineRange = (value: unknown): ReaderAiUnderlineRange | null => {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<ReaderAiUnderlineRange>;
  const start = Number(source.start);
  const end = Number(source.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const safeStart = Math.max(0, Math.floor(Math.min(start, end)));
  const safeEnd = Math.max(safeStart, Math.floor(Math.max(start, end)));
  return {
    start: safeStart,
    end: safeEnd,
    generationId:
      typeof source.generationId === 'string' && source.generationId.trim()
        ? source.generationId.trim()
        : undefined,
  };
};

const normalizeAiUnderlinesByChapter = (value: unknown) => {
  if (!value || typeof value !== 'object') return {} as Record<string, ReaderAiUnderlineRange[]>;
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, ReaderAiUnderlineRange[]>>(
    (acc, [chapterKey, ranges]) => {
      if (!chapterKey || !Array.isArray(ranges)) return acc;
      const normalizedRanges = ranges
        .map((item) => normalizeAiUnderlineRange(item))
        .filter((item): item is ReaderAiUnderlineRange => Boolean(item));
      acc[chapterKey] = normalizedRanges;
      return acc;
    },
    {}
  );
};

const normalizeReadingAiUnderlinesByBookId = (value: unknown) => {
  if (!value || typeof value !== 'object') return {} as Record<string, Record<string, ReaderAiUnderlineRange[]>>;
  return Object.entries(value as Record<string, unknown>).reduce<
    Record<string, Record<string, ReaderAiUnderlineRange[]>>
  >((acc, [bookId, chapterMap]) => {
    if (!bookId || !chapterMap || typeof chapterMap !== 'object') return acc;
    acc[bookId] = normalizeAiUnderlinesByChapter(chapterMap);
    return acc;
  }, {});
};

const normalizeChatBucket = (value: unknown): ReaderChatBucket => {
  if (!value || typeof value !== 'object') return defaultChatBucket();
  const source = value as Partial<ReaderChatBucket>;
  const messages = Array.isArray(source.messages)
    ? source.messages.map((item) => normalizeChatBubble(item)).filter((item): item is ChatBubble => Boolean(item))
    : [];
  return {
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : Date.now(),
    messages,
    personaName: typeof source.personaName === 'string' ? source.personaName.trim() : '',
    characterName: typeof source.characterName === 'string' ? source.characterName.trim() : '',
    chatHistorySummary: typeof source.chatHistorySummary === 'string' ? source.chatHistorySummary : '',
    readingPrefixSummaryByBookId: normalizeReadingPrefixSummaryByBookId(source.readingPrefixSummaryByBookId),
    readingAiUnderlinesByBookId: normalizeReadingAiUnderlinesByBookId(source.readingAiUnderlinesByBookId),
    chatSummaryCards: normalizeSummaryCards(source.chatSummaryCards),
    chatAutoSummaryLastEnd: Number.isFinite(Number(source.chatAutoSummaryLastEnd))
      ? Math.max(0, Math.floor(Number(source.chatAutoSummaryLastEnd)))
      : 0,
  };
};

const normalizeChatStore = (value: unknown): ReaderChatStore => {
  if (!value || typeof value !== 'object') return {};
  const normalized: ReaderChatStore = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, bucket]) => {
    if (!key || !bucket || typeof bucket !== 'object') return;
    normalized[key] = normalizeChatBucket(bucket);
  });
  return normalized;
};

const cloneChatStore = (store: ReaderChatStore): ReaderChatStore => {
  const cloned: ReaderChatStore = {};
  Object.entries(store || {}).forEach(([key, bucket]) => {
    if (!key || !bucket || typeof bucket !== 'object') return;
    cloned[key] = normalizeChatBucket(bucket);
  });
  return cloned;
};

const readLegacyChatStoreFromLocalStorage = (): ReaderChatStore => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(CHAT_HISTORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const normalized = normalizeChatStore(parsed);
    const deduped = dedupeConversationStore(normalized);
    return deduped.store;
  } catch {
    return {};
  }
};

const queuePersistChatStore = (store: ReaderChatStore) => {
  const snapshot = cloneChatStore(store);
  chatStorePersistQueue = chatStorePersistQueue
    .catch(() => undefined)
    .then(() => saveStoredChatHistoryStore(snapshot as Record<string, unknown>))
    .catch((error) => {
      console.error('Failed to persist chat store into IndexedDB', error);
    });
};

export const exportChatHistoryFromCache = async (): Promise<Record<string, unknown>> => {
  if (chatStoreHydrationPromise) {
    await chatStoreHydrationPromise;
  }
  const current = cloneChatStore(chatStoreCache);
  chatStorePersistQueue = chatStorePersistQueue
    .catch(() => undefined)
    .then(() => saveStoredChatHistoryStore(current as Record<string, unknown>))
    .catch(() => {});
  await chatStorePersistQueue;
  return current as Record<string, unknown>;
};

export const hydrateReaderChatStore = async () => {
  if (chatStoreHydrated) return;
  if (chatStoreHydrationPromise) {
    await chatStoreHydrationPromise;
    return;
  }

  chatStoreHydrationPromise = (async () => {
    let loaded = {} as ReaderChatStore;
    let hasLegacyMigration = false;
    try {
      const stored = await getStoredChatHistoryStore();
      loaded = normalizeChatStore(stored);
    } catch (error) {
      console.error('Failed to read chat store from IndexedDB', error);
    }

    const legacy = readLegacyChatStoreFromLocalStorage();
    if (Object.keys(loaded).length === 0 && Object.keys(legacy).length > 0) {
      loaded = legacy;
      hasLegacyMigration = true;
    }

    if (pendingStoreBeforeHydration) {
      loaded = {
        ...loaded,
        ...pendingStoreBeforeHydration,
      };
    }

    const deduped = dedupeConversationStore(loaded);
    chatStoreCache = deduped.store;
    chatStoreHydrated = true;
    const shouldPersist = deduped.changed || hasLegacyMigration || Boolean(pendingStoreBeforeHydration);
    pendingStoreBeforeHydration = null;

    if (hasLegacyMigration && typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(CHAT_HISTORY_STORAGE_KEY);
      } catch {
        // ignore
      }
    }

    if (shouldPersist) {
      await saveStoredChatHistoryStore(chatStoreCache as Record<string, unknown>).catch((error) => {
        console.error('Failed to save hydrated chat store', error);
      });
    }
  })()
    .catch((error) => {
      console.error('Failed to hydrate chat store', error);
      chatStoreCache = cloneChatStore(readLegacyChatStoreFromLocalStorage());
      chatStoreHydrated = true;
      pendingStoreBeforeHydration = null;
    })
    .finally(() => {
      chatStoreHydrationPromise = null;
    });

  await chatStoreHydrationPromise;
};

const emitChatStoreUpdated = (detail: ChatStoreUpdatedEventDetail) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ChatStoreUpdatedEventDetail>(CHAT_STORE_UPDATED_EVENT, { detail }));
};

const emitGenerationStatus = (detail: GenerationStatusEventDetail) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<GenerationStatusEventDetail>(GENERATION_STATUS_EVENT, { detail }));
};

export const readChatStore = (): ReaderChatStore => {
  if (!chatStoreHydrated) {
    if (pendingStoreBeforeHydration) {
      return cloneChatStore(pendingStoreBeforeHydration);
    }
    const legacyStore = readLegacyChatStoreFromLocalStorage();
    if (Object.keys(legacyStore).length > 0) return cloneChatStore(legacyStore);
  }
  return cloneChatStore(chatStoreCache);
};

export const saveChatStore = (store: ReaderChatStore, preferredConversationKey?: string) => {
  const deduped = dedupeConversationStore(normalizeChatStore(store), preferredConversationKey);
  const nextStore = cloneChatStore(deduped.store);
  chatStoreCache = nextStore;
  if (!chatStoreHydrated) {
    pendingStoreBeforeHydration = nextStore;
    return;
  }
  queuePersistChatStore(nextStore);
};

export const readConversationBucket = (conversationKey: string): ReaderChatBucket => {
  if (!conversationKey) return defaultChatBucket();
  const store = readChatStore();
  return store[conversationKey] || defaultChatBucket();
};

export const ensureConversationBucket = (conversationKey: string, legacyConversationKey?: string) => {
  const store = readChatStore();
  const legacyBucket =
    legacyConversationKey && legacyConversationKey !== conversationKey ? store[legacyConversationKey] : undefined;
  const nextBucket = store[conversationKey] || legacyBucket || defaultChatBucket();
  let changed = false;

  if (!store[conversationKey]) {
    store[conversationKey] = nextBucket;
    changed = true;
  }
  if (legacyConversationKey && legacyConversationKey !== conversationKey && legacyBucket) {
    delete store[legacyConversationKey];
    changed = true;
  }

  if (changed) {
    const deduped = dedupeConversationStore(store, conversationKey);
    const resolvedBucket = deduped.store[conversationKey] || nextBucket;
    saveChatStore(deduped.store, conversationKey);
    emitChatStoreUpdated({
      conversationKey,
      bucket: resolvedBucket,
      reason: legacyBucket ? 'migrate-legacy-key' : 'init-bucket',
    });
    return resolvedBucket;
  }

  return nextBucket;
};

type ConversationBucketUpdater =
  | Partial<ReaderChatBucket>
  | ((existing: ReaderChatBucket) => ReaderChatBucket);

export const persistConversationBucket = (
  conversationKey: string,
  updater: ConversationBucketUpdater,
  reason?: string
) => {
  if (!conversationKey) return defaultChatBucket();
  const store = readChatStore();
  const existing = store[conversationKey] || defaultChatBucket();
  const candidate =
    typeof updater === 'function'
      ? updater(existing)
      : {
          ...existing,
          ...updater,
        };
  const nextBucket = normalizeChatBucket({
    ...candidate,
    updatedAt: Date.now(),
  });
  store[conversationKey] = nextBucket;
  const deduped = dedupeConversationStore(store, conversationKey);
  const finalBucket = deduped.store[conversationKey] || nextBucket;
  saveChatStore(deduped.store, conversationKey);
  emitChatStoreUpdated({
    conversationKey,
    bucket: finalBucket,
    reason,
  });
  return finalBucket;
};

export const persistConversationMessages = (conversationKey: string, messages: ChatBubble[], reason?: string) =>
  persistConversationBucket(
    conversationKey,
    (existing) => ({
      ...existing,
      messages,
    }),
    reason
  );

export const getConversationGenerationStatus = (conversationKey: string) => {
  const current = generationRegistry.get(conversationKey);
  if (!current) {
    return {
      isLoading: false,
      mode: null as GenerationMode | null,
      requestId: null as string | null,
    };
  }
  return {
    isLoading: true,
    mode: current.mode,
    requestId: current.requestId,
  };
};

export const beginConversationGeneration = (conversationKey: string, mode: GenerationMode) => {
  if (!conversationKey) {
    return {
      status: 'blocked' as const,
      blockedByMode: null as GenerationMode | null,
      reason: 'missing-conversation-key',
    };
  }

  const existing = generationRegistry.get(conversationKey);
  if (existing) {
    if (mode === 'manual' && existing.mode === 'proactive') {
      existing.controller.abort('manual-priority');
      generationRegistry.delete(conversationKey);
      emitGenerationStatus({
        conversationKey,
        isLoading: false,
        mode: null,
        requestId: null,
        previousMode: 'proactive',
        reason: 'aborted-by-manual',
      });
    } else if (existing.mode === mode) {
      return {
        status: 'duplicate' as const,
        blockedByMode: existing.mode,
      };
    } else {
      return {
        status: 'blocked' as const,
        blockedByMode: existing.mode,
      };
    }
  }

  const requestId = `${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const controller = new AbortController();
  generationRegistry.set(conversationKey, {
    mode,
    requestId,
    controller,
  });
  emitGenerationStatus({
    conversationKey,
    isLoading: true,
    mode,
    requestId,
  });
  return {
    status: 'started' as const,
    requestId,
    controller,
  };
};

export const finishConversationGeneration = (
  conversationKey: string,
  requestId: string,
  reason?: string
) => {
  const existing = generationRegistry.get(conversationKey);
  if (!existing) return;
  if (existing.requestId !== requestId) return;
  generationRegistry.delete(conversationKey);
  emitGenerationStatus({
    conversationKey,
    isLoading: false,
    mode: null,
    requestId: null,
    previousMode: existing.mode,
    reason,
  });
};

export const abortConversationGeneration = (
  conversationKey: string,
  reason = 'aborted'
) => {
  const existing = generationRegistry.get(conversationKey);
  if (!existing) return;
  existing.controller.abort(reason);
  generationRegistry.delete(conversationKey);
  emitGenerationStatus({
    conversationKey,
    isLoading: false,
    mode: null,
    requestId: null,
    previousMode: existing.mode,
    reason,
  });
};

export const deleteConversationBucket = (conversationKey: string, reason = 'delete-bucket') => {
  if (!conversationKey) return false;
  const store = readChatStore();
  if (!store[conversationKey]) return false;
  delete store[conversationKey];
  saveChatStore(store);
  abortConversationGeneration(conversationKey, reason);
  emitChatStoreUpdated({
    conversationKey,
    bucket: defaultChatBucket(),
    reason,
  });
  return true;
};

export const onChatStoreUpdated = (listener: (detail: ChatStoreUpdatedEventDetail) => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<ChatStoreUpdatedEventDetail>;
    if (!customEvent.detail) return;
    listener(customEvent.detail);
  };
  window.addEventListener(CHAT_STORE_UPDATED_EVENT, handler);
  return () => window.removeEventListener(CHAT_STORE_UPDATED_EVENT, handler);
};

export const onGenerationStatusChanged = (listener: (detail: GenerationStatusEventDetail) => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<GenerationStatusEventDetail>;
    if (!customEvent.detail) return;
    listener(customEvent.detail);
  };
  window.addEventListener(GENERATION_STATUS_EVENT, handler);
  return () => window.removeEventListener(GENERATION_STATUS_EVENT, handler);
};

// ===== 跨书籍全局记忆 =====

const CROSS_BOOK_MEMORY_KEY = 'cross_book_memories_v2';

export interface CrossBookMemoryItem {
  id: string;
  characterName: string;
  summary: string;
  updatedAt: number;
  sourceBookId?: string;   // 可选：来源书籍ID，用于自动同步和删书处理
  sourceCardId?: string;   // 可选：来源总结卡片ID，用于精确匹配更新
}

let crossBookMemoryCache: CrossBookMemoryItem[] | null = null;

const readAllMemories = (): CrossBookMemoryItem[] => {
  if (crossBookMemoryCache) return crossBookMemoryCache;
  try {
    const raw = localStorage.getItem(CROSS_BOOK_MEMORY_KEY);
    if (!raw) { crossBookMemoryCache = []; return []; }
    crossBookMemoryCache = JSON.parse(raw) as CrossBookMemoryItem[];
    return crossBookMemoryCache;
  } catch {
    crossBookMemoryCache = [];
    return [];
  }
};

const writeAllMemories = (items: CrossBookMemoryItem[]) => {
  crossBookMemoryCache = items;
  try {
    localStorage.setItem(CROSS_BOOK_MEMORY_KEY, JSON.stringify(items));
  } catch { /* 静默处理 */ }
};

// 迁移旧版数据到新版（v1 → v2）
const migrateCrossBookMemoryIfNeeded = () => {
  try {
    if (localStorage.getItem(CROSS_BOOK_MEMORY_KEY)) return; // 已有v2数据
    const oldRaw = localStorage.getItem('cross_book_memories_v1');
    if (!oldRaw) return;
    const oldItems = JSON.parse(oldRaw) as Array<{characterName: string; summary: string; updatedAt: number}>;
    const migrated: CrossBookMemoryItem[] = oldItems.map(item => ({
      id: `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      characterName: item.characterName,
      summary: item.summary,
      updatedAt: item.updatedAt || Date.now(),
    }));
    writeAllMemories(migrated);
    localStorage.removeItem('cross_book_memories_v1');
  } catch {}
};
migrateCrossBookMemoryIfNeeded();

// 获取某个角色的所有跨书记忆
export const getCrossBookMemories = (characterName: string): CrossBookMemoryItem[] => {
  return readAllMemories()
    .filter(m => m.characterName === characterName)
    .sort((a, b) => b.updatedAt - a.updatedAt);
};

// 获取所有跨书记忆（管理面板用）
export const getAllCrossBookMemories = (): CrossBookMemoryItem[] => {
  return readAllMemories().sort((a, b) => b.updatedAt - a.updatedAt);
};

// 按sourceCardId精确匹配更新，不匹配则新增
export const saveCrossBookMemory = (
  characterName: string,
  summary: string,
  sourceBookId?: string,
  sourceCardId?: string,
) => {
  try {
    const all = readAllMemories();
    // 按sourceCardId精确匹配（引用更新模式）
    if (sourceCardId) {
      const idx = all.findIndex(m => m.sourceCardId === sourceCardId);
      if (idx >= 0) {
        all[idx] = { ...all[idx], summary, updatedAt: Date.now(), sourceBookId };
        writeAllMemories(all);
        return;
      }
    }
    // 新增
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    all.push({ id, characterName, summary, updatedAt: Date.now(), sourceBookId, sourceCardId });
    // 每个角色最多保留100条记忆
    const forChar = all.filter(m => m.characterName === characterName).slice(-100);
    const others = all.filter(m => m.characterName !== characterName);
    writeAllMemories([...others, ...forChar]);
  } catch { /* 静默处理 */ }
};

// 编辑记忆文本
export const editCrossBookMemory = (id: string, newSummary: string) => {
  const all = readAllMemories();
  const idx = all.findIndex(m => m.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx], summary: newSummary, updatedAt: Date.now() };
  writeAllMemories(all);
};

// 删除单条记忆
export const deleteCrossBookMemory = (id: string) => {
  writeAllMemories(readAllMemories().filter(m => m.id !== id));
};

// 删除指定书籍的所有记忆（彻底删除）
export const deleteMemoriesByBook = (bookId: string) => {
  writeAllMemories(readAllMemories().filter(m => m.sourceBookId !== bookId));
};

// 书被删除时：取消引用但保留文本快照（防止AI失忆）
export const detachMemoriesFromBook = (bookId: string) => {
  const all = readAllMemories();
  all.forEach(m => {
    if (m.sourceBookId === bookId) {
      m.sourceBookId = undefined;
      m.sourceCardId = undefined;
    }
  });
  writeAllMemories(all);
};

// ===== 书本级浓缩记忆档案 =====

const BOOK_PROFILES_KEY = 'book_memory_profiles_v1';

export interface BookMemoryProfile {
  bookId: string;
  bookTitle: string;
  characterName: string;
  points: string[];  // 3-5 个关键记忆点
  updatedAt: number;
}

const readBookProfiles = (): BookMemoryProfile[] => {
  try {
    const raw = localStorage.getItem(BOOK_PROFILES_KEY);
    return raw ? JSON.parse(raw) as BookMemoryProfile[] : [];
  } catch { return []; }
};

const writeBookProfiles = (profiles: BookMemoryProfile[]) => {
  try { localStorage.setItem(BOOK_PROFILES_KEY, JSON.stringify(profiles)); } catch {}
};

// 保存或更新一本书的浓缩记忆档案
export const upsertBookProfile = (
  bookId: string,
  bookTitle: string,
  characterName: string,
  points: string[],
) => {
  const profiles = readBookProfiles();
  const idx = profiles.findIndex(p => p.bookId === bookId && p.characterName === characterName);
  const profile: BookMemoryProfile = { bookId, bookTitle, characterName, points, updatedAt: Date.now() };
  if (idx >= 0) {
    profiles[idx] = profile;
  } else {
    profiles.push(profile);
    // 最多保留50本书的记忆
    if (profiles.length > 50) profiles.shift();
  }
  writeBookProfiles(profiles);
};

// 在chatSummaryCards更新后自动更新书本档案
export const autoUpdateBookProfileFromCards = (
  bookId: string,
  bookTitle: string,
  characterName: string,
  cards: ReaderSummaryCard[],
) => {
  if (cards.length === 0) return;
  // 取最近5张卡片的内容作为记忆点
  const points = cards.slice(-5).map(c => c.content).filter(Boolean);
  if (points.length === 0) return;
  upsertBookProfile(bookId, bookTitle, characterName, points);
};

// 获取某个角色读过所有书的浓缩档案
export const getBookProfilesForCharacter = (characterName: string): BookMemoryProfile[] => {
  return readBookProfiles()
    .filter(p => p.characterName === characterName)
    .sort((a, b) => b.updatedAt - a.updatedAt);
};

// 删书时将书本档案浓缩为1条综合记忆点，返回浓缩文本用于提示
// 优先使用 BookMemoryProfile，若不存在则回退到跨书记忆
export const condenseBookProfileOnDelete = (bookId: string, bookTitle?: string): string | null => {
  const title = bookTitle || '未知书籍';

  // 第一优先：使用 BookMemoryProfile 浓缩
  const profiles = readBookProfiles();
  const profile = profiles.find(p => p.bookId === bookId);
  if (profile) {
    const condensed = profile.points.length >= 1
      ? `《${profile.bookTitle}》的记忆：${profile.points.join('；')}`
      : `读过《${profile.bookTitle}》`;
    profile.points = [condensed];
    profile.updatedAt = Date.now();
    writeBookProfiles(profiles);
    return condensed;
  }

  // 回退：从跨书记忆中浓缩
  const allMemories = readAllMemories();
  const bookMemories = allMemories.filter(m => m.sourceBookId === bookId);
  if (bookMemories.length > 0) {
    const characterName = bookMemories[0].characterName;
    const summaries = bookMemories
      .slice(-20) // 最多取最近20条
      .map(m => m.summary)
      .filter(Boolean);
    if (summaries.length === 0) return null;

    const condensed = `《${title}》的记忆：${summaries.join('；')}`;

    // 移除原有跨书记忆，替换为1条浓缩版
    const remaining = allMemories.filter(m => m.sourceBookId !== bookId);
    remaining.push({
      id: `condensed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      characterName,
      summary: condensed,
      updatedAt: Date.now(),
    });
    writeAllMemories(remaining);

    // 同时创建 BookMemoryProfile 以便后续查漏补缺
    upsertBookProfile(bookId, title, characterName, [condensed]);

    return condensed;
  }

  return null;
};;

// 生成用于注入AI提示词的记忆文本
// 最近5本：完整档案（所有记忆点），更早的书：仅1条记忆点
export const buildCrossBookMemoryText = (characterName: string, currentBookId?: string | null): string => {
  const profiles = getBookProfilesForCharacter(characterName);
  const otherProfiles = profiles.filter(p => p.bookId !== (currentBookId || ''));
  if (otherProfiles.length === 0) return '';

  const recent = otherProfiles.slice(0, 5);
  const older = otherProfiles.slice(5);

  let text = '\n\n——你与用户之前共读过的书——\n';

  // 最近5本：完整档案
  recent.forEach(p => {
    text += `\n《${p.bookTitle}》的记忆：\n`;
    p.points.forEach((pt, i) => {
      text += `  ${i + 1}. ${pt}\n`;
    });
  });

  // 更早的书：仅1条记忆
  if (older.length > 0) {
    text += '\n——更早之前读过的书（简要）——\n';
    older.forEach(p => {
      const oneLiner = p.points[0] || '';
      text += `• 《${p.bookTitle}》${oneLiner ? '：' + oneLiner : ''}\n`;
    });
  }

  text += '\n——请在聊天中不突兀地引用这些记忆，但不要变成复读机——';
  return text;
};

// 页面加载时，按sourceCardId匹配同步，避免重复
(async function syncExistingSummariesToCrossBookMemory() {
  try {
    const stored = await getStoredChatHistoryStore();
    if (!stored || Object.keys(stored).length === 0) {
      // 回退：从localStorage读取旧版数据
      const raw = localStorage.getItem(CHAT_HISTORY_STORAGE_KEY);
      if (!raw) return;
      const legacyStore: ReaderChatStore = JSON.parse(raw);
      Object.entries(legacyStore).forEach(([convKey, bucket]) => {
        if (!bucket || !Array.isArray(bucket.chatSummaryCards)) return;
        const bookId = extractBookIdFromConversationKey(convKey);
        bucket.chatSummaryCards.forEach((card: ReaderSummaryCard) => {
          if (card && card.content && bucket.characterName) {
            saveCrossBookMemory(bucket.characterName, card.content, bookId || undefined, card.id);
          }
        });
      });
      return;
    }
    const store: ReaderChatStore = normalizeChatStore(stored);
    Object.entries(store).forEach(([convKey, bucket]) => {
      if (!bucket || !Array.isArray(bucket.chatSummaryCards)) return;
      const bookId = extractBookIdFromConversationKey(convKey);
      bucket.chatSummaryCards.forEach((card: ReaderSummaryCard) => {
        if (card && card.content && bucket.characterName) {
          saveCrossBookMemory(bucket.characterName, card.content, bookId || undefined, card.id);
        }
      });
    });
  } catch {}
})();

// 从conversationKey中提取bookId
const extractBookIdFromConversationKey = (key: string): string | null => {
  const match = key.match(/^book:(.+?)::persona:/);
  return match && match[1] !== 'none' ? match[1] : null;
};
