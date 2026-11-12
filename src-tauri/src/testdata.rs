//! Test data (prompt 049): rows that look plausible and are the same again for the same seed.
//!
//! Pure: no database, no Tauri. A [`Spec`] names a generator per column; a [`Generator`] hands out the rows
//! one after the other – every cell from a random stream of its own, seeded by (seed, column, row), so a
//! row is what it is whatever came before it and the memory does not grow with the rows. Unique columns
//! never draw at random: they walk a permutation of their range, or carry the number of their row.
//! The rows go to the loader of the import ([`crate::db::load`]) as [`Records`], bound like any value.

use std::collections::HashMap;

use chrono::{Duration, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};

use crate::data_import::{NextRecord, Record};
use crate::db::filter::ValueKind;
use crate::db::load::Records;
use crate::db::meta::TableInfo;
use crate::db::relations::ForeignKey;
use crate::error::{AppError, AppResult, ErrorCode};

/// Rows of one run at most.
pub const MAX_ROWS: u64 = 50_000_000;
/// Keys of a referenced table kept in memory at most: a bound, however large that table is.
pub const MAX_KEYS: usize = 200_000;
/// Rows of a preview at most.
pub const MAX_PREVIEW: u64 = 200;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidQuery, message)
}

// ── random numbers ──────────────────────────────────────────────────────────────────────────

/// SplitMix64: small, fast, and the same on every machine.
#[derive(Debug, Clone)]
pub struct Rng(u64);

fn scramble(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Rng {
    /// The stream of one cell: seed, column and row decide it, nothing else.
    pub fn cell(seed: u64, column: u64, row: u64) -> Self {
        let a = scramble(seed.wrapping_add(0x9E37_79B9_7F4A_7C15));
        let b = scramble(a ^ column.wrapping_mul(0xD6E8_FEB8_6659_FD93));
        Rng(scramble(b ^ row.wrapping_mul(0xA076_1D64_78BD_642F)))
    }

    pub fn draw(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        scramble(self.0)
    }

    /// A number below `n` (0 for `n` = 0).
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            return 0;
        }
        ((self.draw() as u128 * n as u128) >> 64) as u64
    }

    /// A number in `[0, 1)`.
    pub fn unit(&mut self) -> f64 {
        (self.draw() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// A number from `min` to `max`, both included.
    pub fn between(&mut self, min: i64, max: i64) -> i64 {
        if max <= min {
            return min;
        }
        let span = max as i128 - min as i128 + 1;
        // every whole number there is: any draw will do
        if span > u64::MAX as i128 {
            return self.draw() as i64;
        }
        (min as i128 + self.below(span as u64) as i128) as i64
    }

    fn pick<'a>(&mut self, list: &[&'a str]) -> &'a str {
        if list.is_empty() {
            ""
        } else {
            list[self.below(list.len() as u64) as usize]
        }
    }
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// A walk through `0..size` that meets every number once: `row ↦ (a·row + b) mod size` with `a` coprime
/// to `size`. Unique without remembering a single value.
#[derive(Debug, Clone, Copy)]
struct Permutation {
    size: u64,
    a: u64,
    b: u64,
}

impl Permutation {
    fn new(size: u64, seed: u64, column: u64) -> Self {
        let mut rng = Rng::cell(seed, column, u64::MAX);
        let size = size.max(1);
        let mut a = (rng.draw() % size) | 1;
        while gcd(a, size) != 1 {
            a = a.wrapping_add(2) % size.max(2);
            if a == 0 {
                a = 1;
            }
        }
        Permutation {
            size,
            a,
            b: rng.draw() % size,
        }
    }

    fn at(&self, row: u64) -> u64 {
        ((self.a as u128 * (row % self.size) as u128 + self.b as u128) % self.size as u128) as u64
    }
}

// ── words ───────────────────────────────────────────────────────────────────────────────────

/// The word lists of a language: put together for this app from common names and words – no list of
/// someone else was taken over (docs/architecture.md).
struct Words {
    first: &'static [&'static str],
    last: &'static [&'static str],
    cities: &'static [&'static str],
    streets: &'static [&'static str],
    countries: &'static [&'static str],
    company_ends: &'static [&'static str],
    phone: &'static str,
    tld: &'static str,
}

const EN: Words = Words {
    first: &[
        "James",
        "Mary",
        "John",
        "Patricia",
        "Robert",
        "Jennifer",
        "Michael",
        "Linda",
        "William",
        "Elizabeth",
        "David",
        "Barbara",
        "Richard",
        "Susan",
        "Joseph",
        "Jessica",
        "Thomas",
        "Sarah",
        "Charles",
        "Karen",
        "Daniel",
        "Nancy",
        "Matthew",
        "Lisa",
        "Anthony",
        "Betty",
        "Mark",
        "Margaret",
        "Paul",
        "Sandra",
        "Steven",
        "Ashley",
        "Andrew",
        "Emily",
        "Kenneth",
        "Donna",
        "Joshua",
        "Michelle",
        "Kevin",
        "Carol",
        "Brian",
        "Amanda",
        "George",
        "Melissa",
        "Edward",
        "Deborah",
        "Ronald",
        "Stephanie",
        "Timothy",
        "Rebecca",
    ],
    last: &[
        "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Wilson",
        "Anderson", "Taylor", "Thomas", "Moore", "Jackson", "Martin", "Lee", "Thompson", "White",
        "Harris", "Clark", "Lewis", "Robinson", "Walker", "Young", "Allen", "King", "Wright",
        "Scott", "Hill", "Green", "Adams", "Baker", "Nelson", "Carter", "Mitchell", "Roberts",
        "Turner", "Phillips", "Campbell", "Parker", "Evans", "Edwards", "Collins", "Stewart",
        "Morris", "Murphy", "Cook", "Rogers", "Morgan", "Cooper",
    ],
    cities: &[
        "Springfield",
        "Riverside",
        "Franklin",
        "Greenville",
        "Bristol",
        "Clinton",
        "Fairview",
        "Salem",
        "Madison",
        "Georgetown",
        "Arlington",
        "Ashland",
        "Oxford",
        "Milton",
        "Newport",
        "Kingston",
        "Dover",
        "Lexington",
        "Manchester",
        "Burlington",
    ],
    streets: &[
        "Main Street",
        "Oak Avenue",
        "Maple Street",
        "Park Road",
        "Cedar Lane",
        "Elm Street",
        "Lake View",
        "Hill Road",
        "Church Street",
        "Mill Lane",
        "High Street",
        "Station Road",
        "Garden Way",
        "River Road",
        "Sunset Boulevard",
    ],
    countries: &[
        "United States",
        "United Kingdom",
        "Canada",
        "Australia",
        "Ireland",
        "New Zealand",
    ],
    company_ends: &["Inc.", "Ltd.", "LLC", "Group", "& Sons", "Partners"],
    phone: "+1 202 555 01",
    tld: "com",
};

