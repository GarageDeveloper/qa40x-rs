//! Scope measurement suite (issue #26 lot B): per-frame waveform metrics —
//! Vpp, Vmean, whole-period AC-coupled RMS, frequency (crossing seed →
//! Goertzel refine → parabolic interpolation), 10–90 % rise/fall time, duty
//! cycle — plus the sliding-window Welford statistics a DSO shows next to
//! each readout.
//!
//! Pure, device-agnostic DSP on capture-native `&[f32]`, `f64` internally
//! (same discipline as `measurements::levels`) — no stream/wire types. The
//! sample unit is whatever the caller works in (digital full scale here);
//! every level metric carries the same unit, times are seconds, `duty` is a
//! 0..1 ratio. Crossing detection reuses the lot-A Schmitt trigger
//! (`find_edge`) so a noisy signal can't fake crossings: the same
//! qualification that stabilizes the displayed edge stabilizes the period
//! count these measures integrate over.

use std::collections::VecDeque;

use super::trigger::{find_edge, Edge};

/// One frame's measured values. `None` = the metric is undefined on this
/// frame (no qualified crossings for the periodic ones, no full 10–90 %
/// transition for rise/fall) — never 0.0, which would poison the running
/// statistics with fake readings.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ScopeValues {
    /// Peak-to-peak amplitude (max − min).
    pub vpp: f64,
    /// Arithmetic mean of the frame (the DC level a DSO calls "Vmean").
    pub vmean: f64,
    /// AC-coupled RMS integrated over whole periods only: between the first
    /// and last Schmitt-qualified rising crossings of the frame mean. A
    /// fixed-length window holds a fractional cycle whose residual
    /// (~`A/(π·cycles)`) swamps the noise floor; integrating crossing-to-
    /// crossing removes it (the endpoints sit where the AC signal is ~0, so
    /// truncating to whole samples there costs nothing).
    pub rms_ac: Option<f64>,
    /// Fundamental frequency in Hz: crossing-count seed refined against the
    /// Hann-windowed Goertzel magnitude by iterative parabolic
    /// interpolation (≤ ~0.005 Hz on a 1 s window — pinned below).
    pub freq_hz: Option<f64>,
    /// Mean 10→90 % rise time (seconds) across every complete rising
    /// transition of the frame; base/top from the bimodal histogram.
    pub rise_s: Option<f64>,
    /// Mean 90→10 % fall time (seconds), mirror of `rise_s`.
    pub fall_s: Option<f64>,
    /// Fraction of time spent above the 50 % (mid base/top) level, measured
    /// over whole periods between the first/last rising mid crossings.
    pub duty: Option<f64>,
}

/// Auto Schmitt half-band for the measurement crossings: 2 % of the frame's
/// own half-swing, floored so a near-silent frame doesn't collapse the band
/// and count noise as periods (same 2 % / 1e-4 policy as the display
/// trigger's `auto_hysteresis`, but sized on Vpp/2 because these crossings
/// are of the MEAN, not of a user level).
fn crossing_hysteresis(vpp: f64) -> f32 {
    ((vpp / 2.0) * 0.02).max(1e-4) as f32
}

/// Every Schmitt-qualified rising crossing of `level`, as sub-sample times
/// (in samples): repeated `find_edge` scans, each restarting just past the
/// previous hit — O(n) total, and every crossing carries the full lot-A
/// qualification (a sub-hysteresis wiggle never becomes a period).
fn rising_crossings(samples: &[f32], level: f32, hysteresis: f32) -> Vec<f64> {
    let mut times = Vec::new();
    let mut from = 0usize;
    while let Some(hit) = find_edge(samples, level, hysteresis, Edge::Rising, from) {
        times.push(hit.index as f64 - 1.0 + hit.frac as f64);
        from = hit.index + 1;
    }
    times
}

