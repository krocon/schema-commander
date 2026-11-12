//! The name index of a connection (prompt 020): every table, view, routine and sequence of all schemas –
//! and, once asked for, every column – in memory, searched after each key press. Reading the catalog is
//! the only part that touches the database; the search is pure and tested below.
//!
//! The query is small: a prefix for the kind (`t:` tables and views, `c:` columns, `f:` routines,
//! `s:` sequences), `schema.name` (for a column `table.column`), then letters. A name is found by its
//! start, by the starts of its words (`ord_it` → `order_items`, `oi` → `OrderItems`), by a part, by its
//! letters in order, and with a typo.

use super::meta::{ObjectKind, quote};
use super::{DbKind, Session, Stop, TextRows};
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(60);
/// Entries of an index at most; a database beyond that is searched as far as it was read.
pub const MAX_ENTRIES: usize = 1_000_000;
/// Hits handed to the window at most.
pub const MAX_HITS: usize = 200;
/// Characters of a query that are looked at.
pub const MAX_QUERY: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NameKind {
    Table,
    View,
    Matview,
    Routine,
    Sequence,
    Column,
}

impl NameKind {
    fn word(word: &str) -> Option<Self> {
        Some(match word {
            "table" => Self::Table,
            "view" => Self::View,
            "matview" => Self::Matview,
            "routine" => Self::Routine,
            "sequence" => Self::Sequence,
            _ => return None,
        })
    }

    /// Ties go to what is asked for most.
    fn rank(self) -> u8 {
        match self {
            Self::Table => 0,
            Self::View | Self::Matview => 1,
            Self::Routine => 2,
            Self::Sequence => 3,
            Self::Column => 4,
        }
    }
}

/// One name of the index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub kind: NameKind,
    pub schema: String,
    pub name: String,
    /// The table of a column.
    pub parent: Option<String>,
    /// The arguments of a routine, the type of a column.
    pub detail: String,
    /// The name in lower case, character for character (the indices of a match are those of the name).
    folded: Vec<char>,
    /// Where the words of the name start (made once: the search runs after every key press).
    starts: Vec<usize>,
    schema_folded: Vec<char>,
    parent_folded: Option<Vec<char>>,
    /// Which characters the name has, as bits: sorts out most names before the costly typo check.
    mask: u64,
}

impl Entry {
    pub fn new(
        kind: NameKind,
        schema: &str,
        name: &str,
        parent: Option<&str>,
        detail: &str,
    ) -> Self {
        Self {
            kind,
            schema: schema.to_string(),
            name: name.to_string(),
            parent: parent.map(str::to_string),
            detail: detail.to_string(),
            starts: {
                let original: Vec<char> = name.chars().collect();
                let folded = fold(name);
                // a name whose folded form has another length (rare: `İ`) is taken as folded
                word_starts(if original.len() == folded.len() {
                    &original
                } else {
                    &folded
                })
            },
            folded: fold(name),
            schema_folded: fold(schema),
            parent_folded: parent.map(fold),
            mask: mask(&fold(name)),
        }
    }
}

#[derive(Debug, Default)]
pub struct NameIndex {
    pub entries: Vec<Entry>,
    /// The columns are in (they are read when first asked for).
    pub columns: bool,
    /// More names than [`MAX_ENTRIES`]: the rest is missing.
    pub cut: bool,
}

/// A hit as the window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameHit {
    pub kind: NameKind,
    pub schema: String,
    pub name: String,
    pub parent: Option<String>,
    pub detail: String,
    /// The name as it is written in SQL, with its schema (a column: only its own name).
    pub quoted: String,
    /// The name alone as it is written in SQL (the completion writes it so inside its own schema).
    pub quoted_name: String,
    /// The characters of `name` that matched (indices of characters, not of bytes).
    pub marks: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameHits {
    pub hits: Vec<NameHit>,
    /// Names that match in all.
    pub total: usize,
    /// Names in the index.
    pub indexed: usize,
    pub cut: bool,
}

/// What the ranking knows beside the query.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    /// The schema unqualified names are looked up in first.
    #[serde(default)]
    pub current_schema: String,
    /// `schema.name` of what was chosen lately, the latest first.
    #[serde(default)]
    pub recent: Vec<String>,
}

/// One bit per character (letters and digits their own, the rest shared).
fn mask(text: &[char]) -> u64 {
    text.iter().fold(0, |m, &c| m | bit(c))
}

fn bit(c: char) -> u64 {
    1 << match c {
        'a'..='z' => c as u32 - 'a' as u32,
        '0'..='9' => 26 + c as u32 - '0' as u32,
        _ => 36 + (c as u32 % 28),
    }
}

