import { Injectable, computed, inject, signal } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError } from '../../core/errors/app-error';
import { McpApi, McpEvent, McpLogEntry, McpProbe, McpStatus } from '../../core/mcp/mcp-api';
import { AiSettings } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { TabsStore } from '../tabs/tabs.store';
import {
  ERROR_CHARS,
  MAX_AI_TABS,
  Proposal,
  configOf,
  expired,
  proposalOf,
  withEntry,
} from './mcp-logic';
import { MCP_TEXTS } from './mcp-texts';

const OFF: McpStatus = { running: false, connections: 0, sidecar: '', sidecarFound: false };

/**
 * AI control over MCP (prompt 048). Off unless the user turns it on; what an assistant may do is decided
 * and enforced in the backend – this service turns the bridge on and off, hands it the settings, keeps
 * the protocol of calls (in memory) and answers what the backend asks the window: text for a tab, and
 * proposals, one at a time. A proposal the user accepts runs in a tab like a statement the user typed.
 */
@Injectable({ providedIn: 'root' })
export class McpService {
  private readonly api = inject(McpApi);
  private readonly settings = inject(SettingsService);
  private readonly tabs = inject(TabsStore);
  private readonly connections = inject(ConnectionsStore);

  /** The dialog of AI control is open. */
  readonly open = signal(false);
  readonly status = signal<McpStatus>(OFF);
  readonly log = signal<readonly McpLogEntry[]>([]);
  readonly problem = signal('');
  readonly probe = signal<McpProbe | null>(null);
  readonly testing = signal(false);
  /** Proposals that wait for the user; the first one is on screen. */
  private readonly proposals = signal<readonly Proposal[]>([]);
  readonly proposal = computed(() => this.proposals()[0] ?? null);
  /** The proposal on screen, as a list: the template makes a dialog of its own for each. */
  readonly shownProposals = computed(() => this.proposals().slice(0, 1));
  /** Tabs assistants opened in this run of the app. */
  private aiTabs = 0;
  readonly ai = computed(() => this.settings.settings().ai);
  private subscribed = false;

  /** At the start of the app: on again if the user had it on. */
  async init(): Promise<void> {
    if (this.ai().enabled) await this.start();
    else await this.refresh();
  }

  private async subscribe(): Promise<void> {
    if (this.subscribed) return;
    this.subscribed = true;
    try {
      await this.api.subscribe((event) => this.onEvent(event));
    } catch {
      this.subscribed = false;
    }
  }

  private async start(): Promise<void> {
    try {
      await this.subscribe();
      this.status.set(await this.api.start(configOf(this.ai())));
      this.problem.set('');
    } catch (e) {
      this.problem.set(describeError(e));
    }
  }

  async refresh(): Promise<void> {
    try {
      this.status.set(await this.api.status());
    } catch {
      this.status.set(OFF);
    }
  }

  /** Turns AI control on or off – and remembers it. */
  async setEnabled(enabled: boolean): Promise<void> {
    this.settings.update({ ai: { ...this.ai(), enabled } });
    this.probe.set(null);
    if (enabled) {
      await this.start();
      return;
    }
    try {
      this.status.set(await this.api.stop());
    } catch (e) {
      this.problem.set(describeError(e));
    }
    // nothing waits for an answer any more
    this.proposals.set([]);
  }

  /** Changes what an assistant may do; the backend enforces it from the next call on. */
  async update(ai: AiSettings): Promise<void> {
    this.settings.update({ ai });
    try {
      await this.api.configure(configOf(ai));
      this.problem.set('');
    } catch (e) {
      // the backend still holds the old rules: say so rather than show new ones that do not count
      if (ai.enabled) this.problem.set(describeError(e));
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.api.disconnect();
    } catch (e) {
      this.problem.set(describeError(e));
    }
  }