const DE: Words = Words {
    first: &[
        "Anna",
        "Paul",
        "Maria",
        "Jonas",
        "Lena",
        "Felix",
        "Laura",
        "Lukas",
        "Julia",
        "Leon",
        "Sarah",
        "Max",
        "Lisa",
        "Tim",
        "Katharina",
        "Jan",
        "Sophie",
        "Niklas",
        "Johanna",
        "Tobias",
        "Emma",
        "Florian",
        "Hannah",
        "David",
        "Marie",
        "Simon",
        "Lea",
        "Daniel",
        "Clara",
        "Moritz",
        "Nina",
        "Stefan",
        "Petra",
        "Thomas",
        "Sabine",
        "Michael",
        "Monika",
        "Andreas",
        "Ursula",
        "Peter",
        "Claudia",
        "Martin",
        "Heike",
        "Frank",
        "Birgit",
        "Klaus",
        "Karin",
        "Uwe",
        "Ingrid",
        "Rainer",
    ],
    last: &[
        "Müller",
        "Schmidt",
        "Schneider",
        "Fischer",
        "Weber",
        "Meyer",
        "Wagner",
        "Becker",
        "Schulz",
        "Hoffmann",
        "Schäfer",
        "Koch",
        "Bauer",
        "Richter",
        "Klein",
        "Wolf",
        "Schröder",
        "Neumann",
        "Schwarz",
        "Zimmermann",
        "Braun",
        "Krüger",
        "Hofmann",
        "Hartmann",
        "Lange",
        "Schmitt",
        "Werner",
        "Krause",
        "Meier",
        "Lehmann",
        "Schmid",
        "Schulze",
        "Maier",
        "Köhler",
        "Herrmann",
        "König",
        "Walter",
        "Mayer",
        "Huber",
        "Kaiser",
        "Fuchs",
        "Peters",
        "Lang",
        "Scholz",
        "Möller",
        "Weiß",
        "Jung",
        "Hahn",
        "Schubert",
        "Vogel",
    ],
    cities: &[
        "Berlin",
        "Hamburg",
        "München",
        "Köln",
        "Frankfurt",
        "Stuttgart",
        "Düsseldorf",
        "Leipzig",
        "Dortmund",
        "Essen",
        "Bremen",
        "Dresden",
        "Hannover",
        "Nürnberg",
        "Bonn",
        "Münster",
        "Karlsruhe",
        "Mannheim",
        "Augsburg",
        "Kiel",
    ],
    streets: &[
        "Hauptstraße",
        "Bahnhofstraße",
        "Gartenstraße",
        "Schulstraße",
        "Dorfstraße",
        "Bergstraße",
        "Kirchweg",
        "Lindenallee",
        "Am Markt",
        "Mühlenweg",
        "Ringstraße",
        "Waldweg",
        "Feldstraße",
        "Rosenweg",
        "Parkallee",
    ],
    countries: &[
        "Deutschland",
        "Österreich",
        "Schweiz",
        "Luxemburg",
        "Liechtenstein",
    ],
    company_ends: &["GmbH", "AG", "KG", "& Söhne", "OHG", "e. K."],
    phone: "+49 30 5550 ",
    tld: "de",
};

const LOREM: &[&str] = &[
    "lorem",
    "ipsum",
    "dolor",
    "sit",
    "amet",
    "consectetur",
    "adipiscing",
    "elit",
    "sed",
    "do",
    "eiusmod",
    "tempor",
    "incididunt",
    "ut",
    "labore",
    "et",
    "dolore",
    "magna",
    "aliqua",
    "enim",
    "ad",
    "minim",
    "veniam",
    "quis",
    "nostrud",
    "exercitation",
    "ullamco",
    "laboris",
    "nisi",
    "aliquip",
    "ex",
    "ea",
    "commodo",
    "consequat",
    "duis",
    "aute",
    "irure",
    "in",
    "reprehenderit",
    "voluptate",
    "velit",
    "esse",
    "cillum",
    "fugiat",
    "nulla",
    "pariatur",
];

fn words(locale: &str) -> &'static Words {
    if locale.to_lowercase().starts_with("de") {
        &DE
    } else {
        &EN
    }
}

/// A name as a mail address can carry it: lower case, plain ASCII.
fn mail_part(name: &str) -> String {
    name.chars()
        .flat_map(|c| match c {
            'ä' | 'Ä' => vec!['a', 'e'],
            'ö' | 'Ö' => vec!['o', 'e'],
            'ü' | 'Ü' => vec!['u', 'e'],
            'ß' => vec!['s', 's'],
            c if c.is_ascii_alphanumeric() => vec![c.to_ascii_lowercase()],
            _ => vec![],
        })
        .collect()
}

// ── the spec ────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Weighted {
    pub value: String,
    #[serde(default = "one")]
    pub weight: f64,
}

fn one() -> f64 {
    1.0
}

