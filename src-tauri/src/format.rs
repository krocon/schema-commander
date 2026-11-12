//! Formatting SQL (prompt 023). Pure: no Tauri, no database.
//!
//! The formatter never parses SQL into a tree it would have to write back. It cuts the text into tokens,
//! decides **only** what stands between two tokens (nothing, a blank, a line break with an indentation) and,
//! if asked, in which case a keyword is written. Strings, comments, quoted names, dollar quoting and hints
//! are tokens and leave as they came.
//!
//! What it promises is checked on every call: the result is cut into tokens again and compared with the
//! tokens of the text (`same_tokens`). If they differ, nothing is returned but [`FormatError::Unsafe`] – the
//! text stays as it is. Text that ends inside a string or a comment is refused ([`FormatError::Incomplete`]):
//! there a blank more or less would change a value.
//!
//! The layout: every clause on its line; a list (`SELECT a, b`) or a condition (`a AND b`) stays on its line
//! while it fits into the width, else one entry per line. Brackets, `CASE` and `BEGIN … END` are groups: a
//! group that fits stays on its line, one that does not is opened, indented and closed on a line of its own.
//! All decisions depend on the tokens alone, never on the blanks of the text – formatting twice is formatting
//! once.

use serde::Deserialize;

/// More than this is no script to format.
pub const MAX_BYTES: usize = 256 * 1024 * 1024;
/// Brackets, `CASE` and blocks inside each other at most (the layout recurses once per level).
const MAX_DEPTH: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    Postgres,
    Mysql,
    Sqlserver,
    Sqlite,
    /// Oracle (prompt 035b): the common rules; what they do not fit (a q-quote, PL/SQL) is found by
    /// the check of the tokens and left as it was.
    Oracle,
    /// DuckDB (prompt 035c): the common rules.
    Duckdb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeywordCase {
    Upper,
    Lower,
    Preserve,
}

/// Where a comma or `AND`/`OR` stands when its line breaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Place {
    Leading,
    Trailing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Lay the text out by the style.
    Format,
    /// Everything on one line (a line comment still ends its line).
    Oneline,
    /// Only write the keywords in upper / lower case; no blank changes.
    Upper,
    Lower,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Style {
    pub keyword_case: KeywordCase,
    /// Blanks per level, 1..=8.
    pub indent: u8,
    pub comma: Place,
    /// Characters a line may have before lists and brackets are broken, 40..=400.
    pub width: u16,
    pub and_or: Place,
    /// Empty lines between two statements, 0..=3.
    pub blank_lines: u8,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            keyword_case: KeywordCase::Upper,
            indent: 4,
            comma: Place::Trailing,
            width: 100,
            and_or: Place::Leading,
            blank_lines: 1,
        }
    }
}

