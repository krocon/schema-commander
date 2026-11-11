import { Injectable, inject } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { MAX_RECENT_OBJECTS } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { ObjectDetailsService } from '../details/details.service';
import { selectTemplate } from '../schema/schema-logic';
import { TableViews } from '../filter/table-views.service';
import { SavedStore } from '../saved/saved.store';
import { SchemaStore } from '../schema/schema.store';
import { TabsStore } from '../tabs/tabs.store';
import { GotoHit, GotoVariant, allowsVariant, recentKey } from './goto-logic';
import { pushRecent } from './palette-logic';

/**
 * Does what a hit of „go to anything“ (prompt 020) asks for. Runs after the dialog is gone, so the editor
 * has the focus again when a name is put into it.
 */
@Injectable({ providedIn: 'root' })
export class GotoService {
  private readonly tabs = inject(TabsStore);
  private readonly connections = inject(ConnectionsStore);
  private readonly details = inject(ObjectDetailsService);
  private readonly schema = inject(SchemaStore);
  private readonly settings = inject(SettingsService);
  private readonly saved = inject(SavedStore);
  private readonly tables = inject(TableViews);

  async run(hit: GotoHit, wanted: GotoVariant, connectionId: string): Promise<void> {
    if (hit.kind === 'tab' && hit.id) {
      this.tabs.activate(hit.id);
      setTimeout(() => this.tabs.active()?.focus(), 50);
      return;
    }
    if (hit.kind === 'connection' && hit.id) {
      this.connections.activate(hit.id);
      return;
    }
    if (hit.kind === 'saved' && hit.id) {
      const entry = this.saved.entries().find((e) => e.id === hit.id);
      if (!entry) return;
      if (wanted === 'insert') await this.saved.insert(entry);
      else if (wanted === 'select') await this.saved.run(entry);
      else await this.saved.open(entry);
      return;
    }
    const object = hit.object;
    if (!object) return;
    this.settings.update({
      recentObjects: pushRecent(
        this.settings.settings().recentObjects,
        recentKey(object),
        MAX_RECENT_OBJECTS,
      ),
    });
    const relation = object.kind === 'table' || object.kind === 'view' || object.kind === 'matview';
    // the usual thing: the data of a table, the definition of the rest, the name of a column
    const variant: GotoVariant =
      wanted !== 'default' && allowsVariant(hit, wanted)
        ? wanted
        : relation
          ? 'default'
          : object.kind === 'column'
            ? 'insert'
            : 'details';
    const dialect =
      this.connections.profiles().find((p) => p.id === connectionId)?.kind ?? 'sqlite';
    switch (variant) {
      case 'default': {
        await this.tables.open(connectionId, object.schema || null, object.name, object.name);
        return;
      }
      case 'details':
        if (object.kind === 'column') return;
        this.details.open({
          connectionId,
          schema: object.schema,
          name: object.name,
          kind: object.kind,
          detail: object.kind === 'routine' ? object.detail : '',
        });
        return;
      case 'insert':
        this.tabs.active()?.insert(object.quoted);
        return;
      case 'select':
        this.tabs.active()?.insert(selectTemplate(dialect, object.quoted));
        return;
      case 'tree':
        // the tree shows what its filter finds: the object (or the table of a column) stands alone there
        this.settings.update({ sidebarVisible: true, sidebarView: 'database' });
        this.schema.setFilter(object.kind === 'column' ? (object.parent ?? '') : object.name);
        return;
    }
  }
}
