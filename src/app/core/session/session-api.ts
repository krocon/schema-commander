import { Injectable } from '@angular/core';
import { call } from '../backend/call';

/** Mirrors `TabMeta` in src-tauri/src/session.rs: what is remembered of a tab – never its text. */
export interface TabMeta {
  readonly id: string;
  readonly title: string;
  /** The user named the tab: the title no longer follows its text. */
  readonly customTitle: boolean;
  readonly connection: string | null;
  /** The `.sql` file the tab was opened from or saved to. */
  readonly filePath: string | null;
  /** The encoding of that file (`utf-8`, `utf-8-bom`, `utf-16le`, `utf-16be`, `windows-1252`). */
  readonly encoding: string | null;
  /** The tab group it is in while the view is split: 0 or 1 (prompt 016). */
  readonly group?: number;
  /** Where the caret was: line and column from 1; 0 or missing = unknown. */
  readonly caretLine?: number;
  readonly caretCh?: number;
}

/** Mirrors `SessionFile`. */
export interface SessionFile {
  readonly version: number;
  readonly tabs: readonly TabMeta[];
  readonly active: string | null;
  /** The tab the other group of a split view shows. */
  readonly other?: string | null;
  /** How a split view lies: `row` (side by side) or `column`. */
  readonly split?: string;
}

/** Mirrors `LoadedSession`. */
export interface LoadedSession {
  readonly session: SessionFile;
  readonly notice: string | null;
}

/** Mirrors `TextFile` in src-tauri/src/textfile.rs. */
export interface TextFile {
  readonly text: string;
  readonly encoding: string;
}

export const SESSION_VERSION = 1;

/**
 * The open tabs over a restart (prompt 004): which tabs there are (`session.json`) and the text of each
 * (a file of its own, written often), plus reading and writing `.sql` files the user chose.
 */
export abstract class SessionApi {
  abstract load(): Promise<LoadedSession>;
  abstract save(session: SessionFile): Promise<void>;
  /** The backed-up text of a tab; `''` when there is none. */
  abstract loadText(id: string): Promise<string>;
  abstract saveText(id: string, text: string): Promise<void>;
  abstract deleteText(id: string): Promise<void>;
  abstract readFile(path: string): Promise<TextFile>;
  /** Rejects with `encoding_failed` when the encoding cannot hold the text. */
  abstract writeFile(path: string, text: string, encoding: string): Promise<void>;
}

@Injectable()
export class TauriSessionApi extends SessionApi {
  load(): Promise<LoadedSession> {
    return call('load_session');
  }
  save(session: SessionFile): Promise<void> {
    return call('save_session', { session });
  }
  loadText(id: string): Promise<string> {
    return call('load_tab_text', { id });
  }
  saveText(id: string, text: string): Promise<void> {
    return call('save_tab_text', { id, text });
  }
  deleteText(id: string): Promise<void> {
    return call('delete_tab_text', { id });
  }
  readFile(path: string): Promise<TextFile> {
    return call('read_text_file', { path });
  }
  writeFile(path: string, text: string, encoding: string): Promise<void> {
    return call('write_text_file', { path, text, encoding });
  }
}
