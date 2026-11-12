import { Injectable, inject, signal } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError } from '../../core/errors/app-error';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import {
  StructPlan,
  StructRan,
  StructRequest,
  StructureApi,
} from '../../core/structure/structure-api';
import { CompletionService } from '../completion/completion.service';
import { needingConfirmation } from '../guard/guard-logic';
import { GuardService } from '../guard/guard.service';
import { SchemaStore } from '../schema/schema.store';
import { TabsStore } from '../tabs/tabs.store';
import { scriptOf, statementsOf } from './structure-logic';

/** What the dialog is opened for. */
export interface StructTarget {
  readonly connectionId: string;
  readonly schema: string;
  /** The table; `null`: a new one. */
  readonly table: string | null;
  readonly mode: 'edit' | 'drop' | 'truncate' | 'duplicate';
}

/** How a run ended, for the dialog. */
export type RunOutcome =
  | { readonly kind: 'done'; readonly statements: number }
  | { readonly kind: 'declined' }
  | { readonly kind: 'failed'; readonly ran: StructRan; readonly of: number }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Editing the structure of tables (prompt 043): opens the dialog, and runs a plan – through the guard of
 * the connection like any statement that writes; the backend writes the statements again from the request
 * and decides. Afterwards the tree, the name index and the completion read the schema anew.
 */
@Injectable({ providedIn: 'root' })
export class StructureService {
  private readonly api = inject(StructureApi);
  private readonly queries = inject(QueryApi);
  private readonly guard = inject(GuardService);
  private readonly connections = inject(ConnectionsStore);
  private readonly settings = inject(SettingsService);
  private readonly schema = inject(SchemaStore);
  private readonly completion = inject(CompletionService);
  private readonly tabs = inject(TabsStore);

  readonly target = signal<StructTarget | null>(null);

  open(target: StructTarget): void {
    this.target.set(target);
  }

  close(): void {
    this.target.set(null);
  }

  /** Whether the structure can be changed on a connection: not on one that only reads. */
  canWrite(connectionId: string): boolean {
    const profile = this.connections.profiles().find((p) => p.id === connectionId);
    return profile?.protection !== 'readonly';
  }

  /** Runs the plan of a request. The user is asked first where the connection wants that. */
  async run(connectionId: string, request: StructRequest, plan: StructPlan): Promise<RunOutcome> {
    const statements = statementsOf(plan);
    if (statements.length === 0) return { kind: 'done', statements: 0 };
    const s = this.settings.settings();
    const allow = !s.confirmDangerous;
    try {
      let tokens: (string | null)[] = [];
      const verdicts = await this.queries.check(connectionId, statements, allow);
      const guarded = needingConfirmation(statements, verdicts);
      if (guarded.length > 0) {
        const profile = this.connections.profiles().find((p) => p.id === connectionId);
        if (!profile) return { kind: 'declined' };
        const answer = await this.guard.ask({
          connection: profile,
          statements: guarded,
          total: statements.length,
        });
        if (!answer) return { kind: 'declined' };
        tokens = await this.queries.confirm(connectionId, statements, answer.typedName, allow);
      }
      const ran = await this.api.apply(
        connectionId,
        request,
        tokens,
        allow,
        s.statementTimeoutSec * 1000,
      );
      // whatever ran changed the schema – also the part of a run that failed half way
      if (ran.failed === null || !ran.rolledBack) {
        this.schema.ran(connectionId, statements);
        this.completion.forget();
      }
      return ran.failed === null
        ? { kind: 'done', statements: ran.done }
        : { kind: 'failed', ran, of: statements.length };
    } catch (e) {
      return { kind: 'error', message: describeError(e) };
    }
  }

  /** The plan as a script in a new tab on the connection: to read, change and run by hand. */
  openScript(connectionId: string, plan: StructPlan, header: string): void {
    this.tabs.newTab(scriptOf(plan, header), { connection: connectionId });
  }
}
