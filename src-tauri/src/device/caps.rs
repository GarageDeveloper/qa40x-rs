//! The explicit capability record (issue #25 lot B): everything the app used
//! to know implicitly through `Model` (rates, ranges, limits, flash gate),
//! plus where the unit's calibration comes from.
//!
//! Data provenance: **model tables only** (`Model::sample_rates`,
//! `Model::capabilities`, `InputGain::ALL`, `OutputGain::ALL`). The
//! capability registers 0x1B/0x1C the official app reads at connect are NOT
//! consulted — a real QA403's 0x1B word is unverified, and moving the 384 kHz
//! gate onto a register read would change measurement semantics (deferred;
//! see the module doc in [`super`]).

use crate::qa40x::{InputGain, Model, OutputGain};
use serde::{Deserialize, Serialize};

/// Where a unit's level calibration comes from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub enum CalibrationSource {
    /// Not known yet — an enumerated but unopened unit (the factory page is
    /// read during bring-up, so only an open can settle this).
    Unknown,
    /// The factory calibration page was read from flash page 0.
    FactoryEeprom { page_bytes: usize },
    /// The page could not be read; the nominal range model is in use.
    NominalFallback,
    /// User-supplied calibration (no producer in lot B — reserved so #33
    /// agents and sound-card devices, which have no EEPROM, have a variant
    /// to carry).
    User { label: String },
}

/// What a device can do: channels, rates, range tables, limits, calibration
/// source. Replaces implicit `Model` knowledge at the seam; on the wire since
/// lot D (ts-rs export, carried by [`super::wire::DeviceEntry`]) — the
/// frontend reads its range/rate menus from here, not from local consts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct DeviceCapabilities {
    /// Model display name (`"QA402"` / `"QA403"`).
    pub model_name: String,
    /// Analog input channel count (QA40x family: 2).
    pub input_channels: u8,
    /// Analog output channel count (QA40x family: 2).
    pub output_channels: u8,
    /// Supported sample rates in Hz, ascending (384 kHz on the QA403 only).
    pub sample_rates_hz: Vec<u32>,
    /// Input full-scale ranges in dBV, ascending — the backend authority for
    /// the frontend's input-range menu (lot D deleted the TS const).
    pub input_ranges_dbv: Vec<i32>,
    /// Output full-scale ranges in dBV, ascending — ditto for the output menu.
    pub output_ranges_dbv: Vec<i32>,
    /// Smallest producible output level, in Vrms.
    pub min_output_vrms: f64,
    /// Largest producible output level, in Vrms (top output range).
    pub max_output_vrms: f64,
    /// Maximum SAFE AC input, in Vrms (informational — see `Capabilities`).
    pub max_input_vrms: f64,
    /// Lower edge of the measurement band, in Hz.
    pub min_measurement_hz: f64,
    /// Upper edge of the measurement band, in Hz (Nyquist of the fastest rate).
    pub max_measurement_hz: f64,
    /// Where level calibration comes from.
    pub calibration: CalibrationSource,
    /// Whether firmware flashing is supported (QA402 only, never virtual).
    pub supports_flash: bool,
    /// Whether the front-panel I2S output port is drivable (issue #71).
    /// From the model table at enumerate time (the whole family has the
    /// port); refined at open with [`Self::with_i2s`] to the honest
    /// post-claim value (EP 0x03 claimed or not).
    pub supports_i2s: bool,
    /// True for the embedded simulator.
    pub is_virtual: bool,
}

impl DeviceCapabilities {
    /// Everything knowable from the model alone — available at ENUMERATE
    /// time, before any device I/O (what lot D's device bar lists).
    /// `calibration` starts [`CalibrationSource::Unknown`]; fill it at open
    /// with [`Self::with_calibration`].
    pub fn for_model(model: Model, is_virtual: bool) -> Self {
        let limits = model.capabilities();
        Self {
            model_name: model.name().to_string(),
            input_channels: 2,
            output_channels: 2,
            sample_rates_hz: model.sample_rates().iter().map(|r| r.as_hz()).collect(),
            input_ranges_dbv: InputGain::ALL.iter().map(|g| g.as_dbv()).collect(),
            output_ranges_dbv: OutputGain::ALL.iter().map(|g| g.as_dbv()).collect(),
            min_output_vrms: limits.min_output_vrms,
            max_output_vrms: limits.max_output_vrms,
            max_input_vrms: limits.max_input_vrms,
            min_measurement_hz: limits.min_measurement_hz,
            max_measurement_hz: limits.max_measurement_hz,
            calibration: CalibrationSource::Unknown,
            // Never offer a flash to the simulator (same rule as DeviceMeta):
            // the demo must not exercise the DFU/HID path the fake bootloader
            // can't complete in-process.
            supports_flash: model.supports_flash() && !is_virtual,
            // Every QA40x model has the front-panel port; the embedded
            // simulator emulates its EP3 sink since vqa40x-core v0.5.0.
            supports_i2s: true,
            is_virtual,
        }
    }

