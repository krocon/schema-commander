import { translatable } from '../../core/i18n/i18n';
import { RESULTS_DE } from './results-texts.de';

/** Texts of the result grid and of copying from it (prompts 006, 009). English is the source. */
export const RESULTS_EN = {
  loadingRows: 'Loading rows …',
  /** The formats of "copy as"; what follows ` (` is left out in the status line. */
  formats: {
    tsv: 'TSV (for spreadsheets)',
    csv: 'CSV',
    json: 'JSON',
    markdown: 'Markdown table',
    html: 'HTML table',
    insert: 'INSERT statements',
    inlist: 'IN (…) list of the first column',
    where: 'WHERE condition',
    values: 'Values of the first column',
  },
  /** Both numbers as they are shown (digits in groups). */
  bigCopyQuestion: (rows: string, cells: string) =>
    `Copy ${rows} rows (${cells} cells) to the clipboard? This can take a while and use a lot of memory.`,
  copied: (n: number, rows: string, format: string) =>
    `${rows} ${n === 1 ? 'row' : 'rows'} copied (${format})`,
  /** Stands for the table in `INSERT` statements when the statement names none. */
  tablePlaceholder: 'table_name',
  bigCopyTitle: 'A lot to copy',
  copy: 'Copy',
  copying: 'Copying …',
  copyCancelled: 'Copying cancelled.',
  tooLarge: 'Too much for the clipboard (more than 256 MB of text). Select less.',
  notCopied: (reason: string) => `Not copied: ${reason}`,
  copiedText: 'Copied.',
};

export const RESULTS_TEXTS = translatable('results', RESULTS_EN, { de: RESULTS_DE });
