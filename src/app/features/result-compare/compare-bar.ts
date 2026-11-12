import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { locale } from '../../core/i18n/i18n';
import { ExportService } from '../export/export.service';
import { QueryTab } from '../tabs/query-tab';
import { CompareView, isKept } from '../tabs/result-tabs-logic';
import { figures, identical } from './compare-view-logic';
import { COMPARE_TEXTS } from './compare-texts';

/**
 * The row above the outcome of a comparison (prompt 041): the figures, „only differences“, the jump to the
 * next difference, the export – and what the user must know (keys that are not unique, columns that
 * were not compared).
 */
@Component({
  selector: 'app-compare-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar" role="group" [attr.aria-label]="t.bar">
      <span class="sides">{{ t.sides(compare().leftTitle, compare().rightTitle) }}</span>
      <ul class="figures" [title]="t.legend">
        @for (f of shownFigures(); track f.key) {
          <li [class]="f.key" [class.zero]="f.count === 0">
            <span class="n">{{ number(f.count) }}</span> {{ t.figures[f.key] }}
          </li>
        }
      </ul>
      <span class="grow"></span>
      <label class="only">
        <input
          #only
          type="checkbox"
          [checked]="compare().onlyDifferences"
          (change)="setOnly(only.checked)"
        />
        {{ t.onlyDifferences }}
      </label>
      <button type="button" [title]="t.previous" [attr.aria-label]="t.previous" (click)="go(false)">
        ↑
      </button>
      <button type="button" [title]="t.next" [attr.aria-label]="t.next" (click)="go(true)">
        ↓
      </button>
      <button
        type="button"
        [disabled]="compare().report.diffRows === 0"
        (click)="exportDifferences()"
      >
        {{ t.export }}
      </button>
    </div>
    <div class="notes" aria-live="polite">
      @if (same()) {
        <p class="ok">{{ t.identical }}</p>
      }
      @if (compare().report.duplicateKeys.length > 0) {
        <p class="warn" role="status">{{ duplicates() }}</p>
      }
      @if (changedColumns()) {
        <p>{{ changedColumns() }}</p>
      }
      @if (compare().report.leftColumnsOnly.length > 0) {
        <p>{{ t.leftColumnsOnly(compare().report.leftColumnsOnly.join(', ')) }}</p>
      }
      @if (compare().report.rightColumnsOnly.length > 0) {
        <p>{{ t.rightColumnsOnly(compare().report.rightColumnsOnly.join(', ')) }}</p>
      }
      @if (compare().report.cut) {
        <p class="warn">{{ t.cut }}</p>
      }
      @if (note()) {
        <p>{{ note() }}</p>
      }
      <p class="sr">{{ t.legend }}</p>
    </div>
  `,
  styles: `
    :host {
      flex: none;
      display: block;
      border-bottom: 1px solid var(--border);
      background: var(--bg-panel);
      font-size: 12px;
    }
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 10px;
      padding: 3px 8px;
    }
    .sides {
      font-weight: 600;
    }
    .figures {
      display: flex;
      flex-wrap: wrap;
      gap: 2px 12px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .figures .n {
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }
    .figures .zero {
      color: var(--text-dim);
    }
    .figures .duplicates {
      color: var(--danger);
    }
    .grow {
      flex: 1;
    }
    .only {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    button {
      padding: 1px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    button:disabled {
      color: var(--text-dim);
    }
    .notes {
      padding: 0 8px 3px;
      color: var(--text-dim);
    }
    .notes p {
      margin: 1px 0;
      overflow-wrap: anywhere;
    }
    .notes .warn {
      color: var(--danger);
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    .notes p {
      display: inline;
    }
    .notes p:not(.sr) + p:not(.sr)::before {
      content: ' · ';
      color: var(--text-dim);
    }
    .notes .ok {
      color: var(--ok);
    }
  `,
})
export class CompareBar {
  readonly tab = input.required<QueryTab>();
  readonly compare = input.required<CompareView>();

  private readonly exporter = inject(ExportService);
  protected readonly t = COMPARE_TEXTS;
  /** What the last jump said (no further difference). */
  protected readonly note = signal('');

  protected readonly shownFigures = computed(() => figures(this.compare().report));
  protected readonly same = computed(() => identical(this.compare().report));
  protected readonly duplicates = computed(() => {
    const r = this.compare().report;
    // more keys than are named: every key stands for two rows at least
    const more = r.duplicateLeft + r.duplicateRight > r.duplicateKeys.length * 2;
    return this.t.duplicates(r.duplicateKeys.join(' · '), more);
  });
  protected readonly changedColumns = computed(() => {
    const by = this.compare().report.changedByColumn;
    return by.length === 0
      ? ''
      : this.t.changedColumns(by.map((c) => `${c.name} ${this.number(c.rows)}`).join(' · '));
  });

  protected number(n: number): string {
    return n.toLocaleString(locale());
  }

  protected setOnly(only: boolean): void {
    const shown = this.tab().shown();
    this.note.set('');
    if (isKept(shown)) this.tab().setOnlyDifferences(shown, only);
  }

  protected async go(forward: boolean): Promise<void> {
    const found = await this.tab().nextDifference(forward);
    this.note.set(found ? '' : this.t.noMore);
    if (found) this.tab().grid?.focusGrid();
  }

  /** The rows that differ, as a file: the export of the view of the differences. */
  protected exportDifferences(): void {
    const { report, leftTitle, rightTitle } = this.compare();
    const name = `${leftTitle}-${rightTitle}`.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
    this.exporter.request.set({
      kind: 'result',
      resultId: report.diffId,
      columns: [...report.columns],
      rows: report.diffRows,
      ranges: [],
      sql: '',
      connectionId: this.tab().connectionId(),
      name: name || 'diff',
      table: name || 'diff',
    });
  }
}
