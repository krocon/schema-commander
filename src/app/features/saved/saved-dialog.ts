import { Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError } from '../../core/errors/app-error';
import { COMMON_TEXTS } from '../../core/i18n/common-texts';
import { SavedForm, formProblem } from './saved-logic';
import { SavedStore } from './saved.store';
import { SAVED_TEXTS } from './saved-texts';

/**
 * Name, folder, description and tags of a saved query (prompt 024): for a text that is saved, and for a
 * query that is renamed, moved or described. Open while `SavedStore.request` is set.
 */
@Component({
  selector: 'app-saved-dialog',
  template: `
    <dialog #dialog aria-labelledby="saved-title" (cancel)="$event.preventDefault(); close()">
      <form (submit)="$event.preventDefault(); submit()">
        <h2 id="saved-title">{{ editing ? t.editTitle : t.saveTitle }}</h2>
        <label for="saved-name">{{ t.name }}</label>
        <input
          #name
          id="saved-name"
          type="text"
          autocomplete="off"
          spellcheck="false"
          maxlength="120"
          [value]="form().name"
          [attr.aria-invalid]="problem() === 'name'"
          (input)="set('name', $any($event.target).value)"
        />
        <label for="saved-folder">{{ t.folderField }}</label>
        <input
          id="saved-folder"
          type="text"
          autocomplete="off"
          spellcheck="false"
          list="saved-folders"
          aria-describedby="saved-folder-hint"
          [value]="form().folder"
          [attr.aria-invalid]="problem() === 'folder'"
          (input)="set('folder', $any($event.target).value)"
        />
        <datalist id="saved-folders">
          @for (folder of folders(); track folder) {
            <option [value]="folder"></option>
          }
        </datalist>
        <p class="hint" id="saved-folder-hint">{{ t.folderHint }}</p>
        <label for="saved-description">{{ t.description }}</label>
        <input
          id="saved-description"
          type="text"
          autocomplete="off"
          maxlength="500"
          [value]="form().description"
          (input)="set('description', $any($event.target).value)"
        />
        <label for="saved-tags">{{ t.tags }}</label>
        <input
          id="saved-tags"
          type="text"
          autocomplete="off"
          spellcheck="false"
          aria-describedby="saved-tags-hint"
          [value]="form().tags"
          (input)="set('tags', $any($event.target).value)"
        />
        <p class="hint" id="saved-tags-hint">{{ t.tagsHint }}</p>
        <label class="check">
          <input
            type="checkbox"
            aria-describedby="saved-bind-hint"
            [checked]="form().bound"
            (change)="set('bound', $any($event.target).checked)"
          />
          {{ bindLabel() }}
        </label>
        <p class="hint" id="saved-bind-hint">{{ t.bindHint }}</p>
        @if (message(); as m) {
          <p class="problem" role="alert">{{ m }}</p>
        }
        <footer>
          <button type="button" (click)="close()">{{ common.cancel }}</button>
          <button type="submit" class="primary" [disabled]="busy()">{{ t.save }}</button>
        </footer>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(480px, 92vw);
      padding: 16px;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    h2 {
      margin: 0 0 8px;
      font-size: 15px;
    }
    label {
      margin-top: 6px;
      font-size: 12px;
      color: var(--text-dim);
    }
    .check {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--text);
      font-size: 13px;
    }
    .hint {
      margin: 0;
      color: var(--text-dim);
      font-size: 11px;
    }
    .problem {
      margin: 6px 0 0;
      color: var(--error-fg);
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
    }
  `,
})
export class SavedDialog implements OnInit {
  protected readonly t = SAVED_TEXTS;
  protected readonly common = COMMON_TEXTS;
  private readonly store = inject(SavedStore);
  private readonly connections = inject(ConnectionsStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly nameField = viewChild.required<ElementRef<HTMLInputElement>>('name');

  /** What the dialog was opened for; it stays that while it is open. */
  private readonly request = this.store.request()!;
  protected readonly editing = this.request.kind === 'edit';
  protected readonly form = signal<SavedForm>(
    this.request.kind === 'edit'
      ? {
          name: this.request.entry.name,
          folder: this.request.entry.folder,
          description: this.request.entry.description,
          tags: this.request.entry.tags.join(', '),
          bound: this.request.entry.connection !== null,
        }
      : { name: this.request.name, folder: '', description: '', tags: '', bound: false },
  );
  protected readonly folders = computed(() => this.store.listing()?.folders ?? []);
  protected readonly problem = signal<'name' | 'folder' | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly busy = signal(false);

  ngOnInit(): void {
    this.dialog().nativeElement.showModal();
    const field = this.nameField().nativeElement;
    field.focus();
    field.select();
  }

  /** The connection the query is or would be bound to, by its name. */
  protected bindLabel(): string {
    const id =
      (this.request.kind === 'edit' ? this.request.entry.connection : null) ??
      this.connections.activeId();
    const name = this.connections.profiles().find((p) => p.id === id)?.name;
    return name ? this.t.bind(name) : this.t.bindNone;
  }

  protected set<K extends keyof SavedForm>(key: K, value: SavedForm[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
    this.problem.set(null);
    this.message.set(null);
  }

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    const problem = formProblem(this.form());
    this.problem.set(problem);
    if (problem) {
      this.message.set(problem === 'name' ? this.t.nameMissing : this.t.folderInvalid);
      return;
    }
    this.busy.set(true);
    try {
      await this.store.submit(this.request, this.form());
      this.close();
    } catch (e) {
      this.message.set(describeError(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected close(): void {
    this.dialog().nativeElement.close();
    this.store.request.set(null);
  }
}
