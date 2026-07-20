use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// QA40x USB Vendor ID (shared by the family) and per-model Product IDs.
/// Confirmed against the vendor's PyQa40x (openByVendorIDAndProductID):
/// QA402 = 0x4E37, QA403 = 0x4E39.
pub const QA40X_VID: u16 = 0x16C0;
pub const QA402_PID: u16 = 0x4E37;
pub const QA403_PID: u16 = 0x4E39;

/// A QuantAsylum analyzer model. The USB protocol is shared across the family;
/// only a few parameters differ (PID, available sample rates, firmware-flash
/// support), so one device implementation is parametrised by this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Model {
    Qa402,
    Qa403,
}

impl Model {
    /// Identify the model from a USB product ID (VID is shared).
    pub fn from_pid(pid: u16) -> Option<Self> {
        match pid {
            QA402_PID => Some(Self::Qa402),
            QA403_PID => Some(Self::Qa403),
            _ => None,
        }
    }

    pub fn pid(&self) -> u16 {
        match self {
            Self::Qa402 => QA402_PID,
            Self::Qa403 => QA403_PID,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Qa402 => "QA402",
            Self::Qa403 => "QA403",
        }
    }

    /// Sample rates the model supports. The QA403 adds 384 kHz.
    pub fn sample_rates(&self) -> &'static [SampleRate] {
        match self {
            Self::Qa402 => &[SampleRate::Rate48kHz, SampleRate::Rate96kHz, SampleRate::Rate192kHz],
            Self::Qa403 => &[
                SampleRate::Rate48kHz,
                SampleRate::Rate96kHz,
                SampleRate::Rate192kHz,
                SampleRate::Rate384kHz,
            ],
        }
    }

    pub fn supports_rate(&self, rate: SampleRate) -> bool {
        self.sample_rates().contains(&rate)
    }

    /// Firmware flashing is only verified for the QA402 — we can't confirm the
    /// QA403's flash transport, so it stays disabled there.
    pub fn supports_flash(&self) -> bool {
        matches!(self, Self::Qa402)
    }

    /// Per-model capabilities, filled when the device is identified. Follows
    /// the same pattern as [`Self::sample_rates`]: code asks the model, it
    /// never hard-codes a limit.
    pub fn capabilities(&self) -> Capabilities {
        // The measurement band derives from what the app already enforces:
        // generator/sweep frequencies are clamped to ≥ 1 Hz and < Nyquist of
        // the configured rate, so the model-wide ceiling is the Nyquist of the
        // fastest supported rate (96 kHz on a QA402, 192 kHz on a QA403).
        let max_rate_hz = self
            .sample_rates()
            .iter()
            .map(|r| r.as_hz())
            .max()
            .unwrap_or(48000);
        // The largest producible level is the largest OUTPUT RANGE: at range R
        // the hottest sine is R dBV RMS (the DAC at full scale), so the ceiling
        // is not a free parameter — it is `OutputGain`'s maximum, which we know
        // from the register map. Derive it rather than quoting a number, so the
        // two can never drift apart.
        let max_range_dbv = OutputGain::ALL
            .iter()
            .map(|g| g.as_dbv())
            .max()
            .expect("OutputGain::ALL is non-empty");
        Capabilities {
            // Floor: a practical "don't ask for less than this" bound, well under
            // the output noise floor. WORKING VALUE pending hardware verification.
            min_output_vrms: 10f64.powf(-120.0 / 20.0), // ≈ 1 µVrms (−120 dBV)
            // Ceiling: derived above — +18 dBV ≈ 7.94 Vrms on the ranges we have
            // verified. Both models expose the same four output ranges as far as
            // we know; if a unit ever differs, give it its own list here.
            max_output_vrms: 10f64.powf(f64::from(max_range_dbv) / 20.0),
            // Max SAFE AC input per QuantAsylum's spec: +32 dBV ≈ 40 Vrms
            // (same for both models; NOT the +42 dBV top input range, which is
            // a full-scale setting, not a voltage rating).
            max_input_vrms: 10f64.powf(32.0 / 20.0), // ≈ 39.8 Vrms (+32 dBV)
            min_measurement_hz: 1.0,
            max_measurement_hz: f64::from(max_rate_hz) / 2.0,
            sample_rate: max_rate_hz,
        }
    }
}

