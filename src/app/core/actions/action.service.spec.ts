import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from '../settings/settings.service';
import { ActionService } from './action.service';

describe('ActionService', () => {
  let actions: ActionService;
  let settings: SettingsService;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    settings = TestBed.inject(SettingsService);
    actions = TestBed.inject(ActionService);
    actions.platform.set('linux');
    await actions.load();
  });

  it('runs a registered action and forgets it when unregistered', () => {
    const run = vi.fn();
    const off = actions.register('TOGGLE_SIDEBAR', run);
    expect(actions.isRegistered('TOGGLE_SIDEBAR')).toBe(true);
    expect(actions.run('TOGGLE_SIDEBAR')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    off();
    expect(actions.run('TOGGLE_SIDEBAR')).toBe(false);
    expect(actions.isRegistered('TOGGLE_SIDEBAR')).toBe(false);
  });

  it('does not run a disabled action or anything while a shortcut is recorded', () => {
    const run = vi.fn();
    let on = false;
    actions.register('RUN_STATEMENT', run, () => on);
    expect(actions.canRun('RUN_STATEMENT')).toBe(false);
    expect(actions.run('RUN_STATEMENT')).toBe(false);
    on = true;
    actions.recording.set(true);
    expect(actions.run('RUN_STATEMENT')).toBe(false);
    actions.recording.set(false);
    expect(actions.run('RUN_STATEMENT')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('acts once when a key and the menu report the same press', () => {
    const run = vi.fn();
    actions.register('COLOR_SCHEME', run);
    expect(actions.run('COLOR_SCHEME', 'key')).toBe(true);
    expect(actions.run('COLOR_SCHEME', 'menu')).toBe(false);
    expect(actions.run('COLOR_SCHEME', 'key')).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reports a failing action, thrown or rejected', async () => {
    const report = vi.fn();
    actions.reportError = report;
    actions.register('TOGGLE_SIDEBAR', () => {
      throw new Error('boom');
    });
    actions.register('COLOR_SCHEME', () => Promise.reject(new Error('later')));
    actions.run('TOGGLE_SIDEBAR');
    actions.run('COLOR_SCHEME');
    await Promise.resolve();
    await Promise.resolve();
    expect(report.mock.calls.map((c) => c[0])).toEqual([
      'TOGGLE_SIDEBAR: boom',
      'COLOR_SCHEME: later',
    ]);
  });

  it('shows the shortcut of this system and follows the own keymap', () => {
    expect(actions.hint('TOGGLE_SIDEBAR')).toBe(' (Strg+B)');
    expect(actions.hint('EDIT_COLOR_SCHEME')).toBe('');
    actions.platform.set('macos');
    expect(actions.hint('TOGGLE_SIDEBAR')).toBe(' (⌘B)');
    actions.setOverride({ TOGGLE_SIDEBAR: ['Mod+Shift+B'] });
    expect(settings.settings().keymap.bindings).toEqual({ TOGGLE_SIDEBAR: ['Mod+Shift+B'] });
    expect(actions.shortcuts('TOGGLE_SIDEBAR')).toEqual(['Mod+Shift+B']);
  });

  it('acts on keys of the document once attached', () => {
    const run = vi.fn();
    actions.register('TOGGLE_SIDEBAR', run);
    const detach = actions.attach(document);
    const press = () =>
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, bubbles: true }),
      );
    press();
    expect(run).toHaveBeenCalledTimes(1);
    detach();
    press();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('has a notice for problems of the own shortcuts', () => {
    expect(actions.startNotice()).toBeNull();
    actions.setOverride({ TOGGLE_SIDEBAR: ['Mod+C'] });
    expect(actions.startNotice()).toContain('1 Hinweis');
  });
});
