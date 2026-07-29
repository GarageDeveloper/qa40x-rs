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
//! - [`DeviceRegistry`]: an [`crate::AppState`] field owning the default
//!   device's [`DeviceRuntime`] (lot B invariant, extended by lot C: the
//!   runtime and everything in it are created once and never replaced —
//!   REST/scripting/stream all hold `Arc`s out of it). Still exactly one
//!   open device; lot E turns the single runtime slot into a map.
//! - [`DeviceRuntime`] (lot C): everything that is runtime state of ONE
//!   device — handle, telemetry cell, mixer, generator flags, sweep cancel,
//!   stream control, open-unit cell, generation-keyed open/close bookkeeping
//!   behind a lifecycle gate, quiesce/shutdown, liveness monitor. Commands
//!   accept an optional `device_id` (`None` ⇒ default device); every stream
//!   frame carries its device identity.
//! - [`wire::DeviceEntry`] / [`wire::DeviceList`] (lot D): the flat DTOs the
//!   `list_devices` command serves to the frontend devices slice — ids as
//!   strings, model as the DISPLAY name, the open unit's entry substituted
//!   by its open-enriched descriptor. The frontend's range/rate menus read
//!   the capability record (the TS consts are gone). Two id rules on the
//!   wire: `connect_device` accepts any ENUMERATED unit's id; every other
//!   keyed command resolves only an OPEN device's id.
//!
//! ## What later lots change (for orientation, see the plan on issue #25)
//!
//! - Lot E: N open devices (runtime map + N stream loops, ingest routed by
//!   `device_id`), a second virtual unit, slot-keyed endpoint ids.
//! - Lot F: programs/REST/scripts per device. F1 delivered the per-device
//!   program gate ([`runtime::DeviceRuntime::try_program_lock`]) and
//!   device-keyed `script_run` (`ScriptControl` no longer retains a device;
//!   the command builds each run's `Session` from its resolved runtime).
//!
//! Lot-C residues, deliberate: `RestControl` and `Session` keep their
//! loose-Arc constructors (frozen for the examples + A/B bench);
//! `RestControl` is built FROM the default runtime — the QA40x-compatible
//! REST scheme stays default-device-bound by specification.

pub mod analyzer;
pub mod caps;
pub mod error;
pub mod id;
pub mod registry;
pub mod runtime;
pub mod source;
pub mod usb;
pub mod virt;
pub mod wire;

#[cfg(test)]
pub mod testing;

pub use analyzer::Analyzer;
pub use caps::{CalibrationSource, DeviceCapabilities};
pub use error::DeviceError;
pub use id::{DeviceDescriptor, DeviceId, DeviceIdentity, SourceId, SourceKind, Transport};
pub use registry::{DeviceRegistry, OpenDevice};
pub use runtime::{
    spawn_liveness_monitor, DeviceLost, DeviceRuntime, GeneratorFlags, OpenGeneration,
    OpenUnitCell, ProgramGuard,
};
pub use source::{DeviceHandle, DeviceSource};
pub use wire::{AddedDevice, DeviceEntry, DeviceList};
