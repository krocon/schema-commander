import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  viewChild,
} from '@angular/core';
import { UpdateService } from './update.service';
import { UPDATE_TEXTS } from './update-texts';

/**
 * What the check for a newer version said: up to date, or the newer version with its notes and the way
 * to its page. The notes are foreign text and only ever set as text.
 */
@Component({
  selector: 'app-update-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      aria-labelledby="update-title"
      (cancel)="$event.preventDefault(); updates.close()"
    >
      <h2 id="update-title">{{ t.title }}</h2>
      <div class="said" role="status">
        @switch (updates.state()) {
          @case ('checking') {
            <p class="dim">{{ t.checking }}</p>
          }
          @case ('failed') {
            <p class="failed">{{ t.failed }}</p>
            <p class="dim">{{ updates.error() }}</p>
          }
          @case ('ready') {
            @if (updates.info(); as info) {
              @if (info.newer) {
                <p class="newer">{{ t.newer(info.latest, info.current) }}</p>
                @if (info.published) {
                  <p class="dim">{{ t.published(info.published) }}</p>
                }
              } @else {
                <p>{{ t.upToDate(info.current) }}</p>
              }
            }
          }
        }
        @if (updates.pageFailed()) {
          <p class="failed">{{ t.openFailed }}</p>
        }
      </div>
      @if (updates.state() === 'ready' && updates.info(); as info) {
        @if (info.newer && info.notes) {
          <pre tabindex="0" role="region" [attr.aria-label]="t.notesLabel">{{ info.notes }}</pre>
          @if (info.notesCut) {
            <p class="dim">{{ t.notesCut }}</p>
          }
        }
      }
      <p class="dim privacy">{{ t.privacy }}</p>
      <footer>
        @if (updates.state() === 'ready' && updates.info()?.newer) {
          <button type="button" (click)="updates.skip()">{{ t.skip }}</button>
          <button type="button" class="primary" autofocus (click)="updates.openPage()">
            {{ t.openPage }}
          </button>
        } @else if (updates.state() !== 'checking') {
          <button type="button" (click)="updates.checkNow()">{{ t.again }}</button>
        }
        <button type="button" (click)="updates.close()">{{ t.close }}</button>
      </footer>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(520px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
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
      margin: 0 0 10px;
      font-size: 15px;
    }
    p {
      margin: 2px 0;
    }
    .said {
      min-height: 2.8em;
    }
    .dim {
      color: var(--text-dim);
    }
    .newer {
      font-weight: 600;
    }
    .failed {
      color: var(--danger);
    }
    .privacy {
      margin: 10px 0;
      font-size: 11px;
    }
    pre {
      max-height: 240px;
      margin: 8px 0 0;
      padding: 6px 8px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      font-family: var(--font-mono);
      font-size: 11px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
  `,
})
export class UpdateDialog {
  protected readonly updates = inject(UpdateService);
  protected readonly t = UPDATE_TEXTS;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }
}
