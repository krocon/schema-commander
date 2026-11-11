import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ImportDialog } from './features/connections/import-dialog';
import { isDatabaseFile } from './features/connections/import-logic';
import { GuardDialog } from './features/guard/guard-dialog';
import { badgeText } from './features/guard/guard-logic';
import { GuardService } from './features/guard/guard.service';
import { HistoryDialog } from './features/history/history-dialog';
import { HistoryPanel } from './features/history/history-panel';
import { HistoryService } from './features/history/history.service';
import { ActionId } from './core/actions/action-catalog';
import {
  COPY_FORMATS,
  isCopyFormat,
  orderedFormats,
  tableOf,
  tablePlaceholder,
} from './features/results/copy-logic';
import { ExportDialog } from './features/export/export-dialog';
import { ExportService } from './features/export/export.service';
import { FormatMode } from './core/format/format-api';
import { FormatService } from './features/format/format.service';
import { EMPTY_SPEC, QuickFilter } from './features/filter/filter-logic';
import { FILTER_TEXTS } from './features/filter/filter-texts';
import { ParamDialog } from './features/params/param-dialog';
import { ParamService } from './features/params/param.service';
import { PARAM_TEXTS } from './features/params/param-texts';
import { SavedDialog } from './features/saved/saved-dialog';
import { nameFromText } from './features/saved/saved-logic';
import { SavedPanel } from './features/saved/saved-panel';
import { SavedStore } from './features/saved/saved.store';
import { SnippetDialog } from './features/snippets/snippet-dialog';
import { StatsPopover } from './features/stats/stats-popover';
import { ColumnsPopover } from './features/find/columns-popover';
import { RelationsDialog } from './features/relations/relations-dialog';
import { EditPreview } from './features/edit/edit-preview';
import { EditService } from './features/edit/edit.service';
import { QueryTab } from './features/tabs/query-tab';
import { RelationsService } from './features/relations/relations.service';
import { QueryColumn } from './core/sql/query.models';
import { FIND_TEXTS } from './features/find/find-texts';
import {
  ColumnLayout,
  EMPTY_LAYOUT,
  columnKeys,
  moveColumn,
  resolveLayout,
  setHidden,
  setPinned,
} from './features/results/column-layout';
import { ColumnLayouts } from './features/results/column-layouts.service';
import { STATS_TEXTS } from './features/stats/stats-texts';
import { StatsService } from './features/stats/stats.service';
import { extensionOf } from './features/value/value-logic';
import { ValueService } from './features/value/value.service';
import { FORMAT_TEXTS } from './features/format/format-texts';
import { CopyService } from './features/results/copy.service';
import { ConfirmDialog, ConfirmRequest, ConfirmService } from './shared/confirm';
import { tlsUnchecked } from './core/connections/connection.models';
import { HostKeyRequest } from './core/connections/connections.store';
import { ContextMenu, MenuItem } from './shared/context-menu';
import { NODE_ACTIONS, SchemaActions } from './features/schema/schema-actions';
import { SchemaStore } from './features/schema/schema.store';
import { SchemaTree } from './features/schema/schema-tree';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { txOpen, txStatus } from './features/tabs/tx-logic';
import { ActionService } from './core/actions/action.service';
import { DEMO_ID, Profile, emptyProfile } from './core/connections/connection.models';
import { ConnectionsStore } from './core/connections/connections.store';
import { DEFAULT_SETTINGS, SIDEBAR_VIEWS, SidebarView } from './core/settings/settings.models';
import { FileDialogApi } from './core/backend/file-dialog-api';
import { SAVED_TEXTS } from './features/saved/saved-texts';
import { SettingsService } from './core/settings/settings.service';
import { ThemeService } from './core/theme/theme.service';
import { ConnectionDialog } from './features/connections/connection-dialog';
import { ConnectionList } from './features/connections/connection-list';
import { PasswordDialog } from './features/connections/password-dialog';
import { CommandPalette } from './features/palette/command-palette';
import { DetailsDialog } from './features/details/details-dialog';
import { ObjectDetailsService } from './features/details/details.service';
import { MenuBar } from './features/menus/menu-bar';
import { MenuService } from './features/menus/menu.service';
import { SettingsDialog } from './features/settings/settings-dialog';
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
import { APP_TEXTS } from './app-texts';
import { COMMON_TEXTS } from './core/i18n/common-texts';

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
    ExportDialog,
    GuardDialog,
    HistoryDialog,
    HistoryPanel,
    ImportDialog,
    PasswordDialog,
    SchemaTree,
    ParamDialog,
    QueryPane,
    SavedDialog,
    SavedPanel,
    SnippetDialog,
    StatsPopover,
    ColumnsPopover,
    RelationsDialog,
    EditPreview,
    DetailsDialog,
    MenuBar,
    SettingsDialog,
    ShortcutDialogComponent,
    SplitterComponent,
    TabBar,
    ThemeEditor,
    ThemePickerComponent,
  ],
  template: `
    @if (!zen()) {
      <!-- Windows and Linux: the menu bar of the window; macOS has the native one (prompt 018) -->
      <app-menu-bar />
      <header class="toolbar" role="toolbar" [attr.aria-label]="t.toolbar">
        <button
          type="button"
          [attr.aria-label]="t.toggleSidebar"
          [title]="t.toggleSidebar + actions.hint('TOGGLE_SIDEBAR')"
          [attr.aria-pressed]="settings.settings().sidebarVisible"
          (click)="actions.run('TOGGLE_SIDEBAR')"
        >
          ☰
        </button>
        <button
          type="button"
          class="primary"
          [title]="t.runHint + actions.hint('RUN_STATEMENT')"
          [disabled]="running()"
          (click)="actions.run('RUN_STATEMENT')"
        >
          ▶ {{ t.run }}
        </button>
        <button
          type="button"
          [title]="t.runScriptHint + actions.hint('RUN_SCRIPT')"
          [disabled]="running()"
          (click)="actions.run('RUN_SCRIPT')"
        >
          ▶▶ {{ t.script }}
        </button>
        @if (running()) {
          <button
            type="button"
            [title]="t.cancelHint + actions.hint('CANCEL_QUERY')"
            (click)="actions.run('CANCEL_QUERY')"
          >
            ■ {{ common.cancel }}
          </button>
        }
        @if (tabs.active(); as tab) {
          <button
            type="button"
            class="tx-mode"
            [attr.aria-pressed]="tab.manual()"
            [title]="
              (tab.manual() ? t.manualCommitHint : t.autoCommitHint) +
              actions.hint('TOGGLE_AUTOCOMMIT')
            "
            (click)="actions.run('TOGGLE_AUTOCOMMIT')"
          >
            {{ tab.manual() ? t.txManual : t.txAuto }}
          </button>
          @if (txIsOpen()) {
            <button
              type="button"
              class="tx-commit"
              [disabled]="running() || tab.tx() === 'failed'"
              [title]="t.commitHint + actions.hint('TX_COMMIT')"
              (click)="actions.run('TX_COMMIT')"
            >
              ✓ {{ t.commit }}
            </button>
            <button
              type="button"
              [disabled]="running()"
              [title]="t.rollbackHint + actions.hint('TX_ROLLBACK')"
              (click)="actions.run('TX_ROLLBACK')"
            >
              ↶ {{ t.rollback }}
            </button>
          }
        }
        <span class="spacer"></span>
        @if (connections.active(); as conn) {
          @let cs = connections.activeState();
          <span
            [class]="'conn conn-' + conn.color"
            [title]="cs.kind === 'open' ? cs.serverVersion : t.notConnected"
            ><i [class.open]="cs.kind === 'open'"></i>{{ conn.name }}</span
          >
          @if (badge(); as b) {
            <span class="guard-badge" [attr.data-protection]="conn.protection">{{ b }}</span>
          }
          @if (conn.kind !== 'sqlite' && uncheckedTls(conn.tls)) {
            <span class="guard-badge" [title]="t.tlsUncheckedHint">{{ t.tlsUnchecked }}</span>
          }
        }
        <button
          type="button"
          [attr.aria-label]="t.palette"
          [title]="t.palette + actions.hint('OPEN_PALETTE')"
          (click)="actions.run('OPEN_PALETTE')"
        >
          ⌘
        </button>
        <button
          type="button"
          [attr.aria-label]="t.colorScheme"
          [title]="t.colorScheme + actions.hint('COLOR_SCHEME')"
          (click)="actions.run('COLOR_SCHEME')"
        >
          ◐
        </button>
      </header>
    }
    <div #workspace class="workspace">
      @if (sidebarShown()) {
        @let view = settings.settings().sidebarView;
        <nav
          #sidebar
          id="sidebar"
          class="sidebar"
          [attr.aria-label]="t.sidebar"
          [style.width.px]="sidebarW()"
        >
          <div class="views" role="tablist" [attr.aria-label]="t.sidebarView">
            <button
              type="button"
              role="tab"
              id="view-database"
              aria-controls="sidebar-view"
              [attr.aria-selected]="view === 'database'"
              [tabindex]="view === 'database' ? 0 : -1"
              [title]="t.databaseHint + actions.hint('SIDEBAR_DATABASE')"
              (click)="actions.run('SIDEBAR_DATABASE')"
              (keydown)="onViewKey($event)"
            >
              {{ t.database }}
            </button>
            <button
              type="button"
              role="tab"
              id="view-history"
              aria-controls="sidebar-view"
              [attr.aria-selected]="view === 'history'"
              [tabindex]="view === 'history' ? 0 : -1"
              [title]="t.historyHint + actions.hint('SIDEBAR_HISTORY')"
              (click)="actions.run('SIDEBAR_HISTORY')"
              (keydown)="onViewKey($event)"
            >
              {{ t.history }}
            </button>
            <button
              type="button"
              role="tab"
              id="view-saved"
              aria-controls="sidebar-view"
              [attr.aria-selected]="view === 'saved'"
              [tabindex]="view === 'saved' ? 0 : -1"
              [title]="t.savedHint + actions.hint('SIDEBAR_SAVED')"
              (click)="actions.run('SIDEBAR_SAVED')"
              (keydown)="onViewKey($event)"
            >
              {{ t.saved }}
            </button>
          </div>
          <div
            id="sidebar-view"
            class="view"
            role="tabpanel"
            [attr.aria-labelledby]="'view-' + view"
          >
            @if (view === 'history') {
              <app-history-panel />
            } @else if (view === 'saved') {
              <app-saved-panel />
            } @else {
              <app-connection-list class="connections" (edit)="connectionDialog.set($event)" />
              <app-schema-tree />
            }
          </div>
        </nav>
        <app-splitter
          orientation="vertical"
          pane="before"
          [label]="t.sidebarWidth"
          controls="sidebar"
          [size]="sidebarW()"
          [min]="sidebarMin"
          [max]="sidebarMaxW()"
          [defaultSize]="defaults.sidebarWidth"
          (sizeChange)="dragWidth.set($event)"
          (sizeCommit)="commitWidth($event)"
        />
      }
      <!--
        Two tab groups at most (prompt 016). All panes are children of the one grid and only change their
        cell: a tab that moves to the other group keeps its editor (undo history, caret, scroll).
      -->
      <div
        #column
        class="column"
        [class.split]="tabs.isSplit()"
        [class.stacked]="tabs.splitDir() === 'column'"
      >
        <app-tab-bar class="g0" [group]="0" />
        @if (tabs.isSplit()) {
          <app-tab-bar class="g1" [group]="1" />
        }
        @for (tab of tabs.tabs(); track tab.id) {
          <!-- A tab is built when it is first shown and stays: undo history, caret and scroll survive. -->
          @if (tab.mounted()) {
            @let shown = tabs.shownIds().includes(tab.id);
            <app-query-pane
              class="pane"
              [tab]="tab"
              [class.g1]="tab.group() === 1"
              [class.front]="tab.id === tabs.activeId()"
              [class.hidden]="!shown"
              [inert]="!shown"
              (focusin)="tabs.activate(tab.id)"
              (pointerdown)="tabs.activate(tab.id)"
            />
          }
        }
      </div>
    </div>
    @if (!zen()) {
      <footer class="status" role="status">
        @if (badge(); as b) {
          <span class="guard-badge" [attr.data-protection]="connections.active()?.protection">{{
            b
          }}</span>
        }
        @if (txText(); as tx) {
          <span class="tx-status" [class.failed]="tabs.active()?.tx() === 'failed'">{{ tx }}</span>
        }
        <span>{{ status() }}</span>
        @if (formatter.visible()) {
          <span>{{ formatTexts.running }}</span>
          <button type="button" class="status-button" (click)="formatter.cancel()">
            {{ formatTexts.cancel }}
          </button>
        }
        @if (exporter.job(); as job) {
          @if (job.state === 'running') {
            <button type="button" class="status-button" (click)="exporter.cancel()">
              {{ common.cancel }}
            </button>
          } @else {
            @if (job.state === 'done') {
              <button type="button" class="status-button" (click)="exporter.reveal()">
                {{ t.revealExport }}
              </button>
            }
            <button
              type="button"
              class="status-button"
              [attr.aria-label]="t.dismissExport"
              (click)="exporter.dismiss()"
            >
              ×
            </button>
          }
        }
        @if (copier.busy()) {
          <button type="button" class="status-button" (click)="copier.cancel()">
            {{ common.cancel }}
          </button>
        }
        <span class="spacer"></span>
        @if (statsShown()) {
          <!-- the figures change with every move of the selection: spoken only once it rests (below) -->
          <span class="stats" role="group" aria-live="off" [attr.aria-label]="statsTexts.region">
            @if (stats.busy()) {
              <span class="stats-busy">{{ statsTexts.working }}</span>
            }
            @for (f of stats.shown(); track f.key) {
              <button
                type="button"
                class="stat"
                [title]="statsTexts.copyHint(f.label)"
                (click)="stats.copy(f)"
              >
                <span class="stat-label">{{ f.label }}</span> {{ f.shown }}
              </button>
            }
            @if (stats.ignored() > 0) {
              <span class="stats-note">{{ statsTexts.ignored(stats.ignored()) }}</span>
            }
          </span>
        }
        @if (tabs.active(); as tab) {
          @if (tab.filePath()) {
            <span>{{ encoding() }}</span>
          }
          @if (tab.caret(); as c) {
            <span>{{ t.caret(c.line, c.ch) }}</span>
          }
        }
      </footer>
    }
    <span class="sr-only" aria-live="polite">{{ statsShown() ? stats.spoken() : '' }}</span>
    @if (stats.summary()) {
      <app-stats-popover />
    }
    @if (edit.preview()) {
      <app-edit-preview />
    }
    @if (relations.dialog()) {
      <app-relations-dialog />
    }
    @if (columnsOf(); as c) {
      <app-columns-popover
        [columns]="c.columns"
        [layout]="c.layout"
        (layoutChange)="layouts.set(c.tab, $event)"
        (jump)="jumpToColumn($event)"
        (fit)="c.tab.grid?.fitWidths()"
        (closed)="closeColumns()"
      />
    }
    @if (menus.context(); as m) {
      <app-context-menu
        [label]="m.label"
        [items]="m.items"
        [x]="m.x"
        [y]="m.y"
        (picked)="menus.choose($event)"
        (closed)="menus.close($event)"
      />
    }
    @if (copier.menu(); as m) {
      <app-context-menu
        [label]="t.copyAs"
        [items]="copyItems()"
        [x]="m.x"
        [y]="m.y"
        (picked)="copyAs($event)"
        (closed)="copier.menu.set(null)"
      />
    }
    @if (guard.request(); as question) {
      @defer (on immediate) {
        <app-guard-dialog [request]="question" (answered)="guard.answer($event)" />
      }
    }
    @if (connections.hostKeyRequest(); as hk) {
      <app-confirm-dialog
        [request]="hostKeyQuestion(hk)"
        (answered)="connections.answerHostKey($event === true)"
      />
    }
    @if (confirm.request(); as question) {
      <app-confirm-dialog [request]="question" (answered)="confirm.answer($event)" />
    }
    @if (notice(); as message) {
      <div class="notice" role="alert">
        <span>{{ message }}</span>
        <button type="button" [attr.aria-label]="common.closeMessage" (click)="dismissNotice()">
          ×
        </button>
      </div>
    }
    @if (dropActive()) {
      <div class="drop" aria-hidden="true">
        <span>{{ t.dropHint }}</span>
      </div>
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
    @if (exporter.request(); as source) {
      @defer (on immediate) {
        <app-export-dialog [source]="source" (closed)="exporter.request.set(null)" />
      }
    }
    @if (importOpen()) {
      @defer (on immediate) {
        <app-import-dialog (closed)="importOpen.set(false)" />
      }
    }
    @if (history.open()) {
      @defer (on immediate) {
        <app-history-dialog (closed)="history.open.set(false)" />
      }
    }
    @if (paletteOpen(); as mode) {
      @defer (on immediate) {
        <app-command-palette
          [start]="mode"
          [initial]="paletteQuery()"
          (closed)="paletteOpen.set(null)"
        />
      }
    }
    @if (objectDetails.current()) {
      @defer (on immediate) {
        <app-details-dialog />
      }
    }
    @if (saved.request()) {
      <app-saved-dialog />
    }
    @if (paramService.request()) {
      <app-param-dialog />
    }
    @if (snippetsOpen()) {
      <app-snippet-dialog (closed)="snippetsOpen.set(false)" />
    }
    @if (settingsOpen()) {
      @defer (on immediate) {
        <app-settings-dialog (closed)="settingsOpen.set(false)" />
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
  protected readonly t = APP_TEXTS;
  protected readonly common = COMMON_TEXTS;
  protected readonly settings = inject(SettingsService);
  /** Created first: it puts the colour scheme on screen and shows the window. */
  protected readonly theme = inject(ThemeService);
  protected readonly actions = inject(ActionService);
  protected readonly connections = inject(ConnectionsStore);
  protected readonly tabs = inject(TabsStore);

  /** The connection dialog is open with this profile (`id === ''` = a new one). */
  protected readonly connectionDialog = signal<Profile | null>(null);
  /** The palette is open: as the commands, or as „go to anything“ (prompt 020). */
  protected readonly paletteOpen = signal<'commands' | 'goto' | null>(null);
  /** What the palette starts with (`q: ` for the saved queries). */
  protected readonly paletteQuery = signal('');
  protected readonly snippetsOpen = signal(false);
  protected readonly importOpen = signal(false);
  /** The shortcut editor, `read` as an overview. */
  protected readonly shortcutsOpen = signal<'edit' | 'read' | null>(null);
  protected readonly settingsOpen = signal(false);
  protected readonly objectDetails = inject(ObjectDetailsService);
  protected readonly menus = inject(MenuService);
  /** A message of the app itself (failed action, unreadable shortcuts). */
  private readonly ownNotice = signal<string | null>(null);
  protected readonly notice = computed(() => this.ownNotice() ?? this.tabs.notice());
  /** Only the tabs: toolbar, sidebar and status line are out of sight (not kept over a restart). */
  protected readonly zen = signal(false);
  protected readonly sidebarShown = computed(
    () => this.settings.settings().sidebarVisible && !this.zen(),
  );
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
    const copied = this.copier.message() ?? this.stats.notice();
    if (copied !== null) return copied;
    const job = this.exporter.job();
    if (job) return job.message;
    const tab = this.tabs.active();
    return tab ? runStatus(tab.runs(), tab.elapsedMs()) : '';
  });
  protected readonly copier = inject(CopyService);
  protected readonly history = inject(HistoryService);
  /** Ticks while a transaction is open, so its duration is shown. */
  private readonly clock = signal(Date.now());
  protected readonly txIsOpen = computed(() => txOpen(this.tabs.active()?.tx() ?? 'idle'));
  protected readonly txText = computed(() => {
    const tab = this.tabs.active();
    if (!tab) return null;
    return txStatus(
      tab.tx(),
      tab.txSince(),
      tab.txStatements(),
      Math.max(this.clock(), tab.txSince() ?? 0),
      this.settings.settings().txWarnMinutes * 60_000,
    );
  });
  protected readonly guard = inject(GuardService);
  protected readonly uncheckedTls = tlsUnchecked;
  protected readonly hostKeyQuestion = (hk: HostKeyRequest): ConfirmRequest => ({
    title: APP_TEXTS.hostKeyTitle,
    message: APP_TEXTS.hostKeyMessage(hk.host, hk.keyType, hk.fingerprint),
    confirm: APP_TEXTS.trust,
  });
  /** The mark of the active connection: its label and how it is protected. */
  protected readonly badge = computed(() => badgeText(this.connections.active()));
  protected readonly exporter = inject(ExportService);
  protected readonly formatter = inject(FormatService);
  protected readonly saved = inject(SavedStore);
  protected readonly paramService = inject(ParamService);
  private readonly values = inject(ValueService);
  protected readonly stats = inject(StatsService);
  protected readonly layouts = inject(ColumnLayouts);
  protected readonly relations = inject(RelationsService);
  protected readonly edit = inject(EditService);
  /** The column list is open. */
  private readonly columnsOpen = signal(false);
  /** What the column list shows: the columns of the result in front and their layout. */
  protected readonly columnsOf = computed(() => {
    const tab = this.tabs.active();
    const current = this.copier.current();
    if (!this.columnsOpen() || !tab || !current) return null;
    return { tab, columns: current.result.columns, layout: this.layouts.of(tab) };
  });

  protected closeColumns(): void {
    const tab = this.tabs.active();
    this.columnsOpen.set(false);
    setTimeout(() => tab?.grid?.focusGrid());
  }

  /** From the column list: the cursor goes into a column (a hidden one is shown first). */
  protected jumpToColumn(index: number): void {
    const c = this.columnsOf();
    if (!c) return;
    const key = columnKeys(c.columns)[index];
    if (c.layout.hidden.includes(key)) {
      this.layouts.set(c.tab, setHidden(c.layout, c.columns, key, false));
    }
    this.columnsOpen.set(false);
    // the grid may be built anew for the layout: the cursor moves once it stands
    setTimeout(() => {
      const grid = c.tab.grid;
      grid?.goTo(grid.cursor()?.[0] ?? 0, index);
      grid?.focusGrid();
    }, 50);
  }

  /** Changes the layout of the result in front by the column the cursor is in. */
  private onColumn(
    change: (layout: ColumnLayout, columns: readonly QueryColumn[], key: string) => ColumnLayout,
  ): void {
    const tab = this.tabs.active();
    const current = this.copier.current();
    const at = tab?.grid?.cursor();
    if (!tab || !current || !at) return this.ownNotice.set(FIND_TEXTS.noCursor);
    const columns = current.result.columns;
    const row = at[0];
    this.layouts.set(tab, change(this.layouts.of(tab), columns, columnKeys(columns)[at[1]]));
    // the cursor stays with its column, wherever that is now
    setTimeout(() => {
      const shown = resolveLayout(this.layouts.of(tab), columns).shown;
      tab.grid?.goTo(row, shown.includes(at[1]) ? at[1] : null);
      tab.grid?.focusGrid();
    }, 50);
  }

  /** The next row of the cursor's column with another value, or with NULL. */
  private async seek(kind: 'change' | 'null'): Promise<void> {
    const tab = this.tabs.active();
    const current = this.copier.current();
    const at = tab?.grid?.cursor();
    if (!tab || !current || !at) return this.ownNotice.set(FIND_TEXTS.noCursor);
    const row = await tab.find.seek(current.result.resultId, at[1], at[0], kind);
    if (row === null) {
      this.ownNotice.set(kind === 'null' ? FIND_TEXTS.noNull : FIND_TEXTS.noOther);
    } else tab.grid?.goTo(row, at[1]);
  }
  protected readonly statsTexts = STATS_TEXTS;
  /** The figures belong to the result in front (or one is being worked out). */
  protected readonly statsShown = computed(() => {
    const front = this.copier.current()?.result.resultId;
    const of = this.stats.stats()?.resultId;
    return this.stats.busy() || (of !== undefined && of === front);
  });
  private readonly fileDialogs = inject(FileDialogApi);
  protected readonly formatTexts = FORMAT_TEXTS;
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
    // what the saved queries have to tell goes where every notice goes
    effect(() => {
      const told = this.saved.notice();
      if (told === null) return;
      untracked(() => {
        this.ownNotice.set(told);
        this.saved.notice.set(null);
      });
    });
    effect(() => {
      const told = this.values.notice();
      if (told === null) return;
      untracked(() => {
        this.ownNotice.set(told);
        this.values.notice.set(null);
      });
    });
  }

  async ngOnInit(): Promise<void> {
    this.cleanups.push(
      this.actions.attach(document),
      this.registerActions(),
      ...this.registerChecks(),
    );
    this.actions.reportError = (message) => this.ownNotice.set(message);
    const engine = this.actions.load();
    // both before the window shows: the stored scheme may be one of the user's own (design 001 E7)
    await Promise.all([this.settings.load(), this.theme.loadUserThemes()]);
    await engine;
    this.menus.init();
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
    if (isTauri()) this.cleanups.push(await this.listenForClose());
    const tick = setInterval(() => {
      if (this.txIsOpen()) this.clock.set(Date.now());
    }, 5000);
    this.cleanups.push(() => clearInterval(tick));
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
        // a database file becomes a connection, everything else a tab
        const database = payload.paths.find(isDatabaseFile);
        if (database) {
          this.connectionDialog.set({
            ...emptyProfile('sqlite'),
            database,
            name: database.split(/[\\/]/).pop() ?? '',
            savePassword: false,
          });
        }
        const scripts = payload.paths.filter((p) => !isDatabaseFile(p));
        if (scripts.length > 0) void this.tabs.openFiles(scripts);
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
    /** Formats in the active tab and says what happened, if there is something to say. */
    const format = (mode: FormatMode, whole: boolean) => async () => {
      try {
        const outcome = (await tab()?.format(mode, whole)) ?? 'nothing';
        const notice = this.formatter.notice(outcome);
        if (notice) this.ownNotice.set(notice);
      } catch (e) {
        this.ownNotice.set(this.formatter.failure(e));
      }
    };
    const canFormat = () => !!tab() && !this.formatter.running();
    /** A condition from the cell under the cursor of a table view (prompt 027). */
    const quick = (kind: QuickFilter) => async () => {
      const t = tab();
      const cell = this.values.cell();
      if (!t?.tableView()) return this.ownNotice.set(FILTER_TEXTS.noTable);
      if (!cell) return this.ownNotice.set(FILTER_TEXTS.noCell);
      if (!(await t.quickFilter(kind, cell))) this.ownNotice.set(FILTER_TEXTS.notAValue);
    };
    const inTable = () => !!tab()?.tableView() && this.values.cell() !== null;
    const offs = [
      this.actions.register('FILTER_CELL_EQ', quick('eq'), inTable),
      this.actions.register('FILTER_CELL_NE', quick('ne'), inTable),
      this.actions.register('FILTER_CELL_GT', quick('gt'), inTable),
      this.actions.register('FILTER_CELL_LT', quick('lt'), inTable),
      this.actions.register('FILTER_CELL_NULL', quick('null'), inTable),
      this.actions.register(
        'FILTER_RESET',
        () => {
          const t = tab();
          const view = t?.tableView();
          if (view) void t?.applyTable({ ...EMPTY_SPEC, limit: view.spec.limit });
          t?.dropLocal();
        },
        () => !!tab()?.tableView() || !!tab()?.localView() || !!tab()?.localSpec().sort.length,
      ),
      this.actions.register('FORMAT_SQL', format('format', false), canFormat),
      this.actions.register('FORMAT_SCRIPT', format('format', true), canFormat),
      this.actions.register('SQL_ONE_LINE', format('oneline', false), canFormat),
      this.actions.register('KEYWORDS_UPPER', format('upper', false), canFormat),
      this.actions.register('KEYWORDS_LOWER', format('lower', false), canFormat),
      this.actions.register(
        'TOGGLE_COMMENT',
        () => tab()?.toggleComment(),
        () => !!tab(),
      ),
      this.actions.register(
        'CANCEL_FORMAT',
        () => this.formatter.cancel(),
        () => this.formatter.running(),
      ),
      this.actions.register(
        'RUN_STATEMENT',
        () => tab()?.runCurrent(),
        () => !this.running() && !!tab(),
      ),
      this.actions.register(
        'EXPAND_STAR',
        async () => {
          if (!(await tab()?.expandStar())) this.ownNotice.set(APP_TEXTS.noStar);
        },
        () => !!tab(),
      ),
      this.actions.register(
        'COPY_CELL_VALUE',
        () => this.values.copy(),
        () => this.values.cell() !== null,
      ),
      ...this.resultActions(),
      this.actions.register(
        'SUMMARIZE_COLUMN',
        () => {
          const cell = this.values.cell();
          if (!cell) return this.ownNotice.set(STATS_TEXTS.noCell);
          void this.stats.summarize(cell.resultId, cell.col, cell.column);
        },
        () => this.values.cell() !== null,
      ),
      this.actions.register(
        'COPY_SELECTION_SUM',
        async () => {
          if (!(await this.stats.copySum())) this.ownNotice.set(STATS_TEXTS.noSum);
        },
        () => this.stats.hasSum(),
      ),
      this.actions.register(
        'SAVE_CELL_VALUE',
        () => {
          const cell = this.values.cell();
          if (cell) void this.values.save(extensionOf(cell.column.kind));
        },
        () => this.values.cell() !== null,
      ),
      this.actions.register(
        'RUN_AGAIN',
        () => {
          if (!tab()?.runAgain()) this.ownNotice.set(PARAM_TEXTS.noValues);
        },
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
      this.actions.register(
        'EXPORT_RESULT',
        () => this.exportResult(),
        () => this.copier.current() !== null && !this.exporter.running(),
      ),
      this.actions.register(
        'CANCEL_EXPORT',
        () => this.exporter.cancel(),
        () => this.exporter.running(),
      ),
      this.actions.register(
        'REVEAL_EXPORT',
        () => this.exporter.reveal(),
        () => this.exporter.job()?.state === 'done',
      ),
      this.actions.register(
        'TX_COMMIT',
        () => this.endTransaction(true),
        () => this.tabs.active()?.tx() === 'active' && !this.running(),
      ),
      this.actions.register(
        'TX_ROLLBACK',
        () => this.endTransaction(false),
        () => this.txIsOpen() && !this.running(),
      ),
      this.actions.register(
        'TOGGLE_AUTOCOMMIT',
        () => {
          const t = tab();
          if (!t) return;
          if (t.manual() && txOpen(t.tx())) {
            this.ownNotice.set(APP_TEXTS.txStillOpen);
            return;
          }
          t.manual.update((m) => !m);
        },
        () => !!tab(),
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
              ? APP_TEXTS.historyConnectionOn
              : APP_TEXTS.historyConnectionOff,
          );
        },
        () => !!tab(),
      ),
      this.actions.register('TOGGLE_HISTORY', () => {
        const on = !this.settings.settings().historyEnabled;
        this.settings.update({ historyEnabled: on });
        this.ownNotice.set(on ? APP_TEXTS.historyOn : APP_TEXTS.historyOff);
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
      this.actions.register('TOGGLE_CONFIRM_DANGEROUS', () => {
        const on = !this.settings.settings().confirmDangerous;
        this.settings.update({ confirmDangerous: on });
        this.ownNotice.set(on ? APP_TEXTS.confirmDangerousOn : APP_TEXTS.confirmDangerousOff);
      }),
      this.actions.register('TOGGLE_DIGIT_GROUPING', () =>
        this.settings.update({ groupDigits: !this.settings.settings().groupDigits }),
      ),
      this.actions.register(
        'CANCEL_QUERY',
        () => tab()?.cancel(),
        () => this.running(),
      ),
      this.actions.register(
        'CLOSE_OTHER_TABS',
        () => {
          const id = this.tabs.activeId();
          return id ? this.tabs.closeOthers(id) : undefined;
        },
        () => this.tabs.tabs().length > 1,
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
        RENAME_TAB: withTab((id) => this.tabs.renaming.set(id)),
        QUIT_APP: () => this.quit(),
        NEXT_TAB: () => this.tabs.cycle(1),
        PREV_TAB: () => this.tabs.cycle(-1),
        DUPLICATE_TAB: withTab((id) => this.tabs.duplicate(id)),
        OPEN_FILE: () => this.tabs.openFiles(),
        // a table with changes that are not written: „save“ writes them (as TablePlus does)
        SAVE_FILE: withTab((id) => {
          const t = this.tabs.active();
          return t && this.edit.count(t).cells > 0 ? this.edit.save(t) : this.tabs.save(id);
        }),
        SAVE_FILE_AS: withTab((id) => this.tabs.save(id, true)),
        NEW_CONNECTION: () => this.connectionDialog.set(emptyProfile()),
        IMPORT_CONNECTIONS: () => this.importOpen.set(true),
        TOGGLE_SIDEBAR: () => {
          // in zen mode the sidebar is out of sight whatever the setting says: asking for it ends zen
          if (this.zen()) {
            this.zen.set(false);
            this.settings.update({ sidebarVisible: true });
          } else {
            this.settings.update({ sidebarVisible: !this.settings.settings().sidebarVisible });
          }
        },
        SPLIT_RIGHT: () => this.split('row'),
        SPLIT_DOWN: () => this.split('column'),
        MOVE_TAB_TO_OTHER_GROUP: withTab((id) => {
          this.tabs.moveToOtherGroup(id);
          this.focusFront();
        }),
        FOCUS_OTHER_GROUP: () => this.tabs.focusOtherGroup(),
        UNSPLIT: () => {
          this.tabs.unsplit();
          this.focusFront();
        },
        TOGGLE_RESULT: () => {
          const visible = this.settings.settings().resultVisible;
          // a maximised result that is sent away gives the editor back
          if (this.tabs.resultMaximized()) this.tabs.resultMaximized.set(false);
          this.settings.update({ resultVisible: !visible });
          if (visible) this.focusFront();
        },
        TOGGLE_RESULT_PLACEMENT: () =>
          this.settings.update({
            resultVisible: true,
            resultPlacement:
              this.settings.settings().resultPlacement === 'right' ? 'bottom' : 'right',
          }),
        MAXIMIZE_RESULT: () => {
          const max = !this.tabs.resultMaximized();
          this.tabs.resultMaximized.set(max);
          // the focus must not stay in an editor that is out of sight
          if (max) setTimeout(() => this.focusArea('result'));
          else this.focusFront();
        },
        SIDEBAR_DATABASE: () => this.showSidebarView('database'),
        SIDEBAR_HISTORY: () => this.showSidebarView('history'),
        TOGGLE_ZEN: () => {
          const zen = !this.zen();
          this.zen.set(zen);
          if (zen) {
            this.ownNotice.set(
              APP_TEXTS.zen(this.actions.hint('TOGGLE_ZEN'), this.actions.hint('OPEN_PALETTE')),
            );
            this.focusFront();
          }
        },
        COLOR_SCHEME: () => this.theme.pickerOpen.set(true),
        EDIT_COLOR_SCHEME: () => this.editCurrentScheme(),
        OPEN_PALETTE: () => this.openPalette('commands'),
        GOTO_ANYTHING: () => this.openPalette('goto'),
        GOTO_SAVED: () => this.openPalette('goto', 'q: '),
        TOGGLE_FILTER_BAR: () =>
          this.settings.update({
            filterBarVisible: !this.settings.settings().filterBarVisible,
            resultVisible: true,
          }),
        TOGGLE_VALUE_PANEL: () =>
          this.settings.update({
            valuePanelVisible: !this.settings.settings().valuePanelVisible,
            resultVisible: true,
          }),
        SIDEBAR_SAVED: () => this.showSidebarView('saved'),
        SAVE_QUERY: () => void this.saveQuery(),
        SAVED_FOLDER: () => void this.chooseSavedFolder(),
        SAVED_DEFAULT_FOLDER: () => void this.saved.useFolder(null),
        OPEN_SNIPPETS: () => this.snippetsOpen.set(true),
        OPEN_SETTINGS: () => this.settingsOpen.set(true),
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

  private split(direction: 'row' | 'column'): void {
    this.tabs.split(direction);
    this.focusFront();
  }

  /** The editor of the tab in front, once the page has followed a change of the layout. */
  private focusFront(): void {
    setTimeout(() => this.tabs.active()?.focus(), 50);
  }

  private openPalette(mode: 'commands' | 'goto', query = ''): void {
    this.paletteQuery.set(query);
    this.paletteOpen.set(mode);
  }

  /** The selection of the tab in front, else its whole text, becomes a saved query (prompt 024). */
  private async saveQuery(): Promise<void> {
    const tab = this.tabs.active();
    if (!tab) return;
    const selection = await tab.selectedText();
    const text = selection.trim() !== '' ? selection : ((await tab.text()) ?? '');
    this.saved.ask(text, nameFromText(text));
  }

  private async chooseSavedFolder(): Promise<void> {
    const path = await this.fileDialogs.openFolder(SAVED_TEXTS.folder);
    if (path !== null) await this.saved.useFolder(path);
  }

  private showSidebarView(view: SidebarView): void {
    this.zen.set(false);
    this.settings.update({ sidebarVisible: true, sidebarView: view });
    setTimeout(() => this.focusArea('sidebar'), 50);
  }

  /** The arrows of the view tabs of the sidebar (APG tabs, shown at once). */
  protected onViewKey(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const now = this.settings.settings().sidebarView;
    const at = SIDEBAR_VIEWS.indexOf(now);
    const n = SIDEBAR_VIEWS.length;
    const view: SidebarView =
      event.key === 'Home'
        ? SIDEBAR_VIEWS[0]
        : event.key === 'End'
          ? SIDEBAR_VIEWS[n - 1]
          : SIDEBAR_VIEWS[(at + (event.key === 'ArrowRight' ? 1 : n - 1)) % n];
    this.settings.update({ sidebarView: view });
    setTimeout(() => document.getElementById(`view-${view}`)?.focus());
  }

  private async endTransaction(commit: boolean): Promise<void> {
    const problem = await this.tabs.active()?.endTransaction(commit);
    if (problem) {
      this.ownNotice.set(
        commit ? APP_TEXTS.commitFailed(problem) : APP_TEXTS.rollbackFailed(problem),
      );
    }
  }

  /** Closes the window like its close button: tabs with an open transaction are asked about first. */
  private async quit(): Promise<void> {
    this.tabs.flush();
    if (isTauri()) await getCurrentWindow().close();
  }

  /** The switches among the actions: menus tick them. */
  private registerChecks(): (() => void)[] {
    const s = () => this.settings.settings();
    const checks: Partial<Record<ActionId, () => boolean>> = {
      TOGGLE_SIDEBAR: () => this.sidebarShown(),
      TOGGLE_RESULT: () => s().resultVisible,
      MAXIMIZE_RESULT: () => this.tabs.resultMaximized(),
      TOGGLE_ZEN: () => this.zen(),
      TOGGLE_DIGIT_GROUPING: () => s().groupDigits,
      TOGGLE_AUTOCOMMIT: () => !(this.tabs.active()?.manual() ?? false),
      TOGGLE_HISTORY: () => s().historyEnabled,
      TOGGLE_HISTORY_CONNECTION: () => this.history.enabled(this.connections.activeId()),
      TOGGLE_CONFIRM_DANGEROUS: () => s().confirmDangerous,
      TOGGLE_SYSTEM_SCHEMAS: () => s().showSystemSchemas,
      TOGGLE_COPY_HEADER: () => s().copyHeader,
      SIDEBAR_DATABASE: () => s().sidebarView === 'database',
      SIDEBAR_HISTORY: () => s().sidebarView === 'history',
      SIDEBAR_SAVED: () => s().sidebarView === 'saved',
      TOGGLE_VALUE_PANEL: () => s().valuePanelVisible,
      TOGGLE_FILTER_BAR: () => s().filterBarVisible,
    };
    return Object.entries(checks).map(([id, on]) =>
      this.actions.registerCheck(id as ActionId, on as () => boolean),
    );
  }

  /** The window is about to close: tabs with an open transaction are asked about first. */
  private async listenForClose(): Promise<() => void> {
    const window = getCurrentWindow();
    return window.onCloseRequested(async (event) => {
      // nothing is lost by closing: no open transaction, no change that is not written
      const loses = (t: QueryTab) => txOpen(t.tx()) || this.edit.count(t).cells > 0;
      if (!this.tabs.tabs().some(loses)) return;
      event.preventDefault();
      if (await this.tabs.settleTransactions(this.tabs.tabs(), APP_TEXTS.theWindow)) {
        await window.destroy();
      }
    });
  }

  /** Columns of the result and searching in it (prompt 029). */
  private resultActions(): (() => void)[] {
    const tab = () => this.tabs.active();
    const has = () => this.copier.current() !== null;
    const hits = () => has() && (tab()?.find.count() ?? 0) > 0;
    const step = (direction: 1 | -1) => () => {
      const t = tab();
      const hit = t?.find.step(t.grid?.cursor() ?? null, direction);
      if (hit) t?.grid?.goTo(hit[0], hit[1]);
    };
    const find = (field: 'text' | 'row') => () => {
      if (!has()) return this.ownNotice.set(FIND_TEXTS.noResult);
      if (!this.settings.settings().resultVisible) this.settings.update({ resultVisible: true });
      tab()?.find.show(field);
    };
    const register = this.actions.register.bind(this.actions);
    // following foreign keys (prompt 030): in a table view, where the table of every column is known
    const table = () => has() && !!tab()?.tableView();
    const edited = () => this.edit.count(tab()).cells > 0;
    const related = (run: (t: QueryTab) => unknown) => () => {
      const t = tab();
      if (t) void run(t);
    };
    return [
      // editing cells (prompt 031): changes are collected, then written together
      register(
        'EDIT_CELL',
        related((t) => this.edit.begin(t)),
        table,
      ),
      register(
        'EDIT_SET_NULL',
        related((t) => this.edit.setAtCursor(t, { kind: 'null' })),
        table,
      ),
      register(
        'EDIT_SET_DEFAULT',
        related((t) => this.edit.setAtCursor(t, { kind: 'default' })),
        table,
      ),
      register(
        'EDIT_UNDO',
        related((t) => this.edit.undo(t)),
        () => (tab()?.edits().undo.length ?? 0) > 0,
      ),
      register(
        'EDIT_REDO',
        related((t) => this.edit.redo(t)),
        () => (tab()?.edits().redo.length ?? 0) > 0,
      ),
      register(
        'EDIT_RESET_CELL',
        related((t) => this.edit.resetCell(t)),
        edited,
      ),
      register(
        'EDIT_RESET_ROW',
        related((t) => this.edit.resetRowAtCursor(t)),
        edited,
      ),
      register(
        'EDIT_DISCARD',
        related((t) => this.edit.discardAsked(t)),
        edited,
      ),
      register(
        'EDIT_PREVIEW',
        related((t) => this.edit.showPreview(t)),
        edited,
      ),
      register(
        'EDIT_SAVE',
        related((t) => this.edit.save(t)),
        edited,
      ),
      register(
        'FK_FOLLOW',
        related((t) => this.relations.follow(t, 'here')),
        table,
      ),
      register(
        'FK_FOLLOW_TAB',
        related((t) => this.relations.follow(t, 'tab')),
        table,
      ),
      register(
        'FK_PEEK',
        related((t) => this.relations.follow(t, 'peek')),
        table,
      ),
      register(
        'FK_REFERENCED_BY',
        related((t) => this.relations.referencedBy(t)),
        table,
      ),
      register(
        'NAV_BACK',
        related((t) => this.relations.back(t)),
        () => this.relations.canBack(tab() ?? null),
      ),
      register(
        'NAV_FORWARD',
        related((t) => this.relations.forward(t)),
        () => this.relations.canForward(tab() ?? null),
      ),
      register(
        'FK_DEFINE',
        related((t) => this.relations.define(t)),
        table,
      ),
      register('FIND_IN_RESULT', find('text'), has),
      register('FIND_NEXT', step(1), hits),
      register('FIND_PREV', step(-1), hits),
      register('GOTO_ROW', find('row'), has),
      register('RESULT_FIRST_ROW', () => tab()?.grid?.goTo(0, null), has),
      register(
        'RESULT_LAST_ROW',
        () => tab()?.grid?.goTo((this.copier.current()?.rows ?? 1) - 1, null),
        has,
      ),
      register('NEXT_CHANGE', () => this.seek('change'), has),
      register('NEXT_NULL', () => this.seek('null'), has),
      register('RESULT_COLUMNS', () => this.columnsOpen.set(true), has),
      register('COLUMN_HIDE', () => this.onColumn((l, c, key) => setHidden(l, c, key, true)), has),
      register(
        'COLUMN_PIN',
        () => this.onColumn((l, c, key) => setPinned(l, c, key, !l.pinned.includes(key))),
        has,
      ),
      register('COLUMN_LEFT', () => this.onColumn((l, c, key) => moveColumn(l, c, key, -1)), has),
      register('COLUMN_RIGHT', () => this.onColumn((l, c, key) => moveColumn(l, c, key, 1)), has),
      register('COLUMNS_FIT', () => tab()?.grid?.fitWidths(), has),
      register(
        'COLUMNS_RESET',
        () => {
          const t = tab();
          if (t) this.layouts.set(t, EMPTY_LAYOUT);
        },
        has,
      ),
    ];
  }

  /** Opens the export dialog for the result in front: what is selected in its grid, or all of it. */
  private exportResult(): void {
    const current = this.copier.current();
    if (!current) return;
    const table = tableOf(current.sql);
    this.exporter.request.set({
      kind: 'result',
      resultId: current.result.resultId,
      columns: current.result.columns,
      rows: current.rows,
      ranges: this.copier.selection().rows,
      sql: current.sql,
      connectionId: current.connectionId,
      name: table?.replace(/["`[\]]/g, '') ?? this.tabs.active()?.title() ?? 'export',
      table: table ?? tablePlaceholder(),
    });
  }

  /** The statement before or after the one in the editor, from the history of the tab's connection. */
  private async recall(step: 1 | -1): Promise<void> {
    const tab = this.tabs.active();
    if (!tab) return;
    const now = (await tab.text()) ?? '';
    const text = await this.history.recalled(tab.id, tab.connectionId(), now, step);
    if (text === null) {
      if (now.trim() !== '') {
        this.ownNotice.set(APP_TEXTS.editorNotEmpty);
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
    const areas: Area[] = [];
    if (this.sidebarShown()) areas.push('sidebar');
    if (!this.tabs.resultMaximized()) areas.push('editor');
    if (this.settings.settings().resultVisible || this.tabs.resultMaximized()) areas.push('result');
    return areas;
  }

  /** The result area of the tab in front. */
  private results(): HTMLElement | null {
    return (
      this.column()?.nativeElement.querySelector<HTMLElement>('app-query-pane.front .results') ??
      null
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
      this.tabs.resultMaximized.set(false);
      this.focusFront();
    } else if (area === 'sidebar') {
      const first = '#sidebar-view :is(button, input, [tabindex="0"])';
      if (!this.sidebarShown()) {
        this.zen.set(false);
        this.settings.update({ sidebarVisible: true });
        // the sidebar is drawn with the next change detection
        setTimeout(() => this.sidebar()?.nativeElement.querySelector<HTMLElement>(first)?.focus());
        return;
      }
      this.sidebar()?.nativeElement.querySelector<HTMLElement>(first)?.focus();
    } else {
      if (!this.settings.settings().resultVisible && !this.tabs.resultMaximized()) {
        this.settings.update({ resultVisible: true });
        setTimeout(() => this.focusArea('result'));
        return;
      }
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
