//! Persistence for measurement history and projects.
//!
//! A **project** groups the measurements taken while working on one device
//! under test (e.g. "Doug Self preamp"). Each **measurement record** captures a
//! measurement's data plus its full context — the device configuration and
//! measurement parameters in effect, a timestamp, and a free-text user comment —
//! so measurements can be browsed, annotated and overlaid for comparison.
//!
//! Everything is stored as JSON under a base directory (the Tauri app-data dir
//! in production). The core functions take the base directory explicitly so they
//! can be unit-tested against a temporary directory.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::storage::error::{StorageError, StorageResult};

pub mod error;

/// Project metadata (without its measurements).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// ISO-8601 timestamps supplied by the caller (the frontend).
    pub created: String,
    pub updated: String,
}

/// A stored measurement together with the context in which it was taken.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasurementRecord {
    pub id: String,
    pub project_id: String,
    /// User-facing label, e.g. "After C7 swap".
    pub name: String,
    /// Discriminator for the payload: "frequency_response" | "spectrum" |
    /// "analysis" | ... The frontend and UI interpret `data` accordingly.
    pub kind: String,
    /// ISO-8601 timestamp supplied by the caller.
    pub timestamp: String,
    /// Free-text notes from whoever ran the measurement.
    #[serde(default)]
    pub comment: String,
    /// Device configuration in effect (input/output full scale, sample rate).
    pub device_config: serde_json::Value,
    /// Measurement-specific parameters (sweep range, duration, amplitude, ...).
    #[serde(default)]
    pub params: serde_json::Value,
    /// The measurement payload (traces, peaks, metrics, ...).
    pub data: serde_json::Value,
}

/// Input to [`save_measurement`] — the record without a server-assigned id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMeasurement {
    pub project_id: String,
    pub name: String,
    pub kind: String,
    pub timestamp: String,
    #[serde(default)]
    pub comment: String,
    pub device_config: serde_json::Value,
    #[serde(default)]
    pub params: serde_json::Value,
    pub data: serde_json::Value,
}

fn projects_file(base: &Path) -> PathBuf {
    base.join("projects.json")
}

/// Reject any id that could escape the storage base directory. Storage IDs are
/// server-generated UUIDs; a frontend-supplied id is only ever used to look one
/// up, so it must be a plain token — no path separators, no `.`/`..`, not
/// absolute, non-empty, bounded length. Called by every path builder below, so a
/// crafted id like `"../.."` can never reach the filesystem (audit S1).
fn valid_id(id: &str) -> StorageResult<()> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(StorageError::Invalid(format!("invalid id: {id:?}")))
    }
}

fn measurements_dir(base: &Path, project_id: &str) -> StorageResult<PathBuf> {
    valid_id(project_id)?;
    Ok(base.join("measurements").join(project_id))
}

fn measurement_file(base: &Path, project_id: &str, measurement_id: &str) -> StorageResult<PathBuf> {
    valid_id(measurement_id)?;
    Ok(measurements_dir(base, project_id)?.join(format!("{measurement_id}.json")))
}

fn read_projects(base: &Path) -> StorageResult<Vec<Project>> {
    let path = projects_file(base);
    match fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(StorageError::Io(e.to_string())),
    }
}

fn write_projects(base: &Path, projects: &[Project]) -> StorageResult<()> {
    fs::create_dir_all(base).map_err(|e| StorageError::Io(e.to_string()))?;
    let bytes = serde_json::to_vec_pretty(projects)?;
    write_atomic(&projects_file(base), &bytes)
}

/// Write via a temp file + rename so a crash mid-write can't corrupt the target.
fn write_atomic(path: &Path, bytes: &[u8]) -> StorageResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| StorageError::Io(e.to_string()))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| StorageError::Io(e.to_string()))?;
    fs::rename(&tmp, path).map_err(|e| StorageError::Io(e.to_string()))?;
    Ok(())
}

