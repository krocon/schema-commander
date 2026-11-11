import { Injectable } from '@angular/core';
import { call } from '../backend/call';

/** Mirrors `Meta` in src-tauri/src/saved.rs: what the header of a saved query says. */
export interface SavedMeta {
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** The id of the connection profile the query belongs to. */
  readonly connection: string | null;
  /** `postgres`, `mysql`, `sqlserver`, `sqlite`. */
  readonly dialect: string | null;
}

/** Mirrors `Entry` (its meta is flattened into it). */
export interface SavedEntry extends SavedMeta {
  /** The path below the folder, with `/`: names the query in every call. */
  readonly id: string;
  /** The file on disk – to open it as a tab. */
  readonly path: string;
  /** The folder below the root; `''` = the root. */
  readonly folder: string;
  /** Milliseconds since 1970. */
  readonly modified: number;
  readonly size: number;
}

/** Mirrors `Listing`. */
export interface SavedListing {
  readonly root: string;
  readonly entries: readonly SavedEntry[];
  /** Every folder below the root, also empty ones. */
  readonly folders: readonly string[];
  /** Differs when anything in the folder changed. */
  readonly stamp: string;
  readonly truncated: boolean;
}

/** Mirrors `Saved`. */
export interface SavedQuery {
  readonly entry: SavedEntry;
  /** The text without its header. */
  readonly text: string;
}

/**
 * Saved queries (prompt 024): `.sql` files in one folder, kept by the backend. A query is named by its id
 * (the path below the folder); the backend refuses every id that leads out of the folder. Rejects with an
 * `AppError` (`not_found`, `unsupported`, `too_large`, `io`, `permission_denied`).
 */
export abstract class SavedApi {
  /** Uses another folder (from the folder dialog); `null` = the app's own. */
  abstract useFolder(path: string | null): Promise<SavedListing>;
  abstract list(): Promise<SavedListing>;
  /** Cheap: reads no file. The window asks now and then and lists again when it differs. */
  abstract stamp(): Promise<string>;
  abstract read(id: string): Promise<SavedQuery>;
  /** `id` = the file to write again, else a new one in `folder`. Resolves with the id. */
  abstract save(id: string | null, folder: string, meta: SavedMeta, text: string): Promise<string>;
  /** Renames and/or moves; resolves with the new id. */
  abstract rename(id: string, folder: string, name: string): Promise<string>;
  abstract createFolder(folder: string): Promise<void>;
  /** Into the trash of the system. */
  abstract delete(id: string): Promise<void>;
  /** The ids of the queries in which every word occurs (name, tags, folder, text). */
  abstract search(query: string): Promise<readonly string[]>;
}

@Injectable()
export class TauriSavedApi extends SavedApi {
  useFolder(path: string | null): Promise<SavedListing> {
    return call('saved_use_folder', { path });
  }
  list(): Promise<SavedListing> {
    return call('saved_list');
  }
  stamp(): Promise<string> {
    return call('saved_stamp');
  }
  read(id: string): Promise<SavedQuery> {
    return call('saved_read', { id });
  }
  save(id: string | null, folder: string, meta: SavedMeta, text: string): Promise<string> {
    return call('saved_save', { id, folder, meta, text });
  }
  rename(id: string, folder: string, name: string): Promise<string> {
    return call('saved_rename', { id, folder, name });
  }
  createFolder(folder: string): Promise<void> {
    return call('saved_create_folder', { folder });
  }
  delete(id: string): Promise<void> {
    return call('saved_delete', { id });
  }
  search(query: string): Promise<readonly string[]> {
    return call('saved_search', { query });
  }
}
