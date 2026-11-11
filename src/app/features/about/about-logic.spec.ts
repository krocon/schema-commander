import { AppInfo } from '../../core/about/about-api';
import { aboutRows, diagnostics, webviewOf } from './about-logic';

const INFO: AppInfo = {
  name: 'Schema Commander',
  version: '1.2.3',
  crateVersion: '1.2.3',
  tauriVersion: '2.9.0',
  os: 'macos',
  arch: 'aarch64',
  debug: false,
};
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/619.1.26 (KHTML, like Gecko)';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.71';

describe('about logic', () => {
  it('names the engine of the WebView and nothing else of the user agent', () => {
    expect(webviewOf(MAC)).toBe('WebKit 619.1.26');
    expect(webviewOf(WINDOWS)).toBe('WebView2 141.0.3537.71');
    expect(webviewOf('Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.1 Safari/537.36')).toBe(
      'Chromium 120.0.1',
    );
    expect(webviewOf('something else')).toBe('');
  });

  it('lists version, build and platform', () => {
    expect(aboutRows(INFO, MAC)).toEqual([
      { label: 'Version', value: '1.2.3' },
      { label: 'Build', value: 'Release' },
      { label: 'Plattform', value: 'macOS · aarch64' },
      { label: 'Tauri', value: '2.9.0' },
      { label: 'WebView', value: 'WebKit 619.1.26' },
      { label: 'Autor', value: 'Marc Kronberg' },
      { label: 'Lizenz', value: 'MIT' },
      { label: 'Quelltext', value: 'https://github.com/krocon/schema-commander' },
    ]);
    // versions that drifted apart are both shown; an OS without a name of its own as it is
    const odd = aboutRows({ ...INFO, crateVersion: '1.2.2', os: 'freebsd', debug: true }, '');
    expect(odd[0].value).toBe('1.2.3 (Rust-Crate 1.2.2)');
    expect(odd[1].value).toBe('Entwicklung');
    expect(odd[2].value).toBe('freebsd · aarch64');
    // without the desktop app there is still something to say
    expect(aboutRows(null, MAC).map((r) => r.label)).toEqual([
      'WebView',
      'Autor',
      'Lizenz',
      'Quelltext',
    ]);
  });

  it('writes diagnostics that hold nothing of the user', () => {
    const text = diagnostics(INFO, WINDOWS);
    expect(text.split('\n')[0]).toBe('Schema Commander');
    expect(text).toContain('Version: 1.2.3');
    expect(text).toContain('WebView: WebView2 141.0.3537.71');
    // the user agent itself (with the version of the OS) is not in it
    expect(text).not.toContain('Windows NT');
    expect(text).not.toContain('Mozilla');
  });
});