/// List all projects, most-recently-updated first.
pub fn list_projects(base: &Path) -> StorageResult<Vec<Project>> {
    let mut projects = read_projects(base)?;
    projects.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(projects)
}

/// Create a new project. `now` is an ISO-8601 timestamp from the caller.
pub fn create_project(
    base: &Path,
    name: &str,
    description: &str,
    now: &str,
) -> StorageResult<Project> {
    if name.trim().is_empty() {
        return Err(StorageError::Invalid("Project name must not be empty".into()));
    }
    let mut projects = read_projects(base)?;
    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        description: description.to_string(),
        created: now.to_string(),
        updated: now.to_string(),
    };
    projects.push(project.clone());
    write_projects(base, &projects)?;
    Ok(project)
}

/// Update a project's name/description. `now` bumps `updated`.
pub fn update_project(
    base: &Path,
    project_id: &str,
    name: Option<&str>,
    description: Option<&str>,
    now: &str,
) -> StorageResult<Project> {
    let mut projects = read_projects(base)?;
    let p = projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| StorageError::NotFound(format!("project {project_id}")))?;
    if let Some(name) = name {
        if name.trim().is_empty() {
            return Err(StorageError::Invalid("Project name must not be empty".into()));
        }
        p.name = name.trim().to_string();
    }
    if let Some(desc) = description {
        p.description = desc.to_string();
    }
    p.updated = now.to_string();
    let updated = p.clone();
    write_projects(base, &projects)?;
    Ok(updated)
}

/// Delete a project and all of its measurements.
pub fn delete_project(base: &Path, project_id: &str) -> StorageResult<()> {
    let mut projects = read_projects(base)?;
    let before = projects.len();
    projects.retain(|p| p.id != project_id);
    if projects.len() == before {
        return Err(StorageError::NotFound(format!("project {project_id}")));
    }
    write_projects(base, &projects)?;
    // Remove the measurement / session / test-plan directories if present.
    for dir in [
        measurements_dir(base, project_id)?,
        sessions_dir(base, project_id)?,
        testplans_dir(base, project_id)?,
    ] {
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| StorageError::Io(e.to_string()))?;
        }
    }
    Ok(())
}

fn sessions_dir(base: &Path, project_id: &str) -> StorageResult<PathBuf> {
    valid_id(project_id)?;
    Ok(base.join("sessions").join(project_id))
}

fn session_file(base: &Path, project_id: &str, session_id: &str) -> StorageResult<PathBuf> {
    valid_id(session_id)?;
    Ok(sessions_dir(base, project_id)?.join(format!("{session_id}.json")))
}

fn testplans_dir(base: &Path, project_id: &str) -> StorageResult<PathBuf> {
    valid_id(project_id)?;
    Ok(base.join("testplans").join(project_id))
}

fn testplan_file(base: &Path, project_id: &str, plan_id: &str) -> StorageResult<PathBuf> {
    valid_id(plan_id)?;
    Ok(testplans_dir(base, project_id)?.join(format!("{plan_id}.json")))
}

fn bump_project_updated(base: &Path, project_id: &str, now: &str) -> StorageResult<()> {
    let mut projects = read_projects(base)?;
    if let Some(p) = projects.iter_mut().find(|p| p.id == project_id) {
        p.updated = now.to_string();
        write_projects(base, &projects)?;
    }
    Ok(())
}

/// Save a new measurement into its project. Returns the stored record with its
/// server-assigned id.
pub fn save_measurement(base: &Path, new: NewMeasurement) -> StorageResult<MeasurementRecord> {
    // The project must exist.
    let projects = read_projects(base)?;
    if !projects.iter().any(|p| p.id == new.project_id) {
        return Err(StorageError::NotFound(format!("project {}", new.project_id)));
    }
    let record = MeasurementRecord {
        id: uuid::Uuid::new_v4().to_string(),
        project_id: new.project_id,
        name: new.name,
        kind: new.kind,
        timestamp: new.timestamp.clone(),
        comment: new.comment,
        device_config: new.device_config,
        params: new.params,
        data: new.data,
    };
    let path = measurement_file(base, &record.project_id, &record.id)?;
    let bytes = serde_json::to_vec_pretty(&record)?;
    write_atomic(&path, &bytes)?;
    bump_project_updated(base, &record.project_id, &new.timestamp)?;
    Ok(record)
}

