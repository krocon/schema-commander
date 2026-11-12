import { Injectable, computed, inject, signal } from '@angular/core';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError, toAppError } from '../../core/errors/app-error';
import { FindApi, FindReport, SourceHit } from '../../core/find/find-api';
import { ObjectDetailsService } from '../details/details.service';
import { TableViews } from '../filter/table-views.service';
import {
  FIND_JOB_BASE,
  NO_RESULTS,
  SearchChoices,
  SearchResults,
  detailOf,
  hitFilter,
  hitsAsTsv,
  specOf,
  withEvent,
} from './server-search-logic';

/** Where a search looks; a table narrows it to that table. */
export interface SearchTarget {
  readonly connectionId: string;
  readonly schema: string | null;
  readonly table: string | null;
}

/**
 * The search on the server as a job (prompt 036): the backend searches, this collects what it tells and
 * opens what a hit leads to. One search at a time.
 */
@Injectable({ providedIn: 'root' })
export class ServerSearchService {
  private readonly api = inject(FindApi);
  private readonly connections = inject(ConnectionsStore);
  private readonly tables = inject(TableViews);
  private readonly details = inject(ObjectDetailsService);
  private readonly clipboard = inject(ClipboardApi);
  private nextId = FIND_JOB_BASE;
  private job: number | null = null;

  /** The target the dialog is open for. */
  readonly request = signal<SearchTarget | null>(null);
  readonly results = signal<SearchResults>(NO_RESULTS);
  readonly running = signal(false);
  readonly report = signal<FindReport | null>(null);
  readonly error = signal<string | null>(null);
  /** The search whose results are shown: what „show rows“ filters by. */
  private searched: SearchChoices | null = null;
  /** Whether the rows of a hit can be shown as a table (not for a regular expression). */
  readonly rowsOpen = signal(true);
  readonly hasHits = computed(
    () => this.results().tables.length > 0 || this.results().sources.length > 0,
  );

  open(schema: string | null = null, table: string | null = null): void {
    if (this.running()) return;
    this.results.set(NO_RESULTS);
    this.report.set(null);
    this.error.set(null);
    this.request.set({ connectionId: this.connections.activeId(), schema, table });
  }

  /** Closes the dialog; a search that runs is stopped. */
  close(): void {
    this.cancel();
    this.request.set(null);
  }

  async start(target: SearchTarget, choices: SearchChoices): Promise<void> {
    if (this.running()) return;
    const id = this.nextId++;
    this.job = id;
    this.searched = choices;
    this.rowsOpen.set(choices.mode !== 'regex');
    this.results.set(NO_RESULTS);
    this.report.set(null);
    this.error.set(null);
    this.running.set(true);
    try {
      const report = await this.api.run(
        id,
        target.connectionId,
        specOf(choices, target.table),
        (event) => {
          // what an older search still tells is not of this one
          if (this.job === id) this.results.update((r) => withEvent(r, event));
        },
      );
      if (this.job === id) this.report.set(report);
    } catch (e) {
      if (this.job === id) this.error.set(describeError(toAppError(e)));
    } finally {
      if (this.job === id) {
        this.running.set(false);
        this.job = null;
      }
    }
  }

  cancel(): void {
    if (this.job !== null && this.running()) void this.api.cancel(this.job);
  }

  /** Opens the table with the rows whose column holds the text. */
  async showRows(
    target: SearchTarget,
    schema: string,
    table: string,
    column: string,
  ): Promise<void> {
    const spec = this.searched ? hitFilter(column, this.searched) : null;
    if (!spec) return;
    this.request.set(null);
    await this.tables.openWith(
      target.connectionId,
      schema === '' ? null : schema,
      table,
      table,
      spec,
    );
  }

  /** Opens the details of the object a definition belongs to. */
  showDefinition(target: SearchTarget, hit: SourceHit): void {
    const object = detailOf(hit);
    if (!object) return;
    this.request.set(null);
    this.details.open({
      connectionId: target.connectionId,
      schema: hit.schema,
      name: object.name,
      kind: object.kind,
      detail: '',
    });
  }

  async copyHits(): Promise<boolean> {
    try {
      await this.clipboard.copyText(hitsAsTsv(this.results()));
      return true;
    } catch {
      return false;
    }
  }
}
