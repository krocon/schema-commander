/**
 * The native menu as the backend takes it (mirrors `MenuSpec` in src-tauri/src/app_menu.rs – in sync by
 * hand). Shortcuts are in the notation of the keymap; Rust turns the safe ones into accelerators.
 */
export type NativeMenuNode =
  | {
      readonly kind: 'item';
      /** The id of an action. */
      readonly id: string;
      readonly label: string;
      readonly accelerator: string | null;
      readonly enabled: boolean;
      /** Set: a check item (✓ when true). */
      readonly checked?: boolean;
    }
  | { readonly kind: 'submenu'; readonly label: string; readonly items: readonly NativeMenuNode[] }
  | { readonly kind: 'separator' }
  /** An item of the OS; `label` are its words in the language of the window. */
  | { readonly kind: 'predefined'; readonly name: PredefinedItem; readonly label: string | null };

export type PredefinedItem =
  | 'about'
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'showAll'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'minimize'
  | 'maximize'
  | 'fullscreen';

export interface NativeMenuSpec {
  /** The entries of the bar are submenus. */
  readonly menus: readonly NativeMenuNode[];
}

/** Mirrors `MenuEvent`: a menu item was chosen. */
export interface NativeMenuEvent {
  readonly id: string;
}

/** Mirrors `MenuItemState`: the new state of one item of the installed menu. */
export interface MenuItemState {
  readonly id: string;
  readonly enabled: boolean;
  readonly checked?: boolean | null;
}