    /// Fill the calibration source once the unit is open.
    pub fn with_calibration(mut self, src: CalibrationSource) -> Self {
        self.calibration = src;
        self
    }

    /// Refine the I2S support flag once the unit is open (the EP 0x03 claim
    /// is best-effort — a firmware/OS that refuses it still connects, with
    /// the port honestly reported unavailable).
    pub fn with_i2s(mut self, available: bool) -> Self {
        self.supports_i2s = available;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qa40x::SampleRate;

    #[test]
    fn qa403_gets_384k_and_qa402_does_not() {
        let qa402 = DeviceCapabilities::for_model(Model::Qa402, false);
        let qa403 = DeviceCapabilities::for_model(Model::Qa403, false);
        assert_eq!(qa402.sample_rates_hz, vec![48_000, 96_000, 192_000]);
        assert_eq!(qa403.sample_rates_hz, vec![48_000, 96_000, 192_000, 384_000]);
    }

    #[test]
    fn range_tables_match_the_register_maps() {
        let caps = DeviceCapabilities::for_model(Model::Qa403, false);
        // These are the values lot D will read INSTEAD of the frontend's
        // INPUT_RANGES_DBV/OUTPUT_RANGES_DBV consts — pin them.
        assert_eq!(caps.input_ranges_dbv, vec![0, 6, 12, 18, 24, 30, 36, 42]);
        assert_eq!(caps.output_ranges_dbv, vec![-12, -2, 8, 18]);
        assert_eq!((caps.input_channels, caps.output_channels), (2, 2));
    }

    #[test]
    fn a_virtual_unit_never_supports_flash() {
        // QA402 is the flashable model — virtuality must still gate it off.
        assert!(DeviceCapabilities::for_model(Model::Qa402, false).supports_flash);
        assert!(!DeviceCapabilities::for_model(Model::Qa402, true).supports_flash);
        // QA403 flash stays off either way (transport unverified).
        assert!(!DeviceCapabilities::for_model(Model::Qa403, false).supports_flash);
    }

    #[test]
    fn capabilities_reproduce_device_meta_field_by_field() {
        // DeviceMeta (the wire struct) is not rewritten in lot B, so the two
        // records coexist until lot D deletes the duplication. This parity
        // test is what keeps them from drifting in the meantime.
        for (model, is_virtual) in [
            (Model::Qa402, false),
            (Model::Qa403, false),
            (Model::Qa402, true),
            (Model::Qa403, true),
        ] {
            let caps = DeviceCapabilities::for_model(model, is_virtual);
            let limits = model.capabilities();
            let meta_rates: Vec<u32> = model.sample_rates().iter().map(SampleRate::as_hz).collect();
            assert_eq!(caps.model_name, model.name());
            assert_eq!(caps.sample_rates_hz, meta_rates);
            assert_eq!(caps.supports_flash, model.supports_flash() && !is_virtual);
            assert_eq!(caps.min_output_vrms, limits.min_output_vrms);
            assert_eq!(caps.max_output_vrms, limits.max_output_vrms);
            assert_eq!(caps.max_input_vrms, limits.max_input_vrms);
            assert_eq!(caps.min_measurement_hz, limits.min_measurement_hz);
            assert_eq!(caps.max_measurement_hz, limits.max_measurement_hz);
            assert_eq!(caps.is_virtual, is_virtual);
        }
    }

    #[test]
    fn with_calibration_fills_the_open_time_field() {
        let caps = DeviceCapabilities::for_model(Model::Qa403, false);
        assert_eq!(caps.calibration, CalibrationSource::Unknown);
        let caps = caps.with_calibration(CalibrationSource::FactoryEeprom { page_bytes: 512 });
        assert_eq!(caps.calibration, CalibrationSource::FactoryEeprom { page_bytes: 512 });
    }

    #[test]
    fn every_model_and_the_virtual_units_declare_the_i2s_port() {
        // The whole family has the front-panel port, and the embedded
        // simulator emulates its EP3 sink — enumerate-time optimism, refined
        // at open by with_i2s.
        for (model, is_virtual) in [
            (Model::Qa402, false),
            (Model::Qa403, false),
            (Model::Qa403, true),
        ] {
            assert!(DeviceCapabilities::for_model(model, is_virtual).supports_i2s);
        }
        // A refused EP 0x03 claim reports honestly at open.
        let caps = DeviceCapabilities::for_model(Model::Qa402, false).with_i2s(false);
        assert!(!caps.supports_i2s);
    }
}
