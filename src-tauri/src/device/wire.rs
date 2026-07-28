//! Wire DTOs for the frontend devices slice (issue #25 lot D).
//!
//! [`DeviceEntry`] is a FLAT projection of [`DeviceDescriptor`] — identity
//! types stay internal (see the [`super::id`] module doc): ids travel as
//! plain strings and `model` carries the DISPLAY name (`"QA402"`), never the
//! `Model` enum variant (`"Qa402"`), which is a live display trap.

use serde::Serialize;

use super::caps::DeviceCapabilities;
use super::id::{DeviceDescriptor, SourceKind};

/// One enumerated unit as the frontend sees it.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DeviceEntry {
    /// Full unit id, `"<source>/<unit-key>"`, e.g. `"usb/AB12_CD34"` — the
    /// value the frontend passes back as a command's optional `deviceId`.
    pub id: String,
    /// The source's id, e.g. `"usb"` or `"virtual"`.
    pub source_id: String,
    pub source_kind: SourceKind,
    /// Human-readable source label, e.g. `"USB"` / `"Built-in virtual"`.
    pub source_label: String,
    /// Model DISPLAY name (`"QA402"` / `"QA403"`).
    pub model: String,
    pub serial: String,
    /// The serial came from the bus path (stable per port, not per unit).
    pub serial_synthetic: bool,
    pub product: String,
    /// Firmware build number; `None` until the unit has been opened (the
    /// version lives in register 0x10, read during bring-up).
    pub firmware_version: Option<u32>,
    pub is_virtual: bool,
    pub capabilities: DeviceCapabilities,
    /// Whether this unit is currently open on a runtime.
    pub open: bool,
    /// The registry runtime slot this unit is open on (issue #25 lot E) —
    /// `None` when not open. Slot indices are stable for a whole session
    /// (the vector never shrinks), so slot-keyed trace ids survive a
    /// disconnect/reconnect of the same slot; slot 0 is the default device.
    pub slot: Option<u32>,
}

impl DeviceEntry {
    /// `source_kind`/`source_label` come from the [`super::DeviceSource`] the
    /// descriptor was enumerated by — the descriptor itself only names the
    /// source, deliberately (a remote #33 source forwards USB transports but
    /// is not the USB source).
    pub fn from_descriptor(
        desc: &DeviceDescriptor,
        source_kind: SourceKind,
        source_label: String,
        open: bool,
        slot: Option<u32>,
    ) -> Self {
        Self {
            id: desc.id.as_str().to_string(),
            source_id: desc.source.as_str().to_string(),
            source_kind,
            source_label,
            model: desc.identity.model.name().to_string(),
            serial: desc.identity.serial.clone(),
            serial_synthetic: desc.identity.serial_synthetic,
            product: desc.identity.product.clone(),
            firmware_version: desc.identity.firmware_version,
            is_virtual: desc.identity.is_virtual,
            capabilities: desc.capabilities.clone(),
            open,
            slot,
        }
    }
}

/// The `list_devices` answer: every unit the registry can currently offer
/// (enumeration union + any open unit that stopped enumerating). `open` is a
/// list from day one so lot E's N-device answer is a routing change, not a
/// wire change.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DeviceList {
    pub devices: Vec<DeviceEntry>,
    /// Ids of the units currently open (lot C/D: at most one).
    pub open: Vec<String>,
}

/// The `connect_additional_device` answer (issue #25 lot E4): the opened
/// unit's id and its runtime slot, IN the connect answer itself — the
/// frontend mints the slot's session with the id already adopted, so there
/// is no window where the session is unroutable (`sessionArgs` returning
/// `{}` would otherwise let an arg-less command drive the DEFAULT runtime —
/// the E2 wire-safety gate this closes for good).
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct AddedDevice {
    /// Full unit id, `"<source>/<unit-key>"` — what the frontend passes
    /// back as the session's `deviceId`.
    pub device_id: String,
    /// The registry runtime slot the unit was opened on (always ≥ 1: an
    /// additional device never lands on the default slot).
    pub slot: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::id::{DeviceId, DeviceIdentity, SourceId, Transport};
    use crate::qa40x::Model;

    fn descriptor(model: Model) -> DeviceDescriptor {
        let source = SourceId::new("usb");
        DeviceDescriptor {
            id: DeviceId::new(&source, "AB12_CD34"),
            source,
            identity: DeviceIdentity {
                model,
                serial: "AB12_CD34".into(),
                product: "QA402 Audio Analyzer".into(),
                firmware_version: None,
                is_virtual: false,
                serial_synthetic: false,
            },
            capabilities: DeviceCapabilities::for_model(model, false),
            transport: Transport::Usb {
                vid: 0x16c0,
                pid: 0x4e37,
                bus_id: "1".into(),
                port_chain: vec![1],
            },
        }
    }

    #[test]
    fn the_entry_carries_the_display_model_name_not_the_enum_variant() {
        let entry = DeviceEntry::from_descriptor(
            &descriptor(Model::Qa402),
            SourceKind::Usb,
            "USB".into(),
            false,
            None,
        );
        // serde would render the Model enum as "Qa402" — the DTO must ship
        // what the UI prints.
        assert_eq!(entry.model, "QA402");
        assert_eq!(entry.id, "usb/AB12_CD34");
        assert_eq!(entry.source_id, "usb");
        assert_eq!(entry.source_kind, SourceKind::Usb);
        assert!(!entry.open);
        assert_eq!(entry.slot, None, "not open ⇒ no slot");
        assert_eq!(entry.firmware_version, None);
    }

    #[test]
    fn the_entry_forwards_capabilities_verbatim() {
        let entry = DeviceEntry::from_descriptor(
            &descriptor(Model::Qa403),
            SourceKind::Usb,
            "USB".into(),
            true,
            Some(1),
        );
        assert_eq!(entry.capabilities.sample_rates_hz, vec![48_000, 96_000, 192_000, 384_000]);
        assert_eq!(entry.capabilities.input_ranges_dbv, vec![0, 6, 12, 18, 24, 30, 36, 42]);
        assert_eq!(entry.capabilities.output_ranges_dbv, vec![-12, -2, 8, 18]);
        assert!(entry.open);
        assert_eq!(entry.slot, Some(1));
    }
}
