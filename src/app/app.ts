import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { HistoryDialog } from './features/history/history-dialog';
import { HistoryService } from './features/history/history.service';
import { ActionId } from './core/actions/action-catalog';
import { COPY_FORMATS, isCopyFormat, orderedFormats } from './features/results/copy-logic';
import { CopyService } from './features/results/copy.service';
import { ConfirmDialog, ConfirmService } from './shared/confirm';
import { ContextMenu, MenuItem } from './shared/context-menu';
import { NODE_ACTIONS, SchemaActions } from './features/schema/schema-actions';
import { SchemaStore } from './features/schema/schema.store';
import { SchemaTree } from './features/schema/schema-tree';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { ActionService } from './core/actions/action.service';
import { DEMO_ID, Profile, emptyProfile } from './core/connections/connection.models';
import { ConnectionsStore } from './core/connections/connections.store';
import { DEFAULT_SETTINGS } from './core/settings/settings.models';
import { SettingsService } from './core/settings/settings.service';
import { ThemeService } from './core/theme/theme.service';
import { ConnectionDialog } from './features/connections/connection-dialog';
import { ConnectionList } from './features/connections/connection-list';
import { PasswordDialog } from './features/connections/password-dialog';
import { CommandPalette } from './features/palette/command-palette';
import { ShortcutDialogComponent } from './features/shortcuts/shortcut-dialog';
import { QueryPane } from './features/tabs/query-pane';
import { runStatus } from './features/tabs/run-state';
import { TabBar } from './features/tabs/tab-bar';
import { encodingLabel } from './features/tabs/tab-logic';
import { TabsStore } from './features/tabs/tabs.store';
import { ThemeEditor } from './features/themes/theme-editor';
import { copyName } from './features/themes/theme-editor-logic';
import { ThemePickerComponent } from './features/themes/theme-picker';
import { SplitterComponent } from './shared/splitter';

const SIDEBAR_MIN = 140;

/**
 * The window: toolbar, sidebar (connections; the schema tree to be), the query tabs with editor and result,
 * and the status line. Sizes and the colour scheme are settings.
 */
