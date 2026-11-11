import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFileDialogApi, FakeThemeApi } from '../../../testing/fake-apis';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { WindowApi } from '../../core/backend/window-api';
import { ThemeApi } from '../../core/theme/theme-api';
import { Theme } from '../../core/theme/theme.models';
import { ThemeService } from '../../core/theme/theme.service';
import { ThemeEditor } from './theme-editor';

const OWN: Theme = {
  id: 'user-gruen',
  name: 'Grün',
  dark: true,
  tokens: { '--bg-app': '#001100' },
};

describe('ThemeEditor', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    document.documentElement.removeAttribute('style');
    (globalThis as unknown as { matchMedia: unknown }).matchMedia = () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
    proto['showModal'] = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    proto['close'] = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  async function open(theme: Theme, stored: Theme[] = [], dropped: string[] = []) {
    const themeApi = new FakeThemeApi();
    themeApi.stored = stored;
    const dialogs = new FakeFileDialogApi();
    TestBed.configureTestingModule({
      imports: [ThemeEditor],
      providers: [
        { provide: WindowApi, useValue: { setWindowChrome: vi.fn(() => Promise.resolve()) } },
        { provide: ThemeApi, useValue: themeApi },
        { provide: FileDialogApi, useValue: dialogs },
      ],
    });
    const service = TestBed.inject(ThemeService);
    await service.loadCatalog();
    await service.loadUserThemes();
    const fixture = TestBed.createComponent(ThemeEditor);
    fixture.componentRef.setInput('request', { theme, dropped });
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const type = (selector: string, value: string, event = 'input') => {
      const input = el.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event(event));
      fixture.detectChanges();
    };
    const click = async (text: string) => {
      const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;
      button.click();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const inline = (name: string) => document.documentElement.style.getPropertyValue(name);
    return { fixture, service, themeApi, dialogs, el, closed, type, click, inline };
  }

  const rowText = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll('.row')]
      .find((r) => r.querySelector('.label')?.textContent === label)!
      .querySelector<HTMLInputElement>('input[type="text"]')!;

  it('shows every token of the scheme and puts it on screen at once', async () => {
    const { el, inline } = await open(OWN, [OWN]);
    expect(el.querySelector<HTMLInputElement>('#theme-name')?.value).toBe('Grün');
    expect(el.querySelectorAll('.row').length).toBeGreaterThan(50);
    expect(rowText(el, 'Hintergrund (Editor, Ergebnis)').value).toBe('#001100');
    expect(inline('--bg-app')).toBe('#001100');
  });

  it('previews a typed colour, refuses nonsense and stores on save', async () => {
    const { el, service, themeApi, click, inline, fixture, closed } = await open(OWN, [OWN]);
    const field = rowText(el, 'Akzent');
    field.value = 'url(x)';
    field.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(field.classList.contains('invalid')).toBe(true);
    expect(inline('--accent')).toBe('');
    field.value = '#00ff00';
    field.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(field.classList.contains('invalid')).toBe(false);
    expect(inline('--accent')).toBe('#00ff00');
    await click('Speichern');
    expect(themeApi.stored).toEqual([
      { ...OWN, tokens: { '--bg-app': '#001100', '--accent': '#00ff00' } },
    ]);
    expect(service.selection()).toMatchObject({ mode: 'fixed', theme: 'user-gruen' });
    expect(closed).toHaveBeenCalled();
  });

  it('gives a new scheme an id of its own and wants a free name', async () => {
    const { el, themeApi, click, type } = await open({ ...OWN, id: '' }, [OWN]);
    expect(el.querySelector('#theme-name-error')?.textContent).toContain('gibt es schon');
    type('#theme-name', 'Grün zwei');
    await click('Speichern');
    expect(themeApi.stored.map((t) => t.id).sort()).toEqual(['user-gruen', 'user-grun-zwei']);
  });

  it('Abbrechen brings back what was on screen and stores nothing', async () => {
    const { themeApi, click, inline, closed } = await open(OWN, [OWN]);
    expect(inline('--bg-app')).toBe('#001100');
    await click('Abbrechen');
    expect(inline('--bg-app')).toBe('');
    expect(themeApi.stored).toEqual([OWN]);
    expect(closed).toHaveBeenCalled();
  });

  it('resets a token to the base and deletes only after asking again', async () => {
    const { el, themeApi, click, fixture } = await open(OWN, [OWN]);
    el.querySelector<HTMLButtonElement>(
      'button[aria-label="Hintergrund (Editor, Ergebnis) zurücksetzen"]',
    )!.click();
    fixture.detectChanges();
    expect(rowText(el, 'Hintergrund (Editor, Ergebnis)').value).toBe('#14171c');
    await click('Löschen');
    expect(themeApi.stored).toEqual([OWN]);
    await click('Wirklich löschen?');
    expect(themeApi.stored).toEqual([]);
  });

  it('exports to the chosen path, says what an import dropped, shows a failed save', async () => {
    const { el, themeApi, dialogs, click } = await open(OWN, [OWN], ['--foo', '--bar']);
    expect(el.querySelector('.note')?.textContent).toContain('2 Einträge');
    dialogs.path = '/tmp/x.theme.json';
    await click('Exportieren');
    expect(dialogs.asked).toEqual(['Farbschema exportieren: Grün.theme.json']);
    expect(themeApi.exported).toEqual([{ path: '/tmp/x.theme.json', theme: OWN }]);
    themeApi.failSave = { code: 'too_large', message: 'too much to store' };
    await click('Speichern');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('zu groß');
  });

  it('warns about weak contrast in words', async () => {
    const { el, fixture } = await open(OWN, [OWN]);
    expect(el.querySelector('.summary')?.textContent).toContain('erfüllen WCAG AA');
    const field = rowText(el, 'Text');
    field.value = '#222222';
    field.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(el.querySelector('.summary')?.textContent).toContain('unter WCAG AA');
    expect(el.querySelector('.contrast.weak')?.textContent).toContain('⚠');
  });
});
