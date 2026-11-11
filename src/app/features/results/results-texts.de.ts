import type { Translation } from '../../core/i18n/i18n';
import type { RESULTS_EN } from './results-texts';

export const RESULTS_DE: Translation<typeof RESULTS_EN> = {
  loadingRows: 'Zeilen werden geladen …',
  formats: {
    tsv: 'TSV (für Tabellenkalkulationen)',
    csv: 'CSV',
    json: 'JSON',
    markdown: 'Markdown-Tabelle',
    html: 'HTML-Tabelle',
    insert: 'INSERT-Anweisungen',
    inlist: 'IN (…)-Liste der ersten Spalte',
    where: 'WHERE-Bedingung',
    values: 'Werte der ersten Spalte',
  },
  bigCopyQuestion: (rows, cells) =>
    `${rows} Zeilen (${cells} Zellen) in die Zwischenablage kopieren? Das kann dauern und viel Speicher belegen.`,
  copied: (n, rows, format) => `${rows} ${n === 1 ? 'Zeile' : 'Zeilen'} kopiert (${format})`,
  tablePlaceholder: 'tabelle',
  bigCopyTitle: 'Viel zu kopieren',
  copy: 'Kopieren',
  copying: 'Kopiere …',
  copyCancelled: 'Kopieren abgebrochen.',
  tooLarge: 'Zu viel für die Zwischenablage (über 256 MB Text). Weniger auswählen.',
  notCopied: (reason) => `Nicht kopiert: ${reason}`,
  copiedText: 'Kopiert.',
};
