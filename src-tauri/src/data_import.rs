//! Loading a file into a table (prompt 033) – the reading half: a file is a **stream** of records, read
//! piece by piece however large it is. CSV and TSV (separator, quote, header and encoding found out or
//! told; line breaks inside quoted fields), JSON (an array of objects), NDJSON (an object per line), each
//! of them gzipped or not. From the first records: a preview, and a guess at the type of every column.
//!
//! The file is not trusted: nothing in it is ever executed or interpreted beyond its format, sizes are
//! bounded (a field, a record, the columns), and what it holds reaches a database only as bound values
//! and quoted names (`edit.rs`, `meta::quote`). Pure (no Tauri), tested below.

use crate::error::{AppError, AppResult, ErrorCode};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

/// Bytes read to find out what a file is.
pub const SNIFF_BYTES: usize = 256 * 1024;
/// A field longer than this ends the import: the file is not what it claims to be.
pub const MAX_FIELD_BYTES: usize = 64 * 1024 * 1024;
/// Columns of a file at most.
pub const MAX_COLUMNS: usize = 2_000;
/// Rows a preview shows, and rows looked at for the types.
pub const PREVIEW_ROWS: usize = 200;
pub const SAMPLE_ROWS: usize = 2_000;
/// Of the text of a record this much is kept for the error file.
pub const RAW_KEPT: usize = 4_096;

fn bad(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidQuery, message)
}

fn io(e: std::io::Error) -> AppError {
    AppError::new(ErrorCode::Io, format!("reading the file: {e}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    /// Found out from the name and the first bytes.
    #[default]
    Auto,
    Csv,
    Json,
    Ndjson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Encoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "utf-16be")]
    Utf16Be,
    #[serde(rename = "windows-1252")]
    Windows1252,
}

/// How a file is read. What is `None` is found out.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceOptions {
    #[serde(default)]
    pub format: Format,
    /// One character: `,` `;` tab `|` …
    #[serde(default)]
    pub delimiter: Option<char>,
    /// The quote of CSV; default `"`.
    #[serde(default)]
    pub quote: Option<char>,
    #[serde(default)]
    pub encoding: Option<Encoding>,
    /// The first record names the columns.
    #[serde(default)]
    pub header: Option<bool>,
    /// Lines before the first record that are no data.
    #[serde(default)]
    pub skip_lines: u32,
}

/// What a file turned out to be.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub format: Format,
    pub delimiter: char,
    pub encoding: Encoding,
    pub header: bool,
    pub gzip: bool,
}

/// One record of a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    /// The line of the file it starts in (from 1); for JSON the number of the object.
    pub line: u64,
    /// `None`: the file says null (JSON) – CSV has only texts.
    pub cells: Vec<Option<String>>,
    /// The record as it stands in the file, for the error file (the start of it, if it is long).
    pub raw: String,
}

// --- bytes of any encoding as UTF-8 -----------------------------------------------------------------

/// Reads a file of an encoding as UTF-8, piece by piece. Bytes that are no text in the encoding become
/// U+FFFD – a file is never refused for one bad byte in gigabytes.
struct Transcoder<R: Read> {
    inner: R,
    encoding: Encoding,
    /// Bytes read but not yet a whole character.
    pending: Vec<u8>,
    /// UTF-8 ready to hand out.
    out: Vec<u8>,
    at: usize,
    done: bool,
}

impl<R: Read> Transcoder<R> {
    fn new(inner: R, encoding: Encoding) -> Self {
        Transcoder {
            inner,
            encoding,
            pending: Vec::new(),
            out: Vec::new(),
            at: 0,
            done: false,
        }
    }

