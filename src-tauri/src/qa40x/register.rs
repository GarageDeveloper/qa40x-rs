/// QA40x register addresses
/// Based on the PyQa40x implementation, the bare-metal interface, and our own
/// USB-traffic observations.
pub mod registers {
    /// Link / comm-test register. Write a pattern and read it back unchanged; the
    /// official app writes it (~1 s) as a keepalive that holds the LINK LED lit.
    pub const LINK_KEEPALIVE: u8 = 0x00;

    /// Unknown register the official app writes `= 0` early on every connect (seen
    /// in every USB capture). Purpose is not
    /// documented — only ever written 0 — so we replay it verbatim to match the
    /// vendor connect sequence, without claiming to know what it does.
    pub const UNKNOWN_INIT_0A: u8 = 0x0A;

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
    pub const TELEM_EXTRA: u8 = 0x15; // logged for decoding; purpose TBD
    pub const TELEM_TEMPERATURE: u8 = 0x16; // deci-degrees Celsius (÷10)

    /// Serial-number register (read-only). Returns the unit serial packed as a
    /// u32 (e.g. 0xAB12CD34 → "AB12_CD34"); matches the USB serial string.
    pub const SERIAL_NUMBER: u8 = 0x1D;

    /// Streaming control register. Start/stop an acquisition by writing the
    /// two values below. These match the public PyQa40x reference
    /// (`stream.py`: `write(8, 0x05)` to start, `write(8, 0x00)` to stop).
    pub const STREAM_CTRL: u8 = 8;

    /// Start an acquisition (`0x05`), per PyQa40x.
    pub const STREAM_START: u32 = 0x05;
    /// Stop the acquisition (`0x00`), per PyQa40x.
    pub const STREAM_STOP: u32 = 0x00;

    /// Calibration page select. Write 0x10 before reading the cal page.
    pub const CAL_PAGE_SELECT: u8 = 0x0D;

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
