use crate::qa40x::QA40xError;
use thiserror::Error;

/// Errors at the device-abstraction seam.
#[derive(Error, Debug)]
pub enum DeviceError {
    /// No unit matches the requested id (or no unit at all for an
    /// open-first). Displays as `Device not found` so `connect_device`'s
    /// user-facing string stays byte-identical to the pre-registry
    /// `QA40xError::DeviceNotFound` path.
    #[error("Device not found")]
    NotFound,

    /// A command named a `device_id` that is not an open device (issue #25
    /// lot C). Distinct from [`DeviceError::NotFound`]: the caller asked for
    /// a SPECIFIC unit and must never be silently served another one.
    #[error("Unknown device: {0}")]
    UnknownDevice(String),

    /// `open_additional` named a unit that is already open on some runtime
    /// (issue #25 lot E). Distinct from a supersede: adding a device must
    /// never silently steal an open unit's claim onto a second runtime.
    #[error("Device already open: {0}")]
    AlreadyOpen(String),

    /// Every device slot is occupied (issue #25 lot E,
    /// [`super::registry::MAX_DEVICES`]).
    #[error("All device slots are in use")]
    NoFreeSlot,

    /// A source failed to enumerate or open (bus scan error, simulator
    /// already attached, ...).
    #[error("{0}")]
    Source(String),

    /// The underlying QA40x device operation failed.
    #[error("{0}")]
    Device(QA40xError),
}

impl From<QA40xError> for DeviceError {
    fn from(e: QA40xError) -> Self {
        match e {
            // Preserve the identity of "not found" across the seam so
            // callers matching on it (and its display) see one variant.
            QA40xError::DeviceNotFound => DeviceError::NotFound,
            e => DeviceError::Device(e),
        }
    }
}

/// The reverse crossing, for `QA40xDevice::connect()` which now scans through
/// [`super::usb`] but keeps returning its historical error type (its
/// signature is frozen for the examples and the A/B bench).
impl From<DeviceError> for QA40xError {
    fn from(e: DeviceError) -> Self {
        match e {
            DeviceError::NotFound => QA40xError::DeviceNotFound,
            DeviceError::UnknownDevice(id) => {
                QA40xError::DeviceError(format!("Unknown device: {id}"))
            }
            e @ (DeviceError::AlreadyOpen(_) | DeviceError::NoFreeSlot) => {
                QA40xError::DeviceError(e.to_string())
            }
            DeviceError::Source(s) => QA40xError::DeviceError(s),
            DeviceError::Device(e) => e,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_found_displays_exactly_like_the_legacy_qa40x_variant() {
        // `connect_device` formats `Failed to connect: {e}` — the registry
        // path must produce the identical user-facing string.
        assert_eq!(DeviceError::NotFound.to_string(), QA40xError::DeviceNotFound.to_string());
        assert_eq!(DeviceError::NotFound.to_string(), "Device not found");
    }

    #[test]
    fn qa40x_errors_display_unchanged_through_the_seam() {
        let e = QA40xError::DeviceError("Failed to open device: busy".into());
        let wrapped: DeviceError = QA40xError::DeviceError("Failed to open device: busy".into()).into();
        assert_eq!(wrapped.to_string(), e.to_string());
        // And DeviceNotFound folds into the dedicated variant.
        assert!(matches!(DeviceError::from(QA40xError::DeviceNotFound), DeviceError::NotFound));
    }
}