    fn fill(&mut self) -> std::io::Result<()> {
        let mut block = [0u8; 64 * 1024];
        let n = self.inner.read(&mut block)?;
        self.done = n == 0;
        self.pending.extend_from_slice(&block[..n]);
        self.out.clear();
        self.at = 0;
        let bytes = std::mem::take(&mut self.pending);
        match self.encoding {
            Encoding::Utf8 => {
                let mut rest = &bytes[..];
                loop {
                    match std::str::from_utf8(rest) {
                        Ok(text) => {
                            self.out.extend_from_slice(text.as_bytes());
                            break;
                        }
                        Err(e) => {
                            let good = e.valid_up_to();
                            self.out.extend_from_slice(&rest[..good]);
                            match e.error_len() {
                                // a wrong byte: it is shown as such, and reading goes on
                                Some(len) => {
                                    self.out.extend_from_slice("\u{FFFD}".as_bytes());
                                    rest = &rest[good + len..];
                                }
                                // a character cut off by the end of the block: with the next one
                                None if !self.done => {
                                    self.pending.extend_from_slice(&rest[good..]);
                                    break;
                                }
                                None => {
                                    self.out.extend_from_slice("\u{FFFD}".as_bytes());
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            Encoding::Windows1252 => {
                let text = crate::textfile::decode_windows_1252(&bytes);
                self.out.extend_from_slice(text.as_bytes());
            }
            Encoding::Utf16Le | Encoding::Utf16Be => {
                let little = self.encoding == Encoding::Utf16Le;
                let whole = bytes.len() - bytes.len() % 2;
                let (pairs, _) = bytes[..whole].as_chunks::<2>();
                let mut units: Vec<u16> = pairs
                    .iter()
                    .map(|p| {
                        if little {
                            u16::from_le_bytes(*p)
                        } else {
                            u16::from_be_bytes(*p)
                        }
                    })
                    .collect();
                let mut keep = whole;
                // half of a pair at the end waits for its other half
                if !self.done && units.last().is_some_and(|u| (0xD800..0xDC00).contains(u)) {
                    units.pop();
                    keep -= 2;
                }
                if !self.done || keep < bytes.len() {
                    self.pending.extend_from_slice(&bytes[keep..]);
                }
                if self.done {
                    self.pending.clear();
                }
                let text: String = char::decode_utf16(units)
                    .map(|c| c.unwrap_or('\u{FFFD}'))
                    .collect();
                self.out.extend_from_slice(text.as_bytes());
            }
        }
        Ok(())
    }
}

impl<R: Read> Read for Transcoder<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.at == self.out.len() {
            if self.done {
                return Ok(0);
            }
            self.fill()?;
        }
        let n = buf.len().min(self.out.len() - self.at);
        buf[..n].copy_from_slice(&self.out[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

// --- finding out what a file is ---------------------------------------------------------------------

/// The encoding by the byte order mark, else UTF-8 if the bytes are that, else Windows-1252. Returns
/// the bytes of the mark to skip.
fn sniff_encoding(bytes: &[u8]) -> (Encoding, usize) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (Encoding::Utf8, 3);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return (Encoding::Utf16Le, 2);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return (Encoding::Utf16Be, 2);
    }
    let utf8 = match std::str::from_utf8(bytes) {
        Ok(_) => true,
        // only the last character is cut off by the end of the sample
        Err(e) => e.error_len().is_none() && bytes.len() - e.valid_up_to() < 4,
    };
    (
        if utf8 {
            Encoding::Utf8
        } else {
            Encoding::Windows1252
        },
        0,
    )
}

/// The separator that gives the records of a sample the same number of fields as the first one. A record ends at a line break outside quotes – a quoted
/// field may run over several lines.
fn sniff_delimiter(sample: &str, quote: char) -> char {
    const CANDIDATES: [char; 4] = [',', ';', '\t', '|'];
    const RECORDS: usize = 30;
    // how often each candidate stands outside quotes, per record
    let mut records: Vec<[usize; 4]> = Vec::new();
    let mut counts = [0usize; 4];
    let mut quoted = false;
    let mut any = false;
    let mut open = false;
    for c in sample.chars() {
        if c == quote {
            quoted = !quoted;
            any = true;
        } else if !quoted && (c == '\n' || c == '\r') {
            if any {
                records.push(counts);
                if records.len() == RECORDS {
                    break;
                }
            }
            counts = [0; 4];
            any = false;
            open = false;
            continue;
        } else {
            any = true;
            if !quoted && let Some(i) = CANDIDATES.iter().position(|d| *d == c) {
                counts[i] += 1;
            }
        }
        open = true;
    }
    // what is left is a whole record only if the sample did not end inside it; taken when it is all
    // there is
    if open && any && !quoted && records.len() < RECORDS {
        records.push(counts);
    }
    // the first record says how many fields there are; the candidate most records agree with wins,
    // among equals the one that stands more often (`1;3,01;x`: two `;`, one `,`)
    let mut best = (',', 0usize, 0usize);
    for (i, candidate) in CANDIDATES.into_iter().enumerate() {
        let first = records.first().map_or(0, |r| r[i]);
        if first == 0 {
            continue;
        }
        let agree = records.iter().filter(|r| r[i] == first).count();
        if (agree, first) > (best.1, best.2) {
            best = (candidate, agree, first);
        }
    }
    best.0
}

fn looks_like_number(text: &str) -> bool {
    let t = text.trim();
    !t.is_empty()
        && t.chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | '-' | '+'))
        && t.chars().any(|c| c.is_ascii_digit())
}

/// A first record names the columns if its cells are all there, all different, and none is a number.
fn sniff_header(first: &[Option<String>]) -> bool {
    let names: Vec<&str> = first
        .iter()
        .map(|c| c.as_deref().unwrap_or("").trim())
        .collect();
    !names.is_empty()
        && names.iter().all(|n| !n.is_empty() && !looks_like_number(n))
        && names
            .iter()
            .enumerate()
            .all(|(i, n)| !names[..i].contains(n))
}

// --- CSV -------------------------------------------------------------------------------------------

/// Reads CSV records from UTF-8: fields in quotes may hold the separator, line breaks and doubled quotes.
/// Lines end with `\n`, `\r\n` or `\r`.
struct CsvReader<R: BufRead> {
    input: R,
    delimiter: u8,
    quote: u8,
    line: u64,
    done: bool,
}

impl<R: BufRead> CsvReader<R> {
    fn next_byte(&mut self) -> AppResult<Option<u8>> {
        let buf = self.input.fill_buf().map_err(io)?;
        let Some(&b) = buf.first() else {
            return Ok(None);
        };
        self.input.consume(1);
        Ok(Some(b))
    }

    fn peek(&mut self) -> AppResult<Option<u8>> {
        Ok(self.input.fill_buf().map_err(io)?.first().copied())
    }

    /// The next record; `None` at the end. A line without anything is no record.
    fn record(&mut self) -> AppResult<Option<Record>> {
        loop {
            if self.done {
                return Ok(None);
            }
            let start = self.line + 1;
            let mut cells: Vec<Option<String>> = Vec::new();
            let mut field: Vec<u8> = Vec::new();
            let mut raw: Vec<u8> = Vec::new();
            let mut quoted = false;
            let mut was_quoted = false;
            let mut any = false;
            let take = |field: &mut Vec<u8>, cells: &mut Vec<Option<String>>| -> AppResult<()> {
                if cells.len() >= MAX_COLUMNS {
                    return Err(bad("a record has too many fields"));
                }
                cells.push(Some(String::from_utf8_lossy(field).into_owned()));
                field.clear();
                Ok(())
            };
            loop {
                let Some(b) = self.next_byte()? else {
                    self.done = true;
                    break;
                };
                any = true;
                if raw.len() < RAW_KEPT {
                    raw.push(b);
                }
                if quoted {
                    if b == self.quote {
                        if self.peek()? == Some(self.quote) {
                            self.next_byte()?;
                            field.push(self.quote);
                        } else {
                            quoted = false;
                        }
                    } else {
                        if b == b'\n' {
                            self.line += 1;
                        }
                        field.push(b);
                    }
                } else if b == self.quote && field.is_empty() && !was_quoted {
                    quoted = true;
                    was_quoted = true;
                } else if b == self.delimiter {
                    take(&mut field, &mut cells)?;
                    was_quoted = false;
                } else if b == b'\n' || b == b'\r' {
                    if b == b'\r' && self.peek()? == Some(b'\n') {
                        self.next_byte()?;
                    }
                    self.line += 1;
                    raw.pop();
                    break;
                } else {
                    field.push(b);
                }
                if field.len() > MAX_FIELD_BYTES {
                    return Err(bad("a field of the file is too long"));
                }
            }
            if self.done {
                if !any {
                    return Ok(None);
                }
                self.line += 1;
            }
            // an empty line is no record
            if cells.is_empty() && field.is_empty() && !was_quoted {
                continue;
            }
            take(&mut field, &mut cells)?;
            return Ok(Some(Record {
                line: start,
                cells,
                raw: String::from_utf8_lossy(&raw).into_owned(),
            }));
        }
    }
}

// --- JSON ------------------------------------------------------------------------------------------

/// The fields of a JSON object in the order of the file, each value as it is written.
struct Fields(Vec<(String, Box<serde_json::value::RawValue>)>);

impl<'de> serde::Deserialize<'de> for Fields {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Fields;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Fields, A::Error> {
                let mut out = Vec::new();
                while let Some(entry) =
                    map.next_entry::<String, Box<serde_json::value::RawValue>>()?
                {
                    out.push(entry);
                }
                Ok(Fields(out))
            }
        }
        d.deserialize_map(V)
    }
}

/// An object of a file: its keys in the order of the file, each with the text a cell holds – texts as
/// they are, **numbers digit for digit as they are written** (never through a float), truth values as
/// written, null as no value, anything nested as its JSON.
type Object = Vec<(String, Option<String>)>;

/// `None`: the text is JSON, but no object – or no JSON at all.
fn parse_object(text: &str) -> Option<Object> {
    let fields: Fields = serde_json::from_str(text).ok()?;
    Some(
        fields
            .0
            .into_iter()
            .map(|(key, raw)| {
                let raw = raw.get();
                let cell = match raw.as_bytes().first() {
                    Some(b'n') => None,
                    Some(b'"') => serde_json::from_str::<String>(raw).ok(),
                    _ => Some(raw.to_owned()),
                };
                (key, cell)
            })
            .collect(),
    )
}

fn raw_of(text: &str) -> String {
    let text = text.trim();
    let mut end = text.len().min(RAW_KEPT);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// Reads the objects of a JSON array one by one, without holding the array.
struct JsonArray<R: Read> {
    bytes: std::io::Bytes<R>,
    started: bool,
    done: bool,
    number: u64,
    /// A byte read ahead.
    held: Option<u8>,
}

impl<R: Read> JsonArray<R> {
    fn byte(&mut self) -> AppResult<Option<u8>> {
        if let Some(b) = self.held.take() {
            return Ok(Some(b));
        }
        self.bytes.next().transpose().map_err(io)
    }

    fn skip_space(&mut self) -> AppResult<Option<u8>> {
        loop {
            match self.byte()? {
                Some(b) if b.is_ascii_whitespace() => {}
                other => return Ok(other),
            }
        }
    }

    /// The text of the next element of the array: from its first byte to the byte that closes it.
    fn element(&mut self) -> AppResult<Option<Vec<u8>>> {
        if self.done {
            return Ok(None);
        }
        if !self.started {
            match self.skip_space()? {
                Some(b'[') => self.started = true,
                _ => return Err(bad("the file is no JSON array")),
            }
        }
        let first = match self.skip_space()? {
            Some(b',') => self.skip_space()?,
            other => other,
        };
        let Some(first) = first else {
            return Err(bad("the JSON array does not end"));
        };
        if first == b']' {
            self.done = true;
            return Ok(None);
        }
        let mut text = vec![first];
        let (mut depth, mut in_string, mut escaped) = (0i64, false, false);
        let track = |b: u8, depth: &mut i64, in_string: &mut bool, escaped: &mut bool| {
            if *in_string {
                if *escaped {
                    *escaped = false;
                } else if b == b'\\' {
                    *escaped = true;
                } else if b == b'"' {
                    *in_string = false;
                }
            } else {
                match b {
                    b'"' => *in_string = true,
                    b'{' | b'[' => *depth += 1,
                    b'}' | b']' => *depth -= 1,
                    _ => {}
                }
            }
        };
        track(first, &mut depth, &mut in_string, &mut escaped);
        while depth > 0 || in_string {
            let Some(b) = self.byte()? else {
                return Err(bad("the JSON array does not end"));
            };
            track(b, &mut depth, &mut in_string, &mut escaped);
            text.push(b);
            if text.len() > MAX_FIELD_BYTES {
                return Err(bad("an object of the file is too long"));
            }
        }
        // a scalar (a number, `true`) runs to the next comma or bracket
        if !matches!(first, b'{' | b'[' | b'"') {
            loop {
                match self.byte()? {
                    Some(b) if b == b',' || b == b']' => {
                        self.held = Some(b);
                        break;
                    }
                    Some(b) => text.push(b),
                    None => break,
                }
            }
        }
        self.number += 1;
        Ok(Some(text))
    }
}

/// The records of a file, whatever its format.
enum Records {
    Csv(Box<CsvReader<BufReader<Box<dyn Read>>>>),
    Json(Box<JsonArray<BufReader<Box<dyn Read>>>>),
    Ndjson {
        input: BufReader<Box<dyn Read>>,
        line: u64,
    },
}

/// A record, or the one that could not be read: its line, why, and how it stands in the file.
pub type NextRecord = Result<Record, (u64, String, String)>;

/// An open file: what it is, the names of its columns, and its records one after the other.
pub struct Source {
    pub detected: Detected,
    pub columns: Vec<String>,
    records: Records,
    /// Records read ahead to find the columns: handed out first.
    ahead: std::collections::VecDeque<Record>,
    /// The same for JSON, where a record read ahead may be one that cannot be read.
    #[allow(clippy::type_complexity)]
    broken_ahead: std::collections::VecDeque<Result<Record, (u64, String, String)>>,
    /// JSON: the keys of the objects in the order of `columns`.
    keys: Vec<String>,
}

/// The cells of an object in the order of the columns; a key that occurs twice counts once (the last).
fn object_cells(object: &Object, keys: &[String]) -> Vec<Option<String>> {
    keys.iter()
        .map(|k| {
            object
                .iter()
                .rev()
                .find(|(key, _)| key == k)
                .and_then(|(_, cell)| cell.clone())
        })
        .collect()
}

impl Source {
    /// Opens a file. `sample` bytes are read to find out what is not told.
    pub fn open(path: &Path, options: &SourceOptions) -> AppResult<Source> {
        let file = std::fs::File::open(path).map_err(io)?;
        let mut head = [0u8; 2];
        let mut probe = BufReader::new(file);
        let gzip = {
            let buf = probe.fill_buf().map_err(io)?;
            let n = buf.len().min(2);
            head[..n].copy_from_slice(&buf[..n]);
            head == [0x1F, 0x8B]
        };
        let mut plain: Box<dyn Read> = if gzip {
            Box::new(flate2::read::MultiGzDecoder::new(probe))
        } else {
            Box::new(probe)
        };
        // the first bytes: to find the encoding, the format, the separator
        let mut sniff = vec![0u8; SNIFF_BYTES];
        let mut got = 0;
        while got < sniff.len() {
            let n = plain.read(&mut sniff[got..]).map_err(io)?;
            if n == 0 {
                break;
            }
            got += n;
        }
        sniff.truncate(got);
        let (found, mark) = sniff_encoding(&sniff);
        let encoding = options.encoding.unwrap_or(found);
        // a mark of the encoding that is told is skipped too
        let mark = if encoding == found { mark } else { 0 };
        let rest: Box<dyn Read> =
            Box::new(std::io::Cursor::new(sniff[mark..].to_vec()).chain(plain));
        let text: Box<dyn Read> = Box::new(Transcoder::new(rest, encoding));
        let mut input = BufReader::with_capacity(64 * 1024, text);
        // the format: told, else by the name, else by the first sign
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let name = name.strip_suffix(".gz").unwrap_or(&name).to_owned();
        let sample = {
            let buf = input.fill_buf().map_err(io)?;
            String::from_utf8_lossy(buf).into_owned()
        };
        let first_sign = sample
            .trim_start_matches('\u{FEFF}')
            .trim_start()
            .chars()
            .next();
        let format = match options.format {
            Format::Auto if name.ends_with(".ndjson") || name.ends_with(".jsonl") => Format::Ndjson,
            Format::Auto if name.ends_with(".json") || first_sign == Some('[') => Format::Json,
            Format::Auto if first_sign == Some('{') => Format::Ndjson,
            Format::Auto => Format::Csv,
            told => told,
        };
        let quote = options.quote.unwrap_or('"');
        let delimiter = options.delimiter.unwrap_or_else(|| {
            if name.ends_with(".tsv") || name.ends_with(".tab") {
                '\t'
            } else {
                sniff_delimiter(&sample, quote)
            }
        });
        if !delimiter.is_ascii() || !quote.is_ascii() || delimiter == quote {
            return Err(bad(
                "separator and quote are one plain character each, and not the same",
            ));
        }
        let mut detected = Detected {
            format,
            delimiter,
            encoding,
            header: false,
            gzip,
        };
        let mut source = Source {
            detected: detected.clone(),
            columns: Vec::new(),
            records: match format {
                Format::Json => Records::Json(Box::new(JsonArray {
                    bytes: input.bytes(),
                    started: false,
                    done: false,
                    number: 0,
                    held: None,
                })),
                Format::Ndjson => Records::Ndjson { input, line: 0 },
                _ => {
                    let mut reader = CsvReader {
                        input,
                        delimiter: delimiter as u8,
                        quote: quote as u8,
                        line: 0,
                        done: false,
                    };
                    for _ in 0..options.skip_lines {
                        let mut line = Vec::new();
                        if reader.input.read_until(b'\n', &mut line).map_err(io)? == 0 {
                            break;
                        }
                        reader.line += 1;
                    }
                    Records::Csv(Box::new(reader))
                }
            },
            ahead: std::collections::VecDeque::new(),
            broken_ahead: std::collections::VecDeque::new(),
            keys: Vec::new(),
        };
        if format == Format::Csv {
            let first = source.raw_record()?;
            let header = options
                .header
                .unwrap_or_else(|| first.as_ref().is_some_and(|r| sniff_header(&r.cells)));
            detected.header = header;
            match first {
                Some(record) if header => {
                    source.columns = record
                        .cells
                        .iter()
                        .enumerate()
                        .map(|(i, c)| {
                            let name = c
                                .as_deref()
                                .unwrap_or("")
                                .trim()
                                .trim_start_matches('\u{FEFF}');
                            if name.is_empty() {
                                format!("column_{}", i + 1)
                            } else {
                                name.to_owned()
                            }
                        })
                        .collect();
                }
                Some(record) => {
                    source.columns = (1..=record.cells.len())
                        .map(|i| format!("column_{i}"))
                        .collect();
                    source.ahead.push_back(record);
                }
                None => {}
            }
        } else {
            // the columns of JSON are the keys of the first objects, in the order they come
            let mut objects: Vec<(u64, Option<Object>, String)> = Vec::new();
            while objects.len() < SAMPLE_ROWS {
                let Some((line, text)) = source.raw_object()? else {
                    break;
                };
                let object = parse_object(&text);
                for (key, _) in object.iter().flatten() {
                    if !source.keys.contains(key) {
                        if source.keys.len() >= MAX_COLUMNS {
                            return Err(bad("the objects have too many different keys"));
                        }
                        source.keys.push(key.clone());
                    }
                }
                objects.push((line, object, raw_of(&text)));
            }
            source.columns = source.keys.clone();
            for (line, object, raw) in objects {
                source.broken_ahead.push_back(match object {
                    Some(object) => Ok(Record {
                        line,
                        cells: object_cells(&object, &source.keys),
                        raw,
                    }),
                    None => Err((line, "not a JSON object".to_owned(), raw)),
                });
            }
        }
        source.detected = detected;
        Ok(source)
    }

    fn raw_record(&mut self) -> AppResult<Option<Record>> {
        match &mut self.records {
            Records::Csv(reader) => reader.record(),
            _ => Ok(None),
        }
    }

    /// The text of the next object of a JSON file, with its number (the line, in NDJSON).
    fn raw_object(&mut self) -> AppResult<Option<(u64, String)>> {
        match &mut self.records {
            Records::Json(array) => {
                let Some(text) = array.element()? else {
                    return Ok(None);
                };
                Ok(Some((
                    array.number,
                    String::from_utf8_lossy(&text).into_owned(),
                )))
            }
            Records::Ndjson { input, line } => loop {
                let mut text = String::new();
                if input
                    .take(MAX_FIELD_BYTES as u64 + 1)
                    .read_line(&mut text)
                    .map_err(io)?
                    == 0
                {
                    return Ok(None);
                }
                *line += 1;
                if text.len() > MAX_FIELD_BYTES {
                    return Err(bad("a line of the file is too long"));
                }
                if text.trim().is_empty() {
                    continue;
                }
                return Ok(Some((*line, text)));
            },
            Records::Csv(_) => Ok(None),
        }
    }

    /// The next record. `Err` in the record: it could not be read (its line and text are in the error),
    /// the reading goes on. An `Err` outside ends the reading.
    #[allow(clippy::type_complexity)]
    /// A CSV record with more fields than the file has columns is not cut: an unquoted separator in a
    /// value would shift what follows it into nothing. Empty fields at the end (a separator behind the
    /// last value) are no fields.
    fn fitting(&self, mut record: Record) -> NextRecord {
        let width = self.columns.len();
        if matches!(self.records, Records::Csv(_)) && record.cells.len() > width {
            if record.cells[width..]
                .iter()
                .any(|c| c.as_deref().is_some_and(|v| !v.is_empty()))
            {
                return Err((
                    record.line,
                    "more fields than columns".to_owned(),
                    record.raw,
                ));
            }
            record.cells.truncate(width);
        }
        Ok(record)
    }

    pub fn next_record(&mut self) -> AppResult<Option<NextRecord>> {
        if let Some(record) = self.broken_ahead.pop_front() {
            return Ok(Some(record));
        }
        if let Some(record) = self.ahead.pop_front() {
            return Ok(Some(self.fitting(record)));
        }
        if matches!(self.records, Records::Csv(_)) {
            return Ok(self.raw_record()?.map(|r| self.fitting(r)));
        }
        let Some((line, text)) = self.raw_object()? else {
            return Ok(None);
        };
        let raw = raw_of(&text);
        Ok(Some(match parse_object(&text) {
            Some(object) => Ok(Record {
                line,
                cells: object_cells(&object, &self.keys),
                raw,
            }),
            None => Err((line, "not a JSON object".to_owned(), raw)),
        }))
    }
}

// --- types ------------------------------------------------------------------------------------------

/// What the values of a column look like.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GuessKind {
    Int,
    Decimal,
    Bool,
    Date,
    DateTime,
    Text,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Guess {
    pub kind: GuessKind,
    /// Characters of the longest value.
    pub max_len: usize,
    /// A value was missing (empty, or one of the null texts).
    pub nullable: bool,
}

fn is_date(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn is_datetime(t: &str) -> bool {
    t.len() >= 16
        && t.is_char_boundary(10)
        && is_date(&t[..10])
        && matches!(t.as_bytes()[10], b' ' | b'T')
        && t[11..]
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, ':' | '.' | '+' | '-' | 'Z'))
}

fn is_int(t: &str) -> bool {
    let digits = t.strip_prefix(['-', '+']).unwrap_or(t);
    !digits.is_empty()
        && digits.len() <= 18
        && digits.bytes().all(|b| b.is_ascii_digit())
        // 007 is a text (a postcode), 0 is a number
        && (digits.len() == 1 || !digits.starts_with('0'))
}

fn is_decimal(t: &str) -> bool {
    let body = t.strip_prefix(['-', '+']).unwrap_or(t);
    let Some((a, b)) = body.split_once('.') else {
        return false;
    };
    !a.is_empty()
        && !b.is_empty()
        && a.len() + b.len() <= 38
        && a.bytes().chain(b.bytes()).all(|c| c.is_ascii_digit())
}

fn is_bool(t: &str) -> bool {
    matches!(t.to_ascii_lowercase().as_str(), "true" | "false")
}

/// The type of every column from some of its records: the narrowest kind all its values fit. A column
/// without any value is text. `nulls`: texts that mean „no value“ (the empty text always does).
pub fn guess_types(rows: &[Vec<Option<String>>], columns: usize, nulls: &[String]) -> Vec<Guess> {
    (0..columns)
        .map(|c| {
            let mut guess = Guess {
                kind: GuessKind::Text,
                max_len: 0,
                nullable: false,
            };
            // which kinds every value seen so far fits
            let (mut int, mut dec, mut boolean, mut date, mut time, mut any) =
                (true, true, true, true, true, false);
            for row in rows {
                let value = row.get(c).and_then(|v| v.as_deref()).map(str::trim);
                let Some(value) = value.filter(|v| !v.is_empty() && !nulls.iter().any(|n| n == v))
                else {
                    guess.nullable = true;
                    continue;
                };
                any = true;
                guess.max_len = guess.max_len.max(value.chars().count());
                int &= is_int(value);
                dec &= is_int(value) || is_decimal(value);
                boolean &= is_bool(value);
                date &= is_date(value);
                time &= is_datetime(value) || is_date(value);
            }
            guess.kind = match (any, int, dec, boolean, date, time) {
                (false, ..) => GuessKind::Text,
                (_, true, ..) => GuessKind::Int,
                (_, _, true, ..) => GuessKind::Decimal,
                (_, _, _, true, ..) => GuessKind::Bool,
                (_, _, _, _, true, _) => GuessKind::Date,
                (_, _, _, _, _, true) => GuessKind::DateTime,
                _ => GuessKind::Text,
            };
            guess
        })
        .collect()
}

/// The first records of a file and what was found out about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub detected: Detected,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub types: Vec<Guess>,
    /// Records that could not be read among the first ones.
    pub broken: usize,
}

/// Reads the start of a file: its columns, its first rows, a guess at the types.
pub fn preview(path: &Path, options: &SourceOptions, nulls: &[String]) -> AppResult<Preview> {
    let mut source = Source::open(path, options)?;
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut broken = 0;
    while rows.len() < SAMPLE_ROWS {
        match source.next_record()? {
            Some(Ok(record)) => rows.push(record.cells),
            Some(Err(_)) => broken += 1,
            None => break,
        }
    }
    let width = rows
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or(0)
        .max(source.columns.len());
    let mut columns = source.columns.clone();
    for i in columns.len()..width {
        columns.push(format!("column_{}", i + 1));
    }
    let types = guess_types(&rows, width, nulls);
    rows.truncate(PREVIEW_ROWS);
    Ok(Preview {
        detected: source.detected,
        columns,
        rows,
        types,
        broken,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn file(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn all(path: &Path, options: &SourceOptions) -> (Source, Vec<Vec<Option<String>>>) {
        let mut source = Source::open(path, options).unwrap();
        let mut rows = Vec::new();
        while let Some(record) = source.next_record().unwrap() {
            rows.push(record.unwrap().cells);
        }
        (source, rows)
    }

    fn cells(row: &[&str]) -> Vec<Option<String>> {
        row.iter().map(|c| Some((*c).to_owned())).collect()
    }

    #[test]
    fn reads_csv_with_quotes_line_breaks_and_every_line_ending() {
        let dir = tempdir().unwrap();
        let path = file(
            dir.path(),
            "a.csv",
            b"id,name,note\r\n1,\"Smith, J.\",\"two\nlines\"\r2,\"say \"\"hi\"\"\",\n\n3,plain,\"\"\n4,5\" pipe,x",
        );
        let (source, rows) = all(&path, &SourceOptions::default());
        assert_eq!(source.columns, ["id", "name", "note"]);
        assert_eq!(
            source.detected,
            Detected {
                format: Format::Csv,
                delimiter: ',',
                encoding: Encoding::Utf8,
                header: true,
                gzip: false
            }
        );
        assert_eq!(
            rows,
            [
                cells(&["1", "Smith, J.", "two\nlines"]),
                cells(&["2", "say \"hi\"", ""]),
                cells(&["3", "plain", ""]),
                cells(&["4", "5\" pipe", "x"]),
            ]
        );
    }

    #[test]
    fn finds_separator_header_and_line_numbers() {
        let dir = tempdir().unwrap();
        let semi = file(dir.path(), "b.csv", b"1;2,5;x\n2;3,5;y\n");
        let (source, rows) = all(&semi, &SourceOptions::default());
        // numbers in the first line: no header, the columns get names
        assert_eq!(
            (source.detected.delimiter, source.detected.header),
            (';', false)
        );
        assert_eq!(source.columns, ["column_1", "column_2", "column_3"]);
        assert_eq!(rows[0], cells(&["1", "2,5", "x"]));
        let tab = file(dir.path(), "c.tsv", b"# a comment\nid\tname\n7\tAda\n");
        let options = SourceOptions {
            skip_lines: 1,
            ..SourceOptions::default()
        };
        let mut source = Source::open(&tab, &options).unwrap();
        assert_eq!(source.detected.delimiter, '\t');
        let first = source.next_record().unwrap().unwrap().unwrap();
        // the line of the file, counted with the skipped line and the header
        assert_eq!((first.line, first.raw.as_str()), (3, "7\tAda"));
        // told otherwise: the first line is data
        let told = SourceOptions {
            header: Some(false),
            delimiter: Some(','),
            ..SourceOptions::default()
        };
        let (source, rows) = all(&semi, &told);
        assert!(!source.detected.header);
        assert_eq!(rows[0], cells(&["1;2", "5;x"]));
    }

    #[test]
    fn reads_every_encoding_and_marks_what_is_no_text() {
        let dir = tempdir().unwrap();
        let text = "name;ort\nJürgen;Köln €\n";
        let utf8_bom = [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat();
        let latin: Vec<u8> = "name;ort\nJ\u{fc}rgen;K\u{f6}ln \u{80}\n"
            .chars()
            .map(|c| c as u8)
            .collect();
        let utf16le: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        let utf16be: Vec<u8> = [0xFE, 0xFF]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_be_bytes))
            .collect();
        for (name, bytes, encoding) in [
            ("u8.csv", utf8_bom, Encoding::Utf8),
            ("l1.csv", latin, Encoding::Windows1252),
            ("le.csv", utf16le, Encoding::Utf16Le),
            ("be.csv", utf16be, Encoding::Utf16Be),
        ] {
            let path = file(dir.path(), name, &bytes);
            let (source, rows) = all(&path, &SourceOptions::default());
            assert_eq!(source.detected.encoding, encoding, "{name}");
            assert_eq!(source.columns, ["name", "ort"], "{name}");
            assert_eq!(rows, [cells(&["Jürgen", "Köln €"])], "{name}");
        }
        // a wrong byte in a file that is told to be UTF-8 is shown, and the reading goes on
        let broken = file(dir.path(), "x.csv", b"a,b\n1,\xFFx\n2,y\n");
        let told = SourceOptions {
            encoding: Some(Encoding::Utf8),
            ..SourceOptions::default()
        };
        let (_, rows) = all(&broken, &told);
        assert_eq!(rows, [cells(&["1", "\u{FFFD}x"]), cells(&["2", "y"])]);
    }

    #[test]
    fn a_character_split_by_a_block_of_the_file_stays_whole() {
        let dir = tempdir().unwrap();
        // far more than one block of the transcoder, every character of several bytes
        let line = "ä😀€,x\n";
        let text: String = std::iter::once("a,b\n")
            .chain(std::iter::repeat_n(line, 40_000))
            .collect();
        for (name, bytes) in [
            ("u8.csv", text.as_bytes().to_vec()),
            (
                "le.csv",
                [0xFF, 0xFE]
                    .into_iter()
                    .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
                    .collect(),
            ),
        ] {
            let path = file(dir.path(), name, &bytes);
            let (_, rows) = all(&path, &SourceOptions::default());
            assert_eq!(rows.len(), 40_000, "{name}");
            assert!(rows.iter().all(|r| r == &cells(&["ä😀€", "x"])), "{name}");
        }
    }

    #[test]
    fn reads_json_arrays_and_ndjson_object_by_object() {
        let dir = tempdir().unwrap();
        let json = file(
            dir.path(),
            "a.json",
            br#" [ {"id": 1, "name": "A, \"B\" ]}", "tags": ["x", {"y": 1}], "ok": true},
              {"id": 2.50, "name": null, "extra": "late"} , 7 ] "#,
        );
        let mut source = Source::open(&json, &SourceOptions::default()).unwrap();
        assert_eq!(source.detected.format, Format::Json);
        // the keys in the order of the file, new keys of later objects behind
        assert_eq!(source.columns, ["id", "name", "tags", "ok", "extra"]);
        let first = source.next_record().unwrap().unwrap().unwrap();
        assert_eq!(
            first.cells,
            [
                Some("1".into()),
                Some("A, \"B\" ]}".into()),
                Some("[\"x\", {\"y\": 1}]".into()),
                Some("true".into()),
                None
            ]
        );
        let second = source.next_record().unwrap().unwrap().unwrap();
        assert_eq!(second.cells[0].as_deref(), Some("2.50"));
        assert_eq!((second.cells[1].clone(), second.line), (None, 2));
        // an element that is no object is a record that cannot be read – the others are read
        assert!(source.next_record().unwrap().unwrap().is_err());
        assert!(source.next_record().unwrap().is_none());

        let nd = file(
            dir.path(),
            "b.ndjson",
            b"{\"a\":1}\n\nnot json\n{\"a\":\"x\",\"b\":2}\n",
        );
        let mut source = Source::open(&nd, &SourceOptions::default()).unwrap();
        assert_eq!(source.detected.format, Format::Ndjson);
        assert_eq!(source.columns, ["a", "b"]);
        let mut seen = Vec::new();
        while let Some(record) = source.next_record().unwrap() {
            seen.push(
                record
                    .map(|r| (r.line, r.cells))
                    .map_err(|(line, _, raw)| (line, raw)),
            );
        }
        assert_eq!(
            seen,
            [
                Ok((1, vec![Some("1".into()), None])),
                Err((3, "not json".into())),
                Ok((4, vec![Some("x".into()), Some("2".into())])),
            ]
        );
        assert!(
            Source::open(
                &file(dir.path(), "c.json", b"{\"a\":1}"),
                &SourceOptions {
                    format: Format::Json,
                    ..SourceOptions::default()
                }
            )
            .and_then(|mut s| s.next_record())
            .is_err()
        );
    }

    #[test]
    fn reads_gzip_and_refuses_what_is_no_format() {
        let dir = tempdir().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(b"id,name\n1,Ada\n").unwrap();
        let path = file(dir.path(), "a.csv.gz", &gz.finish().unwrap());
        let (source, rows) = all(&path, &SourceOptions::default());
        assert!(source.detected.gzip);
        assert_eq!(rows, [cells(&["1", "Ada"])]);
        let same = SourceOptions {
            delimiter: Some('"'),
            ..SourceOptions::default()
        };
        assert!(Source::open(&path, &same).is_err());
        assert!(Source::open(&dir.path().join("missing.csv"), &SourceOptions::default()).is_err());
        // an empty file has no columns and no records
        let (source, rows) = all(&file(dir.path(), "e.csv", b""), &SourceOptions::default());
        assert!(source.columns.is_empty() && rows.is_empty());
    }

    #[test]
    fn guesses_the_narrowest_type_every_value_fits() {
        let rows: Vec<Vec<Option<String>>> = [
            [
                "1",
                "1.5",
                "true",
                "2026-11-11",
                "2026-11-11 10:00:00",
                "007",
                "",
                "x",
            ],
            [
                "-20",
                "2",
                "FALSE",
                "2024-02-29",
                "2026-11-12",
                "12",
                "NULL",
                "",
            ],
            [
                "",
                "3.25",
                "true",
                "2020-01-01",
                "2026-11-11T10:00:00.5Z",
                "3",
                "",
                "long text",
            ],
        ]
        .iter()
        .map(|r| r.iter().map(|c| Some((*c).to_owned())).collect())
        .collect();
        let guess = guess_types(&rows, 8, &["NULL".to_owned()]);
        let kinds: Vec<GuessKind> = guess.iter().map(|g| g.kind).collect();
        assert_eq!(
            kinds,
            [
                GuessKind::Int,
                GuessKind::Decimal,
                GuessKind::Bool,
                GuessKind::Date,
                GuessKind::DateTime,
                // a leading zero is no number: a postcode stays what it is
                GuessKind::Text,
                // nothing but missing values
                GuessKind::Text,
                GuessKind::Text,
            ]
        );
        assert!(guess[0].nullable && !guess[1].nullable && guess[6].nullable);
        assert_eq!(guess[7].max_len, 9);
        // a later value that contradicts makes the column wider, never an error
        let mixed = vec![vec![Some("1".to_owned())], vec![Some("abc".to_owned())]];
        assert_eq!(guess_types(&mixed, 1, &[])[0].kind, GuessKind::Text);
    }

    #[test]
    fn previews_the_start_of_a_file() {
        let dir = tempdir().unwrap();
        let text: String = std::iter::once("id;amount;day\n".to_owned())
            .chain((1..=500).map(|i| format!("{i};{i}.5;2026-01-{:02}\n", i % 28 + 1)))
            .collect();
        let path = file(dir.path(), "p.csv", text.as_bytes());
        let p = preview(&path, &SourceOptions::default(), &[]).unwrap();
        assert_eq!(p.columns, ["id", "amount", "day"]);
        assert_eq!(p.rows.len(), PREVIEW_ROWS);
        assert_eq!(
            p.types.iter().map(|t| t.kind).collect::<Vec<_>>(),
            [GuessKind::Int, GuessKind::Decimal, GuessKind::Date]
        );
        assert_eq!(p.broken, 0);
        // a row with more fields than the header is a broken record; a separator at the end is not
        let wide = file(dir.path(), "w.csv", b"a,b\n1,2,3\n4,5,\n");
        let p = preview(&wide, &SourceOptions::default(), &[]).unwrap();
        assert_eq!(p.columns, ["a", "b"]);
        assert_eq!((p.broken, p.rows.len()), (1, 1));
    }
    #[test]
    fn finds_the_delimiter_when_fields_hold_line_breaks() {
        // a quoted field over two lines: counted by record, not by line – else no candidate is in
        // "every line" and the comma of the amounts wins
        let sample =
            "id;amount;note\n1;3,01;\"a; b\nsecond line\"\n2;6,02;\"c\nd, e, f, g\"\n3;9,03;x\n";
        assert_eq!(sniff_delimiter(sample, '"'), ';');
        assert_eq!(sniff_delimiter("a,b\n\"x\ny\",2\n", '"'), ',');
    }
    #[test]
    fn a_record_with_more_fields_than_columns_is_not_cut_in_silence() {
        // an unquoted separator inside a value: the record has a field too many – it is a problem of
        // that record, not a row with a cut value
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("in.csv");
        std::fs::write(&path, "id;note\n1;fine\n2;a; b\n3;\n4\n").unwrap();
        let mut source = Source::open(&path, &SourceOptions::default()).unwrap();
        let mut seen = Vec::new();
        while let Some(record) = source.next_record().unwrap() {
            seen.push(match record {
                Ok(r) => format!("{}: {}", r.line, r.cells.len()),
                Err((line, reason, raw)) => format!("{line}: {reason} [{raw}]"),
            });
        }
        assert_eq!(
            seen,
            [
                "2: 2",
                "3: more fields than columns [2;a; b]",
                "4: 2",
                "5: 1"
            ]
        );
    }
}
