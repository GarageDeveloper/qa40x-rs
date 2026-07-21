//! Firmware flashing over the NXP MCUBOOT/KBOOT USB-HID bootloader (Phase 3).
//!
//! This module currently implements the **DRY-RUN** only: it builds the exact
//! byte sequence a real flash would send, so it can be validated (against the
//! user's own USB capture and the recovered wire image) with **zero device
//! risk**. The real device path is deliberately NOT wired here and will always
//! require explicit user confirmation — nothing is ever flashed automatically.
//!
//! Ground truth (from the user's USB captures of the official app):
//!   1. Enter the bootloader by writing register 0x0F = 0xDEADBEEF then
//!      0xCAFEBABE (5-byte reg-bus writes: [0x0F][value big-endian]). The device
//!      resets and re-enumerates as the NXP bootloader (VID 0x1FC9, PID 0x0022).
//!   2. Over USB-HID, send the KBOOT `ReceiveSbFile` (0x08) command, then stream
//!      the SB image. HID reports are 64 bytes: [reportId][0x00][len:2 LE][data]
//!      then zero padding. Data reports declare 28 payload bytes each; a
//!      52724-byte image is exactly 1883 data reports (1883 × 28 = 52724), and the
//!      capture shows 1884 OUT transfers (1 command + 1883 data) of ~60-64 bytes.
//!   3. The image on the wire differs from the embedded image by two zeroed
//!      bytes at `size − 4` (the first two of the final 4-byte trailer) —
//!      observed by diffing the captured wire image against the embedded one.
//!
//! The HID framing here is CONFIRMED against NXP's reference implementations:
//!   - report framing `[report_id][0x00][len:2 LE][payload][zero-pad]` and report
//!     ids 1=cmd-out / 2=data-out / 3=cmd-in / 4=data-in  (pyMBoot `_encode_report`,
//!     `pack('<2BH', report_id, 0, data_len)`);
//!   - command packet `[tag][flags][reserved][paramCount][params u32 LE]`, tag
//!     0x08 = ReceiveSBFile; generic response tag 0xA0 with status (u32 LE) right
//!     after the 4-byte header  (spsdk `commands.py`).
//!
//! The capture cross-checks the shape (60-byte reports, 1 command + 1883 data OUT,
//! 2 IN responses). What is NOT yet byte-verified: the response payload CONTENT
//! (the format is standard — status 0 == success) — validated on the first flash.

use serde::Serialize;
use sha2::{Digest, Sha256};

/// KBOOT HID report size in bytes (report id + reserved + 2-byte length + data,
/// then zero padding). Confirmed = 60: the new capture shows the OUT transfers on
/// EP 0x02 (1 command + 1883 data) and the IN responses on EP 0x81 are all
/// data_len = 60. (The report PAYLOADS still weren't captured, so the intra-report
/// framing remains per the documented KBOOT spec.)
const HID_REPORT_SIZE: usize = 60;
/// Payload bytes DECLARED per data report. Confirmed by the byte-count math
/// (1883 × 28 = 52724), independent of the report size — the report is padded.
const HID_DATA_PAYLOAD: usize = 28;
/// KBOOT command tag for ReceiveSbFile.
const CMD_RECEIVE_SB_FILE: u8 = 0x08;

/// The two bootloader-entry register writes, as they appear on the reg bus
/// ([0x0F][value big-endian]). Documented here so the dry-run can surface them.
pub const BOOTLOADER_MAGIC_1: u32 = 0xDEAD_BEEF;
pub const BOOTLOADER_MAGIC_2: u32 = 0xCAFE_BABE;

/// Zero the 2-byte marker at `size − 4` to match the image seen on the wire.
/// Idempotent (safe to call on an already-wire image). This reproduces a
/// difference observed between the captured wire image and the embedded one
/// (embedded 0x90 0xCE → wire 0x00 0x00 at offset size−4 for the 52724-byte
/// image).
pub fn to_wire_image(image: &[u8]) -> Vec<u8> {
    let mut v = image.to_vec();
    let n = v.len();
    if n >= 4 {
        v[n - 4] = 0;
        v[n - 3] = 0;
    }
    v
}

