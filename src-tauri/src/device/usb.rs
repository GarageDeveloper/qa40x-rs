//! The USB device source: the ONE place the app scans the bus.
//!
//! `QA40xDevice`'s presence checks and `connect()` delegate here, so the
//! family predicate (VID 0x16C0 + a known PID) lives in exactly one place.
//! Opening is **by unit key** (serial, else bus path) — `open()` never takes
//! "the first device on the bus"; only the legacy `connect()` path does,
//! through [`first_device_info`].
//!
//! Unit keys are assigned per SCAN: normally the serial alone, but two units
//! reporting the same serial string are disambiguated with their bus path
//! (`<serial>@path-<bus>-<chain>`) instead of silently collapsing into one
//! enumerated device — losing a unit to a key collision is exactly the
//! failure #25 exists to prevent. The price is that a colliding unit's key
//! changes when its twin is unplugged; a unique serial always keys as
//! itself.
//!
//! A deliberate cost: opening rescans the bus (enumerate happened earlier,
//! possibly seconds ago) rather than holding a stale `nusb::DeviceInfo`.
//! A few ms per connect, and the info is always current.

use async_trait::async_trait;
use log::info;

use crate::qa40x::{Model, QA40xError, QA40X_VID};

use super::caps::{CalibrationSource, DeviceCapabilities};
use super::error::DeviceError;
use super::id::{DeviceDescriptor, DeviceId, DeviceIdentity, SourceId, SourceKind, Transport};
use super::source::{DeviceHandle, DeviceSource};

/// One QA40x unit seen on the bus — plain data extracted from
/// `nusb::DeviceInfo` so descriptor building is purely testable.
#[derive(Clone, Debug, PartialEq)]
pub struct UsbUnit {
    pub model: Model,
    pub vid: u16,
    pub pid: u16,
    pub serial: Option<String>,
    pub product: Option<String>,
    pub bus_id: String,
    pub port_chain: Vec<u8>,
    /// Scan-assigned unique key (see [`keys_for`]). Empty until assigned.
    key: String,
}

impl UsbUnit {
    /// The stable key identifying this unit within the USB source, as
    /// assigned by the scan ([`keys_for`]).
    pub fn unit_key(&self) -> &str {
        &self.key
    }

    /// The unit exposes no serial string, so its identity comes from the bus
    /// path — stable per PORT, not per unit; flagged so the UI can say so.
    pub fn serial_synthetic(&self) -> bool {
        !matches!(&self.serial, Some(s) if !s.is_empty())
    }

    /// Preferred key before collision handling: the serial when present.
    fn base_key(&self) -> String {
        match &self.serial {
            Some(s) if !s.is_empty() => s.clone(),
            _ => self.path_key(),
        }
    }

    /// The bus-path key: unique per port within one scan.
    fn path_key(&self) -> String {
        let chain: Vec<String> = self.port_chain.iter().map(u8::to_string).collect();
        format!("path-{}-{}", self.bus_id, chain.join("."))
    }
}

/// The family predicate: is this VID/PID a QA40x we know?
pub fn classify(vid: u16, pid: u16) -> Option<Model> {
    (vid == QA40X_VID).then(|| Model::from_pid(pid)).flatten()
}

/// Unit keys for one scan, index-aligned with `units`: the serial when it is
/// unique in this scan, `<serial>@<path>` when two units report the same
/// serial, the bus path when there is no serial. Pure — the collision policy
/// is testable without a bus.
pub fn keys_for(units: &[UsbUnit]) -> Vec<String> {
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for u in units {
        *counts.entry(u.base_key()).or_insert(0) += 1;
    }
    units
        .iter()
        .map(|u| {
            let base = u.base_key();
            if counts[&base] > 1 && !u.serial_synthetic() {
                format!("{}@{}", base, u.path_key())
            } else {
                base
            }
        })
        .collect()
}

fn unit_of(info: &nusb::DeviceInfo) -> Option<UsbUnit> {
    let model = classify(info.vendor_id(), info.product_id())?;
    Some(UsbUnit {
        model,
        vid: info.vendor_id(),
        pid: info.product_id(),
        serial: info.serial_number().map(str::to_string),
        product: info.product_string().map(str::to_string),
        bus_id: info.bus_id().to_string(),
        port_chain: info.port_chain().to_vec(),
        key: String::new(),
    })
}