/// How the values of a column are made.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Gen {
    /// The column is left out: the database fills it (a default, an identity).
    Skip,
    Fixed {
        value: String,
    },
    Sequence {
        start: i64,
        step: i64,
    },
    Int {
        min: i64,
        max: i64,
        /// Around the middle instead of evenly spread.
        #[serde(default)]
        normal: bool,
    },
    Decimal {
        min: f64,
        max: f64,
        scale: u32,
    },
    Bool {
        true_share: f64,
    },
    /// `from` and `to` as `2026-01-31`.
    Date {
        from: String,
        to: String,
    },
    /// `from` and `to` as `2026-01-31` or `2026-01-31 12:00:00`; `not_before`: a date-time column of the
    /// row this one is never earlier than (`created_at ≤ updated_at`).
    DateTime {
        from: String,
        to: String,
        #[serde(default)]
        not_before: Option<String>,
    },
    Time,
    Uuid,
    /// Words, `min` to `max` characters.
    Text {
        min: u32,
        max: u32,
    },
    /// A small regular expression: literals, `\d \w \s`, classes `[a-z0-9_]`, groups `(a|b)`, and
    /// `{n}`, `{n,m}`, `?`, `*`, `+`.
    Pattern {
        pattern: String,
    },
    Choice {
        values: Vec<Weighted>,
    },
    FirstName,
    LastName,
    FullName,
    /// From the names of the row, so they fit together.
    Email,
    Phone,
    Street,
    City,
    Zip,
    Country,
    Company,
    Lorem {
        words: u32,
    },
    /// JSON with `{{int:1:9}}`, `{{bool}}`, `{{uuid}}`, `{{firstName}}`, `{{lastName}}`, `{{city}}`,
    /// `{{word}}`, `{{date}}` filled in.
    Json {
        template: String,
    },
    /// A value of the column this one points to. `per_parent`: every row there gets that many rows here
    /// (from … to), one after the other – the number of rows follows from it.
    ForeignKey {
        #[serde(default)]
        per_parent: Option<(u32, u32)>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSpec {
    pub name: String,
    /// The type as the database names it (PostgreSQL casts to it).
    #[serde(default)]
    pub type_name: String,
    #[serde(default)]
    pub value_kind: ValueKind,
    /// How its values are made (`gen` on the wire).
    #[serde(rename = "gen")]
    pub how: Gen,
    /// The share of rows without a value, 0 to 1.
    #[serde(default)]
    pub null_share: f64,
    /// No value twice.
    #[serde(default)]
    pub unique: bool,
    /// Characters the column takes at most; longer values are cut.
    #[serde(default)]
    pub max_len: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    #[serde(default)]
    pub schema: String,
    pub table: String,
    pub columns: Vec<ColumnSpec>,
    pub rows: u64,
    pub seed: u64,
    /// `en` or `de`: names, cities, the form of a phone number.
    #[serde(default)]
    pub locale: String,
}

// ── patterns ────────────────────────────────────────────────────────────────────────────────

/// A piece of a pattern.
#[derive(Debug, Clone, PartialEq)]
enum Piece {
    Literal(char),
    /// One of these characters.
    Class(Vec<char>),
    /// One of these sequences.
    Group(Vec<Vec<(Piece, u32, u32)>>),
}

type Sequence = Vec<(Piece, u32, u32)>;

/// `*` and `+` repeat this often at most.
const OPEN_REPEAT: u32 = 8;
const PATTERN_CHARS: usize = 500;

struct PatternParser<'a> {
    chars: std::iter::Peekable<std::str::Chars<'a>>,
    depth: u32,
}

fn digits() -> Vec<char> {
    ('0'..='9').collect()
}

fn word_chars() -> Vec<char> {
    ('a'..='z')
        .chain('A'..='Z')
        .chain('0'..='9')
        .chain(['_'])
        .collect()
}

impl PatternParser<'_> {
    fn alternatives(&mut self) -> AppResult<Vec<Sequence>> {
        let mut all = vec![Vec::new()];
        while let Some(&c) = self.chars.peek() {
            match c {
                ')' if self.depth > 0 => break,
                '|' => {
                    self.chars.next();
                    all.push(Vec::new());
                }
                _ => {
                    let piece = self.piece()?;
                    let (min, max) = self.quantifier()?;
                    all.last_mut()
                        .expect("one sequence")
                        .push((piece, min, max));
                }
            }
        }
        Ok(all)
    }

    fn piece(&mut self) -> AppResult<Piece> {
        match self.chars.next() {
            Some('\\') => match self.chars.next() {
                Some('d') => Ok(Piece::Class(digits())),
                Some('w') => Ok(Piece::Class(word_chars())),
                Some('s') => Ok(Piece::Literal(' ')),
                Some(c) => Ok(Piece::Literal(c)),
                None => Err(invalid("the pattern ends in a backslash")),
            },
            Some('[') => {
                let mut set = Vec::new();
                let mut closed = false;
                while let Some(c) = self.chars.next() {
                    match c {
                        ']' => {
                            closed = true;
                            break;
                        }
                        '\\' => match self.chars.next() {
                            Some('d') => set.extend(digits()),
                            Some('w') => set.extend(word_chars()),
                            Some(c) => set.push(c),
                            None => break,
                        },
                        c if self.chars.peek() == Some(&'-') => {
                            self.chars.next();
                            match self.chars.next() {
                                Some(']') => {
                                    set.extend([c, '-']);
                                    closed = true;
                                    break;
                                }
                                Some(end) if end >= c && (end as u32 - c as u32) < 1_000 => {
                                    set.extend(c..=end);
                                }
                                _ => return Err(invalid("a range in the pattern runs backwards")),
                            }
                        }
                        c => set.push(c),
                    }
                }
                if !closed || set.is_empty() {
                    return Err(invalid("a class of the pattern is empty or not closed"));
                }
                Ok(Piece::Class(set))
            }
            Some('(') => {
                self.depth += 1;
                if self.depth > 8 {
                    return Err(invalid("the pattern is nested too deep"));
                }
                let inner = self.alternatives()?;
                if self.chars.next() != Some(')') {
                    return Err(invalid("a group of the pattern is not closed"));
                }
                self.depth -= 1;
                Ok(Piece::Group(inner))
            }
            Some('.') => Ok(Piece::Class(word_chars())),
            Some(c @ (')' | '{' | '}' | '?' | '*' | '+' | ']')) => {
                Err(invalid(format!("the pattern has a stray `{c}`")))
            }
            Some(c) => Ok(Piece::Literal(c)),
            None => Err(invalid("the pattern ends too early")),
        }
    }

    fn quantifier(&mut self) -> AppResult<(u32, u32)> {
        match self.chars.peek() {
            Some('?') => {
                self.chars.next();
                Ok((0, 1))
            }
            Some('*') => {
                self.chars.next();
                Ok((0, OPEN_REPEAT))
            }
            Some('+') => {
                self.chars.next();
                Ok((1, OPEN_REPEAT))
            }
            Some('{') => {
                self.chars.next();
                let mut text = String::new();
                loop {
                    match self.chars.next() {
                        Some('}') => break,
                        Some(c) if text.len() < 12 => text.push(c),
                        _ => return Err(invalid("a count of the pattern is not closed")),
                    }
                }
                let number = |t: &str| {
                    t.trim()
                        .parse::<u32>()
                        .ok()
                        .filter(|n| *n <= 200)
                        .ok_or_else(|| invalid("a count of the pattern is no number up to 200"))
                };
                let (min, max) = match text.split_once(',') {
                    Some((a, b)) if b.trim().is_empty() => {
                        let a = number(a)?;
                        (a, a + OPEN_REPEAT)
                    }
                    Some((a, b)) => (number(a)?, number(b)?),
                    None => {
                        let n = number(&text)?;
                        (n, n)
                    }
                };
                if max < min {
                    return Err(invalid("a count of the pattern runs backwards"));
                }
                Ok((min, max))
            }
            _ => Ok((1, 1)),
        }
    }
}

/// Reads a pattern.
fn parse_pattern(pattern: &str) -> AppResult<Vec<Sequence>> {
    if pattern.chars().count() > PATTERN_CHARS {
        return Err(invalid("the pattern is too long"));
    }
    let mut parser = PatternParser {
        chars: pattern.chars().peekable(),
        depth: 0,
    };
    let all = parser.alternatives()?;
    if parser.chars.next().is_some() {
        return Err(invalid("the pattern has a stray `)`"));
    }
    Ok(all)
}

