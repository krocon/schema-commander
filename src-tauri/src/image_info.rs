//! What kind of picture a binary value is (prompt 026), read from its first bytes – never decoded here.
//! Only raster formats the WebView shows: PNG, JPEG, GIF, WebP. The size comes from the header, so a value
//! that claims to be a huge picture is known as one before anything tries to draw it. Pure, tested below.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    /// `image/png`, `image/jpeg`, `image/gif`, `image/webp`.
    pub mime: &'static str,
    /// Pixels as the header says; 0 when it does not say (a JPEG whose size lies behind what was read).
    pub width: u32,
    pub height: u32,
}

/// Bytes of a value that are looked at for the header (a JPEG has its size behind its metadata).
pub const HEAD_BYTES: usize = 256 * 1024;

fn be16(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_be_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
    ])))
}

fn le16(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_le_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
    ])))
}

fn le24(b: &[u8], at: usize) -> Option<u32> {
    Some(
        u32::from(*b.get(at)?) | u32::from(*b.get(at + 1)?) << 8 | u32::from(*b.get(at + 2)?) << 16,
    )
}

fn jpeg_size(b: &[u8]) -> (u32, u32) {
    // segments: FF marker, two bytes of length; the size is in a start-of-frame segment
    let mut i = 2;
    while i + 4 <= b.len() {
        if b[i] != 0xff {
            i += 1;
            continue;
        }
        let marker = b[i + 1];
        if marker == 0xff {
            i += 1;
            continue;
        }
        if (0xd0..=0xd9).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        let Some(len) = be16(b, i + 2) else { break };
        let frame = matches!(marker, 0xc0..=0xcf) && !matches!(marker, 0xc4 | 0xc8 | 0xcc);
        if frame {
            return match (be16(b, i + 7), be16(b, i + 5)) {
                (Some(w), Some(h)) => (w, h),
                _ => (0, 0),
            };
        }
        i += 2 + len.max(2) as usize;
    }
    (0, 0)
}

/// The picture the bytes start as; `None` for everything else (also SVG: that is text, and never drawn).
pub fn image_info(b: &[u8]) -> Option<ImageInfo> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") && b.get(12..16) == Some(b"IHDR") {
        let word = |at: usize| Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?));
        return Some(ImageInfo {
            mime: "image/png",
            width: word(16)?,
            height: word(20)?,
        });
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return Some(ImageInfo {
            mime: "image/gif",
            width: le16(b, 6)?,
            height: le16(b, 8)?,
        });
    }
    if b.starts_with(&[0xff, 0xd8, 0xff]) {
        let (width, height) = jpeg_size(b);
        return Some(ImageInfo {
            mime: "image/jpeg",
            width,
            height,
        });
    }
    if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        let (width, height) = match b.get(12..16)? {
            b"VP8X" => (le24(b, 24)? + 1, le24(b, 27)? + 1),
            b"VP8 " => (le16(b, 26)? & 0x3fff, le16(b, 28)? & 0x3fff),
            b"VP8L" => {
                let bits = u32::from_le_bytes(b.get(21..25)?.try_into().ok()?);
                ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
            }
            _ => (0, 0),
        };
        return Some(ImageInfo {
            mime: "image/webp",
            width,
            height,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        b.extend_from_slice(&width.to_be_bytes());
        b.extend_from_slice(&height.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        b
    }

    #[test]
    fn knows_the_raster_formats_by_their_first_bytes() {
        let info = |b: &[u8]| image_info(b).map(|i| (i.mime, i.width, i.height));
        assert_eq!(info(&png(640, 480)), Some(("image/png", 640, 480)));
        assert_eq!(
            info(b"GIF89a\x40\x01\xf0\x00rest"),
            Some(("image/gif", 320, 240))
        );
        // JPEG: an APP0 segment, then the frame with height 600 and width 800
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xc0, 0, 17, 8];
        jpeg.extend_from_slice(&[0x02, 0x58, 0x03, 0x20, 3]);
        assert_eq!(info(&jpeg), Some(("image/jpeg", 800, 600)));
        // its size lies behind what was read: still a JPEG
        assert_eq!(
            info(&[0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]),
            Some(("image/jpeg", 0, 0))
        );
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0".to_vec();
        webp.extend_from_slice(&[0x1f, 0x03, 0, 0x57, 0x02, 0]);
        assert_eq!(info(&webp), Some(("image/webp", 800, 600)));
    }

    #[test]
    fn a_claim_is_read_not_believed_and_text_is_no_picture() {
        // a header that claims a huge picture is reported as it is – the window decides not to draw it
        assert_eq!(
            image_info(&png(4_000_000_000, 4_000_000_000)).map(|i| i.width),
            Some(4_000_000_000)
        );
        for not in [
            &b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"[..],
            b"<?xml version='1.0'?><svg/>",
            b"\x89PNG\r\n\x1a\n",
            b"GIF89a",
            b"RIFF\0\0\0\0WAVE",
            b"BM\x36\0\0\0",
            b"",
        ] {
            assert_eq!(image_info(not), None, "{not:?}");
        }
    }
}
