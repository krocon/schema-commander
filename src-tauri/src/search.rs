//! Searching in a result (prompt 029): which cells hold a text, and where the next cell with another
//! value or the next NULL is. Works over the result store, a stretch of rows at a time, so that the first
//! hits are there at once and a result of millions of rows is counted on while the user reads. Pure (no
//! Tauri), tested below.
//!
//! Every search is a regular expression of the `regex` crate: its matching takes time linear in the text,
//! whatever the pattern (no backtracking), and a pattern that would compile into too large a program is
//! refused. A plain text is escaped into one.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::results::ResultStore;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A pattern longer than this is refused.
pub const MAX_PATTERN_CHARS: usize = 2_000;
/// The compiled program of a pattern may take this much memory.
const MAX_PROGRAM_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSpec {
    pub text: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
    /// Indices of result columns to look in; empty = all.
    #[serde(default)]
    pub columns: Vec<usize>,
}

/// What a stretch of rows brought.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// The cells that hold the text: `[row, column]`, in reading order.
    pub hits: Vec<[u64; 2]>,
    /// The row to go on from.
    pub next: u64,
    /// The end of the result was reached.
    pub done: bool,
}

/// The pattern of a spec; `invalid_query` with what is wrong about it.
pub fn matcher(spec: &SearchSpec) -> AppResult<Regex> {
    let bad = |why: String| AppError::new(ErrorCode::InvalidQuery, why);
    if spec.text.is_empty() {
        return Err(bad("nothing to search for".into()));
    }
    if spec.text.chars().count() > MAX_PATTERN_CHARS {
        return Err(bad("the pattern is too long".into()));
    }
    let core = if spec.regex {
        spec.text.clone()
    } else {
        regex::escape(&spec.text)
    };
    let pattern = if spec.whole_word {
        format!(r"\b(?:{core})\b")
    } else {
        core
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!spec.case_sensitive)
        .size_limit(MAX_PROGRAM_BYTES)
        .build()
        .map_err(|e| match e {
            regex::Error::CompiledTooBig(_) => bad("the pattern is too large".into()),
            // the first line of what the parser says names the fault; the rest draws the pattern
            other => bad(other
                .to_string()
                .lines()
                .rev()
                .find(|l| l.starts_with("error:"))
                .map(|l| l.trim_start_matches("error:").trim().to_string())
                .unwrap_or_else(|| "not a regular expression".into())),
        })
}

/// The text of a cell as it is searched: texts as they are, numbers and truth values as written. NULL
/// and binary data hold no text.
fn text_of(cell: &Value) -> Option<std::borrow::Cow<'_, str>> {
    match cell {
        Value::String(s) => Some(s.as_str().into()),
        Value::Number(n) => Some(n.to_string().into()),
        Value::Bool(b) => Some(if *b { "true" } else { "false" }.into()),
        _ => None,
    }
}

fn damaged(e: serde_json::Error) -> AppError {
    AppError::new(ErrorCode::Io, format!("a stored row is damaged: {e}"))
}

/// Looks through the rows from `from` on: until `max_rows` rows were read, `max_hits` cells were found
/// (the row they are in is finished first) or the result ends. `stop` is asked now and then.
pub fn search(
    store: &ResultStore,
    result_id: u64,
    spec: &SearchSpec,
    from: u64,
    max_rows: u64,
    max_hits: usize,
    stop: &dyn Fn() -> bool,
) -> AppResult<Found> {
    let re = matcher(spec)?;
    let total = store.rows(result_id)?;
    let width = store.columns(result_id)?.len();
    let columns: Vec<usize> = if spec.columns.is_empty() {
        (0..width).collect()
    } else {
        let mut c: Vec<usize> = spec
            .columns
            .iter()
            .copied()
            .filter(|c| *c < width)
            .collect();
        c.sort_unstable();
        c.dedup();
        c
    };
    let to = total.min(from.saturating_add(max_rows.max(1)));
    let mut hits: Vec<[u64; 2]> = Vec::new();
    let mut row = from;
    let mut failed: Option<AppError> = None;
    store.each_row(result_id, from, to, &mut |line| {
        if (row - from).is_multiple_of(1024) && stop() {
            failed = Some(crate::db::cancelled());
            return false;
        }
        let cells: Vec<Value> = match serde_json::from_str(line) {
            Ok(cells) => cells,
            Err(e) => {
                failed = Some(damaged(e));
                return false;
            }
        };
        for &c in &columns {
            if let Some(text) = cells.get(c).and_then(text_of)
                && re.is_match(&text)
            {
                hits.push([row, c as u64]);
            }
        }
        row += 1;
        hits.len() < max_hits
    })?;
    if let Some(e) = failed {
        return Err(e);
    }
    Ok(Found {
        hits,
        next: row,
        done: row >= total,
    })
}