/// Steps one value of a pattern may take: a group that writes nothing, repeated in groups that repeat,
/// would otherwise turn for ever without ever reaching the limit of characters (review 049).
const PATTERN_STEPS: u32 = 20_000;

/// A text the pattern matches; never longer than `limit` characters, never more than `steps` steps.
fn write_pattern(
    alternatives: &[Sequence],
    rng: &mut Rng,
    out: &mut String,
    limit: usize,
    steps: &mut u32,
) {
    if alternatives.is_empty() {
        return;
    }
    let sequence = &alternatives[rng.below(alternatives.len() as u64) as usize];
    let mut length = out.chars().count();
    for (piece, min, max) in sequence {
        let times = rng.between(*min as i64, *max as i64);
        for _ in 0..times {
            if length >= limit || *steps == 0 {
                return;
            }
            *steps -= 1;
            match piece {
                Piece::Literal(c) => {
                    out.push(*c);
                    length += 1;
                }
                Piece::Class(set) => {
                    out.push(set[rng.below(set.len() as u64) as usize]);
                    length += 1;
                }
                Piece::Group(inner) => {
                    write_pattern(inner, rng, out, limit, steps);
                    length = out.chars().count();
                }
            }
        }
    }
}

// ── the generator ───────────────────────────────────────────────────────────────────────────

fn date_of(text: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d")
        .map_err(|_| invalid(format!("„{}“ is no date (2026-01-31)", cut(text, 30))))
}

fn stamp_of(text: &str, end_of_day: bool) -> AppResult<NaiveDateTime> {
    let t = text.trim();
    if let Ok(stamp) = NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S") {
        return Ok(stamp);
    }
    let day = date_of(t)?;
    Ok(if end_of_day {
        day.and_hms_opt(23, 59, 59).expect("a time of day")
    } else {
        day.and_hms_opt(0, 0, 0).expect("a time of day")
    })
}

fn cut(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}

/// What a column needs beyond its spec, worked out once.
#[derive(Debug, Clone)]
enum Prepared {
    Plain,
    /// A range of whole steps: numbers, days, seconds.
    Range {
        low: i64,
        size: u64,
        walk: Option<Permutation>,
    },
    Pattern(Vec<Sequence>),
    /// The sum of the weights.
    Choice(f64),
    Keys,
}

/// Hands out the rows of a spec.
pub struct Generator {
    spec: Spec,
    prepared: Vec<Prepared>,
    /// The values of a foreign key column, by its index.
    keys: HashMap<usize, Vec<String>>,
    total: u64,
    row: u64,
    /// Rows per parent: the column, the parent the walk is at, and how many rows it still gets.
    walk: Option<(usize, u64, u32)>,
}

impl Generator {
    /// Checks the spec – ranges, patterns, whether a unique column has values enough – and works out how
    /// many rows there will be. `keys`: the values a foreign key column draws from, by column name.
    pub fn new(spec: Spec, keys: &HashMap<String, Vec<String>>) -> AppResult<Self> {
        if spec.columns.is_empty() {
            return Err(invalid("no columns"));
        }
        if spec.columns.len() > 1_000 {
            return Err(invalid("too many columns"));
        }
        let mut own_keys = HashMap::new();
        let mut walk = None;
        let mut total = spec.rows;
        for (i, c) in spec.columns.iter().enumerate() {
            if let Gen::ForeignKey { per_parent } = &c.how {
                let values = keys.get(&c.name).cloned().unwrap_or_default();
                if values.is_empty() {
                    return Err(invalid(format!(
                        "the table {} points to has no rows: fill it first",
                        cut(&c.name, 60)
                    )));
                }
                if let Some((min, max)) = per_parent {
                    if max < min {
                        return Err(invalid("rows per parent run backwards"));
                    }
                    if walk.is_some() {
                        return Err(invalid(
                            "only one column can say how many rows a parent gets",
                        ));
                    }
                    // the number of rows follows from the parents
                    total = (0..values.len() as u64)
                        .map(|p| per_parent_count(spec.seed, i as u64, p, *min, *max) as u64)
                        .sum();
                    walk = Some((i, 0, 0));
                }
                own_keys.insert(i, values);
            }
        }
        if total > MAX_ROWS {
            return Err(invalid(format!("more than {MAX_ROWS} rows")));
        }
        let mut prepared = Vec::with_capacity(spec.columns.len());
        for (i, c) in spec.columns.iter().enumerate() {
            if !(0.0..=1.0).contains(&c.null_share) {
                return Err(invalid("the share of NULL is between 0 and 1"));
            }
            prepared.push(prepare(&spec, i, c, total, own_keys.get(&i))?);
        }
        // a column a date waits for must be a date-time itself, and wait for none
        for c in &spec.columns {
            if let Gen::DateTime {
                not_before: Some(other),
                ..
            } = &c.how
            {
                let ok = spec.columns.iter().any(|o| {
                    o.name == *other
                        && o.name != c.name
                        && matches!(
                            &o.how,
                            Gen::DateTime {
                                not_before: None,
                                ..
                            }
                        )
                });
                if !ok {
                    return Err(invalid(format!(
                        "„{}“ is no date-time column of its own to come after",
                        cut(other, 60)
                    )));
                }
            }
        }
        let mut generator = Generator {
            spec,
            prepared,
            keys: own_keys,
            total,
            row: 0,
            walk,
        };
        generator.settle();
        Ok(generator)
    }

    /// The rows there will be.
    pub fn total(&self) -> u64 {
        self.total
    }

    /// The columns that are written (not the ones the database fills), by their index in the spec.
    pub fn written(&self) -> Vec<usize> {
        self.spec
            .columns
            .iter()
            .enumerate()
            .filter(|(_, c)| c.how != Gen::Skip)
            .map(|(i, _)| i)
            .collect()
    }

    pub fn spec(&self) -> &Spec {
        &self.spec
    }

    /// Moves the walk over the parents to one that still gets a row.
    fn settle(&mut self) {
        let Some((column, mut parent, mut left)) = self.walk else {
            return;
        };
        let Some(Gen::ForeignKey {
            per_parent: Some((min, max)),
        }) = self.spec.columns.get(column).map(|c| &c.how)
        else {
            return;
        };
        let parents = self.keys.get(&column).map_or(0, Vec::len) as u64;
        if self.row == 0 && parent == 0 && left == 0 {
            left = per_parent_count(self.spec.seed, column as u64, 0, *min, *max);
        }
        while left == 0 && parent + 1 < parents {
            parent += 1;
            left = per_parent_count(self.spec.seed, column as u64, parent, *min, *max);
        }
        self.walk = Some((column, parent, left));
    }

