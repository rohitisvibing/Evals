// chunk.v1 — page-bounded chunks with stable keys.
//
// Chunks never cross page boundaries, so every chunk carries an exact page
// reference. Keys are `{sha256[0:12]}:p{page}:c{n}` — deterministic for the
// same bytes and chunker version, which keeps benchmark labels stable.

export const CHUNK_TARGET_CHARS = 1200;
export const CHUNK_OVERLAP_CHARS = 150;
const MIN_CHUNK_CHARS = 40;

export type Chunk = {
  chunk_key: string;
  chunk_index: number;
  page_start: number;
  page_end: number;
  content: string;
};

export function chunkPages(sha256: string, pages: string[]): Chunk[] {
  const prefix = sha256.slice(0, 12);
  const out: Chunk[] = [];
  pages.forEach((text, i) => {
    const page = i + 1;
    splitPage(text).forEach((content, n) => {
      out.push({ chunk_key: `${prefix}:p${page}:c${n}`, chunk_index: out.length, page_start: page, page_end: page, content });
    });
  });
  return out;
}

export function splitPage(text: string): string[] {
  const t = text.trim();
  if (t.length < MIN_CHUNK_CHARS) return [];
  if (t.length <= CHUNK_TARGET_CHARS) return [t];

  const pieces: string[] = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(start + CHUNK_TARGET_CHARS, t.length);
    if (end < t.length) {
      // Prefer to break at a paragraph, then line, then sentence, then space.
      const window = t.slice(start + Math.floor(CHUNK_TARGET_CHARS * 0.6), end);
      const offset = start + Math.floor(CHUNK_TARGET_CHARS * 0.6);
      const br =
        lastIndex(window, "\n\n") ?? lastIndex(window, "\n") ?? lastIndex(window, ". ") ?? lastIndex(window, " ");
      if (br !== null) end = offset + br + 1;
    }
    const piece = t.slice(start, end).trim();
    if (piece.length >= MIN_CHUNK_CHARS || pieces.length === 0) pieces.push(piece);
    if (end >= t.length) break;
    start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
    // Start overlap on a word boundary.
    const sp = t.indexOf(" ", start);
    if (sp !== -1 && sp < end) start = sp + 1;
  }
  return pieces;
}

function lastIndex(s: string, needle: string): number | null {
  const i = s.lastIndexOf(needle);
  return i === -1 ? null : i;
}
