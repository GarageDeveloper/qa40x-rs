//! Pure-Rust extractor for the `app/QA40x.exe` payload embedded in a
//! QuantAsylum `setup_QA40x_*.exe` installer.
//!
//! These installers are **Inno Setup 6.0.0** single-file installers (the setup
//! data is appended to the PE). This module reimplements just enough of the
//! Inno Setup on-disk format to recover the first data chunk — which is
//! `QA40x.exe` — byte-for-byte, with **no external process or tool** (it
//! replaces the previous `innoextract` shell-out). The only third-party code is
//! the pure-Rust `lzma-rs` LZMA2 decoder.
//!
//! ## Format walkthrough (scoped to Inno 6.0.0, verified against `innoextract`)
//!
//! 1. **Setup loader header.** Appended to the PE is a 12-byte magic
//!    `rDlPtS \xcd\xe6\xd7\x7b\x0b\x2a`, followed by a `u32` revision (== 1) and
//!    seven little-endian `u32` offset fields. We only need `data_offset` (the
//!    6th field), which points at the start of the compressed file data
//!    (`setup.1`). See [`find_data_offset`].
//!
//! 2. **Data chunk framing.** At `data_offset` the first chunk begins with the
//!    4-byte magic `zlb\x1a`, then a single Inno "LZMA2 dictionary" property
//!    byte, then a raw LZMA2 stream. For a non-solid installer (QuantAsylum's)
//!    the first chunk decompresses to exactly one file: `QA40x.exe`. The LZMA2
//!    stream carries its own end marker, so trailing bytes are ignored.
//!
//! 3. **x86 (BCJ) filter.** Inno stores executables with a call/jump-address
//!    transform to improve compression. We undo it with the Inno Setup 5.2.0+
//!    decoder (`flip_high_byte = true` for 5.3.9+, which includes 6.0.0). See
//!    [`inno_exe_decode_5200`].
//!
//! The recovered bytes are byte-identical to `innoextract -s`'s `app/QA40x.exe`
//! (asserted by a fixture-guarded test against a known SHA-256).

use std::io::Cursor;

/// 12-byte Inno Setup "SetupLdr" signature that precedes the offset table.
const SETUP_LOADER_MAGIC: [u8; 12] = [
    b'r', b'D', b'l', b'P', b't', b'S', 0xcd, 0xe6, 0xd7, 0x7b, 0x0b, 0x2a,
];

/// 4-byte magic that begins every compressed data chunk (`setup.1`).
const CHUNK_MAGIC: [u8; 4] = [b'z', b'l', b'b', 0x1a];