/// Per-model device capabilities — limits code queries instead of assuming.
///
/// NOTE on the output limits: they are **Vrms**. The peak-vs-RMS question
/// that had kept them out of level decisions is settled (task #48, measured
/// on hardware): levels are sine-referenced RMS targets, normalized per
/// waveform in `crate::sources`. The limits are now wired into the
/// auto-level procedure (`crate::measurement`); the dBV *values* below remain
/// working values pending hardware verification.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Capabilities {
    /// Smallest producible output level, in Vrms (working value: −120 dBV).
    pub min_output_vrms: f64,
    /// Largest producible output level, in Vrms: the top of [`OutputGain`]
    /// (+18 dBV ≈ 7.94 Vrms), since at range R the hottest sine is R dBV RMS.
    pub max_output_vrms: f64,
    /// Maximum SAFE AC voltage that may be applied to the analyzer input, in
    /// Vrms. Per QuantAsylum's spec this is +32 dBV ≈ 40 Vrms for both models
    /// (distinct from the +42 dBV top *input range*, which is a full-scale
    /// setting, not a voltage rating). Informational — the app can't enforce
    /// what the user connects; surfaced so the UI can warn.
    pub max_input_vrms: f64,
    /// Lower edge of the measurement band, in Hz (what the app clamps
    /// generator/sweep frequencies to today).
    pub min_measurement_hz: f64,
    /// Upper edge of the measurement band, in Hz: Nyquist of the fastest
    /// supported sample rate.
    pub max_measurement_hz: f64,
    /// Fastest supported sample rate, in Hz (the full list stays in
    /// [`Model::sample_rates`]).
    pub sample_rate: u32,
}

/// USB Endpoint configuration
#[derive(Debug, Clone)]
pub struct UsbEndpoints {
    pub register_write: u8,
    pub register_read: u8,
    pub data_write: u8,
    pub data_read: u8,
}

impl Default for UsbEndpoints {
    fn default() -> Self {
        Self {
            register_write: 0x01,
            register_read: 0x81,
            data_write: 0x02,
            data_read: 0x82,
        }
    }
}

/// Input gain settings in dBV
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, TS)]
#[serde(into = "i32", try_from = "i32")]
#[ts(as = "i32", export, export_to = "InputGain.ts")]
pub enum InputGain {
    Gain0dBV = 0,
    Gain6dBV = 1,
    Gain12dBV = 2,
    Gain18dBV = 3,
    Gain24dBV = 4,
    Gain30dBV = 5,
    Gain36dBV = 6,
    Gain42dBV = 7,
}

impl InputGain {
    pub fn from_dbv(dbv: i32) -> Option<Self> {
        match dbv {
            0 => Some(Self::Gain0dBV),
            6 => Some(Self::Gain6dBV),
            12 => Some(Self::Gain12dBV),
            18 => Some(Self::Gain18dBV),
            24 => Some(Self::Gain24dBV),
            30 => Some(Self::Gain30dBV),
            36 => Some(Self::Gain36dBV),
            42 => Some(Self::Gain42dBV),
            _ => None,
        }
    }

    pub fn as_dbv(&self) -> i32 {
        match self {
            Self::Gain0dBV => 0,
            Self::Gain6dBV => 6,
            Self::Gain12dBV => 12,
            Self::Gain18dBV => 18,
            Self::Gain24dBV => 24,
            Self::Gain30dBV => 30,
            Self::Gain36dBV => 36,
            Self::Gain42dBV => 42,
        }
    }

    pub fn as_register_value(&self) -> u32 {
        *self as u32
    }
}

impl From<InputGain> for i32 {
    fn from(gain: InputGain) -> i32 {
        gain.as_dbv()
    }
}

impl TryFrom<i32> for InputGain {
    type Error = String;

    fn try_from(value: i32) -> Result<Self, Self::Error> {
        Self::from_dbv(value).ok_or_else(|| format!("Invalid input gain: {}", value))
    }
}

/// Output gain settings in dBV
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, TS)]
#[serde(into = "i32", try_from = "i32")]
#[ts(as = "i32", export, export_to = "OutputGain.ts")]
pub enum OutputGain {
    GainMinus12dBV = 0,
    GainMinus2dBV = 1,
    Gain8dBV = 2,
    Gain18dBV = 3,
}