    /// The next row: one value per written column, `None` for NULL. `None` at the end.
    pub fn next_row(&mut self) -> Option<Vec<Option<String>>> {
        if self.row >= self.total {
            return None;
        }
        let row = self.row;
        let cells = self
            .written()
            .into_iter()
            .map(|i| self.cell(i, row))
            .collect();
        self.row += 1;
        if let Some((column, parent, left)) = self.walk {
            self.walk = Some((column, parent, left.saturating_sub(1)));
            self.settle();
        }
        Some(cells)
    }

    fn person(&self, row: u64) -> (&'static str, &'static str) {
        // one person per row, whoever asks: the names and the mail address fit together
        let mut rng = Rng::cell(self.spec.seed, u64::MAX - 1, row);
        let w = words(&self.spec.locale);
        (rng.pick(w.first), rng.pick(w.last))
    }

    /// The moment of a date-time column in a row, without what it waits for.
    fn stamp(&self, column: usize, row: u64, floor: Option<i64>) -> i64 {
        let Prepared::Range { low, size, walk } = &self.prepared[column] else {
            return 0;
        };
        let mut rng = Rng::cell(self.spec.seed, column as u64, row);
        rng.draw(); // the draw for NULL
        let own = match walk {
            Some(p) => offset(*low, p.at(row)),
            None => offset(*low, rng.below(*size)),
        };
        match floor {
            // never before the other one: somewhere between it and the end of the range
            Some(floor) if floor > own => {
                let end = low + *size as i64 - 1;
                if floor >= end {
                    floor
                } else {
                    floor + rng.below((end - floor + 1) as u64) as i64
                }
            }
            _ => own,
        }
    }

    fn cell(&self, column: usize, row: u64) -> Option<String> {
        let c = &self.spec.columns[column];
        let mut rng = Rng::cell(self.spec.seed, column as u64, row);
        // the first draw decides NULL – also where there is none, so a share changes no other value
        let null = rng.unit() < c.null_share;
        if null && !c.unique {
            return None;
        }
        let w = words(&self.spec.locale);
        let prepared = &self.prepared[column];
        let ranged = |rng: &mut Rng| -> i64 {
            match prepared {
                Prepared::Range {
                    low, walk: Some(p), ..
                } => offset(*low, p.at(row)),
                Prepared::Range { low, size, .. } => offset(*low, rng.below(*size)),
                _ => 0,
            }
        };
        let mut unique_by_row = c.unique;
        let text = match &c.how {
            Gen::Skip => return None,
            Gen::Fixed { value } => {
                unique_by_row = false;
                value.clone()
            }
            Gen::Sequence { start, step } => {
                unique_by_row = false;
                (*start as i128 + *step as i128 * row as i128).to_string()
            }
            Gen::Int { normal, .. } => {
                unique_by_row = false;
                match prepared {
                    // the middle of three draws: most values near the middle of the range
                    Prepared::Range {
                        low,
                        size,
                        walk: None,
                    } if *normal => {
                        let sum: u128 = (0..3).map(|_| rng.below(*size) as u128).sum();
                        (*low as i128 + (sum / 3) as i128).to_string()
                    }
                    _ => ranged(&mut rng).to_string(),
                }
            }
            Gen::Decimal { scale, .. } => {
                unique_by_row = false;
                let steps = ranged(&mut rng);
                let scale = (*scale).min(12);
                let unit = 10i64.pow(scale);
                if scale == 0 {
                    steps.to_string()
                } else {
                    let sign = if steps < 0 { "-" } else { "" };
                    let abs = steps.unsigned_abs();
                    format!(
                        "{sign}{}.{:0width$}",
                        abs / unit as u64,
                        abs % unit as u64,
                        width = scale as usize
                    )
                }
            }
            Gen::Bool { true_share } => {
                unique_by_row = false;
                // unique: at most two rows (checked), one of each
                if (c.unique && row == 0) || (!c.unique && rng.unit() < *true_share) {
                    "true"
                } else {
                    "false"
                }
                .to_owned()
            }
            Gen::Date { .. } => {
                unique_by_row = false;
                let days = ranged(&mut rng);
                (NaiveDate::from_ymd_opt(1970, 1, 1).expect("the epoch") + Duration::days(days))
                    .format("%Y-%m-%d")
                    .to_string()
            }
            Gen::DateTime { not_before, .. } => {
                unique_by_row = false;
                let floor = not_before.as_ref().and_then(|name| {
                    let other = self.spec.columns.iter().position(|o| o.name == *name)?;
                    Some(self.stamp(other, row, None))
                });
                let seconds = self.stamp(column, row, floor);
                chrono::DateTime::from_timestamp(seconds, 0)
                    .map(|t| t.naive_utc().format("%Y-%m-%d %H:%M:%S").to_string())
                    .unwrap_or_default()
            }
            Gen::Time => {
                unique_by_row = false;
                let s = match prepared {
                    Prepared::Range { walk: Some(p), .. } => p.at(row),
                    _ => rng.below(86_400),
                };
                format!("{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
            }
            Gen::Uuid => {
                unique_by_row = false;
                let (a, b) = (rng.draw(), rng.draw());
                // version 4, variant 1
                format!(
                    "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
                    a >> 32,
                    (a >> 16) & 0xffff,
                    a & 0xfff,
                    0x8000 | (b >> 48) & 0x3fff,
                    b & 0xffff_ffff_ffff
                )
            }
            Gen::Text { min, max } => {
                let length = rng.between(*min as i64, (*max).max(*min) as i64) as usize;
                let mut out = String::new();
                // the words are plain ASCII: bytes are characters
                while out.len() < length {
                    if !out.is_empty() {
                        out.push(' ');
                    }
                    out.push_str(rng.pick(LOREM));
                }
                cut(&out, length).trim_end().to_owned()
            }
            Gen::Pattern { .. } => {
                let mut out = String::new();
                if let Prepared::Pattern(p) = prepared {
                    let mut steps = PATTERN_STEPS;
                    write_pattern(p, &mut rng, &mut out, 4_000, &mut steps);
                }
                out
            }
            Gen::Choice { values } => {
                if c.unique {
                    unique_by_row = false;
                    // one after the other, each once (there are enough: checked)
                    values[(row % values.len() as u64) as usize].value.clone()
                } else {
                    let Prepared::Choice(sum) = prepared else {
                        return None;
                    };
                    let mut at = rng.unit() * sum;
                    let mut chosen = &values[values.len() - 1];
                    for v in values {
                        at -= v.weight.max(0.0);
                        if at < 0.0 {
                            chosen = v;
                            break;
                        }
                    }
                    chosen.value.clone()
                }
            }
            Gen::FirstName => self.person(row).0.to_owned(),
            Gen::LastName => self.person(row).1.to_owned(),
            Gen::FullName => {
                let (first, last) = self.person(row);
                format!("{first} {last}")
            }
            Gen::Email => {
                let (first, last) = self.person(row);
                let host = ["example.com", "example.org", "example.net"][rng.below(3) as usize];
                let host = if w.tld == "de" && host == "example.com" {
                    "example.de"
                } else {
                    host
                };
                unique_by_row = false;
                let number = if c.unique {
                    row.to_string()
                } else if rng.below(3) == 0 {
                    rng.between(1, 99).to_string()
                } else {
                    String::new()
                };
                format!("{}.{}{number}@{host}", mail_part(first), mail_part(last))
            }
            Gen::Phone => format!("{}{:02}", w.phone, rng.below(100)),
            Gen::Street => format!("{} {}", rng.pick(w.streets), rng.between(1, 199)),
            Gen::City => rng.pick(w.cities).to_owned(),
            Gen::Zip => format!("{:05}", rng.between(1_000, 99_999)),
            Gen::Country => rng.pick(w.countries).to_owned(),
            Gen::Company => format!("{} {}", rng.pick(w.last), rng.pick(w.company_ends)),
            Gen::Lorem { words: n } => {
                let n = (*n).clamp(1, 500);
                let mut out = String::new();
                for i in 0..n {
                    if i > 0 {
                        out.push(' ');
                    }
                    out.push_str(rng.pick(LOREM));
                }
                out
            }
            Gen::Json { template } => {
                unique_by_row = false;
                fill_template(template, &mut rng, w)
            }
            Gen::ForeignKey { per_parent } => {
                unique_by_row = false;
                let keys = self.keys.get(&column)?;
                match (per_parent, self.walk) {
                    (Some(_), Some((walked, parent, _))) if walked == column => {
                        keys.get(parent as usize)?.clone()
                    }
                    // unique: one row per parent, in their order (there are enough: checked)
                    _ if c.unique => keys.get(row as usize)?.clone(),
                    _ => keys[rng.below(keys.len() as u64) as usize].clone(),
                }
            }
        };
        let room = if c.unique && !unique_by_row {
            None
        } else {
            c.max_len
        };
        Some(fitted(text, room, unique_by_row.then_some(row)))
    }
}

/// `low + steps`, for ranges as wide as all whole numbers.
fn offset(low: i64, steps: u64) -> i64 {
    (low as i128 + steps as i128) as i64
}

/// How many rows parent `p` gets.
fn per_parent_count(seed: u64, column: u64, parent: u64, min: u32, max: u32) -> u32 {
    Rng::cell(seed, column ^ 0x5eed, parent).between(min as i64, max as i64) as u32
}

/// A text within the length of its column; with `row`, its number at the end makes it unique.
fn fitted(text: String, max_len: Option<u32>, row: Option<u64>) -> String {
    let suffix = row.map(|r| format!("-{r}")).unwrap_or_default();
    match max_len {
        Some(max) => {
            let max = max as usize;
            let room = max.saturating_sub(suffix.chars().count());
            let mut out = cut(&text, room);
            out.push_str(&cut(&suffix, max));
            cut(&out, max)
        }
        None => text + &suffix,
    }
}

fn json_text(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned())
}

