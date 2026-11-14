import { UpdateInfo } from '../../core/update/update-api';

/** The app asks by itself at most once in this time. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** What a version may be when it is stored: `1.2.3`. */
export const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;

/**
 * Is it time to ask without being asked? Only when the user lets the app, and not within a day of the
 * last time. A last time in the future (the clock was set back) counts as never.
 */
export function dueForCheck(
  settings: { readonly updateCheck: boolean; readonly updateLastCheck: number },
  now: number,
): boolean {
  if (!settings.updateCheck) return false;
  const last = settings.updateLastCheck;
  return last <= 0 || last > now || now - last >= CHECK_INTERVAL_MS;
}

/** The version to point the user at: a newer one they did not say to skip. */
export function offered(info: UpdateInfo | null, skipped: string): string | null {
  return info && info.newer && info.latest !== skipped ? info.latest : null;
}
