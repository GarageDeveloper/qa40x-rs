//! Test doubles for the device seam. `FakeSource` proves the registry works
//! against ANY source; `FakeAnalyzer` proves [`super::Analyzer`] can be
//! satisfied by something that is not a QA40x (target 3 of #25).

use std::sync::Mutex as StdMutex;

use async_trait::async_trait;

use crate::qa40x::{DeviceConfig, InputGain, Model, OutputGain, SampleRate, Telemetry};

use super::analyzer::Analyzer;
use super::caps::{CalibrationSource, DeviceCapabilities};
use super::error::DeviceError;
use super::id::{DeviceDescriptor, DeviceId, DeviceIdentity, SourceId, SourceKind, Transport};
use super::source::{DeviceHandle, DeviceSource};

/// A canned-descriptor source that never touches the device handle.
pub struct FakeSource {
    id: SourceId,
    kind: SourceKind,
    physical: bool,
    descriptors: StdMutex<Vec<DeviceDescriptor>>,
    fail_enumerate: std::sync::atomic::AtomicBool,
    /// Artificial latency inside `open()` — lets lifecycle tests hold an
    /// open in flight while racing a close/second open against it.
    open_delay: Option<std::time::Duration>,
    /// Ids this source was asked to open, in order.
    pub opened: StdMutex<Vec<DeviceId>>,
}

impl FakeSource {
    pub fn new(id: &str, physical: bool, units: &[&str]) -> Self {
        let source = SourceId::new(id);
        let descriptors = units.iter().map(|key| fake_descriptor(&source, key, physical)).collect();
        Self {
            id: source,
            kind: if physical { SourceKind::Usb } else { SourceKind::Virtual },
            physical,
            descriptors: StdMutex::new(descriptors),
            fail_enumerate: std::sync::atomic::AtomicBool::new(false),
            open_delay: None,
            opened: StdMutex::new(Vec::new()),
        }
    }

    pub fn failing(id: &str, physical: bool) -> Self {
        let s = Self::new(id, physical, &[]);
        s.fail_enumerate.store(true, std::sync::atomic::Ordering::SeqCst);
        s
    }

    /// Flip a previously-healthy source into a failing one — for pinning
    /// `list()`'s "open unit whose SOURCE now errors on enumerate" path,
    /// distinct from `vanish()` (source still answers Ok, just without that
    /// unit). A real source can start erroring after an open (bus reset,
    /// backend permission flip) without the unit itself disappearing first.
    pub fn fail_from_now_on(&self) {
        self.fail_enumerate.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// A source whose `open()` takes `delay` — for racing lifecycle tests.
    pub fn slow(id: &str, physical: bool, units: &[&str], delay: std::time::Duration) -> Self {
        let mut s = Self::new(id, physical, units);
        s.open_delay = Some(delay);
        s
    }

    /// Drop `unit_key` from subsequent enumerations — an unplug the source
    /// notices but the registry's bookkeeping hasn't (registry `list()`
    /// tests: an open-but-vanished unit must stay listed).
    pub fn vanish(&self, unit_key: &str) {
        self.descriptors
            .lock()
            .expect("descriptors lock")
            .retain(|d| d.id.unit_key() != unit_key);
    }
}

pub fn fake_descriptor(source: &SourceId, unit_key: &str, physical: bool) -> DeviceDescriptor {
    DeviceDescriptor {
        id: DeviceId::new(source, unit_key),
        source: source.clone(),
        identity: DeviceIdentity {
            model: Model::Qa403,
            serial: unit_key.to_string(),
            product: "QA403 Audio Analyzer".to_string(),
            firmware_version: None,
            is_virtual: !physical,
            serial_synthetic: false,
        },
        capabilities: DeviceCapabilities::for_model(Model::Qa403, !physical),
        transport: if physical {
            Transport::Usb { vid: 0x16C0, pid: 0x4E39, bus_id: "20".into(), port_chain: vec![1] }
        } else {
            Transport::Virtual
        },
    }
}

#[async_trait]
impl DeviceSource for FakeSource {
    fn id(&self) -> &SourceId {
        &self.id
    }

    fn kind(&self) -> SourceKind {
        self.kind
    }

