//! Users, roles and their rights (prompt 047): who there is, what each may do – directly and through the
//! roles it is in –, and the statements that change it.
//!
//! Reading asks the catalog of each database with statements written here; a part the user may not see
//! is left out and named. Changing: the window sends **changes** (never SQL), [`plan`] writes one
//! statement or two for each – names quoted here, privileges only from the lists below – and says what is
//! dangerous. A password is no part of a change: it comes beside it, stands in the statement only when it
//! runs ([`statements`]) and as `'***'` in everything that is shown. PostgreSQL gets a SCRAM verifier
//! instead of the password, so the server never sees it and cannot log it.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::secrets::Secret;
use super::{DbKind, Flavor, Session, Stop, TextRows, meta};
use crate::error::{AppError, AppResult, ErrorCode};

const TIMEOUT: Duration = Duration::from_secs(15);
/// Rights of one principal shown at most.
pub const MAX_GRANTS: usize = 5_000;
/// What stands for a password wherever a statement is shown.
pub const MASK: &str = "'***'";

/// A user or a role, by the name the server knows it by.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Who {
    pub name: String,
    /// MySQL: the host of the account (`%`); empty for a role of MariaDB and everywhere else.
    #[serde(default)]
    pub host: String,
}

impl Who {
    pub fn new(name: &str, host: &str) -> Self {
        Who {
            name: name.to_owned(),
            host: host.to_owned(),
        }
    }

