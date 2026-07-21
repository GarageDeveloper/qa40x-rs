use crate::audio::frequency_response::{FrequencyResponseData, FrequencyResponseTrace};
use crate::qa40x::{
    error::{QA40xError, Result},
    register::{registers, RegisterOps},
    settle::{SettleDeadline, RANGE_RELAY_SETTLE},
    transport::{demo_sim_options, BulkIn, BulkOut, EndpointQueue, VirtEp},
    types::*,
};
use async_trait::async_trait;
use log::{debug, info};
use nusb::transfer::{Buffer, Bulk, Completion, In, Out};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use vqa40x_core::Simulator;

/// Device identity read at connect: firmware version + serial + product.
#[derive(Clone, Debug, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DeviceMeta {
    /// Detected model name ("QA402" / "QA403"), from the USB product ID.
    pub model: String,
    /// Firmware build number (register 0x10), e.g. 60.
    pub firmware_version: u32,
    /// Unit serial number, e.g. "AB12_CD34".
    pub serial: String,
    /// USB product string, e.g. "QA402 Audio Analyzer".
    pub product: String,
    /// Sample rates (Hz) this model supports — the frontend builds its menu from
    /// this (QA403 adds 384 kHz).
    pub sample_rates: Vec<u32>,
    /// Whether firmware flashing is supported/verified for this model (QA402 only).
    pub supports_flash: bool,
    /// Per-model limits (output span, measurement band, fastest rate). See the
    /// [`Capabilities`] doc for why the output Vrms limits are informational
    /// for now (task #48).
    pub capabilities: Capabilities,
    /// True when this is the embedded virtual device (demo mode), not real
    /// hardware — the UI badges the session so a demo can never be mistaken
    /// for a measurement.
    pub is_virtual: bool,
}

/// Live hardware telemetry, matching the official app's readout. Decoded from
/// registers 0x11/0x12/0x13/0x16 (raw values also returned for verification).
#[derive(Clone, Debug, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct Telemetry {
    pub usb_voltage_v: f32,
    pub usb_current_ma: f32,
    pub iso_current_ma: f32,
    pub temperature_c: f32,
    pub raw_usb_voltage: u32,
    pub raw_usb_current: u32,
    pub raw_iso_current: u32,
    pub raw_extra: u32,
    pub raw_temperature: u32,
}

/// The four bulk endpoints, claimed exclusively at connect. nusb 0.2 replaced
/// `interface.bulk_in/out(addr, ..)` with per-endpoint `Endpoint` objects that
/// own a submission queue; we claim all four up front and submit/collect on
/// them. Each is either a real nusb endpoint or a virtual one over the
/// embedded simulator (demo mode) — same queue semantics either way.
struct ClaimedEndpoints {
    register_write: BulkOut,
    register_read: BulkIn,
    data_write: BulkOut,
    data_read: BulkIn,
}

/// QA40x device controller (QA402 / QA403)
pub struct QA40xDevice {
    device: Arc<Mutex<Option<nusb::Device>>>,
    interface: Arc<Mutex<Option<nusb::Interface>>>,
    /// nusb 0.2 claimed endpoints (submit/next_complete live here).
    eps: Arc<Mutex<Option<ClaimedEndpoints>>>,
    endpoints: UsbEndpoints,
    config: Arc<Mutex<DeviceConfig>>,
    /// Cached raw 512-byte factory calibration page (loaded at connect).
    cal_page: Arc<Mutex<Option<Vec<u8>>>>,
    /// Device identity (firmware version + serial), read at connect.
    meta: Arc<Mutex<Option<DeviceMeta>>>,
    /// Detected model (QA402/QA403), set at connect from the USB product ID.
    /// Used to gate model-specific behaviour (sample rates, firmware flash).
    model: Arc<Mutex<Option<Model>>>,
    /// When the last LINK keepalive ran (idle poll or in-run), for the ~1 Hz
    /// rate limit of the in-run keepalive.
    last_keepalive: Arc<Mutex<Option<std::time::Instant>>>,
    /// Telemetry captured by the most recent keepalive. Lets the UI refresh its
    /// telemetry readout during a run without any USB I/O of its own.
    cached_telemetry: Arc<Mutex<Option<Telemetry>>>,
    /// "Not before T" deadline stamped by range-relay writes (reg 5/6) and
    /// waited out by [`Self::stream_io`] before the next capture — never
    /// inside one. See [`crate::qa40x::settle`] for the model and timings.
    relay_settle: Arc<Mutex<SettleDeadline>>,
    /// The embedded virtual QA40x (demo mode), created on the first virtual
    /// connect and kept for the whole app session — its state survives a demo
    /// disconnect/reconnect the way a plugged-in unit survives a USB close.
    virtual_sim: Arc<Mutex<Option<Simulator>>>,
    /// True while the CURRENT connection is the virtual device. Presence
    /// checks short-circuit on it: the demo device is not on the USB bus.
    virtual_active: Arc<AtomicBool>,
}

