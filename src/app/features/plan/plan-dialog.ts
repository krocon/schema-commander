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
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { SessionApi } from '../../core/session/session-api';
import {
  PlanRow,
  amount,
  ancestors,
  duration,
  expensive,
  factor,
  hintText,
  planHints,
  planRows,
  planText,
  scaleOf,
  selfShare,
} from './plan-logic';
import { PlanService, PlanView } from './plan.service';
import { PLAN_TEXTS } from './plan-texts';

/**
 * The plan of a statement as a tree table (prompt 039): operation, object, rows, times, cost – the
 * expensive operations and the estimates that were far off stand out. Below: what the database says
 * about the chosen operation, hints, and the plan as it came. Everything from the database is text.
 */
@Component({
  selector: 'app-plan-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="plan-title" (cancel)="$event.preventDefault(); closed.emit()">
      <header>
        <h2 id="plan-title">{{ t.title }}</h2>
        <span class="dim">{{ view().analyze ? t.analyzed : t.estimated }}</span>
      </header>
      <pre class="sql" tabindex="0">{{ view().sql }}</pre>
      @if (view().error; as error) {
        <p class="problem" role="alert">{{ t.failed(error) }}</p>
      }
      @if (view().loading) {
        <p class="dim" role="status">{{ t.loading }}</p>
      }
      @if (view().plan; as plan) {
        @if (!plan.known) {
          <p class="problem">{{ t.unknown }}</p>
        } @else {
          @if (plan.cut) {
            <p class="problem">{{ t.cut }}</p>
          }
          <div class="tree">
            <table role="treegrid" [attr.aria-label]="t.title">
              <thead>
                <tr>
                  <th scope="col">{{ t.operation }}</th>
                  <th scope="col">{{ t.object }}</th>
                  <th scope="col" class="num">{{ t.estRows }}</th>
                  @if (scale().counted) {
                    <th scope="col" class="num">{{ t.actRows }}</th>
                    <th scope="col" class="num">{{ t.factor }}</th>
                  }
                  @if (scale().timed) {
                    <th scope="col" class="num">{{ t.self }}</th>
                    <th scope="col" class="num">{{ t.total }}</th>
                  }
                  <th scope="col" class="num">{{ t.cost }}</th>
                  @if (scale().buffered) {
                    <th scope="col">{{ t.buffers }}</th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (r of rows(); track r.id) {
                  <tr
                    [attr.aria-level]="r.depth + 1"
                    [attr.aria-expanded]="r.hasChildren ? r.open : null"
                    [attr.aria-selected]="r.id === current()"
                    [class.current]="r.id === current()"
                    [class.costly]="isExpensive(r)"
                    (click)="current.set(r.id)"
                  >
                    <th scope="row" [style.padding-left.px]="8 + r.depth * 16">
                      @if (r.hasChildren) {
                        <button
                          type="button"
                          class="twist"
                          [attr.aria-label]="r.open ? t.collapse(r.node.op) : t.expand(r.node.op)"
                          (click)="toggle(r.id); $event.stopPropagation()"
                        >
                          {{ r.open ? '▾' : '▸' }}
                        </button>
                      } @else {
                        <span class="twist"></span>
                      }
                      <button type="button" class="op" (click)="current.set(r.id)">
                        {{ r.node.op }}
                      </button>
                      @if (r.node.hints.length > 0) {
                        <span class="flag" [title]="hintsOf(r)">!</span>
                      }
                    </th>
                    <td>{{ r.node.object }}</td>
                    <td class="num">{{ amountOf(r.node.estRows) }}</td>
                    @if (scale().counted) {
                      <td class="num">{{ amountOf(r.node.actRows) }}</td>
                      <td class="num" [class.off]="r.node.hints.includes('misestimate')">
                        {{ factorOf(r) }}
                      </td>
                    }
                    @if (scale().timed) {
                      <td class="num bar">
                        <span class="fill" [style.width.%]="share(r)"></span>
                        <span class="value">{{ durationOf(r.node.selfMs) }}</span>
                      </td>
                      <td class="num">{{ durationOf(r.node.timeMs) }}</td>
                    }
                    <td class="num">{{ amountOf(r.node.cost) }}</td>
                    @if (scale().buffered) {
                      <td>{{ r.node.buffers }}</td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="below">
            <section [attr.aria-label]="t.details">
              <h3>{{ t.details }}</h3>
              @if (currentRow(); as r) {
                @if (r.node.detail) {
                  <p class="mono">{{ r.node.detail }}</p>
                }
                <dl>
                  @if (r.node.loops !== null) {
                    <dt>{{ t.loops }}</dt>
                    <dd>{{ amountOf(r.node.loops) }}</dd>
                  }
                  @for (pair of r.node.extra; track $index) {
                    <dt>{{ pair[0] }}</dt>
                    <dd>{{ pair[1] }}</dd>
                  }
                </dl>
              } @else {
                <p class="dim">{{ t.noNode }}</p>
              }
            </section>
            @if (hints().length > 0) {
              <section [attr.aria-label]="t.hintsHeading">
                <h3>{{ t.hintsHeading }}</h3>
                <ul>
                  @for (h of hints(); track $index) {
                    <li>
                      <button type="button" class="link" (click)="reveal(h.row)">
                        {{ h.node.op }}{{ h.node.object ? ' ' + h.node.object : '' }}
                      </button>
                      {{ hintOf(h.hint) }}
                    </li>
                  }
                </ul>
                <p class="dim">{{ t.hintNote }}</p>
              </section>
            }
          </div>
        }
        @if (rawOpen() || !plan.known) {
          <pre class="raw" tabindex="0" role="region" [attr.aria-label]="t.raw">{{ plan.raw }}</pre>
        }
      }
      <footer>
        <span class="status" role="status">{{ note() }}</span>
        @if (view().plan; as plan) {
          @if (plan.known) {
            <button type="button" (click)="rawOpen.set(!rawOpen())">
              {{ rawOpen() ? t.hideRaw : t.showRaw }}
            </button>
            <button type="button" (click)="copy()">{{ t.copy }}</button>
          }
          <button type="button" (click)="save()">{{ t.save }}</button>
        }
        @if (view().sql) {
          <button type="button" [disabled]="view().loading" (click)="plans.again(false)">
            {{ t.runEstimate }}
          </button>
          <button type="button" [disabled]="view().loading" (click)="plans.again(true)">
            {{ t.runAnalyze }}
          </button>
        }
        <button type="button" class="primary" (click)="closed.emit()">{{ t.close }}</button>
      </footer>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(1100px, calc(100vw - 32px));
      height: calc(100vh - 32px);
      max-height: none;
      padding: 14px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog[open] {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 35%);
    }
    header {
      display: flex;
      align-items: baseline;
      gap: 12px;
    }
    h2 {
      margin: 0;
      font-size: 14px;
    }
    h3 {
      margin: 0 0 4px;
      font-size: 12px;
      color: var(--text-dim);
    }
    p {
      margin: 0;
    }
    .dim {
      color: var(--text-dim);
    }
    .problem {
      color: var(--danger);
    }
    pre {
      margin: 0;
      padding: 4px 8px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      font-family: var(--font-mono);
      font-size: 12px;
      user-select: text;
    }
    .sql {
      flex: none;
      max-height: 64px;
      white-space: pre-wrap;
    }
    .raw {
      flex: 1;
      min-height: 80px;
    }
    .tree {
      flex: 2;
      min-height: 120px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 1;
      padding: 3px 8px;
      background: var(--bg-panel);
      text-align: left;
      white-space: nowrap;
    }
    tbody th,
    td {
      padding: 1px 8px;
      border-top: 1px solid var(--border);
      font-weight: normal;
      text-align: left;
      white-space: nowrap;
    }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    tr.current {
      background: var(--bg-panel);
    }
    tr.costly .op {
      color: var(--danger);
      font-weight: 600;
    }
    .off {
      color: var(--danger);
    }
    .twist {
      display: inline-block;
      width: 16px;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--text-dim);
      font: inherit;
    }
    .op,
    .link {
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
    }
    .link {
      color: var(--accent);
    }
    .flag {
      margin-left: 6px;
      color: var(--danger);
      font-weight: 700;
    }
    .bar {
      position: relative;
      min-width: 110px;
    }
    .bar .fill {
      position: absolute;
      inset: 2px auto 2px 0;
      background: var(--accent);
      opacity: 0.25;
    }
    .bar .value {
      position: relative;
    }
    .below {
      flex: 1;
      min-height: 90px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      overflow: auto;
    }
    section {
      min-width: 0;
    }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 1px 12px;
      margin: 4px 0 0;
      font-size: 12px;
    }
    dt {
      color: var(--text-dim);
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
      user-select: text;
    }
    .mono {
      font-family: var(--font-mono);
      font-size: 12px;
      overflow-wrap: anywhere;
      user-select: text;
    }
    ul {
      margin: 0 0 4px;
      padding-left: 16px;
      font-size: 12px;
    }
    footer {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .status {
      flex: 1;
      color: var(--text-dim);
    }
  `,
})
export class PlanDialog {
  readonly view = input.required<PlanView>();
  readonly closed = output<void>();

  protected readonly plans = inject(PlanService);
  private readonly clipboard = inject(ClipboardApi);
  private readonly files = inject(FileDialogApi);
  private readonly session = inject(SessionApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly t = PLAN_TEXTS;
  private readonly closedRows = signal<ReadonlySet<string>>(new Set());
  protected readonly current = signal<string | null>(null);
  protected readonly rawOpen = signal(false);
  protected readonly note = signal('');

  protected readonly rows = computed(() =>
    planRows(this.view().plan?.nodes ?? [], this.closedRows()),
  );
  protected readonly scale = computed(() => {
    const plan = this.view().plan;
    return plan
      ? scaleOf(plan)
      : { maxSelf: 0, maxCost: 0, timed: false, counted: false, buffered: false };
  });
  protected readonly hints = computed(() => {
    const plan = this.view().plan;
    return plan ? planHints(plan) : [];
  });
  protected readonly currentRow = computed(
    () => this.rows().find((r) => r.id === this.current()) ?? null,
  );

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    // another plan: everything open, nothing chosen
    effect(() => {
      void this.view().plan;
      untracked(() => {
        this.closedRows.set(new Set());
        this.current.set(null);
        this.note.set('');
      });
    });
  }

  protected readonly amountOf = amount;
  protected readonly durationOf = duration;
  protected readonly hintOf = hintText;
  protected factorOf = (r: PlanRow) => factor(r.node);
  protected share = (r: PlanRow) => selfShare(r.node, this.scale());
  protected isExpensive = (r: PlanRow) => expensive(r.node, this.scale());
  protected hintsOf = (r: PlanRow) => r.node.hints.map(hintText).join('\n');

  protected toggle(id: string): void {
    this.closedRows.update((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Opens what hides a node and chooses it. */
  protected reveal(id: string): void {
    const hidden = new Set(ancestors(id));
    this.closedRows.update((old) => new Set([...old].filter((r) => !hidden.has(r))));
    this.current.set(id);
  }

  protected async copy(): Promise<void> {
    const plan = this.view().plan;
    if (!plan) return;
    try {
      await this.clipboard.copyText(planText(plan));
      this.note.set(this.t.copied);
    } catch {
      this.note.set(this.t.saveFailed);
    }
  }

  protected async save(): Promise<void> {
    const plan = this.view().plan;
    if (!plan) return;
    const extension = plan.format === 'xml' ? 'sqlplan' : plan.format === 'json' ? 'json' : 'txt';
    try {
      const path = await this.files.saveFile(this.t.save, `plan.${extension}`, [
        { name: this.t.title, extensions: [extension] },
      ]);
      if (!path) return;
      await this.session.writeFile(path, plan.raw, 'utf-8');
      this.note.set(this.t.saved(path.split(/[\\/]/).pop() ?? path));
    } catch {
      this.note.set(this.t.saveFailed);
    }
  }
}