fn fold(text: &str) -> Vec<char> {
    text.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

// --- the query ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Query {
    /// `None` = objects (no columns).
    pub kinds: Option<Vec<NameKind>>,
    /// The part in front of the dot: a schema, or the table of a column.
    pub scope: Option<Vec<char>>,
    pub text: Vec<char>,
}

/// Reads a query. Unknown prefixes are part of the text.
pub fn parse(input: &str) -> Query {
    let input: String = input.trim().chars().take(MAX_QUERY).collect();
    let (kinds, rest) = match input.split_once(':') {
        Some((p, rest)) => match p.trim().to_ascii_lowercase().as_str() {
            "t" => (
                Some(vec![NameKind::Table, NameKind::View, NameKind::Matview]),
                rest,
            ),
            "v" => (Some(vec![NameKind::View, NameKind::Matview]), rest),
            "c" => (Some(vec![NameKind::Column]), rest),
            "f" => (Some(vec![NameKind::Routine]), rest),
            "s" => (Some(vec![NameKind::Sequence]), rest),
            _ => (None, input.as_str()),
        },
        None => (None, input.as_str()),
    };
    let rest = rest.trim();
    let (scope, text) = match rest.rsplit_once('.') {
        Some((scope, text)) if !scope.trim().is_empty() => (Some(fold(scope.trim())), text),
        Some((_, text)) => (None, text),
        None => (None, rest),
    };
    Query {
        kinds,
        scope,
        text: fold(text.trim()),
    }
}

// --- matching ----------------------------------------------------------------------------------------

/// Where the words of a name start: at its start, behind `_ - . space`, at a capital behind a small letter
/// and at a digit behind a letter.
fn word_starts(name: &[char]) -> Vec<usize> {
    let mut starts = Vec::new();
    for (i, &c) in name.iter().enumerate() {
        let sep = |c: char| matches!(c, '_' | '-' | '.' | ' ' | '$');
        if sep(c) {
            continue;
        }
        let start = i == 0
            || sep(name[i - 1])
            || (c.is_uppercase() && name[i - 1].is_lowercase())
            || (c.is_ascii_digit() && name[i - 1].is_alphabetic());
        if start {
            starts.push(i);
        }
    }
    starts
}

/// The text as starts of the words of the name, in order: `ord_it` and `ordit` in `order_items`, `oi` in
/// `OrderItems`. Separators of the text only end a part. Greedy with one step back: a letter that fits
/// the running word and the start of the next one is tried both ways.
fn initials(text: &[char], folded: &[char], starts: &[usize]) -> Option<Vec<u32>> {
    /// Steps a name may cost: names with many words that start alike would otherwise be tried in
    /// every combination.
    const BUDGET: u32 = 400;
    fn go(
        text: &[char],
        folded: &[char],
        starts: &[usize],
        word: usize,
        at: Option<usize>,
        marks: &mut Vec<u32>,
        steps: &mut u32,
    ) -> bool {
        let Some((&c, rest)) = text.split_first() else {
            return true;
        };
        *steps += 1;
        if *steps > BUDGET {
            return false;
        }
        if matches!(c, '_' | '-' | ' ' | '.') {
            // a separator of the text ends a part: the next letter must start a word
            return go(rest, folded, starts, word, None, marks, steps);
        }
        // go on in the running word
        if let Some(i) = at
            && i < folded.len()
            && folded[i] == c
            && !starts.contains(&i)
        {
            marks.push(i as u32);
            if go(rest, folded, starts, word, Some(i + 1), marks, steps) {
                return true;
            }
            marks.pop();
        }
        // or start one of the next words
        for (w, &s) in starts.iter().enumerate().skip(word) {
            if folded[s] == c {
                marks.push(s as u32);
                if go(rest, folded, starts, w + 1, Some(s + 1), marks, steps) {
                    return true;
                }
                marks.pop();
            }
        }
        false
    }
    // the first letter must start a word at all
    let first = text.iter().find(|c| !matches!(c, '_' | '-' | ' ' | '.'))?;
    if !starts.iter().any(|&s| folded[s] == *first) {
        return None;
    }
    let mut marks = Vec::new();
    let mut steps = 0;
    go(text, folded, starts, 0, None, &mut marks, &mut steps).then_some(marks)
}

fn find(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == *needle)
}

fn subsequence(text: &[char], folded: &[char]) -> Option<Vec<u32>> {
    let mut marks = Vec::with_capacity(text.len());
    let mut from = 0;
    for &c in text {
        let at = folded[from..].iter().position(|&h| h == c)? + from;
        marks.push(at as u32);
        from = at + 1;
    }
    Some(marks)
}

