import { Injectable, computed, inject, signal } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError, toAppError } from '../../core/errors/app-error';
import { DataImportApi, LoadPlan, Loaded, SourceOptions } from '../../core/import/data-import-api';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { needingConfirmation } from '../guard/guard-logic';
import { GuardService } from '../guard/guard.service';
import { SchemaStore } from '../schema/schema.store';
import { IMPORT_JOB_BASE } from './data-import-logic';

/** Where an import goes; table and schema may be chosen in the dialog. */
export interface ImportTarget {
  readonly connectionId: string;
  readonly schema: string | null;
  readonly table: string | null;
}

/** An import that runs, or has ended. */
export interface ImportJob {
  readonly id: number;
  readonly state: 'running' | 'done' | 'failed';
  /** Records read so far. */
  readonly read: number;
  readonly report: Loaded | null;
  /** Why it could not run at all. */
  readonly error: string | null;
  readonly errorPath: string | null;
}

/**
 * Imports as jobs (prompt 033): the backend reads the file and writes the rows; this asks the guard of
 * the connection and keeps track. One import at a time.
 */
@Injectable({ providedIn: 'root' })
export class DataImportService {
  private readonly api = inject(DataImportApi);
  private readonly queries = inject(QueryApi);
  private readonly guard = inject(GuardService);
  private readonly connections = inject(ConnectionsStore);
  private readonly settings = inject(SettingsService);
  private readonly schema = inject(SchemaStore);
  private nextId = IMPORT_JOB_BASE;

  /** The target the dialog is open for. */
  readonly request = signal<ImportTarget | null>(null);
  readonly job = signal<ImportJob | null>(null);
  readonly running = computed(() => this.job()?.state === 'running');

  /** Opens the dialog for the active connection (and a table of it, if one is named). */
  open(schema: string | null = null, table: string | null = null): void {
    if (this.running()) return;
    this.job.set(null);
    this.request.set({ connectionId: this.connections.activeId(), schema, table });
  }

  close(): void {
    if (this.running()) return;
    this.request.set(null);
    this.job.set(null);
  }

  private allowDangerous(): boolean {
    return !this.settings.settings().confirmDangerous;
  }

  /**
   * Asks the guard about statements; the tokens for them, or `null` for a no. The backend decides what
   * needs a yes.
   */
  private async admit(
    connectionId: string,
    sqls: readonly string[],
  ): Promise<(string | null)[] | null> {
    const allow = this.allowDangerous();
    const verdicts = await this.queries.check(connectionId, sqls, allow);
    const guarded = needingConfirmation(sqls, verdicts);
    if (guarded.length === 0) return [];
    const profile = this.connections.profiles().find((p) => p.id === connectionId);
    const answer = profile
      ? await this.guard.ask({ connection: profile, statements: guarded, total: sqls.length })
      : null;
    if (!answer) return null;
    return this.queries.confirm(connectionId, sqls, answer.typedName, allow);
  }

  /** Runs the `CREATE TABLE` of the dialog. Resolves with `null`, or with why it did not run. */
  async createTable(connectionId: string, sql: string): Promise<string | null | 'declined'> {
    try {
      const tokens = await this.admit(connectionId, [sql]);
      if (!tokens) return 'declined';
      await this.api.createTable(connectionId, sql, tokens[0] ?? null, this.allowDangerous());
      this.schema.ran(connectionId, [sql]);
      return null;
    } catch (e) {
      return describeError(toAppError(e));
    }
  }

  /** Loads the file. Resolves when the import has ended (or was declined: then no job is left). */
  async start(
    connectionId: string,
    path: string,
    options: SourceOptions,
    plan: LoadPlan,
    errorPath: string | null,
  ): Promise<void> {
    if (this.running()) return;
    const id = this.nextId++;
    const job: ImportJob = { id, state: 'running', read: 0, report: null, error: null, errorPath };
    this.job.set(job);
    const update = (change: Partial<ImportJob>) =>
      this.job.update((j) => (j && j.id === id ? { ...j, ...change } : j));
    try {
      const sqls = await this.api.statements(connectionId, plan);
      const tokens = await this.admit(connectionId, sqls);
      if (!tokens) {
        this.job.set(null);
        return;
      }
      const report = await this.api.run(
        id,
        connectionId,
        path,
        options,
        plan,
        errorPath,
        tokens,
        this.allowDangerous(),
        this.settings.settings().statementTimeoutSec * 1000,
        (read) => update({ read }),
      );
      update({ state: 'done', report, read: report.read });
    } catch (e) {
      update({ state: 'failed', error: describeError(toAppError(e)) });
    }
  }

  /** Stops the import that runs. */
  cancel(): void {
    const job = this.job();
    if (job?.state === 'running') void this.api.cancel(job.id);
  }

  /** Shows the error file of the import that ended. */
  reveal(): void {
    const job = this.job();
    if (job?.report?.errorFile && job.errorPath) {
      void this.api.reveal(job.errorPath).catch(() => undefined);
    }
  }
}
