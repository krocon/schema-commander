import { Injectable, inject } from '@angular/core';
import { describeError } from '../../core/errors/app-error';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { TabsStore } from '../tabs/tabs.store';
import { EMPTY_SPEC, TableView, queryOf, readSpec, tableKey } from './filter-logic';

/**
 * Opens tables as table views (prompt 027): a tab whose `SELECT` the app writes, with the filter and order
 * the table had last. The statement comes from the backend; the tab shows its readable form.
 */
@Injectable({ providedIn: 'root' })
export class TableViews {
  private readonly api = inject(QueryApi);
  private readonly tabs = inject(TabsStore);
  private readonly settings = inject(SettingsService);

  /** `schema` and `table` as the catalog has them (not quoted); `title` names the tab. */
  async open(
    connectionId: string,
    schema: string | null,
    table: string,
    title: string,
  ): Promise<void> {
    const remembered =
      this.settings.settings().tableFilters[tableKey(connectionId, { schema, table })];
    let view: TableView = { schema, table, spec: remembered ? readSpec(remembered) : EMPTY_SPEC };
    let built;
    try {
      built = await this.api.tableQuery(connectionId, queryOf(view));
    } catch {
      // what was remembered does not fit the table any more: the table as it is
      view = { schema, table, spec: EMPTY_SPEC };
      try {
        built = await this.api.tableQuery(connectionId, queryOf(view));
      } catch (e) {
        this.tabs.notice.set(describeError(e));
        return;
      }
    }
    const tab = this.tabs.newTab(built.display, {
      title,
      customTitle: true,
      connection: connectionId,
    });
    await tab.openTable(view, built);
  }
}
