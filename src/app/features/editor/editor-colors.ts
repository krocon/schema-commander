/**
 * The colours of `<editlicious-editor>` from our design tokens (design 001 E1). The editor runs with
 * `scheme="none"`; these values are set on the element (its variables only act there) and resolve against the
 * tokens on `<html>`, so it follows every colour scheme at once. Left side: the documented variables of the
 * package (README „Colour variables“); right side: tokens of `core/theme/tokens.ts` (a spec checks both).
 *
 * Selection and matches are translucent mixes: the editor does not change the text colour above them, a solid
 * `--hit-current-bg` (made for dark text) would make light text unreadable.
 */
const mix = (token: string, percent: number) =>
  `color-mix(in srgb, var(${token}) ${percent}%, transparent)`;

export const EDITOR_COLORS: Readonly<Record<string, string>> = {
  '--ed-bg': 'var(--bg-app)',
  '--ed-text': 'var(--text)',
  '--ed-gutter-bg': 'var(--bg-gutter)',
  '--ed-gutter-text': 'var(--text-dim)',
  '--ed-gutter-text-active': 'var(--text)',
  '--ed-current-line': mix('--text', 6),
  '--ed-selection': mix('--accent', 32),
  '--ed-selection-inactive': mix('--text-dim', 24),
  '--ed-caret': 'var(--accent)',
  '--ed-whitespace': 'var(--border)',
  '--ed-indent-guide': 'var(--border)',
  '--ed-search-match': mix('--hit-current-bg', 30),
  '--ed-search-current': mix('--hit-current-bg', 60),
  '--ed-scrollbar': 'var(--bg-hover)',
  '--ed-scrollbar-hover': 'var(--text-dim)',
  '--ed-mark-error': 'var(--danger)',
  '--ed-mark-warning': 'var(--warn-fg)',
  '--ed-mark-info': 'var(--accent)',
  '--ed-mark-hint': 'var(--text-dim)',
  '--syn-comment': 'var(--sql-comment)',
  '--syn-string': 'var(--sql-string)',
  '--syn-keyword': 'var(--sql-keyword)',
  '--syn-number': 'var(--sql-number)',
  '--syn-constant': 'var(--sql-number)',
  '--syn-type': 'var(--sql-ident)',
  '--syn-function': 'var(--sql-function)',
  '--syn-variable': 'var(--text)',
  '--syn-operator': 'var(--text-dim)',
  '--syn-punct': 'var(--text-dim)',
  '--syn-invalid': 'var(--danger)',
  '--color-bg': 'var(--bg-panel)',
  '--color-surface': 'var(--bg-raised)',
  '--color-surface-2': 'var(--bg-hover)',
  '--color-hover': 'var(--bg-hover)',
  '--color-text': 'var(--text)',
  '--color-text-muted': 'var(--text-dim)',
  '--color-border': 'var(--border)',
  '--color-accent': 'var(--accent)',
  '--color-accent-text': 'var(--accent-text)',
  '--color-focus': 'var(--accent)',
  '--color-error': 'var(--danger)',
  '--color-warning': 'var(--warn-fg)',
  '--font-editor': 'var(--font-mono)',
};
