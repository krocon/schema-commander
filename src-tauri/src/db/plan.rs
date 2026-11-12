//! Execution plans (prompt 039): asking a database how it would run – or did run – a statement, and
//! reading the answer into one model for all of them: a tree of operations with rows, cost and time.
//!
//! The parsers are pure and forgiving: what they do not know becomes a node called by its raw name, with
//! everything it said as its details; a format they cannot read at all becomes a plan that is only its
//! raw text. Nothing here fails because a server is newer than this code.

use super::guard;
use super::value::{Cell, VecSink};
use super::{DbKind, Flavor, Limits, Session, Stop, begin_statement};
use crate::error::{AppError, AppResult, ErrorCode};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

/// Nodes of a plan at most (a plan with more is cut; its raw text is whole).
pub const MAX_NODES: usize = 5_000;
/// Details kept per node.
const MAX_EXTRA: usize = 60;
/// Bytes of a raw plan handed to the window.
pub const MAX_RAW: usize = 4 * 1024 * 1024;

/// Something about a node that is worth a look – a hint, not a verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Hint {
    /// A whole table is read and most of its rows are thrown away by a condition.
    ScanFilter,
    /// A sort did not fit into memory.
    SortOnDisk,
    /// The rows that came differ from the estimate by a factor of ten or more.
    Misestimate,
    /// The node ran a thousand times or more (the inner side of a nested loop).
    ManyLoops,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanNode {
    /// What is done: `Hash Join`, `Seq Scan`, `Table scan` – as the database calls it.
    pub op: String,
    /// The table or index it is done on.
    pub object: String,
    /// The condition, the keys of a sort, … – the most telling line.
    pub detail: String,
    /// Rows the database expected, over all loops.
    pub est_rows: Option<f64>,
    /// Rows that came, over all loops (only after an execution).
    pub act_rows: Option<f64>,
    /// The cost up to and including this node, in the database's own unit.
    pub cost: Option<f64>,
    /// Milliseconds spent in this node and below it, over all loops.
    pub time_ms: Option<f64>,
    /// Milliseconds spent in this node alone.
    pub self_ms: Option<f64>,
    pub loops: Option<f64>,
    /// Pages read, as far as the database says.
    pub buffers: Option<String>,
    /// Everything else the database said about the node.
    pub extra: Vec<(String, String)>,
    pub hints: Vec<Hint>,
    pub children: Vec<PlanNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub nodes: Vec<PlanNode>,
    /// The plan as the database gave it.
    pub raw: String,
    /// `json`, `xml` or `text`.
    pub format: String,
    /// The statement ran.
    pub analyzed: bool,
    /// The time of the whole statement, where the database says it.
    pub total_ms: Option<f64>,
    /// `false`: the format was not understood; `nodes` holds one node that says so.
    pub known: bool,
    /// The plan has more nodes than are shown.
    pub cut: bool,
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn number(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        // MySQL writes its costs as strings
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn unknown(raw: &str, format: &str, analyzed: bool) -> Plan {
    Plan {
        nodes: vec![PlanNode {
            op: "unknown".to_owned(),
            ..PlanNode::default()
        }],
        raw: cut_raw(raw),
        format: format.to_owned(),
        analyzed,
        total_ms: None,
        known: false,
        cut: false,
    }
}

fn cut_raw(raw: &str) -> String {
    if raw.len() <= MAX_RAW {
        return raw.to_owned();
    }
    let mut end = MAX_RAW;
    while !raw.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &raw[..end])
}

// --- PostgreSQL -------------------------------------------------------------------------------------

fn pg_node(o: &serde_json::Map<String, Value>, left: &mut usize) -> PlanNode {
    let s = |key: &str| o.get(key).map(text_of).unwrap_or_default();
    let loops = number(o.get("Actual Loops"));
    let times = |v: Option<f64>| match (v, loops) {
        (Some(v), Some(l)) => Some(v * l),
        (v, _) => v,
    };
    let mut node = PlanNode {
        op: match (s("Node Type"), s("Join Type")) {
            (op, join) if !join.is_empty() && join != "Inner" => format!("{op} ({join})"),
            (op, _) if op.is_empty() => "unknown".to_owned(),
            (op, _) => op,
        },
        object: [
            "Relation Name",
            "Index Name",
            "CTE Name",
            "Function Name",
            "Subplan Name",
        ]
        .iter()
        .map(|k| s(k))
        .find(|v| !v.is_empty())
        .unwrap_or_default(),
        detail: [
            "Index Cond",
            "Hash Cond",
            "Merge Cond",
            "Join Filter",
            "Recheck Cond",
            "Filter",
            "Sort Key",
            "Group Key",
        ]
        .iter()
        .map(|k| s(k))
        .find(|v| !v.is_empty())
        .unwrap_or_default(),
        // per loop in the plan: over all loops here, like the rows that came
        est_rows: match (number(o.get("Plan Rows")), loops) {
            (Some(rows), Some(l)) if l > 0.0 => Some(rows * l),
            (rows, _) => rows,
        },
        act_rows: times(number(o.get("Actual Rows"))),
        cost: number(o.get("Total Cost")),
        time_ms: times(number(o.get("Actual Total Time"))),
        loops,
        ..PlanNode::default()
    };
    let hit = number(o.get("Shared Hit Blocks")).unwrap_or(0.0);
    let read = number(o.get("Shared Read Blocks")).unwrap_or(0.0);
    if hit + read > 0.0 {
        node.buffers = Some(format!("hit {hit} · read {read}"));
    }
    for (key, value) in o {
        if key == "Plans" || node.extra.len() >= MAX_EXTRA {
            continue;
        }
        if !value.is_object() {
            node.extra.push((key.clone(), text_of(value)));
        }
    }
    if let Some(Value::Array(plans)) = o.get("Plans") {
        for child in plans.iter().filter_map(Value::as_object) {
            if *left == 0 {
                break;
            }
            *left -= 1;
            node.children.push(pg_node(child, left));
        }
    }
    node
}

pub fn parse_pg(raw: &str) -> Plan {
    let analyzed = raw.contains("\"Actual Total Time\"");
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return unknown(raw, "json", analyzed);
    };
    let top = match &value {
        Value::Array(list) => list.first(),
        other => Some(other),
    };
    let Some(root) = top
        .and_then(Value::as_object)
        .and_then(|o| o.get("Plan").and_then(Value::as_object))
    else {
        return unknown(raw, "json", analyzed);
    };
    let mut left = MAX_NODES;
    let node = pg_node(root, &mut left);
    finish(
        vec![node],
        raw,
        "json",
        analyzed,
        number(top.and_then(|t| t.get("Execution Time"))),
        left == 0,
    )
}

