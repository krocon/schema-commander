import { Injectable, inject, signal } from '@angular/core';
import { SettingsService } from '../../core/settings/settings.service';
import { Dialect } from '../editor/sql-split';
import { ParamValue } from './param-logic';

/** What the dialog is asked: the statements of a run and what is known of their parameters. */
export interface ParamRequest {
  readonly connectionId: string;
  readonly dialect: Dialect;
  readonly sqls: readonly string[];
  /** The values given last in this tab, by key. */
  readonly values: Readonly<Record<string, ParamValue>>;
}

/**
 * Asks for the values of parameters (prompt 025). One question at a time; the dialog answers it. Which
 * forms are parameters is a setting per connection (`paramForms`), changed in the dialog.
 */
@Injectable({ providedIn: 'root' })
export class ParamService {
  private readonly settings = inject(SettingsService);
  readonly request = signal<ParamRequest | null>(null);
  private resolve: ((values: Readonly<Record<string, ParamValue>> | null) => void) | null = null;

  /** Parameters are looked for at all. */
  enabled(): boolean {
    return this.settings.settings().paramsEnabled;
  }

  /** The forms set for a connection; `undefined` = the defaults of its database. */
  forms(connectionId: string): readonly string[] | undefined {
    return this.settings.settings().paramForms[connectionId];
  }

  setForms(connectionId: string, forms: readonly string[] | null): void {
    const all = { ...this.settings.settings().paramForms };
    if (forms === null) delete all[connectionId];
    else all[connectionId] = forms;
    this.settings.update({ paramForms: all });
  }

  /** The values the user gives; `null` = the run is off. A second question while one is open is a no. */
  ask(request: ParamRequest): Promise<Readonly<Record<string, ParamValue>> | null> {
    if (this.resolve) return Promise.resolve(null);
    this.request.set(request);
    return new Promise((resolve) => (this.resolve = resolve));
  }

  answer(values: Readonly<Record<string, ParamValue>> | null): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.request.set(null);
    resolve?.(values);
  }
}