impl Style {
    fn clamped(self) -> Self {
        Self {
            indent: self.indent.clamp(1, 8),
            width: self.width.clamp(40, 400),
            blank_lines: self.blank_lines.min(3),
            ..self
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatError {
    Cancelled,
    /// The text ends inside a string, a quoted name or a comment.
    Incomplete,
    /// Nested deeper than the formatter follows.
    TooDeep,
    /// The result would not have had the tokens of the text: a bug of the formatter, caught.
    Unsafe,
    TooLarge,
}

// ---------------------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Word,
    Quoted,
    Str,
    Num,
    LineComment,
    BlockComment,
    Open,
    Close,
    Comma,
    /// `;` or the delimiter a `DELIMITER` line set.
    Term,
    Dot,
    /// `::`
    Cast,
    Op,
    /// Any other sign: keeps the blanks it has, on both sides.
    Other,
    /// A line of the client, not of the database: `GO`, `DELIMITER //`. Stays a line of its own.
    RawLine,
}

macro_rules! keywords {
    ($($id:ident),* $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        #[allow(clippy::upper_case_acronyms, non_camel_case_types)]
        enum Kw { No, $($id),* }
        fn kw_of(upper: &str) -> Kw {
            match upper { $(stringify!($id) => Kw::$id,)* _ => Kw::No }
        }
    };
}

keywords!(
    SELECT,
    FROM,
    WHERE,
    GROUP,
    BY,
    HAVING,
    ORDER,
    LIMIT,
    OFFSET,
    FETCH,
    WINDOW,
    UNION,
    EXCEPT,
    INTERSECT,
    ALL,
    DISTINCT,
    INSERT,
    INTO,
    VALUES,
    UPDATE,
    SET,
    DELETE,
    RETURNING,
    WITH,
    RECURSIVE,
    MERGE,
    USING,
    WHEN,
    MATCHED,
    THEN,
    ELSE,
    ELSEIF,
    END,
    CASE,
    BEGIN,
    JOIN,
    INNER,
    LEFT,
    RIGHT,
    FULL,
    OUTER,
    CROSS,
    NATURAL,
    APPLY,
    STRAIGHT_JOIN,
    ON,
    CONFLICT,
    DUPLICATE,
    KEY,
    AS,
    AND,
    OR,
    NOT,
    BETWEEN,
    IS,
    IN,
    EXISTS,
    CREATE,
    ALTER,
    DROP,
    TABLE,
    VIEW,
    IF,
    WHILE,
    DO,
    LOOP,
    REPEAT,
    UNTIL,
    FOR,
    OF,
    AFTER,
    BEFORE,
    INSTEAD,
    PARTITION,
    OVER,
    REFERENCES,
    PRIMARY,
    FOREIGN,
    LATERAL,
    ONLY,
    DEFAULT,
    NULL,
    TRUE,
    FALSE,
    LIKE,
    ILIKE,
    ASC,
    DESC,
    UNIQUE,
    CHECK,
    CONSTRAINT,
    INDEX,
    GRANT,
    REVOKE,
    TRUNCATE,
    DECLARE,
    EXEC,
    EXECUTE,
    RETURN,
    PRINT,
    ANY,
    SOME,
    COLUMN,
    TRIGGER,
    PROCEDURE,
    FUNCTION,
    MATERIALIZED,
    EXPLAIN,
    CALL,
    COLLATE,
    NULLS,
    TOP,
    ADD,
    CASCADE,
    TEMPORARY,
    RETURNS,
    COMMIT,
    ROLLBACK,
    FILTER,
    ROWS,
    RANGE,
    UNBOUNDED,
    PRECEDING,
    FOLLOWING,
    CURRENT,
    ROW,
    EACH,
    TRY,
    CATCH,
    TRANSACTION,
    TIME,
    ZONE,
    WITHOUT,
    OUTPUT,
);

const GLUED: u16 = 1; // no blank between the token before and this one
const OWN_LINE: u16 = 1 << 1; // first token of its line
const MULTILINE: u16 = 1 << 2; // a block comment with a line break in it
const UNARY: u16 = 1 << 3; // a sign: `-1`
const NOSPACE: u16 = 1 << 4; // `(` of a call: `count(`
const CASEABLE: u16 = 1 << 5; // a keyword whose case may change
const SPACE: u16 = 1 << 6; // on one line, a blank stands before it
const UNCLOSED: u16 = 1 << 7; // an opener without its closer
const TAIL: u16 = 1 << 8; // belongs to the opener or closer before it: `BEGIN TRY`, `END IF`
const BREAK: u16 = 1 << 9; // a line break before it means something: `'a'⏎'b'`

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Grp {
    No,
    Paren,
    Case,
    /// `BEGIN … END` with statements in it.
    Block,
    /// MySQL: `IF … END IF`, `WHILE … END WHILE`, `LOOP`, `REPEAT`.
    Ctl,
}

#[derive(Debug, Clone, Copy)]
struct Tok {
    start: u32,
    end: u32,
    kind: Kind,
    kw: Kw,
    flags: u16,
    grp: Grp,
}

impl Tok {
    fn comment(&self) -> bool {
        matches!(self.kind, Kind::LineComment | Kind::BlockComment)
    }
    fn has(&self, flag: u16) -> bool {
        self.flags & flag != 0
    }
}

fn is_ws(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

fn word_start(c: u8, dialect: Dialect) -> bool {
    c.is_ascii_alphabetic()
        || c == b'_'
        || c >= 0x80
        || (c == b'@' && matches!(dialect, Dialect::Mysql | Dialect::Sqlserver))
        || (c == b'#' && dialect == Dialect::Sqlserver)
        || (c == b'$' && !matches!(dialect, Dialect::Postgres | Dialect::Duckdb))
}

fn word_char(c: u8, dialect: Dialect) -> bool {
    c.is_ascii_alphanumeric()
        || c == b'_'
        || c == b'$'
        || c >= 0x80
        || (c == b'@' && matches!(dialect, Dialect::Mysql | Dialect::Sqlserver))
        || (c == b'#' && dialect == Dialect::Sqlserver)
}

/// The end of a quoted text that starts at `from` (a doubled quote is the quote itself); `None`: never closed.
fn quoted_end(b: &[u8], from: usize, quote: u8, escapes: bool) -> Option<usize> {
    let mut i = from + 1;
    while i < b.len() {
        let c = b[i];
        if escapes && c == b'\\' {
            i += 2;
        } else if c == quote {
            if b.get(i + 1) == Some(&quote) {
                i += 2;
            } else {
                return Some(i + 1);
            }
        } else {
            i += 1;
        }
    }
    None
}

fn line_end(b: &[u8], from: usize) -> usize {
    let mut i = from;
    while i < b.len() && b[i] != b'\n' {
        i += 1;
    }
    if i > from && b[i - 1] == b'\r' {
        i -= 1;
    }
    i
}

fn starts_ci(b: &[u8], at: usize, word: &[u8]) -> bool {
    b.len() >= at + word.len() && b[at..at + word.len()].eq_ignore_ascii_case(word)
}

const OPS3: [&[u8]; 6] = [b"<=>", b"->>", b"#>>", b"!~*", b"<->", b"<#>"];
const OPS2: [&[u8]; 29] = [
    b"<=", b">=", b"<>", b"!=", b"==", b"||", b":=", b"->", b"#>", b"@>", b"<@", b"~*", b"!~",
    b"<<", b">>", b"&&", b"+=", b"-=", b"*=", b"/=", b"|=", b"^=", b"&=", b"@@", b"?|", b"?&",
    b"=>", b"!<", b"!>",
];

fn lex(src: &str, dialect: Dialect, stop: &dyn Fn() -> bool) -> Result<Vec<Tok>, FormatError> {
    let b = src.as_bytes();
    let n = b.len();
    let mut toks: Vec<Tok> = Vec::with_capacity(n / 6 + 8);
    let mut delimiter: Vec<u8> = b";".to_vec();
    let mut i = 0;
    // nothing but blanks since the last line break (or the start)
    let mut line_start = true;
    loop {
        let ws = i;
        while i < n && is_ws(b[i]) {
            if b[i] == b'\n' {
                line_start = true;
            }
            i += 1;
        }
        if i >= n {
            break;
        }
        if toks.len() & 0xffff == 0xffff && stop() {
            return Err(FormatError::Cancelled);
        }
        let start = i;
        let c = b[i];
        let next = b.get(i + 1).copied().unwrap_or(0);
        let mut flags = 0u16;
        if i == ws && !toks.is_empty() {
            flags |= GLUED;
        }
        if line_start {
            flags |= OWN_LINE;
        }
        // DuckDB shares dollar quotes, nested comments and E'…' with PostgreSQL
        let pg = matches!(dialect, Dialect::Postgres | Dialect::Duckdb);
        let mysql = dialect == Dialect::Mysql;
        let kind;
        if line_start
            && mysql
            && starts_ci(b, i, b"DELIMITER")
            && matches!(b.get(i + 9), Some(b' ' | b'\t'))
        {
            let mut end = line_end(b, i);
            while end > i && is_ws(b[end - 1]) {
                end -= 1;
            }
            let mut d = i + 9;
            while d < end && is_ws(b[d]) {
                d += 1;
            }
            let mut e = d;
            while e < end && !is_ws(b[e]) {
                e += 1;
            }
            if e > d {
                delimiter = b[d..e].to_vec();
            }
            kind = Kind::RawLine;
            i = end;
        } else if line_start && dialect == Dialect::Sqlserver && go_line(b, i).is_some() {
            kind = Kind::RawLine;
            i = go_line(b, i).unwrap_or(i + 2);
        } else if delimiter != b";" && b[i..].starts_with(&delimiter) {
            kind = Kind::Term;
            i += delimiter.len();
        } else if (c == b'-' && next == b'-') || (c == b'#' && mysql) {
            kind = Kind::LineComment;
            i = line_end(b, i);
        } else if c == b'/' && next == b'*' {
            let nests = pg || dialect == Dialect::Sqlserver;
            let mut depth = 1;
            let mut j = i + 2;
            while j < n && depth > 0 {
                if b[j] == b'*' && b.get(j + 1) == Some(&b'/') {
                    depth -= 1;
                    j += 2;
                } else if nests && b[j] == b'/' && b.get(j + 1) == Some(&b'*') {
                    depth += 1;
                    j += 2;
                } else {
                    j += 1;
                }
            }
            if depth > 0 {
                return Err(FormatError::Incomplete);
            }
            if b[i..j].contains(&b'\n') {
                flags |= MULTILINE;
            }
            kind = Kind::BlockComment;
            i = j;
        } else if c == b'\'' {
            // PostgreSQL: only E'…' knows backslashes; MySQL: every string does
            let e_string = pg
                && flags & GLUED != 0
                && toks.last().is_some_and(|t| {
                    t.kind == Kind::Word
                        && t.end - t.start == 1
                        && (b[t.start as usize] | 0x20) == b'e'
                });
            i = quoted_end(b, i, b'\'', mysql || e_string).ok_or(FormatError::Incomplete)?;
            kind = Kind::Str;
        } else if c == b'"' {
            i = quoted_end(b, i, b'"', mysql).ok_or(FormatError::Incomplete)?;
            kind = if mysql { Kind::Str } else { Kind::Quoted };
        } else if c == b'`' && matches!(dialect, Dialect::Mysql | Dialect::Sqlite) {
            i = quoted_end(b, i, b'`', false).ok_or(FormatError::Incomplete)?;
            kind = Kind::Quoted;
        } else if c == b'[' && matches!(dialect, Dialect::Sqlserver | Dialect::Sqlite) {
            i = quoted_end(b, i, b']', false).ok_or(FormatError::Incomplete)?;
            kind = Kind::Quoted;
        } else if pg
            && (c | 0x20) == b'u'
            && next == b'&'
            && matches!(b.get(i + 2), Some(b'\'' | b'"'))
        {
            // U&'…' and U&"…" are one token
            let quote = b[i + 2];
            i = quoted_end(b, i + 2, quote, false).ok_or(FormatError::Incomplete)?;
            kind = if quote == b'\'' {
                Kind::Str
            } else {
                Kind::Quoted
            };
        } else if c == b'$' && pg {
            let mut j = i + 1;
            if j < n && b[j].is_ascii_digit() {
                while j < n && b[j].is_ascii_digit() {
                    j += 1;
                }
                kind = Kind::Word;
                i = j;
            } else {
                while j < n && (b[j].is_ascii_alphanumeric() || b[j] == b'_' || b[j] >= 0x80) {
                    j += 1;
                }
                if j < n && b[j] == b'$' {
                    let tag = &b[i..=j];
                    let close = find(b, j + 1, tag).ok_or(FormatError::Incomplete)?;
                    kind = Kind::Str;
                    i = close + tag.len();
                } else {
                    kind = Kind::Other;
                    i += 1;
                }
            }
        } else if c.is_ascii_digit() {
            let mut j = i;
            // only digits and dots so far: an `e` may start an exponent with a sign
            let mut plain = true;
            while j < n {
                let d = b[j];
                if d.is_ascii_digit() || d == b'.' {
                    j += 1;
                } else if plain
                    && (d | 0x20) == b'e'
                    && matches!(b.get(j + 1), Some(b'+' | b'-'))
                    && b.get(j + 2).is_some_and(u8::is_ascii_digit)
                {
                    plain = false;
                    j += 2;
                } else if d.is_ascii_alphanumeric() || d == b'_' {
                    if (d | 0x20) != b'e' {
                        plain = false;
                    }
                    j += 1;
                } else {
                    break;
                }
            }
            kind = Kind::Num;
            i = j;
        } else if word_start(c, dialect) {
            let mut j = i + 1;
            while j < n && word_char(b[j], dialect) {
                j += 1;
            }
            kind = Kind::Word;
            i = j;
        } else if c == b'(' {
            kind = Kind::Open;
            i += 1;
        } else if c == b')' {
            kind = Kind::Close;
            i += 1;
        } else if c == b',' {
            kind = Kind::Comma;
            i += 1;
        } else if c == b';' {
            kind = Kind::Term;
            i += 1;
        } else if c == b'.' {
            kind = Kind::Dot;
            i += 1;
        } else if c == b':' && next == b':' {
            kind = Kind::Cast;
            i += 2;
        } else if let Some(op) = OPS3.iter().find(|op| b[i..].starts_with(op)) {
            kind = Kind::Op;
            i += op.len();
        } else if let Some(op) = OPS2.iter().find(|op| b[i..].starts_with(op)) {
            kind = Kind::Op;
            i += op.len();
        } else if b"+-*/=<>!~^&|".contains(&c) {
            kind = Kind::Op;
            i += 1;
        } else {
            kind = Kind::Other;
            i += 1;
        }
        let kw = if kind == Kind::Word {
            keyword(&b[start..i])
        } else {
            Kw::No
        };
        toks.push(Tok {
            start: start as u32,
            end: i as u32,
            kind,
            kw,
            flags,
            grp: Grp::No,
        });
        line_start = false;
    }
    Ok(toks)
}

fn find(b: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    b[from.min(b.len())..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// `GO` alone on its line (with a count, before a comment): where it ends.
fn go_line(b: &[u8], i: usize) -> Option<usize> {
    if !starts_ci(b, i, b"GO") {
        return None;
    }
    let mut j = i + 2;
    let mut end = j;
    let blanks = |j: &mut usize| {
        while *j < b.len() && matches!(b[*j], b' ' | b'\t') {
            *j += 1;
        }
    };
    blanks(&mut j);
    if j > i + 2 {
        let digits = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > digits {
            end = j;
        }
        blanks(&mut j);
    }
    let rest = &b[j..];
    let ends =
        rest.is_empty() || rest[0] == b'\n' || rest.starts_with(b"\r\n") || rest.starts_with(b"--");
    ends.then_some(end)
}

fn keyword(word: &[u8]) -> Kw {
    if word.len() > 16 || !word.is_ascii() {
        return Kw::No;
    }
    let mut buf = [0u8; 16];
    buf[..word.len()].copy_from_slice(word);
    buf.make_ascii_uppercase();
    std::str::from_utf8(&buf[..word.len()]).map_or(Kw::No, kw_of)
}

fn char_len(s: &str) -> usize {
    if s.is_ascii() {
        s.len()
    } else {
        s.chars().count()
    }
}

// ---------------------------------------------------------------------------------------------------------
// What the tokens mean to the layout
// ---------------------------------------------------------------------------------------------------------

struct Doc<'a> {
    src: &'a str,
    dialect: Dialect,
    toks: Vec<Tok>,
    /// Of an opener: its closer – or, unclosed, where its content ends.
    close: Vec<u32>,
    /// Width of the tokens before index `i`, written on one line.
    w: Vec<u32>,
    /// How many tokens before index `i` cannot stand on one line with what follows.
    nf: Vec<u32>,
}

impl<'a> Doc<'a> {
    fn text(&self, i: usize) -> &'a str {
        let t = &self.toks[i];
        &self.src[t.start as usize..t.end as usize]
    }

    fn is(&self, i: usize, word: &str) -> bool {
        self.toks[i].kind == Kind::Word && self.text(i).eq_ignore_ascii_case(word)
    }

    /// The first token from `i` that is no comment, at most `end`.
    fn sig(&self, mut i: usize, end: usize) -> usize {
        while i < end && self.toks[i].comment() {
            i += 1;
        }
        i.min(end)
    }

    fn prev_sig(&self, i: usize) -> Option<usize> {
        (0..i).rev().find(|&j| !self.toks[j].comment())
    }

    fn kw(&self, i: usize, end: usize) -> Kw {
        if i < end { self.toks[i].kw } else { Kw::No }
    }

    /// Behind the whole group an opener starts (with its closer and `END IF`'s `IF`).
    fn group_end(&self, opener: usize) -> usize {
        let close = self.close[opener] as usize;
        if self.toks[opener].has(UNCLOSED) {
            return close;
        }
        let n = self.toks.len();
        let next = self.sig(close + 1, n);
        if next < n && self.toks[next].has(TAIL) {
            next + 1
        } else {
            close + 1
        }
    }

    /// Behind the token or the group at `i`.
    fn after(&self, i: usize) -> usize {
        if self.toks[i].grp == Grp::No {
            i + 1
        } else {
            self.group_end(i)
        }
    }

    /// `WITH` that starts common table expressions (not `WITH (NOLOCK)`, `WITH TIME ZONE`).
    fn is_cte(&self, i: usize, end: usize) -> bool {
        let a = self.sig(i + 1, end);
        if a >= end {
            return false;
        }
        if self.toks[a].kw == Kw::RECURSIVE {
            return true;
        }
        if !matches!(self.toks[a].kind, Kind::Word | Kind::Quoted) {
            return false;
        }
        let b = self.sig(a + 1, end);
        b < end && (self.toks[b].kw == Kw::AS || self.toks[b].kind == Kind::Open)
    }

    /// The content of a bracket is a query (or a window): it is laid out by clauses.
    fn query_like(&self, a: usize, end: usize) -> bool {
        match self.toks[a].kw {
            Kw::SELECT | Kw::VALUES | Kw::INSERT | Kw::UPDATE | Kw::DELETE | Kw::MERGE => true,
            Kw::WITH => self.is_cte(a, end),
            Kw::PARTITION | Kw::ORDER => self.kw(self.sig(a + 1, end), end) == Kw::BY,
            _ => false,
        }
    }

    /// Keywords in their place, signs, call brackets, blanks.
    fn annotate(&mut self, oneline: bool) {
        let n = self.toks.len();
        let mut prev: Option<usize> = None;
        for i in 0..n {
            if self.toks[i].comment() {
                if oneline {
                    self.toks[i].flags &= !OWN_LINE;
                }
                continue;
            }
            let next = self.sig(i + 1, n);
            let pk = prev.map_or(Kw::No, |p| self.toks[p].kw);
            // as written: the word behind is not looked at yet
            let nk = self.kw(next, n);
            let pkind = prev.map(|p| self.toks[p].kind);
            let mut t = self.toks[i];
            if t.kind == Kind::Word && t.kw != Kw::No {
                let dotted =
                    pkind == Some(Kind::Dot) || (next < n && self.toks[next].kind == Kind::Dot);
                let opens = next < n && self.toks[next].kind == Kind::Open;
                let keep = !dotted
                    && !(introduces_name(pk) && !hard(t.kw))
                    && match t.kw {
                        Kw::KEY => {
                            matches!(pk, Kw::PRIMARY | Kw::FOREIGN | Kw::UNIQUE | Kw::DUPLICATE)
                        }
                        Kw::MATCHED => matches!(pk, Kw::WHEN | Kw::NOT),
                        Kw::CONFLICT | Kw::DUPLICATE => pk == Kw::ON,
                        Kw::APPLY => matches!(pk, Kw::CROSS | Kw::OUTER),
                        Kw::TOP => matches!(pk, Kw::SELECT | Kw::DISTINCT | Kw::ALL),
                        // left(…), right(…) are functions
                        Kw::LEFT | Kw::RIGHT => !opens,
                        Kw::FILTER => opens,
                        Kw::ROWS | Kw::RANGE => {
                            matches!(nk, Kw::BETWEEN | Kw::UNBOUNDED | Kw::CURRENT)
                                || (next < n && self.toks[next].kind == Kind::Num)
                        }
                        Kw::UNBOUNDED => matches!(nk, Kw::PRECEDING | Kw::FOLLOWING),
                        Kw::CURRENT | Kw::EACH => nk == Kw::ROW,
                        Kw::ROW => matches!(pk, Kw::CURRENT | Kw::EACH),
                        Kw::TRY | Kw::CATCH => matches!(pk, Kw::BEGIN | Kw::END),
                        Kw::TRANSACTION => {
                            matches!(pk, Kw::BEGIN | Kw::COMMIT | Kw::ROLLBACK | Kw::END)
                        }
                        Kw::TIME => matches!(pk, Kw::WITH | Kw::WITHOUT) && nk == Kw::ZONE,
                        Kw::ZONE => pk == Kw::TIME,
                        Kw::WITHOUT => nk == Kw::TIME,
                        Kw::OUTPUT => self.dialect == Dialect::Sqlserver,
                        _ => true,
                    };
                if keep {
                    t.flags |= CASEABLE;
                } else {
                    t.kw = Kw::No;
                }
            }
            if t.kind == Kind::Op && matches!(self.text(i), "-" | "+" | "~") {
                let operand_before = match pkind {
                    None => false,
                    Some(Kind::Op | Kind::Open | Kind::Comma | Kind::Term | Kind::RawLine) => false,
                    Some(Kind::Word) => {
                        pk == Kw::No || matches!(pk, Kw::END | Kw::NULL | Kw::TRUE | Kw::FALSE)
                    }
                    Some(_) => true,
                };
                if !operand_before {
                    t.flags |= UNARY;
                }
            }
            if t.kind == Kind::Open
                && let Some(p) = prev
            {
                let before = self.toks[p];
                let call = match before.kind {
                    // a blank the text has there stays (MySQL tells functions by it); `IF(`,
                    // `INSERT(`, `TRUNCATE(`, `DEFAULT(` written as calls stay calls
                    Kind::Word | Kind::Quoted if before.kw == Kw::No => {
                        t.has(GLUED) && !self.names_object(p)
                    }
                    Kind::Word => {
                        t.has(GLUED)
                            && matches!(before.kw, Kw::IF | Kw::INSERT | Kw::TRUNCATE | Kw::DEFAULT)
                    }
                    Kind::Op => before.has(UNARY),
                    Kind::Dot | Kind::Other | Kind::Cast => t.has(GLUED),
                    _ => false,
                };
                if call {
                    t.flags |= NOSPACE;
                }
            }
            if t.kind == Kind::Str && t.has(OWN_LINE) && pkind == Some(Kind::Str) {
                // 'a'⏎'b' is one string only with the line break
                t.flags |= BREAK;
            }
            self.toks[i] = t;
            if let Some(p) = prev
                && self.space(p, i)
            {
                self.toks[i].flags |= SPACE;
            }
            prev = Some(i);
        }
    }

    /// The name before a `(` is the object of a statement (`INSERT INTO t (a)`), not a function.
    fn names_object(&self, name: usize) -> bool {
        let mut j = name;
        loop {
            let Some(p) = self.prev_sig(j) else {
                return false;
            };
            if self.toks[p].kind == Kind::Dot {
                match self.prev_sig(p) {
                    Some(q) if matches!(self.toks[q].kind, Kind::Word | Kind::Quoted) => j = q,
                    _ => return false,
                }
            } else {
                return matches!(
                    self.toks[p].kw,
                    Kw::INTO | Kw::TABLE | Kw::REFERENCES | Kw::VIEW | Kw::EXISTS
                );
            }
        }
    }

    /// On one line: does a blank stand between `p` and `i`?
    fn space(&self, p: usize, i: usize) -> bool {
        let prev = &self.toks[p];
        let cur = &self.toks[i];
        let glued = cur.has(GLUED);
        match cur.kind {
            Kind::Comma | Kind::Close | Kind::Cast => return false,
            Kind::Term => return self.text(i) != ";",
            Kind::Open => return prev.kind != Kind::Open && !cur.has(NOSPACE),
            Kind::Dot | Kind::Other => return !glued || prev.kind == Kind::Comma,
            _ => {}
        }
        match prev.kind {
            Kind::Open => false,
            Kind::Cast => !matches!(cur.kind, Kind::Word | Kind::Quoted) && !glued,
            Kind::Dot | Kind::Other => !glued,
            Kind::Op if prev.has(UNARY) => false,
            Kind::Op if cur.kind == Kind::Op => {
                // operators written as one stay one (`<<=`, `!!`) – but `=-1` is `= -1`
                let plain = matches!(
                    self.text(p),
                    "=" | "<" | ">" | "<=" | ">=" | "<>" | "!=" | "*" | "/" | "+" | "-"
                );
                !(glued && !(plain && matches!(self.text(i), "-" | "+")))
            }
            // N'…', X'…', _utf8'…', @`name`
            Kind::Word
                if matches!(cur.kind, Kind::Str | Kind::Quoted) && glued && prev.kw == Kw::No =>
            {
                false
            }
            // 'user'@'host'
            Kind::Word | Kind::Str | Kind::Quoted
                if cur.kind == Kind::Word && glued && self.text(i).starts_with('@') =>
            {
                false
            }
            _ => true,
        }
    }

    /// Finds the groups: brackets, `CASE … END`, `BEGIN … END`, MySQL's `IF … END IF`.
    fn pair(&mut self) -> Result<(), FormatError> {
        let n = self.toks.len();
        self.close = vec![u32::MAX; n];
        let mysql = self.dialect == Dialect::Mysql;
        let mut stack: Vec<(usize, Grp)> = Vec::new();
        // the next word starts a statement
        let mut stmt_start = true;
        for i in 0..n {
            let t = self.toks[i];
            if t.comment() || t.has(TAIL) {
                continue;
            }
            let top = stack.last().map(|s| s.1);
            let mut starts = false;
            match t.kind {
                Kind::RawLine => {
                    for (o, _) in stack.drain(..) {
                        self.toks[o].flags |= UNCLOSED;
                        self.close[o] = i as u32;
                    }
                    starts = true;
                }
                Kind::Term => {
                    while let Some(&(o, g)) = stack.last() {
                        if !matches!(g, Grp::Paren | Grp::Case) {
                            break;
                        }
                        self.give_up(o, i);
                        stack.pop();
                    }
                    starts = true;
                }
                Kind::Open => {
                    self.open(&mut stack, i, Grp::Paren)?;
                }
                Kind::Close => {
                    let mut k = stack.len();
                    while k > 0 && stack[k - 1].1 == Grp::Case {
                        k -= 1;
                    }
                    if k > 0 && stack[k - 1].1 == Grp::Paren {
                        while stack.len() > k {
                            let (o, _) = stack.pop().unwrap_or((0, Grp::No));
                            self.give_up(o, i);
                        }
                        if let Some((o, _)) = stack.pop() {
                            self.close[o] = i as u32;
                        }
                    }
                }
                Kind::Word => match t.kw {
                    Kw::CASE => self.open(&mut stack, i, Grp::Case)?,
                    Kw::BEGIN if self.begins_block(i) => {
                        self.open(&mut stack, i, Grp::Block)?;
                        let next = self.sig(i + 1, n);
                        if next < n
                            && (self.is(next, "TRY")
                                || self.is(next, "CATCH")
                                || self.is(next, "ATOMIC"))
                        {
                            self.toks[next].flags |= TAIL;
                        }
                        starts = true;
                    }
                    Kw::END => {
                        let next = self.sig(i + 1, n);
                        let nk = self.kw(next, n);
                        let ends_ctl = matches!(nk, Kw::IF | Kw::WHILE | Kw::LOOP | Kw::REPEAT);
                        loop {
                            match stack.last().copied() {
                                Some((o, Grp::Case)) => {
                                    self.close[o] = i as u32;
                                    stack.pop();
                                    if mysql && nk == Kw::CASE {
                                        self.toks[next].flags |= TAIL;
                                    }
                                }
                                Some((o, Grp::Block)) if !ends_ctl => {
                                    self.close[o] = i as u32;
                                    stack.pop();
                                    if next < n && (self.is(next, "TRY") || self.is(next, "CATCH"))
                                    {
                                        self.toks[next].flags |= TAIL;
                                    }
                                }
                                Some((o, Grp::Ctl)) if ends_ctl => {
                                    self.close[o] = i as u32;
                                    stack.pop();
                                    self.toks[next].flags |= TAIL;
                                }
                                Some((o, Grp::Ctl)) => {
                                    // not its end: it was none
                                    self.give_up(o, i);
                                    stack.pop();
                                    continue;
                                }
                                _ => {}
                            }
                            break;
                        }
                    }
                    Kw::IF | Kw::WHILE | Kw::LOOP | Kw::REPEAT
                        if mysql && stmt_start && matches!(top, Some(Grp::Block | Grp::Ctl)) =>
                    {
                        self.open(&mut stack, i, Grp::Ctl)?;
                        starts = matches!(t.kw, Kw::LOOP | Kw::REPEAT);
                    }
                    Kw::THEN | Kw::ELSE | Kw::DO if top == Some(Grp::Ctl) => starts = true,
                    _ => {}
                },
                _ => {}
            }
            stmt_start = starts;
        }
        for (o, _) in stack {
            self.give_up(o, n);
        }
        Ok(())
    }

    fn open(
        &mut self,
        stack: &mut Vec<(usize, Grp)>,
        i: usize,
        grp: Grp,
    ) -> Result<(), FormatError> {
        if stack.len() >= MAX_DEPTH {
            return Err(FormatError::TooDeep);
        }
        self.toks[i].grp = grp;
        stack.push((i, grp));
        Ok(())
    }

    fn give_up(&mut self, opener: usize, at: usize) {
        self.toks[opener].flags |= UNCLOSED;
        self.close[opener] = at as u32;
    }

    /// `BEGIN` of a block of statements – not `BEGIN;`, `BEGIN TRANSACTION`.
    fn begins_block(&self, i: usize) -> bool {
        let n = self.toks.len();
        let next = self.sig(i + 1, n);
        if next >= n || matches!(self.toks[next].kind, Kind::Term | Kind::RawLine) {
            return false;
        }
        ![
            "TRANSACTION",
            "TRAN",
            "WORK",
            "DISTRIBUTED",
            "DEFERRED",
            "IMMEDIATE",
            "EXCLUSIVE",
            "ISOLATION",
            "READ",
        ]
        .iter()
        .any(|w| self.is(next, w))
    }

    fn measure(&mut self) {
        let n = self.toks.len();
        self.w = Vec::with_capacity(n + 1);
        self.nf = Vec::with_capacity(n + 1);
        let (mut w, mut nf) = (0u32, 0u32);
        for i in 0..n {
            self.w.push(w);
            self.nf.push(nf);
            let t = self.toks[i];
            let len = char_len(self.text(i)) as u32;
            if t.comment() {
                w += len + 1;
                if t.kind == Kind::LineComment || t.has(OWN_LINE) || t.has(MULTILINE) {
                    nf += 1;
                }
            } else {
                w += len + u32::from(t.has(SPACE));
                if t.kind == Kind::RawLine || matches!(t.grp, Grp::Block | Grp::Ctl) || t.has(BREAK)
                {
                    nf += 1;
                }
            }
        }
        self.w.push(w);
        self.nf.push(nf);
    }
}

/// After these a word is a name, whatever it looks like (`FROM user`, `AS key`).
fn introduces_name(kw: Kw) -> bool {
    matches!(
        kw,
        Kw::FROM
            | Kw::JOIN
            | Kw::INTO
            | Kw::UPDATE
            | Kw::TABLE
            | Kw::AS
            | Kw::VIEW
            | Kw::INDEX
            | Kw::REFERENCES
            | Kw::PROCEDURE
            | Kw::FUNCTION
            | Kw::TRIGGER
            | Kw::CALL
            | Kw::EXEC
            | Kw::EXECUTE
            | Kw::COLUMN
            | Kw::CONSTRAINT
    )
}

/// … except these, which are never names there (`AS SELECT`, `TABLE IF NOT EXISTS`, `DO UPDATE SET`).
fn hard(kw: Kw) -> bool {
    matches!(
        kw,
        Kw::SELECT
            | Kw::WITH
            | Kw::VALUES
            | Kw::LATERAL
            | Kw::ONLY
            | Kw::SET
            | Kw::IF
            | Kw::NOT
            | Kw::EXISTS
            | Kw::TABLE
            | Kw::ON
            | Kw::BEGIN
            | Kw::INSERT
            | Kw::UPDATE
            | Kw::DELETE
            | Kw::MERGE
            | Kw::DECLARE
            | Kw::RETURN
            | Kw::EXEC
            | Kw::EXECUTE
            | Kw::PRINT
            | Kw::WHILE
            | Kw::CASCADE
            | Kw::OF
            | Kw::MATERIALIZED
            | Kw::PROCEDURE
            | Kw::FUNCTION
            | Kw::INTO
    )
}

// ---------------------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClauseKind {
    Plain,
    Join,
    /// `WHEN … THEN …` of a `MERGE`: what follows belongs to it.
    When,
}

struct Clause {
    start: usize,
    /// Behind its keywords.
    head: usize,
    kind: ClauseKind,
}

struct Printer<'a> {
    d: &'a Doc<'a>,
    style: Style,
    case: KeywordCase,
    eol: &'static str,
    stop: &'a dyn Fn() -> bool,
    buf: String,
    col: usize,
    at_start: bool,
    /// The indentation of the line that starts.
    indent: usize,
    /// A line comment was written: the line must end.
    force: bool,
    /// The indentation of the statement being written: where its `BEGIN` stands.
    base: usize,
}

type Done = Result<(), FormatError>;

impl Printer<'_> {
    fn unit(&self) -> usize {
        usize::from(self.style.indent)
    }

