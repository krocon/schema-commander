import { TestBed } from '@angular/core/testing';
import { AboutApi } from '../../core/about/about-api';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FakeAboutApi, FakeClipboardApi } from '../../../testing/fake-apis';
import { AboutDialog } from './about-dialog';

describe('AboutDialog', () => {
  let api: FakeAboutApi;
  let clipboard: FakeClipboardApi;

  beforeEach(() => {
    // jsdom has no modal dialogs
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    TestBed.resetTestingModule();
    api = new FakeAboutApi();
    clipboard = new FakeClipboardApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: AboutApi, useValue: api },
        { provide: ClipboardApi, useValue: clipboard },
      ],
    });
  });

  async function open() {
    const fixture = TestBed.createComponent(AboutDialog);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const click = async (text: string) => {
      const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
      expect(button, text).toBeDefined();
      button?.click();
      await fixture.whenStable();
    };
    return { fixture, el, click };
  }

  it('shows version, build and platform', async () => {
    const { el } = await open();
    const rows = [...el.querySelectorAll('dt')].map(
      (dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`,
    );
    expect(rows).toContain('Version: 1.2.3');
    expect(rows).toContain('Build: Release');
    expect(rows).toContain('Plattform: macOS · aarch64');
    expect(rows).toContain('Lizenz: MIT');
  });

  it('copies the diagnostics', async () => {
    const { el, click } = await open();
    await click('Diagnose kopieren');
    expect(clipboard.texts.length).toBe(1);
    expect(clipboard.texts[0]).toContain('Schema Commander\nVersion: 1.2.3');
    expect(el.querySelector('.status')?.textContent).toBe('In die Zwischenablage kopiert.');
  });

  it('shows the licence texts as text, and hides them again', async () => {
    const { el, click } = await open();
    expect(el.querySelector('pre')).toBeNull();
    await click('Lizenzen Dritter');
    expect(el.querySelector('pre')?.textContent).toBe('THIRD-PARTY NOTICES\n<b>not markup</b>');
    expect(el.querySelector('pre b')).toBeNull();
    await click('Lizenzen ausblenden');
    expect(el.querySelector('pre')).toBeNull();
  });

  it('still says who made it when there is no backend', async () => {
    api.fail = true;
    const { el, click } = await open();
    expect(el.textContent).toContain('nur in der Desktop-App');
    expect(el.textContent).toContain('Marc Kronberg');
    await click('Lizenzen Dritter');
    expect(el.querySelector('.status')?.textContent).toBe(
      'Die Lizenztexte ließen sich nicht lesen.',
    );
  });
});
