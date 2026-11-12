import { translatable } from '../../core/i18n/i18n';
import { CONNECTION_DE } from './connection-texts.de';

/** Texts of the connection list and of the password dialog (prompts 003, 014). English is the source. */
export const CONNECTION_EN = {
  title: 'Connections',
  newConnection: 'New connection',
  filterLabel: 'Filter connections',
  filter: 'Filter',
  stateOpen: 'connected',
  stateConnecting: 'connecting …',
  stateFailed: 'Error',
  disconnect: 'Disconnect',
  disconnectName: (name: string) => `Disconnect ${name}`,
  connect: 'Connect',
  connectName: (name: string) => `Connect ${name}`,
  edit: 'Edit',
  editName: (name: string) => `Edit ${name}`,
  noMatch: 'No connection matches the filter.',
  /** The databases as the dialogs and the list name them, by `DbKind`. */
  kinds: {
    postgres: 'PostgreSQL',
    mysql: 'MySQL / MariaDB',
    sqlserver: 'SQL Server',
    sqlite: 'SQLite (file)',
    oracle: 'Oracle',
    duckdb: 'DuckDB',
    clickhouse: 'ClickHouse',
    trino: 'Trino / Presto',
    libsql: 'libSQL / Turso',
    d1: 'Cloudflare D1',
    firebird: 'Firebird',
    bigquery: 'BigQuery',
    snowflake: 'Snowflake',
  },
  password: 'Password',
  sshSecretTitle: 'SSH tunnel: password or passphrase',
  loginRejected: 'The login was rejected. Please try again.',
  passwordIsStored: 'After a successful login it is stored in the keychain of the system.',
  passwordNotStored: 'It is not stored.',
};

export const CONNECTION_TEXTS = translatable('connections', CONNECTION_EN, { de: CONNECTION_DE });
