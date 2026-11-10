import type { ColorScheme, EditliciousEditorElement } from 'editlicious-editor';

export type { EdCaret, EditliciousEditorElement } from 'editlicious-editor';

/**
 * `<editlicious-editor>` is not bundled: the package is an ES module that finds its worker and its
 * WebAssembly engine next to itself. `angular.json` copies it to `/editlicious/`, and it is loaded from
 * there on first use (a module of its own, about 4 MB with the engine).
 */
const MODULE_URL = 'editlicious/editlicious-editor.js';

let loading: Promise<void> | null = null;

/** Defines `<editlicious-editor>` (once). Rejects when the module cannot be loaded. */
export function loadEditlicious(): Promise<void> {
  loading ??= import(/* @vite-ignore */ new URL(MODULE_URL, document.baseURI).href).then(() =>
    customElements.whenDefined('editlicious-editor').then(() => undefined),
  );
  loading.catch(() => (loading = null));
  return loading;
}

/** Editor schemes that share a name or mood with one of ours; everything else follows its brightness. */
const BY_THEME: Readonly<Record<string, ColorScheme>> = {
  amber: 'amber',
  'one-dark': 'one',
  'one-dark-vivid': 'one',
  'true-black': 'ink',
  'true-dark': 'graphite',
  'solarized-light': 'sand',
};

/** The editor's own colour scheme for one of the app's schemes. */
export function editorScheme(themeId: string, dark: boolean): ColorScheme {
  return BY_THEME[themeId] ?? (dark ? 'one' : 'paper');
}

export function isEditor(el: Element | null | undefined): el is EditliciousEditorElement {
  return !!el && el.localName === 'editlicious-editor';
}
