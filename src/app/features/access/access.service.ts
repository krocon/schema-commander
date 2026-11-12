import { Injectable, computed, inject, signal } from '@angular/core';
import {
  Access,
  AccessApi,
  AccessChange,
  AccessPlan,
  GrantList,
  Who,
} from '../../core/access/access-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError } from '../../core/errors/app-error';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { needingConfirmation } from '../guard/guard-logic';
import { GuardService } from '../guard/guard.service';
import { TabsStore } from '../tabs/tabs.store';
import { Pending, labelOf, likeChanges, queued, sameWho } from './access-logic';
import { ACCESS_TEXTS } from './access-texts';

/**
 * Users, roles and their rights (prompt 047), for one connection at a time. Changes wait in a list and
 * are shown as the statements the backend writes for them; they run through the guard of the connection
 * like any statement that writes. A password waits beside its change – never in a statement that is
 * shown – and is gone once the changes ran, were taken back or the dialog closed.
 */
@Injectable({ providedIn: 'root' })
export class AccessService {
  private readonly api = inject(AccessApi);
  private readonly queries = inject(QueryApi);
  private readonly guard = inject(GuardService);
  private readonly connections = inject(ConnectionsStore);
  private readonly settings = inject(SettingsService);
  private readonly tabs = inject(TabsStore);

  /** The connection whose users are shown; `null`: closed. */
  readonly connectionId = signal<string | null>(null);
  readonly access = signal<Access | null>(null);
  readonly selected = signal<Who | null>(null);
  readonly grants = signal<GrantList | null>(null);
  readonly pending = signal<readonly Pending[]>([]);
  readonly plan = signal<AccessPlan | null>(null);
  /** The changes the plan on screen was written for: only they may run (review 047 L7). */
  private plannedFor: readonly Pending[] | null = null;
  /** The plan is being written anew: nothing runs meanwhile. */
  readonly planning = signal(false);
  readonly busy = signal(false);
  readonly running = signal(false);
  readonly problem = signal('');
  readonly planProblem = signal('');
  /** How the last run ended. */
  readonly note = signal('');
  private asked = 0;
  /** Counts the choices: the rights of an earlier choice are dropped. */
  private chosen = 0;
  private planned = 0;

  readonly profile = computed(
    () => this.connections.profiles().find((p) => p.id === this.connectionId()) ?? null,
  );
  /** Whether anything can be changed: the user may manage, and the connection does not only read. */
  readonly canChange = computed(
    () => (this.access()?.canManage ?? false) && this.profile()?.protection !== 'readonly',
  );

  open(connectionId: string): void {
    this.close();
    this.connectionId.set(connectionId);
    void this.reload();
  }

  close(): void {
    this.asked++;
    this.chosen++;
    this.planned++;
    this.plannedFor = null;
    this.planning.set(false);
    this.connectionId.set(null);
    this.access.set(null);
    this.selected.set(null);
    this.grants.set(null);
    this.pending.set([]);
    this.plan.set(null);
    this.busy.set(false);
    this.running.set(false);
    this.problem.set('');
    this.planProblem.set('');
    this.note.set('');
  }

  /** Reads users and roles again; the choice stays where it is still there. */
  async reload(): Promise<void> {
    const id = this.connectionId();
    if (id === null) return;
    const asked = ++this.asked;
    this.busy.set(true);
    try {
      const access = await this.api.list(id);
      if (asked !== this.asked) return;
      this.access.set(access);
      this.problem.set('');
      const before = this.selected();
      const still = before && access.principals.find((p) => sameWho(p.who, before));
      const next = still ?? access.principals.find((p) => p.me) ?? access.principals[0] ?? null;
      await this.select(next?.who ?? null);
    } catch (e) {
      if (asked === this.asked) this.problem.set(describeError(e));
    } finally {
      if (asked === this.asked) this.busy.set(false);
    }
  }

  async select(who: Who | null): Promise<void> {
    const id = this.connectionId();
    this.selected.set(who);
    this.grants.set(null);
    const chosen = ++this.chosen;
    if (id === null || who === null) return;
    try {
      const grants = await this.api.grants(id, who);
      if (chosen === this.chosen) this.grants.set(grants);
    } catch (e) {
      if (chosen === this.chosen) this.problem.set(describeError(e));
    }
  }

  /** Adds a change to those that wait (or takes back the one it undoes) and writes the plan anew. */
  queue(change: AccessChange, password: string | null = null): void {
    if (!this.canChange()) return;
    this.pending.update((p) => queued(p, { change, password }));
    void this.replan();
  }

  unqueue(index: number): void {
    this.pending.update((p) => p.filter((_, i) => i !== index));
    void this.replan();
  }

