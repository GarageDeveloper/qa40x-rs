//! Scope trigger: locate the first Schmitt-qualified level crossing in a
//! captured buffer and refine it to sub-sample precision.
//!
//! Pure, device-agnostic DSP on capture-native `&[f32]` — no stream/wire
//! types (own [`Edge`] enum, mapped from the wire `TriggerEdge` in
//! `stream.rs` the same way `StreamWindow::to_window_function()` maps
//! windows). This module only ever READS an already-captured buffer to
//! compute alignment metadata; it has no way to gate or reorder anything —
//! callers must keep it that way (see `stream.rs`'s `evaluate_trigger`).

/// Edge polarity to search for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Rising,
    Falling,
}

/// One located trigger crossing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TriggerHit {
    /// First sample at/after the crossing.
    pub index: usize,
    /// Sub-sample residual in [0,1): the crossing is at `index - 1 + frac`.
    pub frac: f32,
}

/// First Schmitt-qualified `edge` crossing of `level` at index ≥ `from`.
///
/// Qualification (rising): the scan must first see a sample at/below
/// `level - hysteresis` (armed), then the first `level` crossing after that
/// becomes a CANDIDATE — held until a later sample clears `level +
/// hysteresis` (confirmed → returned) or the signal falls back to
/// `level - hysteresis` first (a false start → re-arm, keep scanning).
/// The reported crossing is always the plain `level` crossing of the
/// candidate, found BEFORE confirmation — hysteresis only decides WHETHER an
/// edge qualifies, never WHERE it is, so `index`/`frac` are independent of
/// hysteresis width. Falling is the mirror image (handled by negating the
/// comparison polarity, not the buffer).
///
/// Single pass, O(n). `from` is clamped to ≥ 1 (a crossing needs a `prev`
/// sample); `hysteresis` is used as `.abs()`; `hysteresis == 0` degenerates
/// to a plain level crossing (candidate confirms on the same sample that
/// creates it).
pub fn find_edge(
    samples: &[f32],
    level: f32,
    hysteresis: f32,
    edge: Edge,
    from: usize,
) -> Option<TriggerHit> {
    let hyst = hysteresis.abs();
    // Fold polarity into a sign so rising/falling share one scan: comparisons
    // below are all expressed against `s * sample`, which for Falling flips
    // "above/below" without touching the buffer.
    let s: f32 = match edge {
        Edge::Rising => 1.0,
        Edge::Falling => -1.0,
    };
    let lvl = s * level;
    let lo = lvl - hyst;
    let hi = lvl + hyst;

    // `have_low` = have we observed a qualifying low sample yet (armed)? No
    // candidate can form before that — avoids triggering on data whose
    // history before `from` is unknown. `candidate` = a `level` crossing
    // seen while armed, held until a later sample either confirms it
    // (clears `hi`) or a false start sends us back to look for another one.
    let mut have_low = false;
    let mut candidate: Option<(usize, f32)> = None;

    let start = from.max(1);
    for i in start..samples.len() {
        let prev = s * samples[i - 1];
        let cur = s * samples[i];

        if let Some((idx, frac)) = candidate {
            if cur >= hi {
                return Some(TriggerHit { index: idx, frac });
            } else if cur <= lo {
                // False start: dropped back to the low band without ever
                // confirming. `cur` itself re-arms.
                candidate = None;
            }
            // else: between lo and hi, unconfirmed — keep waiting.
            continue;
        }

        if !have_low {
            if cur <= lo {
                have_low = true;
            }
            continue;
        }

        if prev < lvl && cur >= lvl {
            let frac = refine_linear(prev, cur, lvl);
            if cur >= hi {
                // hysteresis == 0 (or the confirming sample IS the crossing
                // sample): confirmed immediately.
                return Some(TriggerHit { index: i, frac });
            }
            candidate = Some((i, frac));
        }
        // else: still below `level` (or between lo and level) — stay armed.
    }
    None
}

