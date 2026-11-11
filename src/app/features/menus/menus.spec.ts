import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionService } from '../../core/actions/action.service';
import { MenuApi } from '../../core/menu/menu-api';
import { MenuItemState, NativeMenuEvent, NativeMenuSpec } from '../../core/menu/menu.models';
import { MenuBar } from './menu-bar';
import { TAB_MENU } from './menu-model';
import { MenuService, NATIVE_DEBOUNCE_MS } from './menu.service';

class FakeMenuApi extends MenuApi {
  native = true;
  refuse: unknown = null;
  readonly specs: NativeMenuSpec[] = [];
  readonly states: MenuItemState[][] = [];
  emit: (event: NativeMenuEvent) => void = () => undefined;

  setAppMenu(spec: NativeMenuSpec): Promise<boolean> {
    this.specs.push(spec);
    return this.refuse ? Promise.reject(this.refuse) : Promise.resolve(this.native);
  }
  setMenuState(items: readonly MenuItemState[]): Promise<void> {
    this.states.push([...items]);
    return Promise.resolve();
  }
  subscribe(onEvent: (event: NativeMenuEvent) => void): Promise<void> {
    this.emit = onEvent;
    return Promise.resolve();
  }
}

describe('MenuService', () => {
  let api: FakeMenuApi;
  let actions: ActionService;
  let menus: MenuService;

  beforeEach(async () => {
    vi.useFakeTimers();
    TestBed.resetTestingModule();
    api = new FakeMenuApi();
    TestBed.configureTestingModule({ providers: [{ provide: MenuApi, useValue: api }] });
    actions = TestBed.inject(ActionService);
    actions.platform.set('macos');
    await actions.load();
    menus = TestBed.inject(MenuService);
  });

  afterEach(() => vi.useRealTimers());

  const settle = async (ms = NATIVE_DEBOUNCE_MS + 10) => {
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(ms);
    TestBed.tick();
  };

  it('installs the native menu once and afterwards only switches its items', async () => {
    const on = { value: false };
    // a rule that reads no signal is seen when the handlers change
    actions.register(
      'TX_COMMIT',
      () => undefined,
      () => on.value,
    );
    menus.init();
    await settle(1);
    expect(api.specs.length).toBe(1);
    expect(menus.mode()).toBe('native');
    on.value = true;
    actions.registerCheck('TOGGLE_RESULT', () => true);
    await settle();
    // the tick made TOGGLE_RESULT a check item: another structure, one rebuild
    expect(api.specs.length).toBe(2);
    actions.register('NEW_TAB', () => undefined);
    await settle();
    expect(api.specs.length).toBe(2);
    expect(api.states.at(-1)).toEqual([{ id: 'NEW_TAB', enabled: true, checked: null }]);
  });

  it('runs the action of a chosen native item, once per key press', async () => {
    const run = vi.fn();
    actions.register('NEW_TAB', run);
    menus.init();
    await settle(1);
    api.emit({ id: 'NEW_TAB' });
    expect(run).toHaveBeenCalledTimes(1);
    // the key ran the action, the accelerator of the menu reports the same press
    vi.setSystemTime(Date.now() + 5000);
    actions.run('NEW_TAB', 'key');
    api.emit({ id: 'NEW_TAB' });
    expect(run).toHaveBeenCalledTimes(2);
    // an id that is no action does nothing
    api.emit({ id: 'rm -rf' });
    // while a dialog is open the menu waits, like the keys
    menus.dialogOpen.set(true);
    vi.setSystemTime(Date.now() + 5000);
    api.emit({ id: 'NEW_TAB' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('draws the menu bar itself where there is no native one, and says when the backend refuses', async () => {
    api.native = false;
    menus.init();
    await settle(1);
    expect(menus.mode()).toBe('html');
    expect(menus.menuBar().map((m) => m.id)).toContain('file');
    // nothing more is sent
    actions.register('NEW_TAB', () => undefined);
    await settle();
    expect(api.specs.length).toBe(1);
  });

  it('reports a refused menu and falls back to its own bar', async () => {
    const reported: string[] = [];
    actions.reportError = (m) => reported.push(m);
    api.refuse = { code: 'unsupported', message: 'more than 600 menu entries' };
    menus.init();
    await settle(1);
    expect(menus.mode()).toBe('html');
    expect(reported[0]).toContain('Die Menüleiste ließ sich nicht aufbauen');
  });

  it('opens a context menu of actions and gives the focus back before the action runs', async () => {
    const order: string[] = [];
    actions.register('DUPLICATE_TAB', () => void order.push('run'));
    menus.openContext(TAB_MENU, 5, 6, () => order.push('focus'), 'Tab');
    expect(menus.context()).toMatchObject({ x: 5, y: 6, label: 'Tab' });
    const item = menus.context()!.items.find((i) => i.id === 'DUPLICATE_TAB');
    expect(item).toMatchObject({ label: 'Tab duplizieren', disabled: false });
    menus.choose('DUPLICATE_TAB');
    expect(menus.context()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['focus', 'run']);
    // Escape gives the focus back, a press elsewhere leaves it where it went
    menus.openContext(TAB_MENU, 0, 0, () => order.push('back'));
    menus.close('key');
    menus.openContext(TAB_MENU, 0, 0, () => order.push('never'));
    menus.close('outside');
    expect(order).toEqual(['focus', 'run', 'back']);
  });
});

describe('MenuBar', () => {
  beforeEach(() => TestBed.resetTestingModule());

  async function open() {
    const api = new FakeMenuApi();
    api.native = false;
    TestBed.configureTestingModule({
      imports: [MenuBar],
      providers: [{ provide: MenuApi, useValue: api }],
    });
    const actions = TestBed.inject(ActionService);
    actions.platform.set('linux');
    await actions.load();
    const ran: string[] = [];
    actions.register('NEW_TAB', () => void ran.push('NEW_TAB'));
    const menus = TestBed.inject(MenuService);
    menus.init();
    const fixture = TestBed.createComponent(MenuBar);
    document.body.appendChild(fixture.nativeElement);
    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 5));
      fixture.detectChanges();
    };
    await settle();
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    const tops = () => [...el.querySelectorAll<HTMLElement>('.top')];
    const key = async (k: string) => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
      );
      await settle();
    };
    return { el, tops, key, settle, ran, menus };
  }

  it('is a menu bar with one stop in the tab order', async () => {
    const { el, tops } = await open();
    expect(el.querySelector('[role=menubar]')?.getAttribute('aria-label')).toBe('Menüleiste');
    expect(tops().map((t) => t.textContent?.trim())).toEqual([
      'Datei',
      'Bearbeiten',
      'Ansicht',
      'Abfrage',
      'Verbindung',
      'Werkzeuge',
      'Hilfe',
    ]);
    expect(tops().filter((t) => t.tabIndex === 0).length).toBe(1);
  });

  it('is worked with the keyboard: arrows, letters, open, choose, Escape', async () => {
    const { el, tops, key, ran } = await open();
    tops()[0].focus();
    await key('ArrowRight');
    expect(document.activeElement).toBe(tops()[1]);
    await key('End');
    expect(document.activeElement).toBe(tops()[6]);
    await key('ArrowRight');
    expect(document.activeElement).toBe(tops()[0]);
    await key('v');
    expect(document.activeElement).toBe(tops()[4]);
    await key('Home');
    await key('ArrowDown');
    const menu = () => el.querySelector<HTMLElement>('app-context-menu .menu');
    expect(menu()?.getAttribute('aria-label')).toBe('Datei');
    expect(tops()[0].getAttribute('aria-expanded')).toBe('true');
    expect((document.activeElement as HTMLElement).dataset['id']).toBe('NEW_TAB');
    // the neighbour opens with the arrows while a menu is open
    await key('ArrowLeft');
    expect(menu()?.getAttribute('aria-label')).toBe('Hilfe');
    await key('ArrowRight');
    expect(menu()?.getAttribute('aria-label')).toBe('Datei');
    await key('Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(tops()[0]);
    await key('Enter');
    await key('Enter');
    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toEqual(['NEW_TAB']);
    expect(menu()).toBeNull();
  });

  it('steps back while a dialog is open', async () => {
    const { el, menus, settle } = await open();
    menus.dialogOpen.set(true);
    await settle();
    expect(el.querySelector('[role=menubar]')?.hasAttribute('inert')).toBe(true);
  });
});