/// A bus-scan failure, displayed as the legacy `connect()` displayed it
/// (`Device error: <os error>`) so the user-facing diagnostic is preserved
/// through the registry seam.
fn scan_err(e: nusb::Error) -> DeviceError {
    DeviceError::Device(QA40xError::DeviceError(e.to_string()))
}

/// One scan of the bus: every QA40x with its `DeviceInfo`, keys assigned.
/// The only `nusb::list_devices()` call in the app.
async fn scan() -> Result<Vec<(UsbUnit, nusb::DeviceInfo)>, DeviceError> {
    let devices = nusb::list_devices().await.map_err(scan_err)?;
    let mut pairs: Vec<(UsbUnit, nusb::DeviceInfo)> = devices
        .filter_map(|info| unit_of(&info).map(|u| (u, info)))
        .collect();
    let units: Vec<UsbUnit> = pairs.iter().map(|(u, _)| u.clone()).collect();
    for (pair, key) in pairs.iter_mut().zip(keys_for(&units)) {
        pair.0.key = key;
    }
    Ok(pairs)
}

/// Every QA40x on the bus.
pub async fn list_units() -> Result<Vec<UsbUnit>, DeviceError> {
    Ok(scan().await?.into_iter().map(|(u, _)| u).collect())
}

/// Whether any QA40x is on the bus. Scan failure reads as absent (the
/// pre-registry `is_hardware_present` behavior).
pub async fn any_unit_present() -> bool {
    matches!(list_units().await, Ok(units) if !units.is_empty())
}

/// Whether `u` sits at exactly this bus position. The port is the scan-stable
/// identity (unit KEYS are scan-assigned and a serial twin appearing re-keys
/// both — the lot-D ghost), so per-unit presence matches on it, never on the
/// key. Pure — the policy is testable without a bus.
pub fn matches_port(u: &UsbUnit, bus_id: &str, port_chain: &[u8]) -> bool {
    u.bus_id == bus_id && u.port_chain == port_chain
}

/// Whether a QA40x is at this exact bus position (issue #25 lot E): the
/// per-unit presence probe — with N units open, unplugging one must be
/// detected as THAT unit's loss, never masked by its siblings still being on
/// the bus. Scan failure reads as absent, same as [`any_unit_present`].
/// Deliberate consequence: a unit replugged into a DIFFERENT port reads as
/// lost — correct, since its claim died with the old port.
pub async fn unit_present_at(bus_id: &str, port_chain: &[u8]) -> bool {
    matches!(
        list_units().await,
        Ok(units) if units.iter().any(|u| matches_port(u, bus_id, port_chain))
    )
}

/// The first QA40x on the bus, as pre-registry `connect()` picked it.
pub async fn first_device_info() -> Result<nusb::DeviceInfo, DeviceError> {
    scan()
        .await?
        .into_iter()
        .next()
        .map(|(_, info)| info)
        .ok_or(DeviceError::NotFound)
}

/// Rescan the bus and find the unit with `unit_key` — open-by-serial, never
/// first-match. Returns the unit WITH its scan-assigned key so descriptors
/// built from it carry the id that was asked for.
pub async fn find_unit(unit_key: &str) -> Result<(UsbUnit, nusb::DeviceInfo), DeviceError> {
    scan()
        .await?
        .into_iter()
        .find(|(u, _)| u.unit_key() == unit_key)
        .ok_or(DeviceError::NotFound)
}

/// Descriptor for an enumerated (unopened) unit — pure, so it is testable
/// without a bus. Firmware version and calibration source stay unknown
/// until the unit is opened.
pub fn descriptor_for(unit: &UsbUnit, source: &SourceId) -> DeviceDescriptor {
    DeviceDescriptor {
        id: DeviceId::new(source, unit.unit_key()),
        source: source.clone(),
        identity: DeviceIdentity {
            model: unit.model,
            serial: unit.unit_key().to_string(),
            product: unit
                .product
                .clone()
                .unwrap_or_else(|| format!("{} Audio Analyzer", unit.model.name())),
            firmware_version: None,
            is_virtual: false,
            serial_synthetic: unit.serial_synthetic(),
        },
        capabilities: DeviceCapabilities::for_model(unit.model, false),
        transport: Transport::Usb {
            vid: unit.vid,
            pid: unit.pid,
            bus_id: unit.bus_id.clone(),
            port_chain: unit.port_chain.clone(),
        },
    }
}

