import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_STATS, FakeClipboardApi, FakeQueryApi } from '../../../testing/fake-apis';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { STATS_BUSY_MS, STATS_SPEAK_MS, STATS_WAIT_MS, StatsService } from './stats.service';

describe('StatsService', () => {
  let api: FakeQueryApi;
  let clipboard: FakeClipboardApi;
  let stats: StatsService;
  const column = { rows: [[0, 9]] as [number, number][], columns: [1] };
  const sums = { ...EMPTY_STATS, cells: 10, nonNull: 10, distinct: 10, numbers: 10, sum: '55' };

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.resetTestingModule();
    api = new FakeQueryApi();
    clipboard = new FakeClipboardApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: QueryApi, useValue: api },
        { provide: ClipboardApi, useValue: clipboard },
      ],
    });
    stats = TestBed.inject(StatsService);
    api.statsAnswer = sums;
  });

  afterEach(() => vi.useRealTimers());

  const settle = () => vi.advanceTimersByTimeAsync(0);

  it('asks once for a selection that keeps changing', async () => {
    for (let last = 1; last <= 20; last++) {
      stats.selectionChanged(7, { rows: [[0, last]], columns: [1] }, 100, 3, true);
      await vi.advanceTimersByTimeAsync(STATS_WAIT_MS - 50);
    }
    expect(api.statsCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(STATS_WAIT_MS);
    expect(api.statsCalls).toHaveLength(1);
    expect(api.statsCalls[0]).toMatchObject({
      resultId: 7,
      selection: { rows: [[0, 20]], columns: [1] },
      top: false,
    });
    expect(stats.stats()).toEqual({ resultId: 7, stats: sums });
    expect(stats.shown().map((f) => `${f.label} ${f.shown}`)).toEqual(['Anzahl 10', 'Summe 55']);
  });

  it('has no figures for nothing marked or a single cell', async () => {
    stats.selectionChanged(7, column, 100, 3, true);
    await vi.advanceTimersByTimeAsync(STATS_WAIT_MS);
    expect(stats.stats()).not.toBeNull();
    stats.selectionChanged(7, { rows: [[4, 4]], columns: [1] }, 100, 3, true);
    expect(stats.stats()).toBeNull();
    // nothing marked means „everything“ to a copy, but not to the status line
    stats.selectionChanged(7, { rows: [], columns: [] }, 100, 3, false);
    await vi.advanceTimersByTimeAsync(STATS_WAIT_MS * 2);
    expect(stats.stats()).toBeNull();
    expect(api.statsCalls).toHaveLength(1);
  });

  it('stops a question that was overtaken and drops its answer', async () => {
    let open!: () => void;
    api.statsGate = new Promise<void>((r) => (open = r));
    stats.selectionChanged(7, column, 100, 3, true);
    await vi.advanceTimersByTimeAsync(STATS_WAIT_MS);
    expect(api.statsCalls).toHaveLength(1);
    const first = api.statsCalls[0].jobId;
    // the selection moves on while the first answer is awaited
    api.statsAnswer = { ...sums, sum: '99' };
    stats.selectionChanged(7, { rows: [[0, 19]], columns: [1] }, 100, 3, true);
    expect(api.cancelledStats).toEqual([first]);
    await vi.advanceTimersByTimeAsync(STATS_WAIT_MS);
    expect(api.statsCalls).toHaveLength(2);
    open();
    await settle();
    expect(stats.stats()?.stats.sum).toBe('99');
    expect(stats.busy()).toBe(false);
  });

  it('shows that it works only when the answer takes a while, and at once for a big selection', async () => {
    let open!: () => void;
    api.statsGate = new Promise<void>((r) => (open = r));
    stats.selectionChanged(7, column, 100, 3, true);
    await vi.advanceTimersByTimeAsync(STATS_WAIT_MS);
    expect(stats.busy()).toBe(false);
    await vi.advanceTimersByTimeAsync(STATS_BUSY_MS);
    expect(stats.busy()).toBe(true);
    open();
    await settle();
    expect(stats.busy()).toBe(false);
    api.statsGate = new Promise<void>((r) => (open = r));
    stats.selectionChanged(7, { rows: [], columns: [1] }, 10_000_000, 3, true);
    await vi.advanceTimersByTimeAsync(STATS_WAIT_MS);
    expect(stats.busy()).toBe(true);
    open();
    await settle();
    expect(stats.busy()).toBe(false);
  });

  it('tells a screen reader only once the selection rested', async () => {
    stats.selectionChanged(7, column, 100, 3, true);
    await vi.advanceTimersByTimeAsync(STATS_WAIT_MS);
    expect(stats.spoken()).toBe('');
    stats.selectionChanged(7, { rows: [[0, 19]], columns: [1] }, 100, 3, true);
    await vi.advanceTimersByTimeAsync(STATS_WAIT_MS + STATS_SPEAK_MS - 10);
    expect(stats.spoken()).toBe('');
    await vi.advanceTimersByTimeAsync(20);
    expect(stats.spoken()).toBe('Anzahl 10, Summe 55');
  });

  it('forgets the figures of a result that is gone, and has none after an error', async () => {
    stats.selectionChanged(7, column, 100, 3, true);
    await vi.advanceTimersByTimeAsync(STATS_WAIT_MS);
    stats.forget(8);
    expect(stats.stats()).not.toBeNull();
    stats.forget(7);
    expect(stats.stats()).toBeNull();
    api.statsError = { code: 'unknown_result', message: '' };
    stats.selectionChanged(7, column, 100, 3, true);
    await vi.advanceTimersByTimeAsync(STATS_WAIT_MS);
    expect(stats.stats()).toBeNull();
    expect(stats.busy()).toBe(false);
  });

  it('copies a figure exactly and says so', async () => {
    api.statsAnswer = { ...sums, sum: '1234567.50' };
    stats.selectionChanged(7, column, 100, 3, true);
    await vi.advanceTimersByTimeAsync(STATS_WAIT_MS);
    expect(stats.hasSum()).toBe(true);
    expect(await stats.copySum()).toBe(true);
    expect(clipboard.texts).toEqual(['1234567.50']);
    expect(stats.notice()).toBe('Summe kopiert.');
    await vi.advanceTimersByTimeAsync(5000);
    expect(stats.notice()).toBeNull();
    api.statsAnswer = { ...EMPTY_STATS, cells: 4 };
    stats.selectionChanged(7, { rows: [[0, 3]], columns: [0] }, 100, 3, true);
    await vi.advanceTimersByTimeAsync(STATS_WAIT_MS);
    expect(await stats.copySum()).toBe(false);
  });

  it('chooses what the status line shows', async () => {
    const settings = TestBed.inject(SettingsService);
    stats.choose('distinct', true);
    stats.choose('sum', false);
    expect(settings.settings().statsMeasures).toEqual(['cells', 'distinct', 'mean', 'min', 'max']);
    expect(stats.chosen('distinct')).toBe(true);
    expect(stats.chosen('sum')).toBe(false);
  });

  it('summarizes a column with its most frequent values, and stops when closed', async () => {
    const col = { name: 'state', kind: 'text' as const, typeName: 'varchar' };
    api.statsAnswer = { ...EMPTY_STATS, cells: 16, top: [{ value: 'paid', count: 5 }] };
    await stats.summarize(7, 2, col);
    expect(api.statsCalls.at(-1)).toMatchObject({
      resultId: 7,
      selection: { rows: [], columns: [2] },
      top: true,
    });
    expect(stats.summary()).toMatchObject({ column: col, stats: { cells: 16 }, problem: null });
    stats.closeSummary();
    expect(stats.summary()).toBeNull();
    // closed while the column is read: stopped, and the late answer opens nothing
    let open!: () => void;
    api.statsGate = new Promise<void>((r) => (open = r));
    const pending = stats.summarize(7, 2, col);
    expect(stats.summary()?.stats).toBeNull();
    const job = api.statsCalls.at(-1)!.jobId;
    stats.closeSummary();
    expect(api.cancelledStats).toContain(job);
    open();
    await pending;
    expect(stats.summary()).toBeNull();
    api.statsGate = null;
    api.statsError = { code: 'unknown_result', message: 'x' };
    await stats.summarize(7, 2, col);
    expect(stats.summary()?.problem).toContain('Die Spalte ließ sich nicht zusammenfassen');
  });
});