@Component({
  selector: 'app-root',
  imports: [
    CommandPalette,
    ConnectionDialog,
    ConfirmDialog,
    ConnectionList,
    ContextMenu,
    HistoryDialog,
    PasswordDialog,
    SchemaTree,
    QueryPane,
    ShortcutDialogComponent,
    SplitterComponent,
    TabBar,
    ThemeEditor,
    ThemePickerComponent,
  ],
  template: `
    <header class="toolbar" role="toolbar" aria-label="Werkzeugleiste">
      <button
        type="button"
        aria-label="Seitenleiste ein-/ausblenden"
        [title]="'Seitenleiste ein-/ausblenden' + actions.hint('TOGGLE_SIDEBAR')"
        [attr.aria-pressed]="settings.settings().sidebarVisible"
        (click)="actions.run('TOGGLE_SIDEBAR')"
      >
        ☰
      </button>
      <button
        type="button"
        class="primary"
        [title]="
          'Auswahl oder Anweisung unter dem Cursor ausführen' + actions.hint('RUN_STATEMENT')
        "
        [disabled]="running()"
        (click)="actions.run('RUN_STATEMENT')"
      >
        ▶ Ausführen
      </button>
      <button
        type="button"
        [title]="'Ganzes Skript ausführen' + actions.hint('RUN_SCRIPT')"
        [disabled]="running()"
        (click)="actions.run('RUN_SCRIPT')"
      >
        ▶▶ Skript
      </button>
      @if (running()) {
        <button
          type="button"
          [title]="'Laufende Anweisung abbrechen' + actions.hint('CANCEL_QUERY')"
          (click)="actions.run('CANCEL_QUERY')"
        >
          ■ Abbrechen
        </button>
      }
      <span class="spacer"></span>
      @if (connections.active(); as conn) {
        @let cs = connections.activeState();
        <span
          [class]="'conn conn-' + conn.color"
          [title]="cs.kind === 'open' ? cs.serverVersion : 'nicht verbunden'"
          ><i [class.open]="cs.kind === 'open'"></i>{{ conn.name }}</span
        >
      }
      <button
        type="button"
        aria-label="Befehlspalette"
        [title]="'Befehlspalette' + actions.hint('OPEN_PALETTE')"
        (click)="actions.run('OPEN_PALETTE')"
      >
        ⌘
      </button>
      <button
        type="button"
        aria-label="Farbschema wählen"
        [title]="'Farbschema wählen' + actions.hint('COLOR_SCHEME')"
        (click)="actions.run('COLOR_SCHEME')"
      >
        ◐
      </button>
    </header>
    <div #workspace class="workspace">
      @if (settings.settings().sidebarVisible) {
        <nav
          #sidebar
          id="sidebar"
          class="sidebar"
          aria-label="Datenbank"
          [style.width.px]="sidebarW()"
        >
          <app-connection-list class="connections" (edit)="connectionDialog.set($event)" />
          <app-schema-tree />
        </nav>
        <app-splitter
          orientation="vertical"
          pane="before"
          label="Breite der Seitenleiste"
          controls="sidebar"
          [size]="sidebarW()"
          [min]="sidebarMin"
          [max]="sidebarMaxW()"
          [defaultSize]="defaults.sidebarWidth"
          (sizeChange)="dragWidth.set($event)"
          (sizeCommit)="commitWidth($event)"
        />
      }
      <div #column class="column">
        <app-tab-bar />
        @for (tab of tabs.tabs(); track tab.id) {
          <!-- A tab is built when it is first shown and stays: undo history, caret and scroll survive. -->
          @if (tab.mounted()) {
            <app-query-pane
              class="pane"
              [tab]="tab"
              [class.hidden]="tab.id !== tabs.activeId()"
              [inert]="tab.id !== tabs.activeId()"
            />
          }
        }
      </div>
    </div>
    <footer class="status" role="status">
      <span>{{ status() }}</span>
      @if (copier.busy()) {
        <button type="button" class="status-button" (click)="copier.cancel()">Abbrechen</button>
      }
      <span class="spacer"></span>
      @if (tabs.active(); as tab) {
        @if (tab.filePath()) {
          <span>{{ encoding() }}</span>
        }
        @if (tab.caret(); as c) {
          <span>Zeile {{ c.line }}, Spalte {{ c.ch }}</span>
        }
      }
    </footer>
    @if (copier.menu(); as m) {
      <app-context-menu
        label="Kopieren als"
        [items]="copyItems()"
        [x]="m.x"
        [y]="m.y"
        (picked)="copyAs($event)"
        (closed)="copier.menu.set(null)"
      />
    }
    @if (confirm.request(); as question) {
      <app-confirm-dialog [request]="question" (answered)="confirm.answer($event)" />
    }
    @if (notice(); as message) {
      <div class="notice" role="alert">
        <span>{{ message }}</span>
        <button type="button" aria-label="Meldung schließen" (click)="dismissNotice()">×</button>
      </div>
    }
    @if (dropActive()) {
      <div class="drop" aria-hidden="true"><span>SQL-Datei hier ablegen</span></div>
    }
    @if (connectionDialog(); as profile) {
      @defer (on immediate) {
        <app-connection-dialog [profile]="profile" (closed)="connectionDialog.set(null)" />
      }
    }
    @if (connections.passwordRequest(); as request) {
      @defer (on immediate) {
        <app-password-dialog [request]="request" />
      }
    }
    @if (history.open()) {
      @defer (on immediate) {
        <app-history-dialog (closed)="history.open.set(false)" />
      }
    }
    @if (paletteOpen()) {
      @defer (on immediate) {
        <app-command-palette (closed)="paletteOpen.set(false)" />
      }
    }
    @if (shortcutsOpen(); as mode) {
      @defer (on immediate) {
        <app-shortcut-dialog [startMode]="mode" (closed)="shortcutsOpen.set(null)" />
      }
    }
    @if (theme.pickerOpen()) {
      @defer (on immediate) {
        <app-theme-picker (closed)="theme.pickerOpen.set(false)" />
      }
    }
    @if (theme.editing(); as request) {
      @defer (on immediate) {
        <app-theme-editor [request]="request" (closed)="theme.editing.set(null)" />
      }
    }
  `,
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {
  protected readonly settings = inject(SettingsService);
  /** Created first: it puts the colour scheme on screen and shows the window. */
  protected readonly theme = inject(ThemeService);
  protected readonly actions = inject(ActionService);
  protected readonly connections = inject(ConnectionsStore);
  protected readonly tabs = inject(TabsStore);

  /** The connection dialog is open with this profile (`id === ''` = a new one). */
  protected readonly connectionDialog = signal<Profile | null>(null);
  protected readonly paletteOpen = signal(false);
  /** The shortcut editor, `read` as an overview. */
  protected readonly shortcutsOpen = signal<'edit' | 'read' | null>(null);
  /** A message of the app itself (failed action, unreadable shortcuts). */
  private readonly ownNotice = signal<string | null>(null);
  protected readonly notice = computed(() => this.ownNotice() ?? this.tabs.notice());
  /** A file is dragged over the window. */
  protected readonly dropActive = signal(false);
  private readonly sidebar = viewChild<ElementRef<HTMLElement>>('sidebar');
  private readonly schemaTree = viewChild(SchemaTree);
  private readonly schema = inject(SchemaStore);
  private readonly schemaActions = inject(SchemaActions);
  private readonly column = viewChild<ElementRef<HTMLElement>>('column');
  private readonly cleanups: (() => void)[] = [];

  protected readonly defaults = DEFAULT_SETTINGS;
  protected readonly sidebarMin = SIDEBAR_MIN;

  protected readonly running = computed(() => this.tabs.active()?.running() ?? false);
  protected readonly status = computed(() => {
    const copied = this.copier.message();
    if (copied !== null) return copied;
    const tab = this.tabs.active();
    return tab ? runStatus(tab.runs(), tab.elapsedMs()) : '';
  });
  protected readonly copier = inject(CopyService);
  protected readonly history = inject(HistoryService);
  protected readonly confirm = inject(ConfirmService);
  /** The formats of "copy as", the one used last on top. */
  protected readonly copyItems = computed<MenuItem[]>(() => {
    const last = this.settings.settings().lastCopyFormat;
    return orderedFormats(isCopyFormat(last) ? last : null).map((f) => ({
      id: f.id,
      label: f.label,
    }));
  });
  protected readonly encoding = computed(() =>
    encodingLabel(this.tabs.active()?.encoding() ?? null),
  );

  // The width is stored when a drag ends; in between the drag signal holds it.
  protected readonly dragWidth = signal<number | null>(null);
  private readonly workspace = viewChild<ElementRef<HTMLElement>>('workspace');
  private readonly workspaceW = signal(0);
  protected readonly sidebarMaxW = computed(() => Math.max(SIDEBAR_MIN, this.workspaceW() * 0.6));
  protected readonly sidebarW = computed(() =>
    clamp(
      this.dragWidth() ?? this.settings.settings().sidebarWidth,
      SIDEBAR_MIN,
      this.sidebarMaxW(),
    ),
  );
  private observer: ResizeObserver | null = null;

  constructor() {
    effect(() => {
      const element = this.workspace()?.nativeElement;
      this.observer?.disconnect();
      this.observer = null;
      if (!element || typeof ResizeObserver === 'undefined') return;
      const measure = () => this.workspaceW.set(element.clientWidth);
      measure();
      this.observer = new ResizeObserver(measure);
      this.observer.observe(element);
    });
  }

  async ngOnInit(): Promise<void> {
    this.cleanups.push(this.actions.attach(document), this.registerActions());
    this.actions.reportError = (message) => this.ownNotice.set(message);
    const engine = this.actions.load();
    // both before the window shows: the stored scheme may be one of the user's own (design 001 E7)
    await Promise.all([this.settings.load(), this.theme.loadUserThemes()]);
    await engine;
    // after the settings: they name the active connection; the tabs name theirs
    await this.connections.load();
    await this.tabs.load();
    const notice = this.actions.startNotice();
    if (notice) this.ownNotice.set(notice);
    // the backup of a text that was just typed must not wait for its timer when the window goes
    const flush = () => this.tabs.flush();
    const hidden = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    this.cleanups.push(() => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
    });
    if (isTauri()) this.cleanups.push(await this.listenForDrops());
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    for (const cleanup of this.cleanups) cleanup();
  }

  protected dismissNotice(): void {
    this.ownNotice.set(null);
    this.tabs.notice.set(null);
  }

  /** Files dropped onto the window open as tabs. */
  private async listenForDrops(): Promise<() => void> {
    return getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === 'enter') {
        // a name dragged out of the schema tree is no file
        this.dropActive.set(payload.paths.length > 0);
      } else if (payload.type === 'over') {
        // nothing changes while it moves
      } else if (payload.type === 'leave') {
        this.dropActive.set(false);
      } else {
        this.dropActive.set(false);
        if (payload.paths.length > 0) void this.tabs.openFiles(payload.paths);
      }
    });
  }

  /** The actions of the window: run, tabs, files, connections, layout, dialogs, moving between its areas. */
  private registerActions(): () => void {
    const tab = () => this.tabs.active();
    const withTab = (run: (id: string) => unknown) => () => {
      const id = this.tabs.activeId();
      if (id) void run(id);
    };
    const offs = [
      this.actions.register(
        'RUN_STATEMENT',
        () => tab()?.runCurrent(),
        () => !this.running() && !!tab(),
      ),
      this.actions.register(
        'RUN_SCRIPT',
        () => tab()?.runScript(),
        () => !this.running() && !!tab(),
      ),
      this.actions.register(
        'SHOW_MESSAGES',
        () => tab()?.shown.set('messages'),
        () => !!tab(),
      ),
      this.actions.register(
        'SCHEMA_REFRESH',
        () => this.schema.refresh(),
        () => this.schema.connected(),
      ),
      this.actions.register('SCHEMA_FILTER', () => this.focusSchemaFilter()),
      this.actions.register('TOGGLE_SYSTEM_SCHEMAS', () =>
        this.settings.update({ showSystemSchemas: !this.settings.settings().showSystemSchemas }),
      ),
      ...NODE_ACTIONS.map((id) =>
        this.actions.register(
          id,
          () => this.schemaActions.run(id),
          () => this.schemaActions.can(id),
        ),
      ),
      this.actions.register('OPEN_HISTORY', () => this.history.open.set(true)),
      this.actions.register(
        'HISTORY_PREV',
        () => this.recall(1),
        () => !!tab(),
      ),
      this.actions.register(
        'HISTORY_NEXT',
        () => this.recall(-1),
        () => !!tab(),
      ),
      this.actions.register(
        'TOGGLE_HISTORY_CONNECTION',
        () => {
          const id = tab()?.connectionId();
          if (!id) return;
          this.history.toggleConnection(id);
          this.ownNotice.set(
            this.history.enabled(id)
              ? 'Der Verlauf merkt sich die Anweisungen dieser Verbindung wieder.'
              : 'Der Verlauf merkt sich keine Anweisungen dieser Verbindung mehr.',
          );
        },
        () => !!tab(),
      ),
      this.actions.register('TOGGLE_HISTORY', () => {
        const on = !this.settings.settings().historyEnabled;
        this.settings.update({ historyEnabled: on });
        this.ownNotice.set(
          on ? 'Der Verlauf ist eingeschaltet.' : 'Der Verlauf ist ausgeschaltet.',
        );
      }),
      this.actions.register(
        'COPY_RESULT',
        () => this.copier.copy(),
        () => this.copier.can(),
      ),
      this.actions.register(
        'COPY_AS',
        () => this.copier.openMenu(),
        () => this.copier.can(),
      ),
      ...COPY_FORMATS.filter((f) => f.id !== 'tsv').map((f) =>
        this.actions.register(
          `COPY_AS_${f.id.toUpperCase()}` as ActionId,
          () => this.copier.copy(f.id),
          () => this.copier.can(),
        ),
      ),
      this.actions.register('TOGGLE_COPY_HEADER', () =>
        this.settings.update({ copyHeader: !this.settings.settings().copyHeader }),
      ),
      this.actions.register(
        'CANCEL_COPY',
        () => this.copier.cancel(),
        () => this.copier.busy(),
      ),
      this.actions.register('TOGGLE_DIGIT_GROUPING', () =>
        this.settings.update({ groupDigits: !this.settings.settings().groupDigits }),
      ),
      this.actions.register(
        'CANCEL_QUERY',
        () => tab()?.cancel(),
        () => this.running(),
      ),
      this.actions.register(
        'REOPEN_TAB',
        () => this.tabs.reopen(),
        () => this.tabs.canReopen(),
      ),
      this.actions.register(
        'EDIT_CONNECTION',
        () => this.connectionDialog.set(this.connections.active()),
        () => this.connections.activeId() !== DEMO_ID,
      ),
      this.actions.register(
        'CONNECT',
        () => this.connections.connect(this.connections.activeId()),
        () => this.connections.activeState().kind !== 'open',
      ),
      this.actions.register(
        'DISCONNECT',
        () => this.connections.disconnect(this.connections.activeId()),
        () => this.connections.activeState().kind === 'open',
      ),
      this.actions.registerAll({
        NEW_TAB: () => {
          this.tabs.newTab();
          // the editor of the new tab is drawn with the next change detection
          setTimeout(() => this.tabs.active()?.focus(), 50);
        },
        CLOSE_TAB: withTab((id) => this.tabs.close(id)),
        NEXT_TAB: () => this.tabs.cycle(1),
        PREV_TAB: () => this.tabs.cycle(-1),
        DUPLICATE_TAB: withTab((id) => this.tabs.duplicate(id)),
        OPEN_FILE: () => this.tabs.openFiles(),
        SAVE_FILE: withTab((id) => this.tabs.save(id)),
        SAVE_FILE_AS: withTab((id) => this.tabs.save(id, true)),
        NEW_CONNECTION: () => this.connectionDialog.set(emptyProfile()),
        TOGGLE_SIDEBAR: () =>
          this.settings.update({ sidebarVisible: !this.settings.settings().sidebarVisible }),
        COLOR_SCHEME: () => this.theme.pickerOpen.set(true),
        EDIT_COLOR_SCHEME: () => this.editCurrentScheme(),
        OPEN_PALETTE: () => this.paletteOpen.set(true),
        OPEN_SHORTCUTS: () => this.shortcutsOpen.set('edit'),
        SHOW_SHORTCUTS: () => this.shortcutsOpen.set('read'),
        FOCUS_EDITOR: () => this.focusArea('editor'),
        FOCUS_RESULT: () => this.focusArea('result'),
        FOCUS_SIDEBAR: () => this.focusArea('sidebar'),
        FOCUS_NEXT_AREA: () => this.focusArea(nextArea(this.areas(), this.currentArea(), 1)),
        FOCUS_PREV_AREA: () => this.focusArea(nextArea(this.areas(), this.currentArea(), -1)),
      }),
    ];
    return () => offs.forEach((off) => off());
  }

  /** The statement before or after the one in the editor, from the history of the tab's connection. */
  private async recall(step: 1 | -1): Promise<void> {
    const tab = this.tabs.active();
    if (!tab) return;
    const now = (await tab.text()) ?? '';
    const text = await this.history.recalled(tab.id, tab.connectionId(), now, step);
    if (text === null) {
      if (now.trim() !== '') {
        this.ownNotice.set(
          'Der Editor ist nicht leer: Der Verlauf ersetzt keinen geschriebenen Text. Verlauf öffnen fügt ein.',
        );
      }
      return;
    }
    await tab.setText(text);
  }

  protected copyAs(format: string): void {
    this.copier.menu.set(null);
    if (isCopyFormat(format)) void this.copier.copy(format);
  }

  /** Shows the sidebar if need be and puts the focus into the filter of the schema tree. */
  private focusSchemaFilter(): void {
    if (!this.settings.settings().sidebarVisible) this.settings.update({ sidebarVisible: true });
    // the sidebar is drawn with the next change detection
    setTimeout(() => this.schemaTree()?.focusFilter());
  }

  /** A copy of the scheme on screen, opened in the scheme editor. */
  private async editCurrentScheme(): Promise<void> {
    await this.theme.loadCatalog();
    const source = this.theme.active();
    if (!source) return;
    const names = new Set(this.theme.themes().map((t) => t.name));
    this.theme.editing.set({
      theme: { ...source, id: '', name: copyName(source.name, names) },
      dropped: [],
    });
  }

  /** The areas that can take the focus right now, in their order on screen. */
  private areas(): Area[] {
    return this.settings.settings().sidebarVisible
      ? ['sidebar', 'editor', 'result']
      : ['editor', 'result'];
  }

  /** The result area of the tab in front. */
  private results(): HTMLElement | null {
    return (
      this.column()?.nativeElement.querySelector<HTMLElement>(
        'app-query-pane:not(.hidden) .results',
      ) ?? null
    );
  }

  private currentArea(): Area | null {
    const active = document.activeElement;
    if (!active) return null;
    if (this.sidebar()?.nativeElement.contains(active)) return 'sidebar';
    if (this.results()?.contains(active)) return 'result';
    if (active.closest('app-sql-editor')) return 'editor';
    return null;
  }

  private focusArea(area: Area): void {
    if (area === 'editor') {
      this.tabs.active()?.focus();
    } else if (area === 'sidebar') {
      if (!this.settings.settings().sidebarVisible) {
        this.settings.update({ sidebarVisible: true });
        // the sidebar is drawn with the next change detection
        setTimeout(() => this.sidebar()?.nativeElement.querySelector('button')?.focus());
        return;
      }
      this.sidebar()?.nativeElement.querySelector('button')?.focus();
    } else {
      const host = this.results();
      const grid = host?.querySelector<HTMLElement>('.ge-table [tabindex], .ge-table');
      (grid ?? host)?.focus();
    }
  }

  protected commitWidth(width: number): void {
    this.dragWidth.set(null);
    this.settings.update({ sidebarWidth: width });
  }
}

export type Area = 'sidebar' | 'editor' | 'result';

/** The area after (`step` 1) or before (`-1`) `current`, around the ends; the first one without a current. */
export function nextArea(areas: readonly Area[], current: Area | null, step: 1 | -1): Area {
  const i = current === null ? -1 : areas.indexOf(current);
  if (i < 0) return step === 1 ? areas[0] : areas[areas.length - 1];
  return areas[(i + step + areas.length) % areas.length];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