/// A saved **session**: a snapshot of the whole workspace — the settings in
/// effect plus the set of displayed curves (each with its markers and remarks).
/// `settings` and `curves` are opaque JSON defined by the frontend, so the
/// session format can evolve without backend changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub timestamp: String,
    #[serde(default)]
    pub comment: String,
    /// Snapshot of device config + measurement parameters.
    pub settings: serde_json::Value,
    /// The displayed curves, each with data, markers and remarks.
    pub curves: serde_json::Value,
}

/// Input to [`save_session`] — a session without a server-assigned id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSession {
    pub project_id: String,
    pub name: String,
    pub timestamp: String,
    #[serde(default)]
    pub comment: String,
    pub settings: serde_json::Value,
    pub curves: serde_json::Value,
}

/// A session without its curve payload, for listings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub timestamp: String,
    pub comment: String,
    /// Number of curves in the session (cheap to show in a listing).
    pub curve_count: usize,
}

/// A measurement without its (potentially large) data payload, for listings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasurementSummary {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub kind: String,
    pub timestamp: String,
    pub comment: String,
}

impl From<&MeasurementRecord> for MeasurementSummary {
    fn from(r: &MeasurementRecord) -> Self {
        Self {
            id: r.id.clone(),
            project_id: r.project_id.clone(),
            name: r.name.clone(),
            kind: r.kind.clone(),
            timestamp: r.timestamp.clone(),
            comment: r.comment.clone(),
        }
    }
}

/// List a project's measurements (summaries only), newest first.
pub fn list_measurements(base: &Path, project_id: &str) -> StorageResult<Vec<MeasurementSummary>> {
    let dir = measurements_dir(base, project_id)?;
    let mut out = Vec::new();
    match fs::read_dir(&dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(bytes) = fs::read(&path) {
                    if let Ok(rec) = serde_json::from_slice::<MeasurementRecord>(&bytes) {
                        out.push(MeasurementSummary::from(&rec));
                    }
                }
            }
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(StorageError::Io(e.to_string())),
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

/// Load a full measurement record (with data payload).
pub fn get_measurement(
    base: &Path,
    project_id: &str,
    measurement_id: &str,
) -> StorageResult<MeasurementRecord> {
    let path = measurement_file(base, project_id, measurement_id)?;
    let bytes = fs::read(&path).map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            StorageError::NotFound(format!("measurement {measurement_id}"))
        } else {
            StorageError::Io(e.to_string())
        }
    })?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Update a measurement's name and/or free-text comment.
pub fn update_measurement(
    base: &Path,
    project_id: &str,
    measurement_id: &str,
    name: Option<&str>,
    comment: Option<&str>,
) -> StorageResult<MeasurementRecord> {
    let mut rec = get_measurement(base, project_id, measurement_id)?;
    if let Some(name) = name {
        if name.trim().is_empty() {
            return Err(StorageError::Invalid("Measurement name must not be empty".into()));
        }
        rec.name = name.trim().to_string();
    }
    if let Some(comment) = comment {
        rec.comment = comment.to_string();
    }
    let path = measurement_file(base, project_id, measurement_id)?;
    let bytes = serde_json::to_vec_pretty(&rec)?;
    write_atomic(&path, &bytes)?;
    Ok(rec)
}

/// Delete a single measurement.
pub fn delete_measurement(
    base: &Path,
    project_id: &str,
    measurement_id: &str,
) -> StorageResult<()> {
    let path = measurement_file(base, project_id, measurement_id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            Err(StorageError::NotFound(format!("measurement {measurement_id}")))
        }
        Err(e) => Err(StorageError::Io(e.to_string())),
    }
}

