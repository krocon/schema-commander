use super::*;
use crate::db::value::{Cell, RowSink};
use crate::results::{Progress, StoreSink};
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

fn spec(kind: Kind, x: Option<u32>, ys: &[u32]) -> ChartSpec {
    ChartSpec {
        kind,
        x,
        ys: ys.to_vec(),
        group: None,
        agg: Agg::Sum,
        sort: Sort::None,
    }
}

fn chart(store: &ResultStore, id: u64, spec: &ChartSpec) -> ChartData {
    sample(&prepare(store, id, spec, &|| false).unwrap(), None, 800)
}

fn text(s: &str) -> Cell {
    Cell::Text(s.into())
}

#[test]
fn suggests_a_chart_from_the_types_of_the_columns() {
    let time = [
        col("id", ColKind::Int),
        col("day", ColKind::Date),
        col("revenue", ColKind::Decimal),
        col("orders", ColKind::Int),
    ];
    let s = suggest(&time).unwrap();
    assert_eq!(
        (s.kind, s.x, s.ys.clone()),
        (Kind::Line, Some(1), vec![2, 3])
    );
    let bars = [
        col("country", ColKind::Text),
        col("revenue", ColKind::Float),
    ];
    let s = suggest(&bars).unwrap();
    assert_eq!((s.kind, s.x, s.ys.clone()), (Kind::Bar, Some(0), vec![1]));
    let two = [col("height", ColKind::Float), col("weight", ColKind::Float)];
    let s = suggest(&two).unwrap();
    assert_eq!(
        (s.kind, s.x, s.ys.clone()),
        (Kind::Scatter, Some(0), vec![1])
    );
    // one measure: over the key, or over the rows
    let keyed = [col("id", ColKind::Int), col("n", ColKind::Int)];
    let s = suggest(&keyed).unwrap();
    assert_eq!((s.kind, s.x, s.ys.clone()), (Kind::Line, Some(0), vec![1]));
    let one = [col("n", ColKind::Int)];
    assert_eq!(suggest(&one).unwrap().x, None);
    // a key is a number too, when there is nothing else
    let only_key = [col("name", ColKind::Text), col("id", ColKind::Int)];
    assert_eq!(suggest(&only_key).unwrap().ys, vec![1]);
    // a time of day is no time axis by itself; nothing to draw without a number
    assert!(suggest(&[col("a", ColKind::Text), col("b", ColKind::Json)]).is_none());
    assert!(suggest(&[]).is_none());
}

#[test]
fn reads_dates_and_timestamps() {
    assert_eq!(time_ms("1970-01-01"), Some(0.0));
    assert_eq!(time_ms("1970-01-02"), Some(86_400_000.0));
    assert_eq!(time_ms("2000-03-01"), Some(951_868_800_000.0));
    assert_eq!(time_ms("2024-02-29 12:30:15"), Some(1_709_209_815_000.0));
    assert_eq!(
        time_ms("2024-02-29T12:30:15.250"),
        Some(1_709_209_815_250.0)
    );
    assert_eq!(
        time_ms("2024-02-29 12:30:15+02:00"),
        Some(1_709_202_615_000.0)
    );
    assert_eq!(
        time_ms("2024-02-29 12:30:15.5-05:30"),
        Some(1_709_229_615_500.0)
    );
    assert_eq!(time_ms("2024-02-29 12:30"), Some(1_709_209_800_000.0));
    assert_eq!(time_ms("1969-12-31 23:59:59"), Some(-1000.0));
    assert_eq!(time_ms("0001-01-01"), Some(-62_135_596_800_000.0));
    for bad in [
        "",
        "abc",
        "2024-13-01",
        "2024-02-30x",
        "2024-02",
        "12:30:00",
        "2024-02-29 25",
        "2024-02-29 12:30:15+",
    ] {
        assert_eq!(time_ms(bad), None, "{bad}");
    }
}

