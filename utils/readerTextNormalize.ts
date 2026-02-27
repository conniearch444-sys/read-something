// ═══════════════════════════════════════════════════════════════
//  Text normalization pipeline extracted from Reader.tsx
//  Used by Reader for rendering and by highlightUtils for
//  reconstructing rendered text from stored chapter content.
// ═══════════════════════════════════════════════════════════════

const LATIN_APOSTROPHE_NORMALIZE_REGEX = /([A-Za-z0-9])[\u2018\u2019\u02BC]([A-Za-z0-9])/g;
const LATIN_OPEN_QUOTE_NORMALIZE_REGEX = /(^|[\s([{<])[\u201C\u201D]([A-Za-z0-9])/g;
const LATIN_CLOSE_QUOTE_NORMALIZE_REGEX = /([A-Za-z0-9])[\u201C\u201D](?=($|[\s)\]}>.,!?;:]))/g;
const LATIN_CLOSE_QUOTE_AFTER_PUNCT_REGEX = /([A-Za-z0-9][A-Za-z0-9'"-]*[.,!?;:])[\u201C\u201D](?=($|[\s)\]}>]))/g;
const LATIN_FULLWIDTH_SPACE_NORMALIZE_REGEX = /([A-Za-z0-9])[\u3000\u00A0]+([A-Za-z0-9])/g;

export const normalizeLatinTypographyArtifacts = (raw: string) =>
  raw
    .replace(/\uFF02/g, '"')
    .replace(/\uFF07/g, "'")
    .replace(LATIN_APOSTROPHE_NORMALIZE_REGEX, "$1'$2")
    .replace(LATIN_OPEN_QUOTE_NORMALIZE_REGEX, '$1"$2')
    .replace(LATIN_CLOSE_QUOTE_NORMALIZE_REGEX, '$1"')
    .replace(LATIN_CLOSE_QUOTE_AFTER_PUNCT_REGEX, '$1"')
    .replace(LATIN_FULLWIDTH_SPACE_NORMALIZE_REGEX, '$1 $2');

export const splitReaderParagraphs = (raw: string) => {
  const normalizedText = normalizeLatinTypographyArtifacts(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029\u0085]/g, '\n')
    .trim();
  if (!normalizedText) return [] as string[];

  return normalizedText
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
};

// ── Heading comparison helpers ──

const ENGLISH_NUMBER_VALUE_BY_WORD: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const ENGLISH_NUMBER_MULTIPLIER_BY_WORD: Record<string, number> = {
  hundred: 100, thousand: 1000,
};
const ENGLISH_NUMBER_CONNECTOR_WORDS = new Set(['and']);
const ROMAN_NUMERAL_CHAR_REGEX = /^[ivxlcdm]+$/;
const ROMAN_NUMERAL_VALIDATION_REGEX = /^(m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3}))$/;
const ROMAN_NUMERAL_VALUE_BY_CHAR: Record<string, number> = {
  i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000,
};
const CHINESE_DIGIT_VALUE_BY_CHAR: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CHINESE_SMALL_UNIT_BY_CHAR: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const CHINESE_LARGE_UNIT_BY_CHAR: Record<string, number> = { 万: 10000, 亿: 100000000 };
const CHINESE_NUMERAL_SEQUENCE_REGEX = /^[零〇一二两三四五六七八九十百千万亿\d]+$/;
const CHINESE_HEADING_WITH_PREFIX_REGEX = /^第([零〇一二两三四五六七八九十百千万亿\d]+)([章节回卷部篇集幕])?$/;
const CHINESE_HEADING_WITH_SUFFIX_REGEX = /^([零〇一二两三四五六七八九十百千万亿\d]+)([章节回卷部篇集幕])$/;
const HEADING_SENTENCE_PUNCTUATION_REGEX = /[。！？!?]/;
const HEADING_NON_LETTER_SYMBOL_REGEX = /[\(\)\[\]\{\},.;:!?`~"'""''\\\/|<>+=*^%$#@&_-]+/g;

const tokenizeComparableHeading = (raw: string) => {
  const normalized = raw
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, ' ')
    .replace(/\u3000/g, ' ')
    .replace(HEADING_NON_LETTER_SYMBOL_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return [] as string[];
  return normalized.split(' ').filter(Boolean);
};

const convertEnglishNumberTokens = (tokens: string[]) => {
  const next: string[] = [];
  let index = 0;

  const parseNumberTokenSequence = (start: number) => {
    let cursor = start;
    let consumed = 0;
    let current = 0;
    let total = 0;
    let hasNumberPart = false;

    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (ENGLISH_NUMBER_CONNECTOR_WORDS.has(token)) {
        cursor += 1; consumed += 1; continue;
      }
      const numberValue = ENGLISH_NUMBER_VALUE_BY_WORD[token];
      if (typeof numberValue === 'number') {
        current += numberValue; hasNumberPart = true; cursor += 1; consumed += 1; continue;
      }
      const multiplierValue = ENGLISH_NUMBER_MULTIPLIER_BY_WORD[token];
      if (typeof multiplierValue === 'number') {
        const base = current || 1;
        current = base * multiplierValue;
        hasNumberPart = true;
        if (multiplierValue >= 1000) { total += current; current = 0; }
        cursor += 1; consumed += 1; continue;
      }
      break;
    }

    if (!hasNumberPart) return { consumed: 0, value: 0 };
    return { consumed, value: total + current };
  };

  while (index < tokens.length) {
    const parsed = parseNumberTokenSequence(index);
    if (parsed.consumed > 0) {
      next.push(String(parsed.value));
      index += parsed.consumed;
      continue;
    }
    next.push(tokens[index]);
    index += 1;
  }
  return next;
};

const parseChineseNumeralSequence = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (!CHINESE_NUMERAL_SEQUENCE_REGEX.test(trimmed)) return null;

  let total = 0;
  let section = 0;
  let digitBuffer: number | null = null;

  for (const char of trimmed) {
    const digit = CHINESE_DIGIT_VALUE_BY_CHAR[char];
    if (typeof digit === 'number') { digitBuffer = digit; continue; }
    const smallUnit = CHINESE_SMALL_UNIT_BY_CHAR[char];
    if (typeof smallUnit === 'number') {
      const base = digitBuffer ?? 1;
      section += base * smallUnit;
      digitBuffer = null;
      continue;
    }
    const largeUnit = CHINESE_LARGE_UNIT_BY_CHAR[char];
    if (typeof largeUnit === 'number') {
      section += digitBuffer ?? 0;
      if (section === 0) section = 1;
      total += section * largeUnit;
      section = 0;
      digitBuffer = null;
      continue;
    }
    return null;
  }

  section += digitBuffer ?? 0;
  const value = total + section;
  return Number.isFinite(value) ? value : null;
};

const normalizeChineseNumberToken = (token: string) => {
  const prefixed = token.match(CHINESE_HEADING_WITH_PREFIX_REGEX);
  if (prefixed) {
    const parsed = parseChineseNumeralSequence(prefixed[1]);
    if (parsed !== null) return `第${parsed}${prefixed[2] || ''}`;
  }
  const suffixed = token.match(CHINESE_HEADING_WITH_SUFFIX_REGEX);
  if (suffixed) {
    const parsed = parseChineseNumeralSequence(suffixed[1]);
    if (parsed !== null) return `${parsed}${suffixed[2]}`;
  }
  const standalone = parseChineseNumeralSequence(token);
  if (standalone !== null) return String(standalone);
  return token;
};

const convertChineseNumberTokens = (tokens: string[]) => tokens.map(normalizeChineseNumberToken);

const parseRomanNumeralToken = (raw: string): number | null => {
  const token = raw.trim().toLowerCase();
  if (!token || !ROMAN_NUMERAL_CHAR_REGEX.test(token)) return null;
  if (!ROMAN_NUMERAL_VALIDATION_REGEX.test(token)) return null;
  let total = 0;
  for (let index = 0; index < token.length; index += 1) {
    const current = ROMAN_NUMERAL_VALUE_BY_CHAR[token[index]];
    const next = index < token.length - 1 ? ROMAN_NUMERAL_VALUE_BY_CHAR[token[index + 1]] : 0;
    if (next > current) { total -= current; } else { total += current; }
  }
  return total > 0 ? total : null;
};

const convertRomanNumberTokens = (tokens: string[]) =>
  tokens.map((token) => {
    const parsed = parseRomanNumeralToken(token);
    return parsed === null ? token : String(parsed);
  });

const normalizeComparableText = (raw: string) => {
  const tokens = tokenizeComparableHeading(raw);
  if (tokens.length === 0) return '';
  return convertEnglishNumberTokens(convertRomanNumberTokens(convertChineseNumberTokens(tokens))).join(' ');
};

const isEquivalentHeadingText = (left: string, right: string) => {
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight;
};

export const shouldConsiderAsShortHeadingLine = (raw: string) => {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.length > 80) return false;
  if (HEADING_SENTENCE_PUNCTUATION_REGEX.test(trimmed)) return false;
  return true;
};

export const resolveLeadingDuplicateTitleParagraphCount = (paragraphs: string[], chapterTitle: string) => {
  if (paragraphs.length === 0 || !chapterTitle) return 0;
  if (isEquivalentHeadingText(paragraphs[0], chapterTitle)) return 1;
  if (paragraphs.length < 2) return 0;
  if (!shouldConsiderAsShortHeadingLine(paragraphs[0])) return 0;
  if (!shouldConsiderAsShortHeadingLine(paragraphs[1])) return 0;
  const combinedHeading = `${paragraphs[0]} ${paragraphs[1]}`.trim();
  return isEquivalentHeadingText(combinedHeading, chapterTitle) ? 2 : 0;
};

export const dropLeadingDuplicateTitleParagraph = (paragraphs: string[], chapterTitle: string) => {
  const removeCount = resolveLeadingDuplicateTitleParagraphCount(paragraphs, chapterTitle);
  if (removeCount <= 0) return paragraphs;
  return paragraphs.slice(removeCount);
};

export const normalizeReaderLayoutText = (raw: string) => splitReaderParagraphs(raw).join('\n');
