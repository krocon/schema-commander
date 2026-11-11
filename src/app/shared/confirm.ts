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
  /** A second way to go on ("Rollback" next to "Commit"); none by default. */
  readonly second?: string;
}

/** How a question with a second way was answered. */
export type Choice = 'yes' | 'second' | 'no';

/**
 * Asks before something big or lasting happens. One question at a time: a second one while the first is
 * open is answered with no.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly request = signal<ConfirmRequest | null>(null);
  private resolve: ((choice: Choice) => void) | null = null;

  ask(request: ConfirmRequest): Promise<boolean> {
    return this.choose(request).then((choice) => choice === 'yes');
  }

  /** Asks a question that may have a second way to go on. */
  choose(request: ConfirmRequest): Promise<Choice> {
    if (this.resolve) return Promise.resolve('no');
    this.request.set(request);
    return new Promise((resolve) => (this.resolve = resolve));
  }

  answer(choice: boolean | Choice): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.request.set(null);
    resolve?.(choice === true ? 'yes' : choice === false ? 'no' : choice);
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
        @if (request().second; as second) {
          <button type="button" (click)="answered.emit('second')">{{ second }}</button>
        }
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
  readonly answered = output<boolean | Choice>();
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly cancel = viewChild.required<ElementRef<HTMLButtonElement>>('cancel');

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      this.cancel().nativeElement.focus();
    });
  }
}