/// A template with its `{{…}}` filled in.
fn fill_template(template: &str, rng: &mut Rng, w: &Words) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let token = rest[start + 2..start + end].trim();
        let mut parts = token.split(':');
        let value = match parts.next().unwrap_or("") {
            "int" => {
                let min = parts.next().and_then(|t| t.parse().ok()).unwrap_or(0);
                let max = parts.next().and_then(|t| t.parse().ok()).unwrap_or(100);
                rng.between(min, max).to_string()
            }
            "bool" => (rng.below(2) == 0).to_string(),
            "uuid" => {
                let (a, b) = (rng.draw(), rng.draw());
                json_text(&format!("{a:016x}{b:016x}"))
            }
            "firstName" => json_text(rng.pick(w.first)),
            "lastName" => json_text(rng.pick(w.last)),
            "city" => json_text(rng.pick(w.cities)),
            "word" => json_text(rng.pick(LOREM)),
            "date" => json_text(&format!(
                "20{:02}-{:02}-{:02}",
                rng.between(15, 26),
                rng.between(1, 12),
                rng.between(1, 28)
            )),
            // what is no token stays as it stands
            _ => rest[start..start + end + 2].to_owned(),
        };
        out.push_str(&value);
        rest = &rest[start + end + 2..];
    }
    out.push_str(rest);
    out
}

