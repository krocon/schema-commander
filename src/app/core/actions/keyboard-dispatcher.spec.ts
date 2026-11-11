import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionId } from './action-catalog';
import {
  CHORD_TIMEOUT_MS,
  DispatchEvent,
  DispatchHost,
  KeyboardDispatcher,
  placeOf,
} from './keyboard-dispatcher';
import { RawBindings, resolveKeymap } from './keymap';

function host(override: RawBindings = {}, off: ActionId[] = []) {
  const ran: ActionId[] = [];
  const h: DispatchHost & { ran: ActionId[]; rec: boolean } = {
    ran,
    rec: false,
    recording: () => h.rec,
    platform: () => 'linux',
    keymap: () => resolveKeymap('linux', override),
    canRun: (id) => !off.includes(id),
    run: (id) => {
      ran.push(id);
      return true;
    },
  };
  return h;
}

function el(html: string, selector: string): Element {
  document.body.innerHTML = html;
  return document.querySelector(selector)!;
}

function key(
  k: string,
  code: string,
  target: EventTarget | null,
  mods: Partial<Pick<DispatchEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'repeat'>> = {},
) {
  const evt = {
    key: k,
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...mods,
  };
  return evt as typeof evt & DispatchEvent;
}

describe('placeOf', () => {
  it('knows where the focus is', () => {
    expect(placeOf(null)).toBe('view');
    expect(placeOf(el('<main><p>x</p></main>', 'p'))).toBe('view');
    expect(placeOf(el('<dialog><input /></dialog>', 'input'))).toBe('dialog');
    expect(placeOf(el('<input type="text" />', 'input'))).toBe('input');
    expect(placeOf(el('<input type="checkbox" />', 'input'))).toBe('control');
    expect(placeOf(el('<editlicious-editor></editlicious-editor>', 'editlicious-editor'))).toBe(
      'input',
    );
    expect(placeOf(el('<div role="menu"><button>x</button></div>', 'button'))).toBe('menu');
    expect(placeOf(el('<div class="ge-table"><div>x</div></div>', '.ge-table div'))).toBe('widget');
    expect(placeOf(el('<button>x</button>', 'button'))).toBe('control');
  });
});

