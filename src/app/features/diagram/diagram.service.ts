import { Injectable, inject, signal } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';

/** What a diagram shows: a schema, or a table of it with its neighbours. */
export interface DiagramTarget {
  readonly connectionId: string;
  readonly schema: string;
  readonly table: string | null;
}

/** Opens the ER diagram (prompt 037). */
@Injectable({ providedIn: 'root' })
export class DiagramService {
  private readonly connections = inject(ConnectionsStore);

  /** The target the diagram is open for. */
  readonly request = signal<DiagramTarget | null>(null);

  open(schema: string, table: string | null = null): void {
    this.request.set({ connectionId: this.connections.activeId(), schema, table });
  }

  close(): void {
    this.request.set(null);
  }
}
