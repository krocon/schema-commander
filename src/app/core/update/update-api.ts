import { Injectable } from '@angular/core';
import { call } from '../backend/call';

/** Mirrors `UpdateInfo` in src-tauri/src/update.rs. */
export interface UpdateInfo {
  /** The version of this build. */
  readonly current: string;
  /** The latest published version, without a `v`. */
  readonly latest: string;
  /** `latest` is newer than `current`. */
  readonly newer: boolean;
  /** The day the release was published, `YYYY-MM-DD`; `''` when unknown. */
  readonly published: string;
  /** The notes of the release as plain text; never markup for the page. */
  readonly notes: string;
  /** The notes were longer than what is shown. */
  readonly notesCut: boolean;
}

/**
 * Is there a newer version? One request to the releases on GitHub – nothing of the user's is sent,
 * nothing is downloaded. Rejects with an `AppError`.
 */
export abstract class UpdateApi {
  abstract check(): Promise<UpdateInfo>;
  /** Opens the page of a release in the browser; `''` opens the list of releases. */
  abstract openPage(version: string): Promise<void>;
}

@Injectable()
export class TauriUpdateApi extends UpdateApi {
  check(): Promise<UpdateInfo> {
    return call('check_update');
  }

  openPage(version: string): Promise<void> {
    return call('open_release_page', { version });
  }
}
