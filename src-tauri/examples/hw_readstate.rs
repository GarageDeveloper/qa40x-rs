//! Read-only QA402 state dump — connects and reports the device's CURRENT
//! registers WITHOUT writing input gain, output gain, sample rate, or anything
//! that would change the analog state (no set_*). Use it to see exactly where
//! the hardware sits (e.g. whether the input attenuator is engaged) without the
//! app re-applying persisted preferences.
//!
//! Run with: cargo run --example hw_readstate [--release]
//!
//! The only bytes written are the standard connect handshake (a scratch write to
//! register 0, the same connectivity check the official app performs); it does
//! not touch the gain/range/attenuator registers.

use tauri_app_lib::qa40x::register::{registers, RegisterOps};
use tauri_app_lib::qa40x::QA40xDevice;

/// Registers to skip in the raw scan because a *read* there has side effects or
/// is meaningless: bootloader-entry trigger (0x0F), cal-page select (0x0D), and
/// the cal readout (0x19, which advances an internal page pointer on each read).
const SKIP: &[u8] = &[
    registers::BOOTLOADER_ENTRY,
    registers::CAL_PAGE_SELECT,
    registers::CALIBRATION,
];

fn u32be(bytes: &[u8]) -> Option<u32> {
    if bytes.len() < 4 {
        return None;
    }
    Some(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

#[tokio::main]
async fn main() {
    env_logger::init();

    let device = QA40xDevice::new();
    println!("== Connecting (read-only; no gain/range writes) ==");
    if let Err(e) = device.connect().await {
        eprintln!("connect failed: {e}");
        eprintln!("If the desktop app is open it holds the single connection — close it and retry.");
        std::process::exit(1);
    }

    // --- The direct answer: input / output / rate as the device holds them now.
    println!("\n== Current analog config (as read, nothing forced) ==");
    match device.read_input_gain().await {
        Ok(g) => println!("  INPUT gain (reg 5)  = {} dBV  (register value {})", g.as_dbv(), g.as_register_value()),
        Err(e) => println!("  INPUT gain (reg 5)  = <read error: {e}>"),
    }
    match device.read_output_gain().await {
        Ok(g) => println!("  OUTPUT gain (reg 6) = {} dBV  (register value {})", g.as_dbv(), g.as_register_value()),
        Err(e) => println!("  OUTPUT gain (reg 6) = <read error: {e}>"),
    }
    match device.read_sample_rate().await {
        Ok(r) => println!("  SAMPLE rate (reg 9) = {} Hz", r.as_hz()),
        Err(e) => println!("  SAMPLE rate (reg 9) = <read error: {e}>"),
    }

    // --- Telemetry (non-destructive), plus firmware/serial for context.
    println!("\n== Telemetry / identity ==");
    match device.read_telemetry().await {
        Ok(t) => println!(
            "  USB {:.3} V | temp {:.1} °C | raw V=0x{:08X} temp=0x{:08X}",
            t.usb_voltage_v, t.temperature_c, t.raw_usb_voltage, t.raw_temperature
        ),
        Err(e) => println!("  telemetry: <read error: {e}>"),
    }
    match device.read_register(registers::FIRMWARE_VERSION).await {
        Ok(d) => println!("  firmware version (0x10) = {:?}", u32be(&d)),
        Err(e) => println!("  firmware version (0x10) = <read error: {e}>"),
    }
    match device.read_register(registers::SERIAL_NUMBER).await {
        Ok(d) => println!("  serial (0x1D) = {:?}", u32be(&d).map(|v| format!("0x{v:08X}"))),
        Err(e) => println!("  serial (0x1D) = <read error: {e}>"),
    }

    // --- Full read-only register scan. Dump every readable address so a second
    // run (once the attenuator is cleared) can be diffed to find which register
    // reflects the attenuator state — the missing piece for the annunciator (#10).
    println!("\n== Raw register scan 0x00..0x1F (read-only) ==");
    for addr in 0x00u8..=0x1F {
        if SKIP.contains(&addr) {
            println!("  0x{addr:02X} : <skipped (write/side-effecting)>");
            continue;
        }
        match device.read_register(addr).await {
            Ok(d) => match u32be(&d) {
                Some(v) => println!("  0x{addr:02X} : 0x{v:08X}  ({v})"),
                None => println!("  0x{addr:02X} : <{} bytes: {:02X?}>", d.len(), d),
            },
            Err(e) => println!("  0x{addr:02X} : <read error: {e}>"),
        }
    }

    println!("\n== Done (no analog state was changed) ==");
}
