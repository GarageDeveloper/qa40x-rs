//! The bulk-endpoint seam between the real USB device and the embedded
//! virtual QA40x (demo mode).
//!
//! [`crate::qa40x::device::QA40xDevice`] does all its I/O through four
//! endpoint queues with nusb 0.2 semantics: `submit()` enqueues a transfer,
//! `next_complete()` returns completions in submission order, `cancel_all()`
//! + draining empties the queue. [`BulkOut`]/[`BulkIn`] keep exactly those
//! semantics and dispatch to either a claimed `nusb::Endpoint` or a
//! [`VirtEp`] driving the in-process `vqa40x-core` simulator through its
//! `UsbBackend` trait (bulk EP1 register frames, bulk EP2 audio streaming —
//! the same wire protocol as the hardware, minus the USB bus).

use async_trait::async_trait;
use log::debug;
use nusb::transfer::{Buffer, Bulk, Completion, In, Out, TransferError};
use nusb::Endpoint;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Notify};
use vqa40x_core::{SimOptions, Simulator};

/// The queue operations `complete_or_cancel` / `cancel_and_drain` need,
/// shared by the OUT and IN wrappers.
#[async_trait]
pub trait EndpointQueue: Send {
    async fn next_complete(&mut self) -> Completion;
    fn pending(&self) -> usize;
    fn cancel_all(&mut self);
}

/// A bulk OUT endpoint: real (nusb) or virtual (in-process simulator).
pub enum BulkOut {
    Usb(Endpoint<Bulk, Out>),
    Virt(VirtEp),
}

/// A bulk IN endpoint: real (nusb) or virtual (in-process simulator).
pub enum BulkIn {
    Usb(Endpoint<Bulk, In>),
    Virt(VirtEp),
}

impl BulkOut {
    pub fn submit(&mut self, buf: Buffer) {
        match self {
            Self::Usb(ep) => ep.submit(buf),
            Self::Virt(ep) => ep.submit(buf),
        }
    }

    /// Clear a STALL condition. The simulator has no halt state — a no-op.
    pub async fn clear_halt(&mut self) -> Result<(), nusb::Error> {
        match self {
            Self::Usb(ep) => ep.clear_halt().await,
            Self::Virt(_) => Ok(()),
        }
    }
}

impl BulkIn {
    pub fn submit(&mut self, buf: Buffer) {
        match self {
            Self::Usb(ep) => ep.submit(buf),
            Self::Virt(ep) => ep.submit(buf),
        }
    }

    pub async fn clear_halt(&mut self) -> Result<(), nusb::Error> {
        match self {
            Self::Usb(ep) => ep.clear_halt().await,
            Self::Virt(_) => Ok(()),
        }
    }
}

#[async_trait]
impl EndpointQueue for BulkOut {
    async fn next_complete(&mut self) -> Completion {
        match self {
            Self::Usb(ep) => ep.next_complete().await,
            Self::Virt(ep) => ep.next_complete().await,
        }
    }

    fn pending(&self) -> usize {
        match self {
            Self::Usb(ep) => ep.pending(),
            Self::Virt(ep) => ep.pending(),
        }
    }

    fn cancel_all(&mut self) {
        match self {
            Self::Usb(ep) => ep.cancel_all(),
            Self::Virt(ep) => ep.cancel_all(),
        }
    }
}

#[async_trait]
impl EndpointQueue for BulkIn {
    async fn next_complete(&mut self) -> Completion {
        match self {
            Self::Usb(ep) => ep.next_complete().await,
            Self::Virt(ep) => ep.next_complete().await,
        }
    }

    fn pending(&self) -> usize {
        match self {
            Self::Usb(ep) => ep.pending(),
            Self::Virt(ep) => ep.pending(),
        }
    }

    fn cancel_all(&mut self) {
        match self {
            Self::Usb(ep) => ep.cancel_all(),
            Self::Virt(ep) => ep.cancel_all(),
        }
    }
}

/// One submitted transfer, stamped with the cancel generation at submit time
/// so `cancel_all` cancels exactly the transfers queued before it.
struct Item {
    buf: Buffer,
    generation: u64,
}

/// A virtual bulk endpoint over the simulator's `UsbBackend`.
///
/// A worker task performs the backend calls one submission at a time (nusb
/// queues complete in submission order); the endpoint address carries the USB
/// direction bit (0x81 = EP1 IN), like the trait expects. `in_transfer` may
/// block until the device has data (register reply, realtime-paced ADC
/// block) — `cancel_all` interrupts it and the transfer completes Cancelled,
/// which is what the device layer's timeout path drains.
pub struct VirtEp {
    submit_tx: mpsc::UnboundedSender<Item>,
    complete_rx: mpsc::UnboundedReceiver<Completion>,
    pending: Arc<AtomicUsize>,
    cancel_generation: Arc<AtomicU64>,
    cancel_notify: Arc<Notify>,
}

