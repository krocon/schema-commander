import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { QueryTab } from '../tabs/query-tab';
import { canBack, canForward, singleKeyText } from './relation-logic';
import { RELATION_TEXTS } from './relation-texts';
import { RelationsService } from './relations.service';

/**
 * The path a tab came along following foreign keys (prompt 030): back and forward as in a browser, every
 * place a button – and, while the table is narrowed to keys, which ones, with the way out to the whole
 * table.
 */
@Component({
  selector: 'app-relation-path',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (nav().entries.length > 1) {
      <nav [attr.aria-label]="t.path">
        <button
          type="button"
          class="step"
          [attr.aria-label]="t.back"
          [title]="t.back"
          [disabled]="!back()"
          (click)="relations.back(tab())"
        >
          ←
        </button>
        <button
          type="button"
          class="step"
          [attr.aria-label]="t.forward"
          [title]="t.forward"
          [disabled]="!forward()"
          (click)="relations.forward(tab())"
        >
          →
        </button>
        <ol>
          @for (entry of nav().entries; track $index) {
            <li>
              <button
                type="button"
                class="crumb"
                [attr.aria-current]="$index === nav().index ? 'location' : null"
                (click)="relations.go(tab(), $index)"
              >
                {{ entry.title }}
              </button>
            </li>
          }
        </ol>
      </nav>
    }
    @if (keys(); as k) {
      <span class="keys">{{ k }}</span>
      <button type="button" class="all" (click)="dropKeys()">{{ t.dropKeys }}</button>
    }
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      padding: 3px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-panel);
      font-size: 12px;
    }
    nav {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }
    ol {
      display: flex;
      align-items: center;
      min-width: 0;
      margin: 0;
      padding: 0;
      list-style: none;
      overflow: hidden;
    }
    li + li::before {
      content: '›';
      padding: 0 4px;
      color: var(--text-dim);
    }
    .step,
    .all {
      flex: none;
      padding: 0 6px;
    }
    .crumb {
      padding: 0 4px;
      border: 0;
      background: transparent;
      color: var(--text-dim);
      font: inherit;
      white-space: nowrap;
    }
    .crumb:hover {
      background: var(--bg-hover);
    }
    .crumb[aria-current] {
      color: var(--text);
      font-weight: 600;
    }
    .keys {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-dim);
      font-family: var(--font-mono);
    }
  `,
})
export class RelationPath {
  protected readonly t = RELATION_TEXTS;
  protected readonly relations = inject(RelationsService);
  readonly tab = input.required<QueryTab>();

  protected readonly nav = computed(() => this.tab().nav());
  protected readonly back = computed(() => canBack(this.nav()));
  protected readonly forward = computed(() => canForward(this.nav()));
  /** What the table is narrowed to, in words. */
  protected readonly keys = computed(() => {
    const keys = this.tab().tableView()?.spec.keys;
    if (!keys) return null;
    return (
      singleKeyText(keys) ??
      this.t.keyFilter(keys.columns.map((c) => c.column).join(', '), keys.rows.length)
    );
  });

  protected dropKeys(): void {
    const view = this.tab().tableView();
    if (view) void this.tab().applyTable({ ...view.spec, keys: null });
  }
}
