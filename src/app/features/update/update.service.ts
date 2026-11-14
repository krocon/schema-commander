import { Injectable, computed, inject, signal } from '@angular/core';
import { describeError, toAppError } from '../../core/errors/app-error';
import { SettingsService } from '../../core/settings/settings.service';
import { UpdateApi, UpdateInfo } from '../../core/update/update-api';
import { dueForCheck, offered } from './update-logic';
import { UPDATE_TEXTS } from './update-texts';

export type UpdateState = 'idle' | 'checking' | 'ready' | 'failed';

/**
 * Tells the user about a newer version: asked for (the dialog), or by itself once a day at the start
 * (a line in the status bar, nothing else). It never downloads or installs anything.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly api = inject(UpdateApi);
  private readonly settings = inject(SettingsService);

  /** The dialog is on screen. */
  readonly open = signal(false);
  readonly state = signal<UpdateState>('idle');
  /** What the last check that came back said. */
  readonly info = signal<UpdateInfo | null>(null);
  /** What the last check that failed was rejected with. */
  private readonly failure = signal<unknown>(null);
  /** Why it failed, in the words of the language on screen. */
  readonly error = computed(() => {
    const failure = this.failure();
    if (failure === null) return '';
    // GitHub answers 404 as long as no release is published (drafts do not count)
    return toAppError(failure).code === 'not_found'
      ? UPDATE_TEXTS.noRelease
      : describeError(failure);
  });
  /** Opening the page failed. */
  readonly pageFailed = signal(false);
  /** The newer version the status bar points at; `null` when there is none or it is skipped. */
  readonly offer = computed(() => offered(this.info(), this.settings.settings().updateSkipped));
  /** Each check has a number: an answer to an older one is dropped. */
  private run = 0;

  /** The user asks: the dialog opens and shows what comes back. */
  async checkNow(): Promise<void> {
    this.open.set(true);
    this.pageFailed.set(false);
    this.state.set('checking');
    const run = ++this.run;
    try {
      const info = await this.api.check();
      if (run !== this.run) return;
      this.info.set(info);
      this.state.set('ready');
      this.settings.update({ updateLastCheck: Date.now() });
    } catch (e) {
      if (run !== this.run) return;
      this.failure.set(e);
      this.state.set('failed');
    }
  }

  /** At the start: asks only if the user lets the app and a day has passed. A failure is not told. */
  async checkAtStart(now = Date.now()): Promise<void> {
    if (!dueForCheck(this.settings.settings(), now)) return;
    const run = ++this.run;
    try {
      const info = await this.api.check();
      if (run !== this.run) return;
      this.info.set(info);
      this.state.set('ready');
      this.settings.update({ updateLastCheck: now });
    } catch {
      // no network, no release yet, not the desktop app: the next start asks again
    }
  }

  /** Shows what is known (from the status bar): no new request. */
  show(): void {
    this.pageFailed.set(false);
    this.open.set(true);
  }

  async openPage(): Promise<void> {
    const info = this.info();
    try {
      await this.api.openPage(info?.newer ? info.latest : '');
      this.pageFailed.set(false);
    } catch {
      this.pageFailed.set(true);
    }
  }

  /** The user does not want to hear about this version again; a later one is offered. */
  skip(): void {
    const info = this.info();
    if (info?.newer) this.settings.update({ updateSkipped: info.latest });
    this.close();
  }

  close(): void {
    this.open.set(false);
    // an answer that is still on its way belongs to a dialog that is gone
    if (this.state() === 'checking') {
      this.run++;
      this.state.set(this.info() ? 'ready' : 'idle');
    }
  }
}