impl OutputGain {
    /// Every output range the hardware exposes, ascending. The register map has
    /// exactly these four; `Model::capabilities` derives the output ceiling from
    /// the last one, so this list is the single source of truth for "how hot can
    /// this device drive".
    pub const ALL: [OutputGain; 4] = [
        OutputGain::GainMinus12dBV,
        OutputGain::GainMinus2dBV,
        OutputGain::Gain8dBV,
        OutputGain::Gain18dBV,
    ];

    pub fn from_dbv(dbv: i32) -> Option<Self> {
        match dbv {
            -12 => Some(Self::GainMinus12dBV),
            -2 => Some(Self::GainMinus2dBV),
            8 => Some(Self::Gain8dBV),
            18 => Some(Self::Gain18dBV),
            _ => None,
        }
    }

    pub fn as_dbv(&self) -> i32 {
        match self {
            Self::GainMinus12dBV => -12,
            Self::GainMinus2dBV => -2,
            Self::Gain8dBV => 8,
            Self::Gain18dBV => 18,
        }
    }

    pub fn as_register_value(&self) -> u32 {
        *self as u32
    }
}

impl From<OutputGain> for i32 {
    fn from(gain: OutputGain) -> i32 {
        gain.as_dbv()
    }
}

impl TryFrom<i32> for OutputGain {
    type Error = String;

    fn try_from(value: i32) -> Result<Self, Self::Error> {
        Self::from_dbv(value).ok_or_else(|| format!("Invalid output gain: {}", value))
    }
}

/// Sample rate settings in Hz
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, TS)]
#[serde(into = "u32", try_from = "u32")]
#[ts(as = "u32", export, export_to = "SampleRate.ts")]
pub enum SampleRate {
    Rate48kHz = 48000,
    Rate96kHz = 96000,
    Rate192kHz = 192000,
    /// QA403 only (register index 3).
    Rate384kHz = 384000,
}

impl SampleRate {
    pub fn from_hz(hz: u32) -> Option<Self> {
        match hz {
            48000 => Some(Self::Rate48kHz),
            96000 => Some(Self::Rate96kHz),
            192000 => Some(Self::Rate192kHz),
            384000 => Some(Self::Rate384kHz),
            _ => None,
        }
    }

    pub fn as_hz(&self) -> u32 {
        *self as u32
    }

    /// Register 9 encodes the sample rate as an index, NOT the Hz value.
    /// Confirmed against PyQa40x, QA40x_BareMetal and ASIO401:
    /// 48k -> 0, 96k -> 1, 192k -> 2 (384k -> 3, QA403 only).
    pub fn as_register_index(&self) -> u32 {
        match self {
            Self::Rate48kHz => 0,
            Self::Rate96kHz => 1,
            Self::Rate192kHz => 2,
            Self::Rate384kHz => 3,
        }
    }

    /// Decode a register-9 read. The device returns the index; older code paths
    /// may still surface the raw Hz value, so accept both forms.
    pub fn from_register_value(value: u32) -> Option<Self> {
        match value {
            0 => Some(Self::Rate48kHz),
            1 => Some(Self::Rate96kHz),
            2 => Some(Self::Rate192kHz),
            3 => Some(Self::Rate384kHz),
            48000 => Some(Self::Rate48kHz),
            96000 => Some(Self::Rate96kHz),
            192000 => Some(Self::Rate192kHz),
            384000 => Some(Self::Rate384kHz),
            _ => None,
        }
    }
}

impl From<SampleRate> for u32 {
    fn from(rate: SampleRate) -> u32 {
        rate.as_hz()
    }
}

impl TryFrom<u32> for SampleRate {
    type Error = String;

    fn try_from(value: u32) -> Result<Self, Self::Error> {
        Self::from_hz(value).ok_or_else(|| format!("Invalid sample rate: {}", value))
    }
}

/// Device configuration
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DeviceConfig {
    pub input_gain: InputGain,
    pub output_gain: OutputGain,
    pub sample_rate: SampleRate,
}

impl Default for DeviceConfig {
    fn default() -> Self {
        Self {
            input_gain: InputGain::Gain6dBV,
            output_gain: OutputGain::Gain8dBV,
            sample_rate: SampleRate::Rate48kHz,
        }
    }
}

