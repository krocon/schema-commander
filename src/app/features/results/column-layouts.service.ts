import { Injectable, inject } from '@angular/core';
import { SettingsService } from '../../core/settings/settings.service';
import { tableKey } from '../filter/filter-logic';
import { QueryTab } from '../tabs/query-tab';
import { ColumnLayout, mergeLayout, rememberLayout } from './column-layout';

/**
 * Where the column layout of a tab lives (prompt 029): a table view has the layout of its table, kept in
 * the settings over a restart; any other tab has one of its own while it lives.
 */
@Injectable({ providedIn: 'root' })
export class ColumnLayouts {
  private readonly settings = inject(SettingsService);

  private keyOf(tab: QueryTab): string | null {
    const view = tab.tableView();
    return view ? tableKey(tab.connectionId(), view) : null;
  }

  /** The layout of the result a tab shows (reads signals: use it in a `computed`). */
  of(tab: QueryTab): ColumnLayout {
    const key = this.keyOf(tab);
    if (key === null) return tab.columnLayout();
    return mergeLayout(this.settings.settings().columnLayouts[key]);
  }

  set(tab: QueryTab, layout: ColumnLayout): void {
    const key = this.keyOf(tab);
    if (key === null) tab.columnLayout.set(layout);
    else
      this.settings.update({
        columnLayouts: rememberLayout(this.settings.settings().columnLayouts, key, layout),
      });
  }
}