#[test]
fn bars_aggregate_per_category() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let id = fill(
        &store,
        &[
            col("country", ColKind::Text),
            col("revenue", ColKind::Decimal),
        ],
        vec![
            vec![text("DE"), Cell::Decimal("10.5".into())],
            vec![text("FR"), Cell::Decimal("3".into())],
            vec![text("DE"), Cell::Decimal("1.5".into())],
            vec![Cell::Null, Cell::I64(7)],
            vec![text("FR"), Cell::Null],
            vec![text("IT"), Cell::Null],
        ],
    );
    let mut s = spec(Kind::Bar, Some(0), &[1]);
    let data = chart(&store, id, &s);
    assert_eq!(data.x_kind, XKind::Category);
    assert_eq!(data.categories, ["DE", "FR", "NULL", "IT"]);
    // a category without a value is a gap, not a zero
    assert_eq!(data.series[0].y, [Some(12.0), Some(3.0), Some(7.0), None]);
    assert_eq!(data.nulls, 2);
    for (agg, want) in [
        (Agg::Avg, [Some(6.0), Some(3.0), Some(7.0), None]),
        (Agg::Min, [Some(1.5), Some(3.0), Some(7.0), None]),
        (Agg::Max, [Some(10.5), Some(3.0), Some(7.0), None]),
        (Agg::Count, [Some(2.0), Some(1.0), Some(1.0), Some(0.0)]),
    ] {
        s.agg = agg;
        assert_eq!(chart(&store, id, &s).series[0].y, want, "{agg:?}");
    }
    s.agg = Agg::Sum;
    s.sort = Sort::ValueDesc;
    let data = chart(&store, id, &s);
    assert_eq!(data.categories, ["DE", "NULL", "FR", "IT"]);
    assert_eq!(data.series[0].x, [0.0, 1.0, 2.0, 3.0]);
    s.sort = Sort::ValueAsc;
    assert_eq!(chart(&store, id, &s).categories, ["FR", "NULL", "DE", "IT"]);
    s.sort = Sort::Label;
    assert_eq!(chart(&store, id, &s).categories, ["DE", "FR", "IT", "NULL"]);
}

#[test]
fn a_line_is_in_the_order_of_x_with_equal_x_merged_and_nulls_as_gaps() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let id = fill(
        &store,
        &[
            col("day", ColKind::Date),
            col("n", ColKind::Int),
            col("m", ColKind::Float),
        ],
        vec![
            vec![text("2024-01-03"), Cell::I64(3), Cell::F64(0.5)],
            vec![text("2024-01-01"), Cell::I64(1), Cell::Null],
            vec![text("2024-01-02"), Cell::Null, Cell::F64(2.5)],
            vec![text("2024-01-03"), Cell::I64(4), Cell::Null],
            vec![Cell::Null, Cell::I64(9), Cell::F64(9.0)],
            vec![text("soon"), Cell::I64(9), Cell::F64(9.0)],
        ],
    );
    let data = chart(&store, id, &spec(Kind::Line, Some(0), &[1, 2]));
    assert_eq!(data.x_kind, XKind::Time);
    let day = 86_400_000.0;
    let first = time_ms("2024-01-01").unwrap();
    assert_eq!(data.series[0].name, "n");
    assert_eq!(data.series[0].x, [first, first + day, first + 2.0 * day]);
    assert_eq!(data.series[0].y, [Some(1.0), None, Some(7.0)]);
    assert_eq!(data.series[1].y, [None, Some(2.5), Some(0.5)]);
    assert_eq!(
        (data.x_min, data.x_max),
        (Some(first), Some(first + 2.0 * day))
    );
    // two rows have no X that is a date
    assert_eq!(data.skipped, 2);
    assert_eq!(data.nulls, 3);
    assert_eq!(data.rows, 6);
}

#[test]
fn groups_become_series_up_to_a_limit() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let rows = (0..60)
        .map(|i| {
            vec![
                Cell::I64(i / 20),
                text(&format!("g{}", i % 20)),
                Cell::I64(i),
            ]
        })
        .collect();
    let id = fill(
        &store,
        &[
            col("x", ColKind::Int),
            col("g", ColKind::Text),
            col("v", ColKind::Int),
        ],
        rows,
    );
    let mut s = spec(Kind::Line, Some(0), &[2]);
    s.group = Some(1);
    let data = chart(&store, id, &s);
    assert_eq!(data.series.len(), MAX_SERIES);
    assert_eq!(data.series[0].name, "g0");
    assert_eq!(data.series[0].y, [Some(0.0), Some(20.0), Some(40.0)]);
    assert_eq!(data.cut_groups, 8);
    // two value columns and groups: the names say both
    s.ys = vec![2, 0];
    let data = chart(&store, id, &s);
    assert_eq!(data.series.len(), MAX_SERIES);
    assert_eq!(data.series[1].name, "x · g0");
    assert_eq!(data.series[2].name, "v · g1");
}

