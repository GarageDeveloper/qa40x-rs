//! The virtual device source: the embedded `vqa40x-core` simulator as a
//! first-class unit with a pinned serial — enumerable next to real hardware
//! instead of only reachable through the demo fallback.
//!
//! Laziness is preserved: enumeration builds descriptors from the options
//! alone; the `Simulator` is instantiated on first open and kept for the
//! whole app session (its state survives a demo disconnect/reconnect the way
//! a plugged-in unit survives a USB close).
//!
//! Lot B ships ONE unit. Lot E appends a second (data, not structure) so two
//! devices can be exercised without two QA40x on the bench.

use async_trait::async_trait;
use log::info;
use tokio::sync::Mutex;
use vqa40x_core::{SimOptions, Simulator};

use crate::qa40x::transport::demo_sim_options;
use crate::qa40x::Model;

use super::caps::{CalibrationSource, DeviceCapabilities};
use super::error::DeviceError;
use super::id::{DeviceDescriptor, DeviceId, DeviceIdentity, SourceId, SourceKind, Transport};
use super::source::{DeviceHandle, DeviceSource};

/// Options for the `index`-th built-in virtual unit. Index 0 is THE demo
/// device (`demo_sim_options`, pinned serial); later indices re-pin the
/// serial's last digit so a second unit (lot E) is distinguishable.
pub fn demo_unit_options(index: usize) -> SimOptions {
    let mut opts = demo_sim_options();
    if index > 0 {
        // Same 8-hex-digit shape as index 0 so the register-0x1D read-back
        // reformats to the identical string.
        opts.serial = format!("0DE0_{:04X}", 1 + index as u32);
    }
    opts
}

/// One virtual unit: its options (the enumerable identity) and its lazily
/// created simulator.
pub struct VirtualUnit {
    opts: SimOptions,
    sim: Mutex<Option<Simulator>>,
}

impl VirtualUnit {
    pub fn new(opts: SimOptions) -> Self {
        Self { opts, sim: Mutex::new(None) }
    }

    /// The model of the persona, from its PID (the options carry
    /// `vqa40x_core::Model`, the app speaks `qa40x::Model` — the shared PID
    /// is the bridge).
    fn model(&self) -> Model {
        Model::from_pid(self.opts.pid).unwrap_or(Model::Qa403)
    }

    fn unit_key(&self) -> String {
        self.opts.serial.clone()
    }

    /// Create-or-reuse the simulator (state persists across open/close).
    async fn simulator(&self) -> Simulator {
        let mut slot = self.sim.lock().await;
        if slot.is_none() {
            info!(
                "Starting embedded virtual {} (serial {})",
                self.opts.model.name(),
                self.opts.serial
            );
            *slot = Some(Simulator::new(self.opts.clone()));
        }
        slot.as_ref().expect("just created").clone()
    }

    #[cfg(test)]
    pub async fn sim_instantiated(&self) -> bool {
        self.sim.lock().await.is_some()
    }
}

/// The built-in virtual units as a [`DeviceSource`].
pub struct VirtualDeviceSource {
    id: SourceId,
    units: Vec<VirtualUnit>,
}

impl VirtualDeviceSource {
    /// The app's built-in source: the demo QA403 plus a second virtual unit
    /// (issue #25 lot E) so a multi-device bench is exercisable without two
    /// QA40x on the bus. Unit 0 stays THE demo device (`open_virtual` picks
    /// the first free one, so the demo path is unchanged while unit 0 is
    /// free); both simulators stay lazy until opened.
    pub fn builtin() -> Self {
        Self::with_units(vec![
            VirtualUnit::new(demo_unit_options(0)),
            VirtualUnit::new(demo_unit_options(1)),
        ])
    }

    pub fn with_units(units: Vec<VirtualUnit>) -> Self {
        Self { id: SourceId::new("virtual"), units }
    }

    fn descriptor_of(&self, unit: &VirtualUnit) -> DeviceDescriptor {
        let model = unit.model();
        DeviceDescriptor {
            id: DeviceId::new(&self.id, &unit.unit_key()),
            source: self.id.clone(),
            identity: DeviceIdentity {
                model,
                serial: unit.unit_key(),
                product: format!("{} Audio Analyzer (virtual)", model.name()),
                firmware_version: None,
                is_virtual: true,
                serial_synthetic: false,
            },
            capabilities: DeviceCapabilities::for_model(model, true),
            transport: Transport::Virtual,
        }
    }

    #[cfg(test)]
    pub fn units(&self) -> &[VirtualUnit] {
        &self.units
    }
}