/* ----------------------------- Sessions ------------------------------ */

/// Save a session snapshot into its project.
pub fn save_session(base: &Path, new: NewSession) -> StorageResult<Session> {
    let projects = read_projects(base)?;
    if !projects.iter().any(|p| p.id == new.project_id) {
        return Err(StorageError::NotFound(format!("project {}", new.project_id)));
    }
    let session = Session {
        id: uuid::Uuid::new_v4().to_string(),
        project_id: new.project_id,
        name: new.name,
        timestamp: new.timestamp.clone(),
        comment: new.comment,
        settings: new.settings,
        curves: new.curves,
    };
    let path = session_file(base, &session.project_id, &session.id)?;
    write_atomic(&path, &serde_json::to_vec_pretty(&session)?)?;
    bump_project_updated(base, &session.project_id, &new.timestamp)?;
    Ok(session)
}

/// List a project's sessions (summaries only), newest first.
pub fn list_sessions(base: &Path, project_id: &str) -> StorageResult<Vec<SessionSummary>> {
    let dir = sessions_dir(base, project_id)?;
    let mut out = Vec::new();
    match fs::read_dir(&dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(bytes) = fs::read(&path) {
                    if let Ok(s) = serde_json::from_slice::<Session>(&bytes) {
                        out.push(SessionSummary {
                            id: s.id,
                            project_id: s.project_id,
                            name: s.name,
                            timestamp: s.timestamp,
                            comment: s.comment,
                            curve_count: s.curves.as_array().map(|a| a.len()).unwrap_or(0),
                        });
                    }
                }
            }
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(StorageError::Io(e.to_string())),
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

/// Load a full session (with settings + curves).
pub fn get_session(base: &Path, project_id: &str, session_id: &str) -> StorageResult<Session> {
    let path = session_file(base, project_id, session_id)?;
    let bytes = fs::read(&path).map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            StorageError::NotFound(format!("session {session_id}"))
        } else {
            StorageError::Io(e.to_string())
        }
    })?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Update a session's name and/or comment.
pub fn update_session(
    base: &Path,
    project_id: &str,
    session_id: &str,
    name: Option<&str>,
    comment: Option<&str>,
) -> StorageResult<Session> {
    let mut s = get_session(base, project_id, session_id)?;
    if let Some(name) = name {
        if name.trim().is_empty() {
            return Err(StorageError::Invalid("Session name must not be empty".into()));
        }
        s.name = name.trim().to_string();
    }
    if let Some(comment) = comment {
        s.comment = comment.to_string();
    }
    let path = session_file(base, project_id, session_id)?;
    write_atomic(&path, &serde_json::to_vec_pretty(&s)?)?;
    Ok(s)
}

/// Delete a session.
pub fn delete_session(base: &Path, project_id: &str, session_id: &str) -> StorageResult<()> {
    let path = session_file(base, project_id, session_id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            Err(StorageError::NotFound(format!("session {session_id}")))
        }
        Err(e) => Err(StorageError::Io(e.to_string())),
    }
}

/* ----------------------------- Test plans ---------------------------- */

/// A reusable **test plan**: an ordered battery of measurement steps. `steps`
/// is opaque JSON (an array of `{ kind, params, label }`), defined by the
/// frontend, so the step schema can evolve without backend changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestPlan {
    pub id: String,
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub steps: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTestPlan {
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub steps: serde_json::Value,
}

/// Save (create) a test plan.
pub fn save_test_plan(base: &Path, new: NewTestPlan) -> StorageResult<TestPlan> {
    let projects = read_projects(base)?;
    if !projects.iter().any(|p| p.id == new.project_id) {
        return Err(StorageError::NotFound(format!("project {}", new.project_id)));
    }
    let plan = TestPlan {
        id: uuid::Uuid::new_v4().to_string(),
        project_id: new.project_id,
        name: new.name,
        description: new.description,
        steps: new.steps,
    };
    let path = testplan_file(base, &plan.project_id, &plan.id)?;
    write_atomic(&path, &serde_json::to_vec_pretty(&plan)?)?;
    Ok(plan)
}

