import { Injectable } from '@angular/core';
import { call } from '../backend/call';

/** Mirrors `NewEntry` in src-tauri/src/history.rs: a statement that ran. */
export interface NewHistoryEntry {
  /** Milliseconds since the epoch. */
  readonly at: number;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly database: string;
  readonly sql: string;
  readonly elapsedMs: number;
  /** Rows read or changed; `null` when unknown. */
  readonly rows: number | null;
  readonly outcome: 'ok' | 'failed' | 'cancelled';
  readonly message: string | null;
  readonly tab: string;
  /** `app`: a statement the app wrote itself (open a table …). */
  readonly origin: 'user' | 'app';
}

/** Mirrors `Keep`: how much the history holds. */
export interface HistoryKeep {
  readonly maxEntries: number;
  /** 0 = any age. */
  readonly maxDays: number;
}

/** Mirrors `Entry`: an entry in a list, with the start of its text. */
export interface HistoryEntry {
  readonly id: number;
  readonly at: number;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly database: string;
  readonly preview: string;
  /** Characters of the statement as it ran. */
  readonly length: number;
  readonly elapsedMs: number;
  readonly rows: number | null;
  readonly outcome: string;
  readonly message: string | null;
  readonly tab: string;
  readonly origin: string;
  /** How often it ran in a row. */
  readonly count: number;
}

/** Mirrors `Filter`; everything is optional. */
export interface HistoryFilter {
  /** Words that must all be in the statement. */
  readonly text?: string;
  readonly connectionId?: string | null;
  readonly failedOnly?: boolean;
  readonly userOnly?: boolean;
  readonly from?: number | null;
  readonly to?: number | null;
  readonly limit?: number;
  readonly offset?: number;
}

export interface HistoryPage {
  readonly entries: readonly HistoryEntry[];
  /** Entries that match in all. */
  readonly total: number;
  /** Said once: the file was broken and set aside. */
  readonly notice: string | null;
}

/** Mirrors `Scope`: what to delete. */
export type HistoryScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'connection'; readonly id: string }
  | { readonly kind: 'entry'; readonly id: number };

/**
 * The history of statements (prompt 010): a file of its own on this machine, the only place where statement
 * texts are kept for good. Never a result, never a parameter value.
 */
export abstract class HistoryApi {
  /** Notes a statement; resolves with the id of its entry. */
  abstract add(entry: NewHistoryEntry, keep: HistoryKeep): Promise<number>;
  /** The entries that match, the latest first. */
  abstract list(filter: HistoryFilter): Promise<HistoryPage>;
  /** The whole text of an entry; rejects with `not_found` when it is gone. */
  abstract text(id: number): Promise<string>;
  /** Deletes for good; resolves with how many went. */
  abstract delete(scope: HistoryScope): Promise<number>;
}

@Injectable()
export class TauriHistoryApi extends HistoryApi {
  add(entry: NewHistoryEntry, keep: HistoryKeep): Promise<number> {
    return call('history_add', { entry, keep });
  }

  list(filter: HistoryFilter): Promise<HistoryPage> {
    return call('history_list', { filter });
  }

  text(id: number): Promise<string> {
    return call('history_text', { id });
  }

  delete(scope: HistoryScope): Promise<number> {
    return call('history_delete', { scope });
  }
}
