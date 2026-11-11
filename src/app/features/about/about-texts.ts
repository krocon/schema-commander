import { translatable } from '../../core/i18n/i18n';
import { ABOUT_DE } from './about-texts.de';

/** Texts of the About dialog (prompt 034). English is the source. */
export const ABOUT_EN = {
  title: 'About Schema Commander',
  tagline: 'A keyboard-driven SQL client',
  version: 'Version',
  crateMismatch: (crate: string) => `Rust crate ${crate}`,
  build: 'Build',
  buildDebug: 'development',
  buildRelease: 'release',
  platform: 'Platform',
  webview: 'WebView',
  tauri: 'Tauri',
  author: 'Author',
  license: 'Licence',
  licenseValue: 'MIT',
  source: 'Source',
  os: { macos: 'macOS', windows: 'Windows', linux: 'Linux' } as Record<string, string>,
  noBackend: 'Build details are only known in the desktop app.',
  loading: 'Loading …',
  copy: 'Copy diagnostics',
  copied: 'Copied to the clipboard.',
  copyFailed: 'Could not copy.',
  showNotices: 'Third-party licences',
  hideNotices: 'Hide licences',
  noticesLabel: 'Licences of the third-party components',
  noticesFailed: 'The licence texts could not be read.',
  close: 'Close',
};

export const ABOUT_TEXTS = translatable('about', ABOUT_EN, { de: ABOUT_DE });
