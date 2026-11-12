import { Injectable, inject, signal } from '@angular/core';
import {
  BackupApi,
  BackupDone,
  DumpSpec,
  RestoreSpec,
  ToolPaths,
} from '../../core/backup/backup-api';
import { describeError, toAppError } from '../../core/errors/app-error';
import { SettingsService } from '../../core/settings/settings.service';
import { withLine } from './backup-logic';

/** What the dialog is opened for. */
export interface BackupTarget {
  readonly connectionId: string;
  readonly mode: 'backup' | 'restore';
  /** Chosen in the tree: only this schema, or only this table of it. */
  readonly schema: string | null;
  readonly table: string | null;
}

/** The job of the dialog: one at a time. */
export interface BackupJob {
  readonly state: 'running' | 'done' | 'stopped' | 'failed';
  /** What the tool said, the newest last. */
  readonly lines: readonly string[];
  readonly done: BackupDone | null;
  readonly error: string | null;
}

/** Ids of the jobs of backup and restore: far from those of the other jobs. */
let nextJob = 9_000_000_000;

/**
 * Backup and restore (prompt 044): the dialog, and its one job – started here, heard line by line,
 * stopped on a word. The backend starts the tools; this service never sees a password.
 */
@Injectable({ providedIn: 'root' })
export class BackupService {
  private readonly api = inject(BackupApi);
  private readonly settings = inject(SettingsService);

  readonly target = signal<BackupTarget | null>(null);
  readonly job = signal<BackupJob | null>(null);
  private jobId: number | null = null;

  open(target: BackupTarget): void {
    if (this.running()) return;
    this.job.set(null);
    this.target.set(target);
  }

  /** Closes the dialog; a job that runs is stopped first. */
  close(): void {
    this.cancel();
    this.target.set(null);
  }

  running(): boolean {
    return this.job()?.state === 'running';
  }

  paths(): ToolPaths {
    return this.settings.settings().toolPaths as ToolPaths;
  }

  setPath(tool: string, path: string): void {
    const paths = { ...this.settings.settings().toolPaths };
    if (path.trim() === '') delete paths[tool];
    else paths[tool] = path.trim();
    this.settings.update({ toolPaths: paths });
  }

  private async track(
    work: (job: number, onLine: (line: string) => void) => Promise<BackupDone>,
  ): Promise<void> {
    if (this.running()) return;
    const id = nextJob++;
    this.jobId = id;
    this.job.set({ state: 'running', lines: [], done: null, error: null });
    const mine = () => this.jobId === id;
    try {
      const done = await work(id, (line) => {
        if (mine()) this.job.update((j) => (j ? { ...j, lines: withLine(j.lines, line) } : j));
      });
      if (mine()) this.job.update((j) => (j ? { ...j, state: 'done', done } : j));
    } catch (e) {
      if (!mine()) return;
      const stopped = toAppError(e).code === 'cancelled';
      this.job.update((j) =>
        j
          ? {
              ...j,
              state: stopped ? 'stopped' : 'failed',
              error: stopped ? null : describeError(e),
            }
          : j,
      );
    } finally {
      if (mine()) this.jobId = null;
    }
  }

  dump(connectionId: string, spec: DumpSpec, path: string): Promise<void> {
    return this.track((job, onLine) =>
      this.api.dump(job, connectionId, spec, path, this.paths(), onLine),
    );
  }

  restore(
    connectionId: string,
    spec: RestoreSpec,
    path: string,
    typedName: string | null,
  ): Promise<void> {
    return this.track((job, onLine) =>
      this.api.restore(job, connectionId, spec, path, this.paths(), typedName, onLine),
    );
  }

  simple(connectionId: string, schema: string, data: boolean, path: string): Promise<void> {
    return this.track((job, onLine) =>
      this.api.simple(job, connectionId, schema, data, path, onLine),
    );
  }

  /** Stops the job that runs: the backend ends the program and removes what it wrote. */
  cancel(): void {
    const id = this.jobId;
    if (id !== null) void this.api.cancel(id).catch(() => undefined);
  }
}