/// Whether `a` becomes `b` with at most `max` edits (insert, delete, replace, swap of neighbours).
fn within_edits(a: &[char], b: &[char], max: usize) -> bool {
    if a.len().abs_diff(b.len()) > max {
        return false;
    }
    let mut before: Vec<usize> = Vec::new();
    let mut last: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut row = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            row[j] = (last[j] + 1).min(row[j - 1] + 1).min(last[j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                row[j] = row[j].min(before[j - 2] + 1);
            }
        }
        if row.iter().min().is_some_and(|&m| m > max) {
            return false;
        }
        before = std::mem::replace(&mut last, row);
    }
    last[b.len()] <= max
}

/// How well a text finds a name: higher is better, `None` = not at all. The marks are the characters of
/// the name that matched.
pub fn score(
    text: &[char],
    folded: &[char],
    starts: &[usize],
    name_mask: u64,
) -> Option<(u32, Vec<u32>)> {
    if text.is_empty() {
        return Some((1, Vec::new()));
    }
    // short names first among equals
    let short = 60u32.saturating_sub(folded.len().min(60) as u32);
    let run = |from: usize| {
        (from..from + text.len())
            .map(|i| i as u32)
            .collect::<Vec<_>>()
    };
    if folded == text {
        return Some((1000 + short, run(0)));
    }
    if folded.starts_with(text) {
        return Some((900 + short, run(0)));
    }
    // characters of the text the name does not have at all (separators of the text aside): with any,
    // only a typo can still explain the text
    let letters = |c: &&char| !matches!(**c, '_' | '-' | ' ' | '.');
    let strangers = text
        .iter()
        .filter(letters)
        .filter(|&&c| name_mask & bit(c) == 0)
        .count();
    if strangers == 0 {
        if let Some(marks) = initials(text, folded, starts) {
            return Some((800 + short, marks));
        }
        if let Some(at) = find(folded, text) {
            let bonus = if starts.contains(&at) { 60 } else { 0 };
            return Some((600 + bonus + short, run(at)));
        }
    }
    // a typo: the whole name, its start, or one of its words
    let edits = if text.len() >= 8 { 2 } else { 1 };
    // with `edits` typos at most that many characters of the text can be missing in the name
    if text.len() >= 4 && strangers <= edits {
        // a typo rarely changes both first letters: a part that starts quite differently is not tried
        let alike = |part: &[char]| {
            part.first() == text.first()
                || part.get(1) == text.get(1)
                || part.first() == text.get(1)
                || part.get(1) == text.first()
        };
        let near = |part: &[char]| alike(part) && within_edits(text, part, edits);
        let mut ends: Vec<usize> = starts.iter().skip(1).copied().collect();
        ends.push(folded.len());
        let word = starts
            .iter()
            .zip(&ends)
            .any(|(&s, &e)| near(folded[s..e].trim_end_matches(['_', '-', '.', ' '])));
        // the start of the name, a little shorter or longer than the text
        let head = word
            || (alike(folded)
                && (text.len().saturating_sub(edits)..=(text.len() + edits).min(folded.len()))
                    .any(|n| within_edits(text, &folded[..n], edits)));
        if head {
            return Some((400 + short, Vec::new()));
        }
    }
    if strangers > 0 {
        return None;
    }
    if let Some(marks) = subsequence(text, folded) {
        // letters that follow each other count more than scattered ones
        let together = marks.windows(2).filter(|w| w[1] == w[0] + 1).count() as u32;
        return Some((200 + together * 10 + short / 2, marks));
    }
    None
}

trait TrimChars {
    fn trim_end_matches(&self, chars: [char; 4]) -> &[char];
}

impl TrimChars for [char] {
    fn trim_end_matches(&self, chars: [char; 4]) -> &[char] {
        let mut end = self.len();
        while end > 0 && chars.contains(&self[end - 1]) {
            end -= 1;
        }
        &self[..end]
    }
}

