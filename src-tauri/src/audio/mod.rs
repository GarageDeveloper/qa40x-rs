pub mod fft;
pub mod spectrum;
pub mod analysis;
pub mod frequency_response;
pub mod wow_flutter;
pub mod weighting;
pub mod trigger;
pub mod scope_measure;
#[cfg(test)]
mod validation;

pub use fft::*;
pub use spectrum::*;
pub use analysis::*;
pub use frequency_response::{analyze_sweep, FrequencyResponseData, FrequencyResponseTrace};
pub use wow_flutter::{analyze_wow_flutter, WowFlutterResult};
pub use weighting::{analyze_levels, weighted_rms, LevelMetrics, LevelResult, Weighting};
pub use trigger::{auto_hysteresis, find_edge, refine_linear, Edge, TriggerHit};
pub use scope_measure::{measure_scope, ScopeValues, SlidingStats, StatsSnapshot};