// --- MySQL and MariaDB (JSON) -------------------------------------------------------------------------

fn my_node(name: &str, o: &serde_json::Map<String, Value>, left: &mut usize) -> PlanNode {
    let s = |key: &str| o.get(key).map(text_of).unwrap_or_default();
    let cost_info = o.get("cost_info").and_then(Value::as_object);
    let loops = number(o.get("r_loops"));
    let access = s("access_type");
    let mut node = PlanNode {
        op: if access.is_empty() {
            name.replace('_', " ")
        } else {
            format!("{} ({access})", name.replace('_', " "))
        },
        object: match (s("table_name"), s("key")) {
            (table, key) if !table.is_empty() && !key.is_empty() => format!("{table} · {key}"),
            (table, _) => table,
        },
        detail: ["attached_condition", "index_condition", "sort_key", "ref"]
            .iter()
            .map(|k| s(k))
            .find(|v| !v.is_empty() && v != "[]")
            .unwrap_or_default(),
        est_rows: number(o.get("rows_examined_per_scan")).or_else(|| number(o.get("rows"))),
        act_rows: match (number(o.get("r_rows")), loops) {
            (Some(rows), Some(l)) => Some(rows * l),
            (rows, _) => rows.or_else(|| number(o.get("r_output_rows"))),
        },
        cost: cost_info
            .and_then(|c| number(c.get("prefix_cost")).or_else(|| number(c.get("query_cost"))))
            .or_else(|| number(o.get("cost"))),
        time_ms: number(o.get("r_total_time_ms")).or_else(|| number(o.get("r_table_time_ms"))),
        loops,
        ..PlanNode::default()
    };
    for (key, value) in o {
        match value {
            Value::Object(child) if key != "cost_info" => {
                if *left > 0 {
                    *left -= 1;
                    node.children.push(my_node(key, child, left));
                }
            }
            Value::Array(list) if list.iter().any(Value::is_object) => {
                for item in list.iter().filter_map(Value::as_object) {
                    if *left == 0 {
                        break;
                    }
                    *left -= 1;
                    // `{"table": {…}}`: the step is what is inside
                    match (item.len(), item.iter().next()) {
                        (1, Some((inner, Value::Object(child)))) => {
                            node.children.push(my_node(inner, child, left));
                        }
                        _ => node.children.push(my_node(key, item, left)),
                    }
                }
            }
            _ if node.extra.len() < MAX_EXTRA => {
                if key == "cost_info" {
                    if let Some(costs) = cost_info {
                        for (k, v) in costs {
                            node.extra.push((k.clone(), text_of(v)));
                        }
                    }
                } else {
                    node.extra.push((key.clone(), text_of(value)));
                }
            }
            _ => {}
        }
    }
    node
}

pub fn parse_mysql(raw: &str) -> Plan {
    let analyzed = raw.contains("\"r_loops\"") || raw.contains("\"r_total_time_ms\"");
    let Ok(Value::Object(top)) = serde_json::from_str::<Value>(raw) else {
        return unknown(raw, "json", analyzed);
    };
    let Some(block) = top.get("query_block").and_then(Value::as_object) else {
        return unknown(raw, "json", analyzed);
    };
    let mut left = MAX_NODES;
    let node = my_node("query_block", block, &mut left);
    let total = node.time_ms;
    finish(vec![node], raw, "json", analyzed, total, left == 0)
}

// --- plans written as a tree of text (MySQL `EXPLAIN ANALYZE`, CockroachDB) ---------------------------

fn nest(flat: Vec<(usize, PlanNode)>) -> Vec<PlanNode> {
    // the last node of every depth so far; a node belongs to the nearest one above it
    fn attach(stack: &mut Vec<(usize, PlanNode)>, roots: &mut Vec<PlanNode>, until: usize) {
        while stack.last().is_some_and(|(depth, _)| *depth >= until) {
            let (_, done) = stack.pop().expect("checked");
            match stack.last_mut() {
                Some((_, parent)) => parent.children.push(done),
                None => roots.push(done),
            }
        }
    }
    let mut roots = Vec::new();
    let mut stack: Vec<(usize, PlanNode)> = Vec::new();
    for (depth, node) in flat {
        attach(&mut stack, &mut roots, depth);
        stack.push((depth, node));
    }
    attach(&mut stack, &mut roots, 0);
    roots
}

/// `key=value` pairs of one bracket: `(cost=1087 rows=1666)`.
fn pairs(text: &str) -> Vec<(&str, &str)> {
    text.split_whitespace()
        .filter_map(|p| p.split_once('='))
        .collect()
}