impl VirtEp {
    pub fn new(sim: Simulator, addr: u8) -> Self {
        let (submit_tx, mut submit_rx) = mpsc::unbounded_channel::<Item>();
        let (complete_tx, complete_rx) = mpsc::unbounded_channel::<Completion>();
        let cancel_generation = Arc::new(AtomicU64::new(0));
        let cancel_notify = Arc::new(Notify::new());
        let generation = cancel_generation.clone();
        let notify = cancel_notify.clone();
        tokio::spawn(async move {
            while let Some(item) = submit_rx.recv().await {
                let completion = Self::perform(&sim, addr, item, &generation, &notify).await;
                if complete_tx.send(completion).is_err() {
                    break; // endpoint dropped — worker exits
                }
            }
        });
        Self {
            submit_tx,
            complete_rx,
            pending: Arc::new(AtomicUsize::new(0)),
            cancel_generation,
            cancel_notify,
        }
    }

    /// Run one transfer against the current persona. Checked against the
    /// cancel generation before AND during the call: an `in_transfer` with
    /// nothing to return blocks until cancelled, exactly like a real bulk IN
    /// URB. The periodic tick closes the register-then-check race window a
    /// pure Notify wait would leave open.
    async fn perform(
        sim: &Simulator,
        addr: u8,
        item: Item,
        cancel_generation: &AtomicU64,
        notify: &Notify,
    ) -> Completion {
        let cancelled = |buf: Buffer| Completion {
            buffer: buf,
            actual_len: 0,
            status: Err(TransferError::Cancelled),
        };
        if item.generation < cancel_generation.load(Ordering::SeqCst) {
            return cancelled(item.buf);
        }

        let backend = sim.current();
        if addr & 0x80 != 0 {
            let want = item.buf.requested_len();
            let fut = backend.in_transfer(addr, want);
            tokio::pin!(fut);
            loop {
                let notified = notify.notified();
                tokio::pin!(notified);
                tokio::select! {
                    res = &mut fut => {
                        return match res {
                            Ok(data) => {
                                let actual_len = data.len();
                                Completion { buffer: Buffer::from(data), actual_len, status: Ok(()) }
                            }
                            Err(_stall) => Completion {
                                buffer: item.buf,
                                actual_len: 0,
                                status: Err(TransferError::Stall),
                            },
                        };
                    }
                    _ = &mut notified => {}
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {}
                }
                if item.generation < cancel_generation.load(Ordering::SeqCst) {
                    debug!("virtual EP 0x{addr:02X}: in-flight IN transfer cancelled");
                    return cancelled(item.buf);
                }
            }
        } else {
            match backend.out_transfer(addr, &item.buf[..]).await {
                Ok(accepted) => Completion {
                    actual_len: accepted,
                    buffer: item.buf,
                    status: Ok(()),
                },
                Err(_stall) => Completion {
                    buffer: item.buf,
                    actual_len: 0,
                    status: Err(TransferError::Stall),
                },
            }
        }
    }

    pub fn submit(&mut self, buf: Buffer) {
        self.pending.fetch_add(1, Ordering::SeqCst);
        let _ = self.submit_tx.send(Item {
            buf,
            generation: self.cancel_generation.load(Ordering::SeqCst),
        });
    }

    pub async fn next_complete(&mut self) -> Completion {
        let completion = match self.complete_rx.recv().await {
            Some(c) => c,
            // Worker gone (can't happen while submit_tx lives) — report the
            // device as gone rather than panicking mid-capture.
            None => Completion {
                buffer: Buffer::new(0),
                actual_len: 0,
                status: Err(TransferError::Disconnected),
            },
        };
        self.pending.fetch_sub(1, Ordering::SeqCst);
        completion
    }

    pub fn pending(&self) -> usize {
        self.pending.load(Ordering::SeqCst)
    }

    pub fn cancel_all(&mut self) {
        self.cancel_generation.fetch_add(1, Ordering::SeqCst);
        self.cancel_notify.notify_waiters();
    }
}

/// The demo device the app embeds: a QA403 with a clean loopback path, a
/// realistic noise floor and just enough harmonic distortion (H2 −90 dBc,
/// H3 −100 dBc) that THD measurements have something real to show. Streams
/// are paced at the sample rate like hardware; the calibration page served is
/// a real factory page, so the app's absolute-level path runs calibrated.
pub fn demo_sim_options() -> SimOptions {
    let model = vqa40x_core::Model::Qa403;
    SimOptions {
        model,
        pid: model.default_pid(),
        h2_dbc: Some(-90.0),
        h3_dbc: Some(-100.0),
        ..SimOptions::default()
    }
}
