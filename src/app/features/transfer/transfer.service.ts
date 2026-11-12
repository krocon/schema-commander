import { Injectable, inject, signal } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError } from '../../core/errors/app-error';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import {
  TransferApi,
  TransferPlan,
  TransferReport,
  TransferRequest,
} from '../../core/transfer/transfer-api';
import { CompletionService } from '../completion/completion.service';
import { needingConfirmation } from '../guard/guard-logic';
import { GuardService } from '../guard/guard.service';
import { SchemaStore } from '../schema/schema.store';
import { Progress } from './transfer-logic';

/** What the dialog is opened for: where the tables come from. */
export interface TransferSource {
  readonly connectionId: string;
  readonly schema: string;
  /** Chosen in the tree; `null`: all tables of the schema are offered, none ticked. */
  readonly table: string | null;
}

/** How a run ended. */
export type TransferOutcome =
  | { readonly kind: 'report'; readonly report: TransferReport }
  | { readonly kind: 'declined' }
  | { readonly kind: 'error'; readonly message: string };

/** Ids of the jobs that copy tables: far from those of the other jobs. */
let nextJob = 10_000_000_000;

/**
 * Copying tables between connections (prompt 045): the dialog and its one job. The statements of a plan
 * pass the guard of the target like every statement that writes; the backend makes the plan again and
 * decides.
 */
@Injectable({ providedIn: 'root' })
export class TransferService {
  private readonly api = inject(TransferApi);
  private readonly queries = inject(QueryApi);
  private readonly guard = inject(GuardService);
  private readonly connections = inject(ConnectionsStore);
  private readonly settings = inject(SettingsService);
  private readonly schema = inject(SchemaStore);
  private readonly completion = inject(CompletionService);

  readonly source = signal<TransferSource | null>(null);
  /** How far the run is; `null`: none runs. */
  readonly progress = signal<Progress | null>(null);
  private jobId: number | null = null;

  open(source: TransferSource): void {
    if (this.running()) return;
    this.source.set(source);
  }

  close(): void {
    this.cancel();
    this.source.set(null);
  }

  running(): boolean {
    return this.jobId !== null;
  }

  plan(source: string, target: string, request: TransferRequest): Promise<TransferPlan> {
    return this.api.plan(source, target, request);
  }

  /** Runs a plan: asks the user where the target wants that, then copies. */
  async run(
    source: string,
    target: string,
    request: TransferRequest,
    plan: TransferPlan,
    errorPath: string | null,
  ): Promise<TransferOutcome> {
    if (this.running()) return { kind: 'declined' };
    const s = this.settings.settings();
    const allow = !s.confirmDangerous;
    const statements = [...plan.statements];
    const id = nextJob++;
    try {
      let tokens: (string | null)[] = [];
      const verdicts = await this.queries.check(target, statements, allow);
      const guarded = needingConfirmation(statements, verdicts);
      if (guarded.length > 0) {
        const profile = this.connections.profiles().find((p) => p.id === target);
        if (!profile) return { kind: 'declined' };
        const answer = await this.guard.ask({
          connection: profile,
          statements: guarded,
          total: statements.length,
        });
        if (!answer) return { kind: 'declined' };
        tokens = await this.queries.confirm(target, statements, answer.typedName, allow);
      }
      this.jobId = id;
      this.progress.set({
        table: plan.tables[0]?.table ?? '',
        index: 0,
        of: plan.tables.length,
        read: 0,
      });
      const report = await this.api.run(
        id,
        source,
        target,
        request,
        tokens,
        allow,
        errorPath,
        s.statementTimeoutSec * 1000,
        (event) => {
          if (this.jobId !== id) return;
          if (event.kind === 'table') {
            this.progress.set({ table: event.table, index: event.index, of: event.of, read: 0 });
          } else {
            this.progress.update((p) => (p ? { ...p, table: event.table, read: event.read } : p));
          }
        },
      );
      // tables may have been created: the tree and the completion read the target anew
      this.schema.ran(target, statements);
      this.completion.forget();
      return { kind: 'report', report };
    } catch (e) {
      return { kind: 'error', message: describeError(e) };
    } finally {
      if (this.jobId === id) {
        this.jobId = null;
        this.progress.set(null);
      }
    }
  }

  cancel(): void {
    const id = this.jobId;
    if (id !== null) void this.api.cancel(id).catch(() => undefined);
  }
}
