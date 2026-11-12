import { Injectable } from '@angular/core';
import { call } from '../backend/call';

/** Mirrors `Hint` in src-tauri/src/db/plan.rs. */
export type PlanHint = 'scanFilter' | 'sortOnDisk' | 'misestimate' | 'manyLoops';

/** Mirrors `PlanNode`: one operation of a plan. */
export interface PlanNode {
  readonly op: string;
  readonly object: string;
  readonly detail: string;
  /** Rows the database expected, over all loops. */
  readonly estRows: number | null;
  /** Rows that came (only after an execution). */
  readonly actRows: number | null;
  readonly cost: number | null;
  /** Milliseconds in this node and below, over all loops. */
  readonly timeMs: number | null;
  /** Milliseconds in this node alone. */
  readonly selfMs: number | null;
  readonly loops: number | null;
  readonly buffers: string | null;
  /** Everything else the database said about the node. */
  readonly extra: readonly (readonly [string, string])[];
  readonly hints: readonly PlanHint[];
  readonly children: readonly PlanNode[];
}

/** Mirrors `Plan`. */
export interface Plan {
  readonly nodes: readonly PlanNode[];
  /** The plan as the database gave it. */
  readonly raw: string;
  readonly format: string;
  /** The statement ran. */
  readonly analyzed: boolean;
  readonly totalMs: number | null;
  /** `false`: the format was not understood – only `raw` tells something. */
  readonly known: boolean;
  readonly cut: boolean;
}

/**
 * The plan of one statement (prompt 039). Without `analyze` nothing runs. With it the statement runs –
 * through the guard of the connection, in a transaction the backend rolls back. Rejects with an `AppError`.
 */
export abstract class PlanApi {
  abstract explain(
    connectionId: string,
    sql: string,
    analyze: boolean,
    confirmation: string | null,
    allowDangerous: boolean,
    timeoutMs: number,
  ): Promise<Plan>;
}

@Injectable()
export class TauriPlanApi extends PlanApi {
  explain(
    connectionId: string,
    sql: string,
    analyze: boolean,
    confirmation: string | null,
    allowDangerous: boolean,
    timeoutMs: number,
  ): Promise<Plan> {
    return call('explain_plan', {
      id: connectionId,
      sql,
      analyze,
      confirmation,
      allowDangerous,
      timeoutMs,
    });
  }
}
