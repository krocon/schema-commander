import { Injectable, signal } from '@angular/core';
import { GuardAnswer, GuardRequest } from './guard-logic';

/**
 * Asks before statements run that the connection guards (prompt 012). The yes alone runs nothing: the
 * backend gives a token for it and checks it at the run.
 */
@Injectable({ providedIn: 'root' })
export class GuardService {
  readonly request = signal<GuardRequest | null>(null);
  private resolve: ((answer: GuardAnswer | null) => void) | null = null;

  /** Resolves with the answer, or `null` for a no. One question at a time. */
  ask(request: GuardRequest): Promise<GuardAnswer | null> {
    if (this.resolve) return Promise.resolve(null);
    this.request.set(request);
    return new Promise((resolve) => (this.resolve = resolve));
  }

  answer(answer: GuardAnswer | null): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.request.set(null);
    resolve?.(answer);
  }
}