/// Linear sub-sample crossing fraction in [0,1) between `prev` and `cur`:
/// the fraction of the `prev → cur` interval at which the line through them
/// equals `level`. Degenerates to 0.0 if `prev == cur` (no slope to
/// interpolate along — shouldn't happen for a real crossing, but keeps the
/// division safe).
pub fn refine_linear(prev: f32, cur: f32, level: f32) -> f32 {
    let d = cur - prev;
    if d.abs() < f32::EPSILON {
        return 0.0;
    }
    ((level - prev) / d).clamp(0.0, 1.0)
}

/// Auto hysteresis: `frac` × peak|x| of the frame, floored at `floor` (so a
/// near-silent frame doesn't collapse the band to ~0 and trigger on noise).
pub fn auto_hysteresis(samples: &[f32], frac: f32, floor: f32) -> f32 {
    let peak = samples.iter().fold(0.0f32, |m, &v| m.max(v.abs()));
    (peak * frac).max(floor)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sine table for a given (possibly fractional) frequency — used instead
    /// of a round 1 kHz so zero crossings don't land exactly on a sample
    /// boundary (1000 Hz divides 48 kHz evenly, which degenerates every
    /// pinned frac to 0 or 1 and defeats the point of the sub-sample test).
    fn sine(freq: f32, fs: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / fs).sin())
            .collect()
    }

    /// Test 1 — zero-crossing alignment: analytic crossing time (samples) vs the
    /// found index/frac must agree within 1e-4 sample. Uses a LOW frequency
    /// (111 Hz, not a round divisor of 48 kHz so the crossing doesn't land
    /// exactly on a sample) — linear refinement's error grows with the
    /// curvature of the waveform between the two bracketing samples, i.e.
    /// with (period_in_samples)^-2; at ~997 Hz (period ~48 samples) that
    /// error already exceeds 1e-4 sample, so the tight tolerance only holds
    /// where a real scope trigger would want it: a signal that's slow
    /// relative to the sample rate.
    #[test]
    fn zero_crossing_alignment_matches_analytic() {
        let fs = 48000.0f32;
        let f0 = 111.0f32;
        let sig = sine(f0, fs, 4096);
        let hit = find_edge(&sig, 0.0, 0.0, Edge::Rising, 0).expect("edge found");

        // The rising zero crossings of sin(2*pi*f0*t) are at t = k / f0
        // (seconds), i.e. sample k * fs / f0. Find the one nearest the hit.
        let period_samples = fs / f0;
        let k = ((hit.index as f32 - 1.0 + hit.frac) / period_samples).round();
        let analytic = k * period_samples;
        let found = hit.index as f32 - 1.0 + hit.frac;
        assert!(
            (found - analytic).abs() < 1e-4,
            "found {found}, analytic {analytic}"
        );
        // Pin the exact values so a future algorithm change is caught.
        assert_eq!(hit.index, 433);
        assert!((hit.frac - 0.432_418_9).abs() < 1e-6, "frac {}", hit.frac);
    }

    /// Test 2 — refinement exactness.
    #[test]
    fn refine_linear_exact_values() {
        assert_eq!(refine_linear(-1.0, 1.0, 0.0), 0.5);
        // Crossing exactly on the EARLIER sample (prev == level) -> frac 0.0,
        // i.e. the crossing sits exactly at `index - 1`.
        assert_eq!(refine_linear(0.0, 1.0, 0.0), 0.0);
    }

    /// Test 3 — hysteresis rejects a straddling wiggle smaller than the band; the
    /// same trace with a real edge appended finds only the real edge.
    #[test]
    fn hysteresis_rejects_noise_wiggle() {
        let mut sig = vec![-1.0f32, -1.0, -0.05, 0.05, -0.05, 0.05, -1.0, -1.0];
        // Wiggle straddles 0 within +-0.05, well under hyst=0.2 -> no edge.
        assert!(find_edge(&sig, 0.0, 0.2, Edge::Rising, 0).is_none());

        // Append a real edge that clears the hysteresis band.
        sig.extend_from_slice(&[-1.0, 1.0, 1.0]);
        let hit = find_edge(&sig, 0.0, 0.2, Edge::Rising, 0).expect("real edge found");
        assert_eq!(hit.index, 9);
        assert_eq!(hit.frac, 0.5);
    }

    /// Test 4 — alignment independent of hysteresis width: same signal, three
    /// hysteresis values, identical index/frac (only the confirmation point
    /// moves, never the reported crossing).
    #[test]
    fn alignment_independent_of_hysteresis() {
        let fs = 48000.0f32;
        let sig = sine(997.0, fs, 4096);
        let mut results = Vec::new();
        for hyst in [0.0f32, 0.05, 0.2] {
            let hit = find_edge(&sig, 0.0, hyst, Edge::Rising, 0).expect("edge found");
            results.push((hit.index, hit.frac));
        }
        assert!(
            results.windows(2).all(|w| w[0] == w[1]),
            "results diverge across hysteresis: {results:?}"
        );
    }

    /// Test 5 — falling-edge symmetry: negating the signal and searching for a
    /// falling edge finds the same index as the rising search on the
    /// original signal.
    #[test]
    fn falling_edge_symmetry() {
        let fs = 48000.0f32;
        let sig = sine(997.0, fs, 4096);
        let rising = find_edge(&sig, 0.0, 0.0, Edge::Rising, 0).expect("rising edge");
        let negated: Vec<f32> = sig.iter().map(|&v| -v).collect();
        let falling = find_edge(&negated, 0.0, 0.0, Edge::Falling, 0).expect("falling edge");
        assert_eq!(rising.index, falling.index);
        assert_eq!(rising.frac, falling.frac);
    }

    /// Test 6 — `from` is honored: an edge entirely before `from` is ignored;
    /// `from = 0` is safe (internally clamped to >= 1).
    #[test]
    fn from_is_honored() {
        let fs = 48000.0f32;
        let sig = sine(997.0, fs, 4096);
        let first = find_edge(&sig, 0.0, 0.0, Edge::Rising, 0).expect("first edge");
        // Starting the search AFTER the first edge must skip it.
        let second = find_edge(&sig, 0.0, 0.0, Edge::Rising, first.index + 1).expect("later edge");
        assert!(second.index > first.index);
        // from = 0 must not panic (needs i >= 1 internally).
        assert!(find_edge(&sig, 0.0, 0.0, Edge::Rising, 0).is_some());
    }

    /// Test 7 — degenerate inputs never panic and never fabricate a crossing.
    #[test]
    fn degenerate_inputs_are_safe() {
        assert!(find_edge(&[], 0.0, 0.0, Edge::Rising, 0).is_none());
        assert!(find_edge(&[1.0], 0.0, 0.0, Edge::Rising, 0).is_none());
        assert!(find_edge(&[-1.0; 100], 0.0, 0.0, Edge::Rising, 0).is_none()); // all-below
        assert!(find_edge(&[1.0; 100], 0.0, 0.0, Edge::Rising, 0).is_none()); // all-above
        assert!(find_edge(&[0.5; 100], 0.5, 0.0, Edge::Rising, 0).is_none()); // DC at level
        assert!(find_edge(&[0.0; 100], 0.0, 0.0, Edge::Rising, 0).is_none()); // silence at level
                                                                              // from beyond the buffer.
        assert!(find_edge(&[-1.0, 1.0], 0.0, 0.0, Edge::Rising, 10).is_none());
        // No NaN leaks into the result on a NaN-containing buffer.
        let with_nan = [f32::NAN, -1.0, 1.0, f32::NAN];
        if let Some(hit) = find_edge(&with_nan, 0.0, 0.0, Edge::Rising, 0) {
            assert!(!hit.frac.is_nan());
        }
    }

    /// Test 8 — `auto_hysteresis`: fraction of frame peak, floored.
    #[test]
    fn auto_hysteresis_scales_with_peak_and_floors() {
        let fs = 48000.0f32;
        let half_peak_sine: Vec<f32> = sine(1000.0, fs, 4096).iter().map(|v| v * 0.5).collect();
        assert!((auto_hysteresis(&half_peak_sine, 0.02, 1e-4) - 0.01).abs() < 1e-4);

        let silence = vec![0.0f32; 4096];
        assert_eq!(auto_hysteresis(&silence, 0.02, 1e-4), 1e-4);
    }
}