    fn label(&self) -> String {
        format!("Fake {}", self.id)
    }

    fn is_physical(&self) -> bool {
        self.physical
    }

    async fn enumerate(&self) -> Result<Vec<DeviceDescriptor>, DeviceError> {
        if self.fail_enumerate.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(DeviceError::Source("fake enumeration failure".into()));
        }
        Ok(self.descriptors.lock().expect("descriptors lock").clone())
    }

    async fn open(&self, id: &DeviceId, _handle: &DeviceHandle) -> Result<DeviceDescriptor, DeviceError> {
        if let Some(delay) = self.open_delay {
            tokio::time::sleep(delay).await;
        }
        let mut desc = self
            .descriptors
            .lock()
            .expect("descriptors lock")
            .iter()
            .find(|d| &d.id == id)
            .cloned()
            .ok_or(DeviceError::NotFound)?;
        // Enrich like a real source (the `open()` contract): the firmware
        // version and calibration source are only knowable from an open.
        desc.identity.firmware_version = Some(42);
        desc.capabilities = desc
            .capabilities
            .with_calibration(CalibrationSource::FactoryEeprom { page_bytes: 512 });
        self.opened.lock().expect("opened lock").push(id.clone());
        Ok(desc)
    }
}

/// A minimal non-QA40x analyzer: everything lives in plain state, no USB, no
/// registers — the shape a CoreAudio/WASAPI device would take.
pub struct FakeAnalyzer {
    connected: std::sync::atomic::AtomicBool,
    config: StdMutex<DeviceConfig>,
    identity: DeviceIdentity,
    capabilities: DeviceCapabilities,
}

impl FakeAnalyzer {
    pub fn new() -> Self {
        Self {
            connected: std::sync::atomic::AtomicBool::new(true),
            config: StdMutex::new(DeviceConfig::default()),
            identity: DeviceIdentity {
                model: Model::Qa403,
                serial: "FAKE_0001".into(),
                product: "Fake Analyzer".into(),
                firmware_version: Some(1),
                is_virtual: true,
                serial_synthetic: false,
            },
            capabilities: DeviceCapabilities::for_model(Model::Qa403, true)
                .with_calibration(CalibrationSource::User { label: "unit test".into() }),
        }
    }
}

impl Default for FakeAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Analyzer for FakeAnalyzer {
    async fn is_connected(&self) -> bool {
        self.connected.load(std::sync::atomic::Ordering::SeqCst)
    }

    async fn identity(&self) -> Option<DeviceIdentity> {
        Some(self.identity.clone())
    }

    async fn capabilities(&self) -> Option<DeviceCapabilities> {
        Some(self.capabilities.clone())
    }

    async fn config(&self) -> DeviceConfig {
        self.config.lock().expect("config lock").clone()
    }

    async fn set_input_range(&self, gain: InputGain) -> Result<(), DeviceError> {
        self.config.lock().expect("config lock").input_gain = gain;
        Ok(())
    }

    async fn set_output_range(&self, gain: OutputGain) -> Result<(), DeviceError> {
        self.config.lock().expect("config lock").output_gain = gain;
        Ok(())
    }

    async fn set_sample_rate(&self, rate: SampleRate) -> Result<(), DeviceError> {
        self.config.lock().expect("config lock").sample_rate = rate;
        Ok(())
    }

    async fn last_telemetry(&self) -> Option<Telemetry> {
        None
    }

    async fn disconnect(&self) -> Result<(), DeviceError> {
        self.connected.store(false, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_non_qa40x_can_satisfy_the_analyzer_trait() {
        // The target-3 proof: drive a device that has no registers, no USB
        // and no QA40xDevice inside, entirely through `dyn Analyzer`.
        let fake = FakeAnalyzer::new();
        let dev: &dyn Analyzer = &fake;
        assert!(dev.is_connected().await);
        dev.set_sample_rate(SampleRate::Rate96kHz).await.expect("set rate");
        assert_eq!(dev.config().await.sample_rate, SampleRate::Rate96kHz);
        let caps = dev.capabilities().await.expect("caps");
        assert!(matches!(caps.calibration, CalibrationSource::User { .. }));
        dev.disconnect().await.expect("disconnect");
        assert!(!dev.is_connected().await);
    }
}
