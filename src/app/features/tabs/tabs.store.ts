import { SchemaStore } from '../schema/schema.store';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError, toAppError } from '../../core/errors/app-error';
import { SESSION_VERSION, SessionApi, TabMeta } from '../../core/session/session-api';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { QueryTab } from './query-tab';
import {
  autoTitle,
  backupDelay,
  cleanTitle,
  cycled,
  fileName,
  moved,
  neighbour,
  newTabId,
  untitled,
} from './tab-logic';

const SESSION_DELAY_MS = 400;
const MAX_CLOSED = 20;
const SQL_FILES = [
  { name: 'SQL', extensions: ['sql'] },
  { name: 'Alle Dateien', extensions: ['*'] },
];

/** A closed tab that can come back: what it was and its text. */
interface Closed {
  readonly meta: TabMeta;
  readonly text: string;
  readonly index: number;
}

/**
 * The query tabs of the window (prompt 004): which there are, which is in front, and their life over a
 * restart. Nothing ever asks „save?“: the text of every tab is backed up a moment after each change and is
 * there again at the next start – also after a crash. Tabs are addressed by id.
 */
@Injectable({ providedIn: 'root' })
export class TabsStore {
  private readonly api = inject(SessionApi);
  private readonly files = inject(FileDialogApi);
  private readonly connections = inject(ConnectionsStore);
  private readonly settings = inject(SettingsService);
  private readonly schema = inject(SchemaStore);
  private readonly services = {
    api: inject(QueryApi),
    connections: this.connections,
    ran: (connection: string, statements: readonly string[]) =>
      this.schema.ran(connection, statements),
    options: () => {
      const s = this.settings.settings();
      return { stopOnError: s.stopOnError, timeoutMs: s.statementTimeoutSec * 1000 };
    },
  };

  readonly tabs = signal<readonly QueryTab[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly active = computed(() => this.tabs().find((t) => t.id === this.activeId()) ?? null);
  /** What the store has to say (broken session, a file that could not be read or written). */
  readonly notice = signal<string | null>(null);
  readonly canReopen = computed(() => this.closed().length > 0);

  private readonly closed = signal<readonly Closed[]>([]);
  private readonly loaded = signal(false);
  private readonly textTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // The session is written a moment after anything of it changed.
    effect(() => {
      const session = this.session();
      if (this.loaded()) untracked(() => this.scheduleSession(session));
    });
    // The tab in front and the connection shown as active are the same thing, both ways: a connection
    // chosen in the list goes to the tab in front at once (no effect: a tab switch in the same turn must
    // not undo the choice), and a tab that comes to the front shows its connection as the active one.
    this.connections.onActivated((id) => this.active()?.connectionId.set(id));
    effect(() => {
      const tab = this.active();
      if (tab) untracked(() => this.connections.activate(tab.connectionId()));
    });
    // The tab in front is built (its editor created) the first time it is looked at.
    effect(() => {
      this.active()?.mounted.set(true);
    });
  }

  private session() {
    return {
      version: SESSION_VERSION,
      tabs: this.tabs().map((t) => t.meta()),
      active: this.activeId(),
    };
  }

  /** Restores the tabs of the last run; always ends with at least one tab. */
  async load(): Promise<void> {
    let metas: readonly TabMeta[] = [];
    let active: string | null = null;
    try {
      const loaded = await this.api.load();
      metas = loaded.session.tabs;
      active = loaded.session.active;
      this.notice.set(loaded.notice);
    } catch (e) {
      // no backend (browser, tests without a fake): one empty tab, nothing is kept
      console.warn('the session could not be loaded', e);
    }
    const known = new Set(this.connections.profiles().map((p) => p.id));
    const tabs = metas.map(
      (m) =>
        new QueryTab(
          { ...m, connection: m.connection && known.has(m.connection) ? m.connection : 'demo' },
          this.services,
        ),
    );
    this.tabs.set(tabs);
    this.activeId.set(tabs.some((t) => t.id === active) ? active : (tabs[0]?.id ?? null));
    if (tabs.length === 0) this.newTab();
    this.loaded.set(true);
  }

