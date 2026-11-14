import { describe, expect, it } from 'vitest';
import { UpdateInfo } from '../../core/update/update-api';
import { CHECK_INTERVAL_MS, dueForCheck, offered } from './update-logic';

const info = (change: Partial<UpdateInfo> = {}): UpdateInfo => ({
  current: '0.2.0',
  latest: '0.3.0',
  newer: true,
  published: '',
  notes: '',
  notesCut: false,
  ...change,
});

describe('dueForCheck', () => {
  const now = 1_800_000_000_000;

  it('never asks when the user turned it off', () => {
    expect(dueForCheck({ updateCheck: false, updateLastCheck: 0 }, now)).toBe(false);
  });

  it('asks the first time and again after a day, not within it', () => {
    expect(dueForCheck({ updateCheck: true, updateLastCheck: 0 }, now)).toBe(true);
    expect(dueForCheck({ updateCheck: true, updateLastCheck: now - 1000 }, now)).toBe(false);
    expect(
      dueForCheck({ updateCheck: true, updateLastCheck: now - CHECK_INTERVAL_MS + 1 }, now),
    ).toBe(false);
    expect(dueForCheck({ updateCheck: true, updateLastCheck: now - CHECK_INTERVAL_MS }, now)).toBe(
      true,
    );
  });

  it('asks when the last time lies in the future (the clock was set back)', () => {
    expect(dueForCheck({ updateCheck: true, updateLastCheck: now + 5000 }, now)).toBe(true);
  });
});

describe('offered', () => {
  it('is the newer version, unless it is skipped or there is none', () => {
    expect(offered(info(), '')).toBe('0.3.0');
    expect(offered(info(), '0.2.5')).toBe('0.3.0');
    expect(offered(info(), '0.3.0')).toBeNull();
    expect(offered(info({ newer: false, latest: '0.2.0' }), '')).toBeNull();
    expect(offered(null, '')).toBeNull();
  });
});
