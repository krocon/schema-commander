use super::*;
use crate::db::value::{Cell, RowSink};
use crate::results::{Progress, StoreSink};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use tempfile::tempdir;

fn col(name: &str, kind: ColKind) -> Column {
    Column {
        name: name.into(),
        kind,
        type_name: String::new(),
    }
}

fn fill(store: &ResultStore, columns: &[Column], rows: Vec<Vec<Cell>>) -> u64 {
    let quiet = |_: Progress| {};
    let mut sink = StoreSink::new(store, &quiet);
    sink.start(columns);
    for row in rows {
        assert!(sink.row(row));
    }
    sink.finish();
    sink.result_id().unwrap()
}

fn people(store: &ResultStore, rows: &[(i64, &str, &str)]) -> u64 {
    fill(
        store,
        &[
            col("id", ColKind::Int),
            col("name", ColKind::Text),
            col("amount", ColKind::Decimal),
        ],
        rows.iter()
            .map(|(id, name, amount)| {
                vec![
                    Cell::I64(*id),
                    Cell::Text((*name).into()),
                    Cell::Decimal((*amount).into()),
                ]
            })
            .collect(),
    )
}

fn run(store: &ResultStore, spec: &CompareSpec) -> CompareReport {
    compare(store, spec, &|_, _| {}, &|| false).unwrap()
}

fn rows_of(store: &ResultStore, id: u64) -> Vec<Value> {
    let mut out = Vec::new();
    let n = store.rows(id).unwrap();
    store
        .each_row(id, 0, n, &mut |row| {
            out.push(serde_json::from_str(row).unwrap());
            true
        })
        .unwrap();
    out
}

fn keyed(left: u64, right: u64) -> CompareSpec {
    CompareSpec {
        left,
        right,
        keys: vec![0],
        ..Default::default()
    }
}

#[test]
fn rows_are_matched_by_their_key_whatever_their_order() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let left = people(
        &store,
        &[(1, "Ada", "1.50"), (2, "Bob", "2"), (3, "Cy", "3")],
    );
    let right = people(
        &store,
        &[(4, "Dee", "4"), (3, "Cy", "3"), (2, "Bobby", "2")],
    );
    let report = run(&store, &keyed(left, right));
    assert_eq!(
        (
            report.same,
            report.changed,
            report.left_only,
            report.right_only
        ),
        (1, 1, 1, 1)
    );
    assert_eq!(report.rows, 5);
    assert_eq!(report.diff_rows, 4);
    assert_eq!(
        report.changed_by_column,
        vec![ColumnCount {
            name: "name".into(),
            rows: 1
        }]
    );
    let rows = rows_of(&store, report.result_id);
    assert_eq!(rows[0], json!(["←", null, 1, "Ada", "1.50"]));
    assert_eq!(rows[1], json!(["≠←", "name", 2, "Bob", "2"]));
    assert_eq!(rows[2], json!(["≠→", "name", 2, "Bobby", "2"]));
    assert_eq!(rows[3], json!(["≡", null, 3, "Cy", "3"]));
    assert_eq!(rows[4], json!(["→", null, 4, "Dee", "4"]));
    // the view shows the rows that differ, and is read like a result
    let diff = rows_of(&store, report.diff_id);
    assert_eq!(diff.len(), 4);
    assert_eq!(diff[3][0], json!("→"));
    assert_eq!(report.columns.len(), 5);
    assert_eq!(report.columns[0].name, STATE_COLUMN);
}

