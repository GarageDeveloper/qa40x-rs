//! Canonical unit conversions — the Rust twin of `src/dashboard/units.ts`.
//!
//! The data plane keeps amplitudes in ONE canonical unit — RMS volts (Vrms) —
//! and this module converts a canonical value to whatever a readout wants to
//! show: peak volts, dBV, dBu, dBFS, dBr, watts, or percent. Formatting
//! (rounding, SI prefixes, "−∞" rendering) stays in the frontend; only the
//! numeric conversion lives here.
//!
//! References:
//!   dBV  → 1 Vrms
//!   dBu  → 0.7746 Vrms (√(1 mW into 600 Ω))
//!   dBFS → the device's full-scale Vrms for the active range (in [`UnitRefs`])
//!   dBr  → a user/reference level in Vrms (in [`UnitRefs`])
//!   W    → v² / load Ω (in [`UnitRefs`])
//!   %    → v / reference Vrms × 100 (in [`UnitRefs`])

use serde::{Deserialize, Serialize};

/// Floor for every ratio→dB conversion in this crate's measurement layer.
///
/// −200 dB corresponds to an amplitude ratio of 1e-10 — far below both the
/// 24-bit converter noise floor and anything the UI distinguishes from
/// silence (the display layer renders ≤ −200 dB as "−∞"). Flooring here
/// avoids `log(0) = -∞`, which JSON/IPC cannot represent. The same floor was
/// already the de-facto convention in `rest::db` and `audio/weighting.rs`.
pub const DB_FLOOR: f64 = -200.0;

/// 0 dBV reference: 1 Vrms.
pub const DBV_REF_VRMS: f64 = 1.0;

/// 0 dBu reference: √(0.001 W · 600 Ω) ≈ 0.7746 Vrms.
pub const DBU_REF_VRMS: f64 = 0.774_596_669_241_483_4;

/// Amplitude ratio → dB (20·log10), floored at [`DB_FLOOR`].
pub fn db20(ratio: f64) -> f64 {
    if ratio > 0.0 {
        (20.0 * ratio.log10()).max(DB_FLOOR)
    } else {
        DB_FLOOR
    }
}

/// dB → amplitude ratio (inverse of [`db20`]).
pub fn undb20(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

/// Power ratio → dB (10·log10), floored at [`DB_FLOOR`].
///
/// Distinct from [`db20`]: use this for power-domain quantities (spectrum
/// power averaging, noise power sums), where the ÷10 form applies.
pub fn db10(ratio: f64) -> f64 {
    if ratio > 0.0 {
        (10.0 * ratio.log10()).max(DB_FLOOR)
    } else {
        DB_FLOOR
    }
}

/// dB → power ratio (inverse of [`db10`]).
pub fn undb10(db: f64) -> f64 {
    10f64.powf(db / 10.0)
}

/// The constant dB offset between the dBu and dBV scales:
/// `dBu = dBV + dbv_to_dbu_db()` ≈ +2.2185 dB.
///
/// Single source of truth for a constant that was independently defined three
/// times in the frontend (`levels.ts`, `dashboard/grid.ts`, `units.ts`) and
/// hard-coded once more in `main.ts`.
pub fn dbv_to_dbu_db() -> f64 {
    20.0 * (DBV_REF_VRMS / DBU_REF_VRMS).log10()
}

/// The +3.01 dB between a sine's peak and its RMS: `20·log10(√2)`.
///
/// Used by the DAC-side dBFS→dBV projection: an output range's dBV rating is
/// the RMS of a full-scale *sine*, so the DAC offset carries this term on top
/// of the range (measured convention, task #48).
pub fn sine_peak_to_rms_db() -> f64 {
    20.0 * std::f64::consts::SQRT_2.log10()
}

/// A display/interchange unit for a canonical Vrms amplitude.
///
/// Serialized names match the frontend's `Unit` string union
/// (`"vrms" | "vpk" | "dbv" | ...`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Vrms,
    Vpk,
    Dbv,
    Dbu,
    Dbfs,
    Dbr,
    Percent,
    Watt,
    /// Bare relative dB (same scale as dBV; used for gain/transfer axes).
    Db,
}

impl Unit {
    /// Whether the unit is logarithmic (dB-family).
    pub fn is_db(self) -> bool {
        matches!(self, Unit::Dbv | Unit::Dbu | Unit::Dbfs | Unit::Dbr | Unit::Db)
    }
}

/// Reference levels a conversion may need (device/range/context dependent).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitRefs {
    /// Vrms that corresponds to 0 dBFS for the active converter range.
    pub full_scale_vrms: f64,
    /// Reference level for dBr / percent (e.g. a stored "0 dBr" level).
    pub ref_vrms: f64,
    /// Load resistance (Ω) used to turn volts into watts.
    pub load_ohms: f64,
}

impl Default for UnitRefs {
    /// Neutral defaults (1 Vrms full-scale & reference, 8 Ω load) — mirrors
    /// the frontend's `DEFAULT_REFS`.
    fn default() -> Self {
        UnitRefs { full_scale_vrms: 1.0, ref_vrms: 1.0, load_ohms: 8.0 }
    }
}

/// Convert a canonical Vrms amplitude to a target unit's numeric value.
///
/// Negative inputs clamp to 0 (an RMS amplitude cannot be negative); dB-family
/// outputs floor at [`DB_FLOOR`].
pub fn from_vrms(vrms: f64, unit: Unit, refs: &UnitRefs) -> f64 {
    let v = vrms.max(0.0);
    match unit {
        Unit::Vrms => v,
        Unit::Vpk => v * std::f64::consts::SQRT_2,
        Unit::Dbv | Unit::Db => db20(v / DBV_REF_VRMS),
        Unit::Dbu => db20(v / DBU_REF_VRMS),
        Unit::Dbfs => db20(v / refs.full_scale_vrms),
        Unit::Dbr => db20(v / refs.ref_vrms),
        Unit::Percent => {
            if refs.ref_vrms > 0.0 {
                v / refs.ref_vrms * 100.0
            } else {
                0.0
            }
        }
        Unit::Watt => {
            if refs.load_ohms > 0.0 {
                v * v / refs.load_ohms
            } else {
                0.0
            }
        }
    }
}