fn prepare(
    spec: &Spec,
    index: usize,
    c: &ColumnSpec,
    total: u64,
    keys: Option<&Vec<String>>,
) -> AppResult<Prepared> {
    let name = cut(&c.name, 60);
    let range = |low: i64, high: i64| -> AppResult<Prepared> {
        if high < low {
            return Err(invalid(format!("{name}: the range runs backwards")));
        }
        let size = (high as i128 - low as i128 + 1).min(u64::MAX as i128) as u64;
        if c.unique && size < total {
            return Err(invalid(format!(
                "{name}: {size} different values are not enough for {total} rows without a double"
            )));
        }
        Ok(Prepared::Range {
            low,
            size,
            walk: c
                .unique
                .then(|| Permutation::new(size, spec.seed, index as u64)),
        })
    };
    let few = |have: usize, what: &str| -> AppResult<()> {
        if c.unique && (have as u64) < total {
            return Err(invalid(format!(
                "{name}: {have} {what} are not enough for {total} rows without a double"
            )));
        }
        Ok(())
    };
    // a unique text carries the number of its row: the column must have room for it (review 049)
    let carries = matches!(
        &c.how,
        Gen::Text { .. }
            | Gen::Pattern { .. }
            | Gen::FirstName
            | Gen::LastName
            | Gen::FullName
            | Gen::Phone
            | Gen::Street
            | Gen::City
            | Gen::Zip
            | Gen::Country
            | Gen::Company
            | Gen::Lorem { .. }
    );
    if let (true, true, Some(max)) = (c.unique, carries, c.max_len) {
        let needed = 1 + total.saturating_sub(1).to_string().len() as u32;
        if max < needed {
            return Err(invalid(format!(
                "{name}: {max} characters have no room for {total} different values"
            )));
        }
    }
    Ok(match &c.how {
        Gen::Int { min, max, .. } => range(*min, *max)?,
        Gen::Decimal { min, max, scale } => {
            if !min.is_finite() || !max.is_finite() || *scale > 12 {
                return Err(invalid(format!("{name}: this is no range of decimals")));
            }
            let unit = 10f64.powi(*scale as i32);
            let (low, high) = ((min * unit).round(), (max * unit).round());
            if low.abs() > 9e17 || high.abs() > 9e17 {
                return Err(invalid(format!("{name}: the range is too wide")));
            }
            range(low as i64, high as i64)?
        }
        Gen::Date { from, to } => {
            let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).expect("the epoch");
            range(
                (date_of(from)? - epoch).num_days(),
                (date_of(to)? - epoch).num_days(),
            )?
        }
        Gen::DateTime {
            not_before: Some(_),
            ..
        } if c.unique => {
            return Err(invalid(format!(
                "{name}: a unique date-time cannot wait for another column"
            )));
        }
        Gen::DateTime { from, to, .. } => range(
            stamp_of(from, false)?.and_utc().timestamp(),
            stamp_of(to, true)?.and_utc().timestamp(),
        )?,
        Gen::Pattern { pattern } => Prepared::Pattern(parse_pattern(pattern)?),
        Gen::Choice { values } => {
            if values.is_empty() || values.len() > 10_000 {
                return Err(invalid(format!("{name}: a choice needs 1 to 10000 values")));
            }
            few(values.len(), "values")?;
            if c.unique {
                let mut seen = std::collections::HashSet::new();
                if !values.iter().all(|v| seen.insert(v.value.as_str())) {
                    return Err(invalid(format!(
                        "{name}: a value stands twice in the list of a unique column"
                    )));
                }
            }
            let sum: f64 = values.iter().map(|v| v.weight.max(0.0)).sum();
            if !sum.is_finite() || sum <= 0.0 {
                return Err(invalid(format!("{name}: the weights add up to nothing")));
            }
            Prepared::Choice(sum)
        }
        Gen::Bool { true_share } => {
            if !(0.0..=1.0).contains(true_share) {
                return Err(invalid(format!("{name}: a share is between 0 and 1")));
            }
            few(2, "values")?;
            Prepared::Plain
        }
        Gen::Time if c.unique => range(0, 86_399)?,
        Gen::Json { .. } if c.unique => {
            return Err(invalid(format!(
                "{name}: JSON from a template cannot be made unique"
            )));
        }
        Gen::Fixed { .. } => {
            few(1, "value")?;
            Prepared::Plain
        }
        Gen::Text { min, max } => {
            if max < min || *max > 100_000 {
                return Err(invalid(format!(
                    "{name}: the length runs backwards or is too long"
                )));
            }
            Prepared::Plain
        }
        Gen::Sequence { step, .. } => {
            if *step == 0 && c.unique {
                return Err(invalid(format!(
                    "{name}: a sequence that stands still is not unique"
                )));
            }
            Prepared::Plain
        }
        Gen::ForeignKey { per_parent } => {
            if per_parent.is_none() {
                few(keys.map_or(0, Vec::len), "rows of the table it points to")?;
            } else if c.unique {
                return Err(invalid(format!(
                    "{name}: a unique column gets one row per parent, not several"
                )));
            }
            Prepared::Keys
        }
        _ => Prepared::Plain,
    })
}

impl Records for Generator {
    fn width(&self) -> usize {
        self.written().len()
    }

    fn next_record(&mut self) -> AppResult<Option<NextRecord>> {
        let line = self.row + 1;
        Ok(self.next_row().map(|cells| {
            Ok(Record {
                line,
                // a generated row has no text of its own; the error file gets its values
                raw: cells
                    .iter()
                    .map(|c| c.as_deref().unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join("\t")
                    .chars()
                    .take(2_000)
                    .collect(),
                cells,
            })
        }))
    }
}

// ── the proposal from the schema ────────────────────────────────────────────────────────────

/// `(20)` of `varchar(20)`.
fn length_of(type_name: &str) -> Option<u32> {
    let inner = type_name.split_once('(')?.1.split_once(')')?.0;
    inner.split(',').next()?.trim().parse().ok()
}

/// `2` of `numeric(10,2)`.
fn scale_of(type_name: &str) -> Option<u32> {
    let inner = type_name.split_once('(')?.1.split_once(')')?.0;
    inner.split_once(',')?.1.trim().parse().ok()
}

/// The values of `enum('a','b')`.
fn enum_values(type_name: &str) -> Vec<String> {
    let lower = type_name.to_lowercase();
    if !lower.starts_with("enum(") && !lower.starts_with("set(") {
        return Vec::new();
    }
    let Some(inner) = type_name
        .split_once('(')
        .and_then(|(_, r)| r.rsplit_once(')'))
        .map(|(i, _)| i)
    else {
        return Vec::new();
    };
    let mut values = Vec::new();
    let mut current = String::new();
    let mut inside = false;
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' if inside && chars.peek() == Some(&'\'') => {
                chars.next();
                current.push('\'');
            }
            '\'' if inside => {
                inside = false;
                values.push(std::mem::take(&mut current));
            }
            '\'' => inside = true,
            c if inside => current.push(c),
            _ => {}
        }
    }
    values
}

fn has(name: &str, parts: &[&str]) -> bool {
    parts.iter().any(|p| name.contains(p))
}