#[test]
fn a_key_that_is_there_twice_is_reported_and_matched_to_nothing() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let left = people(
        &store,
        &[(1, "Ada", "1"), (1, "Ada again", "1"), (2, "Bob", "2")],
    );
    let right = people(
        &store,
        &[
            (1, "Ada", "1"),
            (2, "Bob", "2"),
            (5, "x", "0"),
            (5, "y", "0"),
        ],
    );
    let report = run(&store, &keyed(left, right));
    assert_eq!(report.duplicate_left, 2);
    // the right row with key 1 has no partner it could be sure of; 5 is twice on the right
    assert_eq!(report.duplicate_right, 3);
    assert_eq!(report.same, 1);
    assert_eq!(
        (report.changed, report.left_only, report.right_only),
        (0, 0, 0)
    );
    assert_eq!(report.duplicate_keys, vec!["1".to_owned(), "5".to_owned()]);
    let states: Vec<String> = rows_of(&store, report.result_id)
        .iter()
        .map(|r| r[0].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(states, ["‼←", "‼←", "≡", "‼→", "‼→", "‼→"]);
}

#[test]
fn null_is_a_key_like_any_other_and_equal_only_to_null() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let columns = [col("k", ColKind::Text), col("v", ColKind::Text)];
    let left = fill(
        &store,
        &columns,
        vec![
            vec![Cell::Null, Cell::Text("a".into())],
            vec![Cell::Text("".into()), Cell::Null],
            vec![Cell::Text("NULL".into()), Cell::Text("c".into())],
        ],
    );
    let right = fill(
        &store,
        &columns,
        vec![
            vec![Cell::Text("NULL".into()), Cell::Text("c".into())],
            vec![Cell::Text("".into()), Cell::Text("".into())],
            vec![Cell::Null, Cell::Text("a".into())],
        ],
    );
    let report = run(&store, &keyed(left, right));
    assert_eq!((report.same, report.changed), (2, 1));
    assert_eq!(report.changed_by_column[0].name, "v");
}

#[test]
fn by_position_pairs_row_with_row() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let left = people(&store, &[(1, "Ada", "1"), (2, "Bob", "2"), (3, "Cy", "3")]);
    let right = people(&store, &[(1, "Ada", "1"), (9, "Bob", "2")]);
    let spec = CompareSpec {
        left,
        right,
        ..Default::default()
    };
    let report = run(&store, &spec);
    assert_eq!(
        (
            report.same,
            report.changed,
            report.left_only,
            report.right_only
        ),
        (1, 1, 1, 0)
    );
    assert_eq!(report.changed_by_column[0].name, "id");
    // and the other way round
    let report = run(
        &store,
        &CompareSpec {
            left: right,
            right: left,
            ..Default::default()
        },
    );
    assert_eq!((report.left_only, report.right_only), (0, 1));
}

#[test]
fn tolerances() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let left = people(
        &store,
        &[(1, " Ada ", "1.50"), (2, "BOB", "2.004"), (3, "Cy", "3")],
    );
    let right = people(
        &store,
        &[(1, "Ada", "1.5"), (2, "bob", "2.0"), (3, "Cy", "3.01")],
    );
    let exact = run(&store, &keyed(left, right));
    assert_eq!((exact.same, exact.changed), (0, 3));
    let trim = run(
        &store,
        &CompareSpec {
            trim: true,
            ..keyed(left, right)
        },
    );
    // 1.50 is not 1.5 as long as numbers are compared as written
    assert_eq!(trim.changed, 3);
    assert_eq!(
        trim.changed_by_column
            .iter()
            .map(|c| (c.name.as_str(), c.rows))
            .collect::<Vec<_>>(),
        [("name", 1), ("amount", 3)]
    );
    let loose = run(
        &store,
        &CompareSpec {
            trim: true,
            ignore_case: true,
            decimals: Some(2),
            ..keyed(left, right)
        },
    );
    assert_eq!((loose.same, loose.changed), (2, 1));
    let ignoring = run(
        &store,
        &CompareSpec {
            trim: true,
            ignore_case: true,
            decimals: Some(2),
            ignore: vec![2],
            ..keyed(left, right)
        },
    );
    assert_eq!((ignoring.same, ignoring.changed), (3, 0));
}