/// Overwrite an existing test plan's name/description/steps.
pub fn update_test_plan(
    base: &Path,
    project_id: &str,
    plan_id: &str,
    name: Option<&str>,
    description: Option<&str>,
    steps: Option<serde_json::Value>,
) -> StorageResult<TestPlan> {
    let mut plan = get_test_plan(base, project_id, plan_id)?;
    if let Some(name) = name {
        if name.trim().is_empty() {
            return Err(StorageError::Invalid("Test plan name must not be empty".into()));
        }
        plan.name = name.trim().to_string();
    }
    if let Some(desc) = description {
        plan.description = desc.to_string();
    }
    if let Some(steps) = steps {
        plan.steps = steps;
    }
    let path = testplan_file(base, project_id, plan_id)?;
    write_atomic(&path, &serde_json::to_vec_pretty(&plan)?)?;
    Ok(plan)
}

/// List a project's test plans.
pub fn list_test_plans(base: &Path, project_id: &str) -> StorageResult<Vec<TestPlan>> {
    let dir = testplans_dir(base, project_id)?;
    let mut out = Vec::new();
    match fs::read_dir(&dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(bytes) = fs::read(&path) {
                    if let Ok(p) = serde_json::from_slice::<TestPlan>(&bytes) {
                        out.push(p);
                    }
                }
            }
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(StorageError::Io(e.to_string())),
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Load a full test plan.
pub fn get_test_plan(base: &Path, project_id: &str, plan_id: &str) -> StorageResult<TestPlan> {
    let path = testplan_file(base, project_id, plan_id)?;
    let bytes = fs::read(&path).map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            StorageError::NotFound(format!("test plan {plan_id}"))
        } else {
            StorageError::Io(e.to_string())
        }
    })?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Delete a test plan.
