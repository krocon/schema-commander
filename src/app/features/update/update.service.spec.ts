import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsService } from '../../core/settings/settings.service';
import { UpdateApi } from '../../core/update/update-api';
import { FakeUpdateApi } from '../../../testing/fake-apis';
import { CHECK_INTERVAL_MS } from './update-logic';
import { UpdateService } from './update.service';

describe('UpdateService', () => {
  let api: FakeUpdateApi;
  let settings: SettingsService;
  let updates: UpdateService;
  const now = 1_800_000_000_000;

  beforeEach(() => {
    TestBed.resetTestingModule();
    api = new FakeUpdateApi();
    TestBed.configureTestingModule({ providers: [{ provide: UpdateApi, useValue: api }] });
    settings = TestBed.inject(SettingsService);
    updates = TestBed.inject(UpdateService);
  });

  it('asks at the start, offers the newer version and notes when it asked', async () => {
    await updates.checkAtStart(now);
    expect(api.checks).toBe(1);
    expect(updates.offer()).toBe('1.3.0');
    expect(updates.open()).toBe(false);
    expect(settings.settings().updateLastCheck).toBe(now);
    // not again within a day
    await updates.checkAtStart(now + CHECK_INTERVAL_MS - 1);
    expect(api.checks).toBe(1);
    await updates.checkAtStart(now + CHECK_INTERVAL_MS);
    expect(api.checks).toBe(2);
  });

  it('does not ask at the start when the user turned it off', async () => {
    settings.update({ updateCheck: false });
    await updates.checkAtStart(now);
    expect(api.checks).toBe(0);
    expect(updates.offer()).toBeNull();
  });

  it('says nothing when the check at the start fails, and asks again next time', async () => {
    api.fail = { code: 'connection_failed', message: 'github.com: no route' };
    await updates.checkAtStart(now);
    expect(updates.state()).toBe('idle');
    expect(updates.open()).toBe(false);
    expect(settings.settings().updateLastCheck).toBe(0);
    api.fail = null;
    await updates.checkAtStart(now + 1000);
    expect(updates.offer()).toBe('1.3.0');
  });

  it('opens the dialog when asked, whatever the setting, and tells a failure', async () => {
    settings.update({ updateCheck: false });
    api.fail = { code: 'connection_failed', message: 'github.com: no route' };
    await updates.checkNow();
    expect(updates.open()).toBe(true);
    expect(updates.state()).toBe('failed');
    expect(updates.error()).toContain('github.com: no route');
    // GitHub's 404: there is no published release
    api.fail = { code: 'not_found', message: 'no release has been published yet' };
    await updates.checkNow();
    expect(updates.error()).toBe('Es ist noch kein Release veröffentlicht.');
    api.fail = null;
    await updates.checkNow();
    expect(updates.state()).toBe('ready');
    expect(updates.info()?.latest).toBe('1.3.0');
  });

  it('offers nothing when this is the latest version', async () => {
    api.info = { ...api.info, latest: '1.2.3', newer: false };
    await updates.checkNow();
    expect(updates.state()).toBe('ready');
    expect(updates.offer()).toBeNull();
  });

  it('skips a version until a later one appears', async () => {
    await updates.checkNow();
    updates.skip();
    expect(updates.open()).toBe(false);
    expect(settings.settings().updateSkipped).toBe('1.3.0');
    expect(updates.offer()).toBeNull();
    api.info = { ...api.info, latest: '1.4.0' };
    await updates.checkNow();
    expect(updates.offer()).toBe('1.4.0');
  });

  it('opens the page of the newer version, else the list of releases', async () => {
    await updates.checkNow();
    await updates.openPage();
    api.info = { ...api.info, latest: '1.2.3', newer: false };
    await updates.checkNow();
    await updates.openPage();
    expect(api.opened).toEqual(['1.3.0', '']);
    api.failOpen = true;
    await updates.openPage();
    expect(updates.pageFailed()).toBe(true);
  });

  it('drops an answer that arrives after the dialog was closed or after a later check', async () => {
    api.hold = true;
    const first = updates.checkNow();
    expect(updates.state()).toBe('checking');
    updates.close();
    expect(updates.state()).toBe('idle');
    api.release();
    await first;
    expect(updates.info()).toBeNull();
    // an older answer does not overwrite a newer one
    const older = updates.checkNow();
    api.info = { ...api.info, latest: '2.0.0' };
    const newer = updates.checkNow();
    api.release();
    await Promise.all([older, newer]);
    expect(updates.info()?.latest).toBe('2.0.0');
  });
});