  /** The text a tab starts with: what it was created with, else its backup. */
  async startText(tab: QueryTab): Promise<string> {
    if (tab.startText !== null) return tab.startText;
    try {
      return await this.api.loadText(tab.id);
    } catch (e) {
      if (toAppError(e).code !== 'backend_unavailable') this.notice.set(describeError(e));
      return '';
    }
  }

  newTab(text = '', over: Partial<TabMeta> = {}): QueryTab {
    const tabs = this.tabs();
    const id = newTabId(
      new Set([...tabs.map((t) => t.id), ...this.closed().map((c) => c.meta.id)]),
    );
    const tab = new QueryTab(
      {
        id,
        title: untitled(new Set(tabs.map((t) => t.title()))),
        customTitle: false,
        connection: this.active()?.connectionId() ?? this.connections.activeId(),
        filePath: null,
        encoding: null,
        ...over,
      },
      this.services,
      text,
    );
    this.tabs.set([...tabs, tab]);
    this.activeId.set(id);
    if (text) this.backupNow(tab, text);
    return tab;
  }

  activate(id: string): void {
    if (this.tabs().some((t) => t.id === id)) this.activeId.set(id);
  }

  /** The next (`1`) or previous (`-1`) tab, around the ends. */
  cycle(step: 1 | -1): void {
    const tabs = this.tabs();
    const index = cycled(
      tabs.findIndex((t) => t.id === this.activeId()),
      tabs.length,
      step,
    );
    if (index >= 0) this.activeId.set(tabs[index].id);
  }

  /** Closes a tab without a question: it can be brought back, its text is kept until then. */
  async close(id: string): Promise<void> {
    const tabs = this.tabs();
    const index = tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const tab = tabs[index];
    this.cancelBackup(id);
    const text = (await tab.text().catch(() => null)) ?? (await this.startText(tab));
    // its statement stops and its results leave the store
    tab.dispose();
    this.closed.update((c) => [{ meta: tab.meta(), text, index }, ...c].slice(0, MAX_CLOSED));
    const rest = tabs.filter((t) => t.id !== id);
    if (this.activeId() === id) {
      const next = neighbour(index, tabs.length);
      this.activeId.set(next < 0 ? null : tabs[next].id);
    }
    this.tabs.set(rest);
    void this.api.deleteText(id).catch(() => undefined);
    // the window always has a tab
    if (rest.length === 0) this.newTab();
  }

  async closeOthers(id: string): Promise<void> {
    for (const tab of this.tabs().filter((t) => t.id !== id)) await this.close(tab.id);
  }

  /** Brings back the tab closed last, where it was. */
  reopen(): void {
    const [last, ...rest] = this.closed();
    if (!last) return;
    this.closed.set(rest);
    const taken = new Set(this.tabs().map((t) => t.id));
    const meta = taken.has(last.meta.id) ? { ...last.meta, id: newTabId(taken) } : last.meta;
    const tab = new QueryTab(meta, this.services, last.text);
    const tabs = [...this.tabs()];
    tabs.splice(Math.min(last.index, tabs.length), 0, tab);
    this.tabs.set(tabs);
    this.activeId.set(tab.id);
    this.backupNow(tab, last.text);
  }

  /** A second tab with the same text and connection. */
  async duplicate(id: string): Promise<void> {
    const tab = this.tabs().find((t) => t.id === id);
    if (!tab) return;
    const text = (await tab.text()) ?? (await this.startText(tab));
    this.newTab(text, { connection: tab.connectionId() });
  }

  /** Names a tab; an empty name gives the title back to the text. */
  rename(id: string, raw: string): void {
    const tab = this.tabs().find((t) => t.id === id);
    if (!tab) return;
    const title = cleanTitle(raw);
    tab.customTitle.set(title !== null);
    if (title !== null) tab.title.set(title);
    else void tab.text().then((text) => this.retitle(tab, text ?? ''));
  }

  move(id: string, to: number): void {
    const tabs = this.tabs();
    this.tabs.set(
      moved(
        tabs,
        tabs.findIndex((t) => t.id === id),
        to,
      ),
    );
  }

  /** The editor of a tab says its text changed: the backup follows a moment later. */
  textChanged(tab: QueryTab, chars: number, dirty: boolean): void {
    tab.chars.set(chars);
    tab.dirty.set(dirty);
    this.cancelBackup(tab.id);
    this.textTimers.set(
      tab.id,
      setTimeout(() => void this.backup(tab), backupDelay(chars)),
    );
  }