/// One HID report (`HID_REPORT_SIZE` = 60 bytes).
pub type Report = [u8; HID_REPORT_SIZE];

fn frame_report(report_id: u8, packet: &[u8]) -> Report {
    let mut r = [0u8; HID_REPORT_SIZE];
    r[0] = report_id;
    r[1] = 0x00;
    let len = packet.len().min(HID_DATA_PAYLOAD) as u16;
    r[2] = (len & 0xff) as u8;
    r[3] = (len >> 8) as u8;
    r[4..4 + len as usize].copy_from_slice(&packet[..len as usize]);
    r
}

/// The ReceiveSbFile command report (report id 1): a command packet
/// [tag][flags=0][reserved=0][paramCount=1][param0 = byte count u32 LE].
fn command_report(byte_count: u32) -> Report {
    let mut pkt = Vec::with_capacity(8);
    pkt.push(CMD_RECEIVE_SB_FILE);
    pkt.push(0x00); // flags
    pkt.push(0x00); // reserved
    pkt.push(0x01); // paramCount
    pkt.extend_from_slice(&byte_count.to_le_bytes());
    frame_report(0x01, &pkt)
}

/// The full byte plan a real flash would send.
pub struct FlashPlan {
    /// The image with the size−4 marker zeroed (what actually goes on the wire).
    pub wire_image: Vec<u8>,
    /// The ReceiveSbFile command report (report id 1).
    pub command: Report,
    /// The data reports (report id 2), 28 payload bytes each.
    pub data_reports: Vec<Report>,
}

/// Build the flash plan from an extracted (embedded) SB image.
pub fn build_flash_plan(embedded_image: &[u8]) -> FlashPlan {
    let wire = to_wire_image(embedded_image);
    let command = command_report(wire.len() as u32);
    let data_reports = wire.chunks(HID_DATA_PAYLOAD).map(|c| frame_report(0x02, c)).collect();
    FlashPlan { wire_image: wire, command, data_reports }
}

