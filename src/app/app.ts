import {
  ChangeDetectionStrategy,
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
import { ActionService } from './core/actions/action.service';
import { emptyProfile, DEMO_ID, Profile } from './core/connections/connection.models';
import { ConnectionsStore } from './core/connections/connections.store';
import { DEFAULT_SETTINGS } from './core/settings/settings.models';
import { SettingsService } from './core/settings/settings.service';
import { ThemeService } from './core/theme/theme.service';
import { ConnectionDialog } from './features/connections/connection-dialog';
import { ConnectionList } from './features/connections/connection-list';
import { PasswordDialog } from './features/connections/password-dialog';
import { EdCaret } from './features/editor/editlicious';
import { SqlEditor } from './features/editor/sql-editor';
import { CommandPalette } from './features/palette/command-palette';
import { ResultGrid } from './features/results/result-grid';
import { QuerySession, statusText } from './features/shell/query-session';
import { ShortcutDialogComponent } from './features/shortcuts/shortcut-dialog';
import { ThemeEditor } from './features/themes/theme-editor';
import { copyName } from './features/themes/theme-editor-logic';
import { ThemePickerComponent } from './features/themes/theme-picker';
import { SplitterComponent } from './shared/splitter';

const SIDEBAR_MIN = 140;
const RESULT_MIN = 80;
/** What the editor keeps at least, px. */
const EDITOR_MIN = 120;

const START_SQL = `-- Schema Commander
-- Die Demo-Datenbank im Speicher (SQLite) hat die Tabellen customer, product, orders.
-- Strg/Cmd+Enter führt die Anweisung unter dem Cursor aus, Strg/Cmd+Shift+P zeigt alle Befehle.

SELECT c.name, c.country, count(*) AS orders, round(sum(o.quantity * p.price), 2) AS revenue
FROM orders o
JOIN customer c ON c.id = o.customer_id
JOIN product p ON p.id = o.product_id
GROUP BY c.id
ORDER BY revenue DESC;

SELECT * FROM orders;
`;

/**
 * The window of the walking skeleton: toolbar, sidebar (the schema tree to be), SQL editor, result
 * area and status line. Sizes and the colour scheme are settings.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommandPalette,
    ConnectionDialog,
    ConnectionList,
    PasswordDialog,
    ResultGrid,
    ShortcutDialogComponent,
    SplitterComponent,
    SqlEditor,
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
        [title]="'Anweisung unter dem Cursor ausführen' + actions.hint('RUN_STATEMENT')"
        [disabled]="state().kind === 'running'"
        (click)="actions.run('RUN_STATEMENT')"
      >
        ▶ Ausführen
      </button>
      @if (state().kind === 'running') {
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
          <app-connection-list (edit)="connectionDialog.set($event)" />
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
      <div class="column">
        <app-sql-editor
          class="editor"
          [initialValue]="startSql"
          (run)="session.run($event)"
          (caret)="caret.set($event)"
        />
        <app-splitter
          orientation="horizontal"
          pane="after"
          label="Höhe des Ergebnisbereichs"
          controls="results"
          [size]="resultH()"
          [min]="resultMin"
          [max]="resultMaxH()"
          [defaultSize]="defaults.resultHeight"
          (sizeChange)="dragHeight.set($event)"
          (sizeCommit)="commitHeight($event)"
        />
        <section
          #results
          id="results"
          class="results"
          aria-label="Ergebnis"
          tabindex="-1"
          [style.height.px]="resultH()"
        >
          @switch (state().kind) {
            @case ('done') {
              @if (result(); as r) {
                @if (r.rowsAffected === null) {
                  <app-result-grid [result]="r" />
                } @else {
                  <p class="message">{{ status() }}</p>
                }
              }
            }
            @case ('failed') {
              <p class="message error" role="alert">{{ errorMessage() }}</p>
            }
            @case ('running') {
              <p class="message">Läuft …</p>
            }
            @case ('cancelled') {
              <p class="message">Abgebrochen.</p>
            }
            @default {
              <p class="message">Noch kein Ergebnis. Strg/Cmd+Enter führt die Anweisung aus.</p>
            }
          }
        </section>
      </div>
    </div>
    <footer class="status" role="status">
      <span>{{ status() }}</span>
      <span class="spacer"></span>
      @if (caret(); as c) {
        <span>Zeile {{ c.line }}, Spalte {{ c.ch }}</span>
      }
    </footer>
    @if (notice(); as message) {
      <div class="notice" role="alert">
        <span>{{ message }}</span>
        <button type="button" aria-label="Meldung schließen" (click)="notice.set(null)">×</button>
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
  protected readonly session = inject(QuerySession);
  protected readonly actions = inject(ActionService);
  protected readonly connections = inject(ConnectionsStore);

  /** The connection dialog is open with this profile (`id === ''` = a new one). */
  protected readonly connectionDialog = signal<Profile | null>(null);

  protected readonly paletteOpen = signal(false);
  /** The shortcut editor, `read` as an overview. */
  protected readonly shortcutsOpen = signal<'edit' | 'read' | null>(null);
  /** A message of the app itself (failed action, unreadable shortcuts). */
  protected readonly notice = signal<string | null>(null);
  private readonly sidebar = viewChild<ElementRef<HTMLElement>>('sidebar');
  private readonly results = viewChild<ElementRef<HTMLElement>>('results');
  private readonly cleanups: (() => void)[] = [];

  protected readonly startSql = START_SQL;
  protected readonly defaults = DEFAULT_SETTINGS;
  protected readonly sidebarMin = SIDEBAR_MIN;
  protected readonly resultMin = RESULT_MIN;

  protected readonly editor = viewChild(SqlEditor);
  protected readonly caret = signal<EdCaret | null>(null);
  protected readonly state = this.session.state;
  protected readonly status = computed(() => statusText(this.state()));
  protected readonly result = computed(() => {
    const s = this.state();
    return s.kind === 'done' ? s.result : null;
  });
  protected readonly errorMessage = computed(() => {
    const s = this.state();
    return s.kind === 'failed' ? s.message : '';
  });

  // Sizes are stored when a drag ends; in between the drag signals hold them.
  protected readonly dragWidth = signal<number | null>(null);
  protected readonly dragHeight = signal<number | null>(null);
  private readonly workspace = viewChild<ElementRef<HTMLElement>>('workspace');
  private readonly workspaceW = signal(0);
  private readonly workspaceH = signal(0);
  protected readonly sidebarMaxW = computed(() => Math.max(SIDEBAR_MIN, this.workspaceW() * 0.6));
  protected readonly resultMaxH = computed(() =>
    Math.max(RESULT_MIN, this.workspaceH() - EDITOR_MIN),
  );
  protected readonly sidebarW = computed(() =>
    clamp(
      this.dragWidth() ?? this.settings.settings().sidebarWidth,
      SIDEBAR_MIN,
      this.sidebarMaxW(),
    ),
  );
  protected readonly resultH = computed(() =>
    clamp(
      this.dragHeight() ?? this.settings.settings().resultHeight,
      RESULT_MIN,
      this.resultMaxH(),
    ),
  );
  private observer: ResizeObserver | null = null;

  constructor() {
    effect(() => {
      const element = this.workspace()?.nativeElement;
      this.observer?.disconnect();
      this.observer = null;
      if (!element || typeof ResizeObserver === 'undefined') return;
      const measure = () => {
        this.workspaceW.set(element.clientWidth);
        this.workspaceH.set(element.clientHeight);
      };
      measure();
      this.observer = new ResizeObserver(measure);
      this.observer.observe(element);
    });
  }

  async ngOnInit(): Promise<void> {
    // both before the window shows: the stored scheme may be one of the user's own (design 001 E7)
    this.cleanups.push(this.actions.attach(document), this.registerActions());
    this.actions.reportError = (message) => this.notice.set(message);
    const engine = this.actions.load();
    await Promise.all([this.settings.load(), this.theme.loadUserThemes()]);
    await engine;
    // after the settings: they name the active connection
    await this.connections.load();
    const notice = this.actions.startNotice();
    if (notice) this.notice.set(notice);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    for (const cleanup of this.cleanups) cleanup();
  }

  /** The actions of the window: run, layout, dialogs, moving between its areas. */
  private registerActions(): () => void {
    const running = () => this.state().kind === 'running';
    const offs = [
      this.actions.register(
        'RUN_STATEMENT',
        () => this.editor()?.runCurrent(),
        () => !running() && !!this.editor(),
      ),
      this.actions.register('CANCEL_QUERY', () => this.session.cancel(), running),
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

  private currentArea(): Area | null {
    const active = document.activeElement;
    if (!active) return null;
    if (this.sidebar()?.nativeElement.contains(active)) return 'sidebar';
    if (this.results()?.nativeElement.contains(active)) return 'result';
    if (active.closest('app-sql-editor')) return 'editor';
    return null;
  }

  private focusArea(area: Area): void {
    if (area === 'editor') {
      this.editor()?.focus();
    } else if (area === 'sidebar') {
      if (!this.settings.settings().sidebarVisible) {
        this.settings.update({ sidebarVisible: true });
        // the sidebar is drawn with the next change detection
        setTimeout(() => this.sidebar()?.nativeElement.querySelector('button')?.focus());
        return;
      }
      this.sidebar()?.nativeElement.querySelector('button')?.focus();
    } else {
      const host = this.results()?.nativeElement;
      const grid = host?.querySelector<HTMLElement>('.ge-table [tabindex], .ge-table');
      (grid ?? host)?.focus();
    }
  }

  protected commitWidth(width: number): void {
    this.dragWidth.set(null);
    this.settings.update({ sidebarWidth: width });
  }

  protected commitHeight(height: number): void {
    this.dragHeight.set(null);
    this.settings.update({ resultHeight: height });
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
