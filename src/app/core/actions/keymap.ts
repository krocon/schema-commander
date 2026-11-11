import { ACTION_IDS, ActionId, ActionScope, actionDef, isActionId } from './action-catalog';
import { actionLabel } from './action-texts';
import { KEYMAP_TEXTS } from './keymap-texts';
import linux from './keymaps/linux.json';
import macos from './keymaps/macos.json';
import windows from './keymaps/windows.json';
import { Platform } from './platform';
import { canonicalShortcut, formatShortcut } from './shortcut';

/** Action id → shortcuts (canonical strings). */
export type Bindings = Readonly<Record<ActionId, readonly string[]>>;
/** As stored: any keys, any values (checked here). */
export type RawBindings = Readonly<Record<string, unknown>>;

export const DEFAULT_KEYMAPS: Readonly<Record<Platform, RawBindings>> = { macos, windows, linux };

/** A text of the keymap catalog; the table holds the key, the text is read when it is needed. */
type ReasonKey =
  | 'macQuit'
  | 'macHide'
  | 'macHideOthers'
  | 'macMinimize'
  | 'macFullScreen'
  | 'macAppSwitch'
  | 'macSpotlight'
  | 'closeWindow'
  | 'appSwitch';

/** Taken by the system or the native application menu on this OS: never bound. */
const RESERVED: Readonly<Record<Platform, Readonly<Record<string, ReasonKey>>>> = {
  macos: {
    'Mod+Q': 'macQuit',
    'Mod+H': 'macHide',
    'Mod+Alt+H': 'macHideOthers',
    'Mod+M': 'macMinimize',
    'Mod+Ctrl+F': 'macFullScreen',
    'Mod+Tab': 'macAppSwitch',
    'Mod+Shift+Tab': 'macAppSwitch',
    'Mod+Space': 'macSpotlight',
  },
  windows: { 'Alt+F4': 'closeWindow', 'Alt+Tab': 'appSwitch' },
  linux: { 'Alt+F4': 'closeWindow', 'Alt+Tab': 'appSwitch' },
};

/**
 * Edit keys of text fields and of the SQL editor (`editlicious-editor`: find, completion): an action acting
 * there must not take them.
 */
const TEXT_FIELD_KEYS: readonly string[] = [
  'Mod+C',
  'Mod+V',
  'Mod+X',
  'Mod+A',
  'Mod+Z',
  'Mod+Shift+Z',
  'Mod+F',
  'F3',
  'Shift+F3',
  'Ctrl+Space',
];

/** Why a shortcut cannot be given to an action of this scope (in the current language), `null` if it can. */
export function reservedReason(
  shortcut: string,
  scope: ActionScope,
  platform: Platform,
): string | null {
  const own = RESERVED[platform][shortcut];
  if (own) return KEYMAP_TEXTS[own];
  if (scope !== 'view' && TEXT_FIELD_KEYS.includes(shortcut)) {
    return KEYMAP_TEXTS.textEditing;
  }
  return null;
}

export interface ResolvedKeymap {
  readonly bindings: Bindings;
  /** Canonical shortcut → the actions that own it (at most one per place). */
  readonly lookup: ReadonlyMap<string, readonly ActionId[]>;
  /** Problems found while merging, in the language at that time, for the notice list. */
  readonly problems: readonly string[];
}

const label = actionLabel;

/**
 * Defaults + user override: an override entry replaces the list of that action (`[]` = no shortcut), so new
 * defaults of later versions arrive. Unknown ids, invalid and reserved shortcuts are reported and skipped; on a
 * conflict the override wins and the other action loses that shortcut (reported).
 */