/// MySQL's `EXPLAIN ANALYZE` (and `FORMAT=TREE`): `-> Operation  (cost=… rows=…) (actual time=a..b rows=… loops=…)`.
pub fn parse_mysql_tree(raw: &str) -> Plan {
    let analyzed = raw.contains("actual time=");
    let mut flat = Vec::new();
    for line in raw.lines() {
        let Some(at) = line.find("-> ") else {
            continue;
        };
        if flat.len() >= MAX_NODES {
            break;
        }
        let rest = &line[at + 3..];
        let (head, brackets) = match rest.find("  (") {
            Some(cut) => (&rest[..cut], &rest[cut..]),
            None => (rest, ""),
        };
        let mut node = PlanNode::default();
        // `Filter: (…)`, `Table scan on b`, `Single-row index lookup on a using PRIMARY (id=…)`
        if let Some((op, detail)) = head.split_once(": ") {
            node.op = op.trim().to_owned();
            node.detail = detail.trim().to_owned();
        } else if let Some((op, on)) = head.split_once(" on ") {
            node.op = op.trim().to_owned();
            match on.split_once(' ') {
                Some((object, more)) => {
                    node.object = object.to_owned();
                    node.detail = more.trim().to_owned();
                }
                None => node.object = on.trim().to_owned(),
            }
        } else {
            node.op = head.trim().to_owned();
        }
        for part in brackets.split('(').skip(1) {
            let inner = part.split(')').next().unwrap_or_default();
            let actual = inner.starts_with("actual");
            let mut rows = None;
            let mut loops = None;
            let mut time = None;
            for (key, value) in pairs(inner) {
                match key {
                    "cost" => node.cost = value.parse().ok(),
                    "rows" => rows = value.parse::<f64>().ok(),
                    "loops" => loops = value.parse::<f64>().ok(),
                    // first row .. last row, per loop
                    "time" => {
                        time = value
                            .rsplit("..")
                            .next()
                            .and_then(|t| t.parse::<f64>().ok())
                    }
                    _ => {}
                }
            }
            if actual {
                let l = loops.unwrap_or(1.0);
                node.loops = loops;
                node.act_rows = rows.map(|r| r * l);
                node.time_ms = time.map(|t| t * l);
            } else {
                node.est_rows = rows;
            }
        }
        // est rows are per loop too
        if let (Some(est), Some(l)) = (node.est_rows, node.loops) {
            node.est_rows = Some(est * l);
        }
        flat.push((at, node));
    }
    if flat.is_empty() {
        return unknown(raw, "text", analyzed);
    }
    let cut = flat.len() >= MAX_NODES;
    let nodes = nest(flat);
    let total = nodes.first().and_then(|n| n.time_ms);
    finish(nodes, raw, "text", analyzed, total, cut)
}

/// A number as CockroachDB writes it: `1,666`, `2ms`, `120µs`, `1.5s`.
fn cockroach_number(text: &str) -> Option<f64> {
    let first = text.split_whitespace().next()?.replace(',', "");
    let digits: String = first
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let value: f64 = digits.parse().ok()?;
    Some(match &first[digits.len()..] {
        "µs" | "us" => value / 1000.0,
        "s" => value * 1000.0,
        "ns" => value / 1_000_000.0,
        _ => value,
    })
}

/// CockroachDB's `EXPLAIN [ANALYZE]`: `• operation` with its attributes below, drawn as a tree.
pub fn parse_cockroach(raw: &str) -> Plan {
    let analyzed = raw.contains("actual row count") || raw.contains("execution time");
    let mut flat: Vec<(usize, PlanNode)> = Vec::new();
    let mut total = None;
    for line in raw.lines() {
        let chars: Vec<char> = line.chars().collect();
        if let Some(at) = chars.iter().position(|c| *c == '•') {
            if flat.len() >= MAX_NODES {
                break;
            }
            let op: String = chars[at + 1..].iter().collect();
            flat.push((
                at,
                PlanNode {
                    op: op.trim().to_owned(),
                    ..PlanNode::default()
                },
            ));
            continue;
        }
        let text: String = chars
            .iter()
            .skip_while(|c| c.is_whitespace() || matches!(c, '│' | '├' | '└' | '─'))
            .collect();
        let Some((key, value)) = text.split_once(": ") else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        let Some((_, node)) = flat.last_mut() else {
            // above the tree: what holds for the whole statement
            if key == "execution time" {
                total = cockroach_number(value);
            }
            continue;
        };
        match key {
            "table" => node.object = value.to_owned(),
            "filter" | "equality" | "order" | "group by" | "spans" if node.detail.is_empty() => {
                node.detail = format!("{key}: {value}");
            }
            "estimated row count" => node.est_rows = cockroach_number(value),
            "actual row count" => node.act_rows = cockroach_number(value),
            "execution time" => node.time_ms = cockroach_number(value),
            _ => {}
        }
        if node.extra.len() < MAX_EXTRA {
            node.extra.push((key.to_owned(), value.to_owned()));
        }
    }
    if flat.is_empty() {
        return unknown(raw, "text", analyzed);
    }
    let cut = flat.len() >= MAX_NODES;
    finish(nest(flat), raw, "text", analyzed, total, cut)
}

// --- SQL Server (showplan XML) ------------------------------------------------------------------------