    /// `name`, or `name@host`: how memberships and the window name it.
    pub fn label(&self) -> String {
        if self.host.is_empty() {
            self.name.clone()
        } else {
            format!("{}@{}", self.name, self.host)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Principal {
    pub who: Who,
    pub label: String,
    /// It can log in (a user); otherwise a role.
    pub login: bool,
    /// What it is beyond its rights, in the words of the server (`superuser`, `createdb`, `locked`).
    pub attributes: Vec<String>,
    /// The roles it is in, by label.
    pub member_of: Vec<String>,
    /// It may do everything (superuser, `db_owner`, `SUPER`).
    pub superuser: bool,
    /// The user of this connection.
    pub me: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Missing {
    pub part: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    pub principals: Vec<Principal>,
    /// The label of the user of this connection.
    pub me: String,
    /// The user may create users and roles: without it, nothing can be changed from here.
    pub can_manage: bool,
    pub missing: Vec<Missing>,
}

/// One right on one thing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    /// `server`, `database`, `schema`, `table`, `column`, `sequence`, `routine`, `default`.
    pub level: String,
    pub schema: String,
    pub object: String,
    pub column: String,
    /// `SELECT` …; `OWNER` for what it owns; `DENY …` where SQL Server forbids.
    pub privilege: String,
    pub grantable: bool,
    /// The role the right comes through; empty: granted to the principal itself. `PUBLIC`: to everybody.
    pub via: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GrantList {
    pub grants: Vec<Grant>,
    pub cut: bool,
    pub missing: Vec<Missing>,
}

fn unsupported() -> AppError {
    AppError::new(
        ErrorCode::Unsupported,
        "this database has no users and roles",
    )
}

fn text(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

fn yes(row: &[Option<String>], i: usize) -> bool {
    matches!(
        text(row, i).to_ascii_lowercase().as_str(),
        "true" | "t" | "y" | "yes" | "1"
    )
}

fn lines(row: &[Option<String>], i: usize) -> Vec<String> {
    text(row, i)
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

fn asked(s: &mut dyn Session, sql: &str, params: &[&str], stop: Stop) -> AppResult<TextRows> {
    s.ask(sql, params, Some(TIMEOUT), stop)
}

fn miss(missing: &mut Vec<Missing>, part: &str, e: &AppError) {
    missing.push(Missing {
        part: part.to_owned(),
        reason: super::clean(&e.message),
    });
}

// ── reading: who there is ───────────────────────────────────────────────────────────────────

const PG_ROLES: &str = "SELECT r.rolname::text, r.rolcanlogin::text, r.rolsuper::text, \
     r.rolcreatedb::text, r.rolcreaterole::text, r.rolreplication::text, \
     COALESCE((SELECT string_agg(g.rolname::text, E'\\n' ORDER BY g.rolname) \
               FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid), ''), \
     (r.rolname = current_user)::text \
     FROM pg_roles r WHERE r.rolname !~ '^pg_' ORDER BY r.rolname";

const MS_PRINCIPALS: &str = "SELECT p.name, CASE WHEN p.type = 'R' THEN 'false' ELSE 'true' END, \
     p.type_desc COLLATE DATABASE_DEFAULT, CASE WHEN p.is_fixed_role = 1 THEN 'true' ELSE 'false' END, \
     ISNULL((SELECT STRING_AGG(CAST(r.name AS nvarchar(max)), CHAR(10)) \
             FROM sys.database_role_members m \
             JOIN sys.database_principals r ON r.principal_id = m.role_principal_id \
             WHERE m.member_principal_id = p.principal_id), ''), \
     CASE WHEN p.name = USER_NAME() THEN 'true' ELSE 'false' END \
     FROM sys.database_principals p \
     WHERE p.type IN ('S', 'U', 'G', 'R', 'E', 'X') \
       AND p.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest', 'public') \
     ORDER BY p.name";

/// The users and roles the connection can see.
pub fn principals(s: &mut dyn Session, kind: DbKind, stop: Stop) -> AppResult<Access> {
    let mut out = Access::default();
    match kind {
        DbKind::Sqlite => return Err(unsupported()),
        DbKind::Oracle => return Err(super::not_yet(kind, "users and rights")),
        DbKind::Duckdb => return Err(unsupported()),
        DbKind::Clickhouse => return Err(super::not_yet(kind, "users and rights")),
        DbKind::Postgres => {
            for row in asked(s, PG_ROLES, &[], stop)? {
                let mut attributes = Vec::new();
                for (i, name) in [
                    (2, "superuser"),
                    (3, "createdb"),
                    (4, "createrole"),
                    (5, "replication"),
                ] {
                    if yes(&row, i) {
                        attributes.push(name.to_owned());
                    }
                }
                let who = Who::new(&text(&row, 0), "");
                if yes(&row, 7) {
                    out.me = who.label();
                }
                out.principals.push(Principal {
                    label: who.label(),
                    who,
                    login: yes(&row, 1),
                    attributes,
                    member_of: lines(&row, 6),
                    superuser: yes(&row, 2),
                    me: yes(&row, 7),
                });
            }
            let can = asked(
                s,
                "SELECT (rolsuper OR rolcreaterole)::text FROM pg_roles WHERE rolname = current_user",
                &[],
                stop,
            );
            out.can_manage = matches!(can, Ok(rows) if rows.first().is_some_and(|r| yes(r, 0)));
        }
        DbKind::Mysql => mysql_principals(s, &mut out, stop)?,
        DbKind::Sqlserver => {
            for row in asked(s, MS_PRINCIPALS, &[], stop)? {
                let who = Who::new(&text(&row, 0), "");
                let member_of = lines(&row, 4);
                let mut attributes = vec![text(&row, 2).to_ascii_lowercase().replace('_', " ")];
                if yes(&row, 3) {
                    attributes.push("fixed role".to_owned());
                }
                let superuser = who.name == "dbo" || member_of.iter().any(|r| r == "db_owner");
                if yes(&row, 5) {
                    out.me = who.label();
                }
                out.principals.push(Principal {
                    label: who.label(),
                    who,
                    login: yes(&row, 1),
                    attributes,
                    member_of,
                    superuser,
                    me: yes(&row, 5),
                });
            }
            let can = asked(
                s,
                "SELECT CASE WHEN IS_ROLEMEMBER('db_owner') = 1 OR IS_ROLEMEMBER('db_securityadmin') = 1 \
                 OR IS_SRVROLEMEMBER('sysadmin') = 1 THEN 'true' ELSE 'false' END",
                &[],
                stop,
            );
            out.can_manage = matches!(can, Ok(rows) if rows.first().is_some_and(|r| yes(r, 0)));
        }
    }
    Ok(out)
}

/// MariaDB behind the MySQL protocol: the session does not know, the version of the server says it.
fn is_maria(s: &mut dyn Session, stop: Stop) -> bool {
    s.server_version(stop)
        .is_ok_and(|v| v.to_lowercase().contains("mariadb"))
}

/// `user@host` as `CURRENT_USER()` says it, split at the last `@`.
fn split_account(account: &str) -> Who {
    match account.rsplit_once('@') {
        Some((name, host)) => Who::new(name, host),
        None => Who::new(account, ""),
    }
}

/// The memberships of MySQL (`role_edges`) or MariaDB (`roles_mapping`): member → roles.
fn mysql_memberships(
    s: &mut dyn Session,
    maria: bool,
    stop: Stop,
) -> AppResult<HashMap<String, Vec<Who>>> {
    let sql = if maria {
        "SELECT User, Host, Role, '' FROM mysql.roles_mapping"
    } else {
        "SELECT TO_USER, TO_HOST, FROM_USER, FROM_HOST FROM mysql.role_edges"
    };
    let mut out: HashMap<String, Vec<Who>> = HashMap::new();
    for row in asked(s, sql, &[], stop)? {
        let member = Who::new(&text(&row, 0), &text(&row, 1));
        out.entry(member.label())
            .or_default()
            .push(Who::new(&text(&row, 2), &text(&row, 3)));
    }
    Ok(out)
}

fn mysql_principals(s: &mut dyn Session, out: &mut Access, stop: Stop) -> AppResult<()> {
    let maria = is_maria(s, stop);
    let me = asked(s, "SELECT CURRENT_USER()", &[], stop)?
        .first()
        .map(|r| split_account(&text(r, 0)))
        .unwrap_or_default();
    out.me = me.label();
    // columns: user, host, a role, locked, may do everything
    let sql = if maria {
        "SELECT User, Host, IF(is_role = 'Y', 'true', 'false'), 'false', \
         IF(Super_priv = 'Y', 'true', 'false') FROM mysql.user ORDER BY User, Host"
    } else {
        "SELECT User, Host, \
         IF(account_locked = 'Y' AND password_expired = 'Y' AND IFNULL(authentication_string, '') = '', 'true', 'false'), \
         IF(account_locked = 'Y', 'true', 'false'), IF(Super_priv = 'Y', 'true', 'false') \
         FROM mysql.user ORDER BY User, Host"
    };
    let members = match mysql_memberships(s, maria, stop) {
        Ok(m) => m,
        Err(e) => {
            miss(&mut out.missing, "memberships", &e);
            HashMap::new()
        }
    };
    let roles_of = |who: &Who| -> Vec<String> {
        let mut roles: Vec<String> = members
            .get(&who.label())
            .map(|r| r.iter().map(Who::label).collect())
            .unwrap_or_default();
        roles.sort();
        roles
    };
    match asked(s, sql, &[], stop) {
        Ok(rows) => {
            for row in rows {
                let who = Who::new(&text(&row, 0), &text(&row, 1));
                let role = yes(&row, 2);
                let mut attributes = Vec::new();
                if yes(&row, 3) && !role {
                    attributes.push("locked".to_owned());
                }
                if yes(&row, 4) {
                    attributes.push("super".to_owned());
                }
                out.principals.push(Principal {
                    label: who.label(),
                    login: !role,
                    attributes,
                    member_of: roles_of(&who),
                    superuser: yes(&row, 4),
                    me: who == me,
                    who,
                });
            }
        }
        Err(e) => {
            // without the right to read `mysql.user` there is still the user itself
            miss(&mut out.missing, "principals", &e);
            out.principals.push(Principal {
                label: me.label(),
                login: true,
                member_of: roles_of(&me),
                me: true,
                who: me.clone(),
                ..Principal::default()
            });
        }
    }
    let grantee = mysql_grantee(&me);
    let can = asked(
        s,
        "SELECT 'yes' FROM information_schema.USER_PRIVILEGES \
         WHERE PRIVILEGE_TYPE = 'CREATE USER' AND GRANTEE = ? LIMIT 1",
        &[&grantee],
        stop,
    );
    out.can_manage = matches!(can, Ok(rows) if !rows.is_empty());
    Ok(())
}

/// A grantee as `information_schema` writes it: `'user'@'host'`.
fn mysql_grantee(who: &Who) -> String {
    format!("'{}'@'{}'", who.name, who.host)
}

// ── reading: what one may do ────────────────────────────────────────────────────────────────

const PG_OWN: &str = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'";

fn pg_grants_sql() -> String {
    format!(
        "WITH RECURSIVE mine(oid, via) AS ( \
           SELECT r.oid, ''::text FROM pg_roles r WHERE r.rolname = $1 \
           UNION \
           SELECT m.roleid, g.rolname::text COLLATE \"default\" FROM pg_auth_members m \
             JOIN mine ON m.member = mine.oid JOIN pg_roles g ON g.oid = m.roleid \
         ), who(oid, via) AS (SELECT oid, via FROM mine UNION ALL SELECT 0::oid, 'PUBLIC'), \
         acl(level, schema, object, col, grantee, privilege, grantable) AS ( \
           SELECT 'database', '', d.datname::text, '', a.grantee, a.privilege_type::text, a.is_grantable \
             FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = current_database() \
           UNION ALL \
           SELECT 'schema', '', n.nspname::text, '', a.grantee, a.privilege_type::text, a.is_grantable \
             FROM pg_namespace n, aclexplode(n.nspacl) a WHERE {own} \
           UNION ALL \
           SELECT CASE WHEN c.relkind = 'S' THEN 'sequence' ELSE 'table' END, n.nspname::text, \
                  c.relname::text, '', a.grantee, a.privilege_type::text, a.is_grantable \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a \
             WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S') AND {own} \
           UNION ALL \
           SELECT 'column', n.nspname::text, c.relname::text, t.attname::text, a.grantee, \
                  a.privilege_type::text, a.is_grantable \
             FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(t.attacl) a \
             WHERE t.attnum > 0 AND NOT t.attisdropped AND {own} \
           UNION ALL \
           SELECT 'routine', n.nspname::text, \
                  p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')', '', \
                  a.grantee, a.privilege_type::text, a.is_grantable \
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) a \
             WHERE {own} \
           UNION ALL \
           SELECT 'default', COALESCE(n.nspname::text, ''), \
                  CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences' \
                    WHEN 'f' THEN 'functions' WHEN 'T' THEN 'types' ELSE 'schemas' END, '', \
                  a.grantee, a.privilege_type::text, a.is_grantable \
             FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace, \
                  aclexplode(d.defaclacl) a \
           UNION ALL \
           SELECT CASE WHEN c.relkind = 'S' THEN 'sequence' ELSE 'table' END, n.nspname::text, \
                  c.relname::text, '', c.relowner, 'OWNER', true \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S') AND {own} \
           UNION ALL \
           SELECT 'schema', '', n.nspname::text, '', n.nspowner, 'OWNER', true \
             FROM pg_namespace n WHERE {own} \
         ) \
         SELECT acl.level, acl.schema, acl.object, acl.col, acl.privilege, acl.grantable::text, who.via \
         FROM acl JOIN who ON who.oid = acl.grantee \
         ORDER BY 1, 2, 3, 4, 5, 7 LIMIT {limit}",
        own = PG_OWN,
        limit = MAX_GRANTS + 1
    )
}

/// CockroachDB has no `aclexplode`: what `information_schema` says about tables.
const COCKROACH_GRANTS: &str = "SELECT 'table', table_schema::text, table_name::text, '', \
     privilege_type::text, lower(is_grantable::text), \
     CASE WHEN grantee = $1 THEN '' ELSE grantee::text END \
     FROM information_schema.table_privileges \
     WHERE grantee IN ($1, 'public') AND table_schema NOT IN ('pg_catalog', 'information_schema', 'crdb_internal', 'pg_extension') \
     ORDER BY 2, 3, 5 LIMIT 5001";

const MYSQL_GRANTS: &str = "SELECT 'server', '', '', '', PRIVILEGE_TYPE, IS_GRANTABLE \
       FROM information_schema.USER_PRIVILEGES WHERE GRANTEE IN (?, ?) AND PRIVILEGE_TYPE <> 'USAGE' \
     UNION ALL \
     SELECT 'schema', '', TABLE_SCHEMA, '', PRIVILEGE_TYPE, IS_GRANTABLE \
       FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE IN (?, ?) \
     UNION ALL \
     SELECT 'table', TABLE_SCHEMA, TABLE_NAME, '', PRIVILEGE_TYPE, IS_GRANTABLE \
       FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE IN (?, ?) \
     UNION ALL \
     SELECT 'column', TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, PRIVILEGE_TYPE, IS_GRANTABLE \
       FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE IN (?, ?)";

const MS_GRANTS: &str = "WITH mine(id, via) AS ( \
       SELECT p.principal_id, CAST('' AS nvarchar(128)) FROM sys.database_principals p WHERE p.name = @P1 \
       UNION ALL \
       SELECT m.role_principal_id, CAST(r.name AS nvarchar(128)) FROM sys.database_role_members m \
         JOIN mine ON m.member_principal_id = mine.id \
         JOIN sys.database_principals r ON r.principal_id = m.role_principal_id \
     ), who(id, via) AS (SELECT id, via FROM mine UNION SELECT 0, CAST('PUBLIC' AS nvarchar(128))) \
     SELECT TOP 5001 \
       CASE WHEN dp.class = 0 THEN 'database' WHEN dp.class = 3 THEN 'schema' \
            WHEN dp.minor_id > 0 THEN 'column' ELSE 'table' END, \
       CASE WHEN dp.class = 1 THEN ISNULL(OBJECT_SCHEMA_NAME(dp.major_id), '') ELSE '' END, \
       CASE WHEN dp.class = 0 THEN DB_NAME() WHEN dp.class = 3 THEN ISNULL(SCHEMA_NAME(dp.major_id), '') \
            ELSE ISNULL(OBJECT_NAME(dp.major_id), '') END, \
       CASE WHEN dp.class = 1 AND dp.minor_id > 0 THEN ISNULL(COL_NAME(dp.major_id, dp.minor_id), '') ELSE '' END, \
       CASE WHEN dp.state = 'D' THEN 'DENY ' ELSE '' END + dp.permission_name COLLATE DATABASE_DEFAULT, \
       CASE WHEN dp.state = 'W' THEN 'true' ELSE 'false' END, \
       who.via \
     FROM sys.database_permissions dp JOIN who ON who.id = dp.grantee_principal_id \
     WHERE dp.class IN (0, 1, 3) \
     ORDER BY 1, 2, 3, 4, 5";

fn grant_of(row: &[Option<String>], via: Option<&str>) -> Grant {
    Grant {
        level: text(row, 0),
        schema: text(row, 1),
        object: text(row, 2),
        column: text(row, 3),
        privilege: text(row, 4),
        grantable: yes(row, 5),
        via: via.map(str::to_owned).unwrap_or_else(|| text(row, 6)),
    }
}

/// What a principal may do: granted to itself, and through every role it is in (with the role named).
pub fn grants(s: &mut dyn Session, kind: DbKind, who: &Who, stop: Stop) -> AppResult<GrantList> {
    let mut out = GrantList::default();
    match kind {
        DbKind::Sqlite => return Err(unsupported()),
        DbKind::Oracle => return Err(super::not_yet(kind, "users and rights")),
        DbKind::Duckdb => return Err(unsupported()),
        DbKind::Clickhouse => return Err(super::not_yet(kind, "users and rights")),
        DbKind::Postgres => {
            let cockroach = s.flavor() == Flavor::Cockroach;
            let sql = if cockroach {
                COCKROACH_GRANTS.to_owned()
            } else {
                pg_grants_sql()
            };
            let rows = asked(s, &sql, &[&who.name], stop)?;
            out.grants = rows.iter().map(|r| grant_of(r, None)).collect();
            if cockroach {
                out.missing.push(Missing {
                    part: "grants".to_owned(),
                    reason: "CockroachDB: only the rights on tables are read".to_owned(),
                });
            }
        }
        DbKind::Sqlserver => {
            let rows = asked(s, MS_GRANTS, &[&who.name], stop)?;
            out.grants = rows.iter().map(|r| grant_of(r, None)).collect();
        }
        DbKind::Mysql => {
            let maria = is_maria(s, stop);
            // the principal itself, then every role it is in – however deep
            let members = match mysql_memberships(s, maria, stop) {
                Ok(m) => m,
                Err(e) => {
                    miss(&mut out.missing, "memberships", &e);
                    HashMap::new()
                }
            };
            let mut seen: BTreeSet<String> = BTreeSet::new();
            let mut queue = vec![(who.clone(), String::new())];
            while let Some((holder, via)) = queue.pop() {
                if !seen.insert(holder.label()) {
                    continue;
                }
                let full = mysql_grantee(&holder);
                // MariaDB writes a role without its (empty) host
                let short = format!("'{}'", holder.name);
                let p = [full.as_str(), short.as_str()];
                let params = [p[0], p[1], p[0], p[1], p[0], p[1], p[0], p[1]];
                let rows = asked(s, MYSQL_GRANTS, &params, stop)?;
                out.grants
                    .extend(rows.iter().map(|r| grant_of(r, Some(&via))));
                for role in members.get(&holder.label()).into_iter().flatten() {
                    queue.push((role.clone(), role.label()));
                }
            }
            out.grants.sort_by(|a, b| {
                (
                    &a.level,
                    &a.schema,
                    &a.object,
                    &a.column,
                    &a.privilege,
                    &a.via,
                )
                    .cmp(&(
                        &b.level,
                        &b.schema,
                        &b.object,
                        &b.column,
                        &b.privilege,
                        &b.via,
                    ))
            });
        }
    }
    if out.grants.len() > MAX_GRANTS {
        out.grants.truncate(MAX_GRANTS);
        out.cut = true;
    }
    Ok(out)
}

// ── changing ────────────────────────────────────────────────────────────────────────────────

/// What the window asks for. A password is never in here: it comes beside the change it belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Change {
    /// A user (`login`) or a role; `password`: one comes with it.
    Create {
        who: Who,
        login: bool,
        password: bool,
    },
    Drop {
        who: Who,
        role: bool,
    },
    Password {
        who: Who,
    },
    /// PostgreSQL: `superuser`, `createdb`, `createrole`, `login`, `replication`.
    Attribute {
        who: Who,
        attribute: String,
        on: bool,
    },
    Member {
        role: Who,
        member: Who,
        add: bool,
    },
    Grant {
        who: Who,
        level: String,
        #[serde(default)]
        schema: String,
        #[serde(default)]
        object: String,
        #[serde(default)]
        column: String,
        privilege: String,
        #[serde(default)]
        grantable: bool,
        add: bool,
    },
}

/// A statement of a plan, as it is shown: a password in it is `'***'`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub sql: String,
    /// Why it is dangerous: `superuser`, `escalation`, `all`, `grantOption`, `lockout`, `drop`.
    pub dangers: Vec<String>,
    /// The change it belongs to.
    pub change: usize,
    /// It carries a password when it runs.
    pub secret: bool,
}

/// What the plan is written for.
#[derive(Debug, Clone, Default)]
pub struct Context {
    pub flavor: Flavor,
    /// The user of the connection and the roles it is in, by label: taking from them may lock it out.
    pub mine: Vec<String>,
    /// MySQL: a backslash in a literal is an escape (not with `NO_BACKSLASH_ESCAPES`).
    pub backslash_escapes: bool,
    /// Roles that may do everything or make roles, by label: being put into one gives that.
    pub powerful: Vec<String>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidQuery, message)
}

/// A name that can be a name: not empty, not endless, no control character.
fn named(name: &str, what: &str) -> AppResult<()> {
    if name.is_empty() || name.chars().count() > 128 || name.chars().any(char::is_control) {
        return Err(invalid(format!("this is not a name of a {what}")));
    }
    Ok(())
}

/// A text literal of MySQL, whatever `sql_mode` says about the backslash.
fn mysql_text(text: &str, backslash_escapes: bool) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('\'');
    for c in text.chars() {
        match c {
            '\'' => out.push_str("''"),
            '\\' if backslash_escapes => out.push_str("\\\\"),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// A text literal of PostgreSQL or SQL Server: only the quote counts.
fn plain_text(text: &str, kind: DbKind) -> String {
    let n = if kind == DbKind::Sqlserver { "N" } else { "" };
    format!("{n}'{}'", text.replace('\'', "''"))
}

/// A principal as a statement names it.
fn account(kind: DbKind, who: &Who, cx: &Context) -> AppResult<String> {
    named(&who.name, "user or role")?;
    Ok(match kind {
        DbKind::Mysql => {
            if who.host.chars().count() > 255 || who.host.chars().any(char::is_control) {
                return Err(invalid("this is not a host"));
            }
            let name = mysql_text(&who.name, cx.backslash_escapes);
            if who.host.is_empty() {
                name
            } else {
                format!("{name}@{}", mysql_text(&who.host, cx.backslash_escapes))
            }
        }
        _ => meta::quote_always(&who.name, kind),
    })
}

const PG_ATTRIBUTES: &[&str] = &[
    "superuser",
    "createdb",
    "createrole",
    "login",
    "replication",
];

/// The privileges that can be granted from here, by database and level.
pub fn privileges(kind: DbKind, level: &str) -> &'static [&'static str] {
    match (kind, level) {
        (DbKind::Postgres, "database") => &["CONNECT", "CREATE", "TEMPORARY", "ALL"],
        (DbKind::Postgres, "schema") => &["USAGE", "CREATE", "ALL"],
        (DbKind::Postgres, "table") => &[
            "SELECT",
            "INSERT",
            "UPDATE",
            "DELETE",
            "TRUNCATE",
            "REFERENCES",
            "TRIGGER",
            "ALL",
        ],
        (DbKind::Postgres, "column") => &["SELECT", "INSERT", "UPDATE", "REFERENCES"],
        (DbKind::Postgres, "sequence") => &["USAGE", "SELECT", "UPDATE", "ALL"],
        (DbKind::Mysql, "server") => &[
            "SELECT",
            "INSERT",
            "UPDATE",
            "DELETE",
            "CREATE",
            "DROP",
            "ALTER",
            "INDEX",
            "REFERENCES",
            "CREATE VIEW",
            "SHOW VIEW",
            "TRIGGER",
            "EXECUTE",
            "CREATE USER",
            "PROCESS",
            "RELOAD",
            "SHOW DATABASES",
            "ALL",
        ],
        (DbKind::Mysql, "schema") => &[
            "SELECT",
            "INSERT",
            "UPDATE",
            "DELETE",
            "CREATE",
            "DROP",
            "ALTER",
            "INDEX",
            "REFERENCES",
            "CREATE VIEW",
            "SHOW VIEW",
            "TRIGGER",
            "EXECUTE",
            "ALL",
        ],
        (DbKind::Mysql, "table") => &[
            "SELECT",
            "INSERT",
            "UPDATE",
            "DELETE",
            "CREATE",
            "DROP",
            "ALTER",
            "INDEX",
            "REFERENCES",
            "CREATE VIEW",
            "SHOW VIEW",
            "TRIGGER",
            "ALL",
        ],
        (DbKind::Mysql, "column") => &["SELECT", "INSERT", "UPDATE", "REFERENCES"],
        (DbKind::Sqlserver, "database") => &[
            "CONNECT",
            "SELECT",
            "INSERT",
            "UPDATE",
            "DELETE",
            "EXECUTE",
            "CREATE TABLE",
            "CREATE VIEW",
            "CREATE PROCEDURE",
            "ALTER",
            "VIEW DEFINITION",
            "CONTROL",
        ],
        (DbKind::Sqlserver, "schema" | "table") => &[
            "SELECT",
            "INSERT",
            "UPDATE",
            "DELETE",
            "EXECUTE",
            "REFERENCES",
            "ALTER",
            "VIEW DEFINITION",
            "CONTROL",
        ],
        (DbKind::Sqlserver, "column") => &["SELECT", "UPDATE", "REFERENCES"],
        _ => &[],
    }
}

/// `ON …` of a grant, and the column list that stands before it (PostgreSQL, MySQL) or after it
/// (SQL Server).
fn target(
    kind: DbKind,
    level: &str,
    schema: &str,
    object: &str,
    column: &str,
) -> AppResult<(String, String)> {
    let q = |name: &str, what: &str| -> AppResult<String> {
        named(name, what)?;
        Ok(meta::quote_always(name, kind))
    };
    let columns = if level == "column" {
        format!(" ({})", q(column, "column")?)
    } else {
        String::new()
    };
    let on = match (kind, level) {
        (DbKind::Postgres, "database") => format!("ON DATABASE {}", q(object, "database")?),
        (DbKind::Postgres, "schema") => format!("ON SCHEMA {}", q(object, "schema")?),
        (DbKind::Postgres, "table" | "column") => {
            format!("ON TABLE {}.{}", q(schema, "schema")?, q(object, "table")?)
        }
        (DbKind::Postgres, "sequence") => format!(
            "ON SEQUENCE {}.{}",
            q(schema, "schema")?,
            q(object, "sequence")?
        ),
        (DbKind::Mysql, "server") => "ON *.*".to_owned(),
        (DbKind::Mysql, "schema") => format!("ON {}.*", q(object, "database")?),
        (DbKind::Mysql, "table" | "column") => {
            format!("ON {}.{}", q(schema, "database")?, q(object, "table")?)
        }
        (DbKind::Sqlserver, "database") => String::new(),
        (DbKind::Sqlserver, "schema") => format!("ON SCHEMA::{}", q(object, "schema")?),
        (DbKind::Sqlserver, "table" | "column") => format!(
            "ON OBJECT::{}.{}",
            q(schema, "schema")?,
            q(object, "object")?
        ),
        _ => return Err(invalid("rights on this cannot be changed from here")),
    };
    Ok((on, columns))
}

/// The statements of one change. `password` writes the literal of a password: the mask for what is
/// shown, the real thing only for what runs.
fn written(
    kind: DbKind,
    change: &Change,
    cx: &Context,
    password: &dyn Fn() -> AppResult<String>,
) -> AppResult<Vec<(String, Vec<&'static str>, bool)>> {
    // names of roles are compared without case: SQL Server and MySQL hosts do not mind it either
    let mine = |who: &Who| {
        let label = who.label().to_lowercase();
        label == "public" || cx.mine.iter().any(|m| m.to_lowercase() == label)
    };
    let powerful = |who: &Who| {
        let label = who.label().to_lowercase();
        cx.powerful.iter().any(|m| m.to_lowercase() == label)
            || who.name.starts_with("pg_")
            || matches!(
                who.name.as_str(),
                "db_owner" | "db_securityadmin" | "db_accessadmin" | "sysadmin" | "securityadmin"
            )
    };
    let mut out = Vec::new();
    match change {
        Change::Create {
            who,
            login,
            password: with,
        } => {
            let name = account(kind, who, cx)?;
            if *with && !*login {
                return Err(invalid("a role has no password"));
            }
            match kind {
                DbKind::Postgres => {
                    let mut sql = format!("CREATE ROLE {name}");
                    if *login {
                        sql.push_str(" LOGIN");
                    }
                    if *with {
                        sql.push_str(&format!(" PASSWORD {}", password()?));
                    }
                    out.push((sql, vec![], *with));
                }
                DbKind::Mysql => {
                    let sql = match (*login, *with) {
                        (false, _) => format!("CREATE ROLE {name}"),
                        (true, true) => format!("CREATE USER {name} IDENTIFIED BY {}", password()?),
                        (true, false) => format!("CREATE USER {name}"),
                    };
                    out.push((sql, vec![], *with));
                }
                DbKind::Sqlserver => {
                    if !*login {
                        out.push((format!("CREATE ROLE {name}"), vec![], false));
                    } else {
                        if *with {
                            out.push((
                                format!("CREATE LOGIN {name} WITH PASSWORD = {}", password()?),
                                vec![],
                                true,
                            ));
                        }
                        out.push((
                            format!("CREATE USER {name} FOR LOGIN {name}"),
                            vec![],
                            false,
                        ));
                    }
                }
                DbKind::Sqlite => return Err(unsupported()),
                DbKind::Oracle => return Err(super::not_yet(kind, "users and rights")),
                DbKind::Duckdb => return Err(unsupported()),
                DbKind::Clickhouse => return Err(super::not_yet(kind, "users and rights")),
            }
        }
        Change::Drop { who, role } => {
            let name = account(kind, who, cx)?;
            let word = match (kind, *role) {
                (DbKind::Postgres, _) | (_, true) => "ROLE",
                _ => "USER",
            };
            let mut dangers = vec!["drop"];
            if mine(who) {
                dangers.push("lockout");
            }
            out.push((format!("DROP {word} {name}"), dangers, false));
        }
        Change::Password { who } => {
            let name = account(kind, who, cx)?;
            let sql = match kind {
                DbKind::Postgres => format!("ALTER ROLE {name} PASSWORD {}", password()?),
                DbKind::Mysql => format!("ALTER USER {name} IDENTIFIED BY {}", password()?),
                DbKind::Sqlserver => format!("ALTER LOGIN {name} WITH PASSWORD = {}", password()?),
                DbKind::Sqlite => return Err(unsupported()),
                DbKind::Oracle => return Err(super::not_yet(kind, "users and rights")),
                DbKind::Duckdb => return Err(unsupported()),
                DbKind::Clickhouse => return Err(super::not_yet(kind, "users and rights")),
            };
            // the password this connection logs in with would no longer fit
            let dangers = if mine(who) { vec!["lockout"] } else { vec![] };
            out.push((sql, dangers, true));
        }
        Change::Attribute { who, attribute, on } => {
            if kind != DbKind::Postgres {
                return Err(invalid("this database has no such attributes"));
            }
            if !PG_ATTRIBUTES.contains(&attribute.as_str()) {
                return Err(invalid("this is not an attribute of a role"));
            }
            let name = account(kind, who, cx)?;
            let word = attribute.to_ascii_uppercase();
            let mut dangers = Vec::new();
            if *on && attribute == "superuser" {
                dangers.push("superuser");
            }
            if *on && matches!(attribute.as_str(), "createrole" | "replication") {
                dangers.push("escalation");
            }
            if !*on && mine(who) {
                dangers.push("lockout");
            }
            let no = if *on { "" } else { "NO" };
            out.push((format!("ALTER ROLE {name} {no}{word}"), dangers, false));
        }
        Change::Member { role, member, add } => {
            let r = account(kind, role, cx)?;
            let m = account(kind, member, cx)?;
            let sql = match (kind, *add) {
                (DbKind::Sqlserver, true) => format!("ALTER ROLE {r} ADD MEMBER {m}"),
                (DbKind::Sqlserver, false) => format!("ALTER ROLE {r} DROP MEMBER {m}"),
                (DbKind::Sqlite, _) => return Err(unsupported()),
                (DbKind::Oracle, _) => return Err(super::not_yet(kind, "users and rights")),
                (DbKind::Duckdb, _) => return Err(unsupported()),
                (DbKind::Clickhouse, _) => {
                    return Err(super::not_yet(kind, "users and rights"));
                }
                (_, true) => format!("GRANT {r} TO {m}"),
                (_, false) => format!("REVOKE {r} FROM {m}"),
            };
            let mut dangers = Vec::new();
            if !*add && mine(member) {
                dangers.push("lockout");
            }
            if *add && powerful(role) {
                dangers.push("superuser");
            }
            out.push((sql, dangers, false));
        }
        Change::Grant {
            who,
            level,
            schema,
            object,
            column,
            privilege,
            grantable,
            add,
        } => {
            if !privileges(kind, level).contains(&privilege.as_str()) {
                return Err(invalid("this right cannot be granted from here"));
            }
            let name = account(kind, who, cx)?;
            let (on, columns) = target(kind, level, schema, object, column)?;
            let all = privilege == "ALL";
            let word = match (kind, all) {
                (DbKind::Mysql, true) => "ALL PRIVILEGES",
                _ => privilege.as_str(),
            };
            // SQL Server names the columns after the object, the others after the privilege
            let (what, on) = if kind == DbKind::Sqlserver {
                (word.to_owned(), format!("{on}{columns}"))
            } else {
                (format!("{word}{columns}"), on)
            };
            let on = if on.is_empty() {
                String::new()
            } else {
                format!(" {on}")
            };
            let mut dangers = Vec::new();
            let sql = if *add {
                if all || privilege == "CONTROL" {
                    dangers.push("all");
                }
                if *grantable {
                    dangers.push("grantOption");
                }
                // rights that reach further than they look
                let far = match kind {
                    DbKind::Mysql => {
                        (level == "server"
                            && matches!(
                                privilege.as_str(),
                                "CREATE USER" | "RELOAD" | "PROCESS" | "SHOW DATABASES"
                            ))
                            || (!all
                                && (schema.eq_ignore_ascii_case("mysql")
                                    || (level == "schema" && object.eq_ignore_ascii_case("mysql"))))
                    }
                    DbKind::Sqlserver => level == "database" && privilege == "ALTER",
                    _ => false,
                };
                if far {
                    dangers.push("escalation");
                }
                let option = if *grantable { " WITH GRANT OPTION" } else { "" };
                format!("GRANT {what}{on} TO {name}{option}")
            } else {
                if mine(who) {
                    dangers.push("lockout");
                }
                format!("REVOKE {what}{on} FROM {name}")
            };
            out.push((sql, dangers, false));
        }
    }
    Ok(out)
}

/// The statements of the changes, as they are shown: every password is [`MASK`].
pub fn plan(kind: DbKind, changes: &[Change], cx: &Context) -> AppResult<Vec<Step>> {
    let mut steps = Vec::new();
    for (i, change) in changes.iter().enumerate() {
        for (sql, dangers, secret) in written(kind, change, cx, &|| Ok(MASK.to_owned()))? {
            steps.push(Step {
                sql,
                dangers: dangers.into_iter().map(str::to_owned).collect(),
                change: i,
                secret,
            });
        }
    }
    Ok(steps)
}

/// The statements as they run: with the passwords (`passwords[i]` belongs to `changes[i]`). They are
/// wiped when dropped. A change that needs a password and has none is refused.
pub fn statements(
    kind: DbKind,
    changes: &[Change],
    passwords: &[Option<Secret>],
    cx: &Context,
    salt: &dyn Fn() -> AppResult<[u8; 16]>,
) -> AppResult<Zeroizing<Vec<String>>> {
    let mut out = Zeroizing::new(Vec::new());
    for (i, change) in changes.iter().enumerate() {
        let literal = || -> AppResult<String> {
            let secret = passwords
                .get(i)
                .and_then(Option::as_ref)
                .ok_or_else(|| invalid("a password is missing"))?;
            password_literal(kind, secret, cx, salt)
        };
        for (sql, _, _) in written(kind, change, cx, &literal)? {
            out.push(sql);
        }
    }
    Ok(out)
}

/// The literal a password travels as. PostgreSQL gets a SCRAM-SHA-256 verifier where the password is
/// plain ASCII (what `psql \password` does): the server never sees the password.
fn password_literal(
    kind: DbKind,
    secret: &Secret,
    cx: &Context,
    salt: &dyn Fn() -> AppResult<[u8; 16]>,
) -> AppResult<String> {
    let text = secret.expose();
    if text.is_empty() || text.contains('\0') || text.chars().count() > 512 {
        return Err(invalid("this cannot be a password"));
    }
    Ok(match kind {
        DbKind::Postgres => {
            let printable = text.chars().all(|c| c.is_ascii() && !c.is_ascii_control());
            if printable && cx.flavor != Flavor::Cockroach {
                format!("'{}'", scram_verifier(text, &salt()?, 4096))
            } else {
                plain_text(text, kind)
            }
        }
        DbKind::Mysql => mysql_text(text, cx.backslash_escapes),
        DbKind::Sqlserver => plain_text(text, kind),
        DbKind::Sqlite => return Err(unsupported()),
        DbKind::Oracle => return Err(super::not_yet(kind, "users and rights")),
        DbKind::Duckdb => return Err(unsupported()),
        DbKind::Clickhouse => return Err(super::not_yet(kind, "users and rights")),
    })
}

/// Whether a password of PostgreSQL travels as a verifier (and so cannot stand in a log of the server).
pub fn hides_password(kind: DbKind, flavor: Flavor) -> bool {
    kind == DbKind::Postgres && flavor != Flavor::Cockroach
}

fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes any key");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// PBKDF2-HMAC-SHA256, one block (32 bytes).
fn pbkdf2(password: &[u8], salt: &[u8], rounds: u32) -> Zeroizing<[u8; 32]> {
    let mut first = salt.to_vec();
    first.extend_from_slice(&1u32.to_be_bytes());
    let mut u = hmac(password, &first);
    let mut out = Zeroizing::new(u);
    for _ in 1..rounds {
        u = hmac(password, &u);
        for (o, b) in out.iter_mut().zip(u) {
            *o ^= b;
        }
    }
    out
}

/// `SCRAM-SHA-256$<rounds>:<salt>$<StoredKey>:<ServerKey>` (RFC 5802, as PostgreSQL stores it).
pub fn scram_verifier(password: &str, salt: &[u8], rounds: u32) -> String {
    use data_encoding::BASE64;
    let salted = pbkdf2(password.as_bytes(), salt, rounds);
    let client = Zeroizing::new(hmac(&salted[..], b"Client Key"));
    let stored = Sha256::digest(&client[..]);
    let server = hmac(&salted[..], b"Server Key");
    format!(
        "SCRAM-SHA-256${rounds}:{}${}:{}",
        BASE64.encode(salt),
        BASE64.encode(&stored),
        BASE64.encode(&server)
    )
}

/// A salt from the random source of the TLS library (no dependency of its own).
pub fn random_salt() -> AppResult<[u8; 16]> {
    let mut salt = [0u8; 16];
    rustls::crypto::ring::default_provider()
        .secure_random
        .fill(&mut salt)
        .map_err(|_| AppError::new(ErrorCode::Unsupported, "no random numbers"))?;
    Ok(salt)
}

/// What the plan needs to know about the connection.
pub fn context(s: &mut dyn Session, kind: DbKind, stop: Stop) -> AppResult<Context> {
    let flavor = match (kind, s.flavor()) {
        (DbKind::Mysql, Flavor::Plain) if is_maria(s, stop) => Flavor::Maria,
        (_, flavor) => flavor,
    };
    let mut cx = Context {
        flavor,
        backslash_escapes: true,
        mine: Vec::new(),
        powerful: Vec::new(),
    };
    if kind == DbKind::Mysql {
        let mode = asked(s, "SELECT @@sql_mode", &[], stop)?;
        cx.backslash_escapes = !mode
            .first()
            .is_some_and(|r| text(r, 0).contains("NO_BACKSLASH_ESCAPES"));
    }
    // who the connection is, and every role it is in: taking from them may lock it out
    if let Ok(access) = principals(s, kind, stop) {
        let by_label: HashMap<&str, &Principal> = access
            .principals
            .iter()
            .map(|p| (p.label.as_str(), p))
            .collect();
        cx.powerful = access
            .principals
            .iter()
            .filter(|p| p.superuser || p.attributes.iter().any(|a| a == "createrole"))
            .map(|p| p.label.clone())
            .collect();
        let mut queue = vec![access.me.clone()];
        while let Some(label) = queue.pop() {
            if label.is_empty() || cx.mine.contains(&label) {
                continue;
            }
            if let Some(p) = by_label.get(label.as_str()) {
                queue.extend(p.member_of.iter().cloned());
            }
            cx.mine.push(label);
        }
    }
    Ok(cx)
}

/// The changes that give `to` what `grants` holds directly – as far as it can be granted from here.
pub fn as_changes(kind: DbKind, to: &Who, grants: &[Grant]) -> Vec<Change> {
    grants
        .iter()
        .filter(|g| g.via.is_empty() && privileges(kind, &g.level).contains(&g.privilege.as_str()))
        .map(|g| Change::Grant {
            who: to.clone(),
            level: g.level.clone(),
            schema: g.schema.clone(),
            object: g.object.clone(),
            column: g.column.clone(),
            privilege: g.privilege.clone(),
            grantable: g.grantable,
            add: true,
        })
        .collect()
}

/// The rights of a principal as a script of `GRANT`s.
pub fn script(kind: DbKind, who: &Who, grants: &[Grant], cx: &Context) -> AppResult<String> {
    let steps = plan(kind, &as_changes(kind, who, grants), cx)?;
    Ok(steps
        .iter()
        .map(|s| format!("{};\n", s.sql))
        .collect::<String>())
}

/// Whether the statements run in one transaction: where the database rolls such statements back.
pub fn transactional(kind: DbKind, flavor: Flavor) -> bool {
    match kind {
        DbKind::Postgres => flavor != Flavor::Cockroach,
        DbKind::Sqlserver => true,
        DbKind::Mysql | DbKind::Sqlite | DbKind::Oracle | DbKind::Duckdb | DbKind::Clickhouse => {
            false
        }
    }
}

/// An error of a run with passwords: nothing of a password may come back with it. `carried`: the
/// statement that failed held one – then only the code of the database is kept, whatever the message
/// says (a server quotes the statement in the escaped form, which no search for the password finds;
/// review 047 M2).
pub fn scrubbed(
    mut e: AppError,
    carried: bool,
    statements: &[String],
    passwords: &[Option<Secret>],
) -> AppError {
    let mut secrets: Vec<&str> = passwords
        .iter()
        .flatten()
        .map(Secret::expose)
        .filter(|p| !p.is_empty())
        .collect();
    secrets.extend(statements.iter().map(String::as_str));
    let dirty = |text: &str| secrets.iter().any(|s| text.contains(s));
    let all = e
        .details
        .as_ref()
        .map(|d| serde_json::to_string(d).unwrap_or_default())
        .unwrap_or_default();
    if carried || dirty(&e.message) || dirty(&all) {
        let sqlstate = e.details.as_ref().and_then(|d| d.sqlstate.clone());
        e.message = match &sqlstate {
            Some(code) => {
                format!("the statement failed ({code}); its text is not shown: it holds a password")
            }
            None => "the statement failed; its text is not shown: it holds a password".to_owned(),
        };
        e.details = sqlstate.map(|code| {
            Box::new(crate::error::ErrorDetails {
                sqlstate: Some(code),
                ..Default::default()
            })
        });
    }
    e
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod tests;