export function resolveKeymap(
  platform: Platform,
  override: RawBindings = {},
  defaults: RawBindings = DEFAULT_KEYMAPS[platform],
): ResolvedKeymap {
  const problems: string[] = [];
  const t = KEYMAP_TEXTS;
  const show = (s: string) => formatShortcut(s, platform);
  const normalise = (id: ActionId, list: unknown, own: boolean): string[] => {
    const out: string[] = [];
    const where = own ? t.ownBindings : t.defaults;
    if (!Array.isArray(list)) {
      problems.push(t.notAList(label(id), where));
      return out;
    }
    for (const raw of list.slice(0, 8)) {
      const c = typeof raw === 'string' ? canonicalShortcut(raw, platform) : null;
      if (c === null) {
        problems.push(t.invalidShortcut(String(raw).slice(0, 40), label(id), where));
        continue;
      }
      const why = reservedReason(c, actionDef(id).scope, platform);
      if (why) problems.push(t.reserved(show(c), label(id), why));
      else if (!out.includes(c)) out.push(c);
    }
    return out;
  };

  const merged = new Map<ActionId, string[]>(ACTION_IDS.map((id) => [id, []]));
  for (const [id, list] of Object.entries(defaults)) {
    if (isActionId(id)) merged.set(id, normalise(id, list, false));
    else problems.push(t.unknownInDefaults(id));
  }
  const overridden = new Set<ActionId>();
  for (const [id, list] of Object.entries(override)) {
    if (!isActionId(id)) {
      problems.push(t.unknownInOwn(id.slice(0, 64)));
      continue;
    }
    merged.set(id, normalise(id, list, true));
    overridden.add(id);
  }

  // Overridden actions first: they win a conflict.
  const order = [...merged.keys()].sort(
    (a, b) => Number(overridden.has(b)) - Number(overridden.has(a)),
  );
  const lookup = new Map<string, ActionId[]>();
  for (const id of order) {
    const kept: string[] = [];
    for (const s of merged.get(id) ?? []) {
      const owners = lookup.get(s) ?? [];
      // every pair of scopes overlaps (a global action on a plain key acts in the view too)
      const rival = owners[0];
      if (rival) {
        problems.push(t.conflict(show(s), label(rival), label(id)));
        continue;
      }
      lookup.set(s, [...owners, id]);
      kept.push(s);
    }
    merged.set(id, kept);
  }
  // A chord hides a single stroke that is its first part.
  for (const s of [...lookup.keys()]) {
    const first = s.split(' ')[0];
    if (s.includes(' ') && lookup.has(first)) {
      problems.push(t.hidesChord(show(first), show(s)));
    }
  }
  return { bindings: Object.fromEntries(merged) as unknown as Bindings, lookup, problems };
}

/** What recording a shortcut for an action would do (the editor asks before replacing). */
export type Candidate =
  | { readonly kind: 'ok'; readonly shortcut: string }
  | { readonly kind: 'same'; readonly shortcut: string }
  | { readonly kind: 'reserved'; readonly shortcut: string; readonly reason: string }
  | { readonly kind: 'conflict'; readonly shortcut: string; readonly owner: ActionId };

export function checkCandidate(
  id: ActionId,
  shortcut: string,
  keymap: ResolvedKeymap,
  platform: Platform,
): Candidate {
  const scope = actionDef(id).scope;
  const reason = reservedReason(shortcut, scope, platform);
  if (reason) return { kind: 'reserved', shortcut, reason };
  const owners = keymap.lookup.get(shortcut) ?? [];
  if (owners.includes(id)) return { kind: 'same', shortcut };
  const owner = owners[0];
  return owner ? { kind: 'conflict', shortcut, owner } : { kind: 'ok', shortcut };
}

/**
 * The override after giving `shortcut` to `id` (instead of its shortcuts, or in addition), taking it from
 * `loser` if there is one. Only actions that differ from their default stay in the override.
 */
export function assignShortcut(
  override: Readonly<Record<string, readonly string[]>>,
  keymap: ResolvedKeymap,
  id: ActionId,
  shortcut: string,
  platform: Platform,
  loser: ActionId | null,
  mode: 'replace' | 'add' = 'replace',
): Record<string, readonly string[]> {
  const next: Record<string, readonly string[]> = { ...override };
  const kept = mode === 'add' ? keymap.bindings[id].filter((s) => s !== shortcut) : [];
  next[id] = [...kept, shortcut];
  if (loser) next[loser] = keymap.bindings[loser].filter((s) => s !== shortcut);
  return pruneOverride(next, platform);
}

/** Drops entries equal to the default (order does not matter). */
export function pruneOverride(
  override: Readonly<Record<string, readonly string[]>>,
  platform: Platform,
): Record<string, readonly string[]> {
  const defaults = resolveKeymap(platform, {}).bindings;
  const out: Record<string, readonly string[]> = {};
  for (const [id, list] of Object.entries(override)) {
    if (!isActionId(id)) continue;
    const def = defaults[id];
    const same = list.length === def.length && list.every((s) => def.includes(s));
    if (!same) out[id] = list;
  }
  return out;
}
