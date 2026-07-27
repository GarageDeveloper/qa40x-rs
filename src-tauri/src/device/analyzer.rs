//! The narrow analyzer control surface (issue #25 lot B).
//!
//! Deliberately small: identity, capabilities, the three configuration
//! setters, telemetry cache, lifecycle. The acquisition surface
//! (`generate_and_capture*`, `acquire_data`, streaming, level offsets) stays
//! on the concrete `QA40xDevice` in lot B — putting the A/B-critical capture
//! path behind dyn dispatch buys nothing until lot C makes runtime state
//! per-device. A generic sound-card device (target 3 of #25) can satisfy
//! this trait without being a QA40x — proven by `FakeAnalyzer` in
//! [`super::testing`].

use async_trait::async_trait;

use crate::qa40x::{DeviceConfig, InputGain, OutputGain, QA40xDevice, SampleRate, Telemetry};

use super::caps::{CalibrationSource, DeviceCapabilities};
use super::error::DeviceError;
use super::id::DeviceIdentity;

#[async_trait]
pub trait Analyzer: Send + Sync {
    /// Whether the device is logically open.
    async fn is_connected(&self) -> bool;
    /// Identity read at open; `None` until connected.
    async fn identity(&self) -> Option<DeviceIdentity>;
    /// Capability record of the open unit; `None` until connected.
    async fn capabilities(&self) -> Option<DeviceCapabilities>;
    /// Current cached configuration.
    async fn config(&self) -> DeviceConfig;
    async fn set_input_range(&self, gain: InputGain) -> Result<(), DeviceError>;
    async fn set_output_range(&self, gain: OutputGain) -> Result<(), DeviceError>;
    async fn set_sample_rate(&self, rate: SampleRate) -> Result<(), DeviceError>;
    /// Telemetry captured by the most recent keepalive (no device I/O).
    async fn last_telemetry(&self) -> Option<Telemetry>;
    /// Close the device, leaving it in its safe state.
    async fn disconnect(&self) -> Result<(), DeviceError>;
}

/// Pure delegation — no logic moves off `QA40xDevice`, no existing caller is
/// rerouted through the trait in lot B.
#[async_trait]
impl Analyzer for QA40xDevice {
    async fn is_connected(&self) -> bool {
        QA40xDevice::is_connected(self).await
    }

    async fn identity(&self) -> Option<DeviceIdentity> {
        let model = QA40xDevice::model(self).await?;
        let meta = QA40xDevice::device_meta(self).await?;
        Some(DeviceIdentity {
            model,
            serial: meta.serial,
            product: meta.product,
            firmware_version: Some(meta.firmware_version),
            is_virtual: meta.is_virtual,
            // Whether the serial was synthesized from the bus path is an
            // enumeration-time fact (the descriptor carries it); the open
            // device itself always reports what identity it serves.
            serial_synthetic: false,
        })
    }

    async fn capabilities(&self) -> Option<DeviceCapabilities> {
        let model = QA40xDevice::model(self).await?;
        let caps = DeviceCapabilities::for_model(model, self.is_virtual());
        let cal = match self.factory_calibration_page_len().await {
            Some(page_bytes) => CalibrationSource::FactoryEeprom { page_bytes },
            None => CalibrationSource::NominalFallback,
        };
        Some(caps.with_calibration(cal))
    }

    async fn config(&self) -> DeviceConfig {
        self.get_config().await
    }

    async fn set_input_range(&self, gain: InputGain) -> Result<(), DeviceError> {
        self.set_input_gain(gain).await.map_err(DeviceError::from)
    }

    async fn set_output_range(&self, gain: OutputGain) -> Result<(), DeviceError> {
        self.set_output_gain(gain).await.map_err(DeviceError::from)
    }

    async fn set_sample_rate(&self, rate: SampleRate) -> Result<(), DeviceError> {
        QA40xDevice::set_sample_rate(self, rate).await.map_err(DeviceError::from)
    }

    async fn last_telemetry(&self) -> Option<Telemetry> {
        QA40xDevice::last_telemetry(self).await
    }

    async fn disconnect(&self) -> Result<(), DeviceError> {
        QA40xDevice::disconnect(self).await.map(|_| ()).map_err(DeviceError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_trait_is_object_safe() {
        // Registry/lot-D code will hold `dyn Analyzer` — pin object safety.
        fn _takes(_: Box<dyn Analyzer>) {}
        fn _boxes(dev: QA40xDevice) -> Box<dyn Analyzer> {
            Box::new(dev)
        }
    }

    #[tokio::test]
    async fn an_unopened_device_reports_disconnected_through_the_trait() {
        let dev = QA40xDevice::new();
        let dyn_dev: &dyn Analyzer = &dev;
        assert!(!dyn_dev.is_connected().await);
        assert!(dyn_dev.identity().await.is_none());
        assert!(dyn_dev.capabilities().await.is_none());
    }
}
