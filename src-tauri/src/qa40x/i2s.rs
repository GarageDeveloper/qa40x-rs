//! Front-panel I2S wire vocabulary (issue #71).
//!
//! The QA40x front panel exposes an I2S expansion port with its own bulk
//! endpoint pair (`0x03` OUT / `0x83` IN). Everything here is the pure,
//! device-free half of that protocol: frame widths, block geometry, and the
//! f32 → wire encoding. The paced writer lives in [`crate::device::i2s`].
//!
//! Wire facts confirmed from USB captures of the vendor app (see
//! `doc/device-notes.md` §10): `I2S_WIDTH` (0x0B) takes 0x00 (16-bit) or
//! 0x40 (32-bit); blocks are 2048 interleaved stereo frames (16 KiB in
//! 32-bit mode, 8 KiB in 16-bit), accepted by the device at the I2S rate.

use serde::{Deserialize, Serialize};

/// The I2S port's sample rate. The vendor app always generates I2S at
/// 48 kHz regardless of the acquisition rate (every capture we hold paces
/// EP 0x03 at one 2048-frame block per ~42.7 ms), so the port is pinned
/// here and the I2S mix is rendered at this rate — never resampled from an
/// acquisition-rate buffer. Whether the hardware port clock follows
/// register 0x09 at all is an open question (`doc/device-notes.md` §12).
pub const I2S_RATE_HZ: u32 = 48_000;

/// Frames per EP 0x03 block — wire-confirmed (every observed vendor block
/// is exactly 2048 frames).
pub const I2S_BLOCK_FRAMES: usize = 2048;

/// Whether EP 0x03 frames carry the RIGHT sample first, like the DAC
/// path's `encode_stereo` (L/R are swapped on the wire on EP 0x02).
///
/// UNVALIDATED: every I2S block in our captures is silence, so the channel
/// order is not observable; this assumes the port shares the acquisition
/// path's convention. Deliberately a single flippable constant — if
/// hardware validation (scope on the port, tone on one channel) shows the
/// opposite order, flip this and the `channel_order_is_pinned` test.
pub const I2S_WIRE_SWAP: bool = true;

/// I2S frame width — the two encodings register 0x0B accepts. The vendor
/// app was only ever observed writing 32-bit (0x40); 16-bit is kept in the
/// type (and unit-tested) but not exposed in the UI.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub enum I2sWidth {
    Bits16,
    Bits32,
}

impl I2sWidth {
    /// The value to write to `I2S_WIDTH` (0x0B).
    pub fn register_value(&self) -> u32 {
        match self {
            Self::Bits16 => 0x00,
            Self::Bits32 => 0x40,
        }
    }

    /// Bytes per interleaved stereo frame (two samples).
    pub fn bytes_per_frame(&self) -> usize {
        match self {
            Self::Bits16 => 4,
            Self::Bits32 => 8,
        }
    }

    /// Bytes per EP 0x03 block ([`I2S_BLOCK_FRAMES`] frames).
    pub fn block_bytes(&self) -> usize {
        I2S_BLOCK_FRAMES * self.bytes_per_frame()
    }

    pub fn bits(&self) -> u8 {
        match self {
            Self::Bits16 => 16,
            Self::Bits32 => 32,
        }
    }

    pub fn from_bits(bits: u8) -> Option<Self> {
        match bits {
            16 => Some(Self::Bits16),
            32 => Some(Self::Bits32),
            _ => None,
        }
    }
}

/// Encode stereo f32 samples (±1.0 digital full scale) into the interleaved
/// little-endian I2S byte stream. Samples are clamped to ±1.0 — the port
/// would clip there anyway, and the mix scaler has already reported the
/// clip. Channel order follows [`I2S_WIRE_SWAP`].
pub fn encode_i2s_frames(left: &[f32], right: &[f32], width: I2sWidth) -> Vec<u8> {
    let n = left.len().min(right.len());
    let mut buf = Vec::with_capacity(n * width.bytes_per_frame());
    for i in 0..n {
        let (a, b) = if I2S_WIRE_SWAP {
            (right[i], left[i])
        } else {
            (left[i], right[i])
        };
        match width {
            I2sWidth::Bits32 => {
                const FS: f32 = 2_147_483_647.0; // 2^31 - 1
                buf.extend_from_slice(&((a.clamp(-1.0, 1.0) * FS) as i32).to_le_bytes());
                buf.extend_from_slice(&((b.clamp(-1.0, 1.0) * FS) as i32).to_le_bytes());
            }
            I2sWidth::Bits16 => {
                const FS: f32 = 32_767.0; // 2^15 - 1
                buf.extend_from_slice(&((a.clamp(-1.0, 1.0) * FS) as i16).to_le_bytes());
                buf.extend_from_slice(&((b.clamp(-1.0, 1.0) * FS) as i16).to_le_bytes());
            }
        }
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_geometry_matches_the_wire_captures() {
        // 2048 frames × 8 bytes = 16384 (32-bit) and × 4 = 8192 (16-bit) —
        // the exact EP 0x03 block sizes observed from the vendor app.
        assert_eq!(I2sWidth::Bits32.block_bytes(), 16384);
        assert_eq!(I2sWidth::Bits16.block_bytes(), 8192);
    }

    #[test]
    fn register_values_match_the_observed_writes() {
        assert_eq!(I2sWidth::Bits32.register_value(), 0x40);
        assert_eq!(I2sWidth::Bits16.register_value(), 0x00);
        assert_eq!(I2sWidth::from_bits(32), Some(I2sWidth::Bits32));
        assert_eq!(I2sWidth::from_bits(16), Some(I2sWidth::Bits16));
        assert_eq!(I2sWidth::from_bits(24), None);
    }

    #[test]
    fn silence_encodes_to_zeros_in_both_widths() {
        for w in [I2sWidth::Bits16, I2sWidth::Bits32] {
            let bytes = encode_i2s_frames(&[0.0; 8], &[0.0; 8], w);
            assert_eq!(bytes.len(), 8 * w.bytes_per_frame());
            assert!(bytes.iter().all(|&b| b == 0));
        }
    }

    #[test]
    fn samples_beyond_full_scale_are_clamped() {
        let bytes = encode_i2s_frames(&[2.0], &[-2.0], I2sWidth::Bits32);
        let a = i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        let b = i32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        // Wire order per I2S_WIRE_SWAP: right first. The f32 FS constant
        // rounds 2^31−1 up to 2^31 (not representable in f32), so −1.0
        // saturates to i32::MIN and +1.0 to i32::MAX — the same one-LSB
        // asymmetry as the DAC path's encode_stereo.
        assert_eq!(a, i32::MIN); // right = -2.0 clamped
        assert_eq!(b, i32::MAX); // left = 2.0 clamped
    }

    #[test]
    fn channel_order_is_pinned_against_the_wire_swap_constant() {
        // Flipping I2S_WIRE_SWAP must fail THIS test — loudly and
        // intentionally, because it changes what plays on each I2S channel.
        assert!(I2S_WIRE_SWAP, "channel order changed: revalidate on hardware and update this pin");
        let bytes = encode_i2s_frames(&[0.5], &[-0.5], I2sWidth::Bits16);
        let first = i16::from_le_bytes([bytes[0], bytes[1]]);
        assert!(first < 0, "right sample (-0.5) must ride first on the wire");
    }

    #[test]
    fn frame_count_is_the_shorter_channel() {
        let bytes = encode_i2s_frames(&[0.0; 4], &[0.0; 2], I2sWidth::Bits32);
        assert_eq!(bytes.len(), 2 * 8);
    }
}
