import { translatable } from '../../core/i18n/i18n';
import { GUARD_DE } from './guard-texts.de';

/** Texts of the question before guarded statements run (prompt 012). English is the source. */
export const GUARD_EN = {
  /** What a statement does, after its class. */
  classes: {
    read: 'reads',
    write: 'changes data',
    ddl: 'changes the schema',
    dangerous: 'destroys or grants rights',
  },
  /** The protection levels of a connection. */
  protections: {
    free: 'free',
    ask: 'ask',
    readonly: 'read only',
  },
  titleDangerous: (n: number) =>
    n === 1
      ? 'This statement destroys data or changes rights'
      : `${n} statements destroy data or change rights`,
  titleChanging: (n: number) =>
    n === 1 ? 'This statement changes the database' : `${n} statements change the database`,
  badgeReadonly: 'read only',
  badgeProtected: 'protected',
  others: (total: number) => `The run has ${total} statements; the others run without a question.`,
  typeName: 'To confirm, type the name of the connection:',
  run: 'Run',
};

export const GUARD_TEXTS = translatable('guard', GUARD_EN, { de: GUARD_DE });