impl QA40xDevice {
    /// Create a new QA40x device instance
    pub fn new() -> Self {
        Self {
            device: Arc::new(Mutex::new(None)),
            interface: Arc::new(Mutex::new(None)),
            eps: Arc::new(Mutex::new(None)),
            endpoints: UsbEndpoints::default(),
            config: Arc::new(Mutex::new(DeviceConfig::default())),
            cal_page: Arc::new(Mutex::new(None)),
            meta: Arc::new(Mutex::new(None)),
            model: Arc::new(Mutex::new(None)),
            last_keepalive: Arc::new(Mutex::new(None)),
            cached_telemetry: Arc::new(Mutex::new(None)),
            relay_settle: Arc::new(Mutex::new(SettleDeadline::default())),
            virtual_sim: Arc::new(Mutex::new(None)),
            virtual_active: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Find and connect to a QA40x device (QA402 or QA403).
    pub async fn connect(&self) -> Result<()> {
        info!(
            "Searching for a QA40x device (VID: 0x{:04X}, PID 0x{:04X}/0x{:04X})",
            QA40X_VID, QA402_PID, QA403_PID
        );

        // Release any prior claim first so a reconnect (e.g. after the frontend
        // reloaded while the backend stayed connected) does not fail with
        // "could not claim interface 0: exclusive access". Dropping the stored
        // Interface releases the USB claim.
        {
            // Drop the claimed endpoints first (they hold refs to the interface),
            // then the interface and device, so the OS releases the USB claim.
            *self.eps.lock().await = None;
            self.release_virtual_import().await;
            let mut iface = self.interface.lock().await;
            if iface.is_some() {
                info!("Releasing existing interface claim before reconnecting");
                *iface = None;
            }
            *self.device.lock().await = None;
            // Give the OS a moment to release the claim.
            drop(iface);
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        // Match any known QA40x model (VID is shared; the PID picks the model).
        let device_info = nusb::list_devices()
            .await
            .map_err(|e| QA40xError::DeviceError(e.to_string()))?
            .find(|dev| dev.vendor_id() == QA40X_VID && Model::from_pid(dev.product_id()).is_some())
            .ok_or(QA40xError::DeviceNotFound)?;

        let model = Model::from_pid(device_info.product_id()).unwrap_or(Model::Qa402);
        *self.model.lock().await = Some(model);

        info!("Found {} device", model.name());
        info!(
            "Device info - VID: 0x{:04X}, PID: 0x{:04X} ({})",
            device_info.vendor_id(),
            device_info.product_id(),
            model.name()
        );

        let device = device_info
            .open()
            .await
            .map_err(|e| QA40xError::DeviceError(format!("Failed to open device: {}", e)))?;

        info!("Device opened successfully");

        // Get available configurations
        let first_config = device
            .configurations()
            .next()
            .ok_or_else(|| QA40xError::DeviceError("No configurations found".to_string()))?;

        let config_value = first_config.configuration_value();
        info!("Found configuration with value: {}", config_value);

        // Set the configuration if needed
        // Note: Some devices are already configured, so we try to get active config first
        let active_config = match device.active_configuration() {
            Ok(config) => {
                info!(
                    "Device already has active configuration: {}",
                    config.configuration_value()
                );
                config
            }
            Err(_) => {
                info!(
                    "No active configuration, setting configuration {}",
                    config_value
                );
                device.set_configuration(config_value).await.map_err(|e| {
                    QA40xError::DeviceError(format!("Failed to set configuration: {}", e))
                })?;

                // Get the configuration we just set
                device.active_configuration().map_err(|e| {
                    QA40xError::DeviceError(format!(
                        "Failed to get active configuration after setting: {}",
                        e
                    ))
                })?
            }
        };

        info!(
            "Active configuration value: {}",
            active_config.configuration_value()
        );

        // Find the first interface - the QA40x uses interface 0
        let interface_number = active_config
            .interfaces()
            .next()
            .ok_or_else(|| {
                QA40xError::DeviceError("No interfaces found in configuration".to_string())
            })?
            .interface_number();

        info!("Using interface number: {}", interface_number);

        // Claim the interface
        let interface = device
            .claim_interface(interface_number)
            .await
            .map_err(|e| {
                QA40xError::DeviceError(format!(
                    "Failed to claim interface {}: {}. Make sure no other application is using the device.",
                    interface_number, e
                ))
            })?;

        info!("Interface {} claimed successfully", interface_number);

        // Claim the four bulk endpoints exclusively (nusb 0.2 model).
        let ep_err = |what: &str, e: nusb::Error| {
            QA40xError::DeviceError(format!("Failed to claim {what} endpoint: {e}"))
        };
        let mut eps = ClaimedEndpoints {
            register_write: BulkOut::Usb(
                interface
                    .endpoint::<Bulk, Out>(self.endpoints.register_write)
                    .map_err(|e| ep_err("register-write", e))?,
            ),
            register_read: BulkIn::Usb(
                interface
                    .endpoint::<Bulk, In>(self.endpoints.register_read)
                    .map_err(|e| ep_err("register-read", e))?,
            ),
            data_write: BulkOut::Usb(
                interface
                    .endpoint::<Bulk, Out>(self.endpoints.data_write)
                    .map_err(|e| ep_err("data-write", e))?,
            ),
            data_read: BulkIn::Usb(
                interface
                    .endpoint::<Bulk, In>(self.endpoints.data_read)
                    .map_err(|e| ep_err("data-read", e))?,
            ),
        };

        // Clear any stale endpoint halts before doing register I/O.
        let _ = eps.register_write.clear_halt().await;
        let _ = eps.register_read.clear_halt().await;
        let _ = eps.data_write.clear_halt().await;
        let _ = eps.data_read.clear_halt().await;

        *self.device.lock().await = Some(device);
        *self.interface.lock().await = Some(interface);
        *self.eps.lock().await = Some(eps);

        info!("Successfully connected to QA40x device");

        let serial = device_info
            .serial_number()
            .map(|s| s.to_string())
            .unwrap_or_default();
        let product = device_info
            .product_string()
            .unwrap_or("QA40x Audio Analyzer")
            .to_string();
        self.init_device_session(model, serial, product, false).await
    }

    /// Connect to the embedded virtual QA40x (demo mode): an in-process
    /// `vqa40x-core` simulator behind the same four bulk-endpoint queues as
    /// the hardware, so every code path above this line — registers,
    /// streaming, calibration, telemetry, REST, scripts — runs unchanged.
    /// No download, no USB/IP, no kernel module.
    pub async fn connect_virtual(&self) -> Result<()> {
        // Release any prior claim (real or virtual), same as connect().
        {
            *self.eps.lock().await = None;
            self.release_virtual_import().await;
            *self.interface.lock().await = None;
            *self.device.lock().await = None;
        }

        // First demo connect of the session creates the simulator; later ones
        // reattach to it (its state persists like a unit left plugged in).
        let sim = {
            let mut slot = self.virtual_sim.lock().await;
            if slot.is_none() {
                let opts = demo_sim_options();
                info!(
                    "Starting embedded virtual {} (serial {}, demo mode)",
                    opts.model.name(),
                    opts.serial
                );
                *slot = Some(Simulator::new(opts));
            }
            slot.as_ref().expect("just created").clone()
        };
        if !sim.try_import() {
            return Err(QA40xError::DeviceError(
                "Virtual device is already attached".to_string(),
            ));
        }

        let model = Model::Qa403;
        let serial = sim.busid().to_string(); // placeholder; real serial read below
        *self.model.lock().await = Some(model);
        *self.eps.lock().await = Some(ClaimedEndpoints {
            register_write: BulkOut::Virt(VirtEp::new(sim.clone(), self.endpoints.register_write)),
            register_read: BulkIn::Virt(VirtEp::new(sim.clone(), self.endpoints.register_read)),
            data_write: BulkOut::Virt(VirtEp::new(sim.clone(), self.endpoints.data_write)),
            data_read: BulkIn::Virt(VirtEp::new(sim.clone(), self.endpoints.data_read)),
        });
        self.virtual_active.store(true, Ordering::SeqCst);

        // The simulator serves the serial through register 0x1D as a packed
        // u32 of its hex digits — read it back so the UI shows the same
        // serial a USB enumeration would have carried.
        let serial = match self.read_register(registers::SERIAL_NUMBER).await {
            Ok(d) if d.len() == 4 => {
                let v = u32::from_be_bytes([d[0], d[1], d[2], d[3]]);
                format!("{:04X}_{:04X}", v >> 16, v & 0xFFFF)
            }
            _ => serial,
        };
        let product = format!("{} Audio Analyzer (virtual)", model.name());

        match self.init_device_session(model, serial, product, true).await {
            Ok(()) => {
                info!("Demo mode: connected to the embedded virtual {}", model.name());
                Ok(())
            }
            Err(e) => {
                // Leave no half-open virtual session behind.
                self.mark_disconnected().await;
                Err(e)
            }
        }
    }

    /// Detach from the embedded simulator (if this connection was virtual) so
    /// the next demo connect can re-import it. Keeps the simulator itself —
    /// its state lives for the whole app session.
    async fn release_virtual_import(&self) {
        self.virtual_active.store(false, Ordering::SeqCst);
        if let Some(sim) = self.virtual_sim.lock().await.as_ref() {
            sim.release_import();
        }
    }

    /// Whether the current connection is the embedded virtual device.
    pub fn is_virtual(&self) -> bool {
        self.virtual_active.load(Ordering::SeqCst)
    }

    /// The shared post-claim bring-up, identical for hardware and the virtual
    /// device: quiesce leftover streaming, verify the register bus, replay the
    /// vendor init write, read identity/config/calibration, and force the safe
    /// 42 dBV input range.
    async fn init_device_session(
        &self,
        model: Model,
        serial: String,
        product: String,
        is_virtual: bool,
    ) -> Result<()> {
        // Stop any leftover streaming from a previous session BEFORE the verify
        // register read. A process that died mid-stream can leave the QA40x
        // streaming and unresponsive to register I/O; driving register 8 to 0
        // and settling quiesces it so the verify read succeeds.
        info!("Resetting streaming engine");
        let _ = self
            .write_register(registers::STREAM_CTRL, &registers::STREAM_STOP.to_be_bytes())
            .await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Verify the connection by testing register write/read. If the device is
        // still wedged, clear the endpoints and try the quiesce + verify once more.
        if let Err(e) = self.verify_connection().await {
            info!("Verify failed ({}); attempting recovery", e);
            if let Some(eps) = self.eps.lock().await.as_mut() {
                let _ = eps.data_write.clear_halt().await;
                let _ = eps.data_read.clear_halt().await;
                let _ = eps.register_write.clear_halt().await;
                let _ = eps.register_read.clear_halt().await;
            }
            let _ = self
                .write_register(registers::STREAM_CTRL, &registers::STREAM_STOP.to_be_bytes())
                .await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            self.verify_connection().await?;
        }

        // Replay the vendor's connect-init write (reg 0x0A = 0). The official app
        // sends this on every connect (confirmed in every USB capture); its purpose
        // is undocumented and it is only ever 0, so we mirror it verbatim. Best-
        // effort — an unknown register must not block connecting.
        let _ = self
            .write_register(registers::UNKNOWN_INIT_0A, &0u32.to_be_bytes())
            .await;

        // Read device identity: firmware version (register 0x10) + serial. The
        // firmware register was confirmed on hardware (a read-only scan showed
        // 0x10 == the version the QuantAsylum app reports). Best-effort: identity
        // is informational, so a read failure must not block connecting.
        {
            let firmware_version = match self.read_register(registers::FIRMWARE_VERSION).await {
                Ok(d) if d.len() == 4 => u32::from_be_bytes([d[0], d[1], d[2], d[3]]),
                _ => 0,
            };
            info!("Device identity: {} firmware v{}, serial {}", model.name(), firmware_version, serial);
            *self.meta.lock().await = Some(DeviceMeta {
                model: model.name().to_string(),
                firmware_version,
                serial,
                product,
                sample_rates: model.sample_rates().iter().map(|r| r.as_hz()).collect(),
                // Never offer a firmware flash to the simulator: the demo
                // must not exercise the DFU/HID path the fake bootloader
                // can't complete in-process.
                supports_flash: model.supports_flash() && !is_virtual,
                capabilities: model.capabilities(),
                is_virtual,
            });
        }

        // Try to read current configuration from device
        // If it fails (e.g., uninitialized registers), initialize with defaults
        info!("Reading device configuration");
        match self.read_config_from_device().await {
            Ok(config) => {
                info!("Device configuration read successfully: input={} dBV, output={} dBV, rate={} Hz",
                    config.input_gain.as_dbv(),
                    config.output_gain.as_dbv(),
                    config.sample_rate.as_hz()
                );
                // This reflects the device's CURRENT registers. On a real unplug
                // the QA40x (USB-powered) reboots to its defaults, so the frontend
                // re-applies the user's persisted input/output ranges at connect.
            }
            Err(e) => {
                info!("Unable to read device configuration ({}), initializing with defaults", e);
                let default_config = DeviceConfig::default();

                self.set_input_gain(default_config.input_gain).await?;
                self.set_output_gain(default_config.output_gain).await?;
                self.set_sample_rate(default_config.sample_rate).await?;

                info!("Device initialized with default configuration");
            }
        }

        // Load the factory calibration page (best-effort) so frequency-response
        // magnitudes can be reported as a real voltage gain.
        match self.read_calibration_page().await {
            Ok(page) => {
                info!("Calibration page loaded ({} bytes)", page.len());
                *self.cal_page.lock().await = Some(page);
            }
            Err(e) => info!("Calibration page not loaded ({}); using range model only", e),
        }

        // Force the safe max-headroom input range (42 dBV) on every connect, like
        // the official app: a live signal already present at plug-in can't overload
        // a too-sensitive range. This is deliberately NOT a restore of the previous
        // range — the vendor re-forces 42 dBV on every (re)connect (verified in
        // our USB captures). set_input_gain is
        // idempotent, so this no-ops if the device already booted to 42.
        self.set_input_gain(InputGain::Gain42dBV).await?;

        Ok(())
    }

    /// Compute the dB offset that converts our uncalibrated digital transfer
    /// function into a real voltage gain, for the given input channel and the
    /// driven output channel.
    ///
    /// Derived from the PyQa40x volts↔digital conversion (no empirical
    /// constant). For a loopback `v_in = v_out`, equating the DAC and ADC
    /// conversions gives:
    ///
    /// ```text
    /// gain_cal = gain_digital + cal_adc_dB + cal_dac_dB + inFS - outFS - 9
    /// ```
    ///
    /// where the `9` dB = `3` (dBFS is peak, dBV is RMS → sine √2) on the DAC
    /// plus `6` (differential input → factor 2) on the ADC; `cal_adc_dB`/
    /// `cal_dac_dB` are the factory per-range/channel trims read from the
    /// device. Hardware-validated: a resistive loopback reads ~0 dB across all
    /// ranges. Falls back to nominal cal values when the page is unavailable.
    async fn fr_calibration_offset(&self, input_ch: Channel, output_ch: Channel) -> f32 {
        // Reference-convention constants (see doc): peak↔RMS on the DAC and
        // single-ended↔differential on the ADC.
        const DAC_PEAK_TO_RMS_DB: f32 = 3.0;
        const ADC_DIFFERENTIAL_DB: f32 = 6.0;
        const CONVENTION_DB: f32 = DAC_PEAK_TO_RMS_DB + ADC_DIFFERENTIAL_DB; // 9 dB

        let cfg = self.config.lock().await.clone();
        let in_fs = cfg.input_gain.as_dbv() as f32;
        let out_fs = cfg.output_gain.as_dbv() as f32;

        let page_db = |page: &[u8], off: usize| -> Option<f32> {
            if off + 6 <= page.len() {
                let v = f32::from_le_bytes([page[off + 2], page[off + 3], page[off + 4], page[off + 5]]);
                if v.is_finite() && v.abs() < 40.0 {
                    Some(v)
                } else {
                    None
                }
            } else {
                None
            }
        };
        let ch_off = |base: Option<usize>, ch: Channel| -> Option<usize> {
            base.map(|o| if ch == Channel::Right { o + 6 } else { o })
        };

        // Nominal factory trims (used when the page could not be read); close to
        // the measured values so the fallback is still within a few tenths dB.
        let (mut adc_cal, mut dac_cal) = (8.75_f32, -0.3_f32);
        if let Some(page) = self.cal_page.lock().await.as_ref() {
            if let Some(a) = ch_off(CalibrationData::adc_offset(cfg.input_gain.as_dbv()), input_ch)
                .and_then(|o| page_db(page, o))
            {
                adc_cal = a;
            }
            if let Some(d) = ch_off(CalibrationData::dac_offset(cfg.output_gain.as_dbv()), output_ch)
                .and_then(|o| page_db(page, o))
            {
                dac_cal = d;
            }
        }

        in_fs - out_fs - CONVENTION_DB + adc_cal + dac_cal
    }

    /// Disconnect from the device
    pub async fn disconnect(&self) -> Result<()> {
        // Leave the device in a safe state for the next plug-in: force the safe
        // 42 dBV max-headroom input range (same range the app forces on connect),
        // so a signal present at the next connection can't overload a sensitive
        // range. Best-effort — must not block tearing down the connection.
        let _ = self.set_input_gain(InputGain::Gain42dBV).await;
        // Best-effort: stop any active streaming so we don't leave the device
        // wedged in RUN state for the next session.
        let _ = self
            .write_register(registers::STREAM_CTRL, &registers::STREAM_STOP.to_be_bytes())
            .await;
        // Drop endpoints (they hold refs to the interface) before the interface.
        *self.eps.lock().await = None;
        self.release_virtual_import().await;
        *self.interface.lock().await = None;
        *self.device.lock().await = None;
        *self.meta.lock().await = None;
        *self.model.lock().await = None;
        info!("Disconnected from QA40x");
        Ok(())
    }

    /// Check if device is connected (logical state). The endpoints are the
    /// authority: a real connection also holds an interface, the virtual one
    /// (demo mode) only holds endpoints.
    pub async fn is_connected(&self) -> bool {
        self.eps.lock().await.is_some()
    }

    /// Device identity (firmware version + serial + product), read at connect.
    /// `None` until connected.
    pub async fn device_meta(&self) -> Option<DeviceMeta> {
        self.meta.lock().await.clone()
    }

    /// The detected model (QA402/QA403), set at connect. `None` until connected.
    pub async fn model(&self) -> Option<Model> {
        *self.model.lock().await
    }

    /// Enter the NXP DFU bootloader: write register 0x0F = 0xDEADBEEF then
    /// 0xCAFEBABE (the two-magic unlock seen in the official app's USB capture).
    /// The device then resets and re-enumerates as the NXP bootloader
    /// (0x1FC9:0x0022). **DEVICE-MUTATING** — only call as part of a confirmed
    /// firmware flash, never automatically.
    pub async fn enter_bootloader(&self) -> Result<()> {
        self.write_register(registers::BOOTLOADER_ENTRY, &0xDEAD_BEEFu32.to_be_bytes())
            .await?;
        self.write_register(registers::BOOTLOADER_ENTRY, &0xCAFE_BABEu32.to_be_bytes())
            .await?;
        Ok(())
    }

    /// Release the USB claim and clear cached state WITHOUT any device I/O — used
    /// right after `enter_bootloader`, when the unit is detaching to re-enumerate
    /// as the NXP bootloader (a normal disconnect() would try to write registers
    /// to a device that is already going away).
    pub async fn mark_disconnected(&self) {
        *self.eps.lock().await = None;
        self.release_virtual_import().await;
        *self.interface.lock().await = None;
        *self.device.lock().await = None;
        *self.meta.lock().await = None;
        *self.model.lock().await = None;
    }

    /// One keepalive cycle, mirroring the official app: write the link register
    /// (0x00) with a pattern, then read telemetry. Runs ~1 s while connected and
    /// idle (frontend poll) to hold the LINK LED lit, and between stream frames
    /// during a run (see [`Self::run_keepalive_if_due`]). Must never OVERLAP a
    /// stream, but serialized between streams is safe — proven on hardware by
    /// `examples/hw_run_keepalive.rs` (the earlier "keepalive wedges the stream"
    /// finding was actually undrained cancelled completions; see `stream_pump`).
    pub async fn keepalive(&self) -> Result<Telemetry> {
        self.write_register(registers::LINK_KEEPALIVE, &0x1234_5678u32.to_be_bytes())
            .await?;
        let t = self.read_telemetry().await?;
        *self.last_keepalive.lock().await = Some(std::time::Instant::now());
        *self.cached_telemetry.lock().await = Some(t.clone());
        Ok(t)
    }

    /// Telemetry from the most recent keepalive (idle poll or in-run), with no
    /// USB I/O — safe for the UI to poll while a run owns the stream.
    pub async fn last_telemetry(&self) -> Option<Telemetry> {
        self.cached_telemetry.lock().await.clone()
    }

    /// The shared telemetry cache cell itself. Grab it ONCE at construction so
    /// pure cache readers (the UI's in-run telemetry poll) can read it WITHOUT
    /// the exclusive device mutex: queuing a once-per-second reader on that
    /// mutex during a long capture is what fed the quit-hang's lock convoy.
    pub fn telemetry_cell(&self) -> Arc<Mutex<Option<Telemetry>>> {
        self.cached_telemetry.clone()
    }

    /// Fire a LINK-LED keepalive if none ran within the last ~1 s. Called from
    /// [`Self::stream_io`] before each stream, so multi-frame runs (live
    /// analyzer, sweeps, the looping output generator) keep the LINK LED lit
    /// like the official app, which keepalives at ~1 Hz even while measuring
    /// (our USB captures show its 0x00 writes inside armed
    /// STREAM_CTRL=5 windows; ours run between streams instead).
    /// Non-fatal by design: an LED ping must never fail a measurement.
    async fn run_keepalive_if_due(&self) {
        {
            let mut last = self.last_keepalive.lock().await;
            let due = last.map_or(true, |t| t.elapsed() >= Duration::from_secs(1));
            if !due {
                return;
            }
            // Stamp before attempting so a failing device is pinged at most
            // once a second, not once per frame.
            *last = Some(std::time::Instant::now());
        }
        if let Err(e) = self.keepalive().await {
            debug!("in-run keepalive skipped: {}", e);
        }
    }

    /// Read live hardware telemetry (USB voltage/current, ISO current,
    /// temperature) from the sensor registers. Reads are non-destructive; the
    /// caller should avoid polling this mid-stream (it shares the interface).
    pub async fn read_telemetry(&self) -> Result<Telemetry> {
        let rd = |v: Vec<u8>| -> u32 {
            if v.len() == 4 {
                u32::from_be_bytes([v[0], v[1], v[2], v[3]])
            } else {
                0
            }
        };
        let usb_v = rd(self.read_register(registers::TELEM_USB_VOLTAGE).await?);
        let usb_i = rd(self.read_register(registers::TELEM_USB_CURRENT).await?);
        let iso_i = rd(self.read_register(registers::TELEM_ISO_CURRENT).await?);
        let extra = rd(self.read_register(registers::TELEM_EXTRA).await?);
        let temp = rd(self.read_register(registers::TELEM_TEMPERATURE).await?);
        Ok(Telemetry {
            usb_voltage_v: usb_v as f32 / 1000.0,
            usb_current_ma: usb_i as f32,
            iso_current_ma: iso_i as f32,
            temperature_c: temp as f32 / 10.0,
            raw_usb_voltage: usb_v,
            raw_usb_current: usb_i,
            raw_iso_current: iso_i,
            raw_extra: extra,
            raw_temperature: temp,
        })
    }

    /// Whether a QA40x (QA402 or QA403) is present on the USB bus, regardless of whether we are
    /// connected to it. Used for auto-connect. The virtual device (demo mode)
    /// is "present" while attached — it lives in-process, not on the bus.
    pub async fn is_present(&self) -> bool {
        if self.is_virtual() {
            return true;
        }
        match nusb::list_devices().await {
            Ok(mut devices) => {
                devices.any(|dev| dev.vendor_id() == QA40X_VID && Model::from_pid(dev.product_id()).is_some())
            }
            Err(_) => false,
        }
    }

    /// Check if device is still physically connected by looking for it in USB device list
    pub async fn check_physical_connection(&self) -> bool {
        // If not logically connected, return false immediately
        if !self.is_connected().await {
            return false;
        }

        // The virtual device never unplugs: it is attached until disconnect().
        if self.is_virtual() {
            return true;
        }

        // Check if device is still present in USB device list
        let device_found = match nusb::list_devices().await {
            Ok(mut devices) => {
                devices.any(|dev| dev.vendor_id() == QA40X_VID && Model::from_pid(dev.product_id()).is_some())
            }
            Err(_) => false,
        };

        if !device_found {
            debug!("Device no longer present in USB device list");
            // Clean up the internal state
            *self.eps.lock().await = None;
            *self.interface.lock().await = None;
            *self.device.lock().await = None;
            return false;
        }

        true
    }

    /// Verify connection by writing and reading back a random value to register 0
    async fn verify_connection(&self) -> Result<()> {
        info!("Verifying connection to QA40x");

        // Generate a random u32 value in a separate scope to drop the RNG before await
        let random_value: u32 = {
            use rand::Rng;
            rand::thread_rng().gen()
        };

        debug!("Writing random test value 0x{:08X} to register 0", random_value);

        // Write the random value to register 0
        self.write_register(0, &random_value.to_be_bytes()).await?;

        // Small delay to ensure write completes before reading
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Read it back
        let read_data = self.read_register(0).await?;

        // Check we got 4 bytes back
        if read_data.len() < 4 {
            return Err(QA40xError::DeviceError(format!(
                "Expected 4 bytes from register read, got {}",
                read_data.len()
            )));
        }

        // Convert the read bytes back to u32 (big-endian)
        let read_value = u32::from_be_bytes([read_data[0], read_data[1], read_data[2], read_data[3]]);

        debug!("Read back value 0x{:08X} from register 0", read_value);

        // Verify they match
        if read_value == random_value {
            info!("Connection verification successful: write/read test passed");
            Ok(())
        } else {
            Err(QA40xError::DeviceError(format!(
                "Connection verification failed: wrote 0x{:08X} but read back 0x{:08X}",
                random_value, read_value
            )))
        }
    }

    /// Set input gain
    pub async fn set_input_gain(&self, gain: InputGain) -> Result<()> {
        // Idempotent: the INPUT_GAIN register drives a mechanical relay, so
        // writing it clicks even when the value is unchanged. Skip redundant
        // sets so a repeated config-apply doesn't machine-gun the relay.
        if self.config.lock().await.input_gain == gain {
            return Ok(());
        }
        info!("Setting input gain to {} dBV", gain.as_dbv());
        let value = gain.as_register_value();
        self.write_register(registers::INPUT_GAIN, &value.to_be_bytes())
            .await?;

        // Stamp the relay settle deadline. No sleep here: the wait is paid by
        // the next acquisition, in stream_io, between captures.
        self.relay_settle
            .lock()
            .await
            .stamp(std::time::Instant::now(), RANGE_RELAY_SETTLE);

        let mut config = self.config.lock().await;
        config.input_gain = gain;
        Ok(())
    }

    /// Set output gain
    pub async fn set_output_gain(&self, gain: OutputGain) -> Result<()> {
        // Idempotent (see set_input_gain): skip if the relay is already there.
        if self.config.lock().await.output_gain == gain {
            return Ok(());
        }
        info!("Setting output gain to {} dBV", gain.as_dbv());
        let value = gain.as_register_value();
        self.write_register(registers::OUTPUT_GAIN, &value.to_be_bytes())
            .await?;

        // Stamp the output-relay settle deadline; the next acquisition waits
        // it out (see set_input_gain).
        self.relay_settle
            .lock()
            .await
            .stamp(std::time::Instant::now(), RANGE_RELAY_SETTLE);

        let mut config = self.config.lock().await;
        config.output_gain = gain;
        Ok(())
    }

    /// Set sample rate
    pub async fn set_sample_rate(&self, rate: SampleRate) -> Result<()> {
        // Reject a rate the connected model doesn't support (384 kHz is QA403-only).
        if let Some(model) = *self.model.lock().await {
            if !model.supports_rate(rate) {
                return Err(QA40xError::InvalidValue(format!(
                    "{} does not support {} Hz",
                    model.name(),
                    rate.as_hz()
                )));
            }
        }
        // Idempotent: avoid the register write + 100 ms settle when unchanged.
        if self.config.lock().await.sample_rate == rate {
            return Ok(());
        }
        info!("Setting sample rate to {} Hz", rate.as_hz());
        // Register 9 takes an INDEX (0/1/2), not the Hz value. Writing the Hz
        // value silently leaves the device at 48 kHz because 48000/96000/192000
        // all share the same low bits.
        let value = rate.as_register_index();
        self.write_register(registers::SAMPLE_RATE, &value.to_be_bytes())
            .await?;

        // Sample rate changes require a delay
        tokio::time::sleep(Duration::from_millis(100)).await;

        let mut config = self.config.lock().await;
        config.sample_rate = rate;
        Ok(())
    }

    /// Get current device configuration from memory cache
    pub async fn get_config(&self) -> DeviceConfig {
        self.config.lock().await.clone()
    }

    /// Read input gain from device register
    pub async fn read_input_gain(&self) -> Result<InputGain> {
        let data = self.read_register(registers::INPUT_GAIN).await?;
        if data.len() < 4 {
            return Err(QA40xError::DeviceError(format!(
                "Expected 4 bytes from input gain register, got {}",
                data.len()
            )));
        }

        // Convert big-endian bytes to u32 register value
        let register_value = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);

        // Map register value to InputGain enum
        match register_value {
            0 => Ok(InputGain::Gain0dBV),
            1 => Ok(InputGain::Gain6dBV),
            2 => Ok(InputGain::Gain12dBV),
            3 => Ok(InputGain::Gain18dBV),
            4 => Ok(InputGain::Gain24dBV),
            5 => Ok(InputGain::Gain30dBV),
            6 => Ok(InputGain::Gain36dBV),
            7 => Ok(InputGain::Gain42dBV),
            _ => Err(QA40xError::DeviceError(format!(
                "Invalid input gain register value: {}",
                register_value
            ))),
        }
    }

    /// Read output gain from device register
    pub async fn read_output_gain(&self) -> Result<OutputGain> {
        let data = self.read_register(registers::OUTPUT_GAIN).await?;
        if data.len() < 4 {
            return Err(QA40xError::DeviceError(format!(
                "Expected 4 bytes from output gain register, got {}",
                data.len()
            )));
        }

        // Convert big-endian bytes to u32 register value
        let register_value = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);

        // Map register value to OutputGain enum
        match register_value {
            0 => Ok(OutputGain::GainMinus12dBV),
            1 => Ok(OutputGain::GainMinus2dBV),
            2 => Ok(OutputGain::Gain8dBV),
            3 => Ok(OutputGain::Gain18dBV),
            _ => Err(QA40xError::DeviceError(format!(
                "Invalid output gain register value: {}",
                register_value
            ))),
        }
    }

    /// Read sample rate from device register
    pub async fn read_sample_rate(&self) -> Result<SampleRate> {
        let data = self.read_register(registers::SAMPLE_RATE).await?;
        if data.len() < 4 {
            return Err(QA40xError::DeviceError(format!(
                "Expected 4 bytes from sample rate register, got {}",
                data.len()
            )));
        }

        // Register 9 returns the sample-rate index (0/1/2). Accept a raw Hz
        // value too, in case a device echoes what was written.
        let raw = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);

        SampleRate::from_register_value(raw).ok_or_else(|| {
            QA40xError::DeviceError(format!("Invalid sample rate register value: {}", raw))
        })
    }

