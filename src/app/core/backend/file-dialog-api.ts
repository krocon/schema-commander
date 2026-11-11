import { Injectable } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';

export interface FileFilter {
  readonly name: string;
  /** Without the dot: `json`. */
  readonly extensions: readonly string[];
}

/**
 * The native open and save dialogs. They are the only source of a path that goes into a command: the
 * frontend never builds paths itself.
 */
export abstract class FileDialogApi {
  /** The chosen file, `null` = cancelled (or no desktop backend). */
  abstract openFile(title: string, filters: readonly FileFilter[]): Promise<string | null>;
  abstract saveFile(
    title: string,
    defaultName: string,
    filters: readonly FileFilter[],
  ): Promise<string | null>;
}

const plain = (filters: readonly FileFilter[]) =>
  filters.map((f) => ({ name: f.name, extensions: [...f.extensions] }));

@Injectable()
export class TauriFileDialogApi extends FileDialogApi {
  async openFile(title: string, filters: readonly FileFilter[]): Promise<string | null> {
    if (!isTauri()) return null;
    const chosen = await open({
      title,
      multiple: false,
      directory: false,
      filters: plain(filters),
    });
    return typeof chosen === 'string' ? chosen : null;
  }

  async saveFile(
    title: string,
    defaultName: string,
    filters: readonly FileFilter[],
  ): Promise<string | null> {
    if (!isTauri()) return null;
    return (await save({ title, defaultPath: defaultName, filters: plain(filters) })) ?? null;
  }
}
