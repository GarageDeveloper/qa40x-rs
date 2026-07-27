//! The USB device source: the ONE place the app scans the bus.
//!
//! `QA40xDevice`'s presence checks and `connect()` delegate here, so the
//! family predicate (VID 0x16C0 + a known PID) lives in exactly one place.
//! Opening is **by unit key** (serial, else bus path) — `open()` never takes
//! "the first device on the bus"; only the legacy `connect()` path does,
//! through [`first_device_info`].
//!
//! A deliberate cost: opening rescans the bus (enumerate happened earlier,
//! possibly seconds ago) rather than holding a stale `nusb::DeviceInfo`.
//! A few ms per connect, and the info is always current.

use async_trait::async_trait;
use log::info;

use crate::qa40x::{Model, QA40X_VID};

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
}

impl UsbUnit {
    /// The stable key identifying this unit within the USB source: its
    /// serial, or a bus-path key (`path-<bus>-<port.chain>`) when the unit
    /// exposes no serial string. The path key is stable per PORT, not per
    /// unit — [`Self::serial_synthetic`] flags it so the UI can say so.
    pub fn unit_key(&self) -> String {
        match &self.serial {
            Some(s) if !s.is_empty() => s.clone(),
            _ => {
                let chain: Vec<String> = self.port_chain.iter().map(u8::to_string).collect();
                format!("path-{}-{}", self.bus_id, chain.join("."))
            }
        }
    }

    pub fn serial_synthetic(&self) -> bool {
        !matches!(&self.serial, Some(s) if !s.is_empty())
    }
}

/// The family predicate: is this VID/PID a QA40x we know?
pub fn classify(vid: u16, pid: u16) -> Option<Model> {
    (vid == QA40X_VID).then(|| Model::from_pid(pid)).flatten()
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
    })
}

/// Every QA40x on the bus. The only `nusb::list_devices()` call in the app.
pub async fn list_units() -> Result<Vec<UsbUnit>, DeviceError> {
    let devices = nusb::list_devices()
        .await
        .map_err(|e| DeviceError::Source(e.to_string()))?;
    Ok(devices.filter_map(|info| unit_of(&info)).collect())
}

/// Whether any QA40x is on the bus. Scan failure reads as absent (the
/// pre-registry `is_hardware_present` behavior).
pub async fn any_unit_present() -> bool {
    matches!(list_units().await, Ok(units) if !units.is_empty())
}

/// The first QA40x on the bus, as pre-registry `connect()` picked it.
pub async fn first_device_info() -> Result<nusb::DeviceInfo, DeviceError> {
    let mut devices = nusb::list_devices()
        .await
        .map_err(|e| DeviceError::Source(e.to_string()))?;
    devices
        .find(|info| classify(info.vendor_id(), info.product_id()).is_some())
        .ok_or(DeviceError::NotFound)
}

/// Rescan the bus and find the unit with `unit_key` — open-by-serial, never
/// first-match.
pub async fn find_device_info(unit_key: &str) -> Result<nusb::DeviceInfo, DeviceError> {
    let mut devices = nusb::list_devices()
        .await
        .map_err(|e| DeviceError::Source(e.to_string()))?;
    devices
        .find(|info| unit_of(info).is_some_and(|u| u.unit_key() == unit_key))
        .ok_or(DeviceError::NotFound)
}

/// Descriptor for an enumerated (unopened) unit — pure, so it is testable
/// without a bus. Firmware version and calibration source stay unknown
/// until the unit is opened.
pub fn descriptor_for(unit: &UsbUnit, source: &SourceId) -> DeviceDescriptor {
    DeviceDescriptor {
        id: DeviceId::new(source, &unit.unit_key()),
        source: source.clone(),
        identity: DeviceIdentity {
            model: unit.model,
            serial: unit.unit_key(),
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
        let info = find_device_info(id.unit_key()).await?;
        let unit = unit_of(&info).ok_or(DeviceError::NotFound)?;
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
        desc.capabilities = desc.capabilities.with_calibration(cal);
        Ok(desc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qa40x::{QA402_PID, QA403_PID};

    fn unit(serial: Option<&str>) -> UsbUnit {
        UsbUnit {
            model: Model::Qa403,
            vid: QA40X_VID,
            pid: QA403_PID,
            serial: serial.map(str::to_string),
            product: Some("QA403 Audio Analyzer".into()),
            bus_id: "20".into(),
            port_chain: vec![2, 1],
        }
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
        let u = unit(Some("AB12_CD34"));
        assert_eq!(u.unit_key(), "AB12_CD34");
        assert!(!u.serial_synthetic());
    }

    #[test]
    fn unit_key_falls_back_to_the_bus_path_and_flags_it() {
        for missing in [None, Some("")] {
            let u = unit(missing);
            assert_eq!(u.unit_key(), "path-20-2.1");
            assert!(u.serial_synthetic(), "a path key must be flagged synthetic");
        }
    }

    #[test]
    fn descriptor_is_built_purely_from_the_unit() {
        let src = SourceId::new("usb");
        let d = descriptor_for(&unit(Some("AB12_CD34")), &src);
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
}
