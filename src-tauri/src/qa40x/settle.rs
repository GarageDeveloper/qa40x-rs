//! Relay settle deadline for the range registers.
//!
//! The input-range (reg 5) and output-range (reg 6) registers do not scale
//! anything in software: they drive **mechanical relays**. A relay takes real
//! time to close and stop bouncing, so the concern was that a capture started
//! right after a range write measures a contact mid-flight.
//!
//! # What the hardware actually does (measured, 2026-07-15)
//!
//! It doesn't — not observably. Probes `hw_relay_envelope` and
//! `hw_input_relay_envelope` switch a range, start ONE long capture
//! immediately, and walk the RMS envelope through it in 10.7 ms windows, each
//! against the block's own settled tail. A **control pass with no range change
//! at all** establishes the capture's own start-up artifact (a −0.79 dB dip in
//! the first window — present whether or not a relay moved, so it is the stream
//! starting, not the relay).
//!
//! Relay contribution above that control, on a loopback tone:
//!
//! | transition | excess |
//! |---|---|
//! | output +8 ↔ +18 dBV | ±0.001 dB |
//! | input 12 → 18 dBV (same group) | +0.000 dB |
//! | input 18 → 24 dBV (attenuator engages) | +0.001 dB |
//! | input 24 → 18 dBV (attenuator releases) | +0.002 dB |
//! | **input 42 → 0 dBV (attenuated → most sensitive)** | **+0.000 dB** |
//!
//! Nothing, anywhere — including the attenuator group crossing we had assumed
//! was the expensive one, and including **42 → 0 dBV**: the biggest swing the
//! front-end can make in one write, and the case a stepped/intermediate design
//! would exist to protect.
//!
//! The reason is mundane: the capture path's own latency (register write
//! ~0.3 ms, then stream set-up — ~140 ms of overhead on a 683 ms block) already
//! exceeds whatever the relays need, so by the time the stream delivers its
//! first sample they are quiet.
//!
//! Two method notes worth keeping, because each one nearly produced a false
//! positive:
//!
//! - the control must be taken **at the destination range**, not once at some
//!   arbitrary range: a capture's first-window scatter tracks that range's SNR.
//!   Judging a "landed at 42 dBV" case against a control taken at 12 dBV
//!   attributes the 42 dBV noise floor to the relay (it read +0.096 dB that way,
//!   +0.064 dB against its own control);
//! - a real settling transient decays monotonically. The residual scatter at
//!   42 dBV does not (+0.16, then −0.01, +0.10, +0.11, +0.04 …) — that is noise
//!   at −54 dBFS, not a relay.
//!
//! What this does NOT cover: an intermediate/stepped range change could exist to
//! protect the front-end from a transient **overvoltage** when dropping from an
//! attenuated range to the most sensitive one. That is a safety concern, not an
//! accuracy one, and an RMS-envelope probe is blind to it. Our measurement says
//! only that such a transition costs no measurable accuracy — not that stepping
//! through an intermediate range would be pointless for other reasons.
//!
//! **The measurement cannot see a transient that ends before the stream's first
//! sample.** So this bounds the settle at less than the capture path's start-up
//! latency; it does not prove the relay is instantaneous. Hence: keep the
//! mechanism, and set the deadline to a value that is *free* — shorter than
//! that start-up, so it never actually stalls anything — rather than deleting
//! the guard and having nothing if the streaming path ever gets faster.
//!
//! Earlier revisions of this module carried 0.25 / 0.5 / 1.2 s and a special
//! long case for the group crossing. Those were guesses, and they cost up to
//! 1.2 s of stall (and a ~0.5 s audio gap mid-run) for a benefit the
//! measurement could not find. The group-crossing distinction is gone too: the
//! hardware does not distinguish it, so neither should the code.
//!
//! # Design
//!
//! A **deadline, not a blocking sleep at the write site**: each relay write
//! stamps a "not before T" instant into [`SettleDeadline`], and the acquisition
//! path waits out whatever remains of the *latest* deadline before starting the
//! next stream. So:
//!
//! - several range writes in one config-apply cost **one** settle (the max),
//!   not the sum;
//! - the wait is paid by the acquirer (which is allowed to wait), not by the
//!   setter (which may be inside a config apply);
//! - the wait sits **between** captures — register writes are never interleaved
//!   into a live stream, and neither is this wait.