// (the attribute values of a showplan need no more than the old way of unescaping them)
#[allow(deprecated)]
pub fn parse_mssql(raw: &str) -> Plan {
    use quick_xml::events::Event;
    let analyzed = raw.contains("<RunTimeCountersPerThread");
    let mut reader = quick_xml::Reader::from_str(raw);
    // the operators that are open, each with the depth of its element
    let mut open: Vec<(usize, PlanNode)> = Vec::new();
    let mut roots: Vec<PlanNode> = Vec::new();
    let mut depth = 0usize;
    let mut count = 0usize;
    let mut seen = false;
    loop {
        let event = match reader.read_event() {
            Ok(event) => event,
            Err(_) => return unknown(raw, "xml", analyzed),
        };
        let (start, empty) = match &event {
            Event::Start(e) => (Some(e), false),
            Event::Empty(e) => (Some(e), true),
            _ => (None, false),
        };
        if let Some(e) = start {
            let element = e.local_name().as_ref().to_owned();
            let attrs: Vec<(String, String)> = e
                .attributes()
                .flatten()
                .map(|a| {
                    (
                        a.key.local_name().as_ref().to_owned(),
                        a.unescape_value()
                            .map(|v| v.into_owned())
                            .unwrap_or_default(),
                    )
                })
                .collect();
            let attr = |name: &str| {
                attrs
                    .iter()
                    .find(|(k, _)| k == name)
                    .map(|(_, v)| v.as_str())
            };
            let num = |name: &str| attr(name).and_then(|v| v.parse::<f64>().ok());
            match element.as_str() {
                "RelOp" => {
                    seen = true;
                    count += 1;
                    let mut node = PlanNode {
                        op: attr("PhysicalOp").unwrap_or("unknown").to_owned(),
                        est_rows: num("EstimateRows"),
                        cost: num("EstimatedTotalSubtreeCost"),
                        ..PlanNode::default()
                    };
                    for (key, value) in &attrs {
                        if !matches!(key.as_str(), "PhysicalOp" | "NodeId")
                            && node.extra.len() < MAX_EXTRA
                        {
                            node.extra.push((key.clone(), value.clone()));
                        }
                    }
                    if count <= MAX_NODES {
                        open.push((depth, node));
                    }
                }
                "Object" => {
                    if let Some((_, node)) = open.last_mut()
                        && node.object.is_empty()
                    {
                        let clean = |v: &str| v.trim_matches(['[', ']']).to_owned();
                        node.object = match (attr("Table"), attr("Index")) {
                            (Some(t), Some(i)) => format!("{} · {}", clean(t), clean(i)),
                            (Some(t), None) => clean(t),
                            _ => String::new(),
                        };
                    }
                }
                "RunTimeCountersPerThread" => {
                    if let Some((_, node)) = open.last_mut() {
                        let add = |slot: &mut Option<f64>, v: Option<f64>| {
                            if let Some(v) = v {
                                *slot = Some(slot.unwrap_or(0.0) + v);
                            }
                        };
                        add(&mut node.act_rows, num("ActualRows"));
                        add(&mut node.loops, num("ActualExecutions"));
                        // threads work side by side: the longest of them is how long it took
                        if let Some(ms) = num("ActualElapsedms") {
                            node.time_ms = Some(node.time_ms.unwrap_or(0.0).max(ms));
                        }
                        if let Some(reads) = num("ActualLogicalReads").filter(|r| *r > 0.0) {
                            let before: f64 = node
                                .buffers
                                .as_deref()
                                .and_then(|b| b.strip_prefix("reads "))
                                .and_then(|b| b.parse().ok())
                                .unwrap_or(0.0);
                            node.buffers = Some(format!("reads {}", before + reads));
                        }
                    }
                }
                "ScalarOperator" => {
                    if let Some((_, node)) = open.last_mut()
                        && node.detail.is_empty()
                        && let Some(text) = attr("ScalarString")
                    {
                        node.detail = text.to_owned();
                    }
                }
                "SpillToTempDb" | "SortSpillDetails" | "HashSpillDetails" => {
                    if let Some((_, node)) = open.last_mut()
                        && !node.hints.contains(&Hint::SortOnDisk)
                    {
                        node.hints.push(Hint::SortOnDisk);
                    }
                }
                _ => {}
            }
            if !empty {
                depth += 1;
            }
            // an operator without anything in it
            if empty && element == "RelOp" && count <= MAX_NODES {
                close(&mut open, &mut roots);
            }
        }
        match event {
            Event::End(e) => {
                depth = depth.saturating_sub(1);
                if e.local_name().as_ref() == "RelOp"
                    && open.last().is_some_and(|(at, _)| *at == depth)
                {
                    close(&mut open, &mut roots);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    while !open.is_empty() {
        close(&mut open, &mut roots);
    }
    if !seen {
        return unknown(raw, "xml", analyzed);
    }
    let total = roots.first().and_then(|n| n.time_ms);
    finish(roots, raw, "xml", analyzed, total, count > MAX_NODES)
}

fn close(open: &mut Vec<(usize, PlanNode)>, roots: &mut Vec<PlanNode>) {
    if let Some((_, done)) = open.pop() {
        match open.last_mut() {
            Some((_, parent)) => parent.children.push(done),
            None => roots.push(done),
        }
    }
}

// --- SQLite -------------------------------------------------------------------------------------------

/// `EXPLAIN QUERY PLAN`: rows `id, parent, (unused), detail`.
pub fn parse_sqlite(rows: &[(i64, i64, String)]) -> Plan {
    let raw = rows
        .iter()
        .map(|(id, parent, detail)| format!("{id}\t{parent}\t{detail}"))
        .collect::<Vec<_>>()
        .join("\n");
    fn build(rows: &[(i64, i64, String)], parent: i64, depth: usize) -> Vec<PlanNode> {
        if depth > 64 {
            return Vec::new();
        }
        rows.iter()
            .filter(|(id, p, _)| *p == parent && *id != parent)
            .map(|(id, _, detail)| {
                let mut words = detail.splitn(3, ' ');
                let first = words.next().unwrap_or_default();
                let (op, object, rest) = match first {
                    // `SCAN b`, `SEARCH a USING INTEGER PRIMARY KEY (rowid=?)`
                    "SCAN" | "SEARCH" => (
                        first.to_owned(),
                        words.next().unwrap_or_default().to_owned(),
                        words.next().unwrap_or_default().to_owned(),
                    ),
                    _ => (detail.clone(), String::new(), String::new()),
                };
                PlanNode {
                    op,
                    object,
                    detail: rest,
                    children: build(rows, *id, depth + 1),
                    ..PlanNode::default()
                }
            })
            .collect()
    }
    let nodes = build(&rows[..rows.len().min(MAX_NODES)], 0, 0);
    if nodes.is_empty() {
        return unknown(&raw, "text", false);
    }
    finish(nodes, &raw, "text", false, None, rows.len() > MAX_NODES)
}

// --- what holds for every plan ------------------------------------------------------------------------

/// The time a node spent itself: its time without the time of what is below it.
fn self_times(node: &mut PlanNode) {
    for child in &mut node.children {
        self_times(child);
    }
    if let Some(total) = node.time_ms {
        let below: f64 = node.children.iter().filter_map(|c| c.time_ms).sum();
        node.self_ms = Some((total - below).max(0.0));
    }
}

fn hints(node: &mut PlanNode) {
    for child in &mut node.children {
        hints(child);
    }
    let add = |hint: Hint, hints: &mut Vec<Hint>| {
        if !hints.contains(&hint) {
            hints.push(hint);
        }
    };
    let extra = |key: &str| {
        node.extra
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    };
    let op = node.op.to_ascii_lowercase();
    let scans = op.starts_with("seq scan")
        || op.starts_with("table scan")
        || op.contains("(all)")
        || op == "scan"
        || op.contains("clustered index scan");
    // most rows of a whole table thrown away
    let removed = extra("Rows Removed by Filter").and_then(|v| v.parse::<f64>().ok());
    let filtered = extra("filtered").and_then(|v| v.parse::<f64>().ok());
    let wasteful = match (removed, node.act_rows, filtered, node.est_rows) {
        (Some(gone), Some(kept), _, _) => gone >= 1000.0 && gone >= kept * 9.0,
        (_, _, Some(percent), Some(rows)) => percent <= 10.0 && rows >= 1000.0,
        _ => false,
    };
    let mut found = std::mem::take(&mut node.hints);
    if scans && wasteful {
        add(Hint::ScanFilter, &mut found);
    }
    if extra("Sort Space Type") == Some("Disk")
        || extra("Sort Method").is_some_and(|m| m.contains("external"))
        || extra("r_sort_passes").is_some_and(|p| p.parse::<f64>().is_ok_and(|n| n > 0.0))
    {
        add(Hint::SortOnDisk, &mut found);
    }
    if let (Some(est), Some(act)) = (node.est_rows, node.act_rows) {
        let (low, high) = if est < act { (est, act) } else { (act, est) };
        if high >= 100.0 && high >= low.max(1.0) * 10.0 {
            add(Hint::Misestimate, &mut found);
        }
    }
    if node.loops.is_some_and(|l| l >= 1000.0) {
        add(Hint::ManyLoops, &mut found);
    }
    node.hints = found;
}

fn finish(
    mut nodes: Vec<PlanNode>,
    raw: &str,
    format: &str,
    analyzed: bool,
    total_ms: Option<f64>,
    cut: bool,
) -> Plan {
    for node in &mut nodes {
        self_times(node);
        hints(node);
    }
    Plan {
        nodes,
        raw: cut_raw(raw),
        format: format.to_owned(),
        analyzed,
        total_ms,
        known: true,
        cut,
    }
}

// --- asking -------------------------------------------------------------------------------------------

/// What is sent to get a plan: statements before, the one whose answer is the plan, statements after.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ask {
    pub before: Vec<String>,
    pub explain: String,
    pub after: Vec<String>,
}

/// How a database is asked for the plan of `sql`. `analyze`: the statement runs.
pub fn ask(kind: DbKind, flavor: Flavor, sql: &str, analyze: bool) -> AppResult<Ask> {
    let sql = sql.trim().trim_end_matches(';').trim();
    if sql.is_empty() || !guard::is_single_statement(sql, kind) {
        return Err(AppError::new(
            ErrorCode::InvalidQuery,
            "a plan is shown for one statement",
        ));
    }
    let one = |explain: String| Ask {
        before: Vec::new(),
        explain,
        after: Vec::new(),
    };
    Ok(match (kind, flavor, analyze) {
        (DbKind::Postgres, Flavor::Cockroach, false) => one(format!("EXPLAIN {sql}")),
        (DbKind::Postgres, Flavor::Cockroach, true) => one(format!("EXPLAIN ANALYZE {sql}")),
        (DbKind::Postgres, _, false) => one(format!("EXPLAIN (FORMAT JSON) {sql}")),
        (DbKind::Postgres, _, true) => {
            one(format!("EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) {sql}"))
        }
        (DbKind::Mysql, _, false) => one(format!("EXPLAIN FORMAT=JSON {sql}")),
        (DbKind::Mysql, Flavor::Maria, true) => one(format!("ANALYZE FORMAT=JSON {sql}")),
        (DbKind::Mysql, _, true) => one(format!("EXPLAIN ANALYZE {sql}")),
        (DbKind::Sqlserver, _, analyze) => {
            let option = if analyze {
                "STATISTICS XML"
            } else {
                "SHOWPLAN_XML"
            };
            Ask {
                before: vec![format!("SET {option} ON")],
                explain: sql.to_owned(),
                after: vec![format!("SET {option} OFF")],
            }
        }
        (
            DbKind::Oracle
            | DbKind::Duckdb
            | DbKind::Clickhouse
            | DbKind::Trino
            | DbKind::Firebird
            | DbKind::Bigquery
            | DbKind::Snowflake,
            _,
            _,
        ) => {
            return Err(super::not_yet(kind, "the execution plan"));
        }
        (DbKind::Sqlite | DbKind::Libsql | DbKind::D1, _, false) => {
            one(format!("EXPLAIN QUERY PLAN {sql}"))
        }
        (DbKind::Sqlite | DbKind::Libsql | DbKind::D1, _, true) => {
            return Err(AppError::new(
                ErrorCode::Unsupported,
                "SQLite gives no plan with times",
            ));
        }
    })
}

/// Reads the answer of a database into a plan.
pub fn read(kind: DbKind, flavor: Flavor, rows: &[Vec<Cell>]) -> Plan {
    let text = |cell: &Cell| -> Option<String> {
        match cell {
            Cell::Text(t) | Cell::Json(t) | Cell::Decimal(t) => Some(t.clone()),
            Cell::I64(n) => Some(n.to_string()),
            Cell::U64(n) => Some(n.to_string()),
            _ => None,
        }
    };
    if kind.is_sqlite() {
        let parsed: Vec<(i64, i64, String)> = rows
            .iter()
            .filter_map(|row| match row.as_slice() {
                [Cell::I64(id), Cell::I64(parent), _, detail] => {
                    Some((*id, *parent, text(detail).unwrap_or_default()))
                }
                _ => None,
            })
            .collect();
        return parse_sqlite(&parsed);
    }
    // the plan is the text of the first column (SQL Server: of the row that holds the XML)
    let lines: Vec<String> = rows
        .iter()
        .filter_map(|row| row.first().and_then(text))
        .collect();
    match kind {
        DbKind::Sqlserver => {
            let xml = rows
                .iter()
                .flatten()
                .filter_map(text)
                // the first: behind it may stand the plans of statements the driver added
                .find(|t| t.trim_start().starts_with("<ShowPlanXML"))
                .unwrap_or_default();
            parse_mssql(&xml)
        }
        DbKind::Postgres if flavor == Flavor::Cockroach => parse_cockroach(&lines.join("\n")),
        DbKind::Postgres => parse_pg(&lines.join("\n")),
        _ => {
            let raw = lines.join("\n");
            if raw.trim_start().starts_with('{') {
                parse_mysql(&raw)
            } else {
                parse_mysql_tree(&raw)
            }
        }
    }
}

/// Keeps of everything SQL Server answers only the rows that are a plan.
struct ShowplanSink(Vec<Vec<Cell>>);

impl super::value::RowSink for ShowplanSink {
    fn start(&mut self, _columns: &[super::value::Column]) {}

    fn row(&mut self, cells: Vec<Cell>) -> bool {
        let plan = matches!(cells.first(), Some(Cell::Text(t)) if t.trim_start().starts_with("<ShowPlanXML"));
        if plan && self.0.len() < 8 {
            self.0.push(cells);
        }
        true
    }
}

/// Asks the database for the plan of one statement. With `analyze` the statement **runs** – inside a
/// transaction that is always rolled back: what it changed is undone (as far as the database rolls
/// that kind of statement back).
pub fn explain(
    s: &mut dyn Session,
    kind: DbKind,
    sql: &str,
    analyze: bool,
    timeout: Option<Duration>,
    stop: Stop,
) -> AppResult<Plan> {
    let mut flavor = s.flavor();
    if kind == DbKind::Mysql
        && s.server_version(stop)
            .is_ok_and(|v| v.starts_with("MariaDB"))
    {
        flavor = Flavor::Maria;
    }
    let asked = ask(kind, flavor, sql, analyze)?;
    let limits = Limits {
        max_rows: 100_000,
        timeout,
    };
    let quiet = Limits::rows(1);
    if analyze {
        s.query(begin_statement(kind), quiet, &|| false)?;
    }
    let mut result = (|| -> AppResult<Vec<Vec<Cell>>> {
        for sql in &asked.before {
            s.query(sql, quiet, stop)?;
        }
        if kind == DbKind::Sqlserver {
            // the statement's own rows are not wanted, however many: only the plan
            let mut sink = ShowplanSink(Vec::new());
            s.execute(&asked.explain, limits, &mut sink, stop)?;
            return Ok(sink.0);
        }
        let mut sink = VecSink::new(limits.max_rows);
        s.execute(&asked.explain, limits, &mut sink, stop)?;
        Ok(sink.rows)
    })();
    if s.is_open() {
        for sql in &asked.after {
            if let Err(e) = s.query(sql, quiet, &|| false)
                && result.is_ok()
            {
                result = Err(e);
            }
        }
        if analyze {
            let _ = s.query("ROLLBACK", quiet, &|| false);
        }
    }
    let rows: Vec<Vec<Cell>> = result?;
    let mut plan = read(kind, flavor, &rows);
    plan.analyzed = analyze;
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sqlite;

    const PG_ESTIMATE: &str = include_str!("plan_cases/pg17-estimate.json");
    const PG_ANALYZE: &str = include_str!("plan_cases/pg17-analyze.json");
    const PG_SEMI: &str = include_str!("plan_cases/pg17-analyze-semi.json");
    const MYSQL_ESTIMATE: &str = include_str!("plan_cases/mysql84-estimate.json");
    const MYSQL_ANALYZE: &str = include_str!("plan_cases/mysql84-analyze.txt");
    const MARIA_ESTIMATE: &str = include_str!("plan_cases/mariadb114-estimate.json");
    const MARIA_ANALYZE: &str = include_str!("plan_cases/mariadb114-analyze.json");
    const COCKROACH: &str = include_str!("plan_cases/cockroach243-estimate.txt");
    const MSSQL_ESTIMATE: &str = include_str!("plan_cases/mssql2022-estimate.xml");
    const MSSQL_ACTUAL: &str = include_str!("plan_cases/mssql2022-actual.xml");

    fn all(nodes: &[PlanNode]) -> Vec<&PlanNode> {
        let mut out = Vec::new();
        for n in nodes {
            out.push(n);
            out.extend(all(&n.children));
        }
        out
    }

    fn ops(plan: &Plan) -> Vec<String> {
        all(&plan.nodes).iter().map(|n| n.op.clone()).collect()
    }

    fn objects(plan: &Plan) -> Vec<String> {
        all(&plan.nodes)
            .iter()
            .filter(|n| !n.object.is_empty())
            .map(|n| n.object.clone())
            .collect()
    }

    #[test]
    fn reads_plans_of_postgres() {
        let plan = parse_pg(PG_ESTIMATE);
        assert!(plan.known && !plan.analyzed);
        assert_eq!(plan.nodes.len(), 1);
        let names = ops(&plan);
        assert_eq!(names[0], "Sort");
        assert!(names.iter().any(|n| n.contains("Hash Join")), "{names:?}");
        assert!(names.iter().any(|n| n == "Seq Scan"));
        let objects = objects(&plan);
        assert!(
            objects.contains(&"sc_p_book".to_owned())
                && objects.contains(&"sc_p_author".to_owned())
        );
        let nodes = all(&plan.nodes);
        assert!(
            nodes
                .iter()
                .all(|n| n.est_rows.is_some() && n.cost.is_some())
        );
        assert!(
            nodes
                .iter()
                .all(|n| n.act_rows.is_none() && n.time_ms.is_none())
        );
        // the scan of the books has its condition
        let book = nodes.iter().find(|n| n.object == "sc_p_book").unwrap();
        assert!(book.detail.contains("price"), "{}", book.detail);

        let ran = parse_pg(PG_ANALYZE);
        assert!(ran.analyzed);
        let nodes = all(&ran.nodes);
        assert!(
            nodes
                .iter()
                .all(|n| n.act_rows.is_some() && n.time_ms.is_some())
        );
        // the times of the nodes themselves add up to the time of the root – loops counted
        let own: f64 = nodes.iter().filter_map(|n| n.self_ms).sum();
        let root = ran.nodes[0].time_ms.unwrap();
        assert!((own - root).abs() < 0.01, "{own} / {root}");
        assert!(ran.total_ms.unwrap() >= root);
        assert!(nodes.iter().any(|n| n.buffers.is_some()));
        // a node that ran in a loop: rows and time over all loops
        let semi = parse_pg(PG_SEMI);
        let nodes = all(&semi.nodes);
        let own: f64 = nodes.iter().filter_map(|n| n.self_ms).sum();
        assert!((own - semi.nodes[0].time_ms.unwrap()).abs() < 0.01);
        for n in &nodes {
            if let (Some(l), Some(t), Some(s)) = (n.loops, n.time_ms, n.self_ms) {
                assert!(l >= 1.0 || t == 0.0);
                assert!(s <= t + 1e-9);
            }
        }
    }

    #[test]
    fn reads_plans_of_mysql_and_mariadb() {
        let plan = parse_mysql(MYSQL_ESTIMATE);
        assert!(plan.known && !plan.analyzed);
        let tables = objects(&plan);
        assert!(tables.iter().any(|o| o.starts_with('b')), "{tables:?}");
        assert!(tables.iter().any(|o| o.starts_with('a')), "{tables:?}");
        assert!(plan.nodes[0].cost.is_some());
        let nodes = all(&plan.nodes);
        assert!(
            nodes.iter().any(|n| n.op.starts_with("table (")),
            "{:?}",
            ops(&plan)
        );
        assert!(nodes.iter().any(|n| n.est_rows.is_some()));

        let tree = parse_mysql_tree(MYSQL_ANALYZE);
        assert!(tree.known && tree.analyzed);
        let names = ops(&tree);
        assert_eq!(names[0], "Sort");
        assert!(
            names.contains(&"Nested loop inner join".to_owned()),
            "{names:?}"
        );
        assert!(names.contains(&"Filter".to_owned()));
        let nodes = all(&tree.nodes);
        let scan = nodes
            .iter()
            .find(|n| n.op == "Table scan" && n.object == "b")
            .unwrap();
        assert_eq!(scan.act_rows, Some(5000.0));
        assert_eq!(scan.est_rows, Some(5000.0));
        assert!(scan.cost.is_some() && scan.time_ms.is_some());
        // the lookup ran once per row of the outer side: rows and time over all loops
        let lookup = nodes
            .iter()
            .find(|n| n.op.contains("index lookup"))
            .unwrap();
        assert_eq!(lookup.object, "a");
        assert!(lookup.loops.unwrap() > 1000.0);
        assert_eq!(lookup.act_rows, lookup.loops);
        assert!(lookup.hints.contains(&Hint::ManyLoops));
        let own: f64 = nodes.iter().filter_map(|n| n.self_ms).sum();
        assert!(own >= tree.nodes[0].time_ms.unwrap() - 0.01);

        let maria = parse_mysql(MARIA_ESTIMATE);
        assert!(maria.known && !maria.analyzed && !objects(&maria).is_empty());
        let ran = parse_mysql(MARIA_ANALYZE);
        assert!(ran.analyzed);
        assert!(ran.total_ms.is_some());
        assert!(
            all(&ran.nodes)
                .iter()
                .any(|n| n.act_rows.is_some() && !n.object.is_empty())
        );
    }

    #[test]
    fn reads_plans_of_sql_server_and_cockroach() {
        let plan = parse_mssql(MSSQL_ESTIMATE);
        assert!(plan.known && !plan.analyzed, "{:?}", ops(&plan));
        let names = ops(&plan);
        assert_eq!(names[0], "Sort");
        assert!(
            names
                .iter()
                .any(|n| n.contains("Scan") || n.contains("Seek")),
            "{names:?}"
        );
        let tables = objects(&plan);
        assert!(
            tables.iter().any(|o| o.starts_with("sc_p_book")),
            "{tables:?}"
        );
        assert!(tables.iter().any(|o| o.starts_with("sc_p_author")));
        let nodes = all(&plan.nodes);
        assert!(
            nodes
                .iter()
                .all(|n| n.est_rows.is_some() && n.cost.is_some())
        );
        // costs grow towards the root
        assert!(plan.nodes[0].cost.unwrap() >= nodes.last().unwrap().cost.unwrap());

        let ran = parse_mssql(MSSQL_ACTUAL);
        assert!(ran.analyzed);
        assert_eq!(ran.nodes[0].act_rows, Some(170.0));
        // (an operator that only computes has no counters of its own)
        let counted = all(&ran.nodes)
            .iter()
            .filter(|n| n.act_rows.is_some())
            .count();
        assert!(counted >= 4, "{counted}");
        assert!(all(&ran.nodes).iter().any(|n| n.buffers.is_some()));

        let crdb = parse_cockroach(COCKROACH);
        assert!(crdb.known);
        let names = ops(&crdb);
        assert_eq!(
            names,
            [
                "sort",
                "group (hash)",
                "hash join",
                "scan",
                "filter",
                "scan"
            ]
        );
        // the tree: the join has two sides, the second scan is below the filter
        let join = &crdb.nodes[0].children[0].children[0];
        assert_eq!(join.children.len(), 2);
        assert_eq!(join.children[1].children[0].op, "scan");
        assert!(objects(&crdb).iter().any(|o| o.starts_with("sc_p_author@")));
        assert_eq!(join.detail, "equality: (id) = (author_id)");
    }

    #[test]
    fn what_is_not_understood_is_shown_as_it_is() {
        for (plan, raw) in [
            (parse_pg("not json"), "not json"),
            (parse_pg("[{\"Plane\": {}}]"), "[{\"Plane\": {}}]"),
            (parse_mysql("{\"query\": 1}"), "{\"query\": 1}"),
            (
                parse_mysql_tree("nothing like a tree"),
                "nothing like a tree",
            ),
            (parse_mssql("<ShowPlanXML><Batch>"), "<ShowPlanXML><Batch>"),
            (parse_mssql("<Other/>"), "<Other/>"),
            (parse_cockroach("no tree"), "no tree"),
        ] {
            assert!(!plan.known, "{raw}");
            assert_eq!(plan.nodes.len(), 1);
            assert_eq!(plan.nodes[0].op, "unknown");
            assert_eq!(plan.raw, raw);
        }
        // a node of a kind nobody knows yet, with keys nobody knows: a node with its raw details
        let future = parse_pg(
            r#"[{"Plan": {"Node Type": "Quantum Scan", "Entanglement": "high", "Plan Rows": 3,
               "Plans": [{"Wholly": "new"}]}}]"#,
        );
        assert!(future.known);
        assert_eq!(future.nodes[0].op, "Quantum Scan");
        assert!(
            future.nodes[0]
                .extra
                .contains(&("Entanglement".into(), "high".into()))
        );
        assert_eq!(future.nodes[0].children[0].op, "unknown");
        // a raw plan of megabytes is cut for the window
        let long = format!(
            "[{{\"Plan\": {{\"Node Type\": \"{}\"}}}}]",
            "x".repeat(MAX_RAW)
        );
        assert!(parse_pg(&long).raw.len() <= MAX_RAW + 4);
    }

    #[test]
    fn hints_where_something_is_worth_a_look() {
        let plan = parse_pg(
            r#"[{"Plan": {"Node Type": "Sort", "Plan Rows": 10, "Actual Rows": 5000, "Actual Loops": 1,
               "Actual Total Time": 30.0, "Sort Method": "external merge", "Sort Space Type": "Disk",
               "Plans": [
                 {"Node Type": "Seq Scan", "Relation Name": "big", "Filter": "(x = 1)", "Plan Rows": 5000,
                  "Actual Rows": 5000, "Actual Loops": 1, "Actual Total Time": 20.0,
                  "Rows Removed by Filter": 995000},
                 {"Node Type": "Index Scan", "Relation Name": "small", "Plan Rows": 1, "Actual Rows": 1,
                  "Actual Loops": 4000, "Actual Total Time": 0.001}
               ]}}]"#,
        );
        let root = &plan.nodes[0];
        assert_eq!(root.hints, [Hint::SortOnDisk, Hint::Misestimate]);
        assert_eq!(root.children[0].hints, [Hint::ScanFilter]);
        assert_eq!(root.children[1].hints, [Hint::ManyLoops]);
        // over all loops: 4000 rows, 4 ms
        assert_eq!(root.children[1].act_rows, Some(4000.0));
        assert!((root.children[1].time_ms.unwrap() - 4.0).abs() < 1e-9);
        assert!((root.self_ms.unwrap() - 6.0).abs() < 1e-9);
        // nothing to say about an ordinary plan
        assert!(
            all(&parse_pg(PG_ESTIMATE).nodes)
                .iter()
                .all(|n| n.hints.is_empty())
        );
    }

    #[test]
    fn asks_each_database_in_its_own_way_and_only_for_one_statement() {
        let q = "SELECT 1";
        let of = |kind, flavor, analyze| ask(kind, flavor, q, analyze).unwrap();
        assert_eq!(
            of(DbKind::Postgres, Flavor::Plain, false).explain,
            "EXPLAIN (FORMAT JSON) SELECT 1"
        );
        assert_eq!(
            of(DbKind::Postgres, Flavor::Plain, true).explain,
            "EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) SELECT 1"
        );
        assert_eq!(
            of(DbKind::Postgres, Flavor::Cockroach, true).explain,
            "EXPLAIN ANALYZE SELECT 1"
        );
        assert_eq!(
            of(DbKind::Mysql, Flavor::Plain, false).explain,
            "EXPLAIN FORMAT=JSON SELECT 1"
        );
        assert_eq!(
            of(DbKind::Mysql, Flavor::Plain, true).explain,
            "EXPLAIN ANALYZE SELECT 1"
        );
        assert_eq!(
            of(DbKind::Mysql, Flavor::Maria, true).explain,
            "ANALYZE FORMAT=JSON SELECT 1"
        );
        let ms = of(DbKind::Sqlserver, Flavor::Plain, false);
        assert_eq!(
            (
                ms.before[0].as_str(),
                ms.explain.as_str(),
                ms.after[0].as_str()
            ),
            ("SET SHOWPLAN_XML ON", "SELECT 1", "SET SHOWPLAN_XML OFF")
        );
        assert_eq!(
            of(DbKind::Sqlserver, Flavor::Plain, true).before[0],
            "SET STATISTICS XML ON"
        );
        assert_eq!(
            of(DbKind::Sqlite, Flavor::Plain, false).explain,
            "EXPLAIN QUERY PLAN SELECT 1"
        );
        assert_eq!(
            ask(DbKind::Sqlite, Flavor::Plain, q, true)
                .unwrap_err()
                .code,
            ErrorCode::Unsupported
        );
        // a trailing semicolon is none; a second statement is refused – it would run
        assert_eq!(
            ask(DbKind::Postgres, Flavor::Plain, " SELECT 1 ; ", false)
                .unwrap()
                .explain,
            "EXPLAIN (FORMAT JSON) SELECT 1"
        );
        for two in ["SELECT 1; DROP TABLE t", "SELECT 1;\nDELETE FROM t;", ""] {
            for kind in [
                DbKind::Postgres,
                DbKind::Mysql,
                DbKind::Sqlserver,
                DbKind::Sqlite,
            ] {
                assert!(
                    ask(kind, Flavor::Plain, two, false).is_err(),
                    "{kind:?}: {two}"
                );
            }
        }
        // a semicolon inside a string is none
        assert!(ask(DbKind::Postgres, Flavor::Plain, "SELECT 'a;b'", false).is_ok());
    }

    #[test]
    fn explains_a_join_in_sqlite() {
        let mut s = sqlite::open(&sqlite::demo_profile()).unwrap();
        s.execute_batch_for_tests(
            "CREATE TABLE p_author (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE p_book (id INTEGER PRIMARY KEY, author_id INTEGER, price NUMERIC);
             INSERT INTO p_author VALUES (1, 'a'); INSERT INTO p_book VALUES (1, 1, 9);",
        );
        let sql = "SELECT a.name, COUNT(*) FROM p_book b JOIN p_author a ON a.id = b.author_id \
                   WHERE b.price > 5 GROUP BY a.name ORDER BY 2 DESC";
        let plan = explain(&mut s, DbKind::Sqlite, sql, false, None, &|| false).unwrap();
        assert!(plan.known && !plan.analyzed);
        let names = ops(&plan);
        assert!(
            names.contains(&"SCAN".to_owned()) && names.contains(&"SEARCH".to_owned()),
            "{names:?}"
        );
        assert!(objects(&plan).contains(&"a".to_owned()));
        assert!(names.iter().any(|n| n.starts_with("USE TEMP B-TREE")));
        // nothing ran, nothing changed; a statement that is none is the database's to refuse
        assert!(
            explain(
                &mut s,
                DbKind::Sqlite,
                "SELEC nonsense",
                false,
                None,
                &|| false
            )
            .is_err()
        );
        assert!(
            explain(
                &mut s,
                DbKind::Sqlite,
                "DELETE FROM p_book; DELETE FROM p_author",
                false,
                None,
                &|| false
            )
            .is_err()
        );
        let left = s
            .query("SELECT COUNT(*) FROM p_book", Limits::rows(1), &|| false)
            .unwrap();
        assert_eq!(
            serde_json::to_value(&left.rows).unwrap(),
            serde_json::json!([[1]])
        );
    }
}