    fn newline(&mut self, indent: usize) {
        if !self.at_start {
            self.buf.push_str(self.eol);
            self.at_start = true;
        }
        self.indent = indent;
        self.force = false;
    }

    fn write(&mut self, text: &str) {
        if self.at_start {
            let blanks = self.indent * self.unit();
            self.buf.extend(std::iter::repeat_n(' ', blanks));
            self.col = blanks;
            self.at_start = false;
        }
        self.buf.push_str(text);
        match text.rfind('\n') {
            Some(p) => self.col = char_len(&text[p + 1..]),
            None => self.col += char_len(text),
        }
    }

    fn column(&self) -> usize {
        if self.at_start {
            self.indent * self.unit()
        } else {
            self.col
        }
    }

    fn width(&self, a: usize, b: usize) -> usize {
        (self.d.w[b] - self.d.w[a]) as usize
    }

    /// The tokens `a..b` can stand on the line that is being written.
    fn fits(&self, a: usize, b: usize) -> bool {
        if b <= a {
            return true;
        }
        let lead = usize::from(self.at_start && self.d.toks[a].has(SPACE));
        self.d.nf[b] == self.d.nf[a]
            && self.column() + self.width(a, b) - lead <= usize::from(self.style.width)
    }

    /// Writes a token with the comments around it. `indent`: of the line, should one have to start.
    fn tok(&mut self, i: usize, indent: usize) {
        let d = self.d;
        let n = d.toks.len();
        let mut first = i;
        while first > 0 && d.toks[first - 1].comment() {
            first -= 1;
        }
        // comments on the line of the token before were written with it
        let mut lead = first;
        if first > 0 {
            while lead < i && !d.toks[lead].has(OWN_LINE) {
                lead += 1;
            }
        }
        let here = if self.at_start { self.indent } else { indent };
        let t = d.toks[i];
        if lead < i {
            for j in lead..i {
                self.newline(here);
                self.write(d.text(j));
            }
            self.newline(here);
        } else if self.force || t.has(BREAK) {
            self.newline(here);
        }
        if !self.at_start && t.has(SPACE) {
            self.buf.push(' ');
            self.col += 1;
        }
        let text = d.text(i);
        match self.case {
            KeywordCase::Upper if t.has(CASEABLE) => self.write(&text.to_ascii_uppercase()),
            KeywordCase::Lower if t.has(CASEABLE) => self.write(&text.to_ascii_lowercase()),
            _ => self.write(text),
        }
        let mut j = i + 1;
        while j < n && d.toks[j].comment() && !d.toks[j].has(OWN_LINE) {
            self.buf.push(' ');
            self.col += 1;
            self.write(d.text(j));
            if d.toks[j].kind == Kind::LineComment || d.toks[j].has(MULTILINE) {
                self.force = true;
            }
            j += 1;
        }
    }

