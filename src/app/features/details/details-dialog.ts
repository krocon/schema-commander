import {
  Component,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { describeError } from '../../core/errors/app-error';
import { COMMON_TEXTS } from '../../core/i18n/common-texts';
import { SchemaApi } from '../../core/schema/schema-api';
import { DetailSection, ObjectDetails } from '../../core/schema/schema.models';
import { ResultRef, RowWindow } from '../../core/sql/query.models';
import { SqlEditor } from '../editor/sql-editor';
import { CopyService } from '../results/copy.service';
import { ResultGrid } from '../results/result-grid';
import { TabsStore } from '../tabs/tabs.store';
import { DetailTarget, filterRows, linkTarget, linksOf, orderSections } from './details-logic';
import { DETAILS_TEXTS } from './details-texts';
import { ObjectDetailsService } from './details.service';

const DDL = 'ddl';
let gridId = 0;

/**
 * Everything about one object of the database (prompt 019): its lists – each a grid that can be filtered
 * and copied from – and its DDL in a read-only editor. Lists are a vertical tab list (APG); a relation
 * leads to the object it names, and back again.
 */
@Component({
  selector: 'app-details-dialog',
  imports: [ResultGrid, SqlEditor],
  template: `
    <dialog #dialog aria-labelledby="details-title" (cancel)="$event.preventDefault(); close()">
      <header>
        @if (service.trail().length > 0) {
          <button
            type="button"
            [attr.aria-label]="t.backTo(service.trail()[service.trail().length - 1].name)"
            [title]="t.backTo(service.trail()[service.trail().length - 1].name)"
            (click)="service.back()"
          >
            ←
          </button>
        }
        <h2 id="details-title">
          <small>{{ t.kinds[target().kind] }}</small>
          {{ fullName() }}
        </h2>
        <span class="spacer"></span>
        <button type="button" class="x" [attr.aria-label]="common.close" (click)="close()">
          ×
        </button>
      </header>
      @if (problem(); as p) {
        <p class="note problem" role="alert">{{ p }}</p>
      } @else if (!details()) {
        <p class="note" role="status">{{ t.loading }}</p>
      } @else {
        @if (empty()) {
          <p class="note" role="status">{{ t.nothing }}</p>
        }
        <div class="body">
          <div
            class="lists"
            role="tablist"
            aria-orientation="vertical"
            [attr.aria-label]="t.sectionsLabel"
          >
            @for (id of tabs(); track id) {
              <button
                type="button"
                role="tab"
                [id]="'details-tab-' + id"
                aria-controls="details-panel"
                [attr.aria-selected]="shown() === id"
                [tabindex]="shown() === id ? 0 : -1"
                (click)="shown.set(id)"
                (keydown)="onTabKey($event)"
              >
                {{ tabLabel(id) }}
                @if (count(id); as n) {
                  <small>{{ n }}</small>
                }
              </button>
            }
          </div>
          <div
            id="details-panel"
            class="panel"
            role="tabpanel"
            [attr.aria-labelledby]="'details-tab-' + shown()"
          >
            @if (shown() === ddlId) {
              @for (d of ddlText(); track d.key) {
                <app-sql-editor
                  class="editor"
                  [initialValue]="d.text"
                  [label]="t.ddlLabel(target().name)"
                  [readonly]="true"
                />
              } @empty {
                <p class="note">{{ t.noDdl }}</p>
              }
            } @else if (section(); as s) {
              <div class="bar">
                <input
                  type="search"
                  autocomplete="off"
                  spellcheck="false"
                  [attr.aria-label]="t.filter"
                  [placeholder]="t.filter"
                  [value]="query()"
                  (input)="query.set($any($event.target).value)"
                />
                <span class="count" role="status">{{ t.rows(rows().length, s.rows.length) }}</span>
              </div>
              @if (s.cut) {
                <p class="note">{{ t.cut }}</p>
              }
              @if (links().length > 0) {
                <p class="links">
                  <span>{{ t.goTo }}</span>
                  @for (link of links(); track link.schema + '.' + link.name) {
                    <button
                      type="button"
                      [title]="t.goToObject(link.name)"
                      (click)="service.go(linkTo(link))"
                    >
                      {{ link.schema ? link.schema + '.' + link.name : link.name }}
                    </button>
                  }
                </p>
              }
              @if (grid(); as g) {
                <app-result-grid
                  class="grid"
                  [result]="g.result"
                  [rows]="g.rows.length"
                  [fetch]="g.fetch"
                  [local]="g.rows"
                />
              }
            }
          </div>
        </div>
        @if (refused(); as r) {
          <p class="note" role="status">{{ t.refused(r) }}</p>
        }
      }
      <footer>
        @if (message(); as m) {
          <span class="message" role="status">{{ m }}</span>
        }
        <span class="spacer"></span>
        <button type="button" [disabled]="!details()?.ddl" (click)="copyDdl()">
          {{ t.copyDdl }}
        </button>
        <button type="button" [disabled]="!details()?.ddl" (click)="ddlToTab()">
          {{ t.ddlToTab }}
        </button>
        <button type="button" class="primary" (click)="close()">{{ common.close }}</button>
      </footer>
    </dialog>
  `,
  styleUrl: './details-dialog.css',
})
export class DetailsDialog implements OnInit {
  protected readonly service = inject(ObjectDetailsService);
  private readonly api = inject(SchemaApi);
  private readonly copier = inject(CopyService);
  private readonly tabsStore = inject(TabsStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly t = DETAILS_TEXTS;
  protected readonly common = COMMON_TEXTS;
  protected readonly ddlId = DDL;
  /** The dialog is only in the page while there is a target. */
  protected readonly target = computed<DetailTarget>(
    () =>
      this.service.current() ?? {
        connectionId: '',
        schema: '',
        name: '',
        kind: 'table',
        detail: '',
      },
  );
  protected readonly fullName = computed(() => {
    const target = this.target();
    return target.schema ? `${target.schema}.${target.name}` : target.name;
  });
  protected readonly details = signal<ObjectDetails | null>(null);
  protected readonly problem = signal<string | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly query = signal('');
  /** The id of the list on screen, or `ddl`. */
  protected readonly shown = signal<string>(DDL);
  private asked = 0;

  private readonly sections = computed(() => orderSections(this.details()?.sections ?? []));
  protected readonly tabs = computed(() => [...this.sections().map((s) => s.id), DDL]);
  protected readonly empty = computed(() => {
    const d = this.details();
    return !!d && d.sections.length === 0 && d.ddl === null;
  });
  protected readonly section = computed<DetailSection | null>(
    () => this.sections().find((s) => s.id === this.shown()) ?? null,
  );
  protected readonly rows = computed(() => filterRows(this.section()?.rows ?? [], this.query()));
  protected readonly links = computed(() => {
    const s = this.section();
    return s ? linksOf(s) : [];
  });
  /** The lists the server refused, by their names. */
  protected readonly refused = computed(() => {
    const notes = (this.details()?.notes ?? []).filter((n) => n !== DDL);
    return notes.length ? notes.map((n) => this.sectionName(n)).join(', ') : null;
  });
  /** The DDL for the editor; a new key per object, so the editor starts over. */
  protected readonly ddlText = computed(() => {
    const ddl = this.details()?.ddl;
    return ddl ? [{ key: `${this.asked}`, text: ddl }] : [];
  });
  /** The list as the grid takes it: headers in the language on screen, the rows in memory. */
  protected readonly grid = computed(() => {
    const s = this.section();
    if (!s) return null;
    const named = s.columns[0] === 'property';
    const rows: RowWindow = this.rows().map((row) =>
      named ? [this.propertyName(row[0] ?? ''), ...row.slice(1)] : row,
    );
    const result: ResultRef = {
      // never an id of the result store: the grid reads and copies these rows itself
      resultId: -++gridId,
      columns: s.columns.map((key) => ({ name: this.columnName(key), kind: 'text', typeName: '' })),
    };
    const fetch = (_id: number, from: number, count: number) =>
      Promise.resolve(rows.slice(from, from + count));
    return { result, rows, fetch };
  });

  constructor() {
    // another object: read it; an answer to an older question is dropped
    effect(() => {
      const target = this.service.current();
      if (target) untracked(() => void this.load(target));
    });
  }

  ngOnInit(): void {
    this.dialog().nativeElement.showModal();
  }

  private async load(target: DetailTarget): Promise<void> {
    const mine = ++this.asked;
    this.details.set(null);
    this.problem.set(null);
    this.message.set(null);
    this.query.set('');
    try {
      const details = await this.api.details(
        target.connectionId,
        target.schema,
        target.name,
        target.kind,
        target.detail,
      );
      if (mine !== this.asked) return;
      this.details.set(details);
      this.shown.set(orderSections(details.sections)[0]?.id ?? DDL);
    } catch (e) {
      if (mine === this.asked) this.problem.set(describeError(e));
    }
  }

  protected tabLabel(id: string): string {
    return id === DDL ? this.t.ddl : this.sectionName(id);
  }

  protected count(id: string): number | null {
    return this.sections().find((s) => s.id === id)?.rows.length ?? null;
  }

  private sectionName(id: string): string {
    return (this.t.sections as Record<string, string | undefined>)[id] ?? id;
  }

  private columnName(key: string): string {
    return (this.t.columns as Record<string, string | undefined>)[key] ?? key;
  }

  private propertyName(key: string): string {
    return (this.t.properties as Record<string, string | undefined>)[key] ?? key;
  }

  protected linkTo(link: { schema: string; name: string }): DetailTarget {
    return linkTarget(this.target(), link);
  }

  /** Up and down move between the lists and show them at once (APG tabs, vertical). */
  protected onTabKey(event: KeyboardEvent): void {
    const tabs = this.tabs();
    const at = tabs.indexOf(this.shown());
    const to: Record<string, number> = {
      ArrowDown: (at + 1) % tabs.length,
      ArrowUp: (at - 1 + tabs.length) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    };
    const next = to[event.key];
    if (next === undefined) return;
    event.preventDefault();
    this.query.set('');
    this.shown.set(tabs[next]);
    setTimeout(() =>
      this.dialog()
        .nativeElement.querySelector<HTMLElement>(`#details-tab-${CSS.escape(tabs[next])}`)
        ?.focus(),
    );
  }

  protected async copyDdl(): Promise<void> {
    const ddl = this.details()?.ddl;
    if (!ddl) return;
    await this.copier.copyText(ddl);
    this.message.set(this.t.copied);
  }

  /** The DDL as the text of a new tab on the same connection; the dialog makes room. */
  protected ddlToTab(): void {
    const ddl = this.details()?.ddl;
    if (!ddl) return;
    const target = this.target();
    this.close();
    this.tabsStore.newTab(ddl, {
      title: target.name,
      customTitle: true,
      connection: target.connectionId,
    });
  }

  protected close(): void {
    this.dialog().nativeElement.close();
    this.service.close();
  }
}
