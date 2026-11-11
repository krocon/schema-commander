import { Injectable, computed, inject, signal } from '@angular/core';
import { errorText, toAppError } from '../../core/errors/app-error';
import {
  FORMAT_JOB_BASE,
  FormatApi,
  FormatDialect,
  FormatMode,
  FormatStyle,
} from '../../core/format/format-api';
import { SettingsService } from '../../core/settings/settings.service';
import { BIG_TEXT, FormatOutcome, PREVIEW_SQL, styleOf } from './format-logic';
import { FORMAT_TEXTS } from './format-texts';

/**
 * Formatting as a job (prompt 023): the backend does the work, one text at a time; a long one shows in the
 * status line and can be stopped. The editor asks (`run`) and puts the result in – this never touches text.
 */
@Injectable({ providedIn: 'root' })
export class FormatService {
  private readonly api = inject(FormatApi);
  private readonly settings = inject(SettingsService);
  private nextId = FORMAT_JOB_BASE;
  private readonly job = signal<{ readonly id: number; readonly big: boolean } | null>(null);

  readonly running = computed(() => this.job() !== null);
  /** A long text is being formatted: the status line says so. */
  readonly visible = computed(() => this.job()?.big === true);

  /**
   * The text formatted by the style of the settings; `null` while another one is being formatted. Rejects
   * with an `AppError` (`cancelled`, `format_incomplete`, `format_unsafe` …): then the text must stay.
   */
  async run(
    sql: string,
    dialect: FormatDialect,
    mode: FormatMode,
    crlf: boolean,
  ): Promise<string | null> {
    if (this.job()) return null;
    const id = this.nextId++;
    this.job.set({ id, big: sql.length >= BIG_TEXT });
    try {
      const style = styleOf(this.settings.settings());
      return await this.api.format(id, sql, dialect, mode, style, crlf);
    } finally {
      this.job.set(null);
    }
  }

  cancel(): void {
    const job = this.job();
    if (job) void this.api.cancel(job.id).catch(() => undefined);
  }

  /** The sample of the settings dialog in a style; no job of the status line. */
  preview(style: FormatStyle): Promise<string> {
    return this.api.format(this.nextId++, PREVIEW_SQL, 'postgres', 'format', style, false);
  }

  /** What the user reads about how formatting ended; `null`: nothing to say. */
  notice(outcome: FormatOutcome): string | null {
    return outcome === 'done' ? null : FORMAT_TEXTS[outcome];
  }

  /** What the user reads when formatting was refused or stopped. */
  failure(e: unknown): string {
    return toAppError(e).code === 'cancelled' ? FORMAT_TEXTS.cancelled : errorText(e);
  }
}