    fn flat(&mut self, a: usize, b: usize, indent: usize) {
        let mut i = self.d.sig(a, b);
        while i < b {
            self.tok(i, indent);
            i = self.d.sig(i + 1, b);
        }
    }

    /// The entries of `a..b` between separators on this level: `(start, index of the separator or b)`.
    fn split(
        &self,
        a: usize,
        b: usize,
        separates: impl Fn(&Tok, &mut bool) -> bool,
    ) -> Vec<(usize, usize)> {
        let d = self.d;
        let mut parts = Vec::new();
        let mut start = d.sig(a, b);
        let mut i = start;
        let mut state = false;
        while i < b {
            let t = &d.toks[i];
            if t.grp == Grp::No && separates(t, &mut state) {
                parts.push((start, i));
                start = d.sig(i + 1, b);
                i = start;
            } else {
                i = d.sig(d.after(i).min(b), b);
            }
        }
        parts.push((start, b));
        parts
    }

    fn commas(&self, a: usize, b: usize) -> Vec<(usize, usize)> {
        self.split(a, b, |t, _| t.kind == Kind::Comma)
    }

    /// The first token of `a..b` on this level that is one of `kws`, else `b`.
    fn find(&self, a: usize, b: usize, kws: &[Kw]) -> usize {
        let d = self.d;
        let mut i = d.sig(a, b);
        while i < b {
            if d.toks[i].grp == Grp::No && kws.contains(&d.toks[i].kw) {
                return i;
            }
            i = d.sig(d.after(i).min(b), b);
        }
        b
    }

