import { Injectable, inject, signal } from '@angular/core';
import { describeError } from '../../core/errors/app-error';
import { MonitorApi, ServerActivity, ServerSession } from '../../core/monitor/monitor-api';
import { ConfirmService } from '../../shared/confirm';
import { Reading, durationText, firstLine, transactionRate } from './monitor-logic';
import { MONITOR_TEXTS } from './monitor-texts';

/**
 * The server monitor (prompt 046): one connection is watched at a time. Reads on a word or in a beat –
 * never two readings at once, and none while the page is hidden. Ending a statement or a session asks
 * first, with who, how long and what. Statements of others are shown and nothing else: not logged, not
 * noted in the history.
 */
@Injectable({ providedIn: 'root' })
export class MonitorService {
  private readonly api = inject(MonitorApi);
  private readonly confirm = inject(ConfirmService);

  /** The connection that is watched; `null`: the monitor is closed. */
  readonly connectionId = signal<string | null>(null);
  readonly activity = signal<ServerActivity | null>(null);
  readonly busy = signal(false);
  readonly problem = signal('');
  /** What the last intervention said. */
  readonly note = signal('');
  /** When the reading on screen was taken (ms since the epoch). */
  readonly readAt = signal<number | null>(null);
  /** Transactions per second between the last two readings. */
  readonly rate = signal<number | null>(null);
  private last: Reading | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private asked = 0;

  open(connectionId: string): void {
    this.close();
    this.connectionId.set(connectionId);
    void this.refresh();
  }

  close(): void {
    const id = this.connectionId();
    this.every(0);
    this.asked++;
    this.connectionId.set(null);
    this.activity.set(null);
    this.problem.set('');
    this.note.set('');
    this.readAt.set(null);
    this.rate.set(null);
    this.last = null;
    this.busy.set(false);
    if (id !== null) void this.api.close(id).catch(() => undefined);
  }

  /** Reads again every `seconds` (0: only by hand). */
  every(seconds: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (seconds > 0 && this.connectionId() !== null) {
      this.timer = setInterval(() => {
        // a hidden page watches nothing; a reading that still runs is not overtaken
        if (typeof document !== 'undefined' && document.hidden) return;
        if (!this.busy()) void this.refresh();
      }, seconds * 1000);
    }
  }

  async refresh(): Promise<void> {
    const id = this.connectionId();
    if (id === null || this.busy()) return;
    const asked = ++this.asked;
    this.busy.set(true);
    try {
      const activity = await this.api.activity(id);
      if (asked !== this.asked) return;
      const now: Reading = { at: Date.now(), figures: activity.figures };
      this.rate.set(transactionRate(this.last, now));
      this.last = now;
      this.activity.set(activity);
      this.readAt.set(now.at);
      this.problem.set('');
    } catch (e) {
      if (asked === this.asked) this.problem.set(describeError(e));
    } finally {
      if (asked === this.asked) this.busy.set(false);
    }
  }

  /** Cancels the statement of a session or ends the session – after a question that shows what goes. */
  async end(session: ServerSession, terminate: boolean): Promise<void> {
    const id = this.connectionId();
    if (id === null || session.this) return;
    const t = MONITOR_TEXTS;
    const yes = await this.confirm.ask({
      title: terminate ? t.confirmTerminate : t.confirmCancel,
      message: t.confirmDetails(
        session.user,
        durationText(session.queryMs ?? session.txMs) || '–',
        firstLine(session.statement, 600) || t.noStatement,
      ),
      confirm: terminate ? t.yesTerminate : t.yesCancel,
    });
    if (!yes || this.connectionId() !== id) return;
    this.note.set('');
    try {
      const ended = await this.api.kill(id, session.id, terminate);
      this.note.set(ended ? t.done(session.id) : t.gone(session.id));
    } catch (e) {
      this.problem.set(describeError(e));
    }
    await this.refresh();
  }
}