#[test]
fn numbers_are_rounded_as_text() {
    for (text, decimals, want) in [
        ("1.50", 2, Some("1.5")),
        ("1.005", 2, Some("1.01")),
        ("-1.005", 2, Some("-1.01")),
        ("0.004", 2, Some("0")),
        ("-0.004", 2, Some("0")),
        ("9.999", 2, Some("10")),
        ("99", 0, Some("99")),
        ("0.5", 0, Some("1")),
        ("007", 3, Some("7")),
        (".5", 1, Some("0.5")),
        ("1e3", 2, Some("1000")),
        ("1.5e-3", 3, Some("0.002")),
        ("0.30000000000000004", 6, Some("0.3")),
        (
            "123456789012345678901234567890.125",
            2,
            Some("123456789012345678901234567890.13"),
        ),
        ("abc", 2, None),
        ("", 2, None),
        ("NaN", 2, None),
        ("1.2.3", 2, None),
    ] {
        assert_eq!(round_number(text, decimals).as_deref(), want, "{text}");
    }
}

#[test]
fn columns_go_together_by_name_else_by_position() {
    let a = [
        col("ID", ColKind::Int),
        col("name", ColKind::Text),
        col("old", ColKind::Text),
    ];
    let b = [
        col("new", ColKind::Text),
        col("Name", ColKind::Text),
        col("id", ColKind::Int),
    ];
    let p = pair(&a, &b);
    assert_eq!(p.pairs, vec![(0, 2), (1, 1)]);
    assert_eq!(p.left_only, ["old"]);
    assert_eq!(p.right_only, ["new"]);
    assert!(!p.by_position);
    let c = [col("x", ColKind::Int), col("y", ColKind::Int)];
    let p = pair(&a, &c);
    assert!(p.by_position);
    assert_eq!(p.pairs, vec![(0, 0), (1, 1)]);
    assert_eq!(p.left_only, ["old"]);
    assert!(p.right_only.is_empty());
}

#[test]
fn a_key_must_be_a_column_of_both_results() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let left = people(&store, &[(1, "Ada", "1")]);
    let right = fill(&store, &[col("id", ColKind::Int)], vec![vec![Cell::I64(1)]]);
    let before = store.len();
    let failed = compare(
        &store,
        &CompareSpec {
            left,
            right,
            keys: vec![1],
            ..Default::default()
        },
        &|_, _| {},
        &|| false,
    );
    assert_eq!(failed.unwrap_err().code, ErrorCode::Unsupported);
    assert_eq!(store.len(), before);
}

#[test]
fn long_values_are_compared_whole() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let columns = [
        col("id", ColKind::Int),
        col("doc", ColKind::Text),
        col("raw", ColKind::Bytes),
    ];
    let long = "x".repeat(MAX_TEXT_CHARS + 100);
    let other = format!("{}y", "x".repeat(MAX_TEXT_CHARS + 99));
    let bytes = vec![7u8; 100];
    let mut bytes2 = bytes.clone();
    bytes2[99] = 8;
    let left = fill(
        &store,
        &columns,
        vec![
            vec![Cell::I64(1), Cell::Text(long.clone()), Cell::bytes(&bytes)],
            vec![Cell::I64(2), Cell::Text(long.clone()), Cell::bytes(&bytes)],
            vec![Cell::I64(3), Cell::Text(long.clone()), Cell::bytes(&bytes)],
        ],
    );
    let right = fill(
        &store,
        &columns,
        vec![
            vec![Cell::I64(1), Cell::Text(long.clone()), Cell::bytes(&bytes)],
            vec![Cell::I64(2), Cell::Text(other), Cell::bytes(&bytes)],
            vec![Cell::I64(3), Cell::Text(long), Cell::bytes(&bytes2)],
        ],
    );
    let report = run(&store, &keyed(left, right));
    assert_eq!((report.same, report.changed), (1, 2));
    assert_eq!(
        report
            .changed_by_column
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["doc", "raw"]
    );
}

#[test]
fn a_view_is_compared_like_a_result() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let left = people(&store, &[(1, "Ada", "1"), (2, "Bob", "2"), (3, "Cy", "3")]);
    let right = people(&store, &[(1, "Ada", "1"), (2, "Bob", "2"), (3, "Cy", "3")]);
    let some = store.subset(right, vec![2, 0]).unwrap();
    let report = run(&store, &keyed(left, some.result_id));
    assert_eq!((report.same, report.left_only), (2, 1));
}

