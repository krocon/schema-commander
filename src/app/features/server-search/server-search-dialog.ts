import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { FindColumns, FindMode, SourceHit } from '../../core/find/find-api';
import { SchemaApi } from '../../core/schema/schema-api';
import { SchemaInfo } from '../../core/schema/schema.models';
import {
  DEFAULT_SEARCH,
  SearchChoices,
  canSearch,
  detailOf,
  progressLine,
  reportLine,
  skipText,
} from './server-search-logic';
import { SearchTarget, ServerSearchService } from './server-search.service';
import { SERVER_SEARCH_TEXTS } from './server-search-texts';

/**
 * „Where does this text stand?“ (prompt 036): what to search for and where, then the hits as they come –
 * rows by table, definitions by object, and what was left out. Nothing of a hit is set into the page as
 * markup.
 */
@Component({
  selector: 'app-server-search-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="ss-title" (cancel)="$event.preventDefault(); closed.emit()">
      <h2 id="ss-title">{{ heading() }}</h2>
      <form (submit)="$event.preventDefault(); go()">
        <div class="grid">
          <label for="ss-text">{{ t.text }}</label>
          <input
            #text
            id="ss-text"
            type="text"
            spellcheck="false"
            autocomplete="off"
            maxlength="1000"
            [value]="choices().text"
            (input)="set({ text: text.value })"
          />
          <label for="ss-mode">{{ t.mode }}</label>
          <select #mode id="ss-mode" (change)="setMode(mode.value)">
            <option value="contains" [selected]="choices().mode === 'contains'">
              {{ t.contains }}
            </option>
            <option value="exact" [selected]="choices().mode === 'exact'">{{ t.exact }}</option>
            <option value="regex" [selected]="choices().mode === 'regex'">{{ t.regex }}</option>
          </select>
          <label for="ss-columns">{{ t.columns }}</label>
          <select #cols id="ss-columns" (change)="setColumns(cols.value)">
            <option value="text" [selected]="choices().columns === 'text'">
              {{ t.columnsText }}
            </option>
            <option value="numbers" [selected]="choices().columns === 'numbers'">
              {{ t.columnsNumbers }}
            </option>
            <option value="all" [selected]="choices().columns === 'all'">
              {{ t.columnsAll }}
            </option>
          </select>
        </div>
        <div class="checks">
          <label>
            <input
              #cs
              type="checkbox"
              [checked]="choices().caseSensitive"
              (change)="set({ caseSensitive: cs.checked })"
            />
            {{ t.caseSensitive }}
          </label>
          <label>
            <input
              #da
              type="checkbox"
              [checked]="choices().data"
              (change)="set({ data: da.checked })"
            />
            {{ t.data }}
          </label>
          @if (!target().table) {
            <label>
              <input
                #so
                type="checkbox"
                [checked]="choices().sources"
                (change)="set({ sources: so.checked })"
              />
              {{ t.sources }}
            </label>
            <label>
              <input
                #na
                type="checkbox"
                [checked]="choices().names"
                (change)="set({ names: na.checked })"
              />
              {{ t.names }}
            </label>
          }
        </div>
        @if (!target().table && schemas().length > 1) {
          <fieldset>
            <legend>
              {{ t.schemas }} <span class="dim">({{ t.allSchemas }})</span>
            </legend>
            <div class="schemas">
              @for (s of schemas(); track s.name) {
                <label>
                  <input
                    type="checkbox"
                    [checked]="choices().schemas.includes(s.name)"
                    (change)="toggleSchema(s.name)"
                  />
                  {{ s.name }}
                </label>
              }
            </div>
          </fieldset>
        }
        <div class="grid limits">
          <label for="ss-hits">{{ t.maxHits }}</label>
          <input
            #hits
            id="ss-hits"
            type="number"
            min="1"
            max="1000"
            [value]="choices().maxHits"
            (change)="set({ maxHits: +hits.value })"
          />
          <label for="ss-timeout">{{ t.timeout }}</label>
          <input
            #timeout
            id="ss-timeout"
            type="number"
            min="0"
            [value]="choices().timeoutSec"
            (change)="set({ timeoutSec: +timeout.value })"
          />
          <label for="ss-skip">{{ t.skipOver }}</label>
          <input
            #skip
            id="ss-skip"
            type="number"
            min="0"
            [value]="choices().skipRowsOver"
            (change)="set({ skipRowsOver: +skip.value })"
          />
        </div>
        <p class="dim">{{ guarded() ? t.guarded : t.readOnly }}</p>
        <div class="bar">
          <span class="status" role="status">{{ status() }}</span>
          @if (search.running()) {
            <button type="button" (click)="search.cancel()">{{ t.stop }}</button>
          } @else {
            <button type="submit" class="primary" [disabled]="!ready()">{{ t.start }}</button>
          }
        </div>
      </form>

      <div class="results" tabindex="0" role="region" [attr.aria-label]="t.title">
        @if (results().tables.length > 0) {
          <h3>{{ t.rowsHeading }}</h3>
          @for (table of results().tables; track $index) {
            <section>
              <h4>{{ table.schema }}.{{ table.table }}</h4>
              <ul>
                @for (hit of table.hits; track $index) {
                  <li>
                    <span class="place">{{ hit.column || t.anyColumn }}</span>
                    <span class="preview">{{ hit.preview }}</span>
                    @if (hit.column) {
                      <button
                        type="button"
                        class="link"
                        [attr.aria-label]="t.openRowsOf(table.table, hit.column)"
                        (click)="search.showRows(target(), table.schema, table.table, hit.column)"
                      >
                        {{ t.openRows }}
                      </button>
                    }
                  </li>
                }
                @if (table.more) {
                  <li class="dim">… {{ t.more }}</li>
                }
              </ul>
            </section>
          }
        }
        @if (results().sources.length > 0) {
          <h3>{{ t.sourcesHeading }}</h3>
          <ul>
            @for (hit of results().sources; track $index) {
              <li>
                <span class="place"
                  >{{ t.kinds[hit.kind] ?? hit.kind }} {{ hit.schema }}.{{ hit.name
                  }}{{ hit.line > 0 ? ' · ' + t.line(hit.line) : '' }}</span
                >
                <span class="preview">{{ hit.preview }}</span>
                @if (opens(hit)) {
                  <button
                    type="button"
                    class="link"
                    [attr.aria-label]="t.openDefinitionOf(hit.name)"
                    (click)="search.showDefinition(target(), hit)"
                  >
                    {{ t.openDefinition }}
                  </button>
                }
              </li>
            }
          </ul>
        }
        @if (results().skipped.length > 0) {
          <h3>{{ t.skippedHeading }}</h3>
          <ul>
            @for (s of results().skipped; track $index) {
              <li>
                <span class="place">{{ s.schema }}{{ s.name ? '.' + s.name : '' }}</span>
                <span class="preview dim">{{ why(s) }}</span>
              </li>
            }
          </ul>
        }
        @if (search.report() && !search.hasHits()) {
          <p class="dim">{{ t.nothing }}</p>
        }
      </div>
      <footer>
        <button type="button" [disabled]="!search.hasHits()" (click)="copy()">{{ t.copy }}</button>
        <button type="button" (click)="closed.emit()">{{ t.close }}</button>
      </footer>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(860px, calc(100vw - 32px));
      height: min(720px, calc(100vh - 32px));
      padding: 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog[open] {
      display: flex;
      flex-direction: column;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 35%);
    }
    h2 {
      margin: 0 0 10px;
      font-size: 14px;
    }
    h3 {
      margin: 10px 0 4px;
      font-size: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    h4 {
      margin: 6px 0 2px;
      font-size: 13px;
    }
    .grid {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 6px 12px;
      align-items: center;
    }
    .limits {
      grid-template-columns: max-content 90px max-content 90px;
      margin-top: 8px;
    }
    .checks,
    .schemas {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 16px;
      margin: 8px 0;
    }
    .schemas {
      max-height: 72px;
      overflow: auto;
      margin: 0;
    }
    label {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    fieldset {
      margin: 0;
      padding: 4px 10px 6px;
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    select,
    input[type='text'],
    input[type='number'] {
      padding: 3px 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      color: var(--text);
      font: inherit;
      min-width: 0;
    }
    .dim {
      color: var(--text-dim);
    }
    p {
      margin: 6px 0;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .status {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .results {
      flex: 1;
      min-height: 80px;
      margin: 8px 0;
      padding: 4px 10px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      gap: 10px;
      align-items: baseline;
      padding: 1px 0;
    }
    .place {
      flex: none;
      max-width: 40%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--accent);
    }
    .preview {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--font-mono);
      font-size: 12px;
      user-select: text;
    }
    .link {
      flex: none;
      border: 0;
      padding: 0 2px;
      background: transparent;
      color: var(--accent);
      font: inherit;
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
  `,
})
export class ServerSearchDialog {
  readonly target = input.required<SearchTarget>();
  readonly closed = output<void>();

  protected readonly search = inject(ServerSearchService);
  private readonly meta = inject(SchemaApi);
  private readonly connections = inject(ConnectionsStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly textInput = viewChild.required<ElementRef<HTMLInputElement>>('text');

  protected readonly t = SERVER_SEARCH_TEXTS;
  protected readonly choices = signal<SearchChoices>(DEFAULT_SEARCH);
  protected readonly schemas = signal<readonly SchemaInfo[]>([]);
  protected readonly copied = signal(false);
  protected readonly results = this.search.results;
  protected readonly ready = computed(() => canSearch(this.choices()));
  protected readonly heading = computed(() => {
    const target = this.target();
    return target.table
      ? this.t.titleTable(target.schema ? `${target.schema}.${target.table}` : target.table)
      : this.t.title;
  });
  protected readonly guarded = computed(() => {
    const profile = this.connections.profiles().find((p) => p.id === this.target().connectionId);
    return !!profile && profile.protection !== 'free';
  });
  protected readonly status = computed(() => {
    if (this.copied()) return this.t.copied;
    const error = this.search.error();
    if (error) return this.t.failed(error);
    if (this.search.running()) return progressLine(this.results());
    const report = this.search.report();
    return report ? reportLine(report) : '';
  });

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      this.textInput().nativeElement.focus();
    });
    effect(() => {
      const target = this.target();
      untracked(() => {
        // a table, or a schema of the tree: only there
        this.choices.update((c) => ({ ...c, schemas: target.schema ? [target.schema] : [] }));
        void this.loadSchemas(target);
      });
    });
  }

  protected readonly why = skipText;
  protected opens = (hit: SourceHit): boolean => detailOf(hit) !== null;

  private async loadSchemas(target: SearchTarget): Promise<void> {
    try {
      const all = await this.meta.schemas(target.connectionId);
      this.schemas.set(all.filter((s) => !s.system || s.name === target.schema));
    } catch {
      this.schemas.set([]);
    }
  }

  protected set(change: Partial<SearchChoices>): void {
    this.copied.set(false);
    this.choices.update((c) => ({ ...c, ...change }));
  }

  protected setMode(value: string): void {
    const mode: FindMode = value === 'exact' || value === 'regex' ? value : 'contains';
    this.set({ mode });
  }

  protected setColumns(value: string): void {
    const columns: FindColumns = value === 'numbers' || value === 'all' ? value : 'text';
    this.set({ columns });
  }

  protected toggleSchema(name: string): void {
    const now = this.choices().schemas;
    this.set({ schemas: now.includes(name) ? now.filter((s) => s !== name) : [...now, name] });
  }

  protected go(): void {
    if (!this.ready() || this.search.running()) return;
    this.copied.set(false);
    void this.search.start(this.target(), this.choices());
  }

  protected async copy(): Promise<void> {
    this.copied.set(await this.search.copyHits());
  }
}