/// Goertzel power of the (already windowed) buffer at an ARBITRARY frequency
/// — the standard second-order recurrence, valid off the bin grid, O(n) per
/// evaluation. `f64` throughout: the state accumulates over the whole
/// buffer and `f32` would lose the sub-bin curvature the parabolic
/// refinement reads.
fn goertzel_power(windowed: &[f64], sample_rate: f64, freq_hz: f64) -> f64 {
    let w = 2.0 * std::f64::consts::PI * freq_hz / sample_rate;
    let coeff = 2.0 * w.cos();
    let (mut s1, mut s2) = (0.0f64, 0.0f64);
    for &x in windowed {
        let s0 = x + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/// One parabolic-interpolation descent on the Hann-windowed Goertzel
/// log-power: evaluate at `f − d, f, f + d`, move to the parabola vertex,
/// halve `d`, repeat. Starts at one FFT-bin width (a valid crossing seed is
/// always well inside the Hann mainlobe, which is 4 bins wide). The vertex
/// step is clamped to ±`d` so a degenerate triple can never throw the
/// estimate outside the bracket — which also bounds the total travel to
/// 2 bins from the seed.
fn refine_at(windowed: &[f64], sample_rate: f64, seed_hz: f64) -> f64 {
    let n = windowed.len();
    let nyquist = sample_rate / 2.0;
    let mut f = seed_hz;
    let mut d = sample_rate / n as f64; // one bin
    for _ in 0..10 {
        let lo = (f - d).max(d * 1e-3);
        let hi = (f + d).min(nyquist - d * 1e-3);
        let p = |freq: f64| goertzel_power(windowed, sample_rate, freq).max(1e-300).ln();
        let (pl, pc, pr) = (p(lo), p(f), p(hi));
        let denom = pl - 2.0 * pc + pr;
        if denom < 0.0 {
            // Proper local maximum: parabola vertex, clamped to the bracket.
            let delta = (0.5 * (pl - pr) / denom).clamp(-1.0, 1.0);
            f = (f + delta * d).clamp(lo, hi);
        } else if pr > pl {
            // Not a peak yet (seed on a slope): walk uphill one step.
            f = hi;
        } else {
            f = lo;
        }
        d *= 0.5;
    }
    f
}

/// Refine a crossing-seeded frequency estimate against the Hann-windowed
/// Goertzel spectrum ([`refine_at`]), then sanity-check the SUBHARMONICS:
/// a waveform that crosses its mean more than twice per period (strong odd
/// harmonics) seeds an integer MULTIPLE of the fundamental, and the local
/// refinement then confirms that (real) harmonic peak — comparing the
/// power at `f/2` and `f/3` and re-refining from the stronger one recovers
/// the true fundamental (review lot B #4).
fn refine_frequency(samples: &[f32], sample_rate: f64, seed_hz: f64) -> f64 {
    let n = samples.len();
    let nyquist = sample_rate / 2.0;
    if n < 8 || seed_hz <= 0.0 || seed_hz >= nyquist {
        return seed_hz;
    }
    // Hann-window once; every candidate frequency reuses the same buffer.
    let windowed: Vec<f64> = samples
        .iter()
        .enumerate()
        .map(|(i, &x)| {
            let w = 0.5
                * (1.0
                    - (2.0 * std::f64::consts::PI * i as f64 / (n as f64 - 1.0)).cos());
            x as f64 * w
        })
        .collect();

    let f1 = refine_at(&windowed, sample_rate, seed_hz);
    let bin = sample_rate / n as f64;
    let mut best = (f1, goertzel_power(&windowed, sample_rate, f1));
    for k in [2.0, 3.0] {
        let cand = f1 / k;
        if cand <= bin {
            continue; // below the first resolvable bin — nothing down there
        }
        // The un-refined `f1/k` already sits sub-bin from a real fundamental
        // (the seed is `k · f0 · (1 ± ε)`), so its raw power is comparable.
        if goertzel_power(&windowed, sample_rate, cand) > best.1 {
            let fk = refine_at(&windowed, sample_rate, cand);
            let pk = goertzel_power(&windowed, sample_rate, fk);
            if pk > best.1 {
                best = (fk, pk);
            }
        }
    }
    best.0
}

/// Base/top levels from the bimodal amplitude histogram (the IEEE-181-style
/// method every DSO uses): `base` = the most populated bin in the lower
/// half of the span, `top` = the mode of the upper half. On a square wave
/// this reads the flats (immune to overshoot); on a sine the density peaks
/// at the extremes so it degenerates gracefully to ~min/max.
///
/// A mode only counts when its bin is distinctly more populated than a
/// UNIFORM spread would make it — a triangle/sawtooth's histogram is flat,
/// its "mode" is a sampling-noise artifact anywhere in the half, and using
/// it put `top` at mid-swing (duty 73 %, rise 4× short on the app's own
/// sawtooth source — review lot B #1). A non-modal half falls back to its
/// extreme (the peak method), which is exactly right for those waveforms.
/// Ties resolve OUTWARD (lowest bin for the base, highest for the top) for
/// the same reason.
fn base_top(samples: &[f32], min: f64, max: f64) -> (f64, f64) {
    const BINS: usize = 128;
    let span = max - min;
    let mut counts = [0u32; BINS];
    for &x in samples {
        let idx = (((x as f64 - min) / span) * BINS as f64) as usize;
        counts[idx.min(BINS - 1)] += 1;
    }
    let bin_center = |i: usize| min + (i as f64 + 0.5) / BINS as f64 * span;
    // A real flat must hold a FRANK share of the frame: 8× the uniform
    // per-bin count (6.25 % of the samples). A square's flats hold ~50 %
    // each (modal even when noise spreads them over a few bins); a sine's
    // extreme bins peak at ~5.6 % and a triangle/sawtooth at ≤4 % — all
    // fall back to min/max, the exact IEEE "peak method" answer for
    // waveforms without flats. (A looser 2× threshold was defeated by
    // integer-period synthetic ramps, whose quantized values fake narrow
    // histogram spikes.)
    let modal_threshold = (samples.len() as f64 / BINS as f64) * 8.0;
    let mut lo_mode = 0;
    for i in 0..BINS / 2 {
        if counts[i] > counts[lo_mode] {
            lo_mode = i; // strict > : ties keep the LOWEST bin
        }
    }
    let mut hi_mode = BINS - 1;
    for i in (BINS / 2..BINS).rev() {
        if counts[i] > counts[hi_mode] {
            hi_mode = i; // reverse scan: ties keep the HIGHEST bin
        }
    }
    let base = if counts[lo_mode] as f64 >= modal_threshold { bin_center(lo_mode) } else { min };
    let top = if counts[hi_mode] as f64 >= modal_threshold { bin_center(hi_mode) } else { max };
    (base, top)
}

/// Mean transition time (seconds) between the `from_level` and `to_level`
/// crossings, in `direction`, across every complete transition of the
/// frame: after crossing `from_level`, reaching `to_level` records the pair,
/// while falling back through `from_level` abandons it (a false start).
/// Sub-sample interpolation at both ends. `None` when no complete
/// transition exists.
///
/// Schmitt-armed like every other crossing in this module (review lot
/// B #2): a candidate only opens once the signal has been seen at/below
/// `from_level − hysteresis`, so the noise floor of an idle input — whose
/// excursions never leave the hysteresis band — can never fake a
/// transition time (it used to report ~32 µs on −120 dBFS noise while
/// every other metric correctly read `None`). As in `find_edge`,
/// qualification decides WHETHER, never WHERE: recorded times stay the
/// plain `from`/`to` crossings.
fn mean_transition_s(
    samples: &[f32],
    sample_rate: f64,
    from_level: f64,
    to_level: f64,
    hysteresis: f64,
    direction: Edge,
) -> Option<f64> {
    // Fold polarity so rising/falling share one scan (the find_edge trick):
    // compare `s·x` against `s·level`, with levels ordered from → to.
    let s = match direction {
        Edge::Rising => 1.0f64,
        Edge::Falling => -1.0,
    };
    let (lo, hi) = (s * from_level, s * to_level);
    let h = hysteresis.abs();
    let mut armed = false;
    let mut start_t: Option<f64> = None;
    let mut sum = 0.0f64;
    let mut count = 0u32;
    for i in 1..samples.len() {
        let prev = s * samples[i - 1] as f64;
        let cur = s * samples[i] as f64;
        let cross_up = |level: f64| -> Option<f64> {
            if prev < level && cur >= level {
                Some(i as f64 - 1.0 + (level - prev) / (cur - prev))
            } else {
                None
            }
        };
        // A qualified `from_level` crossing (re)starts the clock: qualified
        // = armed by an earlier low sample, OR `prev` itself sits below the
        // arming level (a step edge whose low side IS the proof — also the
        // only form a first-interval edge can prove), OR a candidate is
        // already pending (a LATER `lo` crossing restarts it, so the timed
        // transition is always the final monotonic run).
        if let Some(t0) = cross_up(lo) {
            if armed || prev <= lo - h || start_t.is_some() {
                start_t = Some(t0);
                armed = false;
            }
        } else if cur <= lo - h {
            armed = true; // (re-)arm; also clears a pending false start
            start_t = None;
        } else if start_t.is_some() && cur < lo {
            start_t = None; // fell back below the start level: false start
        }
        // The `to_level` crossing may land in the SAME sample interval as
        // the `lo` one (a one-sample step edge): check it after, so
        // `t1 >= t0` always holds within an interval.
        if let (Some(t0), Some(t1)) = (start_t, cross_up(hi)) {
            sum += t1 - t0;
            count += 1;
            start_t = None;
        }
    }
    (count > 0).then(|| sum / count as f64 / sample_rate)
}

/// Measure one frame. Total cost: a handful of O(n) passes plus ~30 O(n)
/// Goertzel evaluations for the frequency refinement — measured ~2 ms per
/// endpoint at 32 k samples (≈2× the frame's FFT, ~1 % of its capture
/// time), scaling linearly to ~70 ms at 1 M. Runs on the stream loop's
/// blocking thread for exactly that reason.
pub fn measure_scope(samples: &[f32], sample_rate: f64) -> ScopeValues {
    if samples.len() < 2 || sample_rate <= 0.0 {
        return ScopeValues::default();
    }

    // ---- single pass: min / max / mean --------------------------------
    let (mut min, mut max, mut sum) = (f64::INFINITY, f64::NEG_INFINITY, 0.0f64);
    for &x in samples {
        let v = x as f64;
        min = min.min(v);
        max = max.max(v);
        sum += v;
    }
    let vmean = sum / samples.len() as f64;
    let vpp = max - min;
    if !vpp.is_finite() || vpp <= 0.0 {
        // Flat (or non-finite) frame: every periodic metric is undefined.
        return ScopeValues {
            vpp: if vpp.is_finite() { vpp } else { f64::NAN },
            vmean,
            ..ScopeValues::default()
        };
    }

    let hyst = crossing_hysteresis(vpp);

    // ---- whole-period span: rising crossings of the mean ---------------
    let mean_crossings = rising_crossings(samples, vmean as f32, hyst);
    let (rms_ac, freq_hz) = if mean_crossings.len() >= 2 {
        let t_first = mean_crossings[0];
        let t_last = *mean_crossings.last().unwrap();
        // Whole samples inside [first, last): the endpoints sit on the AC
        // zero, so the fractional-sample residual is ~0 by construction.
        let i0 = t_first.ceil() as usize;
        let i1 = (t_last.ceil() as usize).min(samples.len());
        let span = &samples[i0..i1];
        let rms_ac = (!span.is_empty()).then(|| {
            let m = span.iter().map(|&x| x as f64).sum::<f64>() / span.len() as f64;
            (span.iter().map(|&x| (x as f64 - m).powi(2)).sum::<f64>() / span.len() as f64)
                .sqrt()
        });
        let cycles = (mean_crossings.len() - 1) as f64;
        let seed = cycles * sample_rate / (t_last - t_first);
        // Above ~0.45·fs (fewer than ~2.2 samples per period) the crossing
        // seed itself degrades by hundreds of Hz and the refinement's
        // 2-bin travel cannot recover — report nothing rather than a
        // confidently-formatted wrong number (review lot B #3).
        let freq = (seed < 0.45 * sample_rate)
            .then(|| refine_frequency(samples, sample_rate, seed));
        (rms_ac, freq)
    } else {
        (None, None)
    };

    // ---- base/top → rise, fall, duty -----------------------------------
    let (base, top) = base_top(samples, min, max);
    let amp = top - base;
    let (rise_s, fall_s, duty) = if amp > 0.0 {
        let l10 = base + 0.1 * amp;
        let l50 = base + 0.5 * amp;
        let l90 = base + 0.9 * amp;
        let h = hyst as f64;
        let rise = mean_transition_s(samples, sample_rate, l10, l90, h, Edge::Rising);
        let fall = mean_transition_s(samples, sample_rate, l90, l10, h, Edge::Falling);
        // Duty over whole periods between rising mid crossings (a partial
        // period would bias toward whichever half-cycle the window ends in).
        let mid_crossings = rising_crossings(samples, l50 as f32, hyst);
        let duty = (mid_crossings.len() >= 2)
            .then(|| {
                let i0 = mid_crossings[0].ceil() as usize;
                let i1 = (mid_crossings.last().unwrap().ceil() as usize).min(samples.len());
                let span = &samples[i0..i1];
                (!span.is_empty()).then(|| {
                    span.iter().filter(|&&x| x as f64 > l50).count() as f64 / span.len() as f64
                })
            })
            .flatten();
        (rise, fall, duty)
    } else {
        (None, None, None)
    };

    ScopeValues { vpp, vmean, rms_ac, freq_hz, rise_s, fall_s, duty }
}

/* -------------------------------------------------------------------------- */
/* Sliding-window running statistics                                           */
/* -------------------------------------------------------------------------- */

/// Statistics of the values currently in a [`SlidingStats`] window.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StatsSnapshot {
    pub avg: f64,
    pub min: f64,
    pub max: f64,
    /// Sample standard deviation (n−1 denominator; 0 for a single value).
    pub sd: f64,
    pub n: u32,
}

/// Sliding window of the last `cap` readings with Welford statistics — the
/// per-measurement avg/min/max/σ strip of a DSO. The stats are recomputed
/// over the (bounded, small) window with Welford's one-pass update at each
/// snapshot instead of incrementally add/removing: exact min/max under
/// eviction needs the window anyway, and an O(window) pass per frame is
/// noise while incremental variance downdating drifts numerically over
/// hours of streaming.
#[derive(Clone, Debug)]
pub struct SlidingStats {
    window: VecDeque<f64>,
    cap: usize,
}

impl SlidingStats {
    pub fn new(cap: usize) -> Self {
        Self { window: VecDeque::with_capacity(cap.max(1)), cap: cap.max(1) }
    }

    /// Push one reading, evicting the oldest beyond the window capacity.
    /// Non-finite readings are dropped — a single NaN would otherwise pin
    /// min/max/σ to NaN for a full window length.
    pub fn push(&mut self, value: f64) {
        if !value.is_finite() {
            return;
        }
        if self.window.len() == self.cap {
            self.window.pop_front();
        }
        self.window.push_back(value);
    }

    /// Forget every reading (measurement no longer requested / reconfigured).
    pub fn reset(&mut self) {
        self.window.clear();
    }

    /// Welford pass over the current window; `None` when it is empty.
    pub fn snapshot(&self) -> Option<StatsSnapshot> {
        if self.window.is_empty() {
            return None;
        }
        let (mut mean, mut m2) = (0.0f64, 0.0f64);
        let (mut min, mut max) = (f64::INFINITY, f64::NEG_INFINITY);
        for (i, &v) in self.window.iter().enumerate() {
            let delta = v - mean;
            mean += delta / (i as f64 + 1.0);
            m2 += delta * (v - mean);
            min = min.min(v);
            max = max.max(v);
        }
        let n = self.window.len();
        let sd = if n > 1 { (m2 / (n as f64 - 1.0)).sqrt() } else { 0.0 };
        Some(StatsSnapshot { avg: mean, min, max, sd, n: n as u32 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, amp: f64, dc: f64, fs: f64, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (dc + amp * (2.0 * std::f64::consts::PI * freq * i as f64 / fs).sin()) as f32)
            .collect()
    }

    /// 25 %-duty rectangular wave, `period` samples, levels −amp/+amp.
    fn rect_25(amp: f32, period: usize, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| if (i % period) < period / 4 { amp } else { -amp })
            .collect()
    }

    /// Test 1 — Vpp/Vmean exactness and the POINT of whole-period AC RMS: on a
    /// window holding a fractional cycle count, the crossing-bounded RMS
    /// lands on A/√2 much closer than the naive full-window RMS does.
    #[test]
    fn ac_rms_beats_naive_rms_on_fractional_cycles() {
        let fs = 48000.0;
        // 997 Hz over 4096 samples = 85.08 cycles — deliberately fractional;
        // +0.1 DC so the AC coupling (mean subtraction) is actually exercised.
        let sig = sine(997.0, 0.5, 0.1, fs, 4096);
        let m = measure_scope(&sig, fs);

        assert!((m.vpp - 1.0).abs() < 2e-3, "vpp {}", m.vpp);
        assert!((m.vmean - 0.1).abs() < 2e-3, "vmean {}", m.vmean);

        let expected = 0.5 / std::f64::consts::SQRT_2;
        let ac = m.rms_ac.expect("rms_ac");
        let ac_err = (ac - expected).abs();

        // Naive: centered RMS over the raw window (what lot B replaces).
        let mean = sig.iter().map(|&x| x as f64).sum::<f64>() / sig.len() as f64;
        let naive = (sig.iter().map(|&x| (x as f64 - mean).powi(2)).sum::<f64>()
            / sig.len() as f64)
            .sqrt();
        let naive_err = (naive - expected).abs();

        assert!(ac_err < 1e-4, "ac err {ac_err}");
        assert!(ac_err < naive_err / 3.0, "ac {ac_err} vs naive {naive_err}");
    }

    /// Test 2 — frequency accuracy pin (the lot-B budget): a 1 s window must
    /// resolve a non-bin sine within 0.005 Hz.
    #[test]
    fn frequency_within_5_mhz_on_one_second() {
        let fs = 48000.0;
        let f0 = 997.13;
        let sig = sine(f0, 0.5, 0.0, fs, 48000);
        let f = measure_scope(&sig, fs).freq_hz.expect("freq");
        assert!((f - f0).abs() < 0.005, "freq {f}, err {}", (f - f0).abs());
    }

    /// Test 2b — the refinement also holds on a short window (85 cycles,
    /// 85 ms) to a looser but still sub-bin tolerance, and survives noise.
    #[test]
    fn frequency_short_window_and_noise() {
        let fs = 48000.0;
        let f0 = 997.13;
        let sig = sine(f0, 0.5, 0.0, fs, 4096);
        let f = measure_scope(&sig, fs).freq_hz.expect("freq");
        assert!((f - f0).abs() < 0.5, "short-window freq {f}");

        // Deterministic pseudo-noise at −40 dB of the amplitude.
        let mut state = 0x2545F4914F6CDD1Du64;
        let noisy: Vec<f32> = sig
            .iter()
            .map(|&x| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                let u = (state >> 11) as f64 / (1u64 << 53) as f64; // [0,1)
                x + (0.005 * (2.0 * u - 1.0)) as f32
            })
            .collect();
        let fnoise = measure_scope(&noisy, fs).freq_hz.expect("freq under noise");
        assert!((fnoise - f0).abs() < 0.5, "noisy freq {fnoise}");
    }

    /// Test 3 — rectangular wave: duty 25 %, frequency exact, instantaneous
    /// edges read as the interpolated 0.8-sample 10→90 % time.
    #[test]
    fn rect_wave_duty_freq_rise_fall() {
        let fs = 48000.0;
        let sig = rect_25(0.5, 48, 4800); // 1 kHz, 100 periods
        let m = measure_scope(&sig, fs);

        assert!((m.vpp - 1.0).abs() < 1e-6);
        let duty = m.duty.expect("duty");
        assert!((duty - 0.25).abs() < 0.01, "duty {duty}");
        let f = m.freq_hz.expect("freq");
        assert!((f - 1000.0).abs() < 0.01, "freq {f}");

        // A one-sample step from −0.5 to +0.5 crosses l10 at frac 0.1 and
        // l90 at frac 0.9 of the same interval: 0.8 samples.
        let rise = m.rise_s.expect("rise");
        assert!((rise - 0.8 / fs).abs() < 0.05 / fs, "rise {rise}");
        let fall = m.fall_s.expect("fall");
        assert!((fall - 0.8 / fs).abs() < 0.05 / fs, "fall {fall}");
    }

    /// Test 4 — sine rise time matches the analytic 10–90 % value:
    /// t = asin(0.8)/(π·f) ≈ 0.2952/f (base/top ≈ ±A via the histogram).
    #[test]
    fn sine_rise_time_matches_analytic()  {
        let fs = 48000.0;
        let f0 = 997.0;
        let sig = sine(f0, 0.5, 0.0, fs, 48000);
        let expected = (0.8f64).asin() / (std::f64::consts::PI * f0);
        let rise = measure_scope(&sig, fs).rise_s.expect("rise");
        assert!(
            (rise - expected).abs() < expected * 0.05,
            "rise {rise}, expected {expected}"
        );
        let fall = measure_scope(&sig, fs).fall_s.expect("fall");
        assert!((fall - expected).abs() < expected * 0.05, "fall {fall}");
        // And a sine's duty is 50 %.
        let duty = measure_scope(&sig, fs).duty.expect("duty");
        assert!((duty - 0.5).abs() < 0.01, "duty {duty}");
    }

    /// Test 5 — degenerate frames: silence/DC yield defined Vpp/Vmean and
    /// None for every periodic metric; empty and 1-sample buffers are safe.
    #[test]
    fn degenerate_frames_are_safe() {
        let silent = measure_scope(&vec![0.0f32; 1024], 48000.0);
        assert_eq!(silent.vpp, 0.0);
        assert_eq!(silent.vmean, 0.0);
        assert!(silent.rms_ac.is_none());
        assert!(silent.freq_hz.is_none());
        assert!(silent.rise_s.is_none());
        assert!(silent.duty.is_none());

        let dc = measure_scope(&vec![0.25f32; 1024], 48000.0);
        assert_eq!(dc.vpp, 0.0);
        assert!((dc.vmean - 0.25).abs() < 1e-6);
        assert!(dc.freq_hz.is_none());

        assert_eq!(measure_scope(&[], 48000.0), ScopeValues::default());
        assert_eq!(measure_scope(&[0.5], 48000.0), ScopeValues::default());

        // A NaN-poisoned frame must not panic (values may be NaN/None).
        let with_nan = [f32::NAN, -1.0, 1.0, f32::NAN];
        let _ = measure_scope(&with_nan, 48000.0);
    }

    /// Test 6 — sub-hysteresis noise around the mean must not inflate the
    /// period count (which would drag the frequency seed off): a sine with
    /// a tiny wiggle superimposed keeps the clean signal's cycle count.
    #[test]
    fn noise_wiggle_does_not_add_periods() {
        let fs = 48000.0;
        let clean = sine(100.0, 0.5, 0.0, fs, 4800); // 10 cycles
        // 0.5 % of the amplitude — well under the 2 %-of-half-swing band.
        let wiggly: Vec<f32> = clean
            .iter()
            .enumerate()
            .map(|(i, &x)| x + 0.0025 * ((i as f32) * 1.9).sin())
            .collect();
        let hyst = crossing_hysteresis(1.0);
        let n_clean = rising_crossings(&clean, 0.0, hyst).len();
        let n_wiggly = rising_crossings(&wiggly, 0.0, hyst).len();
        assert_eq!(n_clean, n_wiggly);
        // 10 rising zero crossings in the window, but the one at t = 0 has
        // no `prev` sample to interpolate against — 9 detectable.
        assert_eq!(n_clean, 9);
    }

    /// Test 8 (review lot B #1) — triangle and sawtooth: their amplitude
    /// histogram is FLAT (uniform density), so base/top must fall back to
    /// min/max instead of trusting a sampling-noise "mode" — with the old
    /// inward tie-resolution the top landed at mid-swing and a sawtooth's
    /// rise read 4× short. On a linear ramp the 10→90 % time is exact:
    /// 0.8 × the ramp duration, interpolation error zero.
    #[test]
    fn triangle_and_sawtooth_read_true_rise_fall_duty() {
        let fs = 48000.0;
        let period = 48usize; // 1 kHz
        let n = 32768;

        // Triangle ±1, starting at −1: ramps of half a period each way.
        let tri: Vec<f32> = (0..n)
            .map(|i| {
                let p = i % period;
                if p < period / 2 {
                    -1.0 + 2.0 * (p as f32) / (period / 2) as f32
                } else {
                    1.0 - 2.0 * ((p - period / 2) as f32) / (period / 2) as f32
                }
            })
            .collect();
        let m = measure_scope(&tri, fs);
        let half_period_s = (period / 2) as f64 / fs;
        let rise = m.rise_s.expect("triangle rise");
        assert!((rise - 0.8 * half_period_s).abs() < 1e-9, "tri rise {rise}");
        let fall = m.fall_s.expect("triangle fall");
        assert!((fall - 0.8 * half_period_s).abs() < 1e-9, "tri fall {fall}");
        let duty = m.duty.expect("triangle duty");
        assert!((duty - 0.5).abs() < 0.03, "tri duty {duty}");
        let f = m.freq_hz.expect("triangle freq");
        assert!((f - 1000.0).abs() < 0.01, "tri freq {f}");

        // Sawtooth ±1: one full-period ramp up, one-sample drop.
        let saw: Vec<f32> = (0..n)
            .map(|i| -1.0 + 2.0 * ((i % period) as f32) / period as f32)
            .collect();
        let m = measure_scope(&saw, fs);
        // The sampled ramp tops out at −1 + 2·47/48 (never +1), so the
        // 10→90 % span is 0.8 × that actual swing along a slope of
        // 2/period per sample: 0.8 · 47 samples exactly.
        let rise = m.rise_s.expect("saw rise");
        let expected_rise = 0.8 * (period - 1) as f64 / fs;
        assert!((rise - expected_rise).abs() < 1e-8, "saw rise {rise}");
        // The drop is a one-sample step: 90 %→10 % interpolates to 0.8 of
        // that single interval.
        let fall = m.fall_s.expect("saw fall");
        assert!((fall - 0.8 / fs).abs() < 0.05 / fs, "saw fall {fall}");
        let duty = m.duty.expect("saw duty");
        assert!((duty - 0.5).abs() < 0.03, "saw duty {duty}");
    }

    /// Test 9 (review lot B #2) — the noise floor of an idle input must not
    /// fake rise/fall times: its excursions never clear the Schmitt arming
    /// band, so BOTH transition metrics read `None` exactly like the other
    /// periodic metrics (it used to report ~32 µs while freq/duty said
    /// `None`, and the sliding stats then averaged pure noise).
    #[test]
    fn noise_floor_yields_no_rise_fall() {
        let mut state = 0x2545F4914F6CDD1Du64;
        let noise: Vec<f32> = (0..32768)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                let u = (state >> 11) as f64 / (1u64 << 53) as f64;
                (1e-6 * (2.0 * u - 1.0)) as f32 // ±1 µFS ≈ −120 dBFS
            })
            .collect();
        let m = measure_scope(&noise, 48000.0);
        assert!(m.rise_s.is_none(), "rise {:?}", m.rise_s);
        assert!(m.fall_s.is_none(), "fall {:?}", m.fall_s);
        assert!(m.freq_hz.is_none());
        assert!(m.duty.is_none());
        assert!(m.vpp < 3e-6);
    }

    /// Test 10 (review lot B #3) — near Nyquist the crossing seed degrades
    /// beyond what the 2-bin refinement can recover (measured −210 Hz at
    /// 23.9 kHz): the frequency must be dropped, not reported wrong. Well
    /// below the guard the accuracy pin still holds.
    #[test]
    fn near_nyquist_frequency_is_dropped_not_wrong() {
        let fs = 48000.0;
        let hf = sine(23900.13, 0.5, 0.0, fs, 32768);
        assert!(measure_scope(&hf, fs).freq_hz.is_none());

        let ok = sine(20000.13, 0.5, 0.0, fs, 32768);
        let f = measure_scope(&ok, fs).freq_hz.expect("20 kHz freq");
        assert!((f - 20000.13).abs() < 0.01, "freq {f}");
    }

    /// Test 11 (review lot B #4) — a strong 3rd harmonic makes the signal
    /// cross its mean 6× per period, seeding 3·f0; the subharmonic check
    /// must bring the reading back to the true fundamental (it used to
    /// report 3000.39 Hz for this exact signal).
    #[test]
    fn strong_third_harmonic_does_not_triple_the_frequency() {
        let fs = 48000.0;
        let f0 = 1000.13f64;
        let sig: Vec<f32> = (0..32768)
            .map(|i| {
                let t = i as f64 / fs;
                let w = 2.0 * std::f64::consts::PI * f0 * t;
                (w.sin() - 0.6 * (3.0 * w).sin()) as f32
            })
            .collect();
        let f = measure_scope(&sig, fs).freq_hz.expect("freq");
        assert!((f - f0).abs() < 0.05, "freq {f}, expected {f0}");
    }

    /// Test 7 — SlidingStats: exact avg/min/max/σ on a known set, eviction at
    /// capacity, single-value σ = 0, empty → None, NaN dropped.
    #[test]
    fn sliding_stats_window_and_welford() {
        let mut s = SlidingStats::new(3);
        assert!(s.snapshot().is_none());

        s.push(2.0);
        let one = s.snapshot().unwrap();
        assert_eq!((one.avg, one.min, one.max, one.sd, one.n), (2.0, 2.0, 2.0, 0.0, 1));

        for v in [4.0, 6.0] {
            s.push(v);
        }
        let full = s.snapshot().unwrap();
        assert_eq!((full.avg, full.min, full.max, full.n), (4.0, 2.0, 6.0, 3));
        assert!((full.sd - 2.0).abs() < 1e-12, "sd {}", full.sd); // {2,4,6}: σ=2

        // Eviction: pushing 8 drops 2 → window {4,6,8}.
        s.push(8.0);
        let slid = s.snapshot().unwrap();
        assert_eq!((slid.avg, slid.min, slid.max, slid.n), (6.0, 4.0, 8.0, 3));

        // NaN/∞ are dropped, not accumulated.
        s.push(f64::NAN);
        s.push(f64::INFINITY);
        assert_eq!(s.snapshot().unwrap().n, 3);

        s.reset();
        assert!(s.snapshot().is_none());
    }

    /// Test 8 — the shortest buffer that clears the `len < 2` guard (n = 2):
    /// a single linear step from 0.0 to 1.0. Vpp/Vmean are exact; the ONE
    /// possible mean crossing means `mean_crossings.len() == 1` (< 2), so
    /// every whole-period metric (rms_ac, freq, duty) is undefined — but the
    /// single step is still a complete 10→90 % transition, so `rise_s` reads.
    ///
    /// `rise_s` is NOT the naive 0.8-sample figure here: `base_top`'s 128-bin
    /// histogram over only 2 samples reports the BIN CENTERS nearest the
    /// extremes, not the extremes themselves — `base` = bin 0's center =
    /// 0.5/128, `top` = bin 127's center = 127.5/128, so the measured
    /// `amp` is 254/256 (≈ 99.2 %) of the true 1.0 span. That shrinks the
    /// 10→90 % window from 0.8 to 0.8 × 254/256 = 0.79375 samples — a real,
    /// small discretization bias of the histogram method on very short/
    /// sparse buffers (rect_wave_duty_freq_rise_fall's 4800-sample buffer
    /// already tolerates it with slack; here it's exact enough to pin).
    #[test]
    fn two_sample_buffer_has_one_crossing_and_a_defined_rise() {
        let fs = 48000.0;
        let sig = vec![0.0f32, 1.0f32];
        let m = measure_scope(&sig, fs);

        assert!((m.vpp - 1.0).abs() < 1e-6, "vpp {}", m.vpp);
        assert!((m.vmean - 0.5).abs() < 1e-6, "vmean {}", m.vmean);
        assert!(m.rms_ac.is_none(), "only one mean crossing exists");
        assert!(m.freq_hz.is_none());
        assert!(m.duty.is_none(), "only one mid crossing exists");

        let rise = m.rise_s.expect("the single step is a complete transition");
        let expected = 0.8 * (254.0 / 256.0) / fs;
        assert!((rise - expected).abs() < 1e-12, "rise {rise}, expected {expected}");
    }

    /// Test 9 — a signal spanning LESS than one full cycle (a quarter period
    /// here) must never report a frequency: `mean_crossings` holds at most
    /// one entry (the single rising crossing of the ramp through its own
    /// mean), which is below the 2-crossing whole-period requirement.
    /// Vpp/Vmean are pinned to the analytic quarter-sine values: mean over
    /// θ ∈ [0, π/2) of `amp·sinθ` is `amp·(2/π)` (∫sinθ dθ = [−cosθ], the
    /// quarter-cycle average of a sine ramp); Vpp is ~amp (the window ends
    /// just shy of the peak, one sample before θ = π/2).
    #[test]
    fn sub_one_cycle_window_never_reports_a_frequency() {
        let fs = 48000.0;
        let amp = 0.5;
        // 1 Hz over 12000 samples at 48 kHz = 0.25 s = exactly one quarter
        // period: the sine argument runs from 0 to (just under) π/2.
        let sig = sine(1.0, amp, 0.0, fs, 12000);
        let m = measure_scope(&sig, fs);

        let expected_mean = amp * 2.0 / std::f64::consts::PI;
        assert!((m.vmean - expected_mean).abs() < 1e-3, "vmean {}", m.vmean);
        assert!((m.vpp - amp).abs() < 1e-3, "vpp {}", m.vpp);

        assert!(m.freq_hz.is_none(), "under one cycle: no whole period exists");
        assert!(m.rms_ac.is_none());
        assert!(m.duty.is_none());
    }

    /// Test 10 — duty and frequency must be invariant to DC offset: base/top
    /// (duty) come from the bimodal amplitude HISTOGRAM and mean-crossing
    /// counting (freq) is relative to the frame's OWN mean, so shifting every
    /// sample by a constant moves Vmean by exactly that constant and changes
    /// nothing else — unlike a fixed-level duty/frequency measurement, which
    /// a DC offset would silently break.
    #[test]
    fn duty_and_frequency_are_invariant_to_dc_offset() {
        let fs = 48000.0;
        let amp = 0.5;
        let dc = 0.3;
        // Same 25 %-duty, 1 kHz rectangular wave as Test 3, shifted by +0.3.
        let sig: Vec<f32> = rect_25(amp, 48, 4800).iter().map(|&x| x + dc).collect();
        let m = measure_scope(&sig, fs);

        assert!((m.vpp - 2.0 * amp as f64).abs() < 1e-6, "vpp {}", m.vpp);
        // Un-shifted mean of the 25 %-duty wave is 0.25·amp − 0.75·amp = −0.5·amp.
        let expected_mean = dc as f64 - 0.5 * amp as f64;
        assert!((m.vmean - expected_mean).abs() < 1e-6, "vmean {}", m.vmean);

        let duty = m.duty.expect("duty");
        assert!((duty - 0.25).abs() < 0.01, "duty {duty}");
        let f = m.freq_hz.expect("freq");
        assert!((f - 1000.0).abs() < 0.01, "freq {f}");
    }
}

