import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeFileDialogApi, FakeSessionApi } from '../../../testing/fake-apis';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { language } from '../../core/i18n/i18n';
import { SessionApi } from '../../core/session/session-api';
import { SettingsService } from '../../core/settings/settings.service';
import { ConfirmService } from '../../shared/confirm';
import { SettingsDialog } from './settings-dialog';

describe('SettingsDialog', () => {
  let files: FakeFileDialogApi;
  let session: FakeSessionApi;

  beforeEach(() => {
    TestBed.resetTestingModule();
    files = new FakeFileDialogApi();
    session = new FakeSessionApi();
    // jsdom has no modal dialogs
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
    TestBed.configureTestingModule({
      imports: [SettingsDialog],
      providers: [
        { provide: FileDialogApi, useValue: files },
        { provide: SessionApi, useValue: session },
      ],
    });
  });

  async function open() {
    const fixture = TestBed.createComponent(SettingsDialog);
    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
    };
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    const settings = TestBed.inject(SettingsService);
    const tabs = () => [...el.querySelectorAll<HTMLElement>('[role=tab]')];
    const labels = () =>
      [...el.querySelectorAll<HTMLElement>('.row .label')].map((l) =>
        l.textContent!.replace(/\s+/g, ' ').trim(),
      );
    const control = <T extends HTMLElement>(key: string) => el.querySelector<T>(`#setting-${key}`)!;
    const change = async (field: HTMLElement) => {
      field.dispatchEvent(new Event('change'));
      await settle();
    };
    return { fixture, el, settings, tabs, labels, control, change, settle };
  }

  it('shows the groups as a vertical tab list and moves through them with the arrows', async () => {
    const { el, tabs, labels, settle } = await open();
    expect(el.querySelector('[role=tablist]')?.getAttribute('aria-orientation')).toBe('vertical');
    expect(tabs().map((t) => t.textContent?.trim())).toEqual([
      'Allgemein',
      'Editor',
      'Ergebnis',
      'Ausführen',
      'Verlauf',
      'Sicherheit',
    ]);
    // one stop in the tab order
    expect(tabs().filter((t) => t.tabIndex === 0).length).toBe(1);
    expect(labels()).toContain('Sprache');
    tabs()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
    expect(labels()).toContain('Tab-Breite');
    tabs()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await settle();
    expect(tabs()[5].getAttribute('aria-selected')).toBe('true');
    tabs()[5].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
  });

  it('applies a change at once and resets a single value', async () => {
    const { el, settings, tabs, control, change, settle } = await open();
    tabs()[1].click();
    await settle();
    const size = control<HTMLInputElement>('editorFontSize');
    size.value = '18';
    await change(size);
    expect(settings.settings().editorFontSize).toBe(18);
    // out of bounds: the nearest allowed value, and the field shows it
    size.value = '400';
    await change(size);
    expect(settings.settings().editorFontSize).toBe(40);
    expect(size.value).toBe('40');
    const wrap = control<HTMLInputElement>('editorWordWrap');
    wrap.checked = true;
    await change(wrap);
    expect(settings.settings().editorWordWrap).toBe(true);
    const row = size.closest('.row')!;
    expect(row.classList.contains('changed')).toBe(true);
    const reset = row.querySelector<HTMLButtonElement>('.reset')!;
    expect(reset.getAttribute('aria-label')).toBe(
      '„Schriftgröße (px)“ auf die Vorgabe zurücksetzen',
    );
    reset.click();
    await settle();
    expect(settings.settings().editorFontSize).toBe(14);
    expect(settings.settings().editorWordWrap).toBe(true);
    expect(el.querySelectorAll('.row.changed').length).toBe(1);
  });

  it('changes the language of its own texts while it is open', async () => {
    const { el, control, change, tabs } = await open();
    const select = control<HTMLSelectElement>('language');
    select.value = 'en';
    await change(select);
    TestBed.tick();
    expect(language()).toBe('en');
    expect(el.querySelector('h2')?.textContent).toBe('Settings');
    expect(tabs()[0].textContent?.trim()).toBe('General');
    select.value = 'de';
    await change(select);
    TestBed.tick();
    expect(el.querySelector('h2')?.textContent).toBe('Einstellungen');
  });

  it('searches over all groups and says where a setting lives', async () => {
    const { el, labels, tabs, settle } = await open();
    const search = el.querySelector<HTMLInputElement>('input[type=search]')!;
    search.value = 'schriftgröße';
    search.dispatchEvent(new Event('input'));
    await settle();
    expect(labels()).toEqual(['Editor Schriftgröße (px)', 'Ergebnis Schriftgröße (px)']);
    expect(el.querySelector('.found')?.textContent).toContain('2 Einstellungen gefunden');
    expect(tabs().every((t) => t.getAttribute('aria-selected') === 'false')).toBe(true);
    search.value = 'gibt es nicht';
    search.dispatchEvent(new Event('input'));
    await settle();
    expect(el.querySelector('.found')?.textContent).toContain('Keine Einstellung passt.');
    // a group ends the search
    tabs()[2].click();
    await settle();
    expect(search.value).toBe('');
    expect(labels()).toContain('Zeilenhöhe (px)');
  });

  it('resets everything only after a question', async () => {
    const { el, settings, settle } = await open();
    settings.update({ editorFontSize: 20, stopOnError: false, sidebarWidth: 300 });
    const confirm = TestBed.inject(ConfirmService);
    const button = [...el.querySelectorAll<HTMLButtonElement>('footer button')][0];
    button.click();
    await settle();
    expect(confirm.request()?.title).toBe('Alle Einstellungen zurücksetzen');
    confirm.answer(false);
    await settle();
    expect(settings.settings().editorFontSize).toBe(20);
    button.click();
    await settle();
    confirm.answer(true);
    await settle();
    expect(settings.settings()).toMatchObject({
      editorFontSize: 14,
      stopOnError: true,
      sidebarWidth: 300,
    });
  });

  it('writes the settings to a file and reads them back', async () => {
    const { el, settings, settle } = await open();
    settings.update({ editorTabWidth: 2 });
    files.path = '/tmp/s.json';
    const [, exportButton, importButton] = [
      ...el.querySelectorAll<HTMLButtonElement>('footer button'),
    ];
    exportButton.click();
    await settle();
    expect(JSON.parse(session.disk.get('/tmp/s.json')!.text).settings.editorTabWidth).toBe(2);
    expect(el.querySelector('.message')?.textContent).toContain('keine Passwörter');
    settings.update({ editorTabWidth: 8 });
    importButton.click();
    await settle();
    expect(settings.settings().editorTabWidth).toBe(2);
    // a file that is something else changes nothing and says so
    session.disk.set('/tmp/s.json', { text: '{"hello":1}', encoding: 'utf-8' });
    importButton.click();
    await settle();
    expect(el.querySelector('.message.problem')?.textContent).toContain('kein Einstellungs-Export');
    expect(settings.settings().editorTabWidth).toBe(2);
  });
});
