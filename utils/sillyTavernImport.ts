/**
 * SillyTavern 角色卡导入工具
 * 支持：角色卡 JSON (V1/V2)、独立世界书 JSON、角色卡 PNG（tEXt chunk 内嵌 base64）
 */

export interface ParsedSTEntry {
  title: string;
  content: string;
  insertPosition: 'BEFORE' | 'AFTER';
  sortOrder: number;
}

export interface SillyTavernImportResult {
  /** 角色名，可能为空（需用户补填） */
  name: string;
  /** 人设描述，可能为空 */
  description: string;
  /** 世界书条目列表（已按 sortOrder 升序排序） */
  entries: ParsedSTEntry[];
}

// ──────────────────────────────────────────────
// 内部辅助
// ──────────────────────────────────────────────

function mapPosition(position: unknown): 'BEFORE' | 'AFTER' {
  // 字符串格式（角色卡 V2 character_book）
  if (typeof position === 'string') {
    return position === 'before_char' ? 'BEFORE' : 'AFTER';
  }
  // 数字格式（独立世界书 JSON）
  // 0 = before char，1-4 = after char
  if (typeof position === 'number') {
    return position === 0 ? 'BEFORE' : 'AFTER';
  }
  return 'AFTER';
}

/** 解析角色卡 V2 character_book.entries 数组 */
function parseCharacterBookEntries(entries: unknown[]): ParsedSTEntry[] {
  const result: ParsedSTEntry[] = [];
  entries.forEach((entry: unknown, idx) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    const title = typeof e.comment === 'string' ? e.comment : `条目 ${idx + 1}`;
    const content = typeof e.content === 'string' ? e.content : '';
    const insertPosition = mapPosition(e.position);
    const sortOrder = typeof e.insertion_order === 'number' ? e.insertion_order : idx;
    result.push({ title, content, insertPosition, sortOrder });
  });
  result.sort((a, b) => a.sortOrder - b.sortOrder);
  return result;
}

/** 解析独立世界书 JSON 的 entries 对象（numeric string keys） */
function parseWorldInfoEntries(entriesObj: Record<string, unknown>): ParsedSTEntry[] {
  const result: ParsedSTEntry[] = [];
  Object.values(entriesObj).forEach((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    const title = typeof e.comment === 'string' ? e.comment : '未命名条目';
    const content = typeof e.content === 'string' ? e.content : '';
    const insertPosition = mapPosition(e.position);
    // 独立世界书优先用 displayIndex，其次用 order
    const sortOrder =
      typeof e.displayIndex === 'number'
        ? e.displayIndex
        : typeof e.order === 'number'
        ? e.order
        : 0;
    result.push({ title, content, insertPosition, sortOrder });
  });
  result.sort((a, b) => a.sortOrder - b.sortOrder);
  return result;
}

// ──────────────────────────────────────────────
// 公开 API
// ──────────────────────────────────────────────

/**
 * 解析 SillyTavern 导出的 JSON 字符串。
 * 自动判断是角色卡 JSON（V1/V2）还是独立世界书 JSON。
 */
export function parseSillyTavernJson(jsonStr: string): SillyTavernImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('无效的 JSON 文件');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON 格式不正确');
  }

  const obj = parsed as Record<string, unknown>;

  // ── 独立世界书格式：顶层只有 entries 对象（key 为数字字符串）──
  if (
    obj.entries &&
    typeof obj.entries === 'object' &&
    !Array.isArray(obj.entries) &&
    !('name' in obj)
  ) {
    return {
      name: '',
      description: '',
      entries: parseWorldInfoEntries(obj.entries as Record<string, unknown>),
    };
  }

  // ── 角色卡 V2：优先读 data 字段 ──
  let charName = '';
  let charDesc = '';
  let entries: ParsedSTEntry[] = [];

  const data = obj.data as Record<string, unknown> | undefined;
  if (data && typeof data === 'object') {
    charName = typeof data.name === 'string' ? data.name : '';
    charDesc = typeof data.description === 'string' ? data.description : '';

    const charBook = data.character_book as Record<string, unknown> | undefined;
    if (charBook && Array.isArray(charBook.entries)) {
      entries = parseCharacterBookEntries(charBook.entries);
    }
  }

  // ── 角色卡 V1 兜底：直接读顶层字段 ──
  if (!charName && typeof obj.name === 'string') charName = obj.name;
  if (!charDesc && typeof obj.description === 'string') charDesc = obj.description;

  return { name: charName, description: charDesc, entries };
}

/**
 * 解析 SillyTavern 角色卡 PNG。
 * 扫描 PNG tEXt chunk，找到 keyword="chara" 后 base64 解码，再调用 parseSillyTavernJson。
 */
export function parseSillyTavernPng(buffer: ArrayBuffer): SillyTavernImportResult {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // 验证 PNG 签名
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) throw new Error('不是有效的 PNG 文件');
  }

  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false); // big-endian
    const type =
      String.fromCharCode(bytes[offset + 4]) +
      String.fromCharCode(bytes[offset + 5]) +
      String.fromCharCode(bytes[offset + 6]) +
      String.fromCharCode(bytes[offset + 7]);

    if (type === 'tEXt') {
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      const data = bytes.subarray(dataStart, dataEnd);

      // 找 null 分隔符
      let nullPos = -1;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0) { nullPos = i; break; }
      }
      if (nullPos !== -1) {
        // 用 latin1 解码 keyword
        let keyword = '';
        for (let i = 0; i < nullPos; i++) keyword += String.fromCharCode(data[i]);

        if (keyword === 'chara') {
          // text 部分（latin1 字节）即 base64 字符串
          let b64 = '';
          for (let i = nullPos + 1; i < data.length; i++) b64 += String.fromCharCode(data[i]);
          let jsonStr: string;
          try {
            const binaryStr = atob(b64);
            // base64 解码出的是 UTF-8 字节序列，需用 TextDecoder 正确转为 JS 字符串
            const utf8Bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) utf8Bytes[i] = binaryStr.charCodeAt(i);
            jsonStr = new TextDecoder('utf-8').decode(utf8Bytes);
          } catch {
            throw new Error('PNG 内嵌角色数据 base64 解码失败');
          }
          return parseSillyTavernJson(jsonStr);
        }
      }
    }

    // IEND 块标志结束
    if (type === 'IEND') break;

    offset += 12 + length;
  }

  throw new Error('PNG 文件中未找到角色卡数据（缺少 chara tEXt 块）');
}