pub fn delete_test_plan(base: &Path, project_id: &str, plan_id: &str) -> StorageResult<()> {
    let path = testplan_file(base, project_id, plan_id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            Err(StorageError::NotFound(format!("test plan {plan_id}")))
        }
        Err(e) => Err(StorageError::Io(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_base() -> PathBuf {
        // Unique per test run using process id + a counter file-free scheme.
        let mut dir = std::env::temp_dir();
        let unique = format!(
            "qa402-storage-test-{}-{:p}",
            std::process::id(),
            &dir as *const _
        );
        dir.push(unique);
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn new_meas(project_id: &str, name: &str, ts: &str) -> NewMeasurement {
        NewMeasurement {
            project_id: project_id.to_string(),
            name: name.to_string(),
            kind: "frequency_response".to_string(),
            timestamp: ts.to_string(),
            comment: String::new(),
            device_config: json!({"input_gain": 6, "output_gain": -2, "sample_rate": 48000}),
            params: json!({"start_freq": 20.0, "end_freq": 20000.0}),
            data: json!({"frequencies": [20.0, 1000.0], "magnitudes_db": [-7.5, -7.5]}),
        }
    }

    #[test]
    fn valid_id_accepts_ids_and_rejects_traversal() {
        assert!(valid_id("a1b2c3d4-5e6f-7081-9a0b-1c2d3e4f5061").is_ok());
        assert!(valid_id("plain_id-42").is_ok());
        for bad in [
            "", "..", "../..", "a/b", "a\\b", "a.json", "/etc/passwd", "..\\..", "foo/../bar", ".",
        ] {
            assert!(valid_id(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn storage_rejects_traversal_ids() {
        let base = tmp_base();
        assert!(matches!(
            get_measurement(&base, "..", "../../evil"),
            Err(StorageError::Invalid(_))
        ));
        assert!(matches!(
            delete_session(&base, "ok", "../../evil"),
            Err(StorageError::Invalid(_))
        ));
        assert!(matches!(
            list_test_plans(&base, "../secrets"),
            Err(StorageError::Invalid(_))
        ));
        // A well-formed but nonexistent id still resolves inside base → NotFound.
        assert!(matches!(
            get_measurement(&base, "realproj", "missing"),
            Err(StorageError::NotFound(_))
        ));
    }

    #[test]
    fn project_and_measurement_roundtrip() {
        let base = tmp_base();

        let p = create_project(&base, "Doug Self preamp", "line stage", "2026-07-05T10:00:00Z")
            .unwrap();
        assert_eq!(list_projects(&base).unwrap().len(), 1);

        let m1 = save_measurement(&base, new_meas(&p.id, "baseline", "2026-07-05T10:05:00Z"))
            .unwrap();
        let _m2 = save_measurement(&base, new_meas(&p.id, "after fix", "2026-07-05T11:00:00Z"))
            .unwrap();

        let list = list_measurements(&base, &p.id).unwrap();
        assert_eq!(list.len(), 2);
        // Newest first.
        assert_eq!(list[0].name, "after fix");

        // Comment update persists.
        let updated =
            update_measurement(&base, &p.id, &m1.id, None, Some("noisy PSU")).unwrap();
        assert_eq!(updated.comment, "noisy PSU");
        let reloaded = get_measurement(&base, &p.id, &m1.id).unwrap();
        assert_eq!(reloaded.comment, "noisy PSU");
        assert_eq!(reloaded.device_config["sample_rate"], 48000);

        // Deleting the project removes its measurements.
        delete_project(&base, &p.id).unwrap();
        assert!(list_projects(&base).unwrap().is_empty());
        assert!(list_measurements(&base, &p.id).unwrap().is_empty());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn session_and_testplan_roundtrip() {
        let base = tmp_base();
        let p = create_project(&base, "Preamp", "", "2026-07-06T10:00:00Z").unwrap();

        // Session snapshot.
        let s = save_session(
            &base,
            NewSession {
                project_id: p.id.clone(),
                name: "baseline".into(),
                timestamp: "2026-07-06T10:05:00Z".into(),
                comment: String::new(),
                settings: json!({"sample_rate": 48000}),
                curves: json!([{"label": "FR L", "kind": "frequency_response"}, {"label": "THD"}]),
            },
        )
        .unwrap();
        let list = list_sessions(&base, &p.id).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].curve_count, 2);
        let loaded = get_session(&base, &p.id, &s.id).unwrap();
        assert_eq!(loaded.settings["sample_rate"], 48000);
        update_session(&base, &p.id, &s.id, None, Some("noted")).unwrap();
        assert_eq!(get_session(&base, &p.id, &s.id).unwrap().comment, "noted");

        // Test plan recipe.
        let tp = save_test_plan(
            &base,
            NewTestPlan {
                project_id: p.id.clone(),
                name: "Full QA".into(),
                description: String::new(),
                steps: json!([{"kind": "frequency_response", "params": {}}, {"kind": "thd_sweep"}]),
            },
        )
        .unwrap();
        assert_eq!(list_test_plans(&base, &p.id).unwrap().len(), 1);
        update_test_plan(&base, &p.id, &tp.id, Some("Full QA v2"), None, None).unwrap();
        assert_eq!(get_test_plan(&base, &p.id, &tp.id).unwrap().name, "Full QA v2");

        // Deleting the project removes sessions and plans too.
        delete_project(&base, &p.id).unwrap();
        assert!(list_sessions(&base, &p.id).unwrap().is_empty());
        assert!(list_test_plans(&base, &p.id).unwrap().is_empty());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn saving_to_missing_project_fails() {
        let base = tmp_base();
        let err = save_measurement(&base, new_meas("nope", "x", "2026-07-05T10:00:00Z"));
        assert!(matches!(err, Err(StorageError::NotFound(_))));
        let _ = fs::remove_dir_all(&base);
    }
}
