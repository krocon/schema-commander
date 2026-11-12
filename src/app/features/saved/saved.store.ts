import { dialectOf as sqlDialectOf } from '../../core/connections/connection.models';
import { Injectable, computed, inject, signal } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError } from '../../core/errors/app-error';
import { SavedApi, SavedEntry, SavedListing, SavedQuery } from '../../core/saved/saved-api';
import { SettingsService } from '../../core/settings/settings.service';
import { Dialect, splitForRun } from '../editor/sql-split';
import { pushRecent } from '../palette/palette-logic';
import { TabsStore } from '../tabs/tabs.store';
import { MAX_RECENT_SAVED, SavedForm, cleanFolder, metaOf } from './saved-logic';
import { SAVED_TEXTS } from './saved-texts';

/** What the dialog is open for: a text to save, or a saved query whose properties are edited. */
export type SaveRequest =
  | { readonly kind: 'new'; readonly text: string; readonly name: string }
  | { readonly kind: 'edit'; readonly entry: SavedEntry };

/** How often the folder is looked at for changes made outside, while someone watches. */
const WATCH_MS = 3000;

/**
 * The saved queries of the window (prompt 024): the listing of the folder, kept fresh while the view is on
 * screen, and what can be done with a query. The files belong to the backend; a query that is opened becomes
 * an ordinary file tab (prompt 004) – saving the tab writes the file, header and all.
 */
@Injectable({ providedIn: 'root' })
export class SavedStore {
  private readonly api = inject(SavedApi);
  private readonly settings = inject(SettingsService);
  private readonly tabs = inject(TabsStore);
  private readonly connections = inject(ConnectionsStore);

  readonly listing = signal<SavedListing | null>(null);
  readonly problem = signal<string | null>(null);
  /** Something to tell once (a folder that is gone, a query that was saved). */
  readonly notice = signal<string | null>(null);
  readonly request = signal<SaveRequest | null>(null);
  readonly entries = computed(() => this.listing()?.entries ?? []);
  /** The queries used lately, the latest first – as far as they still exist. */
  readonly recent = computed(() => {
    const byId = new Map(this.entries().map((e) => [e.id, e]));
    return this.settings
      .settings()
      .recentSaved.map((id) => byId.get(id))
      .filter((e): e is SavedEntry => !!e);
  });

  private started: Promise<void> | null = null;
  private watchers = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Reads the folder of the settings (once); a folder that is gone falls back to the default one. */
  start(): Promise<void> {
    this.started ??= this.use(this.settings.settings().savedQueriesDir || null, true);
    return this.started;
  }

  private async use(path: string | null, fallBack: boolean): Promise<void> {
    try {
      this.listing.set(await this.api.useFolder(path));
      this.problem.set(null);
    } catch (e) {
      if (path !== null && fallBack) {
        this.notice.set(SAVED_TEXTS.folderGone);
        this.settings.update({ savedQueriesDir: '' });
        return this.use(null, false);
      }
      this.problem.set(describeError(e));
    }
  }

  /** Another folder (from the folder dialog); `null` = the default one. */
  async useFolder(path: string | null): Promise<void> {
    await this.start();
    try {
      this.listing.set(await this.api.useFolder(path));
      this.settings.update({ savedQueriesDir: path ?? '' });
      this.problem.set(null);
    } catch (e) {
      this.notice.set(describeError(e));
    }
  }

  async refresh(): Promise<void> {
    await this.start();
    try {
      this.listing.set(await this.api.list());
      this.problem.set(null);
    } catch (e) {
      this.problem.set(describeError(e));
    }
  }

  /** Lists again when the folder changed – also when something outside changed it. */
  async check(): Promise<void> {
    const known = this.listing()?.stamp;
    try {
      if ((await this.api.stamp()) !== known) await this.refresh();
    } catch {
      // the next look tells
    }
  }

