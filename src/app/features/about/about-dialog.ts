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
import { AboutApi, AppInfo } from '../../core/about/about-api';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { aboutRows, diagnostics } from './about-logic';
import { ABOUT_TEXTS } from './about-texts';

/**
 * What the app is (prompt 034): version, build, platform, licence – and the licence texts of what it is
 * made of. „Copy diagnostics“ puts the rows on the clipboard for a bug report; nothing of the user's is
 * in them.
 */
@Component({
  selector: 'app-about-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="about-title" (cancel)="$event.preventDefault(); closed.emit()">
      <div class="head">
        <img src="icon.svg" alt="" width="56" height="56" />
        <div>
          <h2 id="about-title">{{ t.title }}</h2>
          <p class="dim">{{ t.tagline }}</p>
        </div>
      </div>
      <dl>
        @for (r of rows(); track r.label) {
          <dt>{{ r.label }}</dt>
          <dd>{{ r.value }}</dd>
        }
      </dl>
      @if (state() === 'loading') {
        <p class="dim">{{ t.loading }}</p>
      } @else if (state() === 'none') {
        <p class="dim">{{ t.noBackend }}</p>
      }
      @if (notices(); as text) {
        <pre tabindex="0" role="region" [attr.aria-label]="t.noticesLabel">{{ text }}</pre>
      }
      <p class="status" role="status">{{ status() }}</p>
      <footer>
        <button type="button" (click)="toggleNotices()">
          {{ notices() === null ? t.showNotices : t.hideNotices }}
        </button>
        <button type="button" (click)="copy()">{{ t.copy }}</button>
        <button type="button" class="primary" (click)="closed.emit()">{{ t.close }}</button>
      </footer>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(560px, calc(100vw - 32px));
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
    .head {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    h2 {
      margin: 0;
      font-size: 15px;
    }
    p {
      margin: 2px 0;
    }
    .dim {
      color: var(--text-dim);
    }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 4px 14px;
      margin: 0 0 8px;
    }
    dt {
      color: var(--text-dim);
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
      user-select: text;
    }
    pre {
      max-height: 260px;
      margin: 8px 0 0;
      padding: 6px 8px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      font-family: var(--font-mono);
      font-size: 11px;
      white-space: pre-wrap;
      user-select: text;
    }
    .status {
      min-height: 1.4em;
      color: var(--text-dim);
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
  `,
})
export class AboutDialog {
  readonly closed = output<void>();

  private readonly api = inject(AboutApi);
  private readonly clipboard = inject(ClipboardApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly t = ABOUT_TEXTS;
  protected readonly info = signal<AppInfo | null>(null);
  protected readonly state = signal<'loading' | 'ready' | 'none'>('loading');
  /** The licence texts while they are shown. */
  protected readonly notices = signal<string | null>(null);
  protected readonly status = signal('');
  private readonly agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  protected readonly rows = computed(() => aboutRows(this.info(), this.agent));

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.info.set(await this.api.appInfo());
      this.state.set('ready');
    } catch {
      this.state.set('none');
    }
  }

  protected async toggleNotices(): Promise<void> {
    if (this.notices() !== null) {
      this.notices.set(null);
      return;
    }
    try {
      this.notices.set(await this.api.notices());
      this.status.set('');
    } catch {
      this.status.set(this.t.noticesFailed);
    }
  }

  protected async copy(): Promise<void> {
    try {
      await this.clipboard.copyText(diagnostics(this.info(), this.agent));
      this.status.set(this.t.copied);
    } catch {
      this.status.set(this.t.copyFailed);
    }
  }
}
