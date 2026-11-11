import { Injectable, computed, inject, signal } from '@angular/core';
import { ClipboardApi, CopySelection } from '../../core/backend/clipboard-api';
import { describeError, toAppError } from '../../core/errors/app-error';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { QueryColumn, ResultStats } from '../../core/sql/query.models';
import { selectionSize } from '../results/copy-logic';
import { Figure, Measure, figuresOf, shownFigures, spoken, toggleMeasure } from './stats-logic';
import { STATS_TEXTS } from './stats-texts';

/** A selection that keeps changing is asked about this long after its last change. */
export const STATS_WAIT_MS = 150;
/** An answer that takes longer shows „…“ meanwhile. */
export const STATS_BUSY_MS = 250;
/** From so many cells on the „…“ is there at once. */
export const STATS_BIG_CELLS = 200_000;
/** A screen reader hears the figures once the selection rested this long. */
export const STATS_SPEAK_MS = 1200;
/** How long the status line says what was copied. */
export const STATS_NOTICE_MS = 3000;
/** Ids of these jobs: apart from exports, formatting and local views. */
const FIRST_JOB = 3_000_000_000;

/** The summary of a column on screen. */
export interface ColumnSummary {
  readonly column: QueryColumn;
  readonly stats: ResultStats | null;
  readonly problem: string | null;
}

/**
 * The figures of what is selected in a result grid (prompt 028): count, sum, mean, smallest, largest.
 * The grid says that its selection changed; the backend works the figures out over the result store.
 * A selection that changes quickly is asked about once, an older question is stopped, and an answer that
 * was overtaken is dropped.
 */
@Injectable({ providedIn: 'root' })
export class StatsService {
  private readonly api = inject(QueryApi);
  private readonly clipboard = inject(ClipboardApi);
  private readonly settings = inject(SettingsService);

  /** The figures of the selection, and of which result they are. */
  readonly stats = signal<{ readonly resultId: number; readonly stats: ResultStats } | null>(null);
  /** An answer is awaited long enough to say so. */
  readonly busy = signal(false);
  /** What a screen reader is told: set only when the selection rested. */
  readonly spoken = signal('');
  /** Something to tell once (a value was copied). */
  readonly notice = signal<string | null>(null);
  /** The column summarized in the popover. */
  readonly summary = signal<ColumnSummary | null>(null);

  readonly figures = computed<Figure[]>(() => {
    const s = this.stats();
    return s ? figuresOf(s.stats, this.settings.settings().groupDigits) : [];
  });
  /** Those the status line shows. */
  readonly shown = computed(() =>
    shownFigures(this.figures(), this.settings.settings().statsMeasures),
  );
  readonly ignored = computed(() => this.stats()?.stats.ignored ?? 0);

  private nextJob = FIRST_JOB;
  private job: number | null = null;
  private summaryJob: number | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private busyTimer: ReturnType<typeof setTimeout> | null = null;
  private speakTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Counts the questions, so only the answer to the last one counts. */
  private asked = 0;

  /** The selection of a grid changed. `rows`, `columns`: the size of its result. */
  selectionChanged(
    resultId: number,
    selection: CopySelection,
    rows: number,
    columns: number,
    explicit: boolean,
  ): void {
    const turn = ++this.asked;
    this.clear(this.waitTimer);
    this.clear(this.speakTimer);
    this.stop();
    // nothing marked, or one cell: there is nothing to add up
    const cells = explicit ? selectionSize(selection, rows, columns).cells : 0;
    if (cells < 2) {
      this.reset();
      return;
    }
    this.waitTimer = setTimeout(
      () => void this.ask(turn, resultId, selection, cells),
      STATS_WAIT_MS,
    );
  }

  /** The grid of a result is gone. */
  forget(resultId: number): void {
    if (this.stats()?.resultId !== resultId && this.job === null && this.waitTimer === null) return;
    this.asked++;
    this.clear(this.waitTimer);
    this.waitTimer = null;
    this.stop();
    this.reset();
  }

  private reset(): void {
    this.clear(this.busyTimer);
    this.busy.set(false);
    this.stats.set(null);
    this.spoken.set('');
  }

  private clear(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer !== null) clearTimeout(timer);
  }

  /** Stops the question that runs: its answer is not wanted any more. */
  private stop(): void {
    if (this.job === null) return;
    void this.api.cancelStats(this.job).catch(() => undefined);
    this.job = null;
  }

  private async ask(
    turn: number,
    resultId: number,
    selection: CopySelection,
    cells: number,
  ): Promise<void> {
    this.waitTimer = null;
    const job = this.nextJob++;
    this.job = job;
    this.clear(this.busyTimer);
    if (cells >= STATS_BIG_CELLS) this.busy.set(true);
    else this.busyTimer = setTimeout(() => this.busy.set(true), STATS_BUSY_MS);
    try {
      const stats = await this.api.resultStats(job, resultId, selection, false);
      if (turn !== this.asked) return;
      this.stats.set({ resultId, stats });
      this.speakTimer = setTimeout(
        () => this.spoken.set(spoken(this.shown(), stats.ignored)),
        STATS_SPEAK_MS,
      );
    } catch {
      // stopped, or the result is gone: no figures
      if (turn === this.asked) this.stats.set(null);
    } finally {
      if (this.job === job) this.job = null;
      if (turn === this.asked) {
        this.clear(this.busyTimer);
        this.busy.set(false);
      }
    }
  }

  private say(text: string): void {
    this.clear(this.noticeTimer);
    this.notice.set(text);
    this.noticeTimer = setTimeout(() => this.notice.set(null), STATS_NOTICE_MS);
  }

  /** Puts the value of a figure on the clipboard, exact. */
  async copy(figure: Figure): Promise<void> {
    try {
      await this.clipboard.copyText(figure.raw);
      this.say(STATS_TEXTS.copied(figure.label));
    } catch (e) {
      this.say(describeError(toAppError(e)));
    }
  }

  /** The sum of the selection onto the clipboard; `false` when it has none. */
  async copySum(): Promise<boolean> {
    const sum = this.figures().find((f) => f.key === 'sum');
    if (!sum) return false;
    await this.copy(sum);
    return true;
  }

  readonly hasSum = computed(() => this.figures().some((f) => f.key === 'sum'));

  /** Whether the status line shows a figure. */
  chosen(key: Measure): boolean {
    return this.settings.settings().statsMeasures.includes(key);
  }

  choose(key: Measure, on: boolean): void {
    this.settings.update({
      statsMeasures: toggleMeasure(this.settings.settings().statsMeasures, key, on),
    });
  }

  /** Summarizes a whole column of a result: its figures and its most frequent values. */
  async summarize(resultId: number, col: number, column: QueryColumn): Promise<void> {
    this.closeSummary();
    const job = this.nextJob++;
    this.summaryJob = job;
    this.summary.set({ column, stats: null, problem: null });
    try {
      const stats = await this.api.resultStats(job, resultId, { rows: [], columns: [col] }, true);
      if (this.summaryJob === job) this.summary.set({ column, stats, problem: null });
    } catch (e) {
      if (this.summaryJob === job)
        this.summary.set({
          column,
          stats: null,
          problem: STATS_TEXTS.summaryFailed(describeError(toAppError(e))),
        });
    } finally {
      if (this.summaryJob === job) this.summaryJob = null;
    }
  }

  /** Closes the summary; what is still being read for it is stopped. */
  closeSummary(): void {
    if (this.summaryJob !== null) {
      void this.api.cancelStats(this.summaryJob).catch(() => undefined);
      this.summaryJob = null;
    }
    this.summary.set(null);
  }
}
