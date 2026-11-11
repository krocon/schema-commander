import { Injectable, inject, signal } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { HistoryApi, HistoryEntry, NewHistoryEntry } from '../../core/history/history-api';
import { SettingsService } from '../../core/settings/settings.service';
import { mayRecall, recallStep } from './history-logic';

/** A statement that ended, as a tab reports it. */
export interface RanStatement {
  readonly at: number;
  readonly connectionId: string;
  readonly sql: string;
  readonly elapsedMs: number;
  readonly rows: number | null;
  readonly outcome: 'ok' | 'failed' | 'cancelled';
  readonly message: string | null;
  readonly tab: string;
  readonly origin: 'user' | 'app';
}

/** Entries looked at when walking back from the editor. */
const RECALL_ENTRIES = 100;

/**
 * Notes what ran (prompt 010) – unless the history is off, for everything or for the connection – and
 * brings earlier statements back into the editor.
 */
@Injectable({ providedIn: 'root' })
export class HistoryService {
  private readonly api = inject(HistoryApi);
  private readonly connections = inject(ConnectionsStore);
  private readonly settings = inject(SettingsService);

  /** The dialog is open. */
  readonly open = signal(false);
  /** Counts what was noted or deleted, so an open list reads again. */
  readonly changed = signal(0);

  private recall: {
    tab: string;
    entries: readonly HistoryEntry[];
    at: number;
    text: string | null;
  } | null = null;

  /** Whether statements on a connection are noted. */
  enabled(connectionId: string): boolean {
    const s = this.settings.settings();
    return s.historyEnabled && !s.historyOff.includes(connectionId);
  }

  /** Turns the history of one connection on or off. */
  toggleConnection(connectionId: string): void {
    const off = this.settings.settings().historyOff;
    this.settings.update({
      historyOff: off.includes(connectionId)
        ? off.filter((id) => id !== connectionId)
        : [...off, connectionId],
    });
  }

  /** Notes a statement. A failure to note never disturbs the run. */
  record(ran: RanStatement): void {
    if (!this.enabled(ran.connectionId)) return;
    const profile = this.connections.profiles().find((p) => p.id === ran.connectionId);
    const s = this.settings.settings();
    const entry: NewHistoryEntry = {
      ...ran,
      connectionName: profile?.name ?? ran.connectionId,
      database: profile?.database ?? '',
    };
    this.recall = null;
    this.api.add(entry, { maxEntries: s.historyMaxEntries, maxDays: s.historyMaxDays }).then(
      () => this.changed.update((n) => n + 1),
      (e) => console.warn('history: not noted', e?.code ?? ''),
    );
  }

  /**
   * The statement before (`1`) or after (`-1`) the one the editor shows, of the connection of the tab.
   * `editorText` is what the editor holds now; `null` is returned when it must not be replaced (something
   * was typed) or there is nothing further. `''` means: back to the empty editor.
   */
  async recalled(
    tab: string,
    connectionId: string,
    editorText: string,
    step: 1 | -1,
  ): Promise<string | null> {
    let recall = this.recall;
    if (!recall || recall.tab !== tab || !mayRecall(editorText, recall.text)) {
      if (!mayRecall(editorText, null)) return null;
      const page = await this.api.list({ connectionId, userOnly: true, limit: RECALL_ENTRIES });
      recall = { tab, entries: page.entries, at: -1, text: null };
    }
    const at = recallStep(recall.at, step, recall.entries.length);
    if (at === recall.at) return null;
    let text = '';
    if (at >= 0) {
      try {
        text = await this.api.text(recall.entries[at].id);
      } catch {
        return null;
      }
    }
    this.recall = { ...recall, at, text: at >= 0 ? text : null };
    return text;
  }
}
