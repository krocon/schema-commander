import { Injectable, computed, inject, signal } from '@angular/core';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError } from '../../core/errors/app-error';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { TestdataApi, TestdataSpec } from '../../core/testdata/testdata-api';
import { needingConfirmation } from '../guard/guard-logic';
import { GuardService } from '../guard/guard.service';
import {
  TESTDATA_JOB_BASE,
  TestdataTemplate,
  readTemplates,
  templateKey,
  withSaved,
} from './testdata-logic';
import { TESTDATA_TEXTS } from './testdata-texts';

/** The table the dialog is open for. */
export interface TestdataTarget {
  readonly connectionId: string;
  readonly schema: string;
  readonly table: string;
}

/**
 * Test data (prompt 049): opens the dialog and runs what it asks for – one job at a time. Writing goes
 * through the guard of the connection like an import; the backend refuses a protected connection. The
 * rows are made in the backend: the window never holds more than the preview.
 */
@Injectable({ providedIn: 'root' })
export class TestdataService {
  private readonly api = inject(TestdataApi);
  private readonly queries = inject(QueryApi);
  private readonly guard = inject(GuardService);
  private readonly connections = inject(ConnectionsStore);
  private readonly settings = inject(SettingsService);
  private readonly files = inject(FileDialogApi);

  readonly target = signal<TestdataTarget | null>(null);
  /** Rows written so far, of how many; `null`: no job runs. */
  readonly progress = signal<{ readonly rows: number; readonly total: number } | null>(null);
  readonly running = computed(() => this.progress() !== null);
  private nextJob = TESTDATA_JOB_BASE;
  private jobId: number | null = null;

  open(target: TestdataTarget): void {
    if (!this.running()) this.target.set(target);
  }

  close(): void {
    void this.stop();
    this.target.set(null);
  }

  /** Whether rows can be written: only on a connection without protection. */
  canWrite(connectionId: string): boolean {
    const profile = this.connections.profiles().find((p) => p.id === connectionId);
    return (profile?.protection ?? 'free') === 'free';
  }

  template(target: TestdataTarget): TestdataTemplate | undefined {
    const all = readTemplates(this.settings.settings().testdataTemplates);
    return all[templateKey(target.connectionId, target.schema, target.table)];
  }

  remember(target: TestdataTarget, template: TestdataTemplate): void {
    const all = readTemplates(this.settings.settings().testdataTemplates);
    this.settings.update({
      testdataTemplates: withSaved(
        all,
        templateKey(target.connectionId, target.schema, target.table),
        template,
      ),
    });
  }

  /** Writes the rows of a spec. Resolves with what to tell the user. */
  async run(
    connectionId: string,
    spec: TestdataSpec,
    total: number,
    options: { readonly clearFirst: boolean; readonly wholeTransaction: boolean },
  ): Promise<string> {
    const t = TESTDATA_TEXTS;
    if (this.running()) return '';
    const allow = !this.settings.settings().confirmDangerous;
    this.progress.set({ rows: 0, total });
    const id = this.nextJob++;
    try {
      const statements = await this.api.statements(connectionId, spec, options.clearFirst);
      let tokens: (string | null)[] = [];
      const verdicts = await this.queries.check(connectionId, statements, allow);
      const guarded = needingConfirmation(statements, verdicts);
      if (guarded.length > 0) {
        const profile = this.connections.profiles().find((p) => p.id === connectionId);
        const answer = profile
          ? await this.guard.ask({
              connection: profile,
              statements: guarded,
              total: statements.length,
            })
          : null;
        if (!answer) return t.declined;
        tokens = await this.queries.confirm(connectionId, statements, answer.typedName, allow);
      }
      this.jobId = id;
      const done = await this.api.run(id, connectionId, spec, options, tokens, allow, (rows) => {
        if (this.jobId === id) this.progress.set({ rows, total });
      });
      if (done.cancelled) return done.rolledBack ? t.rolledBack : t.cancelled(done.written);
      if (done.failed) {
        const reason = done.errors[0]?.reason ?? '';
        return done.rolledBack ? `${t.failed(0, reason)}` : t.failed(done.written, reason);
      }
      return t.done(done.written);
    } catch (e) {
      return describeError(e);
    } finally {
      if (this.jobId === id) this.jobId = null;
      this.progress.set(null);
    }
  }

  /** Writes the rows of a spec into a file the user chooses; `null`: no file was chosen. */
  async export(
    connectionId: string,
    spec: TestdataSpec,
    total: number,
    format: 'csv' | 'insert',
  ): Promise<string | null> {
    const t = TESTDATA_TEXTS;
    if (this.running()) return null;
    // busy from here on: a second click while the file is chosen starts nothing
    this.progress.set({ rows: 0, total });
    const extension = format === 'csv' ? 'csv' : 'sql';
    const path = await this.files
      .saveFile(format === 'csv' ? t.exportCsv : t.exportInsert, `${spec.table}.${extension}`, [
        { name: format === 'csv' ? t.csvFiles : t.sqlFiles, extensions: [extension] },
      ])
      .catch(() => null);
    if (path === null) {
      this.progress.set(null);
      return null;
    }
    const id = this.nextJob++;
    this.jobId = id;
    try {
      return t.exported(await this.api.export(id, connectionId, spec, path, format));
    } catch (e) {
      return describeError(e);
    } finally {
      if (this.jobId === id) this.jobId = null;
      this.progress.set(null);
    }
  }

  async stop(): Promise<void> {
    const id = this.jobId;
    if (id !== null) await this.api.cancel(id).catch(() => undefined);
  }
}