    /// Read current device configuration from hardware registers
    pub async fn read_config_from_device(&self) -> Result<DeviceConfig> {
        info!("Reading configuration from device registers");

        let input_gain = self.read_input_gain().await?;
        let output_gain = self.read_output_gain().await?;
        let sample_rate = self.read_sample_rate().await?;

        let config = DeviceConfig {
            input_gain,
            output_gain,
            sample_rate,
        };

        debug!("Read config from device: input={} dBV, output={} dBV, rate={} Hz",
            config.input_gain.as_dbv(),
            config.output_gain.as_dbv(),
            config.sample_rate.as_hz()
        );

        // Update cached config
        *self.config.lock().await = config.clone();

        Ok(config)
    }

    /// Read the 512-byte factory calibration page and extract the correction
    /// factors for the currently configured input/output full scale.
    ///
    /// Protocol (per PyQa40x): write 0x10 to register 0x0D to select the cal
    /// page, then read register 0x19 128 times; each read returns the next
    /// 4 bytes (little-endian) of the page. Records are 6 bytes: an int16 level
    /// followed by a float32 dB correction; the right channel record sits 6
    /// bytes after the left.
    /// Read the raw 512-byte factory calibration page from the device.
    pub async fn read_calibration_page(&self) -> Result<Vec<u8>> {
        info!("Reading calibration page");

        // Select the calibration page.
        self.write_register(registers::CAL_PAGE_SELECT, &0x10u32.to_be_bytes())
            .await?;
        tokio::time::sleep(Duration::from_millis(10)).await;

        // Read the 512-byte page, 4 bytes at a time, little-endian.
        let mut page = Vec::with_capacity(512);
        for _ in 0..128 {
            let data = self.read_register(registers::CALIBRATION).await?;
            if data.len() < 4 {
                return Err(QA40xError::InvalidValue(
                    "Calibration read returned fewer than 4 bytes".to_string(),
                ));
            }
            // The register read decodes big-endian; re-emit the raw 4 bytes in
            // little-endian page order.
            let val = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
            page.extend_from_slice(&val.to_le_bytes());
        }
        Ok(page)
    }

