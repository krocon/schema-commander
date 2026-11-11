import { ConfirmService } from '../../shared/confirm';
import { closeQuestion, txOpen } from './tx-logic';
import { GuardedStatement } from '../guard/guard-logic';
import { GuardService } from '../guard/guard.service';
import { HistoryService, RanStatement } from '../history/history.service';
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
  Group,
  Shown,
  Slot,
  SplitDirection,
  activate,
  afterClose,
  collapse,
  focusOther,
  isSplit,
  moveToOther,
  repair,
  restoreDirection,
  shownIn,
  unsplit,
} from './layout-logic';
import {
  autoTitle,
  backupDelay,
  cleanTitle,
  cycled,
  fileName,
  isUntitled,
  newTabId,
  untitled,
} from './tab-logic';
import { TABS_TEXTS } from './tabs-texts';

const SESSION_DELAY_MS = 400;
const MAX_CLOSED = 20;
/** The filters of the file dialogs, in the current language. */
const sqlFiles = () => [
  { name: 'SQL', extensions: ['sql'] },
  { name: TABS_TEXTS.allFiles, extensions: ['*'] },
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
  private readonly history = inject(HistoryService);
  private readonly guard = inject(GuardService);
  private readonly confirm = inject(ConfirmService);
  private readonly services = {
    api: inject(QueryApi),
    connections: this.connections,
    notify: (message: string) => this.notice.set(message),
    record: (ran: RanStatement) => this.history.record(ran),
    confirmRun: (connection: string, statements: readonly GuardedStatement[], total: number) => {
      const profile = this.connections.profiles().find((p) => p.id === connection);
      if (!profile) return Promise.resolve(null);
      return this.guard.ask({ connection: profile, statements, total });
    },
    ran: (connection: string, statements: readonly string[]) =>
      this.schema.ran(connection, statements),
    options: () => {
      const s = this.settings.settings();
      return {
        stopOnError: s.stopOnError,
        timeoutMs: s.statementTimeoutSec * 1000,
        allowDangerous: !s.confirmDangerous,
      };
    },
  };

  readonly tabs = signal<readonly QueryTab[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly active = computed(() => this.tabs().find((t) => t.id === this.activeId()) ?? null);
  /** The tab the other group of a split view shows (prompt 016); `null` while not split. */
  readonly otherId = signal<string | null>(null);
  /** How the two groups lie. */
  readonly splitDir = signal<SplitDirection>('row');
  private readonly slots = computed<Slot[]>(() =>
    this.tabs().map((t) => ({ id: t.id, group: t.group() })),
  );
  readonly isSplit = computed(() => isSplit(this.slots()));
  /** The tabs of both groups; the second is empty while the view is not split. */
  readonly groups = computed<readonly [readonly QueryTab[], readonly QueryTab[]]>(() => {
    const tabs = this.tabs();
    return [tabs.filter((t) => t.group() === 0), tabs.filter((t) => t.group() === 1)];
  });
  /** The tab each group shows. */
  readonly shownIds = computed<readonly [string | null, string | null]>(() => {
    const slots = this.slots();
    const shown = this.shown();
    return [shownIn(slots, shown, 0), shownIn(slots, shown, 1)];
  });
  /** The group with the focus: the one of the tab in front. */
  readonly focusedGroup = computed<Group>(() => this.active()?.group() ?? 0);
  /** The result fills its tab, the editor is out of sight (until asked back; not kept over a restart). */
  readonly resultMaximized = signal(false);
  /** The tab that is dragged, for both tab strips. */
  dragged: string | null = null;
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
    this.connections.onActivated((id) => {
      const tab = this.active();
      if (!tab || tab.connectionId() === id) return;
      if (txOpen(tab.tx())) {
        // the transaction belongs to the session on the old connection: it is ended first
        const old = tab.connectionId();
        this.notice.set(TABS_TEXTS.txBlocksSwitch);
        queueMicrotask(() => this.connections.activate(old));
        return;
      }
      tab.leaveSession();
      tab.connectionId.set(id);
    });
    effect(() => {
      const tab = this.active();
      if (tab) untracked(() => this.connections.activate(tab.connectionId()));
    });
    // A tab that is shown is built (its editor created) the first time it is looked at.
    effect(() => {
      const shown = this.shownIds();
      for (const tab of this.tabs()) if (shown.includes(tab.id)) tab.mounted.set(true);
    });
  }

  private session() {
    return {
      version: SESSION_VERSION,
      tabs: this.tabs().map((t) => t.meta()),
      active: this.activeId(),
      other: this.otherId(),
      split: this.splitDir(),
    };
  }

  private shown(): Shown {
    return { active: this.activeId(), other: this.otherId() };
  }

  /** Takes a new layout: the group of every tab and what the groups show. */
  private apply(layout: { slots: readonly Slot[]; shown: Shown }): void {
    const groups = new Map(layout.slots.map((s) => [s.id, s.group]));
    for (const tab of this.tabs()) tab.group.set(groups.get(tab.id) ?? 0);
    this.activeId.set(layout.shown.active);
    this.otherId.set(layout.shown.other);
  }

  /** Brings a tab to the front (its group gets the focus) after the tabs or groups changed. */
  private front(id: string | null): void {
    const slots = collapse(this.slots());
    const shown = repair(slots, this.shown());
    this.apply({ slots, shown: id === null ? shown : activate(slots, shown, id) });
  }

  /** Restores the tabs of the last run; always ends with at least one tab. */
  async load(): Promise<void> {
    let metas: readonly TabMeta[] = [];
    let active: string | null = null;
    let other: string | null = null;
    try {
      const loaded = await this.api.load();
      metas = loaded.session.tabs;
      active = loaded.session.active;
      other = loaded.session.other ?? null;
      this.splitDir.set(restoreDirection(loaded.session.split));
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
    this.activeId.set(active);
    this.otherId.set(other);
    // a stored layout may name what is gone: one group, the first tab
    this.front(null);
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
        // a new tab opens in the group that has the focus
        group: this.focusedGroup(),
        ...over,
      },
      this.services,
      text,
    );
    this.tabs.set([...tabs, tab]);
    this.front(id);
    if (text) this.backupNow(tab, text);
    return tab;
  }

  activate(id: string): void {
    if (id !== this.activeId() && this.tabs().some((t) => t.id === id)) this.front(id);
  }

  /** The next (`1`) or previous (`-1`) tab of the focused group, around the ends. */
  cycle(step: 1 | -1): void {
    const tabs = this.groups()[this.focusedGroup()];
    const index = cycled(
      tabs.findIndex((t) => t.id === this.activeId()),
      tabs.length,
      step,
    );
    if (index >= 0) this.front(tabs[index].id);
  }

  /**
   * Splits the view (prompt 016): the tab in front moves to a second group, beside (`row`) or below
   * (`column`). A view that is split already only changes how it lies. The only tab of the window gets a
   * new neighbour to move.
   */
  split(direction: SplitDirection): void {
    this.splitDir.set(direction);
    if (this.isSplit()) return;
    if (this.tabs().length < 2) this.newTab();
    const id = this.activeId();
    if (id) this.moveToOtherGroup(id);
  }

  /** Moves a tab to the other group, with the focus; the last tab of a group ends the split. */
  moveToOtherGroup(id: string): void {
    const layout = moveToOther(this.slots(), this.shown(), id);
    if (layout) this.apply(layout);
  }

  focusOtherGroup(): void {
    const shown = focusOther(this.slots(), this.shown());
    this.apply({ slots: this.slots(), shown });
    this.active()?.focus();
  }

  unsplit(): void {
    this.apply(unsplit(this.slots(), this.shown()));
  }

  /** Closes a tab without a question: it can be brought back, its text is kept until then. */
  /**
   * Before tabs with an open transaction go: commit, roll back, or stay. Resolves with `false` when the
   * user wants to stay, or when ending a transaction failed (the tab then shows why).
   */
  async settleTransactions(tabs: readonly QueryTab[], what: string): Promise<boolean> {
    const open = tabs.filter((t) => txOpen(t.tx()));
    if (open.length === 0) return true;
    const failed = open.every((t) => t.tx() === 'failed');
    const choice = await this.confirm.choose({
      title: TABS_TEXTS.openTransaction,
      message: closeQuestion(what, open.length),
      // a failed transaction can only be rolled back
      confirm: failed ? TABS_TEXTS.rollback : TABS_TEXTS.commit,
      second: failed ? undefined : TABS_TEXTS.rollback,
    });
    if (choice === 'no') return false;
    const commit = choice === 'yes' && !failed;
    for (const tab of open) {
      const problem = await tab.endTransaction(commit && tab.tx() !== 'failed');
      if (problem !== null) {
        this.services.notify(TABS_TEXTS.txNotEnded(problem));
        return false;
      }
    }
    return true;
  }

  async close(id: string): Promise<void> {
    const tabs = this.tabs();
    const index = tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const tab = tabs[index];
    if (!(await this.settleTransactions([tab], TABS_TEXTS.theTab(tab.title())))) return;
    this.cancelBackup(id);
    const text = (await tab.text().catch(() => null)) ?? (await this.startText(tab));
    // its statement stops and its results leave the store
    tab.dispose();
    this.closed.update((c) => [{ meta: tab.meta(), text, index }, ...c].slice(0, MAX_CLOSED));
    const rest = tabs.filter((t) => t.id !== id);
    // the neighbour in its group comes to the front; an emptied group ends the split
    const layout = afterClose(this.slots(), this.shown(), id);
    this.tabs.set(rest);
    this.apply(layout);
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
    this.front(tab.id);
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

  /** Puts a tab at a place of a group (its own unless told otherwise): how dragging reorders and moves. */
  move(id: string, to: number, group?: Group): void {
    const tab = this.tabs().find((t) => t.id === id);
    if (!tab) return;
    if (group !== undefined && group !== tab.group()) {
      const layout = moveToOther(this.slots(), this.shown(), id);
      if (!layout) return;
      this.apply(layout);
      // its group is empty now: the split is over, the order stays
      if (!this.isSplit()) return;
    }
    const rest = this.tabs().filter((t) => t !== tab);
    const peers = rest.filter((t) => t.group() === tab.group());
    const anchor = peers[Math.max(0, to)];
    const last = peers[peers.length - 1];
    const at = anchor ? rest.indexOf(anchor) : last ? rest.indexOf(last) + 1 : rest.length;
    this.tabs.set([...rest.slice(0, at), tab, ...rest.slice(at)]);
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
      const path = await this.files.openFile(TABS_TEXTS.openSqlFile, sqlFiles());
      chosen = path === null ? [] : [path];
    }
    for (const path of chosen.slice(0, 20)) {
      const open = this.tabs().find((t) => t.filePath() === path);
      if (open) {
        this.front(open.id);
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
              .trim() || TABS_TEXTS.untitled
          }.sql`;
      path = await this.files.saveFile(TABS_TEXTS.saveSqlFile, suggested, sqlFiles());
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
      this.notice.set(TABS_TEXTS.savedAsUtf8(fileName(path)));
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
    else if (!isUntitled(tab.title())) {
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