/// Inverse of [`from_vrms`]: a unit's numeric value back to canonical Vrms.
pub fn to_vrms(value: f64, unit: Unit, refs: &UnitRefs) -> f64 {
    match unit {
        Unit::Vrms => value,
        Unit::Vpk => value / std::f64::consts::SQRT_2,
        Unit::Dbv | Unit::Db => DBV_REF_VRMS * undb20(value),
        Unit::Dbu => DBU_REF_VRMS * undb20(value),
        Unit::Dbfs => refs.full_scale_vrms * undb20(value),
        Unit::Dbr => refs.ref_vrms * undb20(value),
        Unit::Percent => refs.ref_vrms * value / 100.0,
        Unit::Watt => (value.max(0.0) * refs.load_ohms).sqrt(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_UNITS: [Unit; 9] = [
        Unit::Vrms,
        Unit::Vpk,
        Unit::Dbv,
        Unit::Dbu,
        Unit::Dbfs,
        Unit::Dbr,
        Unit::Percent,
        Unit::Watt,
        Unit::Db,
    ];

    fn refs() -> UnitRefs {
        UnitRefs::default()
    }

    #[test]
    fn vrms_passes_through_and_vpk_scales_by_sqrt2() {
        assert_eq!(from_vrms(1.0, Unit::Vrms, &refs()), 1.0);
        assert!((from_vrms(1.0, Unit::Vpk, &refs()) - std::f64::consts::SQRT_2).abs() < 1e-12);
    }

    #[test]
    fn dbv_reference_points() {
        assert!(from_vrms(1.0, Unit::Dbv, &refs()).abs() < 1e-9);
        assert!((from_vrms(2.0, Unit::Dbv, &refs()) - 6.0206).abs() < 1e-3);
        assert!((from_vrms(0.5, Unit::Dbv, &refs()) + 6.0206).abs() < 1e-3);
    }

    #[test]
    fn dbu_references_0_7746_vrms() {
        assert!(from_vrms(DBU_REF_VRMS, Unit::Dbu, &refs()).abs() < 1e-9);
        assert!((from_vrms(1.0, Unit::Dbu, &refs()) - 2.2185).abs() < 1e-3);
        assert!((dbv_to_dbu_db() - 2.2185).abs() < 1e-3);
    }

    #[test]
    fn dbfs_references_the_full_scale_vrms() {
        let r = UnitRefs { full_scale_vrms: 2.0, ..refs() };
        assert!(from_vrms(2.0, Unit::Dbfs, &r).abs() < 1e-9);
        assert!((from_vrms(1.0, Unit::Dbfs, &r) + 6.0206).abs() < 1e-3);
    }

    #[test]
    fn percent_is_a_linear_ratio_to_the_reference() {
        assert!((from_vrms(0.5, Unit::Percent, &refs()) - 50.0).abs() < 1e-9);
        assert!((from_vrms(1.0, Unit::Percent, &refs()) - 100.0).abs() < 1e-9);
    }

    #[test]
    fn watts_is_v_squared_over_load() {
        assert!((from_vrms(2.0, Unit::Watt, &refs()) - 0.5).abs() < 1e-9);
        assert!((from_vrms(8f64.sqrt(), Unit::Watt, &refs()) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn clamps_negative_volts_and_floors_db_at_silence() {
        assert_eq!(from_vrms(-1.0, Unit::Vrms, &refs()), 0.0);
        // TS returned -Infinity here; the agreed canonical form floors at -200
        // (the display layer shows anything <= -200 as "−∞").
        assert_eq!(from_vrms(0.0, Unit::Dbv, &refs()), DB_FLOOR);
        assert_eq!(db20(0.0), DB_FLOOR);
        assert_eq!(db10(-1.0), DB_FLOOR);
    }

    #[test]
    fn round_trips_all_units() {
        let r = UnitRefs { full_scale_vrms: 3.1, ref_vrms: 0.5, load_ohms: 4.0 };
        for unit in ALL_UNITS {
            for v in [0.001, 0.05, 0.5, 1.0, 2.5] {
                let rt = to_vrms(from_vrms(v, unit, &r), unit, &r);
                assert!((rt - v).abs() < 1e-9, "{unit:?} {v} -> {rt}");
            }
        }
    }

    #[test]
    fn power_db_uses_the_div10_form() {
        assert!((db10(0.1) + 10.0).abs() < 1e-9);
        assert!((undb10(-10.0) - 0.1).abs() < 1e-12);
        assert!((undb20(-20.0) - 0.1).abs() < 1e-12);
    }

    #[test]
    fn sine_peak_to_rms_is_3_01_db() {
        assert!((sine_peak_to_rms_db() - 3.0103).abs() < 1e-3);
    }

    #[test]
    fn unit_serde_names_match_the_frontend() {
        assert_eq!(serde_json::to_string(&Unit::Dbfs).unwrap(), "\"dbfs\"");
        assert_eq!(serde_json::to_string(&Unit::Vrms).unwrap(), "\"vrms\"");
        assert_eq!(
            serde_json::from_str::<Unit>("\"percent\"").unwrap(),
            Unit::Percent
        );
        assert!(Unit::Dbr.is_db());
        assert!(!Unit::Watt.is_db());
    }
}
