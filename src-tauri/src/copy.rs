//! A part of a result as text (prompt 009): which rows and columns, in which format. The rows are read from
//! the result store, whole, a chunk at a time; the work can be stopped and has a size limit. Pure of Tauri
//! and of the clipboard – `commands.rs` puts the text there.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::extract::{Extractor, Format, Options};
use crate::results::ResultStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Text for the clipboard at most. More is a file (export, prompt 011).
pub const MAX_COPY_BYTES: usize = 256 * 1024 * 1024;

/// What to copy. Nothing named means everything: no rows = all rows, no columns = all columns.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Selection {
    /// Ranges of rows, first and last, both included.
    pub rows: Vec<(u64, u64)>,
    /// Indices of columns.
    pub columns: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Copied {
    pub rows: u64,
    pub columns: usize,
    /// Characters of the text.
    pub chars: u64,
}

/// The ranges sorted, inside `0..total`, without overlap – each row is copied once, in its order.
pub fn merge_rows(ranges: &[(u64, u64)], total: u64) -> Vec<(u64, u64)> {
    if total == 0 {
        return Vec::new();
    }
    if ranges.is_empty() {
        return vec![(0, total - 1)];
    }
    let mut sorted: Vec<(u64, u64)> = ranges
        .iter()
        .map(|&(a, b)| (a.min(b), a.max(b).min(total - 1)))
        .filter(|&(a, _)| a < total)
        .collect();
    sorted.sort_unstable();
    let mut out: Vec<(u64, u64)> = Vec::new();
    for (a, b) in sorted {
        match out.last_mut() {
            Some(last) if a <= last.1.saturating_add(1) => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

/// The columns in the order they are named (the grid may show them in another order than the result,
/// prompt 029), each once, only those that exist; none named = all.
pub fn pick_columns(columns: &[usize], count: usize) -> Vec<usize> {
    if columns.is_empty() {
        return (0..count).collect();
    }
    let mut out: Vec<usize> = Vec::with_capacity(columns.len().min(count));
    for &c in columns {
        if c < count && !out.contains(&c) {
            out.push(c);
        }
    }
    out
}

/// The selected part of a result as text. `stop` ends the work with `cancelled`; text beyond
/// [`MAX_COPY_BYTES`] ends it with `too_large`.
pub fn render(
    store: &ResultStore,
    result_id: u64,
    selection: &Selection,
    format: Format,
    options: Options,
    stop: &dyn Fn() -> bool,
) -> AppResult<(String, Copied)> {
    let all = store.columns(result_id)?;
    let picked = pick_columns(&selection.columns, all.len());
    let columns = picked.iter().map(|&c| all[c].clone()).collect::<Vec<_>>();
    let ranges = merge_rows(&selection.rows, store.rows(result_id)?);
    let mut extractor = Extractor::new(format, options, columns);
    let mut out = String::new();
    extractor.begin(&mut out);
    let mut failed: Option<AppError> = None;
    let mut count: u64 = 0;
    for (first, last) in ranges {
        store.each_row(result_id, first, last + 1, &mut |row| {
            count += 1;
            if count.is_multiple_of(512) && stop() {
                failed = Some(crate::db::cancelled());
                return false;
            }
            let cells: Vec<Value> = match serde_json::from_str(row) {
                Ok(cells) => cells,
                Err(e) => {
                    failed = Some(AppError::new(
                        ErrorCode::Io,
                        format!("a stored row is damaged: {e}"),
                    ));
                    return false;
                }
            };
            let null = Value::Null;
            let projected: Vec<Value> = picked
                .iter()
                .map(|&c| cells.get(c).unwrap_or(&null).clone())
                .collect();
            extractor.row(&projected, &mut out);
            if out.len() > MAX_COPY_BYTES {
                failed = Some(AppError::new(
                    ErrorCode::TooLarge,
                    format!(
                        "more than {} MB of text: too much for the clipboard",
                        MAX_COPY_BYTES / (1024 * 1024)
                    ),
                ));
                return false;
            }
            true
        })?;
        if failed.is_some() {
            break;
        }
    }
    if let Some(e) = failed {
        return Err(e);
    }
    extractor.end(&mut out);
    let copied = Copied {
        rows: extractor.rows(),
        columns: picked.len(),
        chars: out.chars().count() as u64,
    };
    Ok((out, copied))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::value::{Cell, ColKind, Column, RowSink};
    use crate::results::{Progress, StoreSink};
    use std::sync::atomic::{AtomicU64, Ordering};
    use tempfile::tempdir;

    fn fill(store: &ResultStore, rows: u64) -> u64 {
        let quiet = |_: Progress| {};
        let mut sink = StoreSink::new(store, &quiet);
        sink.start(&[
            Column {
                name: "id".into(),
                kind: ColKind::Int,
                type_name: "INT".into(),
            },
            Column {
                name: "name".into(),
                kind: ColKind::Text,
                type_name: "TEXT".into(),
            },
            Column {
                name: "note".into(),
                kind: ColKind::Text,
                type_name: "TEXT".into(),
            },
        ]);
        for i in 0..rows {
            let note = if i % 2 == 0 {
                Cell::Null
            } else {
                Cell::Text("x".repeat(3000))
            };
            assert!(sink.row(vec![Cell::I64(i as i64), Cell::Text(format!("n{i}")), note]));
        }
        sink.finish();
        sink.result_id().unwrap()
    }

    fn options() -> Options {
        Options {
            header: false,
            null_as: "NULL".into(),
            ..Options::default()
        }
    }

    #[test]
    fn merges_and_clamps_row_ranges() {
        assert_eq!(merge_rows(&[], 5), vec![(0, 4)]);
        assert_eq!(merge_rows(&[], 0), vec![]);
        assert_eq!(
            merge_rows(&[(3, 1), (2, 6), (8, 8), (9, 20), (50, 60)], 12),
            vec![(1, 6), (8, 11)]
        );
        assert_eq!(merge_rows(&[(4, 4), (0, 0)], 5), vec![(0, 0), (4, 4)]);
    }

    #[test]
    fn picks_columns_once_and_only_real_ones() {
        assert_eq!(pick_columns(&[], 3), vec![0, 1, 2]);
        assert_eq!(pick_columns(&[2, 0, 2, 9], 3), vec![2, 0]);
    }

    #[test]
    fn copies_the_selected_rows_and_columns_whole() {
        let dir = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let id = fill(&store, 10);
        let selection = Selection {
            rows: vec![(7, 8), (1, 2)],
            columns: vec![1, 0],
        };
        let (text, copied) =
            render(&store, id, &selection, Format::Tsv, options(), &|| false).unwrap();
        assert_eq!(text, "n1\t1\nn2\t2\nn7\t7\nn8\t8");
        assert_eq!((copied.rows, copied.columns), (4, 2));
        // a long text is copied whole, though a window shows only its start
        let one = Selection {
            rows: vec![(1, 1)],
            columns: vec![2],
        };
        let (text, _) = render(&store, id, &one, Format::Values, options(), &|| false).unwrap();
        assert_eq!(text.len(), 3000);
        let (all, copied) = render(
            &store,
            id,
            &Selection::default(),
            Format::Csv,
            options(),
            &|| false,
        )
        .unwrap();
        assert_eq!(copied.rows, 10);
        assert!(all.starts_with("0,n0,NULL\n1,n1,xxx"));
    }

    #[test]
    fn copies_across_the_chunks_of_a_big_result_and_can_be_stopped() {
        let dir = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let id = fill(&store, 5000);
        let selection = Selection {
            rows: vec![(998, 2002)],
            columns: vec![0],
        };
        let (text, copied) =
            render(&store, id, &selection, Format::Values, options(), &|| false).unwrap();
        assert_eq!(copied.rows, 1005);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!((lines[0], lines[1004]), ("998", "2002"));

        let asked = AtomicU64::new(0);
        let stop = || asked.fetch_add(1, Ordering::Relaxed) >= 2;
        let e = render(
            &store,
            id,
            &Selection::default(),
            Format::Tsv,
            options(),
            &stop,
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::Cancelled);
    }

    #[test]
    fn a_result_that_is_gone_is_an_error() {
        let dir = tempdir().unwrap();
        let store = ResultStore::new(dir.path());
        let e = render(
            &store,
            99,
            &Selection::default(),
            Format::Tsv,
            options(),
            &|| false,
        )
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::UnknownResult);
    }
}
