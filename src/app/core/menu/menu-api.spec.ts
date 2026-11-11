import { describe, expect, it } from 'vitest';
import { TauriMenuApi } from './menu-api';

describe('TauriMenuApi without a backend (browser, tests)', () => {
  it('rejects instead of throwing, so the start of the window goes on', async () => {
    const api = new TauriMenuApi();
    // a channel cannot even be made without Tauri: that must not surface as an exception
    let promise: Promise<void> | undefined;
    expect(() => (promise = api.subscribe(() => undefined))).not.toThrow();
    await expect(promise).rejects.toMatchObject({ code: 'backend_unavailable' });
    await expect(api.setAppMenu({ menus: [] })).rejects.toMatchObject({
      code: 'backend_unavailable',
    });
    await expect(api.setMenuState([])).rejects.toMatchObject({ code: 'backend_unavailable' });
  });
});
