import { computed, signal } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError, toAppError } from '../../core/errors/app-error';
import { TabMeta } from '../../core/session/session-api';
import { QueryApi } from '../../core/sql/query-api';
import { QueryResult } from '../../core/sql/query.models';
import { EdCaret } from '../editor/editlicious';
import { RunState } from './run-state';

/** What a tab needs of its editor; the pane of the tab registers it. */
export interface TabEditor {
  getText(): Promise<string>;
  setText(text: string): Promise<void>;
  focus(): void;
  /** Runs the statement under the caret. */
  runCurrent(): Promise<void>;
}

/** The services a tab works with (handed in by the `TabsStore`, tabs are no injectables). */
export interface TabServices {
  readonly api: QueryApi;
  readonly connections: ConnectionsStore;
}

/**
 * A query tab (prompt 004): its title, connection, the outcome of its last statement and its editor. One
 * instance per tab, addressed by id. A statement started while another runs wins; the answer of the older
 * one is dropped.
 */
export class QueryTab {
  readonly id: string;
  readonly title = signal('');
  /** The user named the tab: the title no longer follows its text. */
  readonly customTitle = signal(false);
  /** The profile statements run on. */
  readonly connectionId = signal('demo');
  readonly filePath = signal<string | null>(null);
  readonly encoding = signal<string | null>(null);

  readonly state = signal<RunState>({ kind: 'idle' });
  readonly caret = signal<EdCaret | null>(null);
  /** The tab was shown once: its editor exists (tabs restored at the start are built when first looked at). */
  readonly mounted = signal(false);
  /** The text changed since it was loaded or written to its file. Only tabs with a file show it. */
  readonly dirty = signal(false);
  /** Characters of the text, as far as the editor told (for the pace of the backup). */
  readonly chars = signal(0);

  readonly running = computed(() => this.state().kind === 'running');

  private editor: TabEditor | null = null;
  private runId = 0;
  private runningOn: string | null = null;

  constructor(
    meta: TabMeta,
    private readonly services: TabServices,
    /** A text the tab starts with instead of its backup (new tab from a file, duplicate). */
    readonly startText: string | null = null,
  ) {
    this.id = meta.id;
    this.title.set(meta.title);
    this.customTitle.set(meta.customTitle);
    this.connectionId.set(meta.connection ?? 'demo');
    this.filePath.set(meta.filePath);
    this.encoding.set(meta.encoding);
  }

  meta(): TabMeta {
    return {
      id: this.id,
      title: this.title(),
      customTitle: this.customTitle(),
      connection: this.connectionId(),
      filePath: this.filePath(),
      encoding: this.encoding(),
    };
  }

  attach(editor: TabEditor): void {
    this.editor = editor;
  }

  detach(editor: TabEditor): void {
    if (this.editor === editor) this.editor = null;
  }

  /** The text of the editor; `null` while the tab has none (never shown). */
  text(): Promise<string | null> {
    return this.editor ? this.editor.getText() : Promise.resolve(null);
  }

  focus(): void {
    this.editor?.focus();
  }

  runCurrent(): void {
    void this.editor?.runCurrent();
  }

  /** Runs a statement on the tab's connection, opening it first when it is closed. */
  async run(sql: string): Promise<void> {
    const { connections } = this.services;
    const id = ++this.runId;
    const connection = this.connectionId();
    const latest = () => id === this.runId;
    this.state.set({ kind: 'running', sql });
    this.runningOn = connection;
    try {
      if (!(await connections.connect(connection))) {
        if (latest()) {
          const state = connections.state(connection);
          this.state.set(
            state.kind === 'failed'
              ? { kind: 'failed', sql, message: state.message }
              : // the password dialog was dismissed
                { kind: 'cancelled', sql },
          );
        }
        return;
      }
      const result = await this.runOnce(connection, sql);
      if (latest()) this.state.set({ kind: 'done', sql, result });
    } catch (e) {
      const error = toAppError(e);
      // cancelled, timed out or broken: the backend dropped the connection
      if (error.code !== 'invalid_query' && error.code !== 'permission_denied') {
        connections.markClosed(connection);
      }
      if (!latest()) return;
      this.state.set(
        error.code === 'cancelled'
          ? { kind: 'cancelled', sql }
          : { kind: 'failed', sql, message: describeError(error) },
      );
    } finally {
      if (latest()) this.runningOn = null;
    }
  }

  /** Asks the backend to stop the statement that runs. */
  cancel(): void {
    if (this.runningOn !== null) {
      void this.services.api.cancel(this.runningOn).catch(() => undefined);
    }
  }

  /** The connection was open in the store but the backend lost it: open it again, once. */
  private async runOnce(connection: string, sql: string): Promise<QueryResult> {
    const { api, connections } = this.services;
    try {
      return await api.run(connection, sql);
    } catch (e) {
      if (toAppError(e).code !== 'not_connected') throw e;
      connections.markClosed(connection);
      if (!(await connections.connect(connection))) throw e;
      return api.run(connection, sql);
    }
  }
}
