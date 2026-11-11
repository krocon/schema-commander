import { SavedEntry, SavedMeta } from '../../core/saved/saved-api';

/**
 * Pure logic of the saved queries (prompt 024): the rows of the view (folders with their queries), what the
 * form of a query may hold, and the list of those used lately.
 */

/** A row of the view: a folder (with the queries below it) or a query. */
export type SavedRow =
  | {
      readonly kind: 'folder';
      /** `f:<path>`. */
      readonly key: string;
      readonly folder: string;
      /** The last part of the path. */
      readonly label: string;
      /** 0 = directly below the root. */
      readonly level: number;
      readonly open: boolean;
      /** Queries in it and below. */
      readonly count: number;
    }
  | {
      readonly kind: 'query';
      /** `q:<id>`. */
      readonly key: string;
      readonly entry: SavedEntry;
      readonly level: number;
    };

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/**
 * The tree as rows: folders first, each with its queries below it, closed folders without theirs.
 * `only` (ids a search found) leaves the matching queries and their folders, all open.
 */
export function savedRows(
  entries: readonly SavedEntry[],
  folders: readonly string[],
  closed: ReadonlySet<string>,
  only: ReadonlySet<string> | null = null,
): SavedRow[] {
  const shown = only ? entries.filter((e) => only.has(e.id)) : entries;
  const all = new Set<string>(only ? [] : folders);
  for (const e of shown) {
    const parts = e.folder ? e.folder.split('/') : [];
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join('/'));
  }
  const count = (folder: string) =>
    shown.filter((e) => e.folder === folder || e.folder.startsWith(`${folder}/`)).length;
  const rows: SavedRow[] = [];
  const walk = (parent: string, level: number) => {
    const children = [...all]
      .filter((f) => (parent ? f.startsWith(`${parent}/`) : true))
      .filter((f) => f.split('/').length === level + 1)
      .sort(byName);
    for (const folder of children) {
      const open = only !== null || !closed.has(folder);
      rows.push({
        kind: 'folder',
        key: `f:${folder}`,
        folder,
        label: folder.split('/').pop() ?? folder,
        level,
        open,
        count: count(folder),
      });
      if (open) walk(folder, level + 1);
    }
    for (const entry of shown
      .filter((e) => e.folder === parent)
      .sort((a, b) => byName(a.name, b.name))) {
      rows.push({ kind: 'query', key: `q:${entry.id}`, entry, level });
    }
  };
  walk('', 0);
  return rows;
}

/** What the form of a saved query holds. */
export interface SavedForm {
  readonly name: string;
  readonly folder: string;
  readonly description: string;
  /** As typed: separated by commas. */
  readonly tags: string;
  /** Belongs to the connection it was saved from. */
  readonly bound: boolean;
}

/** A folder as typed: `/` between its parts, no blanks around them, none empty. */
export function cleanFolder(typed: string): string {
  return typed
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('/');
}

/** What is wrong with a form; `null` = nothing. The backend checks again. */
export function formProblem(form: SavedForm): 'name' | 'folder' | null {
  if (form.name.trim() === '') return 'name';
  const parts = cleanFolder(form.folder).split('/');
  // eslint-disable-next-line no-control-regex
  const bad = /^\.|[\u0000-\u001f:*?"<>|]/;
  if (parts.length > 8 || parts.some((p) => bad.test(p))) return 'folder';
  return null;
}

export function metaOf(
  form: SavedForm,
  connection: { id: string; kind: string } | null,
  before: SavedMeta | null,
): SavedMeta {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    tags: form.tags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== ''),
    // a query that was bound stays bound to what it was bound to
    connection: form.bound ? (before?.connection ?? connection?.id ?? null) : null,
    dialect: form.bound ? (before?.dialect ?? connection?.kind ?? null) : null,
  };
}

/** A name for a query from its text: the start of its first line that is no comment. */
export function nameFromText(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '' && !l.startsWith('--') && !l.startsWith('#')) ?? '';
  const flat = line.replace(/\s+/g, ' ').replace(/;$/, '');
  return flat.length > 60 ? `${flat.slice(0, 57).trimEnd()}…` : flat;
}

export const MAX_RECENT_SAVED = 20;

/** The start of a text for a preview: its first lines, cut. */
export function previewOf(text: string, lines = 12, chars = 1200): string {
  const head = text.split('\n').slice(0, lines).join('\n');
  const cut = head.length > chars ? head.slice(0, chars) : head;
  return cut.length < text.trimEnd().length ? `${cut.trimEnd()}\n…` : cut;
}
