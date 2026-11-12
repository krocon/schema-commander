import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  input,
  output,
  viewChild,
} from '@angular/core';
import { Proposal } from './mcp-logic';
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
        {{ proposal().writes ? t.proposalWrites : t.proposalReads }}
      </p>
      <pre tabindex="0">{{ proposal().sql }}</pre>
      @if (proposal().reason) {
        <h3>{{ t.proposalReason }}</h3>
        <p class="reason">{{ proposal().reason }}</p>
      }
      <p id="mp-note" class="note">{{ t.proposalNote }}</p>
      <div class="buttons">
        <button #decline type="button" (click)="answered.emit('decline')">{{ t.decline }}</button>
        <span class="grow"></span>
        <button type="button" (click)="answered.emit('tab')">{{ t.toTab }}</button>
        <button type="button" class="primary" (click)="answered.emit('run')">{{ t.run }}</button>
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

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly decline = viewChild.required<ElementRef<HTMLButtonElement>>('decline');

  protected readonly t = MCP_TEXTS;

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      this.decline().nativeElement.focus();
    });
  }
}
