import { Injectable, inject, signal } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError, toAppError } from '../../core/errors/app-error';
import { Plan, PlanApi } from '../../core/plan/plan-api';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { ConfirmService } from '../../shared/confirm';
import { needingConfirmation } from '../guard/guard-logic';
import { GuardService } from '../guard/guard.service';
import { QueryTab } from '../tabs/query-tab';
import { PLAN_TEXTS } from './plan-texts';

/** The plan on the screen: of which statement, and what the database said. */
export interface PlanView {
  readonly connectionId: string;
  readonly sql: string;
  readonly analyze: boolean;
  readonly loading: boolean;
  readonly plan: Plan | null;
  readonly error: string | null;
}

/**
 * Asks for plans (prompt 039). „With execution“ runs the statement: the user is told so and asked, and
 * the guard of the connection is asked like for any run – the backend decides and rolls back.
 */
@Injectable({ providedIn: 'root' })
export class PlanService {
  private readonly api = inject(PlanApi);
  private readonly queries = inject(QueryApi);
  private readonly guard = inject(GuardService);
  private readonly confirm = inject(ConfirmService);
  private readonly connections = inject(ConnectionsStore);
  private readonly settings = inject(SettingsService);
  /** Counts what was asked, so an older answer is dropped. */
  private asked = 0;

  readonly view = signal<PlanView | null>(null);

  close(): void {
    this.asked += 1;
    this.view.set(null);
  }

  /** Shows the plan of the statement under the caret of a tab (or of its selection). */
  async show(tab: QueryTab | null, analyze: boolean): Promise<void> {
    if (!tab) return;
    const sql = (await tab.currentStatement()).trim();
    const connectionId = tab.connectionId();
    if (sql === '') {
      this.view.set({
        connectionId,
        sql,
        analyze,
        loading: false,
        plan: null,
        error: PLAN_TEXTS.noStatement,
      });
      return;
    }
    await this.ask(connectionId, sql, analyze);
  }

  /** Asks again for the statement on the screen, estimated or with an execution. */
  async again(analyze: boolean): Promise<void> {
    const view = this.view();
    if (view && view.sql !== '') await this.ask(view.connectionId, view.sql, analyze);
  }

  private async ask(connectionId: string, sql: string, analyze: boolean): Promise<void> {
    const allow = !this.settings.settings().confirmDangerous;
    let token: string | null = null;
    if (analyze) {
      const t = PLAN_TEXTS;
      const yes = await this.confirm.ask({
        title: t.analyzeTitle,
        message: t.analyzeQuestion,
        confirm: t.analyzeYes,
      });
      if (!yes) return;
    }
    const mine = ++this.asked;
    const before = this.view();
    this.view.set({
      connectionId,
      sql,
      analyze,
      loading: true,
      // the plan before stays on the screen while the new one is fetched
      plan: before?.sql === sql ? before.plan : null,
      error: null,
    });
    try {
      if (analyze) {
        const verdicts = await this.queries.check(connectionId, [sql], allow);
        const guarded = needingConfirmation([sql], verdicts);
        if (guarded.length > 0) {
          const profile = this.connections.profiles().find((p) => p.id === connectionId);
          const answer = profile
            ? await this.guard.ask({ connection: profile, statements: guarded, total: 1 })
            : null;
          if (!answer) {
            if (mine === this.asked) this.view.set(before);
            return;
          }
          token = (await this.queries.confirm(connectionId, [sql], answer.typedName, allow))[0];
        }
      }
      const plan = await this.api.explain(
        connectionId,
        sql,
        analyze,
        token,
        allow,
        this.settings.settings().statementTimeoutSec * 1000,
      );
      if (mine === this.asked) {
        this.view.set({ connectionId, sql, analyze, loading: false, plan, error: null });
      }
    } catch (e) {
      if (mine === this.asked) {
        this.view.set({
          connectionId,
          sql,
          analyze,
          loading: false,
          plan: null,
          error: describeError(toAppError(e)),
        });
      }
    }
  }
}