/// Audio sample data
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AudioData {
    pub left_channel: Vec<f32>,
    pub right_channel: Vec<f32>,
    pub sample_rate: u32,
}

/// Factory calibration read from the device's 512-byte calibration page.
///
/// The page holds per-full-scale-level dB corrections for each ADC and DAC
/// range, per channel. `linear_*` are the correction factors (10^(dB/20)) for
/// the currently configured input/output full scale.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CalibrationData {
    pub adc_cal_left: f32,
    pub adc_cal_right: f32,
    pub dac_cal_left: f32,
    pub dac_cal_right: f32,
    /// True if a plausible calibration page was parsed from the device.
    pub valid: bool,
}

impl Default for CalibrationData {
    fn default() -> Self {
        Self {
            adc_cal_left: 1.0,
            adc_cal_right: 1.0,
            dac_cal_left: 1.0,
            dac_cal_right: 1.0,
            valid: false,
        }
    }
}

impl CalibrationData {
    /// Convert dB value to linear scale
    pub fn db_to_linear(db: f32) -> f32 {
        10.0_f32.powf(db / 20.0)
    }

    /// Byte offset of the ADC correction record (left channel) for a given
    /// input full-scale dBV, per PyQa40x. Right channel is +6.
    pub fn adc_offset(input_dbv: i32) -> Option<usize> {
        match input_dbv {
            0 => Some(24),
            6 => Some(36),
            12 => Some(48),
            18 => Some(60),
            24 => Some(72),
            30 => Some(84),
            36 => Some(96),
            42 => Some(108),
            _ => None,
        }
    }

    /// Byte offset of the DAC correction record (left channel) for a given
    /// output full-scale dBV, per PyQa40x. Right channel is +6.
    pub fn dac_offset(output_dbv: i32) -> Option<usize> {
        match output_dbv {
            -12 => Some(120),
            -2 => Some(132),
            8 => Some(144),
            18 => Some(156),
            _ => None,
        }
    }
}

/// Audio channel selector
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Channel {
    Left,
    Right,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qa402_capabilities_derive_from_its_rate_list() {
        let caps = Model::Qa402.capabilities();
        assert_eq!(caps.sample_rate, 192_000);
        assert_eq!(caps.max_measurement_hz, 96_000.0); // Nyquist of 192 kHz
        assert_eq!(caps.min_measurement_hz, 1.0);
    }

    #[test]
    fn qa403_capabilities_include_the_384k_rate() {
        let caps = Model::Qa403.capabilities();
        assert_eq!(caps.sample_rate, 384_000);
        assert_eq!(caps.max_measurement_hz, 192_000.0); // Nyquist of 384 kHz
        assert_eq!(caps.min_measurement_hz, 1.0);
    }

    #[test]
    fn the_output_ceiling_is_the_largest_output_range_not_a_quoted_number() {
        for model in [Model::Qa402, Model::Qa403] {
            let caps = model.capabilities();
            // The ceiling must BE the top output range: at range R the hottest
            // sine is R dBV RMS, so anything above it is unproducible. A number
            // quoted independently of `OutputGain` would let auto-level accept a
            // target the hardware cannot reach and then measure a clipped signal
            // instead of refusing.
            assert!((20.0 * caps.max_output_vrms.log10() - 18.0).abs() < 1e-9);
            assert!((caps.max_output_vrms - 7.943_282_347_242_816).abs() < 1e-9);

            // Floor: a working value, round-tripped to guard against unit slips.
            assert!((caps.min_output_vrms - 1e-6).abs() < 1e-12);
            assert!((20.0 * caps.min_output_vrms.log10() - (-120.0)).abs() < 1e-9);
        }
    }

    #[test]
    fn output_ceiling_tracks_the_range_list() {
        // The guard that makes the two impossible to drift apart: whatever the
        // top of `OutputGain::ALL` is, that is the ceiling.
        let top = OutputGain::ALL.iter().map(|g| g.as_dbv()).max().unwrap();
        let caps = Model::Qa402.capabilities();
        assert!((20.0 * caps.max_output_vrms.log10() - f64::from(top)).abs() < 1e-9);
        assert_eq!(top, OutputGain::Gain18dBV.as_dbv());
    }
}
