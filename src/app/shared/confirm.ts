import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injectable,
  afterNextRender,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

/** A question with two answers. */
export interface ConfirmRequest {
  readonly title: string;
  readonly message: string;
  /** The button that says yes (a verb: „Kopieren“, „Ausführen“). */
  readonly confirm: string;
}

/**
 * Asks before something big or lasting happens. One question at a time: a second one while the first is
 * open is answered with no.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly request = signal<ConfirmRequest | null>(null);
  private resolve: ((yes: boolean) => void) | null = null;

  ask(request: ConfirmRequest): Promise<boolean> {
    if (this.resolve) return Promise.resolve(false);
    this.request.set(request);
    return new Promise((resolve) => (this.resolve = resolve));
  }

  answer(yes: boolean): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.request.set(null);
    resolve?.(yes);
  }
}

/** The dialog of `ConfirmService`; Escape and "Abbrechen" say no, the focus starts on "Abbrechen". */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
      (cancel)="$event.preventDefault(); answered.emit(false)"
    >
      <h2 id="confirm-title">{{ request().title }}</h2>
      <p id="confirm-message">{{ request().message }}</p>
      <footer>
        <button #cancel type="button" (click)="answered.emit(false)">Abbrechen</button>
        <button type="button" class="primary" (click)="answered.emit(true)">
          {{ request().confirm }}
        </button>
      </footer>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(440px, calc(100vw - 32px));
      padding: 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 35%);
    }
    h2 {
      margin: 0 0 8px;
      font-size: 14px;
    }
    p {
      margin: 0 0 16px;
      line-height: 1.45;
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
  `,
})
export class ConfirmDialog {
  readonly request = input.required<ConfirmRequest>();
  readonly answered = output<boolean>();
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly cancel = viewChild.required<ElementRef<HTMLButtonElement>>('cancel');

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      this.cancel().nativeElement.focus();
    });
  }
}