/// What to look for down a column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Seek {
    /// The next cell whose value differs from the one in `from`.
    Change,
    /// The next cell that is NULL.
    Null,
}

/// The row below `from` in column `col` that is what `seek` asks for; `None` if there is none.
pub fn seek(
    store: &ResultStore,
    result_id: u64,
    col: usize,
    from: u64,
    seek: Seek,
    stop: &dyn Fn() -> bool,
) -> AppResult<Option<u64>> {
    let total = store.rows(result_id)?;
    if col >= store.columns(result_id)?.len() || from >= total {
        return Ok(None);
    }
    let mut start: Option<Value> = None;
    let mut row = from;
    let mut found = None;
    let mut failed: Option<AppError> = None;
    store.each_row(result_id, from, total, &mut |line| {
        if (row - from).is_multiple_of(1024) && stop() {
            failed = Some(crate::db::cancelled());
            return false;
        }
        let mut cells: Vec<Value> = match serde_json::from_str(line) {
            Ok(cells) => cells,
            Err(e) => {
                failed = Some(damaged(e));
                return false;
            }
        };
        let cell = if col < cells.len() {
            cells.swap_remove(col)
        } else {
            Value::Null
        };
        if row == from {
            start = Some(cell);
        } else if match seek {
            Seek::Null => cell.is_null(),
            Seek::Change => start.as_ref() != Some(&cell),
        } {
            found = Some(row);
            return false;
        }
        row += 1;
        true
    })?;
    match failed {
        Some(e) => Err(e),
        None => Ok(found),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::value::{Cell, ColKind, Column, RowSink};
    use crate::results::{Progress, StoreSink};
    use tempfile::tempdir;

    fn store_with(width: usize, rows: Vec<Vec<Cell>>) -> (tempfile::TempDir, ResultStore, u64) {
        let dir = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let report = |_: Progress| {};
        let id = {
            let mut sink = StoreSink::new(&store, &report);
            let columns: Vec<Column> = (0..width)
                .map(|c| Column {
                    name: format!("c{c}"),
                    kind: ColKind::Text,
                    type_name: String::new(),
                })
                .collect();
            sink.start(&columns);
            for row in rows {
                assert!(sink.row(row));
            }
            sink.finish();
            sink.result_id().unwrap()
        };
        (dir, store, id)
    }

    fn text(s: &str) -> Cell {
        Cell::Text(s.into())
    }

    fn spec(text: &str) -> SearchSpec {
        SearchSpec {
            text: text.into(),
            ..SearchSpec::default()
        }
    }

    fn all(store: &ResultStore, id: u64, spec: &SearchSpec) -> Vec<[u64; 2]> {
        let found = search(store, id, spec, 0, u64::MAX, usize::MAX, &|| false).unwrap();
        assert!(found.done);
        found.hits
    }

    fn sample() -> (tempfile::TempDir, ResultStore, u64) {
        store_with(
            3,
            vec![
                vec![text("Köln"), Cell::I64(1042), text("paid in full")],
                vec![text("KÖLN-Süd"), Cell::Null, text("a.b")],
                vec![text("Bonn 😀 \"quoted\"\tTab"), Cell::I64(42), text("axb")],
                vec![text("straße"), Cell::Bool(true), text("Paid")],
            ],
        )
    }

    #[test]
    fn finds_text_whatever_its_case_unless_asked() {
        let (_d, store, id) = sample();
        assert_eq!(all(&store, id, &spec("köln")), vec![[0, 0], [1, 0]]);
        let exact = SearchSpec {
            case_sensitive: true,
            ..spec("Köln")
        };
        assert_eq!(all(&store, id, &exact), vec![[0, 0]]);
        // numbers and truth values as they are written; NULL holds nothing
        assert_eq!(all(&store, id, &spec("42")), vec![[0, 1], [2, 1]]);
        assert_eq!(all(&store, id, &spec("true")), vec![[3, 1]]);
        assert_eq!(all(&store, id, &spec("null")), Vec::<[u64; 2]>::new());
        // what JSON escapes is found as the text it is
        assert_eq!(all(&store, id, &spec("\"quoted\"\tTab")), vec![[2, 0]]);
        assert_eq!(all(&store, id, &spec("😀")), vec![[2, 0]]);
        // a plain text is no pattern: the dot is a dot
        assert_eq!(all(&store, id, &spec("a.b")), vec![[1, 2]]);
    }

    #[test]
    fn whole_words_patterns_and_columns() {
        let (_d, store, id) = sample();
        let word = SearchSpec {
            whole_word: true,
            ..spec("paid")
        };
        assert_eq!(all(&store, id, &word), vec![[0, 2], [3, 2]]);
        let word42 = SearchSpec {
            whole_word: true,
            ..spec("42")
        };
        assert_eq!(all(&store, id, &word42), vec![[2, 1]]);
        // words end where letters end, in any script
        let koeln = SearchSpec {
            whole_word: true,
            ..spec("köln")
        };
        assert_eq!(all(&store, id, &koeln), vec![[0, 0], [1, 0]]);
        let pattern = SearchSpec {
            regex: true,
            ..spec(r"^a.b$")
        };
        assert_eq!(all(&store, id, &pattern), vec![[1, 2], [2, 2]]);
        let in_column = SearchSpec {
            columns: vec![2, 2, 9],
            ..spec("a")
        };
        assert_eq!(
            all(&store, id, &in_column),
            vec![[0, 2], [1, 2], [2, 2], [3, 2]]
        );
    }

    #[test]
    fn a_bad_pattern_says_what_is_wrong_and_big_ones_are_refused() {
        let bad = |text: &str| {
            matcher(&SearchSpec {
                regex: true,
                ..spec(text)
            })
            .unwrap_err()
        };
        let e = bad("a(b");
        assert_eq!(e.code, ErrorCode::InvalidQuery);
        assert!(e.message.contains("unclosed group"), "{}", e.message);
        assert!(!e.message.contains('\n'));
        assert_eq!(bad("").code, ErrorCode::InvalidQuery);
        // no backreferences, no lookaround: the price of linear time
        assert_eq!(bad(r"(a)\1").code, ErrorCode::InvalidQuery);
        assert_eq!(
            bad(&"a".repeat(MAX_PATTERN_CHARS + 1)).code,
            ErrorCode::InvalidQuery
        );
        assert_eq!(
            bad(r"(\pL{50}){50}{50}").message,
            "the pattern is too large"
        );
        // the classic of backtracking engines ends at once here
        let (_d, store, id) = store_with(1, vec![vec![text(&format!("{}!", "a".repeat(5000)))]]);
        let evil = SearchSpec {
            regex: true,
            ..spec("^(a+)+$")
        };
        let start = std::time::Instant::now();
        assert!(all(&store, id, &evil).is_empty());
        assert!(start.elapsed().as_secs() < 2);
    }

    #[test]
    fn reads_a_stretch_at_a_time_and_stops_when_asked() {
        let rows = (0..5000)
            .map(|i| vec![text(if i % 100 == 7 { "needle" } else { "hay" })])
            .collect();
        let (_d, store, id) = store_with(1, rows);
        let needle = spec("needle");
        let first = search(&store, id, &needle, 0, 1000, 100, &|| false).unwrap();
        assert_eq!(first.hits.len(), 10);
        assert_eq!((first.next, first.done), (1000, false));
        // enough hits end a stretch early, after the row of the last one
        let few = search(&store, id, &needle, 0, 5000, 3, &|| false).unwrap();
        assert_eq!(few.hits, vec![[7, 0], [107, 0], [207, 0]]);
        assert_eq!((few.next, few.done), (208, false));
        let rest = search(&store, id, &needle, few.next, u64::MAX, usize::MAX, &|| {
            false
        })
        .unwrap();
        assert_eq!(rest.hits.len(), 47);
        assert!(rest.done);
        let beyond = search(&store, id, &needle, 9000, 10, 10, &|| false).unwrap();
        assert_eq!((beyond.hits.len(), beyond.done), (0, true));
        let stopped = search(&store, id, &needle, 0, 5000, 100, &|| true).unwrap_err();
        assert_eq!(stopped.code, ErrorCode::Cancelled);
        assert_eq!(
            search(&store, 99, &needle, 0, 10, 10, &|| false)
                .unwrap_err()
                .code,
            ErrorCode::UnknownResult
        );
    }

    /// How long a big result takes (`cargo test --lib search::tests::big -- --ignored --nocapture`).
    #[test]
    #[ignore = "a measurement, not a check"]
    fn big_result_is_searched_in_a_time_one_can_wait() {
        let rows = (0..1_000_000)
            .map(|i| {
                vec![
                    Cell::I64(i),
                    text(if i % 1000 == 7 {
                        "a needle"
                    } else {
                        "some hay in a row"
                    }),
                    text("more text that is not it"),
                ]
            })
            .collect();
        let (_d, store, id) = store_with(3, rows);
        let start = std::time::Instant::now();
        let first = search(&store, id, &spec("needle"), 0, 5_000, 5_000, &|| false).unwrap();
        let first_ms = start.elapsed();
        let rest = search(
            &store,
            id,
            &spec("needle"),
            first.next,
            u64::MAX,
            usize::MAX,
            &|| false,
        )
        .unwrap();
        eprintln!(
            "first 5000 rows: {first_ms:?} ({} hits); 1 million rows: {:?} ({} hits)",
            first.hits.len(),
            start.elapsed(),
            first.hits.len() + rest.hits.len()
        );
        assert_eq!(first.hits.len() + rest.hits.len(), 1000);
    }

    #[test]
    fn seeks_the_next_other_value_and_the_next_null() {
        let rows = vec![
            vec![text("a"), Cell::I64(1)],
            vec![text("a"), Cell::Null],
            vec![text("a"), Cell::I64(1)],
            vec![text("b"), Cell::Null],
            vec![Cell::Null, Cell::I64(2)],
        ];
        let (_d, store, id) = store_with(2, rows);
        let go = |col, from, what| seek(&store, id, col, from, what, &|| false).unwrap();
        assert_eq!(go(0, 0, Seek::Change), Some(3));
        assert_eq!(go(0, 3, Seek::Change), Some(4));
        assert_eq!(go(0, 4, Seek::Change), None);
        assert_eq!(go(0, 0, Seek::Null), Some(4));
        assert_eq!(go(1, 0, Seek::Null), Some(1));
        // from a NULL the next NULL is another row, and „another value“ is the next that is not NULL
        assert_eq!(go(1, 1, Seek::Null), Some(3));
        assert_eq!(go(1, 1, Seek::Change), Some(2));
        assert_eq!(go(1, 4, Seek::Null), None);
        assert_eq!(go(7, 0, Seek::Null), None);
        assert_eq!(go(0, 99, Seek::Null), None);
        assert_eq!(
            seek(&store, id, 0, 0, Seek::Change, &|| true)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
    }
}
