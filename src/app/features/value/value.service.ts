import { Injectable, inject, signal } from '@angular/core';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { describeError } from '../../core/errors/app-error';
import { QueryApi } from '../../core/sql/query-api';
import { QueryColumn } from '../../core/sql/query.models';
import { sizeText } from './value-logic';
import { VALUE_TEXTS } from './value-texts';

/** The cell a value panel shows: where it is in its result, and its column. */
export interface ActiveCell {
  readonly resultId: number;
  readonly row: number;
  readonly col: number;
  readonly column: QueryColumn;
}

/**
 * The cell the user is at, for the actions on its value (prompt 026): copy it whole, save it into a file.
 * Each result grid says where its cursor is; the last one that moved is the one meant. The value itself
 * never comes here – the backend copies and writes it.
 */
@Injectable({ providedIn: 'root' })
export class ValueService {
  private readonly api = inject(QueryApi);
  private readonly clipboard = inject(ClipboardApi);
  private readonly files = inject(FileDialogApi);

  readonly cell = signal<ActiveCell | null>(null);
  /** Something to tell once. */
  readonly notice = signal<string | null>(null);
  /** What the panel on screen shows of binary data (its hex lines): what „copy“ takes for bytes. */
  readonly shownBinary = signal<string | null>(null);

  /** The grid of a result that is gone has no cell any more. */
  forget(resultId: number): void {
    if (this.cell()?.resultId === resultId) this.cell.set(null);
  }

  /** The whole text of the cell onto the clipboard; of binary data what the panel shows of it. */
  async copy(): Promise<void> {
    const cell = this.cell();
    if (!cell) return;
    try {
      await this.api.copyCellValue(cell.resultId, cell.row, cell.col);
      this.notice.set(VALUE_TEXTS.copied);
    } catch (e) {
      const shown = this.shownBinary();
      if ((e as { code?: string })?.code === 'unsupported' && shown !== null) {
        try {
          await this.clipboard.copyText(shown);
          this.notice.set(VALUE_TEXTS.copied);
          return;
        } catch (inner) {
          this.notice.set(describeError(inner));
          return;
        }
      }
      this.notice.set(describeError(e));
    }
  }

  /** The whole value into a file the user chooses: text as UTF-8, binary data as it is. */
  async save(extension: string): Promise<void> {
    const cell = this.cell();
    if (!cell) return;
    const name = `${cell.column.name.replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'value'}.${extension}`;
    try {
      const path = await this.files.saveFile(VALUE_TEXTS.saveTitle, name, []);
      if (path === null) return;
      const bytes = await this.api.saveCellValue(cell.resultId, cell.row, cell.col, path);
      this.notice.set(VALUE_TEXTS.saved(sizeText(bytes)));
    } catch (e) {
      this.notice.set(describeError(e));
    }
  }
}