use std::time::{Duration, Instant};

/// Settle after any range-relay write (input reg 5 or output reg 6).
///
/// Measured: no relay transient is detectable on any transition once the
/// capture's own start-up artifact is controlled for (see the module docs). The
/// capture path's start-up latency is itself ~140 ms, so this deadline has
/// always elapsed by the time a stream could start — it stalls nothing in
/// practice, and exists so the guard is there if that latency ever shrinks.
///
/// Do not raise this without a measurement that shows a transient: the previous
/// values were guesses and cost up to 1.2 s per range change for nothing.
pub const RANGE_RELAY_SETTLE: Duration = Duration::from_millis(50);

/// The "not before T" instant relay writes stamp and the acquisition path
/// waits on. Monotonic: stamping never moves the deadline earlier, so
/// overlapping settles collapse to the latest one.
#[derive(Debug, Default)]
pub struct SettleDeadline {
    not_before: Option<Instant>,
}

impl SettleDeadline {
    /// Record that a relay was just written and needs `settle` from `now`.
    /// Keeps the later of the existing and the new deadline (max, not sum).
    pub fn stamp(&mut self, now: Instant, settle: Duration) {
        let candidate = now + settle;
        self.not_before = Some(match self.not_before {
            Some(existing) if existing > candidate => existing,
            _ => candidate,
        });
    }

    /// How much longer the acquirer must wait as of `now`; `None` when every
    /// stamped relay has already settled.
    pub fn remaining(&self, now: Instant) -> Option<Duration> {
        self.not_before
            .and_then(|t| t.checked_duration_since(now))
            .filter(|d| !d.is_zero())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_settle_stays_free_relative_to_the_capture_start_up() {
        // The measurement's whole point: no relay transient was detectable, and
        // the capture path's own start-up (~140 ms) already covers this. If
        // someone raises this above that latency it starts costing real stalls
        // for a benefit nothing has ever shown — make that deliberate.
        assert!(
            RANGE_RELAY_SETTLE <= Duration::from_millis(100),
            "raising the settle past the capture path's own start-up reintroduces \
             a stall the hardware measurement does not justify"
        );
    }

    #[test]
    fn two_writes_collapse_to_one_wait_not_the_sum() {
        let t0 = Instant::now();
        let mut d = SettleDeadline::default();
        // An input write and an output write in one config-apply:
        d.stamp(t0, RANGE_RELAY_SETTLE);
        d.stamp(t0, RANGE_RELAY_SETTLE);
        // The acquirer waits once, not twice.
        assert_eq!(d.remaining(t0), Some(RANGE_RELAY_SETTLE));
    }

    #[test]
    fn a_later_short_stamp_never_shortens_an_earlier_long_one() {
        let t0 = Instant::now();
        let mut d = SettleDeadline::default();
        d.stamp(t0, Duration::from_millis(1200));
        let t1 = t0 + Duration::from_millis(100);
        d.stamp(t1, Duration::from_millis(250)); // would end sooner
        assert_eq!(d.remaining(t1), Some(Duration::from_millis(1100)));
    }

    #[test]
    fn remaining_shrinks_with_time_and_expires() {
        let t0 = Instant::now();
        let mut d = SettleDeadline::default();
        d.stamp(t0, Duration::from_millis(500));
        assert_eq!(
            d.remaining(t0 + Duration::from_millis(200)),
            Some(Duration::from_millis(300))
        );
        assert_eq!(d.remaining(t0 + Duration::from_millis(500)), None);
        assert_eq!(d.remaining(t0 + Duration::from_secs(10)), None);
    }

    #[test]
    fn unstamped_deadline_never_waits() {
        assert_eq!(SettleDeadline::default().remaining(Instant::now()), None);
    }
}