#[test]
fn a_long_line_is_thinned_to_the_pixels_and_keeps_its_peaks_and_gaps() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    const N: i64 = 200_000;
    let rows = (0..N)
        .map(|i| {
            let y = match i {
                77_777 => Cell::F64(1e6),
                123_456 => Cell::F64(-1e6),
                150_000..=150_100 => Cell::Null,
                _ => Cell::F64((i % 100) as f64),
            };
            vec![Cell::I64(i), y]
        })
        .collect();
    let id = fill(
        &store,
        &[col("x", ColKind::Int), col("y", ColKind::Float)],
        rows,
    );
    let prepared = prepare(&store, id, &spec(Kind::Line, Some(0), &[1]), &|| false).unwrap();
    let data = sample(&prepared, None, 600);
    let s = &data.series[0];
    assert!(data.thinned);
    assert_eq!(s.points, N as u64);
    assert!(s.x.len() <= 600 * 5, "{}", s.x.len());
    assert!(s.x.windows(2).all(|w| w[0] <= w[1]));
    let at = |x: f64| s.x.iter().position(|v| *v == x).map(|i| s.y[i]);
    assert_eq!(at(77_777.0), Some(Some(1e6)));
    assert_eq!(at(123_456.0), Some(Some(-1e6)));
    assert_eq!((s.x[0], *s.x.last().unwrap()), (0.0, (N - 1) as f64));
    // the NULLs are a gap in the line
    assert!(s.y.iter().any(Option::is_none));
    // zoomed in, every point is there
    let zoom = sample(&prepared, Some((77_700.0, 77_800.0)), 600);
    assert!(!zoom.thinned);
    // one point more on each side, so the line runs to the edge
    assert_eq!(zoom.series[0].x.len(), 103);
    assert_eq!((zoom.x_min, zoom.x_max), (Some(0.0), Some((N - 1) as f64)));
    // a range outside of the data, or a broken one
    assert!(sample(&prepared, Some((1e9, 2e9)), 600).series[0].x.len() <= 1);
    assert_eq!(
        sample(&prepared, Some((f64::NAN, 1.0)), 600).series[0].points,
        N as u64
    );
}

#[test]
fn a_scatter_plot_keeps_one_point_per_cell() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let rows = (0..100_000i64)
        .map(|i| vec![Cell::F64((i % 1000) as f64), Cell::F64((i / 1000) as f64)])
        .collect();
    let id = fill(
        &store,
        &[col("a", ColKind::Float), col("b", ColKind::Float)],
        rows,
    );
    let prepared = prepare(&store, id, &spec(Kind::Scatter, Some(0), &[1]), &|| false).unwrap();
    let data = sample(&prepared, None, 200);
    assert!(data.thinned);
    assert_eq!(data.series[0].points, 100_000);
    assert!(data.series[0].x.len() <= 50 * 25);
    assert!(data.series[0].x.len() > 500);
    // the corners are there
    let has = |x: f64, y: f64| {
        data.series[0]
            .x
            .iter()
            .zip(&data.series[0].y)
            .any(|(a, b)| *a == x && *b == Some(y))
    };
    assert!(has(0.0, 0.0));
    let few = sample(&prepared, Some((0.0, 1.0)), 200);
    assert!(!few.thinned);
    assert_eq!(few.series[0].x.len(), 200);
}

#[test]
fn the_rows_are_x_when_no_column_is() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let id = fill(
        &store,
        &[col("n", ColKind::Decimal)],
        vec![
            vec![Cell::Decimal("1.5".into())],
            vec![Cell::Decimal("NaN".into())],
            vec![Cell::Decimal("2.5".into())],
        ],
    );
    let data = chart(&store, id, &spec(Kind::Line, None, &[0]));
    assert_eq!(data.x_kind, XKind::Row);
    assert_eq!(data.series[0].x, [1.0, 3.0]);
    assert_eq!(data.series[0].y, [Some(1.5), Some(2.5)]);
    assert_eq!(data.skipped, 1);
}

