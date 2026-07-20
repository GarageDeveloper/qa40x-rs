pub mod device;
pub mod register;
pub mod error;
pub mod settle;
pub mod types;

pub use device::{DeviceMeta, QA40xDevice, Telemetry};
pub use error::{QA40xError, Result};
pub use types::*;

// The frequency-response payload lives with the DSP code that produces it.
pub use crate::audio::frequency_response::{FrequencyResponseData, FrequencyResponseTrace};