/// The local USB bus as a [`DeviceSource`].
pub struct UsbDeviceSource {
    id: SourceId,
}

impl UsbDeviceSource {
    pub fn new() -> Self {
        Self { id: SourceId::new("usb") }
    }
}

impl Default for UsbDeviceSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl DeviceSource for UsbDeviceSource {
    fn id(&self) -> &SourceId {
        &self.id
    }

    fn kind(&self) -> SourceKind {
        SourceKind::Usb
    }

    fn label(&self) -> String {
        "USB".to_string()
    }

    fn is_physical(&self) -> bool {
        true
    }

    async fn enumerate(&self) -> Result<Vec<DeviceDescriptor>, DeviceError> {
        Ok(list_units()
            .await?
            .iter()
            .map(|u| descriptor_for(u, &self.id))
            .collect())
    }

    async fn open(&self, id: &DeviceId, handle: &DeviceHandle) -> Result<DeviceDescriptor, DeviceError> {
        let dev = handle.lock().await;
        // Same ordering as the legacy connect(): release whatever is claimed
        // FIRST (so a reconnect never fails on our own exclusive claim),
        // then rescan and match — by unit key, not first-on-the-bus.
        dev.release_claim().await;
        let (unit, info) = find_unit(id.unit_key()).await?;
        info!("USB source: opening {} (key {})", unit.model.name(), id.unit_key());
        dev.connect_to_usb(info).await.map_err(DeviceError::from)?;

        // Enrich with what only an open unit can tell.
        let mut desc = descriptor_for(&unit, &self.id);
        if let Some(meta) = dev.device_meta().await {
            desc.identity.firmware_version = Some(meta.firmware_version);
        }
        let cal = match dev.factory_calibration_page_len().await {
            Some(page_bytes) => CalibrationSource::FactoryEeprom { page_bytes },
            None => CalibrationSource::NominalFallback,
        };
        desc.capabilities = desc
            .capabilities
            .with_calibration(cal)
            .with_i2s(dev.i2s_available().await);
        Ok(desc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qa40x::transport::demo_sim_options;
    use crate::qa40x::{QA40xDevice, QA402_PID, QA403_PID};
    use std::sync::Arc;
    use tokio::sync::Mutex;
    use vqa40x_core::Simulator;

    fn unit(serial: Option<&str>, port: u8) -> UsbUnit {
        UsbUnit {
            model: Model::Qa403,
            vid: QA40X_VID,
            pid: QA403_PID,
            serial: serial.map(str::to_string),
            product: Some("QA403 Audio Analyzer".into()),
            bus_id: "20".into(),
            port_chain: vec![2, port],
            key: String::new(),
        }
    }

    fn keyed(serial: Option<&str>, port: u8) -> UsbUnit {
        let mut u = unit(serial, port);
        u.key = keys_for(std::slice::from_ref(&u)).remove(0);
        u
    }

    #[test]
    fn classify_accepts_exactly_the_known_family() {
        assert_eq!(classify(QA40X_VID, QA402_PID), Some(Model::Qa402));
        assert_eq!(classify(QA40X_VID, QA403_PID), Some(Model::Qa403));
        // Right PID on the wrong VID is NOT a QA40x.
        assert_eq!(classify(0x1234, QA403_PID), None);
        // Unknown PID on the right VID is rejected (another Teensy-VID device).
        assert_eq!(classify(QA40X_VID, 0x0001), None);
    }

    #[test]
    fn unit_key_prefers_the_serial() {
        let u = keyed(Some("AB12_CD34"), 1);
        assert_eq!(u.unit_key(), "AB12_CD34");
        assert!(!u.serial_synthetic());
    }

    #[test]
    fn unit_key_falls_back_to_the_bus_path_and_flags_it() {
        for missing in [None, Some("")] {
            let u = keyed(missing, 1);
            assert_eq!(u.unit_key(), "path-20-2.1");
            assert!(u.serial_synthetic(), "a path key must be flagged synthetic");
        }
    }

    #[test]
    fn colliding_serials_are_disambiguated_with_the_bus_path_not_collapsed() {
        // Two units reporting the same iSerial (the #25 door: both must stay
        // selectable — dedupe-by-id would silently drop one otherwise).
        let units = vec![unit(Some("AB12_CD34"), 1), unit(Some("AB12_CD34"), 2)];
        let keys = keys_for(&units);
        assert_eq!(keys[0], "AB12_CD34@path-20-2.1");
        assert_eq!(keys[1], "AB12_CD34@path-20-2.2");
        assert_ne!(keys[0], keys[1]);

        // A third unit with a UNIQUE serial keeps its plain key.
        let units = vec![unit(Some("AB12_CD34"), 1), unit(Some("AB12_CD34"), 2), unit(Some("EE00_0001"), 3)];
        assert_eq!(keys_for(&units)[2], "EE00_0001");
    }

    #[test]
    fn matches_port_requires_the_exact_bus_position() {
        let u = keyed(Some("AB12_CD34"), 1); // bus "20", chain [2, 1]
        assert!(matches_port(&u, "20", &[2, 1]));
        assert!(!matches_port(&u, "21", &[2, 1]), "a different bus is a different position");
        assert!(!matches_port(&u, "20", &[2, 2]), "a different port is a different position");
        assert!(!matches_port(&u, "20", &[2]), "a chain prefix is not the position");
    }

    #[tokio::test]
    async fn unit_present_at_an_impossible_position_is_absent_not_an_error() {
        // Bus ids are OS-assigned numeric-ish strings; this one cannot exist,
        // so the probe must read absent on ANY machine (with or without a
        // QA40x plugged) — the monitor tests rely on that hermeticity.
        assert!(!unit_present_at("test-no-such-bus", &[42, 7]).await);
    }

    #[test]
    fn descriptor_is_built_purely_from_the_unit() {
        let src = SourceId::new("usb");
        let d = descriptor_for(&keyed(Some("AB12_CD34"), 1), &src);
        assert_eq!(d.id.as_str(), "usb/AB12_CD34");
        assert_eq!(d.identity.serial, "AB12_CD34");
        assert_eq!(d.identity.firmware_version, None, "unopened: no firmware yet");
        assert_eq!(d.capabilities.calibration, CalibrationSource::Unknown);
        assert!(!d.identity.is_virtual);
        assert!(matches!(
            &d.transport,
            Transport::Usb { vid, pid, bus_id, port_chain }
                if *vid == QA40X_VID && *pid == QA403_PID && bus_id == "20" && port_chain == &vec![2, 1]
        ));
    }

    #[tokio::test]
    async fn list_units_succeeds_on_a_machine_without_a_qa40x() {
        // The scan itself must be Ok (possibly empty) — a machine with no
        // QA40x is the normal case for CI.
        let units = list_units().await;
        assert!(units.is_ok(), "bus scan failed: {:?}", units.err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn open_releases_the_prior_claim_before_scanning_for_the_unit() {
        // The past-bug class this ordering guards against: "could not claim
        // interface 0: exclusive access" on reconnect. Attach the handle to a
        // virtual session, then ask the USB source for a unit that cannot
        // exist on the bus: the open FAILS, but the prior claim must already
        // be gone — proof that release precedes the rescan/match, not only
        // the successful connect.
        let device = QA40xDevice::new();
        let sim = Simulator::new(demo_sim_options());
        device
            .connect_virtual_sim(sim.clone(), Model::Qa403)
            .await
            .expect("attach the virtual session");
        let handle: DeviceHandle = Arc::new(Mutex::new(device));
        assert!(handle.lock().await.is_connected().await);

        let src = UsbDeviceSource::new();
        let impossible = DeviceId::new(&SourceId::new("usb"), "NO_SUCH_UNIT_KEY");
        let err = src.open(&impossible, &handle).await.expect_err("no such unit on the bus");
        assert!(matches!(err, DeviceError::NotFound));

        // Release happened even though the match failed → it came first.
        assert!(
            !handle.lock().await.is_connected().await,
            "the prior claim must be released before the unit lookup"
        );
        assert!(
            sim.try_import(),
            "the virtual import must have been released by the failed USB open"
        );
        sim.release_import();
    }
}
