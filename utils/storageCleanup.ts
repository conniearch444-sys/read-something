/**
 * 清理孤立数据 — 已删除但残留的书籍内容、图片、TTS音频、RAG索引
 */
import { getAllBookContents, deleteBookContent } from './bookContentStorage';
import { getAllImageRefsAndSizes, deleteImageByRef, isImageRef } from './imageStorage';
import { clearBookTtsAudio } from './ttsAudioStorage';
import { exportRagIndexForArchive } from './ragEngine'; // has deleteEmbeddingsByBook

export interface CleanupResult {
  orphanedBooks: string[];
  orphanedImages: number;
  orphanedTtsBooks: string[];
  orphanedRagBooks: string[];
  freedBytes: number;
}

function getActiveBookIds(): Set<string> {
  try {
    const raw = localStorage.getItem('app_books');
    if (!raw) return new Set();
    const books = JSON.parse(raw);
    if (!Array.isArray(books)) return new Set();
    return new Set(books.map((b: any) => b.id).filter(Boolean));
  } catch {
    return new Set();
  }
}

function collectAllReferencedImageRefs(): Set<string> {
  const refs = new Set<string>();
  const keysToScan = [
    'app_books', 'app_personas', 'app_characters', 'app_settings',
    'app_worldbook',
  ];

  for (const key of keysToScan) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const data = JSON.parse(raw);
      const jsonStr = JSON.stringify(data);
      // Find all idb://... references
      const matches = jsonStr.match(/idb:\/\/[a-f0-9-]+/gi);
      if (matches) matches.forEach(m => refs.add(m));
    } catch { /* skip */ }
  }

  return refs;
}

export async function runCleanup(): Promise<CleanupResult> {
  const result: CleanupResult = {
    orphanedBooks: [],
    orphanedImages: 0,
    orphanedTtsBooks: [],
    orphanedRagBooks: [],
    freedBytes: 0,
  };

  const activeBookIds = getActiveBookIds();

  // 1. Clean orphaned book contents
  const allContents = await getAllBookContents();
  for (const bookId of Object.keys(allContents)) {
    if (!activeBookIds.has(bookId)) {
      try {
        await deleteBookContent(bookId);
        result.orphanedBooks.push(bookId);
        result.freedBytes += JSON.stringify(allContents[bookId]).length;
      } catch { /* skip if delete fails */ }
    }
  }

  // 2. Clean orphaned images
  const activeImageRefs = collectAllReferencedImageRefs();
  const allImages = await getAllImageRefsAndSizes();
  for (const imageRef of Object.keys(allImages)) {
    if (!activeImageRefs.has(imageRef)) {
      try {
        result.freedBytes += allImages[imageRef] || 0;
        await deleteImageByRef(imageRef);
        result.orphanedImages++;
      } catch { /* skip */ }
    }
  }

  // 3. Clean orphaned TTS audio
  // clearBookTtsAudio needs bookId; we can't enumerate all TTS entries easily
  // Just clean TTS for orphaned books found in step 1
  for (const bookId of result.orphanedBooks) {
    try {
      await clearBookTtsAudio(bookId);
      result.orphanedTtsBooks.push(bookId);
    } catch { /* skip */ }
  }

  // 4. Clean orphaned RAG embeddings
  // Use deleteEmbeddingsByBook (dynamically imported to avoid circular deps)
  try {
    const { deleteEmbeddingsByBook, getBookMeta } = await import('./ragEngine');
    // Check all books with RAG meta
    const ragExport = await exportRagIndexForArchive();
    if (ragExport && ragExport.meta) {
      for (const metaItem of ragExport.meta) {
        const bookId = metaItem.bookId;
        if (!activeBookIds.has(bookId)) {
          try {
            await deleteEmbeddingsByBook(bookId);
            result.orphanedRagBooks.push(bookId);
            result.freedBytes += (metaItem.chunkCount || 0) * 6144; // ~6KB per chunk
          } catch { /* skip */ }
        }
      }
    }
  } catch { /* RAG might not be available */ }

  return result;
}
