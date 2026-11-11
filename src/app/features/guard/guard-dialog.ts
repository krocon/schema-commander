import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  CLASS_LABELS,
  GuardAnswer,
  GuardRequest,
  PROTECTION_LABELS,
  guardTitle,
  nameMatches,
  needsName,
  shortSql,
} from './guard-logic';

/**
 * The question before guarded statements run: which connection, which database, which statements. What
 * destroys on a protected connection needs the name of the connection typed. Escape and "Abbrechen" say no;
 * the focus starts where a no is nearest.
 */
@Component({
  selector: 'app-guard-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      aria-labelledby="guard-title"
      (cancel)="$event.preventDefault(); answered.emit(null)"
    >
      <form (submit)="$event.preventDefault(); yes()">
        <h2 id="guard-title">{{ title() }}</h2>
        <p class="where">
          <span class="badge" [attr.data-protection]="request().connection.protection">{{
            request().connection.label || protection()
          }}</span>
          <strong>{{ request().connection.name }}</strong>
          @if (request().connection.database) {
            <span class="db">{{ request().connection.database }}</span>
          }
        </p>
        <ol>
          @for (s of request().statements; track $index) {
            <li>
              <span class="class" [class.dangerous]="s.verdict.class === 'dangerous'">{{
                labels[s.verdict.class]
              }}</span>
              <pre>{{ short(s.sql) }}</pre>
            </li>
          }
        </ol>
        @if (request().total > request().statements.length) {
          <p class="note">
            Der Lauf hat {{ request().total }} Anweisungen; die übrigen laufen ohne Rückfrage.
          </p>
        }
        @if (named()) {
          <label for="guard-name"
            >Zum Bestätigen den Namen der Verbindung eingeben:
            <strong>{{ request().connection.name }}</strong></label
          >
          <input
            #name
            id="guard-name"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            (input)="typed.set(name.value)"
          />
        }
        <footer>
          <button #cancel type="button" (click)="answered.emit(null)">Abbrechen</button>
          <button type="submit" class="danger" [disabled]="!ready()">Ausführen</button>
        </footer>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(560px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      padding: 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 2px solid var(--badge-danger-bg);
      border-radius: 8px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    h2 {
      margin: 0 0 8px;
      font-size: 14px;
    }
    .where {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 10px;
    }
    .badge {
      padding: 1px 8px;
      border-radius: 10px;
      background: var(--badge-danger-bg);
      color: var(--badge-danger-fg);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .db {
      color: var(--text-dim);
    }
    ol {
      margin: 0 0 10px;
      padding: 0;
      list-style: none;
      max-height: 260px;
      overflow: auto;
    }
    li {
      margin-bottom: 8px;
    }
    .class {
      font-size: 11px;
      color: var(--text-dim);
    }
    .class.dangerous {
      color: var(--danger);
      font-weight: 600;
    }
    pre {
      margin: 2px 0 0;
      padding: 6px 8px;
      background: var(--bg-app);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .note {
      margin: 0 0 10px;
      color: var(--text-dim);
    }
    label {
      display: block;
      margin-bottom: 4px;
    }
    input {
      width: 100%;
      margin-bottom: 12px;
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      color: var(--text);
      font: inherit;
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .danger {
      background: var(--badge-danger-bg);
      color: var(--badge-danger-fg);
      border-color: var(--badge-danger-bg);
    }
    .danger:disabled {
      opacity: 0.5;
    }
  `,
})
export class GuardDialog {
  readonly request = input.required<GuardRequest>();
  readonly answered = output<GuardAnswer | null>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly cancel = viewChild.required<ElementRef<HTMLButtonElement>>('cancel');
  private readonly nameField = viewChild<ElementRef<HTMLInputElement>>('name');

  protected readonly labels = CLASS_LABELS;
  protected readonly short = (sql: string) => shortSql(sql);
  protected readonly typed = signal('');
  protected readonly title = computed(() => guardTitle(this.request()));
  protected readonly protection = computed(
    () => PROTECTION_LABELS[this.request().connection.protection],
  );
  protected readonly named = computed(() => needsName(this.request().statements));
  protected readonly ready = computed(
    () => !this.named() || nameMatches(this.typed(), this.request().connection.name),
  );

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      // a habitual Enter must not run anything: the name field takes the focus, else "Abbrechen"
      (this.nameField() ?? this.cancel()).nativeElement.focus();
    });
  }

  protected yes(): void {
    if (!this.ready()) return;
    this.answered.emit({ typedName: this.named() ? this.typed() : null });
  }
}
