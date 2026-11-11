import { Injectable, signal } from '@angular/core';
import { DetailTarget, MAX_TRAIL, sameTarget } from './details-logic';

/**
 * Which object the details dialog shows (prompt 019), and the way back: following a relation shows another
 * object in the same dialog.
 */
@Injectable({ providedIn: 'root' })
export class ObjectDetailsService {
  /** The object on screen; `null` = the dialog is closed. */
  readonly current = signal<DetailTarget | null>(null);
  /** The objects one came from, the latest last. */
  readonly trail = signal<readonly DetailTarget[]>([]);

  /** Opens the dialog for an object (a fresh start: no way back). */
  open(target: DetailTarget): void {
    this.trail.set([]);
    this.current.set(target);
  }

  /** Follows a relation: the object on screen can be gone back to. */
  go(target: DetailTarget): void {
    const from = this.current();
    if (!from || sameTarget(from, target)) return;
    this.trail.update((t) => [...t, from].slice(-MAX_TRAIL));
    this.current.set(target);
  }

  back(): void {
    const trail = this.trail();
    const last = trail[trail.length - 1];
    if (!last) return;
    this.trail.set(trail.slice(0, -1));
    this.current.set(last);
  }

  close(): void {
    this.trail.set([]);
    this.current.set(null);
  }
}
