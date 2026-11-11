import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFileDialogApi, FakeThemeApi } from '../../../testing/fake-apis';
import { ThemeApi } from '../../core/theme/theme-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { WindowApi } from '../../core/backend/window-api';
import { SettingsService } from '../../core/settings/settings.service';
import { Theme } from '../../core/theme/theme.models';
import { ThemeService } from '../../core/theme/theme.service';
import { ThemePickerComponent } from './theme-picker';

describe('ThemePickerComponent', () => {
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

  async function open(stored: Theme[] = []) {
    const themeApi = new FakeThemeApi();
    themeApi.stored = stored;
    const dialogs = new FakeFileDialogApi();
    TestBed.configureTestingModule({
      imports: [ThemePickerComponent],
      providers: [
        { provide: WindowApi, useValue: { setWindowChrome: vi.fn(() => Promise.resolve()) } },
        { provide: ThemeApi, useValue: themeApi },
        { provide: FileDialogApi, useValue: dialogs },
      ],
    });
    const theme = TestBed.inject(ThemeService);
    const settings = TestBed.inject(SettingsService);
    const fixture = TestBed.createComponent(ThemePickerComponent);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges();
    await fixture.whenStable();
    await theme.loadCatalog();
    await theme.loadUserThemes();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const key = (target: Element, k: string) => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      fixture.detectChanges();
    };
    return { fixture, theme, settings, el, closed, key, themeApi, dialogs };
  }

  it('shows all schemes, „System folgen“ chosen, and filters with a count', async () => {
    const { el, fixture } = await open();
    expect(el.querySelectorAll('.card').length).toBe(18);
    expect(el.querySelector('.card.chosen')?.getAttribute('data-id')).toBe('system');
    expect(el.querySelector('.count')?.textContent).toContain('17 von 17');
    const input = el.querySelector<HTMLInputElement>('#theme-filter')!;
    input.value = 'hell';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect([...el.querySelectorAll('.card')].map((c) => c.getAttribute('data-id'))).toEqual([
      'system',
      'light',
      'true-light',
      'solarized-light',
    ]);
    expect(el.querySelector('.count')?.textContent).toContain('3 von 17');
    expect(el.querySelector('.count')?.getAttribute('role')).toBe('status');
  });

  it('arrow keys preview a scheme, Enter keeps it', async () => {
    const { el, theme, settings, key, closed } = await open();
    const grid = el.querySelector('[role=listbox]')!;
    key(grid, 'ArrowRight');
    key(grid, 'ArrowRight');
    expect(theme.preview()?.id).toBe('one-dark');
    expect(grid.getAttribute('aria-activedescendant')).toBe('theme-option-one-dark');
    TestBed.tick();
    expect(document.documentElement.style.getPropertyValue('--bg-app')).not.toBe('');
    key(grid, 'Enter');
    expect(settings.settings().themeSelection).toMatchObject({ mode: 'fixed', theme: 'one-dark' });
    expect(theme.preview()).toBeNull();
    expect(closed).toHaveBeenCalled();
  });

  it('Esc goes back to the scheme from before', async () => {
    const { el, theme, settings, key } = await open();
    const grid = el.querySelector('[role=listbox]')!;
    key(grid, 'End');
    expect(theme.preview()?.id).toBe('solarized-light');
    el.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(theme.preview()).toBeNull();
    expect(settings.settings().themeSelection.mode).toBe('system');
    TestBed.tick();
    expect(document.documentElement.style.getPropertyValue('--bg-app')).toBe('');
  });

  it('offers the light and dark scheme of „System folgen“', async () => {
    const { el, theme, settings, fixture } = await open();
    const dark = el.querySelector<HTMLSelectElement>('#theme-pair-dark')!;
    expect(dark.options.length).toBe(14);
    dark.value = 'amber';
    dark.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(theme.preview()?.id).toBe('amber');
    el.querySelector<HTMLButtonElement>('button.primary')!.click();
    expect(settings.settings().themeSelection).toMatchObject({ mode: 'system', dark: 'amber' });
  });

  const OWN: Theme = {
    id: 'user-gruen',
    name: 'Grün',
    dark: true,
    tokens: { '--bg-app': '#001100' },
  };
  const button = (el: HTMLElement, text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes(text),
    )!;

  it('lists own schemes in a group of their own and edits only those', async () => {
    const { el, theme, fixture, closed } = await open([OWN]);
    expect(el.querySelector('[role="group"][aria-label="Eigene"] .card')?.textContent).toContain(
      'Grün',
    );
    expect(el.querySelector('.count')?.textContent).toContain('18 von 18');
    expect(button(el, 'Bearbeiten').disabled).toBe(true);
    el.querySelector<HTMLElement>('[data-id="user-gruen"]')!.click();
    fixture.detectChanges();
    expect(button(el, 'Bearbeiten').disabled).toBe(false);
    button(el, 'Bearbeiten').click();
    expect(theme.editing()).toEqual({ theme: OWN, dropped: [] });
    expect(closed).toHaveBeenCalled();
  });

  it('makes a new scheme from the chosen one', async () => {
    const { el, theme, fixture } = await open();
    el.querySelector<HTMLElement>('[data-id="one-dark"]')!.click();
    fixture.detectChanges();
    button(el, 'Neu aus gewähltem').click();
    const request = theme.editing();
    expect(request?.theme.id).toBe('');
    expect(request?.theme.name).toBe('One Dark (Kopie)');
    expect(request?.theme.tokens['--bg-app']).toBe('#282c34');
  });

  it('imports a file into the editor and says when it is no scheme', async () => {
    const { el, theme, themeApi, dialogs, fixture } = await open();
    dialogs.path = '/x/a.json';
    themeApi.files.set('/x/a.json', {
      name: 'Fremd',
      dark: false,
      tokens: { '--bg-app': '#fff', '--nope': '1' },
    });
    button(el, 'Importieren').click();
    await fixture.whenStable();
    expect(theme.editing()?.theme).toEqual({
      id: '',
      name: 'Fremd',
      dark: false,
      tokens: { '--bg-app': '#fff' },
    });
    expect(theme.editing()?.dropped).toEqual(['--nope']);
  });

  it('shows why an import failed', async () => {
    const { el, theme, themeApi, dialogs, fixture } = await open();
    dialogs.path = '/x/b.json';
    themeApi.files.set('/x/b.json', { hello: 1 });
    button(el, 'Importieren').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('kein Farbschema');
    dialogs.path = '/x/gone.json';
    button(el, 'Importieren').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Nicht gefunden');
    expect(theme.editing()).toBeNull();
  });
});