    /// Statements one below the other; `top`: with the empty lines between them.
    fn statements(&mut self, a: usize, b: usize, indent: usize, top: bool) -> Done {
        let d = self.d;
        let outer = self.base;
        let mut i = d.sig(a, b);
        while i < b {
            self.base = indent;
            if (self.stop)() {
                return Err(FormatError::Cancelled);
            }
            if d.toks[i].kind == Kind::RawLine {
                self.newline(0);
                self.tok(i, 0);
                i = d.sig(i + 1, b);
                continue;
            }
            let mut j = i;
            while j < b && !matches!(d.toks[j].kind, Kind::Term | Kind::RawLine) {
                j = d.sig(d.after(j).min(b), b);
            }
            let written = !self.buf.is_empty();
            self.newline(indent);
            if top && written {
                for _ in 0..self.style.blank_lines {
                    self.buf.push_str(self.eol);
                }
            }
            if j > i {
                self.level(i, j, indent)?;
            }
            if j < b && d.toks[j].kind == Kind::Term {
                self.tok(j, indent + 1);
                j += 1;
            }
            i = d.sig(j, b);
        }
        self.base = outer;
        Ok(())
    }

    /// A statement or the query in a bracket: its clauses one below the other.
    fn level(&mut self, a: usize, b: usize, indent: usize) -> Done {
        let d = self.d;
        let mut ddl = matches!(
            d.toks[a].kw,
            Kw::CREATE | Kw::ALTER | Kw::DROP | Kw::GRANT | Kw::REVOKE | Kw::TRUNCATE
        ) || d.is(a, "COMMENT");
        let merge = d.toks[a].kw == Kw::MERGE;
        let mut clauses: Vec<Clause> = Vec::new();
        let mut cur = Clause {
            start: a,
            head: a,
            kind: ClauseKind::Plain,
        };
        let (mut pk, mut ppk) = (Kw::No, Kw::No);
        let mut i = a;
        while i < b {
            if d.toks[i].grp != Grp::No {
                i = d.sig(d.after(i).min(b), b);
                (pk, ppk) = (Kw::No, Kw::No);
                continue;
            }
            if let Some((head, kind)) = self.clause_head(i, b, &mut ddl, (cur.kind, merge), pk, ppk)
            {
                if i > cur.start {
                    clauses.push(cur);
                }
                cur = Clause {
                    start: i,
                    head,
                    kind,
                };
                (pk, ppk) = (Kw::No, Kw::No);
                i = d.sig(head, b);
            } else {
                ppk = pk;
                pk = d.toks[i].kw;
                i = d.sig(i + 1, b);
            }
        }
        clauses.push(cur);
        for k in 0..clauses.len() {
            let c = &clauses[k];
            let end = clauses.get(k + 1).map_or(b, |next| next.start);
            let at = indent + usize::from(c.kind == ClauseKind::Join);
            if k > 0 {
                self.newline(at);
            }
            let (start, head) = (c.start, c.head);
            self.clause(start, head, end, at)?;
        }
        Ok(())
    }

