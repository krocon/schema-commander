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
import { DEFAULT_SETTINGS } from './core/settings/settings.models';
import { SettingsService } from './core/settings/settings.service';
import { ThemeService } from './core/theme/theme.service';
import { EdCaret } from './features/editor/editlicious';
import { SqlEditor } from './features/editor/sql-editor';
import { ResultGrid } from './features/results/result-grid';
import { QuerySession, statusText } from './features/shell/query-session';
import { ThemePickerComponent } from './features/themes/theme-picker';
import { SplitterComponent } from './shared/splitter';

const SIDEBAR_MIN = 140;
const RESULT_MIN = 80;
/** What the editor keeps at least, px. */
const EDITOR_MIN = 120;

const START_SQL = `-- Schema Commander – Walking Skeleton
-- Demo-Datenbank im Speicher (SQLite): customer, product, orders.
-- Strg/Cmd+Enter führt die Anweisung unter dem Cursor aus.

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
  imports: [ResultGrid, SplitterComponent, SqlEditor, ThemePickerComponent],
  template: `
    <header class="toolbar" role="toolbar" aria-label="Werkzeugleiste">
      <button
        type="button"
        title="Seitenleiste ein-/ausblenden"
        [attr.aria-pressed]="settings.settings().sidebarVisible"
        (click)="toggleSidebar()"
      >
        ☰
      </button>
      <button
        type="button"
        class="primary"
        title="Anweisung unter dem Cursor ausführen (Strg/Cmd+Enter)"
        [disabled]="state().kind === 'running'"
        (click)="editor()?.runCurrent()"
      >
        ▶ Ausführen
      </button>
      <span class="spacer"></span>
      <span class="conn conn-3" title="Verbindung"><i></i>Demo (SQLite im Speicher)</span>
      <button
        type="button"
        title="Farbschema wählen"
        aria-label="Farbschema wählen"
        (click)="theme.pickerOpen.set(true)"
      >
        ◐
      </button>
    </header>
    <div #workspace class="workspace">
      @if (settings.settings().sidebarVisible) {
        <nav id="sidebar" class="sidebar" aria-label="Datenbank" [style.width.px]="sidebarW()">
          <h2>Demo</h2>
          <ul>
            @for (table of demoTables; track table) {
              <li>
                <button type="button" (click)="session.run('SELECT * FROM ' + table)">
                  ▦ {{ table }}
                </button>
              </li>
            }
          </ul>
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
        <section id="results" class="results" aria-label="Ergebnis" [style.height.px]="resultH()">
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
    @if (theme.pickerOpen()) {
      @defer (on immediate) {
        <app-theme-picker (closed)="theme.pickerOpen.set(false)" />
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

  protected readonly startSql = START_SQL;
  protected readonly demoTables = ['customer', 'product', 'orders'];
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
    await this.settings.load();
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  protected toggleSidebar(): void {
    this.settings.update({ sidebarVisible: !this.settings.settings().sidebarVisible });
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
