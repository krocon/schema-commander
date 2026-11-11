import { Injectable } from '@angular/core';
import { call } from '../backend/call';

/** Mirrors `AppInfo` in src-tauri/src/about.rs (prompt 034). */
export interface AppInfo {
  readonly name: string;
  /** From tauri.conf.json, which reads package.json (one source of truth). */
  readonly version: string;
  /** Cargo.toml – equal to `version` unless the versions drifted apart. */
  readonly crateVersion: string;
  readonly tauriVersion: string;
  /** `macos`, `windows`, `linux`, … */
  readonly os: string;
  /** `x86_64`, `aarch64`, … */
  readonly arch: string;
  readonly debug: boolean;
}

/** What the app is and what it is made of. Rejects with an `AppError`. */
export abstract class AboutApi {
  abstract appInfo(): Promise<AppInfo>;
  /** The licence texts of the third-party components, as the package carries them. */
  abstract notices(): Promise<string>;
}

@Injectable()
export class TauriAboutApi extends AboutApi {
  appInfo(): Promise<AppInfo> {
    return call('app_info');
  }

  notices(): Promise<string> {
    return call('third_party_notices');
  }
}
