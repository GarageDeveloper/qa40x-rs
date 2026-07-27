//! Device abstraction + registry (issue #25, lot B).
//!
//! The seam between "the app" and "a measurement device": sources enumerate
//! units, a registry owns the session's device handle and opens units onto
//! it. `QA40xDevice` itself is wrapped, not modified — its bring-up sequence
//! (`init_device_session`) and the whole acquisition surface are untouched,
//! so the A/B bench against the official app is unaffected.
//!
//! NOT to be confused with [`crate::sources`], which is the *signal*-source
//! model (sine/multitone/file slots feeding the mixer). This module is about
//! *hardware* sources.
//!
//! ## The seam contract
//!
//! - [`DeviceSource`]: one place devices come from (the USB bus, the embedded
//!   simulator, later a remote agent — issue #33). `enumerate()` is async,
//!   fallible, side-effect free, and returns **N** descriptors per source (a
//!   single USB/IP or aggregate source may host several units — the #33
//!   door). `open()` opens one unit *by id* onto the session's handle; the
//!   USB source matches by serial/unit key, never "first device on the bus".
//! - [`Analyzer`]: the narrow control surface a non-QA40x device could also
//!   satisfy (target 3 of #25: generic sound cards). Deliberately excludes
//!   the acquisition surface (`generate_and_capture*`, `acquire_data`,
//!   streaming) in lot B — the A/B-critical capture path stays on the
//!   concrete `QA40xDevice` until lot C moves runtime state per device.
//! - [`DeviceCapabilities`]: the explicit capability record (channels, rates
//!   incl. the QA403-only 384 kHz, range tables, calibration source) that
//!   replaces implicit `Model` knowledge. Built from the model tables at
//!   enumerate time; the calibration source is filled in at open. The
//!   capability registers 0x1B/0x1C are deliberately NOT consulted — a real
//!   QA403's 0x1B word is unverified, and gating 384 kHz on a register read
//!   would be a measurement-semantics change (deferred).
//! - [`DeviceRegistry`]: an [`crate::AppState`] field owning the ONE device
//!   object of the session (lot B invariant: created once, never replaced —
//!   REST/scripting/stream all hold the same `Arc`). Still exactly one open
//!   device; lot E turns the single open slot into a map.
//!
//! ## What later lots change (for orientation, see the plan on issue #25)
//!
//! - Lot C: per-device runtime state (`DeviceHandle` becomes a struct holding
//!   stream control, mixer, generator flags, sweep cancel, telemetry,
//!   liveness monitor), `device_id` on commands, one stream loop per device,
//!   serial-scoped unplug detection.
//! - Lot D: capabilities on the wire (ts-rs export + a devices command), the
//!   frontend devices slice, deletion of the TS range consts.
//! - Lot E: N open devices, a second virtual unit, slot-keyed endpoint ids.
//! - Lot F: programs/REST/scripts per device.

pub mod analyzer;
pub mod caps;
pub mod error;
pub mod id;
pub mod registry;
pub mod source;
pub mod usb;
pub mod virt;

#[cfg(test)]
pub mod testing;

pub use analyzer::Analyzer;
pub use caps::{CalibrationSource, DeviceCapabilities};
pub use error::DeviceError;
pub use id::{DeviceDescriptor, DeviceId, DeviceIdentity, SourceId, SourceKind, Transport};
pub use registry::{DeviceRegistry, OpenDevice};
pub use source::{DeviceHandle, DeviceSource};