    /// Whether the keyword at `i` starts a clause: behind its keywords, and what it is.
    #[allow(clippy::too_many_lines)]
    fn clause_head(
        &self,
        i: usize,
        b: usize,
        ddl: &mut bool,
        (current, merge): (ClauseKind, bool),
        pk: Kw,
        ppk: Kw,
    ) -> Option<(usize, ClauseKind)> {
        let d = self.d;
        let t = d.toks[i];
        if t.kw == Kw::No {
            return None;
        }
        let sqlserver = d.dialect == Dialect::Sqlserver;
        let next = d.sig(i + 1, b);
        let nk = d.kw(next, b);
        let plain = |end: usize| Some((end, ClauseKind::Plain));
        if *ddl {
            // CREATE VIEW v AS SELECT …: from here on it is a query
            let query = matches!(
                nk,
                Kw::SELECT | Kw::INSERT | Kw::UPDATE | Kw::DELETE | Kw::MERGE | Kw::VALUES
            ) || (nk == Kw::WITH && d.is_cte(next, b))
                || (sqlserver
                    && matches!(
                        nk,
                        Kw::SET
                            | Kw::DECLARE
                            | Kw::IF
                            | Kw::EXEC
                            | Kw::EXECUTE
                            | Kw::RETURN
                            | Kw::PRINT
                            | Kw::WHILE
                    ));
            if t.kw == Kw::AS && query {
                *ddl = false;
            }
            return None;
        }
        let when = |i: usize| {
            let then = self.find(i + 1, b, &[Kw::THEN, Kw::WHEN]);
            let head = if then < b && d.toks[then].kw == Kw::THEN {
                then + 1
            } else {
                i + 1
            };
            Some((head, ClauseKind::When))
        };
        if current == ClauseKind::When {
            return match t.kw {
                Kw::WHEN => when(i),
                Kw::OUTPUT => plain(i + 1),
                _ => None,
            };
        }
        // `b = VALUES(b)`, `, values`: a value, not a clause
        let value = d
            .prev_sig(i)
            .is_some_and(|p| matches!(d.toks[p].kind, Kind::Op | Kind::Comma));
        // `FOR UPDATE`, `ON DELETE`, `THEN INSERT`, `AFTER UPDATE OF`: no statement starts there
        let inner = matches!(
            pk,
            Kw::THEN
                | Kw::DO
                | Kw::FOR
                | Kw::ON
                | Kw::AFTER
                | Kw::BEFORE
                | Kw::OF
                | Kw::OR
                | Kw::INSTEAD
                | Kw::KEY
        );
        match t.kw {
            Kw::SELECT => plain(if matches!(nk, Kw::DISTINCT | Kw::ALL) {
                next + 1
            } else {
                i + 1
            }),
            Kw::FROM if pk == Kw::DISTINCT && matches!(ppk, Kw::IS | Kw::NOT) => None,
            Kw::VALUES if pk == Kw::DEFAULT || value => None,
            Kw::FROM
            | Kw::WHERE
            | Kw::HAVING
            | Kw::LIMIT
            | Kw::OFFSET
            | Kw::FETCH
            | Kw::WINDOW
            | Kw::RETURNING
            | Kw::OUTPUT
            | Kw::ROWS
            | Kw::RANGE
            | Kw::VALUES => plain(i + 1),
            Kw::GROUP | Kw::ORDER | Kw::PARTITION if nk == Kw::BY => plain(next + 1),
            Kw::UNION | Kw::EXCEPT | Kw::INTERSECT => {
                plain(if matches!(nk, Kw::ALL | Kw::DISTINCT) {
                    next + 1
                } else {
                    i + 1
                })
            }
            Kw::INSERT | Kw::MERGE if !inner => {
                plain(if nk == Kw::INTO { next + 1 } else { i + 1 })
            }
            Kw::UPDATE if !inner => plain(i + 1),
            Kw::DELETE if !inner => plain(if nk == Kw::FROM { next + 1 } else { i + 1 }),
            Kw::SET => {
                let referential = matches!(pk, Kw::UPDATE | Kw::DELETE) && ppk == Kw::ON;
                let charset = d.prev_sig(i).is_some_and(|p| d.is(p, "CHARACTER"));
                if referential || charset {
                    None
                } else {
                    plain(i + 1)
                }
            }
            Kw::WITH if d.is_cte(i, b) => plain(if nk == Kw::RECURSIVE { next + 1 } else { i + 1 }),
            Kw::USING if merge || !(next < b && d.toks[next].kind == Kind::Open) => plain(i + 1),
            Kw::WHEN => when(i),
            Kw::ON if nk == Kw::CONFLICT => plain(next + 1),
            Kw::ON if nk == Kw::DUPLICATE => {
                let key = d.sig(next + 1, b);
                let update = d.sig(key + 1, b);
                if d.kw(key, b) == Kw::KEY && d.kw(update, b) == Kw::UPDATE {
                    plain(update + 1)
                } else {
                    plain(next + 1)
                }
            }
            Kw::JOIN
            | Kw::INNER
            | Kw::LEFT
            | Kw::RIGHT
            | Kw::FULL
            | Kw::CROSS
            | Kw::NATURAL
            | Kw::OUTER
            | Kw::STRAIGHT_JOIN => {
                let mut j = i;
                for _ in 0..4 {
                    match d.kw(j, b) {
                        Kw::JOIN | Kw::APPLY | Kw::STRAIGHT_JOIN => {
                            return Some((j + 1, ClauseKind::Join));
                        }
                        Kw::INNER
                        | Kw::LEFT
                        | Kw::RIGHT
                        | Kw::FULL
                        | Kw::CROSS
                        | Kw::NATURAL
                        | Kw::OUTER => {
                            j = d.sig(j + 1, b);
                        }
                        _ => break,
                    }
                }
                None
            }
            // T-SQL: statements follow each other without `;`
            Kw::ELSE
            | Kw::IF
            | Kw::DECLARE
            | Kw::EXEC
            | Kw::EXECUTE
            | Kw::PRINT
            | Kw::RETURN
            | Kw::WHILE
                if sqlserver =>
            {
                plain(i + 1)
            }
            _ => None,
        }
    }