describe('KeyboardDispatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs a global action with a modifier everywhere but in dialogs', () => {
    const h = host();
    const d = new KeyboardDispatcher(h);
    const editor = el('<editlicious-editor></editlicious-editor>', 'editlicious-editor');
    const evt = key('Enter', 'Enter', editor, { ctrlKey: true });
    expect(d.handle(evt)).toBe('RUN_STATEMENT');
    expect(evt.preventDefault).toHaveBeenCalled();
    expect(evt.stopPropagation).toHaveBeenCalled();
    const inDialog = el('<dialog><input /></dialog>', 'input');
    expect(d.handle(key('Enter', 'Enter', inDialog, { ctrlKey: true }))).toBeNull();
    expect(h.ran).toEqual(['RUN_STATEMENT']);
  });

  it('keeps plain keys for typing: a view action stays out of fields, editor and widgets', () => {
    const h = host();
    const d = new KeyboardDispatcher(h);
    const q = (target: Element) => key('?', 'Slash', target, { shiftKey: true });
    expect(d.handle(q(el('<main><p>x</p></main>', 'p')))).toBe('SHOW_SHORTCUTS');
    for (const html of [
      '<input type="text" class="t" />',
      '<editlicious-editor class="t"></editlicious-editor>',
      '<div class="ge-table"><div class="t">x</div></div>',
      '<textarea class="t"></textarea>',
    ]) {
      const evt = q(el(html, '.t'));
      expect(d.handle(evt), html).toBeNull();
      expect(evt.preventDefault, html).not.toHaveBeenCalled();
    }
  });

  it('does not take AltGr characters of a German keyboard', () => {
    const h = host({ TOGGLE_SIDEBAR: ['Ctrl+Alt+Q'] });
    const d = new KeyboardDispatcher(h);
    const editor = el('<editlicious-editor></editlicious-editor>', 'editlicious-editor');
    // AltGr+Q types `@` on Windows/Linux: reported as Ctrl+Alt with key `@`
    const evt = key('@', 'KeyQ', editor, { ctrlKey: true, altKey: true });
    expect(d.handle(evt)).toBeNull();
    expect(evt.preventDefault).not.toHaveBeenCalled();
    for (const [k, code] of [
      ['{', 'Digit7'],
      ['\\', 'Minus'],
      ['€', 'KeyE'],
    ]) {
      expect(d.handle(key(k, code, editor, { ctrlKey: true, altKey: true })), k).toBeNull();
    }
    // the browser may name AltGr itself, whatever the key says
    const named = {
      ...key('q', 'KeyQ', editor, { ctrlKey: true, altKey: true }),
      getModifierState: (m: string) => m === 'AltGraph',
    };
    expect(d.handle(named)).toBeNull();
    // a real Ctrl+Alt+Q still acts, and outside of text fields nothing is typed anyway
    expect(d.handle(key('q', 'KeyQ', editor, { ctrlKey: true, altKey: true }))).toBe(
      'TOGGLE_SIDEBAR',
    );
    const body = el('<main><p>x</p></main>', 'p');
    expect(d.handle(key('@', 'KeyQ', body, { ctrlKey: true, altKey: true }))).toBe(
      'TOGGLE_SIDEBAR',
    );
  });

  it('leaves Space and Enter to a focused button', () => {
    const h = host({ SHOW_SHORTCUTS: ['Space'] });
    const d = new KeyboardDispatcher(h);
    expect(d.handle(key(' ', 'Space', el('<button>x</button>', 'button')))).toBeNull();
    expect(d.handle(key(' ', 'Space', el('<main><p>x</p></main>', 'p')))).toBe('SHOW_SHORTCUTS');
  });

  it('waits for the second stroke of a chord, for a while', () => {
    const h = host();
    const d = new KeyboardDispatcher(h);
    const body = el('<main><p>x</p></main>', 'p');
    const first = key('k', 'KeyK', body, { ctrlKey: true });
    expect(d.handle(first)).toBeNull();
    expect(first.preventDefault).toHaveBeenCalled();
    expect(d.handle(key('s', 'KeyS', body, { ctrlKey: true }))).toBe('OPEN_SHORTCUTS');
    // too late: the chord is forgotten, Ctrl+S alone is nothing
    d.handle(key('k', 'KeyK', body, { ctrlKey: true }));
    vi.advanceTimersByTime(CHORD_TIMEOUT_MS + 1);
    expect(d.handle(key('s', 'KeyS', body, { ctrlKey: true }))).toBeNull();
    expect(h.ran).toEqual(['OPEN_SHORTCUTS']);
  });

  it('passes a key on when its action cannot run, and repeats only what may repeat', () => {
    const h = host({}, ['TOGGLE_SIDEBAR']);
    const d = new KeyboardDispatcher(h);
    const body = el('<main><p>x</p></main>', 'p');
    const off = key('b', 'KeyB', body, { ctrlKey: true });
    expect(d.handle(off)).toBeNull();
    expect(off.preventDefault).not.toHaveBeenCalled();
    expect(d.handle(key('F6', 'F6', body, { repeat: true }))).toBe('FOCUS_NEXT_AREA');
    const held = key('Enter', 'Enter', body, { ctrlKey: true, repeat: true });
    expect(d.handle(held)).toBeNull();
    // swallowed all the same: a held Mod+Enter must not type line breaks
    expect(held.preventDefault).toHaveBeenCalled();
  });

  it('does nothing while a shortcut is recorded or a text is composed', () => {
    const h = host();
    const d = new KeyboardDispatcher(h);
    const body = el('<main><p>x</p></main>', 'p');
    h.rec = true;
    expect(d.handle(key('b', 'KeyB', body, { ctrlKey: true }))).toBeNull();
    h.rec = false;
    expect(
      d.handle({ ...key('b', 'KeyB', body, { ctrlKey: true }), isComposing: true }),
    ).toBeNull();
    expect(h.ran).toEqual([]);
  });
});
