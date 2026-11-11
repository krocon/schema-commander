import { AppInfo } from '../../core/about/about-api';
import { ABOUT_TEXTS } from './about-texts';

export const AUTHOR = 'Marc Kronberg';
export const SOURCE_URL = 'https://github.com/krocon/schema-commander';

export interface AboutRow {
  readonly label: string;
  readonly value: string;
}

/**
 * The engine of the WebView and its version from the user agent: `WebKit 619.1`, `Chromium 141.0`.
 * Nothing else of the user agent is kept.
 */
export function webviewOf(userAgent: string): string {
  const edge = /Edg\/([\d.]+)/.exec(userAgent);
  if (edge) return `WebView2 ${edge[1]}`;
  const chrome = /Chrom(?:e|ium)\/([\d.]+)/.exec(userAgent);
  if (chrome) return `Chromium ${chrome[1]}`;
  const webkit = /AppleWebKit\/([\d.]+)/.exec(userAgent);
  if (webkit) return `WebKit ${webkit[1]}`;
  return '';
}

/** The rows of the dialog. `info` is `null` outside the desktop app. */
export function aboutRows(info: AppInfo | null, userAgent: string): AboutRow[] {
  const t = ABOUT_TEXTS;
  const rows: AboutRow[] = [];
  if (info) {
    rows.push({
      label: t.version,
      value:
        info.crateVersion === info.version
          ? info.version
          : `${info.version} (${t.crateMismatch(info.crateVersion)})`,
    });
    rows.push({ label: t.build, value: info.debug ? t.buildDebug : t.buildRelease });
    rows.push({ label: t.platform, value: `${t.os[info.os] ?? info.os} · ${info.arch}` });
    rows.push({ label: t.tauri, value: info.tauriVersion });
  }
  const webview = webviewOf(userAgent);
  if (webview) rows.push({ label: t.webview, value: webview });
  rows.push({ label: t.author, value: AUTHOR });
  rows.push({ label: t.license, value: t.licenseValue });
  rows.push({ label: t.source, value: SOURCE_URL });
  return rows;
}

/**
 * Plain text for a bug report: what the app and its platform are – no path, no connection, nothing of
 * the user's.
 */
export function diagnostics(info: AppInfo | null, userAgent: string): string {
  return [
    info?.name ?? 'Schema Commander',
    ...aboutRows(info, userAgent).map((r) => `${r.label}: ${r.value}`),
  ].join('\n');
}