  clear(): void {
    this.pending.set([]);
    void this.replan();
  }

  private changes(): AccessChange[] {
    return this.pending().map((p) => p.change);
  }

  private async replan(): Promise<void> {
    const id = this.connectionId();
    const planned = ++this.planned;
    this.note.set('');
    const pending = this.pending();
    this.plannedFor = null;
    if (id === null || pending.length === 0) {
      this.plan.set(null);
      this.planProblem.set('');
      this.planning.set(false);
      return;
    }
    this.planning.set(true);
    try {
      const plan = await this.api.plan(id, this.changes());
      if (planned !== this.planned) return;
      this.plan.set(plan);
      this.plannedFor = pending;
      this.planProblem.set('');
    } catch (e) {
      if (planned !== this.planned) return;
      this.plan.set(null);
      this.planProblem.set(describeError(e));
    } finally {
      if (planned === this.planned) this.planning.set(false);
    }
  }

  /** Runs what waits. The user is asked first where the connection wants that. */
  async apply(): Promise<void> {
    const id = this.connectionId();
    const plan = this.plan();
    const profile = this.profile();
    if (id === null || !plan || !profile || this.running() || !this.canChange()) return;
    const t = ACCESS_TEXTS;
    const pending = this.pending();
    // only what is on screen runs: not a change whose statement was not written yet
    if (this.planning() || this.plannedFor !== pending) return;
    const statements = plan.steps.map((s) => s.sql);
    const allow = !this.settings.settings().confirmDangerous;
    this.running.set(true);
    this.note.set('');
    try {
      let tokens: (string | null)[] = [];
      const verdicts = await this.queries.check(id, statements, allow);
      const guarded = needingConfirmation(statements, verdicts);
      if (guarded.length > 0) {
        const answer = await this.guard.ask({
          connection: profile,
          statements: guarded,
          total: statements.length,
        });
        if (!answer) {
          this.note.set(t.declined);
          return;
        }
        tokens = await this.queries.confirm(id, statements, answer.typedName, allow);
      }
      if (this.connectionId() !== id) return;
      const ran = await this.api.apply(
        id,
        pending.map((p) => p.change),
        pending.map((p) => p.password),
        tokens,
        allow,
      );
      if (this.connectionId() !== id) return;
      if (ran.failed === null) {
        this.note.set(t.done(ran.done));
        // the passwords go with the changes
        this.pending.set([]);
        this.plan.set(null);
      } else {
        const reason = ran.error ? describeError(ran.error) : '';
        const rest = ran.rolledBack ? t.rolledBack : t.partly(ran.failed);
        let note = `${t.failed(ran.failed + 1, statements.length, reason)} ${rest}`;
        // a password does not wait for a second try (review 047 L8)
        if (pending.some((p) => p.password !== null)) {
          this.pending.update((all) => all.filter((p) => p.password === null));
          note = `${note} ${t.passwordsGone}`;
        }
        this.note.set(note);
      }
      await this.reload();
      const note = this.note();
      await this.replan();
      this.note.set(note);
    } catch (e) {
      this.note.set(describeError(e));
    } finally {
      this.running.set(false);
    }
  }

  /** The rights a principal holds itself as a script in a new tab on the connection. */
  async script(who: Who): Promise<void> {
    const id = this.connectionId();
    if (id === null) return;
    try {
      const text = await this.api.script(id, who);
      // a name of the server in a comment: nothing in it may end the line
      const name = [...labelOf(who)].map((c) =>
        c < ' ' || c === '\u2028' || c === '\u2029' ? ' ' : c,
      );
      this.tabs.newTab(`${ACCESS_TEXTS.scriptHeader(name.join(''))}\n${text}`, {
        connection: id,
      });
    } catch (e) {
      this.problem.set(describeError(e));
    }
  }

  /** "Rights like": what `source` holds itself and the chosen principal does not, as changes that wait. */
  async like(source: Who): Promise<void> {
    const id = this.connectionId();
    const to = this.selected();
    const profile = this.profile();
    const mine = this.grants();
    if (id === null || !to || !profile || !mine || !this.canChange()) return;
    try {
      const theirs = await this.api.grants(id, source);
      if (this.connectionId() !== id || this.selected() !== to) return;
      const changes = likeChanges(profile.kind, to, theirs.grants, mine.grants);
      if (changes.length === 0) {
        this.note.set(ACCESS_TEXTS.likeNothing(labelOf(source)));
        return;
      }
      this.pending.update((p) =>
        changes.reduce<Pending[]>((all, change) => queued(all, { change, password: null }), [...p]),
      );
      await this.replan();
    } catch (e) {
      this.problem.set(describeError(e));
    }
  }
}