#[async_trait]
impl DeviceSource for VirtualDeviceSource {
    fn id(&self) -> &SourceId {
        &self.id
    }

    fn kind(&self) -> SourceKind {
        SourceKind::Virtual
    }

    fn label(&self) -> String {
        "Built-in virtual".to_string()
    }

    fn is_physical(&self) -> bool {
        false
    }

    async fn enumerate(&self) -> Result<Vec<DeviceDescriptor>, DeviceError> {
        // From the options alone — no Simulator is instantiated here.
        Ok(self.units.iter().map(|u| self.descriptor_of(u)).collect())
    }

    async fn open(&self, id: &DeviceId, handle: &DeviceHandle) -> Result<DeviceDescriptor, DeviceError> {
        let unit = self
            .units
            .iter()
            .find(|u| u.unit_key() == id.unit_key())
            .ok_or(DeviceError::NotFound)?;
        let sim = unit.simulator().await;
        let dev = handle.lock().await;
        dev.connect_virtual_sim(sim, unit.model()).await.map_err(DeviceError::from)?;

        // Enrich: serial as the device served it (register 0x1D read-back),
        // firmware version, calibration page.
        let mut desc = self.descriptor_of(unit);
        if let Some(meta) = dev.device_meta().await {
            desc.identity.firmware_version = Some(meta.firmware_version);
            desc.identity.serial = meta.serial;
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

    #[test]
    fn the_demo_serial_is_pinned_and_survives_the_register_roundtrip() {
        // The sim serves the serial through register 0x1D as the first 8 hex
        // digits packed big-endian; the device layer reformats the read-back
        // as "{:04X}_{:04X}". The pinned serial must be a fixed point of that
        // round-trip or the UI would show a different serial than enumerated.
        let opts = demo_unit_options(0);
        let digits: String = opts.serial.chars().filter(|c| *c != '_').collect();
        let v = u32::from_str_radix(&digits, 16).expect("8 hex digits");
        let roundtrip = format!("{:04X}_{:04X}", v >> 16, v & 0xFFFF);
        assert_eq!(roundtrip, opts.serial);
    }

    #[test]
    fn a_second_unit_gets_a_distinct_pinned_serial_of_the_same_shape() {
        let a = demo_unit_options(0);
        let b = demo_unit_options(1);
        assert_ne!(a.serial, b.serial);
        let digits: String = b.serial.chars().filter(|c| *c != '_').collect();
        let v = u32::from_str_radix(&digits, 16).expect("8 hex digits");
        assert_eq!(format!("{:04X}_{:04X}", v >> 16, v & 0xFFFF), b.serial);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_already_attached_error_formats_exactly_as_the_command_reports_it() {
        // End-to-end pin of the user-facing string `connect_virtual_device`
        // produces when the simulator is already imported elsewhere —
        // preserved verbatim from the pre-registry path (#25 lot B review).
        use crate::qa40x::QA40xDevice;

        let sim = Simulator::new(demo_sim_options());
        assert!(sim.try_import(), "first import wins");

        let device = QA40xDevice::new();
        let err = device
            .connect_virtual_sim(sim.clone(), Model::Qa403)
            .await
            .expect_err("second attach must be refused");
        let seam_err = DeviceError::from(err);
        assert_eq!(
            format!("Failed to connect to the virtual device: {}", seam_err),
            "Failed to connect to the virtual device: Device error: Virtual device is already attached"
        );
        sim.release_import();
    }

    #[tokio::test]
    async fn enumeration_does_not_instantiate_the_simulator() {
        let src = VirtualDeviceSource::builtin();
        let descs = src.enumerate().await.expect("virtual enumerate is infallible");
        // Lot E: two built-in units, the demo device FIRST (open_virtual
        // picks the first free one — the demo path must land on unit 0).
        assert_eq!(descs.len(), 2);
        let d = &descs[0];
        assert_eq!(d.id.as_str(), format!("virtual/{}", demo_unit_options(0).serial));
        assert_eq!(descs[1].id.as_str(), format!("virtual/{}", demo_unit_options(1).serial));
        for d in &descs {
            assert!(d.identity.is_virtual);
            assert_eq!(d.identity.model, Model::Qa403);
            assert!(d.capabilities.sample_rates_hz.contains(&384_000));
            assert!(!d.capabilities.supports_flash);
        }
        // The laziness invariant: enumerate() must never boot a simulator.
        assert!(!src.units()[0].sim_instantiated().await);
        assert!(!src.units()[1].sim_instantiated().await);
    }
}