/// A generator for every column of a table, from its type, its keys and its name. A proposal: the user
/// changes what does not fit.
pub fn suggest(table: &TableInfo, foreign: &[ForeignKey]) -> Vec<ColumnSpec> {
    let created = table
        .columns
        .iter()
        .find(|c| has(&c.name.to_lowercase(), &["created", "erstellt", "angelegt"]))
        .map(|c| c.name.clone());
    // a column that is the only one of a unique index
    let alone_unique = |name: &str| {
        table.indexes.iter().any(|i| {
            let d = i.detail.to_lowercase();
            d.contains("unique") && {
                let inner = i
                    .detail
                    .rsplit_once('(')
                    .and_then(|(_, r)| r.split_once(')'))
                    .map(|(c, _)| c.trim().trim_matches(['"', '`', '[', ']']).to_owned());
                inner.as_deref() == Some(name)
            }
        })
    };
    let keys = table.columns.iter().filter(|c| c.key == "pk").count();
    table
        .columns
        .iter()
        .map(|column| {
            let name = column.name.to_lowercase();
            let ty = column.type_name.to_lowercase();
            let default = column.default.as_deref().unwrap_or("").to_lowercase();
            let filled = has(
                &default,
                &["nextval", "identity", "auto_increment", "autoincrement"],
            ) || has(&ty, &["serial", "identity"]);
            let points = foreign
                .iter()
                .any(|f| f.columns.len() == 1 && f.columns[0] == column.name);
            let whole =
                has(&ty, &["int", "serial"]) && !ty.contains("interval") && !ty.contains("point");
            let decimal = has(
                &ty,
                &[
                    "numeric", "decimal", "money", "real", "double", "float", "number",
                ],
            );
            let boolean = ty.starts_with("bool") || ty == "bit" || ty == "tinyint(1)";
            let binary = has(&ty, &["blob", "bytea", "binary", "image"]);
            let options = enum_values(&column.type_name);
            let max_len = if whole || decimal || boolean {
                None
            } else {
                length_of(&column.type_name)
            };
            let room = max_len.unwrap_or(40).clamp(1, 40);
            let mut value_kind = ValueKind::Text;
            let mut type_name = column.type_name.clone();
            let how = if points {
                if whole || decimal {
                    value_kind = ValueKind::Number;
                }
                Gen::ForeignKey { per_parent: None }
            } else if filled {
                Gen::Skip
            } else if !options.is_empty() {
                Gen::Choice {
                    values: options
                        .into_iter()
                        .map(|value| Weighted { value, weight: 1.0 })
                        .collect(),
                }
            } else if boolean {
                value_kind = ValueKind::Bool;
                Gen::Bool { true_share: 0.5 }
            } else if whole {
                value_kind = ValueKind::Number;
                if column.key == "pk" {
                    Gen::Sequence { start: 1, step: 1 }
                } else if has(&name, &["age", "alter"]) {
                    Gen::Int {
                        min: 18,
                        max: 90,
                        normal: true,
                    }
                } else if has(&name, &["year", "jahr"]) {
                    Gen::Int {
                        min: 1990,
                        max: 2026,
                        normal: false,
                    }
                } else if has(
                    &name,
                    &["quantity", "qty", "count", "menge", "anzahl", "stock"],
                ) {
                    Gen::Int {
                        min: 1,
                        max: 100,
                        normal: false,
                    }
                } else {
                    let max = if ty.contains("tiny") {
                        100
                    } else if ty.contains("small") {
                        10_000
                    } else {
                        100_000
                    };
                    Gen::Int {
                        min: 1,
                        max,
                        normal: false,
                    }
                }
            } else if decimal {
                value_kind = ValueKind::Number;
                let scale = scale_of(&column.type_name).unwrap_or(2).min(6);
                let max = if has(
                    &name,
                    &[
                        "price", "preis", "amount", "betrag", "total", "cost", "summe",
                    ],
                ) {
                    500.0
                } else if has(&name, &["rate", "percent", "prozent", "share", "anteil"]) {
                    100.0
                } else {
                    1_000.0
                };
                Gen::Decimal {
                    min: 0.0,
                    max,
                    scale,
                }
            } else if ty.contains("uuid") || ty.contains("uniqueidentifier") {
                Gen::Uuid
            } else if ty.contains("json") {
                Gen::Json {
                    template: r#"{"id": {{int:1:1000}}, "active": {{bool}}, "tag": {{word}}}"#
                        .to_owned(),
                }
            } else if ty.contains("timestamp") || ty.contains("datetime") {
                let later = has(
                    &name,
                    &["updated", "modified", "changed", "geändert", "geaendert"],
                );
                Gen::DateTime {
                    from: "2023-01-01".to_owned(),
                    to: "2026-12-31".to_owned(),
                    not_before: created.clone().filter(|c| later && *c != column.name),
                }
            } else if ty == "date" {
                if has(&name, &["birth", "geburt", "dob"]) {
                    Gen::Date {
                        from: "1950-01-01".to_owned(),
                        to: "2005-12-31".to_owned(),
                    }
                } else {
                    Gen::Date {
                        from: "2023-01-01".to_owned(),
                        to: "2026-12-31".to_owned(),
                    }
                }
            } else if ty.starts_with("time") {
                Gen::Time
            } else if binary {
                value_kind = ValueKind::Bytes;
                if column.nullable || column.default.is_some() {
                    Gen::Skip
                } else {
                    Gen::Pattern {
                        pattern: "[0-9a-f]{16}".to_owned(),
                    }
                }
            } else if has(&name, &["email", "e_mail", "mail"]) {
                Gen::Email
            } else if has(&name, &["first_name", "firstname", "vorname", "given"]) {
                Gen::FirstName
            } else if has(
                &name,
                &["last_name", "lastname", "surname", "nachname", "family"],
            ) {
                Gen::LastName
            } else if name == "name"
                || has(
                    &name,
                    &["full_name", "fullname", "customer_name", "contact", "kunde"],
                )
            {
                Gen::FullName
            } else if has(&name, &["phone", "telefon", "mobile", "handy", "fax"]) || name == "tel" {
                Gen::Phone
            } else if has(
                &name,
                &[
                    "street",
                    "strasse",
                    "straße",
                    "address",
                    "adresse",
                    "anschrift",
                ],
            ) {
                Gen::Street
            } else if has(&name, &["city", "town", "stadt"]) || name == "ort" {
                Gen::City
            } else if has(&name, &["zip", "postal", "postcode", "plz"]) {
                Gen::Zip
            } else if has(&name, &["country", "land"]) {
                Gen::Country
            } else if has(
                &name,
                &[
                    "company",
                    "firma",
                    "organization",
                    "organisation",
                    "employer",
                ],
            ) {
                Gen::Company
            } else if has(&name, &["status", "state", "zustand"]) {
                Gen::Choice {
                    values: [("active", 6.0), ("inactive", 2.0), ("pending", 1.0)]
                        .into_iter()
                        .map(|(v, weight)| Weighted {
                            value: v.to_owned(),
                            weight,
                        })
                        .collect(),
                }
            } else if has(&name, &["url", "website", "homepage"]) {
                Gen::Pattern {
                    pattern: r"https://www\.[a-z]{5,10}\.example\.com".to_owned(),
                }
            } else if has(&name, &["code", "sku", "artikelnummer"]) {
                Gen::Pattern {
                    pattern: r"[A-Z]{3}-\d{5}".to_owned(),
                }
            } else if has(
                &name,
                &[
                    "description",
                    "beschreibung",
                    "comment",
                    "kommentar",
                    "note",
                    "notiz",
                    "bemerkung",
                    "body",
                    "text",
                ],
            ) {
                Gen::Lorem { words: 12 }
            } else if has(&name, &["title", "titel", "subject", "betreff"]) {
                Gen::Lorem { words: 4 }
            } else {
                Gen::Text {
                    min: room.min(5),
                    max: room,
                }
            };
            if matches!(how, Gen::Skip) {
                type_name = column.type_name.clone();
            }
            let unique = !matches!(how, Gen::Skip | Gen::ForeignKey { .. })
                && ((column.key == "pk" && keys == 1) || alone_unique(&column.name));
            ColumnSpec {
                name: column.name.clone(),
                type_name,
                value_kind,
                how,
                null_share: 0.0,
                unique,
                max_len,
            }
        })
        .collect()
}

#[cfg(test)]
#[path = "testdata_tests.rs"]
mod tests;
