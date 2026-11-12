import { Injectable, inject, signal } from '@angular/core';
import { QueryApi } from '../../core/sql/query-api';
import { Shown } from '../tabs/result-tabs-logic';
import { QueryTab } from '../tabs/query-tab';
import { TabsStore } from '../tabs/tabs.store';
import { CompareChoice, specOf, suggestKeys } from './compare-view-logic';
import { COMPARE_TEXTS } from './compare-texts';

/** What the dialog starts with: the tab, and the two results that are chosen first. */
export interface CompareRequest {
  readonly tab: QueryTab;
  readonly left: Shown | null;
  readonly right: Shown | null;
}

/** How a tab compared the last time: the names of its keys and of ignored columns, and the tolerances. */
interface Remembered {
  readonly byKey: boolean;
  readonly keys: readonly string[];
  readonly ignore: readonly string[];
  readonly trim: boolean;
  readonly ignoreCase: boolean;
  readonly round: boolean;
  readonly decimals: number;
}

/**
 * Comparing two results of a tab (prompt 041): opens the dialog, and runs „again and compare“. The
 * comparison itself is a job of the tab – its outcome is one of the tab's results.
 */
@Injectable({ providedIn: 'root' })
export class ResultCompareService {
  private readonly tabs = inject(TabsStore);
  private readonly api = inject(QueryApi);

  readonly request = signal<CompareRequest | null>(null);
  /** What was chosen the last time, by tab. In memory only. */
  private readonly remembered = new Map<string, Remembered>();

  /** Whether the tab in front has two results to compare. */
  can(): boolean {
    return (this.tabs.active()?.comparable().length ?? 0) >= 2;
  }

  /** Opens the dialog for the tab in front: the result on screen against another one. */
  open(): void {
    const tab = this.tabs.active();
    if (!tab) return;
    const all = tab.comparable();
    if (all.length < 2) {
      this.tabs.notice.set(COMPARE_TEXTS.tooFew);
      return;
    }
    const shown = tab.shown();
    const right = all.find((c) => c.target === shown) ?? all[all.length - 1];
    // the other one: the kept result that is the newest, else the result before
    const others = all.filter((c) => c !== right);
    const left = [...others].reverse().find((c) => typeof c.target === 'string') ?? others[0];
    this.request.set({ tab, left: left.target, right: right.target });
  }

  close(): void {
    this.request.set(null);
  }

  /** What the dialog starts with for a tab; `null`: it never compared. */
  recalled(tab: QueryTab): Remembered | null {
    return this.remembered.get(tab.id) ?? null;
  }

  /** Runs the comparison the dialog asks for. `true`: the outcome is on screen. */
  async run(
    tab: QueryTab,
    left: Shown,
    right: Shown,
    choice: CompareChoice,
    names: readonly string[],
  ): Promise<boolean> {
    const all = tab.comparable();
    const l = all.find((c) => c.target === left);
    const r = all.find((c) => c.target === right);
    if (!l || !r) return false;
    this.remembered.set(tab.id, {
      byKey: choice.byKey,
      keys: choice.keys.map((c) => (names[c] ?? '').toLowerCase()),
      ignore: choice.ignore.map((c) => (names[c] ?? '').toLowerCase()),
      trim: choice.trim,
      ignoreCase: choice.ignoreCase,
      round: choice.round,
      decimals: choice.decimals,
    });
    return tab.compare(specOf(l.result.resultId, r.result.resultId, choice), l.title, r.title);
  }

  /**
   * „Run again and compare“: keeps the result on screen, runs its statement again, and compares the old
   * result with the new one – at once the way the tab compared the last time, else the dialog asks.
   */
  async runAgain(): Promise<void> {
    const tab = this.tabs.active();
    if (!tab) return;
    const pair = await tab.runAgainToCompare();
    if (!pair) return;
    const before = this.remembered.get(tab.id);
    if (before) {
      try {
        const pairing = await this.api.compareColumns(
          pair.left.result.resultId,
          pair.right.result.resultId,
        );
        const columns = pair.left.result.columns;
        const index = (name: string) =>
          pairing.pairs.map((p) => p[0]).find((c) => columns[c]?.name.toLowerCase() === name);
        const keys = before.keys.map(index);
        if (!before.byKey || keys.every((k) => k !== undefined)) {
          const choice: CompareChoice = {
            ...before,
            keys: keys.filter((k): k is number => k !== undefined),
            ignore: before.ignore.map(index).filter((k): k is number => k !== undefined),
          };
          await tab.compare(
            specOf(pair.left.result.resultId, pair.right.result.resultId, choice),
            pair.left.title,
            pair.right.title,
          );
          if (tab.compareProblem()) this.tabs.notice.set(tab.compareProblem());
          return;
        }
      } catch {
        // the dialog asks
      }
    }
    this.request.set({ tab, left: pair.left.target, right: pair.right.target });
  }

  /** The keys the dialog proposes (see `suggestKeys`). */
  readonly suggest = suggestKeys;
}