/// The best [`MAX_HITS`] names for a query. Among equals: the current schema, what was chosen lately,
/// tables before the rest, then by name.
pub fn search(index: &NameIndex, input: &str, context: &Context, kind: DbKind) -> NameHits {
    let query = parse(input);
    let current = fold(&context.current_schema);
    let mut found: Vec<(u32, &Entry, Vec<u32>)> = Vec::new();
    for entry in &index.entries {
        let wanted = match &query.kinds {
            Some(kinds) => kinds.contains(&entry.kind),
            None => entry.kind != NameKind::Column,
        };
        if !wanted {
            continue;
        }
        if let Some(scope) = &query.scope {
            // in front of the dot: the schema, or for a column its table
            let fits = |part: &[char]| part.starts_with(scope) || find(part, scope).is_some();
            if !(fits(&entry.schema_folded) || entry.parent_folded.as_deref().is_some_and(fits)) {
                continue;
            }
        }
        let Some((mut points, marks)) =
            score(&query.text, &entry.folded, &entry.starts, entry.mask)
        else {
            continue;
        };
        if !current.is_empty() && entry.schema_folded == current {
            points += 30;
        }
        if !context.recent.is_empty() {
            let key = format!("{}.{}", entry.schema, entry.name);
            if let Some(i) = context.recent.iter().take(50).position(|r| *r == key) {
                points += 45u32.saturating_sub(i as u32);
            }
        }
        found.push((points, entry, marks));
    }
    let total = found.len();
    let order = |a: &(u32, &Entry, Vec<u32>), b: &(u32, &Entry, Vec<u32>)| {
        b.0.cmp(&a.0)
            .then(a.1.kind.rank().cmp(&b.1.kind.rank()))
            .then_with(|| a.1.folded.cmp(&b.1.folded))
            .then_with(|| a.1.schema.cmp(&b.1.schema))
            .then_with(|| a.1.parent.cmp(&b.1.parent))
    };
    if found.len() > MAX_HITS {
        found.select_nth_unstable_by(MAX_HITS, order);
        found.truncate(MAX_HITS);
    }
    found.sort_by(order);
    let hits = found
        .into_iter()
        .map(|(_, e, marks)| NameHit {
            kind: e.kind,
            schema: e.schema.clone(),
            name: e.name.clone(),
            parent: e.parent.clone(),
            detail: e.detail.clone(),
            quoted: if e.kind == NameKind::Column {
                quote(&e.name, kind)
            } else {
                format!("{}.{}", quote(&e.schema, kind), quote(&e.name, kind))
            },
            quoted_name: quote(&e.name, kind),
            marks,
        })
        .collect();
    NameHits {
        hits,
        total,
        indexed: index.entries.len(),
        cut: index.cut,
    }
}

// --- reading the catalog -----------------------------------------------------------------------------