    fn clause(&mut self, a: usize, head: usize, b: usize, indent: usize) -> Done {
        if self.fits(a, b) {
            self.flat(a, b, indent + 1);
            return Ok(());
        }
        self.flat(a, head, indent + 1);
        let body = self.d.sig(head, b);
        if body >= b {
            return Ok(());
        }
        let items = self.commas(body, b);
        if items.len() > 1 {
            self.list(&items, indent, head > a)
        } else {
            self.item(body, b, indent)
        }
    }

    /// Entries one per line, a level deeper. `own_lines`: the first one too (else it goes on with the line).
    fn list(&mut self, items: &[(usize, usize)], indent: usize, own_lines: bool) -> Done {
        let leading = self.style.comma == Place::Leading;
        // the comma could not follow its entry (a line comment ended the line): it leads the next one
        let mut carried = false;
        for (k, &(start, end)) in items.iter().enumerate() {
            let on_line = k == 0 && !own_lines;
            let at = if on_line { indent } else { indent + 1 };
            if !on_line {
                self.newline(at);
            }
            if k > 0 && (leading || carried) {
                self.tok(items[k - 1].1, at);
            }
            self.item(start, end, at)?;
            carried = self.force;
            if k + 1 < items.len() && !leading && !carried {
                self.tok(end, at + 1);
            }
        }
        Ok(())
    }

    /// An entry of a list or a condition: broken at `AND`/`OR` when it does not fit.
    fn item(&mut self, a: usize, b: usize, indent: usize) -> Done {
        let a = self.d.sig(a, b);
        if a >= b {
            return Ok(());
        }
        if self.fits(a, b) {
            self.flat(a, b, indent + 1);
            return Ok(());
        }
        // the AND of BETWEEN … AND … joins nothing
        let parts = self.split(a, b, |t, between| match t.kw {
            Kw::BETWEEN => {
                *between = true;
                false
            }
            Kw::AND if *between => {
                *between = false;
                false
            }
            Kw::AND | Kw::OR => true,
            _ => false,
        });
        if parts.len() == 1 {
            return self.flow(a, b, indent);
        }
        let leading = self.style.and_or == Place::Leading;
        for (k, &(start, end)) in parts.iter().enumerate() {
            let at = if k == 0 { indent } else { indent + 1 };
            if k > 0 {
                self.newline(at);
                if leading {
                    self.tok(parts[k - 1].1, at);
                }
            }
            if self.fits(start, end) {
                self.flat(start, end, at + 1);
            } else {
                self.flow(start, end, at)?;
            }
            if k + 1 < parts.len() && !leading {
                self.tok(end, at + 1);
            }
        }
        Ok(())
    }

    /// Token after token on the line; groups decide for themselves.
    fn flow(&mut self, a: usize, b: usize, indent: usize) -> Done {
        let d = self.d;
        let mut i = d.sig(a, b);
        while i < b {
            if d.toks[i].grp == Grp::No {
                self.tok(i, indent + 1);
                i += 1;
            } else {
                i = self.group(i, b, indent)?.min(b);
            }
            i = d.sig(i, b);
        }
        Ok(())
    }

