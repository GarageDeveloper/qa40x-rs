//! Pure measurement math and unit conversions — no UI, no device, no I/O.
//!
//! This module is the target of the frontend DSP-extraction refactor: every
//! measurement calculation or unit conversion the TypeScript frontend used to
//! perform inline now has (or will have, as call sites migrate) its single
//! authoritative implementation here.
//!
//! Design rules (agreed with the maintainer, 2026-07):
//!
//! - **Canonical data is linear.** Amplitudes travel as volts / Vrms (or as
//!   full-scale-referenced samples where the converter reference is not yet
//!   applied); gains travel as plain ratios. No struct in this module stores a
//!   dB or percent value — dB only exists as a *derived* output ([`Ratio::db`],
//!   the `*_db` functions), never as stored state.
//! - **Everything is pure.** No globals, no hardware access, no interior
//!   mutability. Context a computation needs (unit references, a user
//!   weighting curve, thresholds) is always a parameter.
//! - **`f64` everywhere.** The numbers this module replaces were computed by
//!   the frontend in IEEE double precision; staying in `f64` makes
//!   before/after parity checks exact. (The `audio/` capture pipeline stays
//!   `f32` — samples are converted at the boundary.)
//! - **Explicit log floor.** Ratio→dB conversions floor at
//!   [`units::DB_FLOOR`] = −200 dB (amplitude ratio 1e-10) instead of
//!   returning −∞: JSON/IPC cannot carry infinities, and the display layer
//!   already renders anything ≤ −200 dB as "−∞". The one intentional
//!   divergence from the old TS helpers (which returned `-Infinity`) is
//!   therefore invisible at the UI edge.
//!
//! Division of labour with the neighbouring modules:
//! - `audio/` keeps the heavy, buffer-crunching analysis (FFT, spectra, THD
//!   suites, wow & flutter demodulation) — it *produces* measurements;
//! - `measurements/` (this module) owns units, projections, light per-frame
//!   metrics, weighting curves and small filters — it *interprets* them.
//!   `audio/weighting.rs` A/C curves are duplicated here for now; the phase C
//!   migration will make that module delegate to [`weighting`].

pub mod filters;
pub mod levels;
pub mod spectral;
pub mod units;
pub mod weighting;

use serde::{Deserialize, Serialize};

/// A dimensionless linear (voltage) ratio, e.g. a crest factor or a gain.
/// Stores the linear value; the dB reading is derived, never stored.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Ratio {
    /// The linear ratio (1.0 = unity / 0 dB).
    pub linear: f64,
}

impl Ratio {
    /// The ratio expressed in dB (20·log10), floored at [`units::DB_FLOOR`].
    pub fn db(&self) -> f64 {
        units::db20(self.linear)
    }
}
