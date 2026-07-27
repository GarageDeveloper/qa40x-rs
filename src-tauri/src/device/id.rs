//! Identity types for the device seam: which source a unit came from, which
//! unit it is, and what it identified as.
//!
//! Serde only, deliberately **no ts-rs**: nothing here is on the wire in
//! lot B (`src/gen` must stay byte-identical). Lot D adds the TS export when
//! the frontend devices slice lands.

use crate::qa40x::Model;
use serde::{Deserialize, Serialize};

use super::caps::DeviceCapabilities;

/// What kind of place devices come from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceKind {
    /// The local USB bus.
    Usb,
    /// The embedded in-process simulator.
    Virtual,
    // Issue #33 door: a remote agent source (`agent@host:port`) slots in here
    // without touching the traits — see the module doc.
}

/// Identifies one [`super::DeviceSource`], e.g. `"usb"` or `"virtual"`. A
/// future agent source uses `"agent@host:port"` — which is why [`DeviceId`]
/// splits at the FIRST `/`, never the last.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SourceId(String);

impl SourceId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for SourceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Identifies one unit across all sources: `"<source>/<unit-key>"`, e.g.
/// `"usb/AB12_CD34"` or `"virtual/0DE0_0001"`. The unit key is the serial
/// when the unit has one, else a bus-path key (see
/// [`super::usb::UsbUnit::unit_key`]).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DeviceId(String);

impl DeviceId {
    pub fn new(source: &SourceId, unit_key: &str) -> Self {
        Self(format!("{}/{}", source.as_str(), unit_key))
    }

    /// The source part (before the first `/`).
    pub fn source(&self) -> &str {
        self.0.split_once('/').map_or(self.0.as_str(), |(s, _)| s)
    }

    /// The unit key part (after the first `/`).
    pub fn unit_key(&self) -> &str {
        self.0.split_once('/').map_or("", |(_, k)| k)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for DeviceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// What a unit identified as. At enumerate time this is what the bus/options
/// say; `firmware_version` is `None` until the unit has been opened (the
/// version lives in register 0x10, read during bring-up).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeviceIdentity {
    pub model: Model,
    /// Unit serial, e.g. `"AB12_CD34"`. May be synthetic — see
    /// `serial_synthetic`.
    pub serial: String,
    /// USB product string, e.g. `"QA402 Audio Analyzer"`.
    pub product: String,
    /// Firmware build number (register 0x10); `None` until opened.
    pub firmware_version: Option<u32>,
    /// True for the embedded simulator.
    pub is_virtual: bool,
    /// The serial came from the bus path (the unit exposes no serial
    /// string), so it is stable per port, not per unit.
    pub serial_synthetic: bool,
}

/// How the unit is reached.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Transport {
    Usb {
        vid: u16,
        pid: u16,
        bus_id: String,
        port_chain: Vec<u8>,
    },
    Virtual,
}

/// One enumerated unit: identity + capabilities + how to reach it. Plain
/// serializable data — a remote (#33) source can ship these across a
/// network without the receiving side knowing anything about the transport.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeviceDescriptor {
    pub id: DeviceId,
    pub source: SourceId,
    pub identity: DeviceIdentity,
    pub capabilities: DeviceCapabilities,
    pub transport: Transport,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_id_composes_and_splits_at_the_first_slash() {
        let id = DeviceId::new(&SourceId::new("usb"), "AB12_CD34");
        assert_eq!(id.as_str(), "usb/AB12_CD34");
        assert_eq!(id.source(), "usb");
        assert_eq!(id.unit_key(), "AB12_CD34");
    }

    #[test]
    fn same_unit_key_on_different_sources_never_collides() {
        let usb = DeviceId::new(&SourceId::new("usb"), "AB12_CD34");
        let virt = DeviceId::new(&SourceId::new("virtual"), "AB12_CD34");
        assert_ne!(usb, virt);
    }

    #[test]
    fn an_agent_style_source_id_splits_at_the_first_slash_only() {
        // The #33 door: "agent@10.0.0.5:7402" as a source id must round-trip
        // even if a unit key ever contains a '/' of its own.
        let src = SourceId::new("agent@10.0.0.5:7402");
        let id = DeviceId::new(&src, "AB12/extra");
        assert_eq!(id.source(), "agent@10.0.0.5:7402");
        assert_eq!(id.unit_key(), "AB12/extra");
    }

    #[test]
    fn a_sourceless_id_degrades_without_panicking() {
        let id = DeviceId("no-slash".into());
        assert_eq!(id.source(), "no-slash");
        assert_eq!(id.unit_key(), "");
    }
}