    /// Writes the group an opener starts; answers with the index behind it.
    fn group(&mut self, o: usize, limit: usize, indent: usize) -> Result<usize, FormatError> {
        let d = self.d;
        let close = d.close[o] as usize;
        let closed = !d.toks[o].has(UNCLOSED);
        let end = d.group_end(o);
        let grp = d.toks[o].grp;
        // a short rest of the line (`AS total,`) must fit behind it too
        let mut with_rest = end;
        for _ in 0..4 {
            with_rest = d.sig(with_rest, limit);
            if with_rest >= limit {
                break;
            }
            with_rest += 1;
        }
        let measured = if d.sig(with_rest, limit) >= limit {
            limit.max(end)
        } else {
            end
        };
        if matches!(grp, Grp::Paren | Grp::Case) && self.fits(o, measured) {
            self.flat(o, end, indent + 1);
            return Ok(end);
        }
        match grp {
            Grp::Paren => {
                self.tok(o, indent + 1);
                let first = d.sig(o + 1, close);
                if first < close {
                    if d.query_like(first, close) {
                        self.newline(indent + 1);
                        self.level(first, close, indent + 1)?;
                    } else {
                        let items = self.commas(first, close);
                        let atoms = items.iter().all(|&(s, e)| self.atom(s, e));
                        if items.len() > 1 && atoms {
                            self.fill(&items, indent + 1);
                        } else {
                            self.list(&items, indent, true)?;
                        }
                    }
                }
                if closed {
                    self.newline(indent);
                    self.tok(close, indent);
                }
            }
            Grp::Case => {
                self.tok(o, indent + 1);
                let mut start = d.sig(o + 1, close);
                let mut operand = true;
                while start < close {
                    let next = self.find(d.after(start).min(close), close, &[Kw::WHEN, Kw::ELSE]);
                    let branch = matches!(d.toks[start].kw, Kw::WHEN | Kw::ELSE)
                        && d.toks[start].grp == Grp::No;
                    if operand && !branch {
                        self.flow(start, next, indent)?;
                    } else {
                        self.newline(indent + 1);
                        self.flow(start, next, indent + 1)?;
                    }
                    operand = false;
                    start = next;
                }
                if closed {
                    self.newline(indent);
                    self.tok(close, indent);
                }
            }
            Grp::Block => {
                let indent = self.base;
                if !self.at_start {
                    self.newline(indent);
                }
                self.tok(o, indent);
                let mut first = d.sig(o + 1, close);
                if first < close && d.toks[first].has(TAIL) {
                    self.tok(first, indent);
                    first = d.sig(first + 1, close);
                }
                self.statements(first, close, indent + 1, false)?;
                if closed {
                    self.newline(indent);
                    self.tok(close, indent);
                    if end > close + 1 {
                        self.tok(end - 1, indent);
                    }
                }
                return Ok(end);
            }
            Grp::Ctl => {
                self.tok(o, indent + 1);
                let mut i = d.sig(o + 1, close);
                let mut condition = matches!(d.toks[o].kw, Kw::IF | Kw::WHILE);
                loop {
                    if condition {
                        let then = self.find(i, close, &[Kw::THEN, Kw::DO]);
                        self.flow(i, then, indent)?;
                        if then < close {
                            self.tok(then, indent + 1);
                        }
                        i = d.sig(then + 1, close);
                    }
                    let branch = self.find(i, close, &[Kw::ELSEIF, Kw::ELSE, Kw::UNTIL]);
                    self.statements(i, branch, indent + 1, false)?;
                    if branch >= close {
                        break;
                    }
                    self.newline(indent);
                    self.tok(branch, indent);
                    i = d.sig(branch + 1, close);
                    match d.toks[branch].kw {
                        Kw::UNTIL => {
                            self.flow(i, close, indent)?;
                            break;
                        }
                        kw => condition = kw == Kw::ELSEIF,
                    }
                }
                if closed {
                    self.newline(indent);
                    self.tok(close, indent);
                }
            }
            Grp::No => {}
        }
        // `END IF`, `END TRY`
        if closed && end > close + 1 {
            self.tok(end - 1, indent);
        }
        Ok(end)
    }

    /// One or two plain tokens (`1`, `-1`, `'a'`): such lists are filled, not stacked.
    fn atom(&self, a: usize, b: usize) -> bool {
        let d = self.d;
        b - a <= 2
            && d.nf[b] == d.nf[a]
            && (a..b).all(|i| d.toks[i].grp == Grp::No && !d.toks[i].comment())
    }

    fn fill(&mut self, items: &[(usize, usize)], indent: usize) {
        self.newline(indent);
        for (k, &(start, end)) in items.iter().enumerate() {
            if k > 0 {
                self.tok(items[k - 1].1, indent);
                if self.col + 1 + self.width(start, end) > usize::from(self.style.width) {
                    self.newline(indent);
                }
            }
            self.flat(start, end, indent);
        }
    }

    /// Comments behind the last token.
    fn rest(&mut self) {
        let d = self.d;
        let n = d.toks.len();
        let mut i = n;
        while i > 0 && d.toks[i - 1].comment() {
            i -= 1;
        }
        if i > 0 {
            while i < n && !d.toks[i].has(OWN_LINE) {
                i += 1;
            }
        }
        for j in i..n {
            self.newline(0);
            self.write(d.text(j));
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// The one function
// ---------------------------------------------------------------------------------------------------------

/// The text of `sql`, laid out by `mode` and `style`. `crlf`: the lines of the document end in `\r\n`.
/// `stop` is asked now and then; `true` ends the work with [`FormatError::Cancelled`].
pub fn format(
    sql: &str,
    dialect: Dialect,
    style: &Style,
    mode: Mode,
    crlf: bool,
    stop: &dyn Fn() -> bool,
) -> Result<String, FormatError> {
    if sql.len() > MAX_BYTES {
        return Err(FormatError::TooLarge);
    }
    let style = style.clamped();
    let toks = lex(sql, dialect, stop)?;
    if toks.is_empty() {
        return Ok(sql.to_owned());
    }
    let mut doc = Doc {
        src: sql,
        dialect,
        toks,
        close: Vec::new(),
        w: Vec::new(),
        nf: Vec::new(),
    };
    doc.annotate(mode == Mode::Oneline);
    let out = match mode {
        Mode::Upper | Mode::Lower => recase(&doc, mode == Mode::Upper),
        Mode::Format | Mode::Oneline => {
            doc.pair()?;
            doc.measure();
            let n = doc.toks.len();
            let mut p = Printer {
                d: &doc,
                style,
                case: if mode == Mode::Format {
                    style.keyword_case
                } else {
                    KeywordCase::Preserve
                },
                eol: if crlf || sql.contains("\r\n") {
                    "\r\n"
                } else {
                    "\n"
                },
                stop,
                buf: String::with_capacity(sql.len() + sql.len() / 4),
                col: 0,
                at_start: true,
                indent: 0,
                force: false,
                base: 0,
            };
            if mode == Mode::Format {
                p.statements(0, n, 0, true)?;
            } else {
                let mut i = doc.sig(0, n);
                while i < n {
                    if doc.toks[i].kind == Kind::RawLine {
                        p.newline(0);
                        p.tok(i, 0);
                        p.force = true;
                    } else {
                        p.tok(i, 0);
                    }
                    i = doc.sig(i + 1, n);
                }
            }
            p.rest();
            let mut out = p.buf;
            if sql.ends_with('\n') {
                out.push_str(p.eol);
            }
            out
        }
    };
    if stop() {
        return Err(FormatError::Cancelled);
    }
    if !same_tokens(&doc, &out, stop)? {
        return Err(FormatError::Unsafe);
    }
    Ok(out)
}

fn recase(doc: &Doc<'_>, upper: bool) -> String {
    let mut out = String::with_capacity(doc.src.len());
    let mut at = 0;
    for (i, t) in doc.toks.iter().enumerate() {
        if t.has(CASEABLE) {
            out.push_str(&doc.src[at..t.start as usize]);
            let text = doc.text(i);
            out.push_str(&if upper {
                text.to_ascii_uppercase()
            } else {
                text.to_ascii_lowercase()
            });
            at = t.end as usize;
        }
    }
    out.push_str(&doc.src[at..]);
    out
}

/// The promise: `out` has the tokens of the text, one for one – only keywords may differ in case.
fn same_tokens(doc: &Doc<'_>, out: &str, stop: &dyn Fn() -> bool) -> Result<bool, FormatError> {
    let after = match lex(out, doc.dialect, stop) {
        Ok(toks) => toks,
        Err(FormatError::Cancelled) => return Err(FormatError::Cancelled),
        Err(_) => return Ok(false),
    };
    if after.len() != doc.toks.len() {
        return Ok(false);
    }
    Ok(doc.toks.iter().zip(&after).enumerate().all(|(i, (a, b))| {
        let (x, y) = (doc.text(i), &out[b.start as usize..b.end as usize]);
        a.kind == b.kind && (x == y || (a.has(CASEABLE) && x.eq_ignore_ascii_case(y)))
    }))
}

#[cfg(test)]
#[path = "format_tests.rs"]
mod tests;
