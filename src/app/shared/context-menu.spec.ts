import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ContextMenu,
  MenuCloseReason,
  MenuItem,
  isTypeahead,
  menuPosition,
  typeaheadIndex,
} from './context-menu';

const ITEMS: MenuItem[] = [
  { id: 'copy', label: 'Kopieren', shortcut: 'Ctrl+C' },
  {
    id: 'as',
    label: 'Kopieren als',
    children: [
      { id: 'csv', label: 'CSV' },
      { id: 'json', label: 'JSON' },
    ],
  },
  { id: '-1', label: '', separator: true },
  { id: 'export', label: 'Exportieren …', disabled: true },
  { id: 'digits', label: 'Tausendertrennung', checked: true },
  // the older form: a line above an entry
  { id: 'max', label: 'Maximieren', separator: true, checked: false },
];

@Component({
  imports: [ContextMenu],
  template: `
    <app-context-menu
      [items]="items()"
      [x]="10"
      [y]="10"
      label="Ergebnis"
      (picked)="picked.push($event)"
      (closed)="closed.push($event)"
    />
  `,
})
class Host {
  readonly items = signal<readonly MenuItem[]>(ITEMS);
  readonly picked: string[] = [];
  readonly closed: MenuCloseReason[] = [];
}

describe('ContextMenu', () => {
  beforeEach(() => TestBed.resetTestingModule());

  async function open() {
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
    };
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    const menu = () => el.querySelector<HTMLElement>('app-context-menu > .menu')!;
    const entries = () => [...menu().querySelectorAll<HTMLElement>('[role^=menuitem]')];
    const focused = () => (document.activeElement as HTMLElement | null)?.dataset['id'];
    const key = async (k: string) => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
      );
      await settle();
    };
    return { fixture, host: fixture.componentInstance, el, menu, entries, focused, key, settle };
  }

  it('is a menu with entries, lines, switches and shortcuts', async () => {
    const { menu, entries } = await open();
    expect(menu().getAttribute('role')).toBe('menu');
    expect(menu().getAttribute('aria-label')).toBe('Ergebnis');
    expect(entries().map((e) => e.getAttribute('role'))).toEqual([
      'menuitem',
      'menuitem',
      'menuitem',
      'menuitemcheckbox',
      'menuitemcheckbox',
    ]);
    expect(menu().querySelectorAll('[role=separator]').length).toBe(2);
    expect(entries()[0].querySelector('kbd')?.textContent).toBe('Ctrl+C');
    expect(entries()[1].getAttribute('aria-haspopup')).toBe('menu');
    expect(entries()[2].getAttribute('aria-disabled')).toBe('true');
    expect(entries()[3].getAttribute('aria-checked')).toBe('true');
    expect(entries()[4].getAttribute('aria-checked')).toBe('false');
  });

  it('moves with the arrows, Home, End and letters – over grey entries too', async () => {
    const { focused, key } = await open();
    // the first entry that can be chosen has the focus
    expect(focused()).toBe('copy');
    await key('ArrowDown');
    await key('ArrowDown');
    expect(focused()).toBe('export');
    await key('End');
    expect(focused()).toBe('max');
    await key('ArrowDown');
    expect(focused()).toBe('copy');
    await key('ArrowUp');
    expect(focused()).toBe('max');
    await key('Home');
    await key('t');
    expect(focused()).toBe('digits');
    // the next entry with that letter, around the end
    await key('k');
    expect(focused()).toBe('copy');
    await key('k');
    expect(focused()).toBe('as');
  });

  it('chooses with Enter and Space, never a grey entry', async () => {
    const { host, key } = await open();
    await key('Enter');
    expect(host.picked).toEqual(['copy']);
    await key('ArrowDown');
    await key('ArrowDown');
    await key('Enter');
    await key(' ');
    expect(host.picked).toEqual(['copy']);
    await key('ArrowDown');
    await key(' ');
    expect(host.picked).toEqual(['copy', 'digits']);
  });

  it('opens a submenu with the right arrow and leaves it with the left one or Escape', async () => {
    const { el, host, entries, focused, key } = await open();
    await key('ArrowDown');
    await key('ArrowRight');
    const sub = () => el.querySelector<HTMLElement>('app-context-menu app-context-menu .menu');
    expect(sub()?.getAttribute('aria-label')).toBe('Kopieren als');
    expect(entries()[1].getAttribute('aria-expanded')).toBe('true');
    expect(focused()).toBe('csv');
    await key('ArrowDown');
    expect(focused()).toBe('json');
    await key('ArrowLeft');
    expect(sub()).toBeNull();
    expect(focused()).toBe('as');
    await key('Enter');
    expect(focused()).toBe('csv');
    await key('Escape');
    expect(sub()).toBeNull();
    expect(host.closed).toEqual([]);
    // an entry of a submenu is picked like any other
    await key('ArrowRight');
    await key('ArrowDown');
    await key('Enter');
    expect(host.picked).toEqual(['json']);
  });

  it('closes with Escape, Tab and a press outside, and says how', async () => {
    const { host, key, menu } = await open();
    await key('Escape');
    await key('Tab');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(host.closed).toEqual(['key', 'tab', 'outside']);
    // a press inside is none
    menu().dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(host.closed.length).toBe(3);
  });

  it('keeps a menu inside the window and finds entries by their first letter', () => {
    expect(menuPosition(790, 590, 200, 100, 800, 600)).toEqual({ left: 596, top: 496 });
    expect(menuPosition(-5, 2, 200, 100, 800, 600)).toEqual({ left: 4, top: 4 });
    expect(typeaheadIndex(['Alpha', 'beta', 'Aal'], 0, 'a')).toBe(2);
    expect(typeaheadIndex(['Alpha', 'beta'], 0, 'x')).toBe(-1);
    const event = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
    expect(isTypeahead(event({ key: 'a' }))).toBe(true);
    expect(isTypeahead(event({ key: 'a', ctrlKey: true }))).toBe(false);
    expect(isTypeahead(event({ key: ' ' }))).toBe(false);
    expect(isTypeahead(event({ key: 'Enter' }))).toBe(false);
  });
});
