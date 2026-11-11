import { Component, ElementRef, OnInit, computed, inject, input, viewChild } from '@angular/core';
import { whereLabel } from '../../core/connections/connection.models';
import { ConnectionsStore, PasswordRequest } from '../../core/connections/connections.store';

/**
 * Asks for the password of a connection (prompt 003). The text only goes to the store, which hands it to the
 * backend; it is never kept here.
 */
@Component({
  selector: 'app-password-dialog',
  template: `
    <dialog
      #dialog
      aria-labelledby="password-title"
      (cancel)="$event.preventDefault(); answer(null)"
    >
      <form (submit)="$event.preventDefault(); answer(field.value)">
        <h2 id="password-title">
          {{ request().kind === 'ssh' ? 'SSH-Tunnel: Passwort oder Passphrase' : 'Passwort' }}
        </h2>
        <p>
          {{ profile()?.name }}
          <span class="where">{{ request().kind === 'ssh' ? sshWhere() : where() }}</span>
        </p>
        @if (request().wrong) {
          <p class="problem" role="alert">Die Anmeldung wurde abgelehnt. Bitte noch einmal.</p>
        }
        <label for="password-field">Passwort</label>
        <input
          #field
          id="password-field"
          type="password"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
        <p class="hint">
          @if (profile()?.savePassword) {
            Nach einer gelungenen Anmeldung wird es im Schlüsselbund des Systems gespeichert.
          } @else {
            Es wird nicht gespeichert.
          }
        </p>
        <footer>
          <button type="button" (click)="answer(null)">Abbrechen</button>
          <button type="submit" class="primary">Verbinden</button>
        </footer>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(420px, calc(100vw - 32px));
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
      margin: 0 0 10px;
    }
    .where,
    .hint {
      display: block;
      color: var(--text-dim);
      font-size: 12px;
    }
    label {
      display: block;
      margin-bottom: 4px;
      font-size: 12px;
    }
    input {
      width: 100%;
      margin-bottom: 8px;
    }
    .problem {
      color: var(--error-fg);
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .primary {
      background: var(--accent);
      color: var(--accent-text);
    }
  `,
})
export class PasswordDialog implements OnInit {
  private readonly store = inject(ConnectionsStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  readonly request = input.required<PasswordRequest>();

  protected readonly profile = computed(
    () => this.store.profiles().find((p) => p.id === this.request().id) ?? null,
  );
  protected readonly sshWhere = computed(() => {
    const ssh = this.profile()?.ssh;
    return ssh ? `${ssh.user}@${ssh.host}${ssh.port ? `:${ssh.port}` : ''}` : '';
  });
  protected readonly where = computed(() => {
    const p = this.profile();
    return p ? whereLabel(p) : '';
  });

  ngOnInit(): void {
    this.dialog().nativeElement.showModal();
    this.field().nativeElement.focus();
  }

  protected answer(password: string | null): void {
    // the field is emptied before the dialog goes: nothing of the password stays in the page
    this.field().nativeElement.value = '';
    this.dialog().nativeElement.close();
    this.store.answerPassword(password);
  }
}