  async test(): Promise<void> {
    if (this.testing()) return;
    this.testing.set(true);
    this.probe.set(null);
    try {
      this.probe.set(await this.api.test());
    } catch (e) {
      this.problem.set(describeError(e));
    } finally {
      this.testing.set(false);
    }
  }

  clearLog(): void {
    this.log.set([]);
  }

  private onEvent(event: McpEvent): void {
    switch (event.kind) {
      case 'status':
        this.status.update((s) => ({ ...s, connections: event.connections }));
        return;
      case 'call':
        this.log.update((log) => withEntry(log, event.entry));
        return;
      case 'request':
        this.onRequest(event.id, event.tool, event.args);
    }
  }

  private onRequest(id: number, tool: string, args: Readonly<Record<string, unknown>>): void {
    if (tool === 'write_to_tab' && typeof args['text'] === 'string') {
      const connection = typeof args['connection'] === 'string' ? args['connection'] : null;
      if (this.aiTabs >= MAX_AI_TABS) {
        void this.api.reply(id, null, {
          code: 'limit_exceeded',
          message: `at most ${MAX_AI_TABS} tabs – the user closes some first`,
        });
        return;
      }
      this.aiTabs++;
      // text into a tab: nothing runs
      this.tabs.newTab(args['text'], connection ? { connection } : {});
      void this.api.reply(id, { opened: true });
      return;
    }
    const proposal = tool === 'propose_query' ? proposalOf(id, args) : null;
    if (!proposal) {
      void this.api.reply(id, null, { code: 'invalid_args', message: 'not understood' });
      return;
    }
    this.proposals.update((all) => [...all, proposal]);
  }

  /**
   * What the assistant hears of an error: the start of it – an error can quote values –, and only that
   * there was one where the user shares no data.
   */
  private errorFor(message: string | null): string | null {
    if (message === null) return null;
    return this.ai().structureOnly ? 'the statement failed' : message.slice(0, ERROR_CHARS);
  }

  /** The name of the connection of a proposal, as the user knows it. */
  connectionName(proposal: Proposal): string {
    return (
      this.connections.profiles().find((p) => p.id === proposal.connectionId)?.name ??
      MCP_TEXTS.unknownConnection
    );
  }

  /**
   * The user's answer to the proposal on screen. `run`: it runs in a new tab, through the guard of the
   * connection like any statement; `tab`: it is only put into a tab; `decline`: nothing happens.
   */
  async answer(choice: 'run' | 'tab' | 'decline'): Promise<void> {
    const proposal = this.proposal();
    if (!proposal) return;
    this.proposals.update((all) => all.slice(1));
    if (choice === 'decline') {
      await this.api.reply(proposal.id, { accepted: false });
      return;
    }
    // the assistant stopped waiting: what it no longer expects does not run
    if (expired(proposal, Date.now())) {
      this.problem.set(MCP_TEXTS.proposalExpired);
      await this.api.reply(proposal.id, { accepted: false });
      return;
    }
    const tab = this.tabs.newTab(proposal.sql, { connection: proposal.connectionId });
    if (choice === 'tab') {
      await this.api.reply(proposal.id, { accepted: false, opened_in_tab: true });
      return;
    }
    try {
      await tab.run(proposal.sql);
      const runs = tab.runs();
      const failed = runs.find((r) => r.kind === 'failed');
      const done = runs.filter((r) => r.kind === 'done');
      await this.api.reply(proposal.id, {
        accepted: true,
        // the user may still have said no to the guard of the connection
        ran: done.length > 0 && !failed,
        rows_affected: done.reduce<number | null>(
          (sum, r) => (r.rowsAffected === null ? sum : (sum ?? 0) + r.rowsAffected),
          null,
        ),
        error: this.errorFor(failed?.message ?? null),
      });
    } catch (e) {
      await this.api.reply(proposal.id, {
        accepted: true,
        ran: false,
        error: this.errorFor(describeError(e)),
      });
    }
  }
}