  /** Writes the backup of every tab that waits for one (the window goes to the background or closes). */
  flush(): void {
    for (const id of [...this.textTimers.keys()]) {
      const tab = this.tabs().find((t) => t.id === id);
      this.cancelBackup(id);
      if (tab) void this.backup(tab);
    }
  }

  /** Opens `.sql` files in new tabs; a file that is open already comes to the front. */
  async openFiles(paths?: readonly string[]): Promise<void> {
    let chosen = paths;
    if (!chosen) {
      const path = await this.files.openFile('SQL-Datei öffnen', SQL_FILES);
      chosen = path === null ? [] : [path];
    }
    for (const path of chosen.slice(0, 20)) {
      const open = this.tabs().find((t) => t.filePath() === path);
      if (open) {
        this.activeId.set(open.id);
        continue;
      }
      try {
        const file = await this.api.readFile(path);
        this.newTab(file.text, {
          title: fileName(path),
          customTitle: true,
          filePath: path,
          encoding: file.encoding,
        });
      } catch (e) {
        this.notice.set(`${fileName(path)}: ${describeError(e)}`);
      }
    }
  }

  /** Writes a tab to its file, asking for one first when it has none (or `as` is set). */
  async save(id: string, as = false): Promise<void> {
    const tab = this.tabs().find((t) => t.id === id);
    if (!tab) return;
    const text = (await tab.text()) ?? (await this.startText(tab));
    let path = tab.filePath();
    if (as || path === null) {
      const suggested = path
        ? fileName(path)
        : `${
            tab
              .title()
              .replace(/[\\/:*?"<>|]+/g, ' ')
              .trim() || 'Abfrage'
          }.sql`;
      path = await this.files.saveFile('SQL-Datei speichern', suggested, SQL_FILES);
      if (path === null) return;
    }
    const encoding = tab.encoding() ?? 'utf-8';
    try {
      await this.write(path, text, encoding, tab);
    } catch (e) {
      this.notice.set(`${fileName(path)}: ${describeError(e)}`);
    }
  }

  private async write(path: string, text: string, encoding: string, tab: QueryTab): Promise<void> {
    try {
      await this.api.writeFile(path, text, encoding);
      tab.encoding.set(encoding);
    } catch (e) {
      if (toAppError(e).code !== 'encoding_failed') throw e;
      // the old encoding cannot hold the text: UTF-8 can, and the user is told
      await this.api.writeFile(path, text, 'utf-8');
      tab.encoding.set('utf-8');
      this.notice.set(
        `${fileName(path)} wurde als UTF-8 gespeichert: Die bisherige Kodierung kann nicht alle Zeichen des Textes darstellen.`,
      );
    }
    tab.filePath.set(path);
    tab.title.set(fileName(path));
    tab.customTitle.set(true);
    tab.dirty.set(false);
  }

  private async backup(tab: QueryTab): Promise<void> {
    this.textTimers.delete(tab.id);
    const text = await tab.text().catch(() => null);
    if (text === null || !this.tabs().includes(tab)) return;
    this.retitle(tab, text);
    await this.api.saveText(tab.id, text).catch((e) => {
      if (toAppError(e).code !== 'backend_unavailable') this.notice.set(describeError(e));
    });
  }

  private backupNow(tab: QueryTab, text: string): void {
    this.retitle(tab, text);
    void this.api.saveText(tab.id, text).catch(() => undefined);
  }

  private retitle(tab: QueryTab, text: string): void {
    if (tab.customTitle()) return;
    const title = autoTitle(text);
    if (title !== null) tab.title.set(title);
    else if (!tab.title().startsWith('Abfrage')) {
      tab.title.set(untitled(new Set(this.tabs().map((t) => t.title()))));
    }
  }

  private cancelBackup(id: string): void {
    const timer = this.textTimers.get(id);
    if (timer) clearTimeout(timer);
    this.textTimers.delete(id);
  }

  private scheduleSession(session: ReturnType<TabsStore['session']>): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null;
      void this.api.save(session).catch(() => undefined);
    }, SESSION_DELAY_MS);
  }
}
