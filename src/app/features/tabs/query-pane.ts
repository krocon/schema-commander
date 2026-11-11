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
import { DEFAULT_SETTINGS } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { SplitterComponent } from '../../shared/splitter';
import { EdChange } from '../editor/editlicious';
import { SqlEditor } from '../editor/sql-editor';
import { ResultGrid } from '../results/result-grid';
import { QueryTab, TabEditor } from './query-tab';
import { statusText } from './run-state';
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
        (run)="tab().run($event)"
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
      background: var(--bg-app);
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
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly tab = input.required<QueryTab>();

  protected readonly defaults = DEFAULT_SETTINGS;
  protected readonly resultMin = RESULT_MIN;
  /** The text the editor starts with; `null` while it is read. Wrapped: an empty text is a text too. */
  protected readonly startText = signal<{ text: string } | null>(null);
  protected readonly state = computed(() => this.tab().state());
  protected readonly status = computed(() => statusText(this.state()));
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

  protected onChanged(change: EdChange): void {
    this.tabs.textChanged(this.tab(), change.charCount, change.dirty);
  }

  protected commitHeight(height: number): void {
    this.dragHeight.set(null);
    this.settings.update({ resultHeight: height });
  }
}
