/**
 * Pure logic of the command palette (prompt 002): fuzzy matching of action names and the order of the list.
 */
export interface PaletteEntry {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  /** The shortcut as shown (`⌘B`), `''` without one. */
  readonly keys: string;
  readonly enabled: boolean;
}

export interface PaletteHit {
  readonly entry: PaletteEntry;
  /** Indices in `entry.label` that matched, for the highlight. */
  readonly marks: readonly number[];
  readonly score: number;
}

/**
 * Lower case without accents, one character for each character of the input (so indices in the folded text
 * are indices in the original): `é` → `e`, `…` stays one character.
 */
function fold(text: string): string {
  let out = '';
  // by UTF-16 unit, not by code point: the indices must stay those of `text`
  for (const unit of text.split('')) {
    const plain = unit.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    out += plain.length > 0 ? plain[0] : unit;
  }
  return out;
}

/**
 * Matches `query` in `text` as a subsequence, every word of the query on its own. Higher is better: a match at
 * the start of the text or of a word and matches in a row count more. `null` = no match.
 */
export function fuzzyMatch(query: string, text: string): { score: number; marks: number[] } | null {
  const hay = fold(text);
  let score = 0;
  const marks: number[] = [];
  for (const word of fold(query).split(/\s+/).filter(Boolean)) {
    const exact = hay.indexOf(word);
    if (exact >= 0) {
      const atWord = exact === 0 || /[^\p{L}\p{N}]/u.test(hay[exact - 1]);
      score += 100 + word.length * 4 + (exact === 0 ? 40 : atWord ? 25 : 0);
      for (let i = 0; i < word.length; i++) marks.push(exact + i);
      continue;
    }
    let from = 0;
    let last = -2;
    let part = 0;
    for (const ch of word) {
      const at = hay.indexOf(ch, from);
      if (at < 0) return null;
      const atWord = at === 0 || /[^\p{L}\p{N}]/u.test(hay[at - 1]);
      part += 4 + (at === last + 1 ? 6 : 0) + (atWord ? 8 : 0);
      marks.push(at);
      last = at;
      from = at + 1;
    }
    score += part;
  }
  return { score, marks: [...new Set(marks)].sort((a, b) => a - b) };
}

/**
 * The list for a query. Without a query: the recently used actions first (in their order), then all others
 * as given. With a query: by score; ties by recency, then by name. Disabled actions stay in the list (they
 * are shown dimmed) but come after the enabled ones of the same score.
 */
export function paletteHits(
  entries: readonly PaletteEntry[],
  query: string,
  recent: readonly string[],
): PaletteHit[] {
  const recency = (id: string) => {
    const i = recent.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  if (!query.trim()) {
    return entries
      .map((entry, index) => ({ entry, marks: [], score: 0, index }))
      .sort((a, b) => recency(a.entry.id) - recency(b.entry.id) || a.index - b.index);
  }
  const hits: PaletteHit[] = [];
  for (const entry of entries) {
    const m = fuzzyMatch(query, entry.label);
    if (m) {
      hits.push({ entry, marks: m.marks, score: m.score });
      continue;
    }
    // the group and the id find it too, a little weaker and without highlight
    const other = fuzzyMatch(query, `${entry.group} ${entry.id.replace(/_/g, ' ')}`);
    if (other) hits.push({ entry, marks: [], score: other.score / 2 });
  }
  return hits.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.entry.enabled) - Number(a.entry.enabled) ||
      recency(a.entry.id) - recency(b.entry.id) ||
      a.entry.label.localeCompare(b.entry.label),
  );
}

/** The label in pieces: `[text, marked]`. */
export function markedParts(label: string, marks: readonly number[]): [string, boolean][] {
  if (marks.length === 0) return [[label, false]];
  const set = new Set(marks);
  const parts: [string, boolean][] = [];
  for (let i = 0; i < label.length; i++) {
    const on = set.has(i);
    const last = parts[parts.length - 1];
    if (last && last[1] === on) last[0] += label[i];
    else parts.push([label[i], on]);
  }
  return parts;
}

/** `id` at the front of the recently used ids, at most `max`. */
export function pushRecent(recent: readonly string[], id: string, max: number): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, max);
}