#[test]
fn stopping_leaves_nothing_behind() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let rows: Vec<(i64, &str, &str)> = (0..10_000).map(|i| (i, "n", "1")).collect();
    let left = people(&store, &rows);
    let right = people(&store, &rows);
    let before = store.len();
    let failed = compare(&store, &keyed(left, right), &|_, _| {}, &|| true);
    assert_eq!(failed.unwrap_err().code, ErrorCode::Cancelled);
    assert_eq!(store.len(), before);
}

#[test]
fn the_next_difference_is_found_in_the_view() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let left = people(
        &store,
        &[(1, "a", "1"), (2, "b", "2"), (3, "c", "3"), (4, "d", "4")],
    );
    let right = people(
        &store,
        &[(1, "a", "1"), (2, "B", "2"), (3, "c", "3"), (4, "D", "4")],
    );
    let report = run(&store, &keyed(left, right));
    // rows: ≡, ≠←, ≠→, ≡, ≠←, ≠→
    assert_eq!(
        store.neighbour(report.diff_id, 0, true).unwrap(),
        Some((0, 1))
    );
    assert_eq!(
        store.neighbour(report.diff_id, 2, true).unwrap(),
        Some((2, 4))
    );
    assert_eq!(store.neighbour(report.diff_id, 5, true).unwrap(), None);
    assert_eq!(
        store.neighbour(report.diff_id, 4, false).unwrap(),
        Some((1, 2))
    );
    assert_eq!(store.neighbour(report.diff_id, 1, false).unwrap(), None);
}

/// The acceptance of prompt 041: two results of a million rows each, with differences that are known.
#[test]
fn a_million_rows_on_each_side() {
    const N: i64 = 1_000_000;
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let columns = [
        col("id", ColKind::Int),
        col("name", ColKind::Text),
        col("n", ColKind::Int),
    ];
    let side = |right: bool| {
        let quiet = |_: Progress| {};
        let mut sink = StoreSink::new(&store, &quiet);
        sink.start(&columns);
        for i in 0..N {
            // the right side: every 1000th row is missing, every 777th has another value, 500 rows
            // are new – and it comes in the opposite order
            if right && i % 1000 == 0 {
                continue;
            }
            let id = if right { N - 1 - i } else { i };
            let value = if right && i % 777 == 0 { id + 1 } else { id };
            assert!(sink.row(vec![
                Cell::I64(id),
                Cell::Text(format!("row {id}")),
                Cell::I64(value),
            ]));
        }
        if right {
            for i in 0..500 {
                assert!(sink.row(vec![
                    Cell::I64(N + i),
                    Cell::Text("new".into()),
                    Cell::I64(0)
                ]));
            }
        }
        sink.finish();
        sink.result_id().unwrap()
    };
    let left = side(false);
    let right = side(true);
    let missing = (0..N).filter(|i| i % 1000 == 0).count() as u64;
    let changed = (0..N).filter(|i| i % 777 == 0 && i % 1000 != 0).count() as u64;
    let told = AtomicU64::new(0);
    let report = compare(
        &store,
        &keyed(left, right),
        &|done, of| {
            assert!(done <= of);
            told.fetch_add(1, Ordering::Relaxed);
        },
        &|| false,
    )
    .unwrap();
    assert_eq!(report.left_rows, N as u64);
    assert_eq!(report.left_only, missing);
    assert_eq!(report.changed, changed);
    assert_eq!(report.right_only, 500);
    assert_eq!(report.same, N as u64 - missing - changed);
    assert_eq!((report.duplicate_left, report.duplicate_right), (0, 0));
    assert_eq!(report.rows, N as u64 + changed + 500);
    assert_eq!(report.diff_rows, missing + 2 * changed + 500);
    assert!(!report.cut);
    assert!(told.load(Ordering::Relaxed) > 100);
}
