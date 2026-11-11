import { ColKind, ImageInfo } from '../../core/sql/query.models';

/**
 * Pure logic of the value panel (prompt 026): which views a value has and which one is shown first, and
 * the views themselves – JSON and XML laid out, binary data as hex, a number in other bases, a date in
 * other zones. Laying out never changes a value: only blanks between its tokens are written anew.
 */

export type ValueView = 'text' | 'json' | 'xml' | 'hex' | 'image' | 'number' | 'date';

/** What is known of a value before its text is looked at. */
export interface ValueFacts {
  readonly kind: 'null' | 'text' | 'bytes' | 'unreadable';
  /** The kind of its column. */
  readonly column: ColKind;
  /** The start of its text (enough to tell JSON from XML from prose). */
  readonly start: string;
  /** Bytes of the whole value. */
  readonly total: number;
  readonly image: ImageInfo | null;
}

/** A picture is drawn up to this size; what claims more is shown as bytes. */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 16_384;
export const MAX_IMAGE_PIXELS = 100_000_000;

/**
 * Whether a binary value is drawn as a picture: a raster format the header names, of a size the header
 * admits to and the window can afford. A header that does not say its size (0) is drawn only when the
 * data is small. Anything else stays bytes – nothing is ever decoded on a guess.
 */
export function drawable(image: ImageInfo | null, total: number): boolean {
  if (!image || total > MAX_IMAGE_BYTES) return false;
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mime)) return false;
  if (image.width === 0 || image.height === 0) return total <= 4 * 1024 * 1024;
  return (
    image.width <= MAX_IMAGE_SIDE &&
    image.height <= MAX_IMAGE_SIDE &&
    image.width * image.height <= MAX_IMAGE_PIXELS
  );
}

