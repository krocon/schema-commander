import { contrastRatio, parseColor, toHex, WHITE } from '../../core/theme/color';
import {
  CONTRAST_PAIRS,
  completeTokens,
  diffTokens,
  resolveColor,
  sanitizeTokens,
} from '../../core/theme/theme-logic';
import { Theme, USER_PREFIX } from '../../core/theme/theme.models';

/**
 * Pure logic of the scheme editor (design 001): ids, the draft with all tokens, what a scheme stores,
 * reading a file to import, and the contrast of a token.
 */

export const MAX_NAME_LEN = 100;
const MAX_ID_LEN = 64;

/** A scheme while it is edited: every token has a value (base + own). */
export interface ThemeDraft {
  /** `null` = not stored yet. */
  readonly id: string | null;
  readonly name: string;
  readonly dark: boolean;
  readonly tokens: Readonly<Record<string, string>>;
}

/** `user-<name as slug>`, made unique with `-2`, `-3` … */
export function newUserId(name: string, taken: ReadonlySet<string>): string {
  const slug =
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_ID_LEN - USER_PREFIX.length - 4) || 'schema';
  const base = `${USER_PREFIX}${slug}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/** A name not used yet: `Dunkel (Kopie)`, `Dunkel (Kopie 2)` … */
export function copyName(name: string, taken: ReadonlySet<string>): string {
  const stem = name.replace(/ \(Kopie(?: \d+)?\)$/, '').slice(0, MAX_NAME_LEN - 12);
  let candidate = `${stem} (Kopie)`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem} (Kopie ${n})`;
  return candidate;
}

export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Bitte einen Namen eingeben.';
  if ([...trimmed].length > MAX_NAME_LEN) return `Höchstens ${MAX_NAME_LEN} Zeichen.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) return 'Der Name enthält Steuerzeichen.';
  return null;
}

/** All tokens of a scheme: the base of its brightness, overlaid with its own. */
export function draftOf(theme: Theme, light: Theme, dark: Theme, id: string | null): ThemeDraft {
  return { id, name: theme.name, dark: theme.dark, tokens: completeTokens(theme, light, dark) };
}

/** The same own values on the base of the other brightness. */
export function withBrightness(
  draft: ThemeDraft,
  dark: boolean,
  lightBase: Theme,
  darkBase: Theme,
): ThemeDraft {
  if (draft.dark === dark) return draft;
  const own = diffTokens(draft.tokens, (draft.dark ? darkBase : lightBase).tokens);
  return { ...draft, dark, tokens: { ...(dark ? darkBase : lightBase).tokens, ...own } };
}

/** What is stored: only what differs from the base. */
export function themeOf(draft: ThemeDraft, id: string, light: Theme, dark: Theme): Theme {
  return {
    id,
    name: draft.name.trim(),
    dark: draft.dark,
    tokens: diffTokens(draft.tokens, (draft.dark ? dark : light).tokens),
  };
}

export interface ImportResult {
  /** `null` = the file is no scheme. */
  readonly draft: ThemeDraft | null;
  /** Names of tokens that were left out (unknown token, unsafe or wrong kind of value). */
  readonly dropped: readonly string[];
}

/**
 * A file's JSON as a draft. Forgiving about everything but the shape: `tokens` must be an object. Only
 * catalog tokens with a value of their kind survive; the scheme always gets a new id.
 */
export function importDraft(
  raw: unknown,
  light: Theme,
  dark: Theme,
  takenNames: ReadonlySet<string>,
): ImportResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { draft: null, dropped: [] };
  const o = raw as Record<string, unknown>;
  if (!o['tokens'] || typeof o['tokens'] !== 'object' || Array.isArray(o['tokens'])) {
    return { draft: null, dropped: [] };
  }
  const { tokens, dropped } = sanitizeTokens(o['tokens']);
  const isDark = typeof o['dark'] === 'boolean' ? o['dark'] : guessDark(tokens);
  const given = typeof o['name'] === 'string' && !nameProblem(o['name']) ? o['name'].trim() : '';
  let name = given || 'Importiertes Schema';
  if (takenNames.has(name)) name = copyName(name, takenNames);
  return {
    draft: {
      id: null,
      name,
      dark: isDark,
      tokens: { ...(isDark ? dark : light).tokens, ...tokens },
    },
    dropped,
  };
}

/** Without a `dark` flag: a dark background means a dark scheme. */
function guessDark(tokens: Readonly<Record<string, string>>): boolean {
  const bg = resolveColor('--bg-app', tokens);
  if (!bg) return true;
  return contrastRatio(WHITE, bg, WHITE) > 4.5;
}

export interface TokenContrast {
  /** The worst ratio of the pairs this token is part of. */
  readonly ratio: number;
  readonly min: number;
  readonly ok: boolean;
  /** The other token of that pair. */
  readonly against: string;
}

/** The weakest contrast pair of a token; `null` = the token is in no pair (or a colour is missing). */
export function tokenContrast(
  name: string,
  tokens: Readonly<Record<string, string>>,
): TokenContrast | null {
  const app = resolveColor('--bg-app', tokens) ?? WHITE;
  const backdrop = app.a < 1 ? WHITE : app;
  let worst: TokenContrast | null = null;
  for (const pair of CONTRAST_PAIRS) {
    if (pair.fg !== name && pair.bg !== name) continue;
    const fg = resolveColor(pair.fg, tokens);
    const bg = resolveColor(pair.bg, tokens);
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg, backdrop);
    // the pair that misses its own minimum by most
    if (!worst || ratio / pair.min < worst.ratio / worst.min) {
      worst = {
        ratio,
        min: pair.min,
        ok: ratio >= pair.min,
        against: pair.fg === name ? pair.bg : pair.fg,
      };
    }
  }
  return worst;
}

/** How many pairs of a complete scheme miss their minimum. */
export function failingPairs(tokens: Readonly<Record<string, string>>): number {
  const app = resolveColor('--bg-app', tokens) ?? WHITE;
  const backdrop = app.a < 1 ? WHITE : app;
  return CONTRAST_PAIRS.filter((pair) => {
    const fg = resolveColor(pair.fg, tokens);
    const bg = resolveColor(pair.bg, tokens);
    return !fg || !bg || contrastRatio(fg, bg, backdrop) < pair.min;
  }).length;
}

/** `#rrggbb` for `<input type="color">`; `#000000` when the value is no colour. */
export function swatchHex(name: string, tokens: Readonly<Record<string, string>>): string {
  const c = resolveColor(name, tokens);
  return c ? toHex({ ...c, a: 1 }).slice(0, 7) : '#000000';
}

/** A colour typed by hand, normalised: plain colours and `var(--token)` stay as typed (trimmed). */
export function isPlainColor(value: string): boolean {
  return parseColor(value) !== null;
}
