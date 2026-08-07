/// QA40x register addresses
/// Based on the PyQa40x implementation, the bare-metal interface, and our own
/// USB-traffic observations.
pub mod registers {
    /// Link / comm-test register. Write a pattern and read it back unchanged; the
    /// official app writes it (~1 s) as a keepalive that holds the LINK LED lit.
    pub const LINK_KEEPALIVE: u8 = 0x00;

    /// Front-panel I2S stream control: write 1 to start the I2S generation
    /// stream (samples then flow on bulk EP 0x03), 0 to stop it. Identified
    /// from a USB capture of the official app's I2S feature — the `= 0` write
    /// every host performs early in the connect sequence is simply "I2S off",
    /// part of putting the unit in a defined state.
    pub const I2S_CTRL: u8 = 0x0A;

    /// Front-panel I2S frame width, written just before `I2S_CTRL = 1`.
    /// Observed values: 0x00 = 16-bit frames, 0x40 = 32-bit frames.
    pub const I2S_WIDTH: u8 = 0x0B;

    /// Input gain register
    pub const INPUT_GAIN: u8 = 5;

    /// Output gain register
    pub const OUTPUT_GAIN: u8 = 6;

    /// Sample rate register
    pub const SAMPLE_RATE: u8 = 9;

    /// Bootloader-entry trigger. Write 0xDEADBEEF then 0xCAFEBABE to reset the
    /// device into its NXP DFU bootloader (for firmware flashing). DEVICE-MUTATING.
    pub const BOOTLOADER_ENTRY: u8 = 0x0F;

    /// Firmware version register (read-only). Returns the firmware build number
    /// as a u32 (e.g. 60). Confirmed on hardware by a read-only register scan —
    /// this is the value the QuantAsylum app shows as the firmware version.
    pub const FIRMWARE_VERSION: u8 = 0x10;

    /// Live hardware telemetry (read-only), matching the official app's readout:
    /// USB Voltage / USB Current / ISO Current / Temperature. Decoding validated
    /// on hardware. Reads are non-destructive.
    pub const TELEM_USB_VOLTAGE: u8 = 0x11; // millivolts
    pub const TELEM_USB_CURRENT: u8 = 0x12; // milliamps
    pub const TELEM_ISO_CURRENT: u8 = 0x13; // milliamps
    /// Byte length of the firmware trace buffer (0x418 observed on a QA402),
    /// read out via [`TRACE_READ`] after `PAGE_SELECT = 1`. Not telemetry —
    /// long misfiled as "TELEM_EXTRA" until a capture of the official app's
    /// "Query Hardware for Firmware State" feature pinned it down.
    pub const TRACE_LEN: u8 = 0x15;

    /// Firmware trace buffer readout: each read returns the next 4 bytes,
    /// like [`CALIBRATION`] but for the trace selected by `PAGE_SELECT = 1`.
    /// A healthy unit answers all zeros.
    pub const TRACE_READ: u8 = 0x14;
    pub const TELEM_TEMPERATURE: u8 = 0x16; // deci-degrees Celsius (÷10)

    /// Capability/feature word (read-only, constant). Both a real QA402 and
    /// a real QA403 (fw 60) answer 0x40000040 — the word is identical across
    /// models, so it does not discriminate them.
    pub const CAPABILITY: u8 = 0x1B;

    /// Second capability-style word (read-only, constant), differing per
    /// model: 0x02A35B03 on a real QA402, 0x7F31BD30 on a real QA403
    /// (both confirmed on hardware).
    pub const CAPABILITY2: u8 = 0x1C;

    /// Serial-number register (read-only). Returns the unit serial packed as a
    /// u32 (e.g. 0xAB12CD34 → "AB12_CD34"); matches the USB serial string.
    pub const SERIAL_NUMBER: u8 = 0x1D;

    /// Stream status probe: the official app reads it between a stream stop
    /// and restart. Semantics beyond that use are not settled.
    pub const STREAM_STATUS: u8 = 0x1E;

    /// Streaming control register. Start/stop an acquisition by writing the
    /// two values below. These match the public PyQa40x reference
    /// (`stream.py`: `write(8, 0x05)` to start, `write(8, 0x00)` to stop).
    pub const STREAM_CTRL: u8 = 8;

    /// Start an acquisition (`0x05`), per PyQa40x.
    pub const STREAM_START: u32 = 0x05;
    /// Stop the acquisition (`0x00`), per PyQa40x.
    pub const STREAM_STOP: u32 = 0x00;

    /// Page selector for sequential readout, and every write resets the read
    /// pointer. `0x10 + 2*page` selects a flash page read via [`CALIBRATION`]
    /// (page 0 is the factory calibration page; pages 1..=3 read as zeros on
    /// a real unit); `1` selects the firmware trace buffer read via
    /// [`TRACE_READ`].
    pub const PAGE_SELECT: u8 = 0x0D;

    /// Calibration data readout. Read repeatedly; each read returns the next
    /// 4 bytes (little-endian) of the 512-byte calibration page.
    pub const CALIBRATION: u8 = 0x19;
}

use async_trait::async_trait;

/// Register operations
#[async_trait]
pub trait RegisterOps {
    async fn read_register(&self, address: u8) -> crate::qa40x::Result<Vec<u8>>;
    async fn write_register(&self, address: u8, data: &[u8]) -> crate::qa40x::Result<()>;
}