/// Reconstitute the image from the data-report payloads — used to validate that
/// the reports faithfully carry the wire image.
pub fn reconstitute(plan: &FlashPlan) -> Vec<u8> {
    let mut out = Vec::with_capacity(plan.wire_image.len());
    for r in &plan.data_reports {
        let len = u16::from_le_bytes([r[2], r[3]]) as usize;
        out.extend_from_slice(&r[4..4 + len]);
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in d {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

/// A human/UI-facing summary of the dry-run for one image (no device touched).
#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DryRun {
    pub wire_sha256: String,
    pub total_bytes: usize,
    pub data_report_count: usize,
    pub data_payload_bytes: usize,
    pub hid_report_size: usize,
    /// The two 0x0F register writes that enter the bootloader (5 bytes each).
    pub bootloader_entry_hex: [String; 2],
    pub command_report_hex: String,
    pub first_data_report_hex: String,
    pub last_data_report_hex: String,
    /// Data reports concatenated == the wire image (framing carries it exactly).
    pub reconstitutes_ok: bool,
}

/// Build the dry-run summary from an extracted (embedded) image.
pub fn dry_run(embedded_image: &[u8]) -> DryRun {
    let plan = build_flash_plan(embedded_image);
    let reconstituted = reconstitute(&plan);
    let entry = |v: u32| {
        let mut b = vec![0x0Fu8];
        b.extend_from_slice(&v.to_be_bytes());
        hex(&b)
    };
    DryRun {
        wire_sha256: sha256_hex(&plan.wire_image),
        total_bytes: plan.wire_image.len(),
        data_report_count: plan.data_reports.len(),
        data_payload_bytes: HID_DATA_PAYLOAD,
        hid_report_size: HID_REPORT_SIZE,
        bootloader_entry_hex: [entry(BOOTLOADER_MAGIC_1), entry(BOOTLOADER_MAGIC_2)],
        command_report_hex: hex(&plan.command),
        first_data_report_hex: plan.data_reports.first().map(|r| hex(r)).unwrap_or_default(),
        last_data_report_hex: plan.data_reports.last().map(|r| hex(r)).unwrap_or_default(),
        reconstitutes_ok: reconstituted == plan.wire_image,
    }
}

/* ------------------------------------------------------------------ */
/* Real device path (NXP KBOOT USB-HID). Touches hardware — callers MUST */
/* gate on the connected model + a valid signature and require explicit  */
/* confirmation. Never call this automatically.                          */
/* ------------------------------------------------------------------ */

/// NXP MCUBOOT/KBOOT bootloader USB ids (the QA40x re-enumerates as this).
pub const NXP_VID: u16 = 0x1FC9;
pub const NXP_PID: u16 = 0x0022;

/// Locate a KBOOT generic-response's kStatus (u32 LE). The generic response has
/// tag 0xA0 followed by [flags][reserved][paramCount][status:4][cmdTag:4]; we
/// find the tag defensively (report id / framing may or may not be present).
fn parse_status(report: &[u8]) -> Option<u32> {
    let pos = report.iter().position(|&b| b == 0xA0)?;
    let s = pos + 4; // tag, flags, reserved, paramCount
    (s + 4 <= report.len())
        .then(|| u32::from_le_bytes([report[s], report[s + 1], report[s + 2], report[s + 3]]))
}

/// Wait (up to `timeout`) for the NXP bootloader to enumerate, then send the
/// `ReceiveSbFile` command and stream the image, reporting progress. Returns Ok
/// only on kStatus_Success. The bytes sent are exactly what the dry-run built &
/// validated; the HID transport follows the documented NXP KBOOT protocol.
pub fn flash_via_hid(
    plan: &FlashPlan,
    timeout: std::time::Duration,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<(), String> {
    use std::time::Instant;
    // Create ONE HidApi for the whole flash and keep it alive. Recreating it per
    // poll iteration (the old bug) churns hid_init/hid_exit and rebuilds the macOS
    // IOHIDManager attached to the thread's CFRunLoop over and over — an
    // intermittent corruption that crashes with a PAC trap in CFRunLoopAddSource.
    // Poll for the newly-attached bootloader with refresh_devices() instead.
    let mut api = hidapi::HidApi::new().map_err(|e| format!("HID init failed: {e}"))?;
    let deadline = Instant::now() + timeout;
    let dev = loop {
        match api.open(NXP_VID, NXP_PID) {
            Ok(d) => break d,
            Err(_) if Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let _ = api.refresh_devices();
            }
            Err(_) => {
                // Present-but-unopenable means a permission problem (e.g. no
                // udev rule for the bootloader's hidraw node on Linux), not a
                // device that never re-enumerated — say so.
                let present = api
                    .device_list()
                    .any(|d| d.vendor_id() == NXP_VID && d.product_id() == NXP_PID);
                return Err(if present {
                    let hint = if cfg!(target_os = "linux") {
                        " This usually means missing permissions on its hidraw device node: add the 1fc9:0022 udev rules from 99-qa40x.rules, reload udev, then power-cycle the analyzer and retry."
                    } else {
                        " Another application may be holding the device open — close it, power-cycle the analyzer and retry."
                    };
                    format!(
                        "The NXP bootloader ({NXP_VID:04x}:{NXP_PID:04x}) enumerated but could not be opened — flash aborted (nothing was written).{hint}"
                    )
                } else {
                    format!(
                        "The device did not switch to the NXP bootloader ({NXP_VID:04x}:{NXP_PID:04x}) in time — flash aborted (nothing was written)."
                    )
                });
            }
        }
    };

    // Command: ReceiveSbFile with the byte count.
    dev.write(&plan.command)
        .map_err(|e| format!("HID write (command) failed: {e}"))?;

    // Optional early response: if the target rejects the command, stop now.
    let mut resp = [0u8; 64];
    if let Ok(n) = dev.read_timeout(&mut resp, 1500) {
        if let Some(status) = parse_status(&resp[..n]) {
            if status != 0 {
                return Err(format!("Bootloader rejected the command (status 0x{status:08x})."));
            }
        }
    }

    // Stream the data reports (28 payload bytes each), reporting progress.
    let total = plan.wire_image.len();
    let mut sent = 0usize;
    for (i, r) in plan.data_reports.iter().enumerate() {
        dev.write(r)
            .map_err(|e| format!("HID write (data report {i}/{}) failed: {e}", plan.data_reports.len()))?;
        sent += u16::from_le_bytes([r[2], r[3]]) as usize;
        on_progress(sent, total);
    }

    // Final response — expect kStatus_Success (0).
    let mut end = [0u8; 64];
    let n = dev
        .read_timeout(&mut end, 8000)
        .map_err(|e| format!("HID read (final response) failed: {e}"))?;
    if n == 0 {
        return Err("No final response from the bootloader — flash status unknown; verify the unit.".into());
    }
    match parse_status(&end[..n]) {
        Some(0) => Ok(()),
        Some(s) => Err(format!("Flash reported failure — bootloader status 0x{s:08x}.")),
        None => Err(format!("Unrecognised bootloader response: {}", hex(&end[..n]))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn zeroes_two_bytes_at_size_minus_four() {
        let img = vec![0xAAu8; 100];
        let wire = to_wire_image(&img);
        assert_eq!(wire[96], 0x00, "size-4 zeroed");
        assert_eq!(wire[97], 0x00, "size-3 zeroed");
        assert_eq!(wire[98], 0xAA, "size-2 untouched");
        assert_eq!(wire[99], 0xAA, "size-1 untouched");
    }

    #[test]
    fn image_chunks_into_exact_reports_and_reconstitutes() {
        // 52724 B → 1883 data reports of 28 bytes, no remainder.
        let img = vec![0x5Au8; 52724];
        let plan = build_flash_plan(&img);
        assert_eq!(plan.data_reports.len(), 1883);
        assert_eq!(1883 * HID_DATA_PAYLOAD, 52724);
        for r in &plan.data_reports {
            assert_eq!(u16::from_le_bytes([r[2], r[3]]) as usize, HID_DATA_PAYLOAD);
        }
        assert_eq!(reconstitute(&plan), plan.wire_image);
    }

    #[test]
    fn receive_sb_file_command_encodes_byte_count() {
        let plan = build_flash_plan(&vec![0u8; 52724]);
        // report: [01][00][len=8 00][08 00 00 01][F4 CD 00 00]
        assert_eq!(&plan.command[0..4], &[0x01, 0x00, 0x08, 0x00]);
        assert_eq!(&plan.command[4..8], &[CMD_RECEIVE_SB_FILE, 0x00, 0x00, 0x01]);
        assert_eq!(&plan.command[8..12], &52724u32.to_le_bytes()); // 0xCDF4 LE
    }

    #[test]
    fn real_wire_image_validates() {
        // firmwares/qa40x-firmware-v58.sb is the actual wire image recovered from
        // the capture: already zeroed, 52724 B. The plan must carry it exactly.
        let p = Path::new("../firmwares/qa40x-firmware-v58.sb");
        if !p.exists() {
            eprintln!("fixture absent, skipping");
            return;
        }
        let wire = std::fs::read(p).unwrap();
        assert_eq!(wire.len(), 52724);
        // to_wire is idempotent on an already-wire image.
        assert_eq!(to_wire_image(&wire), wire);
        let d = dry_run(&wire);
        assert!(d.reconstitutes_ok, "data reports must reconstitute the wire image");
        assert_eq!(d.wire_sha256, sha256_hex(&wire));
        assert_eq!(d.data_report_count, 1883);
        assert_eq!(d.total_bytes, 52724);
        assert_eq!(d.bootloader_entry_hex[0], "0fdeadbeef");
        assert_eq!(d.bootloader_entry_hex[1], "0fcafebabe");
    }
}