fn at(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

fn ask(s: &mut dyn Session, sql: &str, params: &[&str], stop: Stop) -> AppResult<TextRows> {
    s.ask(sql, params, Some(TIMEOUT), stop)
}

/// The schemas of SQLite: the files that are attached.
fn sqlite_files(s: &mut dyn Session, kind: DbKind, stop: Stop) -> AppResult<Vec<String>> {
    if kind == DbKind::D1 {
        // one database, and D1 lets nobody ask which files are attached
        return Ok(vec!["main".to_owned()]);
    }
    Ok(ask(
        s,
        "SELECT name FROM pragma_database_list ORDER BY seq",
        &[],
        stop,
    )?
    .iter()
    .map(|r| at(r, 0))
    .collect())
}

/// Reads the objects of all schemas but the system's: kind, schema, name, detail.
pub fn read_objects(s: &mut dyn Session, kind: DbKind, stop: Stop) -> AppResult<NameIndex> {
    let rows = match kind {
        // a dataset is named in the statement: one question each, the first fifty
        DbKind::Bigquery => {
            let mut rows = TextRows::new();
            for schema in super::meta::schemas(s, kind, stop)?.into_iter().take(50) {
                let asked = ask(
                    s,
                    &format!(
                        "SELECT CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END, table_schema, \
                           table_name, '' FROM {}.INFORMATION_SCHEMA.TABLES",
                        super::meta::quote_always(&schema.name, kind)
                    ),
                    &[],
                    stop,
                );
                // a dataset in another place than the jobs of the connection cannot be asked from here
                rows.extend(asked.unwrap_or_default());
            }
            rows
        }
        DbKind::Postgres => ask(
            s,
            "SELECT CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' \
               WHEN 'S' THEN 'sequence' ELSE 'table' END, n.nspname::text, c.relname::text, ''::text \
             FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') \
               AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' \
             UNION ALL \
             SELECT 'routine', n.nspname::text, p.proname::text, \
               pg_catalog.pg_get_function_identity_arguments(p.oid)::text \
             FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'",
            &[],
            stop,
        )?,
        DbKind::Mysql => ask(
            s,
            "SELECT CASE WHEN TABLE_TYPE LIKE '%VIEW%' THEN 'view' WHEN TABLE_TYPE = 'SEQUENCE' \
               THEN 'sequence' ELSE 'table' END, TABLE_SCHEMA, TABLE_NAME, '' \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema') \
             UNION ALL SELECT 'routine', ROUTINE_SCHEMA, ROUTINE_NAME, LOWER(ROUTINE_TYPE) \
             FROM information_schema.ROUTINES \
             WHERE ROUTINE_SCHEMA NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema')",
            &[],
            stop,
        )?,
        DbKind::Sqlserver => ask(
            s,
            "SELECT CASE WHEN o.type = 'U' THEN 'table' WHEN o.type = 'V' THEN 'view' \
               WHEN o.type = 'SO' THEN 'sequence' ELSE 'routine' END, s.name, o.name, '' \
             FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'SO') AND o.is_ms_shipped = 0",
            &[],
            stop,
        )?,
        DbKind::Firebird => ask(
            s,
            "SELECT CASE WHEN r.rdb$view_blr IS NULL THEN 'table' ELSE 'view' END, '', \
               r.rdb$relation_name, '' \
             FROM rdb$relations r WHERE COALESCE(r.rdb$system_flag, 0) = 0 \
             UNION ALL SELECT 'routine', '', p.rdb$procedure_name, 'procedure' FROM rdb$procedures p \
             WHERE COALESCE(p.rdb$system_flag, 0) = 0 AND p.rdb$package_name IS NULL",
            &[],
            stop,
        )?,
        DbKind::Trino => ask(
            s,
            "SELECT CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END, table_schema, \
               table_name, '' \
             FROM information_schema.tables WHERE table_schema <> 'information_schema'",
            &[],
            stop,
        )?,
        DbKind::Clickhouse => ask(
            s,
            "SELECT multiIf(engine = 'MaterializedView', 'matview', engine LIKE '%View', 'view', \
               'table'), database, name, engine \
             FROM system.tables \
             WHERE NOT is_temporary AND name NOT LIKE '.inner%' \
               AND database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')",
            &[],
            stop,
        )?,
        DbKind::Duckdb => ask(
            s,
            "SELECT 'table', schema_name, table_name, '' FROM duckdb_tables() \
             WHERE database_name = current_database() AND NOT internal \
             UNION ALL SELECT 'view', schema_name, view_name, '' FROM duckdb_views() \
             WHERE database_name = current_database() AND NOT internal \
             UNION ALL SELECT 'sequence', schema_name, sequence_name, '' FROM duckdb_sequences() \
             WHERE database_name = current_database()",
            &[],
            stop,
        )?,
        DbKind::Oracle => ask(
            s,
            "SELECT CASE o.object_type WHEN 'TABLE' THEN 'table' WHEN 'VIEW' THEN 'view' \
               WHEN 'MATERIALIZED VIEW' THEN 'matview' WHEN 'SEQUENCE' THEN 'sequence' \
               ELSE 'routine' END, o.owner, o.object_name, \
               CASE WHEN o.object_type IN ('PROCEDURE', 'FUNCTION', 'PACKAGE') \
                 THEN LOWER(o.object_type) ELSE '' END \
             FROM all_objects o \
             WHERE o.oracle_maintained = 'N' AND o.generated = 'N' \
               AND o.object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW', 'SEQUENCE', 'PROCEDURE', \
                 'FUNCTION', 'PACKAGE') \
               AND o.object_name NOT LIKE 'BIN$%' \
               AND NOT (o.object_type = 'TABLE' AND EXISTS (SELECT 1 FROM all_mviews m \
                 WHERE m.owner = o.owner AND m.mview_name = o.object_name))",
            &[],
            stop,
        )?,
        DbKind::Sqlite | DbKind::Libsql | DbKind::D1 => {
            let mut rows = Vec::new();
            for file in sqlite_files(s, kind, stop)? {
                // a schema cannot be bound: its name goes in quoted (as in `meta.rs`)
                let quoted = super::meta::quote_always(&file, DbKind::Sqlite);
                rows.extend(ask(
                    s,
                    &format!(
                        "SELECT type, ?1, name, '' FROM {quoted}.sqlite_schema \
                         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'"
                    ),
                    &[&file],
                    stop,
                )?);
            }
            rows
        }
    };
    let mut index = NameIndex::default();
    for row in &rows {
        let Some(kind) = NameKind::word(&at(row, 0)) else {
            continue;
        };
        if index.entries.len() >= MAX_ENTRIES {
            index.cut = true;
            break;
        }
        index.entries.push(Entry::new(
            kind,
            &at(row, 1),
            &at(row, 2),
            None,
            &at(row, 3),
        ));
    }
    Ok(index)
}

/// Adds the columns of all tables and views: schema, table, column, type.
pub fn read_columns(
    s: &mut dyn Session,
    kind: DbKind,
    index: &mut NameIndex,
    stop: Stop,
) -> AppResult<()> {
    let rows = match kind {
        DbKind::Bigquery => {
            let mut rows = TextRows::new();
            for schema in super::meta::schemas(s, kind, stop)?.into_iter().take(50) {
                let asked = ask(
                    s,
                    &format!(
                        "SELECT table_schema, table_name, column_name, data_type \
                         FROM {}.INFORMATION_SCHEMA.COLUMNS",
                        super::meta::quote_always(&schema.name, kind)
                    ),
                    &[],
                    stop,
                );
                rows.extend(asked.unwrap_or_default());
            }
            rows
        }
        DbKind::Postgres => ask(
            s,
            "SELECT n.nspname::text, c.relname::text, a.attname::text, \
               pg_catalog.format_type(a.atttypid, a.atttypmod) \
             FROM pg_catalog.pg_attribute a \
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f') \
               AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'",
            &[],
            stop,
        )?,
        DbKind::Mysql => ask(
            s,
            "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema')",
            &[],
            stop,
        )?,
        DbKind::Sqlserver => ask(
            s,
            "SELECT s.name, o.name, c.name, t.name FROM sys.columns c \
             JOIN sys.objects o ON o.object_id = c.object_id \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             JOIN sys.types t ON t.user_type_id = c.user_type_id \
             WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0",
            &[],
            stop,
        )?,
        DbKind::Firebird => ask(
            s,
            &format!(
                "SELECT '', rf.rdb$relation_name, rf.rdb$field_name, {} \
                 FROM rdb$relation_fields rf \
                 JOIN rdb$fields f ON f.rdb$field_name = rf.rdb$field_source \
                 JOIN rdb$relations r ON r.rdb$relation_name = rf.rdb$relation_name \
                 WHERE {} ORDER BY rf.rdb$relation_name, rf.rdb$field_position",
                super::firebird::TYPE,
                super::firebird::OWN
            ),
            &[],
            stop,
        )?,
        DbKind::Trino => ask(
            s,
            "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns \
             WHERE table_schema <> 'information_schema'",
            &[],
            stop,
        )?,
        DbKind::Clickhouse => ask(
            s,
            "SELECT database, table, name, type FROM system.columns \
             WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') \
               AND table NOT LIKE '.inner%'",
            &[],
            stop,
        )?,
        DbKind::Duckdb => ask(
            s,
            "SELECT schema_name, table_name, column_name, data_type FROM duckdb_columns() \
             WHERE database_name = current_database() AND NOT internal",
            &[],
            stop,
        )?,
        DbKind::Oracle => ask(
            s,
            "SELECT c.owner, c.table_name, c.column_name, c.data_type \
             FROM all_tab_cols c \
             WHERE c.hidden_column = 'NO' AND c.table_name NOT LIKE 'BIN$%' \
               AND c.owner IN (SELECT u.username FROM all_users u WHERE u.oracle_maintained = 'N')",
            &[],
            stop,
        )?,
        DbKind::Sqlite | DbKind::Libsql | DbKind::D1 => {
            let mut rows = Vec::new();
            for file in sqlite_files(s, kind, stop)? {
                let quoted = super::meta::quote_always(&file, DbKind::Sqlite);
                rows.extend(ask(
                    s,
                    &format!(
                        "SELECT ?1, m.name, p.name, p.type FROM {quoted}.sqlite_schema m, \
                           pragma_table_info(m.name, ?1) p \
                         WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND m.name NOT LIKE '\\_cf\\_%' ESCAPE '\\'"
                    ),
                    &[&file],
                    stop,
                )?);
            }
            rows
        }
    };
    for row in &rows {
        if index.entries.len() >= MAX_ENTRIES {
            index.cut = true;
            break;
        }
        index.entries.push(Entry::new(
            NameKind::Column,
            &at(row, 0),
            &at(row, 2),
            Some(&at(row, 1)),
            &at(row, 3),
        ));
    }
    index.columns = true;
    Ok(())
}

/// The kind of an object as the details (prompt 019) name it.
pub fn object_kind(kind: NameKind) -> Option<ObjectKind> {
    Some(match kind {
        NameKind::Table => ObjectKind::Table,
        NameKind::View => ObjectKind::View,
        NameKind::Matview => ObjectKind::Matview,
        NameKind::Routine => ObjectKind::Routine,
        NameKind::Sequence => ObjectKind::Sequence,
        NameKind::Column => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(names: &[(&str, NameKind, &str)]) -> NameIndex {
        NameIndex {
            entries: names
                .iter()
                .map(|(name, kind, schema)| Entry::new(*kind, schema, name, None, ""))
                .collect(),
            columns: false,
            cut: false,
        }
    }

    fn names(index: &NameIndex, query: &str) -> Vec<String> {
        search(index, query, &Context::default(), DbKind::Postgres)
            .hits
            .into_iter()
            .map(|h| h.name)
            .collect()
    }

    const T: NameKind = NameKind::Table;

    #[test]
    fn reads_the_small_query_language() {
        assert_eq!(
            parse("  Orders "),
            Query {
                kinds: None,
                scope: None,
                text: fold("orders")
            }
        );
        let q = parse("t: sales.ord");
        assert_eq!(
            q.kinds,
            Some(vec![NameKind::Table, NameKind::View, NameKind::Matview])
        );
        assert_eq!(q.scope, Some(fold("sales")));
        assert_eq!(q.text, fold("ord"));
        assert_eq!(parse("c:orders.cust").kinds, Some(vec![NameKind::Column]));
        assert_eq!(parse("f:twice").kinds, Some(vec![NameKind::Routine]));
        assert_eq!(parse("s:").kinds, Some(vec![NameKind::Sequence]));
        assert_eq!(
            parse("v:x").kinds,
            Some(vec![NameKind::View, NameKind::Matview])
        );
        // an unknown prefix is text; a dot at the start asks for nothing special
        assert_eq!(parse("x:y").text, fold("x:y"));
        assert_eq!(
            parse(".ord"),
            Query {
                kinds: None,
                scope: None,
                text: fold("ord")
            }
        );
        // a long query is cut, never refused
        assert_eq!(parse(&"a".repeat(5000)).text.len(), MAX_QUERY);
    }

    /// The ranking catalog: a query and the names it must find, the best first.
    #[test]
    fn ranks_as_the_catalog_says() {
        let i = index(&[
            ("order_items", T, "shop"),
            ("orders", T, "shop"),
            ("OrderItems", T, "legacy"),
            ("customer_orders", T, "shop"),
            ("reorder_points", T, "shop"),
            ("customers", T, "shop"),
            ("product", T, "shop"),
            ("audit_log", T, "shop"),
            ("x_o_r_d", T, "shop"),
        ]);
        let cases: &[(&str, &[&str])] = &[
            // exact, then what holds the word, then what is one typo away (`order`)
            (
                "orders",
                &[
                    "orders",
                    "customer_orders",
                    "OrderItems",
                    "order_items",
                    "reorder_points",
                ],
            ),
            // the start (short names first), starts of words, a word inside, a part of a word
            (
                "ord",
                &[
                    "orders",
                    "OrderItems",
                    "order_items",
                    "x_o_r_d",
                    "customer_orders",
                    "reorder_points",
                ],
            ),
            // starts of words, with and without the separator; scattered letters come last
            ("ord_it", &["OrderItems", "order_items", "reorder_points"]),
            ("ordit", &["OrderItems", "order_items", "reorder_points"]),
            ("oi", &["OrderItems", "order_items", "reorder_points"]),
            ("co", &["customer_orders", "customers"]),
            ("rp", &["reorder_points"]),
            // a part of the name
            ("tem", &["OrderItems", "order_items"]),
            // typos: two letters swapped, one missing, one wrong
            (
                "ordres",
                &["orders", "customer_orders", "OrderItems", "order_items"],
            ),
            ("custmers", &["customers", "customer_orders"]),
            ("prodcut", &["product"]),
            ("adit", &["audit_log"]),
            // nothing
            ("zzz", &[]),
        ];
        let mut wrong = Vec::new();
        for (query, expected) in cases {
            let found = names(&i, query);
            if &found != expected {
                wrong.push(format!("{query}: {found:?}"));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    #[test]
    fn marks_what_matched() {
        let marks = |query: &str, name: &str| {
            let e = Entry::new(T, "s", name, None, "");
            score(&fold(query), &e.folded, &e.starts, e.mask).map(|s| s.1)
        };
        assert_eq!(marks("ord", "orders"), Some(vec![0, 1, 2]));
        assert_eq!(marks("ord_it", "order_items"), Some(vec![0, 1, 2, 6, 7]));
        assert_eq!(marks("oi", "OrderItems"), Some(vec![0, 5]));
        assert_eq!(marks("tem", "order_items"), Some(vec![7, 8, 9]));
        // umlauts and capitals: the indices are those of the characters of the name
        assert_eq!(marks("ße", "Größe"), Some(vec![3, 4]));
        assert_eq!(marks("grö", "Größe 1"), Some(vec![0, 1, 2]));
        assert_eq!(marks("zzz", "orders"), None);
    }

    #[test]
    fn prefers_the_current_schema_and_what_was_chosen_lately() {
        let i = index(&[
            ("orders", T, "archive"),
            ("orders", T, "shop"),
            ("orders", T, "zeta"),
        ]);
        let schemas = |context: &Context| -> Vec<String> {
            search(&i, "orders", context, DbKind::Postgres)
                .hits
                .into_iter()
                .map(|h| h.schema)
                .collect()
        };
        assert_eq!(schemas(&Context::default()), ["archive", "shop", "zeta"]);
        let here = Context {
            current_schema: "shop".into(),
            recent: vec![],
        };
        assert_eq!(schemas(&here)[0], "shop");
        let lately = Context {
            current_schema: "shop".into(),
            recent: vec!["zeta.orders".into()],
        };
        assert_eq!(schemas(&lately), ["zeta", "shop", "archive"]);
    }

    #[test]
    fn filters_by_kind_and_scope_and_quotes_what_it_hands_out() {
        let mut i = index(&[
            ("orders", T, "shop"),
            ("orders", NameKind::View, "reports"),
            ("order_total", NameKind::Routine, "shop"),
            ("Odd Name", T, "shop"),
        ]);
        i.entries.push(Entry::new(
            NameKind::Column,
            "shop",
            "order_id",
            Some("items"),
            "integer",
        ));
        i.entries.push(Entry::new(
            NameKind::Column,
            "shop",
            "id",
            Some("orders"),
            "integer",
        ));
        // columns only when asked for
        assert_eq!(names(&i, "ord"), ["orders", "orders", "order_total"]);
        assert_eq!(names(&i, "f:ord"), ["order_total"]);
        assert_eq!(names(&i, "v:ord"), ["orders"]);
        assert_eq!(names(&i, "rep.ord"), ["orders"]);
        assert_eq!(names(&i, "c:ord"), ["order_id"]);
        // in front of the dot of a column: its table
        assert_eq!(names(&i, "c:orders."), ["id"]);
        let hits = search(&i, "odd", &Context::default(), DbKind::Postgres);
        assert_eq!(hits.hits[0].quoted, "shop.\"Odd Name\"");
        assert_eq!(hits.hits[0].quoted_name, "\"Odd Name\"");
        let column = search(&i, "c:order_id", &Context::default(), DbKind::Postgres);
        assert_eq!(column.hits[0].quoted, "order_id");
        assert_eq!(column.hits[0].parent.as_deref(), Some("items"));
        // an empty query lists what there is, tables first
        let all = search(&i, "", &Context::default(), DbKind::Postgres);
        assert_eq!(all.total, 4);
        assert_eq!(all.hits[0].kind, T);
        assert_eq!(all.indexed, 6);
    }

    #[test]
    fn hands_out_a_bounded_list_and_says_how_many_there_are() {
        let many: Vec<(String, NameKind, &str)> = (0..5000)
            .map(|n| (format!("table_{n:05}"), T, "s"))
            .collect();
        let refs: Vec<(&str, NameKind, &str)> =
            many.iter().map(|(n, k, s)| (n.as_str(), *k, *s)).collect();
        let hits = search(
            &index(&refs),
            "table",
            &Context::default(),
            DbKind::Postgres,
        );
        assert_eq!(hits.hits.len(), MAX_HITS);
        assert_eq!(hits.total, 5000);
        assert_eq!(hits.hits[0].name, "table_00000");
    }

    #[test]
    fn two_hundred_thousand_names_are_searched_at_once() {
        let words = [
            "order", "item", "customer", "invoice", "product", "audit", "stock", "price",
        ];
        let mut entries = Vec::with_capacity(200_000);
        for n in 0..200_000usize {
            let name = format!("{}_{}_{}", words[n % 8], words[(n / 8) % 8], n);
            entries.push(Entry::new(
                T,
                &format!("schema_{}", n % 40),
                &name,
                None,
                "",
            ));
        }
        let i = NameIndex {
            entries,
            columns: false,
            cut: false,
        };
        let mut slowest = Duration::ZERO;
        for query in [
            "o",
            "ord",
            "ord_it",
            "custmer",
            "invoice_product_1999",
            "s:x",
            "schema_7.pri",
        ] {
            let started = std::time::Instant::now();
            let hits = search(&i, query, &Context::default(), DbKind::Postgres);
            eprintln!(
                "{query}: {:?}, {} of {}",
                started.elapsed(),
                hits.hits.len(),
                hits.total
            );
            slowest = slowest.max(started.elapsed());
            assert!(hits.hits.len() <= MAX_HITS);
        }
        // measured on the machine of the design: 2–69 ms optimised, up to 0.7 s in this unoptimised
        // test build – the bound is for the latter
        eprintln!("slowest of 7 searches over 200 000 names: {slowest:?}");
        assert!(slowest < Duration::from_millis(1500), "{slowest:?}");
    }

    #[test]
    fn reads_the_names_of_the_demo_database() {
        let mut s = crate::db::sqlite::open(&crate::db::sqlite::demo_profile()).unwrap();
        s.execute_batch_for_tests(
            "CREATE TABLE n_order_items (id INTEGER PRIMARY KEY, order_id INTEGER);
             CREATE VIEW n_open_orders AS SELECT id FROM n_order_items;",
        );
        let mut i = read_objects(&mut s, DbKind::Sqlite, &|| false).unwrap();
        assert!(!i.columns);
        assert_eq!(names(&i, "n_ord_it"), ["n_order_items"]);
        assert_eq!(names(&i, "v:n_open"), ["n_open_orders"]);
        // columns come when they are asked for
        assert!(names(&i, "c:order_id").is_empty());
        read_columns(&mut s, DbKind::Sqlite, &mut i, &|| false).unwrap();
        assert!(i.columns);
        let hits = search(
            &i,
            "c:n_order_items.ord",
            &Context::default(),
            DbKind::Sqlite,
        );
        assert_eq!(hits.hits[0].name, "order_id");
        assert_eq!(hits.hits[0].detail, "INTEGER");
    }
}