fn u32_le(bytes: &[u8], off: usize) -> Result<u32, String> {
    let end = off
        .checked_add(4)
        .ok_or_else(|| "offset overflow".to_string())?;
    let slice = bytes
        .get(off..end)
        .ok_or_else(|| format!("truncated u32 at offset {off}"))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// Locate the Inno Setup loader header and return the `data_offset` it records
/// (start of the compressed file data, `setup.1`).
///
/// Layout after the 12-byte magic (all little-endian `u32`, revision 1):
/// `revision, _skip, exe_offset, exe_uncompressed_size, exe_checksum,
///  header_offset, data_offset`.
fn find_data_offset(setup: &[u8]) -> Result<usize, String> {
    // Scan for the loader magic. There is exactly one in a well-formed
    // installer; take the last match to be safe against coincidental data.
    let sig_pos = setup
        .windows(SETUP_LOADER_MAGIC.len())
        .rposition(|w| w == SETUP_LOADER_MAGIC)
        .ok_or("not an Inno Setup installer (loader signature not found)")?;

    let after = sig_pos + SETUP_LOADER_MAGIC.len();
    let revision = u32_le(setup, after)?;
    if revision != 1 {
        return Err(format!(
            "unsupported Inno Setup loader revision {revision} (expected 1)"
        ));
    }

    // data_offset is the 6th u32 following the revision field:
    //   [after+0] revision
    //   [after+4] skip / exe_offset lo
    //   [after+8] exe_offset
    //   [after+12] exe_uncompressed_size
    //   [after+16] exe_checksum
    //   [after+20] header_offset
    //   [after+24] data_offset
    let data_offset = u32_le(setup, after + 24)? as usize;

    // Validate: it must point at a chunk magic within the file.
    let end = data_offset
        .checked_add(CHUNK_MAGIC.len())
        .ok_or("data_offset overflow")?;
    let magic = setup
        .get(data_offset..end)
        .ok_or_else(|| format!("data_offset {data_offset} is past end of file"))?;
    if magic != CHUNK_MAGIC {
        return Err(format!(
            "expected 'zlb' chunk magic at data_offset {data_offset}, found {magic:02x?}"
        ));
    }
    Ok(data_offset)
}

/// Undo Inno Setup's x86 call/jump-address transform (decoder for the filter
/// used by Inno Setup 5.2.0 and later).
///
/// Ported directly from innoextract's `inno_exe_decoder_5200`. For every `0xE8`
/// (CALL) / `0xE9` (JMP) opcode whose 4-byte relative operand does not cross a
/// 64 KiB block boundary and whose high byte is `0x00`/`0xFF`, the absolute
/// address stored by the encoder is converted back to a position-relative one.
/// With `flip_high_byte` (true for Inno 5.3.9+, incl. 6.0.0) the high byte is
/// complemented when bit 23 of the relative address is set.
///
/// The transform is length-preserving; the output has the same length as input.
fn inno_exe_decode_5200(buf: &[u8], flip_high_byte: bool) -> Vec<u8> {
    const BLOCK_SIZE: usize = 0x10000;
    let n = buf.len();
    let mut out = vec![0u8; n];
    let mut i = 0usize; // read cursor into `buf`
    let mut offset = 0usize; // bytes emitted / consumed so far

    while i < n {
        let b = buf[i];
        out[offset] = b;
        i += 1;
        offset += 1;

        if b != 0xe8 && b != 0xe9 {
            continue;
        }

        // Ignore CALL/JMP whose operand would span a 64 KiB block boundary.
        let block_left = BLOCK_SIZE - ((offset - 1) % BLOCK_SIZE);
        if block_left < 5 {
            continue;
        }

        // Need four operand bytes; if truncated, copy the tail verbatim.
        if i + 4 > n {
            while i < n {
                out[offset] = buf[i];
                i += 1;
                offset += 1;
            }
            break;
        }

        let (mut b0, mut b1, mut b2, mut b3) = (buf[i], buf[i + 1], buf[i + 2], buf[i + 3]);
        i += 4;
        offset += 4;

        if b3 == 0x00 || b3 == 0xff {
            let addr = (offset as u32) & 0x00ff_ffff;
            let mut rel = (b0 as u32) | ((b1 as u32) << 8) | ((b2 as u32) << 16);
            rel = rel.wrapping_sub(addr);
            b0 = rel as u8;
            b1 = (rel >> 8) as u8;
            b2 = (rel >> 16) as u8;
            if flip_high_byte && (rel & 0x0080_0000) != 0 {
                b3 = !b3;
            }
        }

        out[offset - 4] = b0;
        out[offset - 3] = b1;
        out[offset - 2] = b2;
        out[offset - 1] = b3;
    }

    out.truncate(offset);
    out
}

/// Recover the embedded `app/QA40x.exe` bytes from a QuantAsylum Inno Setup 6
/// installer image, byte-identical to what `innoextract -s` produces.
///
/// Pure Rust: locates the loader `data_offset`, decodes the first data chunk's
/// raw LZMA2 stream, and reverses Inno's x86 filter. Returns a descriptive
/// error (never panics) if the input does not look like the expected installer.
pub fn extract_qa40x_exe(setup: &[u8]) -> Result<Vec<u8>, String> {
    let data_offset = find_data_offset(setup)?;

    // Chunk = [magic 4][inno lzma2 dict-prop byte 1][raw LZMA2 stream ...].
    let stream_start = data_offset + CHUNK_MAGIC.len() + 1;
    let stream = setup
        .get(stream_start..)
        .ok_or("data chunk is truncated (no LZMA2 stream)")?;

    // Decode the raw LZMA2 stream. Its embedded end marker stops decoding at the
    // chunk boundary, so the trailing bytes of the file are simply ignored.
    let mut reader = Cursor::new(stream);
    let mut decompressed = Vec::new();
    lzma_rs::lzma2_decompress(&mut reader, &mut decompressed)
        .map_err(|e| format!("LZMA2 decompression of the data chunk failed: {e}"))?;

    // Undo the x86/BCJ filter (Inno 6.0.0 uses the 5.3.9+ flip-high-byte form).
    let exe = inno_exe_decode_5200(&decompressed, true);

    // Sanity: the recovered payload must be a PE ("MZ").
    if exe.len() < 2 || &exe[0..2] != b"MZ" {
        return Err(
            "recovered payload is not a PE executable — the installer layout is not the \
             expected QuantAsylum Inno Setup 6 single-file form"
                .to_string(),
        );
    }
    Ok(exe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(bytes);
        h.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Full pipeline against the real fixture installer. Guarded so it is
    /// skipped when the (git-ignored, local-only) fixtures are not present.
    /// Point `QA40X_SETUP_FIXTURE` at a QuantAsylum `setup_1.200.exe`, and
    /// optionally `QA40X_EXE_REFERENCE` at the `QA40x.exe` extracted from it
    /// by `innoextract -s`.
    #[test]
    fn extracts_qa40x_exe_byte_identical() {
        // Reference produced by `innoextract -s` (the truth we must match).
        const REF_SHA256: &str =
            "a679157213ff4f4b009c9588e9c602076de1e273c29e8a3835c8366fa0f3ce57";
        let Ok(setup_path) = std::env::var("QA40X_SETUP_FIXTURE") else {
            eprintln!("skipping: QA40X_SETUP_FIXTURE not set (fixture installer)");
            return;
        };
        if !Path::new(&setup_path).exists() {
            eprintln!("skipping: fixture installer not present at {setup_path}");
            return;
        }
        let setup = std::fs::read(&setup_path).expect("fixture readable");
        let exe = extract_qa40x_exe(&setup).expect("pure-Rust extraction succeeds");
        assert_eq!(exe.len(), 5_256_744, "unexpected QA40x.exe length");
        assert_eq!(
            sha256_hex(&exe),
            REF_SHA256,
            "recovered QA40x.exe must be byte-identical to innoextract's output"
        );

        // And the reference file itself, if present, must match bit-for-bit.
        if let Ok(ref_path) = std::env::var("QA40X_EXE_REFERENCE") {
            if Path::new(&ref_path).exists() {
                let reference = std::fs::read(&ref_path).expect("reference readable");
                assert_eq!(exe, reference, "byte-for-byte mismatch vs innoextract output");
            }
        }
    }

    #[test]
    fn rejects_non_installer() {
        let junk = vec![0u8; 4096];
        let err = extract_qa40x_exe(&junk).unwrap_err();
        assert!(err.contains("loader signature"), "unexpected error: {err}");
    }
}
