import type { Chapter, ReaderHighlightRange, ReaderPositionState } from '../types';
import { splitReaderParagraphs, dropLeadingDuplicateTitleParagraph, normalizeReaderLayoutText } from './readerTextNormalize';

export const PRESET_HIGHLIGHT_COLORS = ['#FFE066', '#FFD6A5', '#FFADAD', '#C7F9CC', '#A0C4FF', '#D7B5FF'];

export interface ResolvedHighlightItem {
  id: string;
  range: ReaderHighlightRange;
  chapterKey: string;
  chapterIndex: number | null;
  chapterTitle: string;
  text: string;
}

/**
 * Reconstruct the rendered text for a chapter, matching the Reader's pipeline:
 * splitReaderParagraphs → dropLeadingDuplicateTitleParagraph → join('\n')
 */
const buildChapterRenderedText = (chapterContent: string, chapterTitle: string): string => {
  const paragraphs = splitReaderParagraphs(chapterContent);
  const filtered = dropLeadingDuplicateTitleParagraph(paragraphs, chapterTitle);
  return filtered.join('\n');
};

const extractHighlightText = (renderedText: string, range: ReaderHighlightRange): string => {
  const safeStart = Math.max(0, Math.min(range.start, renderedText.length));
  const safeEnd = Math.max(safeStart, Math.min(range.end, renderedText.length));
  return renderedText.slice(safeStart, safeEnd);
};

export const resolveHighlightItems = (
  highlightsByChapter: Record<string, ReaderHighlightRange[]>,
  chapters: Chapter[],
  fullText?: string,
): ResolvedHighlightItem[] => {
  const items: ResolvedHighlightItem[] = [];

  for (const [chapterKey, ranges] of Object.entries(highlightsByChapter)) {
    if (!ranges || ranges.length === 0) continue;

    let chapterIndex: number | null = null;
    let chapterTitle = '全文';
    let renderedText = '';

    if (chapterKey === 'full') {
      renderedText = fullText ? normalizeReaderLayoutText(fullText) : '';
    } else {
      const match = chapterKey.match(/^chapter-(\d+)$/);
      if (match) {
        chapterIndex = parseInt(match[1], 10);
        const chapter = chapters[chapterIndex];
        if (chapter) {
          chapterTitle = chapter.title?.trim() || `第${chapterIndex + 1}章`;
          renderedText = buildChapterRenderedText(chapter.content || '', chapterTitle);
        }
      }
    }

    ranges.forEach((range, rangeIndex) => {
      const text = extractHighlightText(renderedText, range);
      if (!text.trim()) return;
      items.push({
        id: `${chapterKey}-${rangeIndex}`,
        range,
        chapterKey,
        chapterIndex,
        chapterTitle,
        text,
      });
    });
  }

  return items;
};

export const buildPositionFromHighlight = (
  chapterKey: string,
  charOffset: number,
  chapters: Chapter[],
  fullTextLength: number,
): ReaderPositionState => {
  if (chapterKey === 'full') {
    return {
      chapterIndex: null,
      chapterCharOffset: charOffset,
      globalCharOffset: charOffset,
      scrollRatio: fullTextLength > 0 ? charOffset / fullTextLength : 0,
      totalLength: fullTextLength,
      updatedAt: Date.now(),
    };
  }

  const match = chapterKey.match(/^chapter-(\d+)$/);
  const chapterIndex = match ? parseInt(match[1], 10) : 0;
  const chapter = chapters[chapterIndex];
  const chapterLength = chapter?.content?.length || 0;

  let globalOffset = 0;
  for (let i = 0; i < chapterIndex && i < chapters.length; i++) {
    globalOffset += chapters[i].content?.length || 0;
  }
  globalOffset += charOffset;

  const totalLength = chapters.reduce((sum, ch) => sum + (ch.content?.length || 0), 0);

  return {
    chapterIndex,
    chapterCharOffset: charOffset,
    globalCharOffset: globalOffset,
    scrollRatio: chapterLength > 0 ? charOffset / chapterLength : 0,
    totalLength,
    updatedAt: Date.now(),
  };
};