    pub async fn read_calibration(&self) -> Result<CalibrationData> {
        let page = self.read_calibration_page().await?;

        let cfg = self.config.lock().await.clone();
        let read_db = |offset: usize| -> Option<f32> {
            // Skip the int16 level, read the float32 dB correction.
            let p = offset + 2;
            if p + 4 <= page.len() {
                Some(f32::from_le_bytes([
                    page[p],
                    page[p + 1],
                    page[p + 2],
                    page[p + 3],
                ]))
            } else {
                None
            }
        };

        let adc_off = CalibrationData::adc_offset(cfg.input_gain.as_dbv());
        let dac_off = CalibrationData::dac_offset(cfg.output_gain.as_dbv());

        let mut cal = CalibrationData::default();
        let mut valid = true;
        if let Some(off) = adc_off {
            match (read_db(off), read_db(off + 6)) {
                (Some(l), Some(r)) if l.is_finite() && r.is_finite() && l.abs() < 20.0 && r.abs() < 20.0 => {
                    cal.adc_cal_left = CalibrationData::db_to_linear(l);
                    cal.adc_cal_right = CalibrationData::db_to_linear(r);
                }
                _ => valid = false,
            }
        } else {
            valid = false;
        }
        if let Some(off) = dac_off {
            match (read_db(off), read_db(off + 6)) {
                (Some(l), Some(r)) if l.is_finite() && r.is_finite() && l.abs() < 20.0 && r.abs() < 20.0 => {
                    cal.dac_cal_left = CalibrationData::db_to_linear(l);
                    cal.dac_cal_right = CalibrationData::db_to_linear(r);
                }
                _ => valid = false,
            }
        } else {
            valid = false;
        }
        cal.valid = valid;

        debug!(
            "Calibration (valid={}): ADC L={:.4} R={:.4}, DAC L={:.4} R={:.4}",
            cal.valid, cal.adc_cal_left, cal.adc_cal_right, cal.dac_cal_left, cal.dac_cal_right
        );
        Ok(cal)
    }

