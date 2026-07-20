use thiserror::Error;

#[derive(Error, Debug)]
pub enum QA40xError {
    #[error("USB transfer error: {0}")]
    TransferError(#[from] nusb::transfer::TransferError),

    #[error("Device error: {0}")]
    DeviceError(String),

    #[error("Device not found")]
    DeviceNotFound,

    #[error("Device not opened")]
    DeviceNotOpened,

    #[error("Invalid register address: {0}")]
    InvalidRegister(u8),

    #[error("Invalid value: {0}")]
    InvalidValue(String),

    #[error("Timeout waiting for operation")]
    Timeout,

    /// A capture aborted on the caller's cancel flag (user stop) — the
    /// stream was closed through the normal STREAM_STOP + drain path; the
    /// device is healthy. Callers surface this as "cancelled", never retry.
    #[error("cancelled")]
    Cancelled,

    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, QA40xError>;
