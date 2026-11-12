import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  DestroyRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Proposal, lineCount } from './mcp-logic';

/** How long "Run it" stays off after the dialog appeared. */
export const READY_MS = 700;
import { MCP_TEXTS } from './mcp-texts';

/**
 * A statement an AI assistant proposes (prompt 048): the statement, the connection and the assistant's
 * reason – all as text, nothing of it is markup. The focus starts on "Decline"; Escape declines.
 */
@Component({
  selector: 'app-mcp-proposal-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      aria-labelledby="mp-title"
      aria-describedby="mp-note"
      (cancel)="$event.preventDefault(); answered.emit('decline')"
    >
      <h2 id="mp-title">{{ t.proposalTitle }}</h2>
      <p class="on">{{ t.proposalOn(connection()) }}</p>
      <p [class.warn]="proposal().writes" class="kind">
        {{ kindText() }}
      </p>
      @if (lines() > 12) {
        <p class="note">{{ t.proposalLines(lines()) }}</p>
      }
      <pre tabindex="0">{{ proposal().sql }}</pre>
      @if (proposal().reason) {
        <h3>{{ t.proposalReason }}</h3>
        <p class="reason">{{ proposal().reason }}</p>
      }
      <p id="mp-note" class="note">{{ t.proposalNote }}</p>
      <div class="buttons">
        <button #decline type="button" (click)="answered.emit('decline')">{{ t.decline }}</button>
        <span class="grow"></span>
        <button type="button" [disabled]="!ready()" (click)="answered.emit('tab')">
          {{ t.toTab }}
        </button>
        <button type="button" class="primary" [disabled]="!ready()" (click)="answered.emit('run')">
          {{ t.run }}
        </button>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(720px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
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
    h2 {
      margin: 0;
      font-size: 14px;
    }
    h3 {
      margin: 0;
      font-size: 12px;
      color: var(--text-dim);
    }
    p {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .note {
      color: var(--text-dim);
      font-size: 12px;
    }
    .warn {
      color: var(--danger);
    }
    .reason {
      white-space: pre-wrap;
    }
    pre {
      min-height: 60px;
      max-height: 320px;
      margin: 0;
      padding: 8px 10px;
      overflow: auto;
      background: var(--bg-app);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      font-family: var(--font-mono, monospace);
      font-size: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .buttons {
      display: flex;
      gap: 8px;
    }
    .grow {
      flex: 1;
    }
    button {
      padding: 3px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    button:disabled {
      opacity: 0.5;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-text);
    }
  `,
})
export class McpProposalDialog {
  readonly proposal = input.required<Proposal>();
  /** The name of the connection, as the user knows it. */
  readonly connection = input.required<string>();
  readonly answered = output<'run' | 'tab' | 'decline'>();

  private readonly destroyed = inject(DestroyRef);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly decline = viewChild.required<ElementRef<HTMLButtonElement>>('decline');

  protected readonly t = MCP_TEXTS;
  /** A moment before anything can be run: a click meant for the dialog before does not land here. */
  protected readonly ready = signal(false);
  protected readonly lines = computed(() => lineCount(this.proposal().sql));
  protected readonly kindText = computed(() => {
    const p = this.proposal();
    return p.dangerous
      ? this.t.proposalDangerous
      : p.writes
        ? this.t.proposalWrites
        : this.t.proposalReads;
  });

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      this.decline().nativeElement.focus();
      const timer = setTimeout(() => this.ready.set(true), READY_MS);
      this.destroyed.onDestroy(() => clearTimeout(timer));
    });
  }
}
