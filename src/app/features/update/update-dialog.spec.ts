import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { UpdateApi } from '../../core/update/update-api';
import { FakeUpdateApi } from '../../../testing/fake-apis';
import { UpdateDialog } from './update-dialog';
import { UpdateService } from './update.service';

describe('UpdateDialog', () => {
  let api: FakeUpdateApi;
  let updates: UpdateService;

  beforeEach(() => {
    // jsdom has no modal dialogs
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    TestBed.resetTestingModule();
    api = new FakeUpdateApi();
    TestBed.configureTestingModule({ providers: [{ provide: UpdateApi, useValue: api }] });
    updates = TestBed.inject(UpdateService);
  });

  async function open() {
    const fixture = TestBed.createComponent(UpdateDialog);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const buttons = () => [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());
    const click = async (text: string) => {
      const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
      expect(button, text).toBeDefined();
      button?.click();
      await fixture.whenStable();
    };
    return { fixture, el, buttons, click };
  }

  it('shows the newer version, its day and its notes as text', async () => {
    await updates.checkNow();
    const { el, buttons } = await open();
    expect(el.querySelector('.newer')?.textContent).toBe(
      'Version 1.3.0 ist verfügbar. Installiert ist 1.2.3.',
    );
    expect(el.textContent).toContain('Veröffentlicht am 2026-11-14');
    const notes = el.querySelector('pre');
    expect(notes?.textContent).toBe('What is new\n<b>not markup</b>');
    expect(notes?.querySelector('b')).toBeNull();
    expect(buttons()).toEqual(['Diese Version überspringen', 'Download-Seite öffnen', 'Schließen']);
  });

  it('opens the page of the release', async () => {
    await updates.checkNow();
    const { click } = await open();
    await click('Download-Seite öffnen');
    expect(api.opened).toEqual(['1.3.0']);
  });

  it('says when this is the latest version, and offers to ask again', async () => {
    api.info = { ...api.info, latest: '1.2.3', newer: false };
    await updates.checkNow();
    const { el, buttons, click } = await open();
    expect(el.querySelector('.said')?.textContent).toContain(
      'Schema Commander 1.2.3 ist die neueste Version.',
    );
    expect(el.querySelector('pre')).toBeNull();
    expect(buttons()).toEqual(['Erneut suchen', 'Schließen']);
    await click('Erneut suchen');
    expect(api.checks).toBe(2);
  });

  it('tells a failure in words and what the check sends', async () => {
    api.fail = { code: 'connection_failed', message: 'github.com: no route' };
    await updates.checkNow();
    const { el } = await open();
    expect(el.querySelector('.failed')?.textContent).toBe(
      'Die Suche nach Updates ist nicht gelungen.',
    );
    expect(el.textContent).toContain('github.com: no route');
    expect(el.querySelector('.privacy')?.textContent).toContain('Nichts über Sie');
  });

  it('closes with its button', async () => {
    await updates.checkNow();
    const { click } = await open();
    await click('Schließen');
    expect(updates.open()).toBe(false);
  });
});