  /** Keeps the listing fresh until the returned function is called. */
  watch(): () => void {
    this.watchers++;
    void this.start().then(() => this.check());
    this.timer ??= setInterval(() => void this.check(), WATCH_MS);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.watchers === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  search(query: string): Promise<readonly string[]> {
    return this.api.search(query);
  }

  read(id: string): Promise<SavedQuery> {
    return this.api.read(id);
  }

  /** Asks for name and folder of a text to save. */
  ask(text: string, name: string): void {
    if (text.trim() === '') {
      this.notice.set(SAVED_TEXTS.nothingToSave);
      return;
    }
    void this.start();
    this.request.set({ kind: 'new', text, name });
  }

  /** Writes what the dialog holds. Rejects with what went wrong (the dialog shows it). */
  async submit(request: SaveRequest, form: SavedForm): Promise<void> {
    const folder = cleanFolder(form.folder);
    const active = this.connections.active();
    const connection = active ? { id: active.id, kind: active.kind } : null;
    if (request.kind === 'new') {
      const meta = metaOf(form, connection, null);
      const id = await this.api.save(null, folder, meta, request.text);
      this.touch(id);
      this.notice.set(SAVED_TEXTS.saved(meta.name));
    } else {
      const before = request.entry;
      const meta = metaOf(form, connection, before);
      const saved = await this.api.read(before.id);
      // header first (description, tags, binding), then the move: the file is named after the query
      await this.api.save(before.id, before.folder, { ...meta, name: before.name }, saved.text);
      const id =
        meta.name !== before.name || folder !== before.folder
          ? await this.api.rename(before.id, folder, meta.name)
          : before.id;
      this.renamed(before.id, id);
    }
    await this.refresh();
  }

  async remove(entry: SavedEntry): Promise<void> {
    try {
      await this.api.delete(entry.id);
    } catch (e) {
      this.notice.set(describeError(e));
    }
    await this.refresh();
  }

  /** Opens the file of a query as a tab; a bound one on its connection, if that still exists. */
  async open(entry: SavedEntry): Promise<void> {
    this.touch(entry.id);
    const wasOpen = this.tabs.tabs().some((t) => t.filePath() === entry.path);
    await this.tabs.openFiles([entry.path]);
    const tab = this.tabs.active();
    const bound = entry.connection;
    // only a tab that is new: one that was open may be in the middle of something on its connection
    if (
      !wasOpen &&
      tab &&
      tab.filePath() === entry.path &&
      bound &&
      this.connections.profiles().some((p) => p.id === bound)
    ) {
      tab.connectionId.set(bound);
    }
  }

  /** Puts the text of a query (without its header) into the editor in front. */
  async insert(entry: SavedEntry): Promise<void> {
    try {
      const saved = await this.api.read(entry.id);
      this.touch(entry.id);
      this.tabs.active()?.insert(saved.text);
    } catch (e) {
      this.notice.set(describeError(e));
    }
  }

  /** Opens a query and runs it, statement by statement. */
  async run(entry: SavedEntry): Promise<void> {
    try {
      const saved = await this.api.read(entry.id);
      await this.open(entry);
      const tab = this.tabs.active();
      if (!tab || tab.filePath() !== entry.path) return;
      const kind = this.connections.profiles().find((p) => p.id === tab.connectionId())?.kind;
      const statements = splitForRun(saved.text, sqlDialectOf(kind ?? 'sqlite') as Dialect).map(
        (s) => s.text,
      );
      if (statements.length > 0) await tab.runAll(statements, 'user');
    } catch (e) {
      this.notice.set(describeError(e));
    }
  }

  private touch(id: string): void {
    this.settings.update({
      recentSaved: pushRecent(this.settings.settings().recentSaved, id, MAX_RECENT_SAVED),
    });
  }

  private renamed(from: string, to: string): void {
    if (from === to) return;
    const recent = this.settings.settings().recentSaved;
    if (recent.includes(from)) {
      this.settings.update({ recentSaved: recent.map((id) => (id === from ? to : id)) });
    }
  }
}