#[test]
fn hostile_labels_are_cut_and_stay_one_line() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let long = "x".repeat(500);
    let id = fill(
        &store,
        &[col("name", ColKind::Text), col("n", ColKind::Int)],
        vec![
            vec![text("<script>alert(1)</script>\n\u{0}zwei"), Cell::I64(1)],
            vec![text(&long), Cell::I64(2)],
            vec![Cell::bytes(&[1, 2, 3]), Cell::I64(3)],
        ],
    );
    let data = chart(&store, id, &spec(Kind::Bar, Some(0), &[1]));
    assert_eq!(data.categories[0], "<script>alert(1)</script>  zwei");
    assert_eq!(data.categories[1].chars().count(), 61);
    assert_eq!(data.categories[2], "?");
}

#[test]
fn refuses_what_is_no_chart() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let id = fill(&store, &[col("n", ColKind::Int)], vec![vec![Cell::I64(1)]]);
    for bad in [
        spec(Kind::Line, None, &[]),
        spec(Kind::Line, None, &[5]),
        spec(Kind::Line, Some(9), &[0]),
        spec(Kind::Line, None, &[0; 13]),
    ] {
        let failed = prepare(&store, id, &bad, &|| false);
        assert_eq!(failed.unwrap_err().code, ErrorCode::Unsupported);
    }
    assert_eq!(
        prepare(&store, 999, &spec(Kind::Line, None, &[0]), &|| false)
            .unwrap_err()
            .code,
        ErrorCode::UnknownResult
    );
}

#[test]
fn stops_when_asked() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let rows = (0..20_000).map(|i| vec![Cell::I64(i)]).collect();
    let id = fill(&store, &[col("n", ColKind::Int)], rows);
    let failed = prepare(&store, id, &spec(Kind::Line, None, &[0]), &|| true);
    assert_eq!(failed.unwrap_err().code, ErrorCode::Cancelled);
}

#[test]
fn the_cache_keeps_the_last_charts() {
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let id = fill(&store, &[col("n", ColKind::Int)], vec![vec![Cell::I64(1)]]);
    let cache = ChartCache::default();
    let make = || prepare(&store, id, &spec(Kind::Line, None, &[0]), &|| false).unwrap();
    let (first, _) = cache.keep(make());
    let ids: Vec<u64> = (0..3).map(|_| cache.keep(make()).0).collect();
    assert!(cache.get(first).is_none());
    assert!(ids.iter().all(|i| cache.get(*i).is_some()));
    cache.free(ids[0]);
    assert!(cache.get(ids[0]).is_none());
}

/// The acceptance of prompt 042: a time series of five million points. In a debug build this takes long;
/// run it with `cargo test --release --lib chart::tests::five_million -- --ignored --nocapture`.
#[test]
#[ignore = "slow in a debug build"]
fn five_million_points() {
    const N: i64 = 5_000_000;
    let dir = tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let quiet = |_: Progress| {};
    let mut sink = StoreSink::new(&store, &quiet);
    sink.start(&[col("at", ColKind::Timestamp), col("v", ColKind::Float)]);
    let start = chrono::NaiveDate::from_ymd_opt(2024, 1, 1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap();
    for i in 0..N {
        let at = start + chrono::Duration::seconds(i);
        assert!(sink.row(vec![Cell::Ts(at), Cell::F64(((i % 3600) as f64).sin())]));
    }
    sink.finish();
    let id = sink.result_id().unwrap();
    let begun = std::time::Instant::now();
    let prepared = prepare(&store, id, &spec(Kind::Line, Some(0), &[1]), &|| false).unwrap();
    let data = sample(&prepared, None, 1200);
    let first = begun.elapsed();
    assert_eq!(data.series[0].points, N as u64);
    assert!(data.series[0].x.len() <= 1200 * 5);
    let begun = std::time::Instant::now();
    let lo = data.x_min.unwrap();
    for step in 0..50 {
        let from = lo + step as f64 * 3_600_000.0 * 10.0;
        let zoom = sample(&prepared, Some((from, from + 3_600_000.0 * 100.0)), 1200);
        assert!(zoom.series[0].points > 300_000);
    }
    let zoom = begun.elapsed() / 50;
    eprintln!("5 million points: first chart {first:?}, a zoom step {zoom:?}");
    if !cfg!(debug_assertions) {
        assert!(first.as_secs_f64() < 2.0, "{first:?}");
        assert!(zoom.as_secs_f64() < 0.05, "{zoom:?}");
    }
}
