import { Injectable, computed, inject, signal } from '@angular/core';
import {
  ClipboardApi,
  CopyFormat,
  CopyOptions,
  CopySelection,
} from '../../core/backend/clipboard-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError, toAppError } from '../../core/errors/app-error';
import { SettingsService } from '../../core/settings/settings.service';
import { ConfirmService } from '../../shared/confirm';
import { TabsStore } from '../tabs/tabs.store';
import {
  ASK_FROM_CELLS,
  bigCopyQuestion,
  copiedMessage,
  selectionSize,
  tableOf,
  tablePlaceholder,
} from './copy-logic';
import { RESULTS_TEXTS } from './results-texts';

/** How long the status line says what was copied. */
export const COPY_MESSAGE_MS = 4000;

/**
 * Copies from the result in front (prompt 009): what is selected in its grid, or all of it. The grids tell
 * what is selected in them; the rows are written to the clipboard by the backend.
 */
@Injectable({ providedIn: 'root' })
export class CopyService {
  private readonly api = inject(ClipboardApi);
  private readonly tabs = inject(TabsStore);
  private readonly connections = inject(ConnectionsStore);
  private readonly settings = inject(SettingsService);
  private readonly confirm = inject(ConfirmService);

  /** A copy runs. */
  readonly busy = signal(false);
  /** What the status line says about the last copy. */
  readonly message = signal<string | null>(null);
  /** Where the menu "copy as" is open. */
  readonly menu = signal<{ readonly x: number; readonly y: number } | null>(null);
  private readonly sources = new Map<number, () => CopySelection>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** The result in front: of the statement shown in the active tab. */
  readonly current = computed(() => {
    const tab = this.tabs.active();
    if (!tab) return null;
    const shown = tab.shown();
    const run = typeof shown === 'number' ? tab.runs()[shown] : undefined;
    if (!run?.result || run.rows === null) return null;
    return {
      result: run.result,
      rows: run.rows,
      sql: run.sql,
      connectionId: tab.connectionId(),
    };
  });
  readonly can = computed(() => this.current() !== null && !this.busy());

  /** What is selected in the grid of the result in front (nothing = everything). */
  selection(): CopySelection {
    const current = this.current();
    return (current && this.sources.get(current.result.resultId)?.()) ?? { rows: [], columns: [] };
  }

  /** A grid says what is selected in it; the function returned ends that. */
  register(resultId: number, selection: () => CopySelection): () => void {
    this.sources.set(resultId, selection);
    return () => {
      if (this.sources.get(resultId) === selection) this.sources.delete(resultId);
    };
  }

  /** Opens the menu of formats, at a point or over the result. */
  openMenu(x?: number, y?: number): void {
    if (!this.can()) return;
    if (x === undefined || y === undefined) {
      const box = document.querySelector('app-result-grid')?.getBoundingClientRect();
      x = (box?.left ?? 200) + 40;
      y = (box?.top ?? 200) + 30;
    }
    this.menu.set({ x, y });
  }

  private say(text: string): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.message.set(text);
    this.timer = setTimeout(() => this.message.set(null), COPY_MESSAGE_MS);
  }

  /** Copies the selection of the result in front; without a format: tab-separated, as a spreadsheet takes it. */
  async copy(format: CopyFormat = 'tsv'): Promise<void> {
    const current = this.current();
    if (!current || this.busy()) return;
    const { result, rows, sql, connectionId } = current;
    const selection = this.sources.get(result.resultId)?.() ?? { rows: [], columns: [] };
    const size = selectionSize(selection, rows, result.columns.length);
    if (size.rows === 0) return;
    if (size.cells >= ASK_FROM_CELLS) {
      const yes = await this.confirm.ask({
        title: RESULTS_TEXTS.bigCopyTitle,
        message: bigCopyQuestion(size.rows, size.cells),
        confirm: RESULTS_TEXTS.copy,
      });
      if (!yes) return;
    }
    const s = this.settings.settings();
    const options: CopyOptions = {
      header: s.copyHeader,
      nullAs: s.copyNullAs,
      delimiter: s.csvDelimiter,
      table: tableOf(sql) ?? tablePlaceholder(),
      dialect: this.connections.profiles().find((p) => p.id === connectionId)?.kind ?? 'sqlite',
    };
    this.busy.set(true);
    if (this.timer !== null) clearTimeout(this.timer);
    this.message.set(RESULTS_TEXTS.copying);
    try {
      const copied = await this.api.copyResult(result.resultId, selection, format, options);
      if (format !== 'tsv') this.settings.update({ lastCopyFormat: format });
      this.say(copiedMessage(copied, format));
    } catch (e) {
      const error = toAppError(e);
      this.say(
        error.code === 'cancelled'
          ? RESULTS_TEXTS.copyCancelled
          : error.code === 'too_large'
            ? RESULTS_TEXTS.tooLarge
            : RESULTS_TEXTS.notCopied(describeError(error)),
      );
    } finally {
      this.busy.set(false);
    }
  }

  /** Stops the copy that runs. */
  cancel(): void {
    if (this.busy()) void this.api.cancelCopy();
  }

  /** Puts a short text on the clipboard (a name of the schema tree). */
  async copyText(text: string): Promise<void> {
    try {
      await this.api.copyText(text);
      this.say(RESULTS_TEXTS.copiedText);
    } catch (e) {
      this.say(RESULTS_TEXTS.notCopied(describeError(toAppError(e))));
    }
  }
}
