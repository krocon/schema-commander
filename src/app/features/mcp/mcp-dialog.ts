import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { Profile } from '../../core/connections/connection.models';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { locale } from '../../core/i18n/i18n';
import { McpLogEntry } from '../../core/mcp/mcp-api';
import { AI_LEVELS, AiLevel } from '../../core/settings/settings.models';
import {
  claudeCommand,
  levelOf,
  levelsFor,
  oneLine,
  patternsOf,
  serverConfig,
  withLevel,
} from './mcp-logic';
import { MCP_TEXTS } from './mcp-texts';
import { McpService } from './mcp.service';

/**
 * AI control over MCP (prompt 048): the switch, what leaves this computer and what does not, what an
 * assistant may do on each connection, how to set an assistant up – and the protocol of everything
 * assistants called. Statements in the protocol are text of the assistant and shown as text.
 */
@Component({
  selector: 'app-mcp-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="mc-title" (cancel)="$event.preventDefault(); closed.emit()">
      <h2 id="mc-title">{{ t.title }}</h2>
      <div class="body">
        <p class="note">{{ t.intro }}</p>
        <p class="leaves">{{ t.leaves }}</p>
        <div class="row">
          <label>
            <input
              #on
              type="checkbox"
              [checked]="ai().enabled"
              (change)="mcp.setEnabled(on.checked)"
            />
            {{ t.enabled }}
          </label>
          <span class="note" role="status">
            {{ status().running ? t.running : t.off }}
          </span>
        </div>
        @if (mcp.problem()) {
          <p class="warn" role="alert">{{ mcp.problem() }}</p>
        }
        @if (status().running) {
          <div class="row">
            <span role="status">{{ t.connected(status().connections) }}</span>
            <button
              type="button"
              [disabled]="status().connections === 0"
              (click)="mcp.disconnect()"
            >
              {{ t.disconnect }}
            </button>
          </div>
        }

        <h3>{{ t.limits }}</h3>
        <div class="row">
          <label>
            <input
              #so
              type="checkbox"
              [checked]="ai().structureOnly"
              (change)="patch({ structureOnly: so.checked })"
            />
            {{ t.structureOnly }}
          </label>
          <label>
            {{ t.maxRows }}
            <input
              #mr
              type="number"
              min="1"
              max="1000"
              [value]="ai().maxRows"
              (change)="patch({ maxRows: number(mr.value, 1, 1000, ai().maxRows) })"
            />
          </label>
          <label>
            {{ t.maxChars }}
            <input
              #mc
              type="number"
              min="1000"
              max="500000"
              step="1000"
              [value]="ai().maxChars"
              (change)="patch({ maxChars: number(mc.value, 1000, 500000, ai().maxChars) })"
            />
          </label>
        </div>
        <label class="stack">
          {{ t.exclude }}
          <textarea
            #ex
            rows="2"
            spellcheck="false"
            [value]="
              ai().exclude.join(
                '
'
              )
            "
            (change)="patch({ exclude: patterns(ex.value) })"
          ></textarea>
          <span class="note">{{ t.excludeHint }}</span>
        </label>

        <h3>{{ t.access }}</h3>
        <div class="row">
          <label>
            {{ t.defaultAccess }}
            <select #da (change)="patch({ defaultAccess: level(da.value) })">
              @for (l of levels; track l) {
                <option [value]="l" [selected]="ai().defaultAccess === l">
                  {{ t.levels[l] }}
                </option>
              }
            </select>
          </label>
        </div>
        <table>
          <thead>
            <tr>
              <th scope="col">{{ t.connection }}</th>
              <th scope="col">{{ t.level }}</th>
            </tr>
          </thead>
          <tbody>
            @for (p of profiles(); track p.id) {
              <tr>
                <th scope="row">
                  {{ p.name }}
                  @if (p.protection !== 'free') {
                    <span class="note">{{ t.protectedHint }}</span>
                  }
                </th>
                <td>
                  <select #lv [attr.aria-label]="p.name" (change)="setLevel(p, lv.value)">
                    <option value="" [selected]="!hasOwn(p)">
                      {{ t.byDefault(t.levels[defaultOf(p)]) }}
                    </option>
                    @for (l of levelsOf(p); track l) {
                      <option [value]="l" [selected]="hasOwn(p) && levelNow(p) === l">
                        {{ t.levels[l] }}
                      </option>
                    }
                  </select>
                </td>
              </tr>
            }
          </tbody>
        </table>

        <h3>{{ t.setup }}</h3>
        <p class="path">
          <span class="note">{{ t.sidecar }}</span>
          <code>{{ status().sidecar }}</code>
        </p>
        @if (!status().sidecarFound) {
          <p class="warn">{{ t.sidecarMissing }}</p>
        }
        <div class="row">
          <button type="button" [disabled]="!status().sidecar" (click)="copy(command())">
            {{ t.copyCommand }}
          </button>
          <button type="button" [disabled]="!status().sidecar" (click)="copy(config())">
            {{ t.copyConfig }}
          </button>
          <button
            type="button"
            [disabled]="mcp.testing() || !status().running"
            (click)="mcp.test()"
          >
            {{ mcp.testing() ? t.testing : t.test }}
          </button>
          <span class="note" role="status">{{ copied() ? t.copied : '' }}</span>
        </div>
        @if (mcp.probe(); as probe) {
          <p [class.warn]="!probe.ok" role="status">{{ probeText() }}</p>
        }

        <h3>{{ t.log }}</h3>
        <div class="row">
          <span class="note">{{ t.logHint }}</span>
          <span class="grow"></span>
          <button type="button" [disabled]="mcp.log().length === 0" (click)="mcp.clearLog()">
            {{ t.clearLog }}
          </button>
        </div>
        @if (mcp.log().length === 0) {
          <p class="note">{{ t.logEmpty }}</p>
        } @else {
          <table class="log">
            <thead>
              <tr>
                <th scope="col">{{ t.columns.time }}</th>
                <th scope="col">{{ t.columns.tool }}</th>
                <th scope="col">{{ t.columns.connection }}</th>
                <th scope="col">{{ t.columns.statement }}</th>
                <th scope="col" class="num">{{ t.columns.rows }}</th>
                <th scope="col">{{ t.columns.outcome }}</th>
              </tr>
            </thead>
            <tbody>
              @for (e of mcp.log(); track e.id) {
                <tr [class.failed]="!e.ok">
                  <td>{{ time(e) }}</td>
                  <td>{{ e.tool }}</td>
                  <td>{{ nameOf(e.connection) }}</td>
                  <td class="stmt" [title]="e.statement">{{ line(e.statement) }}</td>
                  <td class="num">{{ e.rows }}</td>
                  <td>{{ e.ok ? t.ok : e.code }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </div>
      <div class="buttons">
        <span class="grow"></span>
        <button type="button" (click)="closed.emit()">{{ t.close }}</button>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(900px, calc(100vw - 32px));
      height: min(800px, calc(100vh - 32px));
      padding: 14px 16px;
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
    .body {
      flex: 1;
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-right: 4px;
    }
    h2 {
      margin: 0;
      font-size: 14px;
    }
    h3 {
      margin: 8px 0 0;
      font-size: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    p {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .row,
    .buttons {
      flex: none;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 14px;
    }
    label {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    label.stack {
      flex-direction: column;
      align-items: stretch;
      gap: 3px;
    }
    textarea {
      font-family: var(--font-mono, monospace);
      font-size: 12px;
      resize: vertical;
    }
    input[type='number'] {
      width: 90px;
    }
    .grow {
      flex: 1;
    }
    .note {
      color: var(--text-dim);
      font-size: 12px;
    }
    .leaves {
      padding: 6px 8px;
      border: 1px solid var(--border);
      border-left: 3px solid var(--danger);
      border-radius: var(--radius);
    }
    .warn {
      color: var(--danger);
    }
    .path {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    code {
      font-family: var(--font-mono, monospace);
      font-size: 12px;
      overflow-wrap: anywhere;
      user-select: all;
    }
    table {
      border-collapse: collapse;
      font-size: 12px;
    }
    table.log {
      width: 100%;
    }
    th,
    td {
      padding: 2px 8px 2px 0;
      text-align: left;
      vertical-align: top;
      font-weight: normal;
    }
    thead th {
      color: var(--text-dim);
    }
    tbody th .note {
      margin-left: 6px;
    }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .stmt {
      max-width: 380px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-family: var(--font-mono, monospace);
    }
    tr.failed td {
      color: var(--danger);
    }
    button {
      padding: 3px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    button:disabled {
      opacity: 0.5;
    }
  `,
})
export class McpDialog {
  readonly closed = output<void>();

  protected readonly mcp = inject(McpService);
  private readonly connections = inject(ConnectionsStore);
  private readonly clipboard = inject(ClipboardApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly t = MCP_TEXTS;
  protected readonly levels = AI_LEVELS;
  protected readonly ai = this.mcp.ai;
  protected readonly status = this.mcp.status;
  protected readonly copied = signal(false);
  protected readonly profiles = computed(() => this.connections.profiles());
  protected readonly command = computed(() => claudeCommand(this.status().sidecar));
  protected readonly config = computed(() => serverConfig(this.status().sidecar));
  protected readonly probeText = computed(() => {
    const p = this.mcp.probe();
    if (!p) return '';
    return p.ok
      ? this.t.testOk(p.server ?? '', p.version ?? '', p.tools)
      : this.t.testFailed(this.t.steps[p.step], p.code ?? '');
  });

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      void this.mcp.refresh();
    });
  }

  protected patch(patch: Partial<ReturnType<typeof this.ai>>): void {
    void this.mcp.update({ ...this.ai(), ...patch });
  }

  protected number(text: string, min: number, max: number, fallback: number): number {
    const n = Number(text);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  }

  protected patterns = patternsOf;

  protected level(value: string): AiLevel {
    return (AI_LEVELS as readonly string[]).includes(value) ? (value as AiLevel) : 'off';
  }

  protected hasOwn(p: Profile): boolean {
    return this.ai().access[p.id] !== undefined;
  }

  protected levelNow(p: Profile): AiLevel {
    return levelOf(this.ai(), p);
  }

  /** What the connection gets without a level of its own. */
  protected defaultOf(p: Profile): AiLevel {
    return levelOf({ ...this.ai(), access: {} }, p);
  }

  protected levelsOf = levelsFor;

  protected setLevel(p: Profile, value: string): void {
    void this.mcp.update(withLevel(this.ai(), p.id, value === '' ? null : this.level(value)));
  }

  protected async copy(text: string): Promise<void> {
    try {
      await this.clipboard.copyText(text);
      this.copied.set(true);
    } catch {
      this.copied.set(false);
    }
  }

  protected time(e: McpLogEntry): string {
    return new Date(e.at).toLocaleTimeString(locale());
  }

  protected line(statement: string): string {
    return oneLine(statement);
  }

  protected nameOf(id: string): string {
    return this.connections.profiles().find((p) => p.id === id)?.name ?? id;
  }
}
