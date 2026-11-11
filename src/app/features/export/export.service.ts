import { Injectable, computed, inject, signal } from '@angular/core';
import { ExportApi, ExportSpec } from '../../core/backend/export-api';
import { describeError, toAppError } from '../../core/errors/app-error';
import { QueryColumn } from '../../core/sql/query.models';
import { baseName, doneMessage, progressMessage } from './export-logic';
import { EXPORT_TEXTS } from './export-texts';

/** What to export. */
export type ExportSource =
  | {
      readonly kind: 'result';
      readonly resultId: number;
      readonly columns: readonly QueryColumn[];
      /** Rows of the result, and the ranges chosen in the grid (none = all). */
      readonly rows: number;
      readonly ranges: readonly (readonly [number, number])[];
      /** The statement of the result and its connection: to run it again for all rows. */
      readonly sql: string;
      readonly connectionId: string;
      /** For the file name and the table of `INSERT`. */
      readonly name: string;
      readonly table: string;
    }
  | {
      readonly kind: 'query';
      readonly connectionId: string;
      readonly sql: string;
      readonly name: string;
      readonly table: string;
    };

/** A file that is being written, or was. */
export interface ExportJob {
  readonly id: number;
  readonly path: string;
  readonly state: 'running' | 'done' | 'failed' | 'cancelled';
  /** What the status line says. */
  readonly message: string;
}

/**
 * Exports as jobs (prompt 011): started from the dialog, shown in the status line, stoppable. The file is
 * written by the backend; this only keeps track.
 */
@Injectable({ providedIn: 'root' })
export class ExportService {
  private readonly api = inject(ExportApi);
  private nextId = 1;

  /** The source the dialog is open for. */
  readonly request = signal<ExportSource | null>(null);
  /** The job the status line talks about: the one that runs, else the last one. */
  readonly job = signal<ExportJob | null>(null);
  readonly running = computed(() => this.job()?.state === 'running');

  private update(id: number, change: Partial<ExportJob>): void {
    this.job.update((job) => (job && job.id === id ? { ...job, ...change } : job));
  }

  /** Writes `source` to `path` (from the save dialog). One export at a time. */
  async start(source: ExportSource, path: string, spec: ExportSpec, rerun: boolean): Promise<void> {
    if (this.running()) return;
    const id = this.nextId++;
    const name = baseName(path);
    this.job.set({ id, path, state: 'running', message: progressMessage(name, 0) });
    const progress = (rows: number) => this.update(id, { message: progressMessage(name, rows) });
    try {
      const done =
        source.kind === 'result' && !rerun
          ? await this.api.exportResult(id, source.resultId, source.ranges, path, spec, progress)
          : await this.api.exportQuery(id, source.connectionId, source.sql, path, spec, progress);
      this.update(id, { state: 'done', message: doneMessage(name, done) });
    } catch (e) {
      const error = toAppError(e);
      this.update(
        id,
        error.code === 'cancelled'
          ? {
              state: 'cancelled',
              message: EXPORT_TEXTS.cancelled(name),
            }
          : {
              state: 'failed',
              message: EXPORT_TEXTS.failed(name, describeError(error)),
            },
      );
    }
  }

  /** Stops the export that runs. */
  cancel(): void {
    const job = this.job();
    if (job?.state === 'running') void this.api.cancel(job.id);
  }

  /** Shows the file of the last export in the file manager. */
  reveal(): void {
    const job = this.job();
    if (job?.state === 'done') void this.api.reveal(job.path).catch(() => undefined);
  }

  /** Takes the message of a finished export out of the status line. */
  dismiss(): void {
    if (!this.running()) this.job.set(null);
  }
}
