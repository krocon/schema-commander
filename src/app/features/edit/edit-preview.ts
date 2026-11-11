import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  viewChild,
} from '@angular/core';
import { SettingsService } from '../../core/settings/settings.service';
import { EDIT_TEXTS } from './edit-texts';
import { EditService } from './edit.service';

/**
 * What writing the changes would send (prompt 031): one `UPDATE` per row, readable with the values
 * written out – sent they are bound. From here they can be written.
 */
@Component({
  selector: 'app-edit-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      aria-labelledby="edit-preview-title"
      (cancel)="$event.preventDefault(); edit.preview.set(null)"
    >
      @if (edit.preview(); as p) {
        <h2 id="edit-preview-title">{{ t.previewTitle(p.statements.length) }}</h2>
        <p class="note">{{ t.previewNote }}</p>
        <p class="note">{{ settings.settings().editLock ? t.locked : t.unlocked }}</p>
        <p class="note">
          {{ t.previewCounts(p.counts.delete, p.counts.update, p.counts.insert) }}
        </p>
        <ol>
          @for (s of p.statements; track $index) {
            <li>
              <pre>{{ s }}</pre>
            </li>
          }
        </ol>
        <footer>
          <button type="button" (click)="edit.preview.set(null)">{{ t.close }}</button>
          <button #go type="button" class="primary" [disabled]="edit.busy()" (click)="write(p.tab)">
            {{ t.write }}
          </button>
        </footer>
      }
    </dialog>
  `,
  styles: `
    dialog {
      display: flex;
      flex-direction: column;
      width: min(720px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      padding: 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 12px;
    }
    dialog:not([open]) {
      display: none;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    h2 {
      margin: 0 0 8px;
      font-size: 14px;
    }
    .note {
      margin: 0 0 4px;
      color: var(--text-dim);
    }
    ol {
      flex: 1;
      min-height: 0;
      margin: 8px 0 0;
      padding: 0;
      list-style: none;
      overflow: auto;
    }
    pre {
      margin: 0 0 8px;
      padding: 6px 8px;
      background: var(--bg-app);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-family: var(--font-mono);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      margin-top: 12px;
    }
  `,
})
export class EditPreview {
  protected readonly t = EDIT_TEXTS;
  protected readonly edit = inject(EditService);
  protected readonly settings = inject(SettingsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly writeButton = viewChild<ElementRef<HTMLButtonElement>>('go');

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      this.writeButton()?.nativeElement.focus();
    });
  }

  protected write(tab: Parameters<EditService['save']>[0]): void {
    this.edit.preview.set(null);
    void this.edit.save(tab);
  }
}
