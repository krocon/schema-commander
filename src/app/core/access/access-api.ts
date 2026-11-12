import { Injectable } from '@angular/core';
import { call } from '../backend/call';
import { StructRan } from '../structure/structure-api';

/** Mirrors `Who` in src-tauri/src/db/access.rs (prompt 047): a user or role by its name on the server. */
export interface Who {
  readonly name: string;
  /** MySQL: the host of the account; empty everywhere else. */
  readonly host: string;
}

/** Mirrors `Principal`. */
export interface Principal {
  readonly who: Who;
  /** `name` or `name@host`: how memberships name it. */
  readonly label: string;
  /** It can log in (a user); otherwise a role. */
  readonly login: boolean;
  readonly attributes: readonly string[];
  /** The roles it is in, by label. */
  readonly memberOf: readonly string[];
  readonly superuser: boolean;
  /** The user of this connection. */
  readonly me: boolean;
}

export interface AccessMissing {
  readonly part: string;
  readonly reason: string;
}

/** Mirrors `Access`. */
export interface Access {
  readonly principals: readonly Principal[];
  readonly me: string;
  /** Without it nothing can be changed from here. */
  readonly canManage: boolean;
  readonly missing: readonly AccessMissing[];
}

/** Mirrors `Grant`: one right on one thing. */
export interface Grant {
  /** `server`, `database`, `schema`, `table`, `column`, `sequence`, `routine`, `default`. */
  readonly level: string;
  readonly schema: string;
  readonly object: string;
  readonly column: string;
  /** `SELECT` …; `OWNER`; `DENY …` (SQL Server). */
  readonly privilege: string;
  readonly grantable: boolean;
  /** The role it comes through; empty: granted to the principal itself; `PUBLIC`: to everybody. */
  readonly via: string;
}

export interface GrantList {
  readonly grants: readonly Grant[];
  readonly cut: boolean;
  readonly missing: readonly AccessMissing[];
}

/** Mirrors `Change`: what the window asks for. A password is never part of it. */
export type AccessChange =
  | {
      readonly op: 'create';
      readonly who: Who;
      readonly login: boolean;
      readonly password: boolean;
    }
  | { readonly op: 'drop'; readonly who: Who; readonly role: boolean }
  | { readonly op: 'password'; readonly who: Who }
  | {
      readonly op: 'attribute';
      readonly who: Who;
      readonly attribute: string;
      readonly on: boolean;
    }
  | { readonly op: 'member'; readonly role: Who; readonly member: Who; readonly add: boolean }
  | {
      readonly op: 'grant';
      readonly who: Who;
      readonly level: string;
      readonly schema: string;
      readonly object: string;
      readonly column: string;
      readonly privilege: string;
      readonly grantable: boolean;
      readonly add: boolean;
    };

export type AccessDanger = 'superuser' | 'escalation' | 'all' | 'grantOption' | 'lockout' | 'drop';

/** Mirrors `Step`: a statement as it is shown – a password in it is `'***'`. */
export interface AccessStep {
  readonly sql: string;
  readonly dangers: readonly AccessDanger[];
  /** The change it belongs to. */
  readonly change: number;
  readonly secret: boolean;
}

export interface AccessPlan {
  readonly steps: readonly AccessStep[];
  readonly transactional: boolean;
  /** The server never sees a password; otherwise it may log the statement. */
  readonly hidesPassword: boolean;
}

/** Users, roles and their rights (prompt 047). */
export abstract class AccessApi {
  abstract list(connectionId: string): Promise<Access>;
  abstract grants(connectionId: string, who: Who): Promise<GrantList>;
  /** The statements of changes, as they are shown. */
  abstract plan(connectionId: string, changes: readonly AccessChange[]): Promise<AccessPlan>;
  /** The rights a principal holds itself, as `GRANT`s. */
  abstract script(connectionId: string, who: Who): Promise<string>;
  /**
   * Runs the changes; `passwords[i]` belongs to `changes[i]`. The backend writes the statements and lets
   * each pass the guard (`confirmations[i]` for statement `i` of the plan).
   */
  abstract apply(
    connectionId: string,
    changes: readonly AccessChange[],
    passwords: readonly (string | null)[],
    confirmations: readonly (string | null)[],
    allowDangerous: boolean,
  ): Promise<StructRan>;
}

@Injectable()
export class TauriAccessApi extends AccessApi {
  list(connectionId: string): Promise<Access> {
    return call('access_list', { id: connectionId });
  }

  grants(connectionId: string, who: Who): Promise<GrantList> {
    return call('access_grants', { id: connectionId, who });
  }

  plan(connectionId: string, changes: readonly AccessChange[]): Promise<AccessPlan> {
    return call('access_plan', { id: connectionId, changes });
  }

  script(connectionId: string, who: Who): Promise<string> {
    return call('access_script', { id: connectionId, who });
  }

  apply(
    connectionId: string,
    changes: readonly AccessChange[],
    passwords: readonly (string | null)[],
    confirmations: readonly (string | null)[],
    allowDangerous: boolean,
  ): Promise<StructRan> {
    return call('access_apply', {
      id: connectionId,
      changes,
      passwords,
      confirmations,
      allowDangerous,
    });
  }
}
