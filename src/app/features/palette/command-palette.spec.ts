import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionService } from '../../core/actions/action.service';
import { SettingsService } from '../../core/settings/settings.service';
import { CommandPalette } from './command-palette';

describe('CommandPalette', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
    proto['showModal'] = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    proto['close'] = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  async function open() {
    TestBed.configureTestingModule({ imports: [CommandPalette] });
    const actions = TestBed.inject(ActionService);
    const settings = TestBed.inject(SettingsService);
    actions.platform.set('macos');
    await actions.load();
    const sidebar = vi.fn();
    const scheme = vi.fn();
    actions.register('TOGGLE_SIDEBAR', sidebar);
    actions.register('COLOR_SCHEME', scheme);
    actions.register('OPEN_PALETTE', vi.fn());
    const fixture = TestBed.createComponent(CommandPalette);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const field = el.querySelector<HTMLInputElement>('input')!;
    const type = (text: string) => {
      field.value = text;
      field.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    const key = (k: string) => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      fixture.detectChanges();
    };
    const labels = () => [...el.querySelectorAll('li .label')].map((l) => l.textContent?.trim());
    return { el, field, type, key, labels, sidebar, scheme, closed, settings };
  }

  it('lists the actions with their shortcuts, without itself, unregistered ones dimmed', async () => {
    const { el, labels } = await open();
    expect(labels()).toContain('Seitenleiste ein-/ausblenden');
    expect(labels()).not.toContain('Befehlspalette');
    const row = (text: string) =>
      [...el.querySelectorAll('li')].find((li) => li.textContent?.includes(text))!;
    expect(row('Seitenleiste').querySelector('kbd')?.textContent).toBe('⌘B');
    expect(row('Seitenleiste').classList.contains('off')).toBe(false);
    expect(row('In den Editor').getAttribute('aria-disabled')).toBe('true');
  });

  it('filters while typing, moves with the arrows and runs on Enter after closing', async () => {
    const { el, type, key, labels, scheme, closed, settings, field } = await open();
    type('farb');
    expect(labels()[0]).toBe('Farbschema wählen …');
    expect(el.querySelector('.hit')?.textContent).toBe('Farb');
    expect(field.getAttribute('aria-activedescendant')).toBe('palette-option-COLOR_SCHEME');
    key('ArrowDown');
    key('ArrowUp');
    key('Enter');
    expect(closed).toHaveBeenCalled();
    expect(scheme).toHaveBeenCalledTimes(1);
    expect(settings.settings().recentActions).toEqual(['COLOR_SCHEME']);
  });

  it('does not run a dimmed action and says when nothing matches', async () => {
    const { el, type, key, closed } = await open();
    type('in den editor');
    key('Enter');
    expect(closed).not.toHaveBeenCalled();
    type('zzzz');
    expect(el.querySelector('.status')?.textContent).toContain('Kein Befehl');
  });

  it('puts recently used actions first', async () => {
    const { labels, settings } = await open();
    settings.update({ recentActions: ['COLOR_SCHEME'] });
    TestBed.tick();
    expect(labels()[0]).toBe('Farbschema wählen …');
  });
});