    /// USB bulk transfer size used for all streaming (matches PyQa40x).
    const USB_BUF_SIZE: usize = 16384;

    /// Encode stereo f32 samples into the interleaved int32 little-endian byte
    /// stream the DAC expects. L/R are swapped on the wire on the QA402/QA403,
    /// so the caller's "left" is placed in the right slot and vice versa.
    fn encode_stereo(left: &[f32], right: &[f32]) -> Vec<u8> {
        let n = left.len().min(right.len());
        let mut buf = Vec::with_capacity(n * 8);
        const FS: f32 = 2_147_483_647.0; // 2^31 - 1
        for i in 0..n {
            let l = (left[i].clamp(-1.0, 1.0) * FS) as i32;
            let r = (right[i].clamp(-1.0, 1.0) * FS) as i32;
            // Wire order is swapped: right sample first, then left.
            buf.extend_from_slice(&r.to_le_bytes());
            buf.extend_from_slice(&l.to_le_bytes());
        }
        buf
    }

    /// Decode the ADC byte stream (interleaved int32 LE, L/R swapped on the
    /// wire) back into normalized f32 left/right channels.
    fn decode_stereo(bytes: &[u8], max_samples: usize) -> (Vec<f32>, Vec<f32>) {
        let mut left = Vec::with_capacity(max_samples);
        let mut right = Vec::with_capacity(max_samples);
        const FS: f32 = 2_147_483_648.0; // 2^31
        let mut i = 0;
        while i + 8 <= bytes.len() && left.len() < max_samples {
            // Wire order is swapped: first 4 bytes are the right channel.
            let r = i32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
            let l = i32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]);
            left.push(l as f32 / FS);
            right.push(r as f32 / FS);
            i += 8;
        }
        (left, right)
    }

    /// Run one synchronized DAC-write / ADC-read stream.
    ///
    /// `tx` is the full interleaved byte stream to send to the DAC. Returns the
    /// captured ADC byte stream. Implements the "prime the pump" protocol: two
    /// reads and two writes are queued up front, then each completed read is
    /// immediately followed by another write so the hardware never stalls.
    ///
    /// Streaming is always stopped afterwards, including on error paths.
    async fn stream_io(&self, tx: &[u8]) -> Result<Vec<u8>> {
        self.stream_io_cancellable(tx, None).await
    }

    /// [`stream_io`] with a cooperative cancel flag: checked between block
    /// reads by the pump; on cancel the stream closes through the SAME
    /// STREAM_STOP + cancel_and_drain path as an error — the transaction is
    /// simply not retried and returns [`QA40xError::Cancelled`].
    async fn stream_io_cancellable(
        &self,
        tx: &[u8],
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<Vec<u8>> {
        const BUF: usize = QA40xDevice::USB_BUF_SIZE;
        let total_bytes = tx.len();
        let blocks = ((total_bytes + BUF - 1) / BUF).max(2);

        debug!("stream_io: {} bytes in {} blocks", total_bytes, blocks);

        // Keep the LINK LED lit across multi-frame runs: at most one keepalive
        // per second, always BETWEEN streams (never overlapping one — this
        // sits before STREAM_CTRL=5). Hardware-validated by hw_run_keepalive.
        self.run_keepalive_if_due().await;

        // Range relays: if reg 5/6 was written since the last capture, wait
        // out the remaining settle BEFORE starting the stream. The wait lives
        // here — between captures, never interleaved into one — and several
        // range writes collapse into a single wait (the deadline is the max,
        // not the sum). Runs after the keepalive so that register I/O counts
        // toward the settle window instead of adding to it.
        let remaining = self.relay_settle.lock().await.remaining(std::time::Instant::now());
        if let Some(wait) = remaining {
            debug!("Waiting {} ms for range relays to settle", wait.as_millis());
            tokio::time::sleep(wait).await;
        }

        // A cold stream occasionally stalls on the very first transfer, which
        // then wedges the endpoints. Retry once, fully quiescing the device in
        // between so the second attempt starts clean.
        const MAX_ATTEMPTS: usize = 2;
        let mut last_err = QA40xError::Timeout;

        for attempt in 0..MAX_ATTEMPTS {
            // Start streaming, then give the engine a moment to spin up before
            // submitting transfers (avoids the cold-start read timeout).
            self.write_register(registers::STREAM_CTRL, &registers::STREAM_START.to_be_bytes())
                .await?;
            tokio::time::sleep(Duration::from_millis(40)).await;

            let result = self.stream_pump(tx, blocks, cancel).await;

            // On failure, clear the data endpoints so a stalled transfer does
            // not wedge the retry (or the next operation).
            if result.is_err() {
                if let Some(eps) = self.eps.lock().await.as_mut() {
                    let _ = eps.data_write.clear_halt().await;
                    let _ = eps.data_read.clear_halt().await;
                }
            }

            // Always stop streaming between attempts and on the way out.
            let _ = self
                .write_register(registers::STREAM_CTRL, &registers::STREAM_STOP.to_be_bytes())
                .await;

            match result {
                Ok(rx) => return Ok(rx),
                // User cancel: the stream is already stopped and drained —
                // return immediately, a retry would replay the whole capture.
                Err(QA40xError::Cancelled) => return Err(QA40xError::Cancelled),
                Err(e) => {
                    debug!("stream_io attempt {} failed: {}", attempt + 1, e);
                    last_err = e;
                    // Let cancelled transfers fully drain before retrying so the
                    // fresh queue does not collide with lingering ones.
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
            }
        }

        Err(last_err)
    }

    /// Inner pump loop for [`stream_io`]. Kept separate so the caller can
    /// guarantee streaming is stopped regardless of how this returns.
    async fn stream_pump(
        &self,
        tx: &[u8],
        blocks: usize,
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<Vec<u8>> {
        const BUF: usize = QA40xDevice::USB_BUF_SIZE;
        let total_bytes = tx.len();

        let chunk = |idx: usize| -> Vec<u8> {
            let start = idx * BUF;
            if start >= total_bytes {
                vec![0u8; BUF]
            } else {
                let end = (start + BUF).min(total_bytes);
                let mut c = tx[start..end].to_vec();
                if c.len() < BUF {
                    c.resize(BUF, 0);
                }
                c
            }
        };

        let mut guard = self.eps.lock().await;
        let eps = guard.as_mut().ok_or(QA40xError::DeviceNotOpened)?;

        // Pre-queue every read and write up front (the QA40xPlot approach). With
        // all ADC reads already submitted before data flows, there is no
        // cold-start race where the first read times out, and the DAC never
        // underruns waiting for the host to submit the next write. Each endpoint
        // keeps its own FIFO queue; next_complete() returns them in submission
        // order. Interleave read/write submission per block so the device sees
        // paired transfers.
        for i in 0..blocks {
            eps.data_read.submit(Buffer::new(BUF));
            eps.data_write.submit(chunk(i).into());
        }

        let result = Self::pump_collect(eps, blocks, total_bytes, cancel).await;

        // On any failure, cancel and FULLY drain both data endpoints. Draining
        // matters as much as cancelling: nusb keeps completed-but-uncollected
        // transfers queued per endpoint, so any stale cancelled completion left
        // behind here would be returned to the NEXT stream's next_complete() and
        // fail it with "transfer was cancelled" — that poisoning is what made
        // every capture after a failure fail (hw_run_keepalive, ~2 ok/28 err).
        if result.is_err() {
            cancel_and_drain(&mut eps.data_read).await;
            cancel_and_drain(&mut eps.data_write).await;
        }

        result
    }

    /// Collection half of [`stream_pump`]: gather every queued ADC read in
    /// order, then confirm every DAC write. Kept separate so the caller has a
    /// single error path on which it can cancel + drain both data endpoints.
    async fn pump_collect(
        eps: &mut ClaimedEndpoints,
        blocks: usize,
        capacity: usize,
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<Vec<u8>> {
        let mut rx = Vec::with_capacity(capacity);

        // Collect ADC data in order. A generous timeout covers the whole queue
        // draining at the sample rate.
        for i in 0..blocks {
            // Cooperative cancel between blocks (a long batched sweep is ONE
            // stream — this is the only mid-transaction exit): returning Err
            // rides the caller's cancel_and_drain + STREAM_STOP path.
            if cancel.is_some_and(|c| c.load(std::sync::atomic::Ordering::SeqCst)) {
                debug!("stream_pump: cancelled at block {}/{}", i, blocks);
                return Err(QA40xError::Cancelled);
            }
            match complete_or_cancel(&mut eps.data_read, Duration::from_secs(5)).await {
                Ok(c) => {
                    c.status.map_err(QA40xError::from)?;
                    rx.extend_from_slice(&c.buffer[..]);
                }
                Err(e) => {
                    debug!("stream_pump: read stalled at block {}/{}", i, blocks);
                    return Err(e);
                }
            }
        }

        // Confirm all DAC writes completed.
        for _ in 0..blocks {
            complete_or_cancel(&mut eps.data_write, Duration::from_secs(5))
                .await?
                .status
                .map_err(QA40xError::from)?;
        }

        Ok(rx)
    }

    /// Acquire audio data from the device
    ///
    /// The QA40x requires synchronized DAC write + ADC read operations.
    /// For acquisition-only mode, we send zeros to the DAC.
    pub async fn acquire_data(&self, num_samples: usize) -> Result<AudioData> {
        info!("Acquiring {} samples", num_samples);

        // Discard the first blocks worth of ADC data: after the stream starts,
        // the hardware pipeline is still filling and the initial samples are
        // stale. Capturing extra and dropping the lead-in keeps the returned
        // block clean.
        const LEADIN_SAMPLES: usize = 4096;
        let capture_samples = num_samples + LEADIN_SAMPLES;

        // Silence on the DAC while we read the ADC.
        let tx = vec![0u8; capture_samples * 8];
        let rx = self.stream_io(&tx).await?;

        let (mut left, mut right) = Self::decode_stereo(&rx, capture_samples);
        // Drop the lead-in.
        let drop = LEADIN_SAMPLES.min(left.len());
        left.drain(0..drop);
        right.drain(0..drop);
        left.truncate(num_samples);
        right.truncate(num_samples);

        debug!("Acquired {} samples per channel", left.len());

        let config = self.config.lock().await;
        Ok(AudioData {
            left_channel: left,
            right_channel: right,
            sample_rate: config.sample_rate.as_hz(),
        })
    }

    /// Generate output signal (DAC)
    ///
    /// The QA40x requires synchronized DAC write + ADC read operations.
    /// For output-only mode, we still need to read from ADC (data is discarded).
    pub async fn generate_signal(&self, left: &[f32], right: &[f32]) -> Result<()> {
        if left.len() != right.len() {
            return Err(QA40xError::InvalidValue(
                "Left and right channel lengths must match".to_string(),
            ));
        }

        info!("Generating signal with {} samples", left.len());

        let tx = Self::encode_stereo(left, right);
        let _ = self.stream_io(&tx).await?;

        debug!("Signal generation complete");
        Ok(())
    }

    /// Output a signal on the DAC while simultaneously capturing the ADC input.
    ///
    /// Unlike [`generate_signal`], which discards the captured input, this
    /// returns the recorded audio — so a generated tone can be analysed through
    /// a loopback (fundamental + harmonics + THD). A short lead-in of silence is
    /// prepended and dropped so the returned block is past the pipeline warm-up.
    pub async fn generate_and_capture(&self, left: &[f32], right: &[f32]) -> Result<AudioData> {
        self.generate_and_capture_cancellable(left, right, None).await
    }

    /// [`generate_and_capture`] with a cooperative cancel flag — for LONG
    /// single-stream transactions (the batched THD sweep) that a user must be
    /// able to abort mid-capture. Returns [`QA40xError::Cancelled`]; the
    /// device is left cleanly stopped (same STREAM_STOP + drain exit as an
    /// error, without the retry).
    pub async fn generate_and_capture_cancellable(
        &self,
        left: &[f32],
        right: &[f32],
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<AudioData> {
        if left.len() != right.len() {
            return Err(QA40xError::InvalidValue(
                "Left and right channel lengths must match".to_string(),
            ));
        }
        let num_samples = left.len();
        info!("Generate-and-capture with {} samples", num_samples);

        // Prepend silence so the captured, latency-shifted signal is fully
        // inside the returned window.
        const LEADIN_SAMPLES: usize = 4096;
        let mut l = vec![0.0f32; LEADIN_SAMPLES];
        l.extend_from_slice(left);
        let mut r = vec![0.0f32; LEADIN_SAMPLES];
        r.extend_from_slice(right);

        let tx = Self::encode_stereo(&l, &r);
        let rx = self.stream_io_cancellable(&tx, cancel).await?;

        let total = LEADIN_SAMPLES + num_samples;
        let (mut cl, mut cr) = Self::decode_stereo(&rx, total);
        let drop = LEADIN_SAMPLES.min(cl.len());
        cl.drain(0..drop);
        cr.drain(0..drop);
        cl.truncate(num_samples);
        cr.truncate(num_samples);

        let config = self.config.lock().await;
        Ok(AudioData {
            left_channel: cl,
            right_channel: cr,
            sample_rate: config.sample_rate.as_hz(),
        })
    }

    /// Measure frequency response by outputting a log sweep and recording the
    /// input simultaneously.
    ///
    /// `amplitude_dbfs` is the output level relative to DAC full scale (-60..0).
    /// The excitation is a Farina log sweep with equal energy per octave; the
    /// response is estimated as a regularized complex transfer function with the
    /// USB round-trip latency removed (see [`crate::audio::analyze_sweep`]).
    pub async fn measure_frequency_response(
        &self,
        start_freq: f32,
        end_freq: f32,
        output_channel: Channel,
        input_channel: Channel,
        duration_secs: f32,
        amplitude_dbfs: f32,
    ) -> Result<FrequencyResponseData> {
        let (drive_left, drive_right) = match output_channel {
            Channel::Left => (true, false),
            Channel::Right => (false, true),
        };
        let (want_left, want_right) = match input_channel {
            Channel::Left => (true, false),
            Channel::Right => (false, true),
        };
        let traces = self
            .measure_frequency_response_multi(
                start_freq,
                end_freq,
                duration_secs,
                amplitude_dbfs,
                drive_left,
                drive_right,
                want_left,
                want_right,
            )
            .await?;
        traces
            .into_iter()
            .next()
            .map(|t| t.data)
            .ok_or_else(|| QA40xError::InvalidValue("No input channel selected".into()))
    }

    /// Measure the frequency response, driving one or both output channels and
    /// analysing one or both input channels from a single synchronized sweep.
    ///
    /// Returns one trace per requested input channel. The reference is the sweep
    /// that was sent to the DAC, so an undriven-output / driven-input pair yields
    /// the crosstalk response.
    pub async fn measure_frequency_response_multi(
        &self,
        start_freq: f32,
        end_freq: f32,
        duration_secs: f32,
        amplitude_dbfs: f32,
        drive_left: bool,
        drive_right: bool,
        want_left: bool,
        want_right: bool,
    ) -> Result<Vec<FrequencyResponseTrace>> {
        info!(
            "Measuring FR: {}-{} Hz, drive L={} R={}, want L={} R={}, {} dBFS",
            start_freq, end_freq, drive_left, drive_right, want_left, want_right, amplitude_dbfs
        );
        if !want_left && !want_right {
            return Err(QA40xError::InvalidValue(
                "At least one input channel must be selected".into(),
            ));
        }

        let sample_rate = self.config.lock().await.sample_rate.as_hz();
        let nyquist = sample_rate as f32 / 2.0;

        // Clamp the sweep band to sane limits and below Nyquist.
        let f_start = start_freq.max(1.0).min(nyquist * 0.9);
        let f_end = end_freq.clamp(f_start * 1.01, nyquist * 0.95);

        let duration = duration_secs.clamp(0.1, 10.0);
        let num_samples = ((sample_rate as f32 * duration) as usize).max(1024);
        let amplitude = 10.0_f32.powf(amplitude_dbfs.clamp(-80.0, 0.0) / 20.0);

        // Sweep slightly beyond the analysed band so the fade-in/out and reduced
        // energy near the sweep edges fall OUTSIDE [f_start, f_end].
        let sweep_start = (f_start / 1.3).max(1.0);
        let sweep_end = (f_end * 1.3).min(nyquist * 0.98);

        let sweep = crate::utils::SignalGenerator::log_chirp(
            sweep_start,
            sweep_end,
            amplitude,
            sample_rate,
            num_samples,
        );

        // Pad with silence so the full response (including latency tail) is captured.
        const PAD: usize = 8192;
        let mut sweep_padded = vec![0.0f32; PAD];
        sweep_padded.extend_from_slice(&sweep);
        sweep_padded.extend(std::iter::repeat(0.0).take(PAD));
        let total = sweep_padded.len();

        let zero = vec![0.0f32; total];
        let left_out = if drive_left { &sweep_padded } else { &zero };
        let right_out = if drive_right { &sweep_padded } else { &zero };

        let tx = Self::encode_stereo(left_out, right_out);
        let rx = self.stream_io(&tx).await?;
        let (left_in, right_in) = Self::decode_stereo(&rx, total);

        // The driven output channel used as the calibration reference (if both
        // are driven, they share the same sweep so either works).
        let output_ch = if drive_left { Channel::Left } else { Channel::Right };

        // Reference is the sweep sent to the DAC.
        let reference = &sweep_padded;
        let mut traces = Vec::new();
        for (want, name, response, in_ch) in [
            (want_left, "Left", &left_in, Channel::Left),
            (want_right, "Right", &right_in, Channel::Right),
        ] {
            if !want {
                continue;
            }
            let len = reference.len().min(response.len());
            let mut data = crate::audio::analyze_sweep(
                &reference[..len],
                &response[..len],
                sample_rate,
                f_start,
                f_end,
            );

            // Apply the calibration offset so the magnitude is a real voltage
            // gain (a resistive loopback reads ~0 dB).
            let offset = self.fr_calibration_offset(in_ch, output_ch).await;
            for m in data.magnitudes_db.iter_mut() {
                *m += offset;
            }
            debug!("FR {} channel: applied calibration offset {:.2} dB", name, offset);

            traces.push(FrequencyResponseTrace {
                channel: name.to_string(),
                data,
            });
        }

        info!("Frequency response complete: {} trace(s)", traces.len());
        Ok(traces)
    }

    /// Measure THD and THD+N at a single tone frequency/level via synchronized
    /// generate-and-capture. THD/THD+N are dimensionless ratios so no
    /// calibration is needed; `fundamental_dbfs` is relative to digital full
    /// scale. Building block for the THD-vs-frequency and THD-vs-level sweeps.
    pub async fn measure_thd_point(
        &self,
        frequency: f32,
        amplitude_dbfs: f32,
        output_channel: Channel,
        input_channel: Channel,
    ) -> Result<crate::audio::ThdSweepPoint> {
        let sample_rate = self.config.lock().await.sample_rate.as_hz();
        let amplitude = 10.0_f32.powf(amplitude_dbfs.clamp(-80.0, 0.0) / 20.0);

        // Coherent sampling: snap the tone to an exact FFT bin so it completes an
        // integer number of cycles in the analysis window — no spectral leakage,
        // which is what otherwise dominates THD+N. Generate a guard band on each
        // side so the pure-tone interior window is clear of the latency lead-in.
        const N_FFT: usize = 32768;
        const GUARD: usize = 2048;
        let bin = ((frequency * N_FFT as f32 / sample_rate as f32).round()).max(1.0);
        let f_bin = bin * sample_rate as f32 / N_FFT as f32;
        let tone_len = N_FFT + 2 * GUARD;

        let tone = crate::utils::SignalGenerator::sine(f_bin, amplitude, sample_rate, tone_len);
        let silence = vec![0.0f32; tone_len];
        let (left, right) = match output_channel {
            Channel::Left => (tone.as_slice(), silence.as_slice()),
            Channel::Right => (silence.as_slice(), tone.as_slice()),
        };

        let captured = self.generate_and_capture(left, right).await?;
        let full = match input_channel {
            Channel::Left => &captured.left_channel,
            Channel::Right => &captured.right_channel,
        };
        // Pure-tone interior window (past the round-trip latency).
        let start = GUARD.min(full.len());
        let end = (start + N_FFT).min(full.len());
        let sig = &full[start..end];

        let (thd, thd_n, fund_mag) =
            crate::audio::AudioAnalyzer::thd_suite(sig, sample_rate, f_bin, 7);

        // Floor at a finite value (not -inf): serde serializes non-finite floats
        // as JSON null, which crashes the frontend. -200 dB reads as "below the
        // floor" (e.g. no harmonics measurable because they exceed Nyquist).
        let to_db = |r: f32| if r > 0.0 { (20.0 * r.log10()).max(-200.0) } else { -200.0 };
        Ok(crate::audio::ThdSweepPoint {
            frequency: f_bin,
            level_dbfs: amplitude_dbfs,
            thd_percent: thd * 100.0,
            thd_db: to_db(thd),
            thd_n_percent: thd_n * 100.0,
            thd_n_db: to_db(thd_n),
            fundamental_dbfs: to_db(fund_mag),
        })
    }

    /// Measure wow & flutter of a reference tone. When `generate` is true the
    /// reference tone is played on the output (loopback / driven DUT); otherwise
    /// silence is sent and the input is monitored (external transport playing a
    /// test tone). The captured input channel is FM-demodulated.
    pub async fn measure_wow_flutter(
        &self,
        reference_freq: f32,
        duration_secs: f32,
        output_channel: Channel,
        input_channel: Channel,
        generate: bool,
    ) -> Result<crate::audio::WowFlutterResult> {
        let sample_rate = self.config.lock().await.sample_rate.as_hz();
        let duration = duration_secs.clamp(1.0, 15.0);
        let n = (sample_rate as f32 * duration) as usize;

        let stim = if generate {
            // 0.5 amplitude reference tone.
            crate::utils::SignalGenerator::sine(reference_freq, 0.5, sample_rate, n)
        } else {
            vec![0.0f32; n]
        };
        let silence = vec![0.0f32; n];
        let (left, right) = match output_channel {
            Channel::Left => (stim.as_slice(), silence.as_slice()),
            Channel::Right => (silence.as_slice(), stim.as_slice()),
        };

        let captured = self.generate_and_capture(left, right).await?;
        let sig = match input_channel {
            Channel::Left => &captured.left_channel,
            Channel::Right => &captured.right_channel,
        };

        Ok(crate::audio::analyze_wow_flutter(sig, sample_rate, reference_freq))
    }

    /// Linear factor converting a full-scale-referenced digital RMS to Vrms for
    /// the given input channel, from the input full scale and factory ADC cal
    /// (PyQa40x model: `v = digital · cal_adc · 10^((inFS - 6)/20)`). Returns
    /// `(factor, calibrated)`; `calibrated=false` (cal assumed 0 dB) if the
    /// calibration page is unavailable.
    async fn input_volts_factor(&self, input_ch: Channel) -> (f32, bool) {
        let cfg = self.config.lock().await.clone();
        let in_fs = cfg.input_gain.as_dbv() as f32;
        let base = 10.0f32.powf((in_fs - 6.0) / 20.0);

        if let Some(page) = self.cal_page.lock().await.as_ref() {
            let base_off = CalibrationData::adc_offset(cfg.input_gain.as_dbv());
            let off = base_off.map(|o| if input_ch == Channel::Right { o + 6 } else { o });
            if let Some(o) = off {
                if o + 6 <= page.len() {
                    let db = f32::from_le_bytes([page[o + 2], page[o + 3], page[o + 4], page[o + 5]]);
                    if db.is_finite() && db.abs() < 40.0 {
                        return (base * 10.0f32.powf(db / 20.0), true);
                    }
                }
            }
        }
        (base, false)
    }

    /// dB to ADD to a dBFS reading on `input_ch` to obtain absolute dBV, for the
    /// current input range + factory calibration. Lets the UI display the
    /// spectrum in dBV instead of dBFS. Returns `(offset_db, calibrated)`.
    pub async fn input_dbv_offset(&self, input_ch: Channel) -> (f32, bool) {
        let (factor, calibrated) = self.input_volts_factor(input_ch).await;
        let offset = if factor > 0.0 { 20.0 * factor.log10() } else { 0.0 };
        (offset, calibrated)
    }

    /// Linear factor converting a full-scale-referenced digital RMS on a DAC
    /// channel to output Vrms, from the output full scale and factory DAC cal
    /// — the DAC-side mirror of `input_volts_factor`. Two conversions, two
    /// converters: the input factor moves with reg 5, this one with reg 6.
    ///
    /// Base: the output range's dBV is *the RMS of a sine at DAC full scale*
    /// (digital peak 1.0, digital RMS 1/√2 → 10^(outFS/20) Vrms), so the
    /// per-unit-digital-RMS factor is `√2 · 10^(outFS/20)`. The factory trim
    /// for the active output full scale DIVIDES (it is stored in the
    /// volts→digital direction): that sign is what keeps this factor
    /// consistent with `fr_calibration_offset` (hardware-validated — a
    /// resistive loopback FR reads ~0 dB), whose value must equal
    /// `input_dbv_offset − output_dbv_offset`.
    async fn output_volts_factor(&self, output_ch: Channel) -> (f32, bool) {
        let cfg = self.config.lock().await.clone();
        let base = dac_volts_per_digital_rms(cfg.output_gain.as_dbv() as f32);

        if let Some(page) = self.cal_page.lock().await.as_ref() {
            let base_off = CalibrationData::dac_offset(cfg.output_gain.as_dbv());
            let off = base_off.map(|o| if output_ch == Channel::Right { o + 6 } else { o });
            if let Some(o) = off {
                if o + 6 <= page.len() {
                    let db = f32::from_le_bytes([page[o + 2], page[o + 3], page[o + 4], page[o + 5]]);
                    if db.is_finite() && db.abs() < 40.0 {
                        return (base / 10.0f32.powf(db / 20.0), true);
                    }
                }
            }
        }
        (base, false)
    }

    /// dB to ADD to a dBFS reading of the generated stimulus on `output_ch` to
    /// obtain the absolute output level in dBV, for the current output range +
    /// factory calibration — the DAC-side mirror of `input_dbv_offset`. Each
    /// converter carries its OWN dBFS reference (it moves with that
    /// converter's range register), so an Output (stimulus) trace must be
    /// placed on an absolute dBV axis through this offset, never through the
    /// ADC's (task #51). Returns `(offset_db, calibrated)`.
    pub async fn output_dbv_offset(&self, output_ch: Channel) -> (f32, bool) {
        let (factor, calibrated) = self.output_volts_factor(output_ch).await;
        let offset = if factor > 0.0 { 20.0 * factor.log10() } else { 0.0 };
        (offset, calibrated)
    }

    /// Measure signal/noise levels on an input channel: unweighted / A / C RMS
    /// and peak (dBFS), plus absolute Vrms/dBV/dBu via calibration. With
    /// `generate` a stimulus tone is played (self-test); otherwise silence is
    /// sent and the input is monitored (e.g. a DUT's noise floor).
    pub async fn measure_levels(
        &self,
        input_channel: Channel,
        output_channel: Channel,
        duration_secs: f32,
        generate: bool,
        stimulus_freq: f32,
        stimulus_dbfs: f32,
    ) -> Result<crate::audio::LevelResult> {
        let sample_rate = self.config.lock().await.sample_rate.as_hz();
        let duration = duration_secs.clamp(0.2, 15.0);
        let n = (sample_rate as f32 * duration) as usize;

        let stim = if generate {
            let amp = 10.0f32.powf(stimulus_dbfs.clamp(-80.0, 0.0) / 20.0);
            crate::utils::SignalGenerator::sine(stimulus_freq, amp, sample_rate, n)
        } else {
            vec![0.0f32; n]
        };
        let silence = vec![0.0f32; n];
        let (left, right) = match output_channel {
            Channel::Left => (stim.as_slice(), silence.as_slice()),
            Channel::Right => (silence.as_slice(), stim.as_slice()),
        };

        let captured = self.generate_and_capture(left, right).await?;
        let sig = match input_channel {
            Channel::Left => &captured.left_channel,
            Channel::Right => &captured.right_channel,
        };

        let m = crate::audio::analyze_levels(sig, sample_rate);
        let (factor, calibrated) = self.input_volts_factor(input_channel).await;

        let lin = |dbfs: f32| 10.0f32.powf(dbfs / 20.0);
        let v_rms = lin(m.rms_dbfs) * factor;
        let v_a = lin(m.rms_a_dbfs) * factor;
        let v_to_dbv = |v: f32| if v > 0.0 { 20.0 * v.log10() } else { -200.0 };

        Ok(crate::audio::LevelResult {
            rms_dbfs: m.rms_dbfs,
            peak_dbfs: m.peak_dbfs,
            rms_a_dbfs: m.rms_a_dbfs,
            rms_c_dbfs: m.rms_c_dbfs,
            rms_vrms: v_rms,
            rms_dbv: v_to_dbv(v_rms),
            rms_dbu: v_to_dbv(v_rms / 0.775),
            rms_a_dbv: v_to_dbv(v_a),
            calibrated,
        })
    }
}

/// Await an endpoint's next completion with a timeout. nusb 0.2 decouples
/// `submit` from completion (unlike 0.1, where dropping the transfer future
/// cancelled it), so on timeout we cancel the endpoint's queued transfers and
/// drain every cancellation — otherwise the next submit/collect would pick up a
/// stale completion.
async fn complete_or_cancel<T: EndpointQueue>(
    ep: &mut T,
    timeout: Duration,
) -> Result<Completion> {
    match tokio::time::timeout(timeout, ep.next_complete()).await {
        Ok(c) => Ok(c),
        Err(_) => {
            cancel_and_drain(ep).await;
            Err(QA40xError::Timeout)
        }
    }
}

/// Cancel every queued transfer on an endpoint and drain ALL the resulting
/// completions, leaving the endpoint's completion queue empty. Leaving even one
/// stale (cancelled) completion queued would hand it to the next collector and
/// fail it with "transfer was cancelled" — see `stream_pump`.
async fn cancel_and_drain<T: EndpointQueue>(ep: &mut T) {
    ep.cancel_all();
    while ep.pending() > 0 {
        if tokio::time::timeout(Duration::from_millis(500), ep.next_complete())
            .await
            .is_err()
        {
            debug!("cancel_and_drain: {} transfers still pending after drain timeout", ep.pending());
            break;
        }
    }
}

#[async_trait]
impl RegisterOps for QA40xDevice {
    async fn read_register(&self, address: u8) -> Result<Vec<u8>> {
        debug!("READ_REGISTER: Starting read from register 0x{:02X}", address);

        let mut guard = self.eps.lock().await;
        let eps = guard.as_mut().ok_or(QA40xError::DeviceNotOpened)?;

        // To read a register, write (0x80 | address) + 4 zero bytes on the
        // register-write endpoint, then read the 4-byte reply on register-read.
        let read_address = 0x80 | address;
        let mut cmd = Vec::with_capacity(5);
        cmd.push(read_address);
        cmd.extend_from_slice(&[0u8; 4]);

        eps.register_write.submit(cmd.into());
        complete_or_cancel(&mut eps.register_write, Duration::from_secs(1))
            .await?
            .status
            .map_err(QA40xError::from)?;

        eps.register_read.submit(Buffer::new(512)); // bulk IN needs a multiple of max_packet (512); device short-packets 4 bytes
        let data = complete_or_cancel(&mut eps.register_read, Duration::from_secs(1))
            .await?
            .into_result()
            .map_err(QA40xError::from)?;

        debug!("READ_REGISTER: read {} bytes from 0x{:02X}: {:02X?}", data.len(), address, &data[..]);
        Ok(data.to_vec())
    }

    async fn write_register(&self, address: u8, data: &[u8]) -> Result<()> {
        debug!("Writing {} bytes to register 0x{:02X}: {:02X?}", data.len(), address, data);

        let mut guard = self.eps.lock().await;
        let eps = guard.as_mut().ok_or(QA40xError::DeviceNotOpened)?;

        let mut buffer = Vec::with_capacity(data.len() + 1);
        buffer.push(address);
        buffer.extend_from_slice(data);

        eps.register_write.submit(buffer.into());
        complete_or_cancel(&mut eps.register_write, Duration::from_secs(1))
            .await?
            .status
            .map_err(QA40xError::from)?;

        debug!("Successfully wrote to register 0x{:02X}", address);
        Ok(())
    }
}

impl Default for QA40xDevice {
    fn default() -> Self {
        Self::new()
    }
}

/// Vrms produced per unit of full-scale-referenced digital RMS on the DAC, at
/// an output full scale of `out_fs_dbv`. The output range's dBV is defined as
/// the RMS of a **sine at DAC full scale**: digital peak 1.0 (RMS 1/√2)
/// ↦ 10^(outFS/20) Vrms, hence the √2. Getting this wrong by dropping the √2
/// is a systematic 3.01 dB error on every displayed output level.
fn dac_volts_per_digital_rms(out_fs_dbv: f32) -> f32 {
    std::f32::consts::SQRT_2 * 10.0f32.powf(out_fs_dbv / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dac_dbfs_to_dbv_offset_is_the_range_plus_the_sine_rms_sqrt2() {
        // A digital full-scale sine plays at the range's dBV RMS, so the
        // dBFS→dBV offset (in dB) is outFS + 20·log10(√2) ≈ outFS + 3.0103.
        for (fs, expect) in [(8.0f32, 11.0103f32), (18.0, 21.0103), (-12.0, -8.9897)] {
            let off = 20.0 * dac_volts_per_digital_rms(fs).log10();
            assert!(
                (off - expect).abs() < 1e-3,
                "outFS {fs}: offset {off} != {expect}"
            );
        }
    }

    #[test]
    fn input_minus_output_offset_matches_the_validated_loopback_identity() {
        // `fr_calibration_offset` (hardware-validated: a resistive loopback FR
        // reads ~0 dB) is `inFS − outFS − 9 + cal_adc + cal_dac` with the 9 =
        // 3 (DAC peak↔sine-RMS) + 6 (differential ADC input). The two per-
        // converter offsets must reproduce it: input (inFS − 6 + cal_adc)
        // minus output (outFS + √2 − cal_dac). Trim-free case checked here;
        // the FR path rounds √2 to 3.0 dB, hence the 0.011 dB tolerance.
        let (in_fs, out_fs) = (6.0f32, 8.0f32);
        let input_off = in_fs - 6.0;
        let output_off = 20.0 * dac_volts_per_digital_rms(out_fs).log10();
        let fr_offset = in_fs - out_fs - 9.0;
        assert!(((input_off - output_off) - fr_offset).abs() < 0.011);
    }
}
