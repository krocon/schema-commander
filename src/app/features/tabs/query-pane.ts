import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { DEFAULT_SETTINGS } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { SplitterComponent } from '../../shared/splitter';
import { EdChange } from '../editor/editlicious';
import { SqlEditor } from '../editor/sql-editor';
import { Dialect } from '../editor/sql-split';
import { ResultGrid } from '../results/result-grid';
import { QueryTab, TabEditor } from './query-tab';
import { StatementRun, clock, outcomeText, statusText } from './run-state';
import { TabsStore } from './tabs.store';

const RESULT_MIN = 80;
/** What the editor keeps at least, px. */
const EDITOR_MIN = 120;

/**
 * The content of one query tab (prompt 004): its editor above, its result below, a splitter between. Every
 * shown tab keeps its pane – and with it undo history, caret and scroll position – while another is in front.
 */
@Component({
  selector: 'app-query-pane',
  imports: [ResultGrid, SplitterComponent, SqlEditor],
  host: {
    role: 'tabpanel',
    '[attr.aria-labelledby]': '"tab-" + tab().id',
    '[id]': '"pane-" + tab().id',
  },
  template: `
    @if (startText(); as start) {
      <app-sql-editor
        class="editor"
        [initialValue]="start.text"
        [label]="'SQL-Editor: ' + tab().title()"
        [dialect]="dialect()"
        (run)="tab().runAll($event)"
        (caret)="tab().caret.set($event)"
        (changed)="onChanged($event)"
      />
    } @else {
      <p class="editor message">Text wird geladen …</p>
    }
    <app-splitter
      orientation="horizontal"
      pane="after"
      label="Höhe des Ergebnisbereichs"
      [controls]="'results-' + tab().id"
      [size]="resultH()"
      [min]="resultMin"
      [max]="resultMaxH()"
      [defaultSize]="defaults.resultHeight"
      (sizeChange)="dragHeight.set($event)"
      (sizeCommit)="commitHeight($event)"
    />
    <section
      class="results"
      aria-label="Ergebnis"
      tabindex="-1"
      [id]="'results-' + tab().id"
      [style.height.px]="resultH()"
    >
      @if (tab().runs().length > 1 || tab().log().length > 0) {
        <div class="subtabs" role="tablist" aria-label="Ergebnisse">
          @for (run of tab().runs(); track $index) {
            @if (tab().runs().length > 1) {
              <button
                type="button"
                role="tab"
                [class]="'sub ' + run.kind"
                [attr.aria-selected]="tab().shown() === $index"
                [tabindex]="tab().shown() === $index ? 0 : -1"
                [title]="run.sql"
                (click)="tab().shown.set($index)"
                (keydown)="onSubKey($event)"
              >
                <span class="mark" aria-hidden="true">{{ mark(run) }}</span>
                {{ $index + 1 }}
                <span class="sr">{{ outcome(run) }}</span>
              </button>
            }
          }
          <button
            type="button"
            role="tab"
            class="sub"
            [attr.aria-selected]="tab().shown() === 'messages'"
            [tabindex]="tab().shown() === 'messages' ? 0 : -1"
            (click)="tab().shown.set('messages')"
            (keydown)="onSubKey($event)"
          >
            Meldungen
          </button>
        </div>
      }
      <div class="body" role="tabpanel">
        @if (tab().shown() === 'messages') {
          <ol class="log" aria-label="Meldungen">
            @for (entry of tab().log(); track $index) {
              <li [class]="entry.kind">
                <time>{{ time(entry.at) }}</time>
                <code>{{ entry.sql }}</code>
                <span class="text">{{ entry.text }}</span>
                @if (entry.elapsedMs !== null) {
                  <span class="ms">{{ entry.elapsedMs }} ms</span>
                }
              </li>
            } @empty {
              <li class="info">Noch keine Meldungen.</li>
            }
          </ol>
        } @else {
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
              <p class="message">Noch kein Ergebnis.</p>
            }
          }
        }
      </div>
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }
    .editor {
      flex: 1 1 0;
      min-height: 0;
    }
    .results {
      flex: none;
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: var(--bg-app);
    }
    .body {
      flex: 1 1 0;
      min-height: 0;
      overflow: auto;
    }
    .subtabs {
      flex: none;
      display: flex;
      gap: 2px;
      padding: 2px 6px 0;
      overflow-x: auto;
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border);
      scrollbar-width: none;
    }
    .sub {
      flex: none;
      padding: 2px 9px;
      border-radius: var(--radius) var(--radius) 0 0;
      color: var(--text-dim);
      font-size: 12px;
    }
    .sub[aria-selected='true'] {
      background: var(--bg-app);
      color: var(--text);
    }
    .sub.failed .mark {
      color: var(--danger);
    }
    .sub.done .mark {
      color: var(--ok);
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    .log {
      margin: 0;
      padding: 6px 0;
      list-style: none;
      font-size: 12px;
    }
    .log li {
      display: grid;
      grid-template-columns: max-content minmax(120px, 2fr) minmax(120px, 3fr) max-content;
      gap: 12px;
      padding: 2px 12px;
      border-left: 3px solid transparent;
    }
    .log li.error {
      border-left-color: var(--error-edge);
      background: var(--error-bg);
      color: var(--error-fg);
    }
    .log li.cancelled,
    .log time,
    .log .ms {
      color: var(--text-dim);
    }
    .log code {
      font-family: var(--font-mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .log .text {
      overflow-wrap: anywhere;
    }
    .message {
      margin: 0;
      padding: 12px 16px;
      color: var(--text-dim);
    }
    .message.error {
      background: var(--error-bg);
      color: var(--error-fg);
      border-left: 3px solid var(--error-edge);
      font-family: var(--font-mono);
      white-space: pre-wrap;
    }
  `,
})
export class QueryPane implements OnInit, OnDestroy {
  private readonly tabs = inject(TabsStore);
  private readonly settings = inject(SettingsService);
  private readonly connections = inject(ConnectionsStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly tab = input.required<QueryTab>();

  protected readonly defaults = DEFAULT_SETTINGS;
  protected readonly resultMin = RESULT_MIN;
  /** The text the editor starts with; `null` while it is read. Wrapped: an empty text is a text too. */
  protected readonly startText = signal<{ text: string } | null>(null);
  protected readonly state = computed(() => this.tab().state());
  protected readonly status = computed(() => statusText(this.state()));
  /** The rules of the tab's database for splitting statements. */
  protected readonly dialect = computed<Dialect>(() => {
    const id = this.tab().connectionId();
    return this.connections.profiles().find((p) => p.id === id)?.kind ?? 'sqlite';
  });
  protected readonly time = clock;
  protected readonly outcome = outcomeText;
  protected readonly result = computed(() => {
    const s = this.state();
    return s.kind === 'done' ? s.result : null;
  });
  protected readonly errorMessage = computed(() => {
    const s = this.state();
    return s.kind === 'failed' ? s.message : '';
  });

  // The height is stored when a drag ends; in between the drag signal holds it.
  protected readonly dragHeight = signal<number | null>(null);
  private readonly height = signal(0);
  protected readonly resultMaxH = computed(() => Math.max(RESULT_MIN, this.height() - EDITOR_MIN));
  protected readonly resultH = computed(() =>
    Math.min(
      this.resultMaxH(),
      Math.max(RESULT_MIN, this.dragHeight() ?? this.settings.settings().resultHeight),
    ),
  );

  private readonly editor = viewChild(SqlEditor);
  private observer: ResizeObserver | null = null;
  private readonly handle: TabEditor = {
    getText: () => this.editor()?.getText() ?? Promise.resolve(this.startText()?.text ?? ''),
    setText: (text) => this.editor()?.setText(text) ?? Promise.resolve(),
    focus: () => this.editor()?.focus(),
    runCurrent: () => this.editor()?.runCurrent() ?? Promise.resolve(),
    runScript: () => this.editor()?.runScript() ?? Promise.resolve(),
  };

  constructor() {
    effect(() => {
      // a hidden pane has no size: keep the last one
      const element = this.host.nativeElement;
      this.observer?.disconnect();
      if (typeof ResizeObserver === 'undefined') return;
      this.observer = new ResizeObserver(() => {
        if (element.clientHeight > 0) this.height.set(element.clientHeight);
      });
      this.observer.observe(element);
    });
  }

  async ngOnInit(): Promise<void> {
    const tab = this.tab();
    tab.attach(this.handle);
    this.startText.set({ text: await this.tabs.startText(tab) });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.tab().detach(this.handle);
  }

  /** `✓`, `✗` … in front of the number of a result. */
  protected mark(run: StatementRun): string {
    switch (run.kind) {
      case 'done':
        return '✓';
      case 'failed':
        return '✗';
      case 'running':
        return '…';
      case 'cancelled':
      case 'skipped':
        return '–';
      default:
        return '';
    }
  }

  /** Arrows move between the results and the messages (APG tabs). */
  protected onSubKey(event: KeyboardEvent): void {
    const tab = this.tab();
    const count = tab.runs().length > 1 ? tab.runs().length : 0;
    const order: (number | 'messages')[] = [...Array(count).keys(), 'messages'];
    const at = order.indexOf(tab.shown());
    const to: Record<string, number> = {
      ArrowRight: (at + 1) % order.length,
      ArrowLeft: (at - 1 + order.length) % order.length,
      Home: 0,
      End: order.length - 1,
    };
    const next = to[event.key];
    if (next === undefined) return;
    event.preventDefault();
    tab.shown.set(order[next]);
    setTimeout(() =>
      this.host.nativeElement.querySelector<HTMLElement>('.subtabs [aria-selected=true]')?.focus(),
    );
  }

  protected onChanged(change: EdChange): void {
    this.tabs.textChanged(this.tab(), change.charCount, change.dirty);
  }

  protected commitHeight(height: number): void {
    this.dragHeight.set(null);
    this.settings.update({ resultHeight: height });
  }
}
