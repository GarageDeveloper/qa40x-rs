//! The [`DeviceSource`] trait: one place devices come from.

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::qa40x::QA40xDevice;

use super::error::DeviceError;
use super::id::{DeviceDescriptor, DeviceId, SourceId, SourceKind};

/// Lot B: the ONE device object of the session (the same
/// `Arc<Mutex<QA40xDevice>>` REST/scripting/stream already hold). Lot C
/// replaces the alias with a per-device handle struct — this trait's
/// signatures do not change when it does.
pub type DeviceHandle = Arc<Mutex<QA40xDevice>>;

/// A place devices come from: the USB bus, the embedded simulator, later a
/// remote agent (issue #33).
#[async_trait]
pub trait DeviceSource: Send + Sync {
    fn id(&self) -> &SourceId;

    fn kind(&self) -> SourceKind;

    /// Human-readable label for source-level UI ("USB", "Built-in virtual").
    fn label(&self) -> String;

    /// Whether this source's units are physical hardware on a bus (USB: yes;
    /// virtual: no). Backs `is_hardware_present` / the demo hand-over.
    fn is_physical(&self) -> bool;

    /// Every unit this source can currently offer — N per source (the #33
    /// door: one USB/IP agent may host several units). Async, fallible,
    /// latency-tolerant, and side-effect free: enumeration must NOT open,
    /// claim, or instantiate anything.
    async fn enumerate(&self) -> Result<Vec<DeviceDescriptor>, DeviceError>;

    /// Open the unit `id` onto `handle` (releasing whatever the handle held
    /// first). Returns the descriptor ENRICHED by the open — firmware
    /// version and calibration source are only knowable once the unit is up.
    async fn open(&self, id: &DeviceId, handle: &DeviceHandle) -> Result<DeviceDescriptor, DeviceError>;
}
