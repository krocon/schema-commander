//! Reading and writing `.sql` files (prompt 004) so that a file keeps its encoding: UTF-8 with or without
//! a byte order mark, UTF-16 with one, and Windows-1252 for everything that is no valid UTF-8 (old scripts).
//! Line endings are part of the text and travel through the editor unchanged. Pure, tested below.

use crate::error::{AppError, AppResult, ErrorCode};
use serde::Serialize;
use std::path::Path;

/// A file to read at most (bytes).
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

pub const UTF8: &str = "utf-8";
pub const UTF8_BOM: &str = "utf-8-bom";
pub const UTF16LE: &str = "utf-16le";
pub const UTF16BE: &str = "utf-16be";
pub const WINDOWS_1252: &str = "windows-1252";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub text: String,
    /// One of the names above; hand it back to [`write`].
    pub encoding: String,
}

/// The code points Windows-1252 has at 0x80–0x9F (the rest equals Latin-1).
const CP1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{81}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{8D}', '\u{017D}', '\u{8F}',
    '\u{90}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{9D}', '\u{017E}', '\u{0178}',
];

fn decode_1252(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0x80..=0x9F => CP1252_HIGH[(b - 0x80) as usize],
            _ => b as char,
        })
        .collect()
}

fn encode_1252(text: &str) -> Option<Vec<u8>> {
    text.chars()
        .map(|c| match c as u32 {
            0..=0x7F | 0xA0..=0xFF => Some(c as u8),
            _ => CP1252_HIGH
                .iter()
                .position(|&h| h == c)
                .map(|i| 0x80 + i as u8),
        })
        .collect()
}

fn decode_utf16(bytes: &[u8], little: bool) -> Option<String> {
    let (pairs, rest) = bytes.as_chunks::<2>();
    if !rest.is_empty() {
        return None;
    }
    let units: Vec<u16> = pairs
        .iter()
        .map(|p| {
            if little {
                u16::from_le_bytes(*p)
            } else {
                u16::from_be_bytes(*p)
            }
        })
        .collect();
    String::from_utf16(&units).ok()
}

/// The text of some bytes and the encoding they were in.
pub fn decode(bytes: &[u8]) -> TextFile {
    let file = |text: String, encoding: &str| TextFile {
        text,
        encoding: encoding.to_string(),
    };
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF])
        && let Ok(text) = std::str::from_utf8(rest)
    {
        return file(text.to_string(), UTF8_BOM);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE])
        && let Some(text) = decode_utf16(rest, true)
    {
        return file(text, UTF16LE);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF])
        && let Some(text) = decode_utf16(rest, false)
    {
        return file(text, UTF16BE);
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => file(text.to_string(), UTF8),
        Err(_) => file(decode_1252(bytes), WINDOWS_1252),
    }
}

/// The bytes of a text in an encoding. A text that the encoding cannot hold (an emoji in a Windows-1252
/// file) is refused, never written with losses: the caller offers UTF-8 instead.
pub fn encode(text: &str, encoding: &str) -> AppResult<Vec<u8>> {
    let utf16 = |little: bool| {
        let mut out = if little {
            vec![0xFF, 0xFE]
        } else {
            vec![0xFE, 0xFF]
        };
        for unit in text.encode_utf16() {
            out.extend_from_slice(&if little {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        out
    };
    match encoding {
        UTF8 => Ok(text.as_bytes().to_vec()),
        UTF8_BOM => Ok([&[0xEF, 0xBB, 0xBF], text.as_bytes()].concat()),
        UTF16LE => Ok(utf16(true)),
        UTF16BE => Ok(utf16(false)),
        WINDOWS_1252 => encode_1252(text).ok_or_else(|| {
            AppError::new(
                ErrorCode::EncodingFailed,
                "the text has characters Windows-1252 cannot hold",
            )
        }),
        _ => Err(AppError::new(ErrorCode::Unsupported, "unknown encoding")),
    }
}

fn io_error(e: &std::io::Error) -> AppError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        _ => ErrorCode::Io,
    };
    AppError::new(code, e.to_string())
}

pub fn read(path: &Path) -> AppResult<TextFile> {
    let meta = std::fs::metadata(path).map_err(|e| io_error(&e))?;
    if !meta.is_file() {
        return Err(AppError::new(ErrorCode::Unsupported, "not a file"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(AppError::new(ErrorCode::TooLarge, "the file is too large"));
    }
    let bytes = std::fs::read(path).map_err(|e| io_error(&e))?;
    Ok(decode(&bytes))
}

/// Writes next to the target and renames: the file is never left half written.
pub fn write(path: &Path, text: &str, encoding: &str) -> AppResult<()> {
    let bytes = encode(text, encoding)?;
    crate::session::write_atomic(path, &bytes).map_err(|e| io_error(&e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn detects_encodings() {
        assert_eq!(decode("SELECT 'ä'".as_bytes()).encoding, UTF8);
        assert_eq!(decode(b"").encoding, UTF8);
        let bom = [&[0xEF, 0xBB, 0xBF][..], "ä".as_bytes()].concat();
        assert_eq!(
            decode(&bom),
            TextFile {
                text: "ä".into(),
                encoding: UTF8_BOM.into()
            }
        );
        assert_eq!(
            decode(&[0xFF, 0xFE, 0xE4, 0x00]),
            TextFile {
                text: "ä".into(),
                encoding: UTF16LE.into()
            }
        );
        assert_eq!(decode(&[0xFE, 0xFF, 0x00, 0xE4]).encoding, UTF16BE);
        // 0xE4 alone is no UTF-8: Windows-1252 „ä“, 0x80 is the euro sign there
        assert_eq!(
            decode(&[b'G', 0xE4, b' ', 0x80]),
            TextFile {
                text: "Gä €".into(),
                encoding: WINDOWS_1252.into()
            }
        );
    }

    #[test]
    fn every_encoding_round_trips_with_its_line_endings() {
        let text = "SELECT 'Grüße';\r\n-- Zeile 2\n";
        for encoding in [UTF8, UTF8_BOM, UTF16LE, UTF16BE, WINDOWS_1252] {
            let bytes = encode(text, encoding).unwrap();
            assert_eq!(
                decode(&bytes),
                TextFile {
                    text: text.into(),
                    encoding: encoding.into()
                },
                "{encoding}"
            );
        }
        let emoji = encode("🚀 小林", UTF16LE).unwrap();
        assert_eq!(decode(&emoji).text, "🚀 小林");
    }

    #[test]
    fn refuses_to_write_with_losses() {
        assert_eq!(encode("€ „ok“ ž", WINDOWS_1252).unwrap().len(), 8);
        assert_eq!(
            encode("🚀", WINDOWS_1252).unwrap_err().code,
            ErrorCode::EncodingFailed
        );
        assert_eq!(
            encode("x", "ebcdic").unwrap_err().code,
            ErrorCode::Unsupported
        );
    }

    #[test]
    fn reads_and_writes_files() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("Meine Abfrage ä.sql");
        write(&path, "SELECT 1;\r\n", UTF8_BOM).unwrap();
        assert_eq!(std::fs::read(&path).unwrap()[..3], [0xEF, 0xBB, 0xBF]);
        let file = read(&path).unwrap();
        assert_eq!(file.text, "SELECT 1;\r\n");
        assert_eq!(file.encoding, UTF8_BOM);
        assert_eq!(
            read(&dir.path().join("nope.sql")).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(read(dir.path()).unwrap_err().code, ErrorCode::Unsupported);
    }
}
