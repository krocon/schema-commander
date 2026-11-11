import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  viewChild,
} from '@angular/core';
import { locale } from '../../core/i18n/i18n';
import { SettingsService } from '../../core/settings/settings.service';
import { groupDigits, typeLabel } from '../results/cell-format';
import { Measure, figuresOf, shareText } from './stats-logic';
import { STATS_TEXTS } from './stats-texts';
import { StatsService } from './stats.service';

/**
 * The summary of a column (prompt 028): its figures and its most frequent values. Each figure can be
 * copied and chosen for the status line. Values of the database are shown as text, never as markup.
 */
@Component({
  selector: 'app-stats-popover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      aria-labelledby="stats-title"
      (cancel)="$event.preventDefault(); stats.closeSummary()"
    >
      @if (stats.summary(); as s) {
        <h2 id="stats-title">
          {{ t.summaryTitle(s.column.name) }}
          <span class="type">{{ type(s.column.typeName) }}</span>
        </h2>
        @if (s.problem) {
          <p class="problem" role="alert">{{ s.problem }}</p>
        } @else if (s.stats) {
          <table>
            <thead>
              <tr>
                <th scope="col">{{ t.figure }}</th>
                <th scope="col" class="num">{{ t.value }}</th>
                <th scope="col">{{ t.inStatus }}</th>
                <th scope="col">
                  <span class="sr-only">{{ t.copy }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              @for (f of figures(); track f.key) {
                <tr>
                  <th scope="row">{{ f.label }}</th>
                  <td class="num">{{ f.shown }}</td>
                  <td>
                    <input
                      type="checkbox"
                      [checked]="stats.chosen(f.key)"
                      [attr.aria-label]="t.inStatusHint(f.label)"
                      (change)="choose(f.key, $event)"
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      class="small"
                      [attr.aria-label]="t.copyHint(f.label)"
                      (click)="stats.copy(f)"
                    >
                      {{ t.copy }}
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
          @if (s.stats.ignored > 0) {
            <p class="note">{{ t.ignored(s.stats.ignored) }}</p>
          }
          @if (s.stats.top.length > 0) {
            <h3 id="stats-top">{{ t.top }}</h3>
            <table aria-labelledby="stats-top">
              <thead>
                <tr>
                  <th scope="col">{{ t.value }}</th>
                  <th scope="col" class="num">{{ t.times }}</th>
                  <th scope="col" class="num">{{ t.share }}</th>
                </tr>
              </thead>
              <tbody>
                @for (v of s.stats.top; track $index) {
                  <tr>
                    <td class="value" [class.dim]="v.value === null || v.value === ''">
                      {{ v.value === null ? t.nullValue : v.value === '' ? t.emptyText : v.value }}
                    </td>
                    <td class="num">{{ count(v.count) }}</td>
                    <td class="num">{{ share(v.count, s.stats.cells) }}</td>
                  </tr>
                }
              </tbody>
            </table>
            @if (s.stats.topPartial) {
              <p class="note">{{ t.topPartial }}</p>
            }
          }
        } @else {
          <p class="note" role="status">{{ t.summaryWorking }}</p>
        }
        @if (stats.notice(); as n) {
          <p class="note" role="status">{{ n }}</p>
        }
      }
      <footer>
        <button #close type="button" (click)="stats.closeSummary()">{{ t.close }}</button>
      </footer>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(520px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      padding: 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: auto;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    h2 {
      margin: 0 0 10px;
      font-size: 14px;
    }
    h3 {
      margin: 14px 0 6px;
      font-size: 12px;
    }
    .type {
      margin-left: 6px;
      color: var(--text-dim);
      font-weight: 400;
      font-size: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th,
    td {
      padding: 3px 8px 3px 0;
      text-align: left;
      vertical-align: baseline;
      border-bottom: 1px solid var(--border);
    }
    thead th {
      color: var(--text-dim);
      font-weight: 400;
    }
    tbody th {
      font-weight: 400;
      white-space: nowrap;
    }
    .num {
      text-align: right;
      font-family: var(--font-mono);
      overflow-wrap: anywhere;
    }
    .value {
      font-family: var(--font-mono);
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .dim {
      color: var(--text-dim);
    }
    .note {
      margin: 8px 0 0;
      color: var(--text-dim);
      font-size: 12px;
    }
    .problem {
      margin: 0;
      color: var(--danger);
    }
    .small {
      padding: 1px 8px;
      font-size: 11px;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    footer {
      display: flex;
      justify-content: flex-end;
      margin-top: 14px;
    }
  `,
})
export class StatsPopover {
  protected readonly t = STATS_TEXTS;
  protected readonly stats = inject(StatsService);
  private readonly settings = inject(SettingsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly close = viewChild.required<ElementRef<HTMLButtonElement>>('close');

  protected readonly figures = computed(() => {
    const s = this.stats.summary()?.stats;
    return s ? figuresOf(s, this.settings.settings().groupDigits) : [];
  });
  protected readonly type = typeLabel;

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      this.close().nativeElement.focus();
    });
  }

  protected count(n: number): string {
    return this.settings.settings().groupDigits ? groupDigits(String(n)) : String(n);
  }

  protected share(count: number, of: number): string {
    return shareText(count, of, locale());
  }

  protected choose(key: Measure, event: Event): void {
    this.stats.choose(key, (event.target as HTMLInputElement).checked);
  }
}
