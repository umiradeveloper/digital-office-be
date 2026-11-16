/**
 * HTML terbatas untuk isi naskah dinas.
 * - sanitizeHtml: hanya tag & gaya yang aman (mencegah XSS dari editor)
 * - fillPlaceholders: isi {{nomor}}, {{tanggal}}, dst.
 * - parseBlocks: ubah HTML menjadi blok teks untuk dirender ke PDF
 */

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'li', 'blockquote']);
const LIST_TAGS = new Set(['ul', 'ol']);
const INLINE_TAGS = new Set(['strong', 'b', 'em', 'i', 'u', 'span', 'br']);
const ALLOWED = new Set([...BLOCK_TAGS, ...LIST_TAGS, ...INLINE_TAGS]);
const VOID = new Set(['br']);
const ALIGN_RE = /text-align\s*:\s*(left|center|right|justify)/i;

const TOKEN_RE = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)|(<)/g;

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s: string) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+|#39);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY[e] ?? m;
  });
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Sanitasi whitelist: tag lain dibuang (isi teksnya tetap), atribut hanya style text-align. */
export function sanitizeHtml(input: string): string {
  const html = (input ?? '').slice(0, 500_000);
  const out: string[] = [];
  const stack: string[] = [];
  let skipDepth = 0; // di dalam <script>/<style>
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(html))) {
    const [full, rawTag, attrs, text, lone] = m;
    if (full.startsWith('<!--')) continue;
    if (lone) { if (!skipDepth) out.push('&lt;'); continue; }
    if (text !== undefined) {
      if (!skipDepth) out.push(text.replace(/>/g, '&gt;'));
      continue;
    }
    const tag = rawTag.toLowerCase();
    const closing = full.startsWith('</');
    if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object') {
      skipDepth += closing ? -1 : 1;
      if (skipDepth < 0) skipDepth = 0;
      continue;
    }
    if (skipDepth || !ALLOWED.has(tag)) continue;
    const norm = tag === 'b' ? 'strong' : tag === 'i' ? 'em' : tag === 'div' ? 'p' : tag;
    if (closing) {
      const idx = stack.lastIndexOf(norm);
      if (idx === -1) continue;
      while (stack.length > idx) out.push(`</${stack.pop()}>`);
      continue;
    }
    if (VOID.has(norm)) { out.push('<br>'); continue; }
    const align = ALIGN_RE.exec(attrs ?? '')?.[1]?.toLowerCase();
    const styleAttr = align && BLOCK_TAGS.has(tag) ? ` style="text-align:${align}"` : '';
    // span tanpa gaya tidak berguna — dibuang tetapi teks tetap
    if (norm === 'span') continue;
    out.push(`<${norm}${styleAttr}>`);
    stack.push(norm);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join('').replace(/<p><\/p>/g, '<p><br></p>').trim();
}

/** Ganti {{kunci}} dengan nilai (di-escape). Kunci tak dikenal dibiarkan. */
export function fillPlaceholders(html: string, vars: Record<string, string | null | undefined>) {
  return html.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in vars ? escapeHtml(vars[k] ?? '') : m));
}

export function htmlToText(html: string) {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|h[1-3]|li|blockquote)>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
}

// ───────── Blok untuk renderer PDF ─────────

export interface Run { text: string; bold: boolean; italic: boolean; underline: boolean }
export interface Block {
  type: 'p' | 'h1' | 'h2' | 'h3' | 'li' | 'blockquote';
  align: 'left' | 'center' | 'right' | 'justify';
  list?: { ordered: boolean; index: number; depth: number };
  runs: Run[];
}

export function parseBlocks(cleanHtml: string): Block[] {
  const blocks: Block[] = [];
  const fmt = { bold: 0, italic: 0, underline: 0 };
  const lists: { ordered: boolean; count: number }[] = [];
  let cur: Block | null = null;
  const blockStack: Block[] = [];

  const ensure = () => {
    if (!cur) { cur = { type: 'p', align: 'left', runs: [] }; blocks.push(cur); }
    return cur;
  };
  const pushText = (t: string) => {
    if (!t) return;
    const b = ensure();
    b.runs.push({ text: t, bold: fmt.bold > 0, italic: fmt.italic > 0, underline: fmt.underline > 0 });
  };

  let m: RegExpExecArray | null;
  const re = /<\/?([a-z0-9]+)([^>]*)>|([^<]+)/g;
  while ((m = re.exec(cleanHtml))) {
    const [full, tag, attrs, text] = m;
    if (text !== undefined) {
      const t = decodeEntities(text).replace(/\s+/g, (ws) => (ws.includes(' ') ? ws : ' '));
      if (t.trim() || (cur && (cur as Block).runs.length)) pushText(t);
      continue;
    }
    const closing = full.startsWith('</');
    switch (tag) {
      case 'strong': fmt.bold += closing ? -1 : 1; break;
      case 'em': fmt.italic += closing ? -1 : 1; break;
      case 'u': fmt.underline += closing ? -1 : 1; break;
      case 'br': pushText('\n'); break;
      case 'ul': case 'ol':
        if (closing) lists.pop(); else lists.push({ ordered: tag === 'ol', count: 0 });
        cur = null; break;
      default:
        if (!['p', 'h1', 'h2', 'h3', 'li', 'blockquote'].includes(tag)) break;
        if (closing) {
          blockStack.pop();
          cur = null;
        } else {
          const align = (/text-align:(left|center|right|justify)/.exec(attrs)?.[1] ?? 'left') as Block['align'];
          const b: Block = { type: tag as Block['type'], align, runs: [] };
          if (tag === 'li') {
            const l = lists[lists.length - 1] ?? { ordered: false, count: 0 };
            l.count++;
            b.list = { ordered: l.ordered, index: l.count, depth: Math.max(0, lists.length - 1) };
          }
          blocks.push(b); blockStack.push(b); cur = b;
        }
    }
  }
  // rapikan spasi di awal/akhir tiap blok
  for (const b of blocks) {
    if (b.runs.length) {
      b.runs[0].text = b.runs[0].text.replace(/^ +/, '');
      const last = b.runs[b.runs.length - 1];
      last.text = last.text.replace(/[ \n]+$/, '');
    }
  }
  return blocks;
}
