import { translatable } from '../../core/i18n/i18n';
import { MENU_DE } from './menu-texts.de';

/** Texts of the menu bar (prompt 018). The entries themselves are the names of the actions. */
export const MENU_EN = {
  appName: 'Schema Commander',
  menuBar: 'Menu bar',
  file: 'File',
  edit: 'Edit',
  view: 'View',
  query: 'Query',
  connection: 'Connection',
  tools: 'Tools',
  window: 'Window',
  help: 'Help',
  copyAs: 'Copy result as',
  navigation: 'Go to',
  layout: 'Split view',
  schema: 'Schema',
  format: 'More formatting',
  saved: 'Folder of the saved queries',
  failed: (reason: string) => `The menu bar could not be built: ${reason}`,
  /** The words of the items macOS provides. */
  native: {
    about: 'About Schema Commander',
    services: 'Services',
    hide: 'Hide Schema Commander',
    hideOthers: 'Hide Others',
    showAll: 'Show All',
    quit: 'Quit Schema Commander',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    minimize: 'Minimize',
    maximize: 'Zoom',
    fullscreen: 'Enter Full Screen',
  },
};

export const MENU_TEXTS = translatable('menus', MENU_EN, { de: MENU_DE });