const looksLikeJson = (start: string) => /^\s*[{[]/.test(start) && /^\s*(\{\s*["}]|\[)/.test(start);
const looksLikeXml = (start: string) => /^\s*<(\?xml|!DOCTYPE|[A-Za-z_][\w:.-]*[\s>/])/.test(start);
const INTEGER = /^-?\d+$/;

/** The views of a value, the one shown first in front. */
export function viewsOf(facts: ValueFacts): ValueView[] {
  if (facts.kind === 'null' || facts.kind === 'unreadable') return ['text'];
  if (facts.kind === 'bytes') {
    return drawable(facts.image, facts.total) ? ['image', 'hex'] : ['hex'];
  }
  const start = facts.start;
  if (facts.column === 'json') return ['json', 'text'];
  if (facts.column === 'int' && INTEGER.test(start.trim())) return ['text', 'number'];
  if (['timestamp', 'timestampTz', 'date'].includes(facts.column)) return ['text', 'date'];
  if (looksLikeJson(start)) return ['json', 'text'];
  if (looksLikeXml(start)) return ['xml', 'text'];
  return ['text'];
}

/** The grammar the editor colours a view with; `''` = plain text. */
export function languageOf(view: ValueView): string {
  return view === 'json' ? 'JSON' : view === 'xml' ? 'XML' : '';
}

const isBlank = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;

/**
 * Lays JSON out, one member per line, without reading its values: strings, numbers and words are copied
 * as they are (a number of forty digits stays one, a key that occurs twice stays twice). Works in steps,
 * so a caller can let the window breathe between them. Broken JSON is laid out as far as its brackets
 * go and copied from there on – never an error, never a loss.
 */
export class JsonLayout {
  private at = 0;
  private depth = 0;
  private readonly out: string[] = [];
  /** A bracket was opened and nothing written behind it yet. */
  private fresh = false;
  /** The last thing written was a value: another one right behind it (broken JSON) gets a blank. */
  private value = false;
  private readonly unit: string;

  constructor(
    private readonly text: string,
    indent = 2,
  ) {
    this.unit = ' '.repeat(indent);
  }

  get done(): boolean {
    return this.at >= this.text.length;
  }

  /** How far it is, 0…1. */
  get progress(): number {
    return this.text.length === 0 ? 1 : this.at / this.text.length;
  }

  private line(): void {
    this.out.push('\n', this.unit.repeat(this.depth));
  }

  /** Works through about `chars` characters of the text. */
  step(chars = Number.MAX_SAFE_INTEGER): void {
    const text = this.text;
    const end = Math.min(text.length, this.at + chars);
    while (this.at < end) {
      const code = text.charCodeAt(this.at);
      if (isBlank(code)) {
        this.at++;
        continue;
      }
      const ch = text[this.at];
      if (ch === '{' || ch === '[') {
        if (this.fresh) this.line();
        this.out.push(ch);
        this.depth++;
        this.fresh = true;
        this.value = false;
        this.at++;
      } else if (ch === '}' || ch === ']') {
        this.depth = Math.max(0, this.depth - 1);
        // an empty object or array stays `{}` / `[]`
        if (!this.fresh) this.line();
        this.fresh = false;
        this.out.push(ch);
        this.at++;
      } else if (ch === ',') {
        this.out.push(',');
        this.line();
        this.value = false;
        this.at++;
      } else if (ch === ':') {
        this.out.push(': ');
        this.value = false;
        this.at++;
      } else {
        if (this.fresh) {
          this.line();
          this.fresh = false;
        }
        const from = this.at;
        if (ch === '"') {
          this.at++;
          while (this.at < text.length && text[this.at] !== '"') {
            this.at += text[this.at] === '\\' ? 2 : 1;
          }
          this.at = Math.min(text.length, this.at + 1);
        } else {
          // a number, true, false, null – or anything else, up to the next sign of the structure
          while (
            this.at < text.length &&
            !'{}[],:"'.includes(text[this.at]) &&
            !isBlank(text.charCodeAt(this.at))
          ) {
            this.at++;
          }
          if (this.at === from) this.at++;
        }
        if (this.value) this.out.push(' ');
        this.out.push(text.slice(from, this.at));
        this.value = true;
      }
    }
  }

  result(): string {
    return this.out.join('');
  }
}

/** JSON laid out in one go. */
export function layoutJson(text: string, indent = 2): string {
  const layout = new JsonLayout(text, indent);
  layout.step();
  return layout.result();
}

/**
 * Lays XML out: one element per line, indented by depth; text between tags stays with its element when it
 * is short and has no elements beside it. Comments, CDATA, processing instructions and the doctype are
 * copied as they are. Text that is not XML comes back unchanged.
 */
export function layoutXml(text: string, indent = 2): string {
  // a `<` that starts no tag (`a < b`) is text
  const token =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<\/[A-Za-z_][^>]*>|<[A-Za-z_][^>]*>|<|[^<]+/g;
  const isTag = (t: string | undefined): boolean => !!t && t.length > 1 && t.startsWith('<');
  const tokens = text.match(token);
  if (!tokens || !tokens.some(isTag)) return text;
  const unit = ' '.repeat(indent);
  const lines: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!isTag(t)) {
      // text; a lonely `<` belongs to the text around it
      let content = t;
      while (i + 1 < tokens.length && !isTag(tokens[i + 1])) content += tokens[++i];
      content = content.trim();
      if (content !== '') lines.push(unit.repeat(depth) + content);
      continue;
    }
    const closing = t.startsWith('</');
    const special = t.startsWith('<?') || t.startsWith('<!');
    const selfClosing = t.endsWith('/>');
    if (closing) depth = Math.max(0, depth - 1);
    // <a>text</a> on one line
    const next = tokens[i + 1];
    const after = tokens[i + 2];
    if (
      !closing &&
      !special &&
      !selfClosing &&
      next !== undefined &&
      !next.startsWith('<') &&
      after?.startsWith('</') &&
      !next.includes('\n')
    ) {
      lines.push(unit.repeat(depth) + t + next + after);
      i += 2;
      continue;
    }
    lines.push(unit.repeat(depth) + t);
    if (!closing && !special && !selfClosing) depth++;
  }
  return lines.join('\n');
}

const HEX = '0123456789abcdef';

/** Bytes as lines of sixteen: offset, hex, and what is printable ASCII (the rest a dot). */
export function hexDump(bytes: Uint8Array, offset = 0): string {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += 16) {
    let hex = '';
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      if (at + i < bytes.length) {
        const b = bytes[at + i];
        hex += HEX[b >> 4] + HEX[b & 15] + ' ';
        ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
      } else {
        hex += '   ';
      }
      if (i === 7) hex += ' ';
    }
    lines.push(`${(offset + at).toString(16).padStart(8, '0')}  ${hex} ${ascii}`);
  }
  return lines.join('\n');
}

/** Base64 → bytes. */
export function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A whole number in other bases, exact for any length; `null` when the text is none. */
export function numberForms(text: string): { decimal: string; hex: string; binary: string } | null {
  const t = text.trim();
  if (!INTEGER.test(t)) return null;
  const n = BigInt(t);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const group = (digits: string, size: number, sep: string) =>
    digits.replace(new RegExp(`\\B(?=(.{${size}})+$)`, 'g'), sep);
  return {
    decimal: sign + group(abs.toString(10), 3, ' '),
    hex: `${sign}0x${group(abs.toString(16).toUpperCase(), 4, ' ')}`,
    binary: `${sign}0b${group(abs.toString(2), 8, ' ')}`,
  };
}

/**
 * A date or time of a result in other zones. A value with an offset is an instant: it is shown in UTC and
 * in the zone of this computer. One without is a wall-clock time – it is not moved, only its parts shown.
 */
export function dateForms(
  text: string,
  column: ColKind,
): { utc: string | null; local: string | null; epoch: string | null; weekday: number } | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      text.trim(),
    );
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', fraction = '', zone] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${fraction.slice(0, 4)}`;
  if (column === 'timestampTz' && zone) {
    const offset =
      zone === 'Z'
        ? 'Z'
        : zone.length === 3
          ? `${zone}:00`
          : zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const instant = new Date(iso + offset);
    if (Number.isNaN(instant.getTime())) return null;
    const pad = (n: number, width = 2) => String(n).padStart(width, '0');
    const local = `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())} ${pad(instant.getHours())}:${pad(instant.getMinutes())}:${pad(instant.getSeconds())}`;
    return {
      utc: instant
        .toISOString()
        .replace('T', ' ')
        .replace(/\.000Z$/, 'Z'),
      local,
      epoch: String(Math.floor(instant.getTime() / 1000)),
      weekday: instant.getDay(),
    };
  }
  // no zone: the day of the week of the date as written (read as UTC so that no zone moves it)
  const day = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return null;
  return { utc: null, local: null, epoch: null, weekday: day.getUTCDay() };
}

/** Bytes as a person reads them: `512 B`, `1.5 KB`, `50.0 MB`. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${n.toFixed(1)} ${units[unit]}`;
}

/** Bytes of a value that are read without asking: what is shown while moving through cells. */
export const FIRST_PART = 256 * 1024;
/** A value up to this size is read whole at once; a larger one on request. */
export const AUTO_WHOLE = 4 * 1024 * 1024;
/** Bytes asked for in one piece when the whole value is read. */
export const PART = 4 * 1024 * 1024;
/** Bytes of binary data the hex view shows (the file has all of them). */
export const HEX_BYTES = 256 * 1024;
/** A whole value is read into the window up to this size; beyond it there is the file. */
export const MAX_IN_WINDOW = 256 * 1024 * 1024;

/** The ending of a file a value of a column is saved into. */
export function extensionOf(column: ColKind): string {
  return column === 'bytes' ? 'bin' : column === 'json' ? 'json' : 'txt';
}
