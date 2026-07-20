//! Firmware extraction & verification (Phase 1 of the firmware pipeline).
//!
//! QuantAsylum ships `setup_QA40x_<appver>.exe` — Inno Setup 6 installers whose
//! payload `app/QA40x.exe` embeds one or two NXP "Secure Binary" v2.1 firmware
//! images back to back, one per device. Observed layout: the QA402 image comes
//! first (invariably 52724 B across releases) and, in two-image builds, the
//! QA403 image second (size varies by version).
//!
//! This module carves those SB2.1 images out of a `QA40x.exe` (or, via
//! innoextract, out of a full setup installer), hashes each with SHA-256, and
//! looks the hash up in an embedded checksum registry. A match proves the
//! extracted image is byte-identical to a specific official release build
//! (integrity/provenance). Because every app build re-encrypts the firmware
//! with a fresh nonce, an *unknown* hash is not necessarily bad — it just is
//! not one of the builds we have gathered.
//!
//! Flashing is intentionally NOT implemented here. The carved image bytes are
//! stashed in `AppState` keyed by SHA-256 so a later flash phase can use them.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

use crate::AppState;

/// In-memory store of the raw carved image bytes, keyed by SHA-256 hex. Held in
/// `AppState`; a later flash phase reads from here so we never re-carve.
pub type FirmwareStore = Arc<std::sync::Mutex<HashMap<String, Vec<u8>>>>;

/* ------------------------------------------------------------------ */
/* Embedded checksum registry                                          */
/* ------------------------------------------------------------------ */

const REGISTRY_JSON: &str = include_str!("../../firmware-registry.json");

#[derive(Debug, Deserialize)]
pub struct Registry {
    #[allow(dead_code)]
    pub schema: String,
    #[allow(dead_code)]
    pub generated: String,
    #[allow(dead_code)]
    pub source: String,
    #[allow(dead_code)]
    pub notes: Vec<String>,
    pub releases: Vec<RegistryRelease>,
}

#[derive(Debug, Deserialize)]
pub struct RegistryRelease {
    pub app_version: String,
    /// Firmware version for this release, if known (older releases may be null).
    pub firmware_version: Option<String>,
    pub images: Vec<RegistryImage>,
}

#[derive(Debug, Deserialize)]
pub struct RegistryImage {
    /// Device the image is for (QA402/QA403), if inferable from size; else null.
    pub device: Option<String>,
    #[allow(dead_code)]
    pub size: u64,
    pub sha256: String,
}

/// Parse (once) and return the embedded registry.
fn registry() -> &'static Registry {
    static REG: OnceLock<Registry> = OnceLock::new();
    REG.get_or_init(|| {
        serde_json::from_str(REGISTRY_JSON).expect("embedded firmware-registry.json is valid JSON")
    })
}

/// A registry hit: the official release an extracted image belongs to.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct RegistryMatch {
    pub app_version: String,
    pub firmware_version: Option<String>,
    pub device: Option<String>,
}

/// Look a SHA-256 (hex) up across every image of every registry release.
pub(crate) fn lookup_sha256(sha: &str) -> Option<RegistryMatch> {
    for rel in &registry().releases {
        for img in &rel.images {
            if img.sha256.eq_ignore_ascii_case(sha) {
                return Some(RegistryMatch {
                    app_version: rel.app_version.clone(),
                    firmware_version: rel.firmware_version.clone(),
                    device: img.device.clone(),
                });
            }
        }
    }
    None
}

/// firmware_version recorded in the registry for an app version (tag), if any.
/// Tags may be prefixed with `v`; the registry stores the bare number string.
fn firmware_for_app_version(tag: &str) -> Option<String> {
    let norm = tag.trim_start_matches(['v', 'V']);
    registry()
        .releases
        .iter()
        .find(|r| r.app_version == norm)
        .and_then(|r| r.firmware_version.clone())
}

/* ------------------------------------------------------------------ */
/* SB2.1 carver                                                         */
/*                                                                      */
/* SB2.1 ("Secure Binary" v2.1) is a PUBLIC NXP container format; the    */
/* header, certificate block and RSA-signature offsets below follow      */
/* NXP's open tooling/spec (elftosb / spsdk), not anything specific to    */
/* QA40x.exe — which is only scanned for the SB2.1 magic and carved.      */
/* ------------------------------------------------------------------ */

/// Which device an image is for, inferred from its size and position among the
/// carved images. The QA402 firmware is invariably 52724 B across every
/// release, so a 52724-byte image is the QA402; in a two-image build the other
/// (second) image is the QA403, whose size varies by version. Older
/// single-image builds keep the 52724→QA402 rule, else Unknown.
fn device_for_index(index: usize, total: usize, size: usize) -> String {
    if size == 52724 {
        "QA402".to_string()
    } else if total == 2 && index == 1 {
        "QA403".to_string()
    } else {
        "Unknown".to_string()
    }
}

/// A carved Secure-Binary v2.1 image located inside a host binary.
#[derive(Debug, Clone)]
pub struct SbImage {
    pub offset: usize,
    pub size: usize,
    pub sha256: String,
    pub device_guess: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut s = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

/// Scan `bytes` for SB2.1 firmware images and carve each one out.
///
/// Framing (little-endian): a 16-byte nonce, 4 zero bytes at image+0x10, the
/// magic `STMP` at image+0x14, a version byte (major, must be 2) at image+0x18,
/// and a u32 block count at image+0x1C. Image size = block_count*16 + 4.
///
/// We scan for `STMP`, back up 0x14 to the image start, validate the zero
/// padding and version, read the block count, and slice `[start .. start+size]`.
pub fn carve_sb2_images(bytes: &[u8]) -> Vec<SbImage> {
    const MAGIC: &[u8; 4] = b"STMP";
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 4 <= bytes.len() {
        if &bytes[i..i + 4] == MAGIC && i >= 0x14 {
            let start = i - 0x14;
            if start + 0x20 <= bytes.len()
                && bytes[start + 0x10..start + 0x14] == [0, 0, 0, 0]
                && bytes[start + 0x18] == 2
            {
                let blocks = u32::from_le_bytes([
                    bytes[start + 0x1C],
                    bytes[start + 0x1D],
                    bytes[start + 0x1E],
                    bytes[start + 0x1F],
                ]) as usize;
                let size = blocks * 16 + 4;
                // A valid image is at least its header and fits in the buffer.
                if size > 0x20 && start + size <= bytes.len() {
                    let slice = &bytes[start..start + size];
                    out.push(SbImage {
                        offset: start,
                        size,
                        sha256: sha256_hex(slice),
                        device_guess: String::new(), // set by position below
                    });
                    // Skip past this image so its body can't yield spurious hits.
                    i = start + size;
                    continue;
                }
            }
        }
        i += 1;
    }
    // Assign the device by position now that the total is known.
    let total = out.len();
    for (idx, img) in out.iter_mut().enumerate() {
        img.device_guess = device_for_index(idx, total, img.size);
    }
    out
}

/* ------------------------------------------------------------------ */
/* SB2.1 signature verification (RSA-2048 / SHA-256, pure Rust)         */
/* ------------------------------------------------------------------ */

/// Cryptographic authenticity of an SB2.1 image, independent of the registry.
///
/// An SB2.1 (.sb) container embeds its whole signing chain and is RSA-signed
/// over everything preceding the signature. Verifying that signature with the
/// embedded leaf certificate's public key proves the image is genuine
/// QuantAsylum firmware — no device secret (SBKEK) is needed, and it works even
/// for builds that are not in our hash registry.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct SignatureStatus {
    /// True iff the RSA-2048/SHA-256 signature verified against the leaf cert.
    pub valid: bool,
    /// Subject of the leaf signing certificate (CN if present, else RFC4514).
    pub signer: Option<String>,
    /// Human-readable detail — the failure reason when invalid, or the signing
    /// algorithm when valid.
    pub detail: Option<String>,
}

impl SignatureStatus {
    fn invalid(detail: impl Into<String>) -> Self {
        SignatureStatus {
            valid: false,
            signer: None,
            detail: Some(detail.into()),
        }
    }
}

/// Read a little-endian u32 at `off`, or `None` if it would run past the end.
fn u32_le(bytes: &[u8], off: usize) -> Option<u32> {
    let end = off.checked_add(4)?;
    let slice = bytes.get(off..end)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// Byte range (offset, len) of every certificate in the SB2.1 cert table, plus
/// the offset where the RSA signature begins and the leaf-cert index.
struct CertLayout {
    /// (offset, len) of each DER certificate in image order.
    certs: Vec<(usize, usize)>,
    /// Offset of the 256-byte RSA-2048 signature.
    sig_off: usize,
}

/// Locate the certificate table + signature offset in an SB2.1 image. Returns
/// `Err(detail)` on any malformed/short structure rather than panicking.
fn locate_cert_layout(img: &[u8]) -> Result<CertLayout, String> {
    // 1. Find the "cert" block header.
    let o = img
        .windows(4)
        .position(|w| w == b"cert")
        .ok_or("no 'cert' block found in image")?;

    // 2. Header length and certificate count.
    let hdr_len = u32_le(img, o + 8).ok_or("truncated cert header (hdr_len)")? as usize;
    let cert_count = u32_le(img, o + 24).ok_or("truncated cert header (cert_count)")? as usize;
    if cert_count == 0 {
        return Err("certificate table is empty".into());
    }
    // Sanity bound: refuse absurd counts (guards against garbage offsets).
    if cert_count > 64 {
        return Err(format!("implausible certificate count ({cert_count})"));
    }

    // 3. Walk the certificate table.
    let mut p = o.checked_add(hdr_len).ok_or("cert header offset overflow")?;
    let mut certs = Vec::with_capacity(cert_count);
    for i in 0..cert_count {
        let clen = u32_le(img, p).ok_or_else(|| format!("truncated length for cert #{i}"))? as usize;
        let der_start = p + 4;
        let der_end = der_start
            .checked_add(clen)
            .ok_or_else(|| format!("cert #{i} length overflow"))?;
        if der_end > img.len() {
            return Err(format!("cert #{i} runs past end of image"));
        }
        certs.push((der_start, clen));
        p = der_end;
    }

    // 4. Skip the 4×32-byte Root Key Hash table; the signature follows.
    let rkh_off = p;
    let sig_off = rkh_off
        .checked_add(4 * 32)
        .ok_or("RKH table offset overflow")?;
    if sig_off + 256 > img.len() {
        return Err("signature runs past end of image".into());
    }

    Ok(CertLayout { certs, sig_off })
}

/// Extract the subject of a DER X.509 cert as a display string: its CN if the
/// subject has one, otherwise the full RFC4514 form.
fn cert_subject_display(cert: &x509_cert::Certificate) -> String {
    let rfc4514 = cert.tbs_certificate.subject.to_string();
    // Pull out a "CN=..." component when present (handles it appearing anywhere
    // in the comma-separated RDN sequence).
    for part in rfc4514.split(',') {
        let part = part.trim();
        if let Some(cn) = part.strip_prefix("CN=") {
            if !cn.is_empty() {
                return cn.to_string();
            }
        }
    }
    rfc4514
}

/// Verify the RSA-2048 / SHA-256 signature embedded in an SB2.1 image.
///
/// The leaf (last) certificate signs `img[0..sig_off]`; its RSA public key
/// verifies the 256-byte signature at `sig_off`. Fully defensive: any parsing
/// or offset problem yields `valid: false` with a detail string.
pub fn verify_sb2_signature(img: &[u8]) -> SignatureStatus {
    use rsa::pkcs8::DecodePublicKey;
    use rsa::{Pkcs1v15Sign, RsaPublicKey};
    use x509_cert::der::{Decode, Encode, SliceReader};
    use x509_cert::Certificate;

    let layout = match locate_cert_layout(img) {
        Ok(l) => l,
        Err(detail) => return SignatureStatus::invalid(detail),
    };

    // Leaf = last certificate. Its stored length includes trailing padding, so
    // decode a single Certificate and ignore any trailing bytes.
    let &(leaf_off, leaf_len) = layout.certs.last().expect("cert_count >= 1 checked");
    let leaf_bytes = match img.get(leaf_off..leaf_off + leaf_len) {
        Some(b) => b,
        None => return SignatureStatus::invalid("leaf certificate slice out of range"),
    };
    let mut reader = match SliceReader::new(leaf_bytes) {
        Ok(r) => r,
        Err(e) => return SignatureStatus::invalid(format!("cannot read leaf cert: {e}")),
    };
    let cert = match Certificate::decode(&mut reader) {
        Ok(c) => c,
        Err(e) => return SignatureStatus::invalid(format!("leaf cert is not valid DER: {e}")),
    };

    let signer = cert_subject_display(&cert);

    // Rebuild the SubjectPublicKeyInfo DER and load it as an RSA public key.
    let spki_der = match cert.tbs_certificate.subject_public_key_info.to_der() {
        Ok(d) => d,
        Err(e) => return SignatureStatus::invalid(format!("cannot encode public key: {e}")),
    };
    let public_key = match RsaPublicKey::from_public_key_der(&spki_der) {
        Ok(k) => k,
        Err(e) => {
            return SignatureStatus {
                valid: false,
                signer: Some(signer),
                detail: Some(format!("leaf key is not RSA/parsable: {e}")),
            }
        }
    };

    let signature = &img[layout.sig_off..layout.sig_off + 256];
    let signed = &img[0..layout.sig_off];

    // SHA-256 the signed region, then RSA PKCS#1 v1.5 verify.
    let digest = Sha256::digest(signed);
    match public_key.verify(Pkcs1v15Sign::new::<Sha256>(), &digest, signature) {
        Ok(()) => SignatureStatus {
            valid: true,
            signer: Some(signer),
            detail: Some("RSA-2048 / SHA-256 (PKCS#1 v1.5)".to_string()),
        },
        Err(e) => SignatureStatus {
            valid: false,
            signer: Some(signer),
            detail: Some(format!("signature does not verify: {e}")),
        },
    }
}

/* ------------------------------------------------------------------ */
/* Frontend-facing result types                                        */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ExtractedImage {
    pub index: usize,
    pub size: usize,
    pub device: String,
    pub sha256: String,
    pub known: bool,
    #[serde(rename = "match")]
    pub match_: Option<RegistryMatch>,
    /// Cryptographic authenticity of the image, independent of the registry.
    pub signature: SignatureStatus,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ExtractionResult {
    /// "exe" when carved from a QA40x.exe directly, "setup" from an installer.
    pub source_kind: String,
    pub app_exe_name: String,
    pub images: Vec<ExtractedImage>,
}

/// Carve `bytes`, look up each image, stash the raw bytes in `store`.
fn extract_from_bytes(
    bytes: &[u8],
    source_kind: &str,
    app_exe_name: &str,
    store: &FirmwareStore,
) -> ExtractionResult {
    let carved = carve_sb2_images(bytes);
    let mut images = Vec::with_capacity(carved.len());
    if let Ok(mut guard) = store.lock() {
        for (index, img) in carved.iter().enumerate() {
            let raw = &bytes[img.offset..img.offset + img.size];
            let signature = verify_sb2_signature(raw);
            guard.insert(img.sha256.clone(), raw.to_vec());
            let m = lookup_sha256(&img.sha256);
            images.push(ExtractedImage {
                index,
                size: img.size,
                device: img.device_guess.clone(),
                sha256: img.sha256.clone(),
                known: m.is_some(),
                match_: m,
                signature,
            });
        }
    }
    ExtractionResult {
        source_kind: source_kind.to_string(),
        app_exe_name: app_exe_name.to_string(),
        images,
    }
}

/// Grab the shared firmware store out of `AppState` (a brief tokio lock).
async fn firmware_store(state: &tauri::State<'_, Arc<Mutex<AppState>>>) -> FirmwareStore {
    state.lock().await.firmware_images.clone()
}

/* ------------------------------------------------------------------ */
/* Commands: local extraction                                          */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub async fn extract_firmware_from_exe(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    path: String,
) -> Result<ExtractionResult, String> {
    let store = firmware_store(&state).await;
    let p = PathBuf::from(&path);
    let bytes = std::fs::read(&p).map_err(|e| format!("Cannot read {}: {}", path, e))?;
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("QA40x.exe")
        .to_string();
    let result = extract_from_bytes(&bytes, "exe", &name, &store);
    if result.images.is_empty() {
        return Err(format!(
            "No SB2.1 firmware images found in {}. Is this a QA40x.exe?",
            name
        ));
    }
    Ok(result)
}

/// Recursively find a file whose lowercased name equals `target_lower`.
fn find_file_ci(dir: &Path, target_lower: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(found) = find_file_ci(&p, target_lower) {
                return Some(found);
            }
        } else if p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.to_lowercase() == target_lower)
            .unwrap_or(false)
        {
            return Some(p);
        }
    }
    None
}

/// Blocking half of setup extraction. Recovers `app/QA40x.exe` from an Inno
/// Setup 6 installer using the **pure-Rust** extractor ([`crate::inno`]); only
/// if that fails does it fall back to the external `innoextract` tool (kept as a
/// documented safety net for installer layouts the pure-Rust path doesn't yet
/// handle). Returns (exe bytes, exe file name).
fn extract_app_exe_from_setup(setup_path: &str) -> Result<(Vec<u8>, String), String> {
    let setup_bytes =
        std::fs::read(setup_path).map_err(|e| format!("Cannot read {}: {}", setup_path, e))?;

    match crate::inno::extract_qa40x_exe(&setup_bytes) {
        Ok(bytes) => {
            log::info!(
                "Extracted QA40x.exe from installer via pure-Rust Inno reader ({} bytes)",
                bytes.len()
            );
            Ok((bytes, "QA40x.exe".to_string()))
        }
        Err(inno_err) => {
            // FALLBACK: the pure-Rust reader is scoped to QuantAsylum's Inno 6
            // single-file installers. If a future installer layout defeats it,
            // fall back to the external tool rather than failing outright.
            log::warn!(
                "Pure-Rust Inno extraction failed ({inno_err}); falling back to innoextract"
            );
            run_innoextract_and_read(setup_path)
        }
    }
}

/// Blocking fallback: run innoextract, locate QA40x.exe, read it, clean up.
/// Returns (exe bytes, exe file name). Only invoked when the pure-Rust reader in
/// [`extract_app_exe_from_setup`] cannot handle the installer.
fn run_innoextract_and_read(setup_path: &str) -> Result<(Vec<u8>, String), String> {
    use std::process::Command;

    let out_dir = std::env::temp_dir().join(format!("qa40x-fw-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Cannot create temp dir: {}", e))?;

    // TODO(Phase 2): this shells out to `innoextract` as a TEMPORARY external
    // decompressor. Replace with a pure-Rust Inno Setup 6 / LZMA reader.
    let output = Command::new("innoextract")
        .arg("-s")
        .arg("-d")
        .arg(&out_dir)
        .arg(setup_path)
        .output();

    let output = match output {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let _ = std::fs::remove_dir_all(&out_dir);
            return Err(
                "innoextract is not installed. Install it (e.g. `brew install innoextract`) \
                 to extract firmware from a setup installer, or point at an already-extracted \
                 QA40x.exe instead. (Interim: a pure-Rust reader is planned.)"
                    .to_string(),
            );
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&out_dir);
            return Err(format!("Failed to run innoextract: {}", e));
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_dir_all(&out_dir);
        return Err(format!(
            "innoextract failed: {}",
            stderr.trim().lines().last().unwrap_or("unknown error")
        ));
    }

    let exe = match find_file_ci(&out_dir, "qa40x.exe") {
        Some(e) => e,
        None => {
            let _ = std::fs::remove_dir_all(&out_dir);
            return Err(
                "Extracted the installer but found no QA40x.exe inside. Is this a QA40x setup?"
                    .to_string(),
            );
        }
    };
    let name = exe
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("QA40x.exe")
        .to_string();
    let bytes = std::fs::read(&exe).map_err(|e| format!("Cannot read extracted exe: {}", e));

    let _ = std::fs::remove_dir_all(&out_dir);
    Ok((bytes?, name))
}

#[tauri::command]
pub async fn extract_firmware_from_setup(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    path: String,
) -> Result<ExtractionResult, String> {
    let store = firmware_store(&state).await;
    let path_owned = path.clone();
    // Extraction + file IO is blocking; keep it off the async worker.
    let (bytes, name) = tokio::task::spawn_blocking(move || extract_app_exe_from_setup(&path_owned))
        .await
        .map_err(|e| format!("Extraction task failed: {}", e))??;

    let result = extract_from_bytes(&bytes, "setup", &name, &store);
    if result.images.is_empty() {
        return Err(format!(
            "Extracted {} but found no SB2.1 firmware images inside it.",
            name
        ));
    }
    Ok(result)
}

/* ------------------------------------------------------------------ */
/* Commands: GitHub releases                                           */
/* ------------------------------------------------------------------ */

const GH_USER_AGENT: &str = "qa40x-analyzer (firmware extractor)";

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ReleaseInfo {
    pub app_version: String,
    pub published_at: Option<String>,
    pub notes: String,
    pub mentions_firmware: bool,
    pub setup_asset_url: Option<String>,
    /// firmware version from our registry for this app version, if gathered.
    pub firmware_version: Option<String>,
}

#[tauri::command]
pub async fn list_qa40x_releases() -> Result<Vec<ReleaseInfo>, String> {
    let client = reqwest::Client::builder()
        .user_agent(GH_USER_AGENT)
        .build()
        .map_err(|e| format!("HTTP client init failed: {}", e))?;

    let resp = client
        // per_page=100 fetches all releases in one page (the repo has < 100), so
        // every firmware version shows in the picker, not just the recent 30.
        .get("https://api.github.com/repos/QuantAsylum/QA40x/releases?per_page=100")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GitHub request failed: {}", e))?;

    if !resp.status().is_success() {
        let code = resp.status();
        return Err(format!(
            "GitHub returned {} (this endpoint is rate-limited to ~60 requests/hour for \
             unauthenticated clients — try again later).",
            code
        ));
    }

    let releases: Vec<GhRelease> = resp
        .json()
        .await
        .map_err(|e| format!("Cannot parse GitHub response: {}", e))?;

    let infos = releases
        .into_iter()
        .map(|r| {
            let notes = r.body.unwrap_or_default();
            let mentions_firmware = notes.to_lowercase().contains("firmware");
            let setup_asset_url = r
                .assets
                .iter()
                .find(|a| {
                    let n = a.name.to_lowercase();
                    n.contains("setup") && n.ends_with(".exe")
                })
                .map(|a| a.browser_download_url.clone());
            let firmware_version = firmware_for_app_version(&r.tag_name);
            ReleaseInfo {
                app_version: r.tag_name,
                published_at: r.published_at,
                notes,
                mentions_firmware,
                setup_asset_url,
                firmware_version,
            }
        })
        .collect();

    Ok(infos)
}

#[tauri::command]
pub async fn download_qa40x_setup(url: String) -> Result<String, String> {
    // Only download from GitHub's own hosts (release pages redirect to
    // objects.githubusercontent.com); refuse arbitrary hosts.
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    let host = parsed.host_str().unwrap_or("");
    let host_ok = host == "github.com"
        || host == "objects.githubusercontent.com"
        || host.ends_with(".githubusercontent.com");
    if !host_ok {
        return Err(format!(
            "Refusing to download from '{}'. Only github.com / githubusercontent.com are allowed.",
            host
        ));
    }

    let client = reqwest::Client::builder()
        .user_agent(GH_USER_AGENT)
        .build()
        .map_err(|e| format!("HTTP client init failed: {}", e))?;

    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Download failed while reading body: {}", e))?;

    let file_name = url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty() && s.to_lowercase().ends_with(".exe"))
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("qa40x-setup-{}.exe", uuid::Uuid::new_v4()));
    let dest = std::env::temp_dir().join(format!("qa40x-dl-{}-{}", uuid::Uuid::new_v4(), file_name));

    std::fs::write(&dest, &bytes).map_err(|e| format!("Cannot write download: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal well-formed SB2.1 image of `blocks` 16-byte blocks so the
    /// carver framing can be exercised without a real firmware fixture.
    fn synth_image(blocks: u32, fill: u8) -> Vec<u8> {
        let size = blocks as usize * 16 + 4;
        let mut img = vec![fill; size];
        // nonce (0x00..0x10) left as fill; 4 zero bytes at 0x10
        for b in img.iter_mut().take(0x14).skip(0x10) {
            *b = 0;
        }
        img[0x14..0x18].copy_from_slice(b"STMP");
        img[0x18] = 2; // major version
        img[0x1C..0x20].copy_from_slice(&blocks.to_le_bytes());
        img
    }

    #[test]
    fn carves_two_back_to_back_images() {
        // QA402 = 52724 B → (52724-4)/16 = 3295 blocks; QA403 = 52660 B → 3291.
        let img1 = synth_image(3295, 0xAB);
        let img2 = synth_image(3291, 0xCD);
        assert_eq!(img1.len(), 52724);
        assert_eq!(img2.len(), 52660);

        let mut host = vec![0u8; 1000];
        host.extend_from_slice(&img1);
        host.extend_from_slice(&img2);
        host.extend_from_slice(&[0u8; 500]);

        let carved = carve_sb2_images(&host);
        assert_eq!(carved.len(), 2, "should find exactly two images");
        assert_eq!(carved[0].size, 52724);
        assert_eq!(carved[0].device_guess, "QA402");
        assert_eq!(carved[1].size, 52660);
        assert_eq!(carved[1].device_guess, "QA403");
        assert_eq!(carved[0].offset, 1000);
        assert_eq!(carved[1].offset, 1000 + 52724);
    }

    #[test]
    fn rejects_wrong_version_byte() {
        let mut img = synth_image(3295, 0x00);
        img[0x18] = 1; // not v2
        let carved = carve_sb2_images(&img);
        assert!(carved.is_empty(), "v1 header must be rejected");
    }

    #[test]
    fn embedded_registry_parses() {
        let reg = registry();
        assert!(!reg.releases.is_empty());
        // The registry is keyed by app version; 1.200 is the oldest gathered.
        assert!(reg.releases.iter().any(|r| r.app_version == "1.200"));
    }

    #[test]
    fn known_registry_hash_matches() {
        // 1.223 QA402 image hash from the registry must resolve.
        let m = lookup_sha256("b109ccd83763b224ed973df3a6ac82b65c4b57e7e236dd0d60c490b6bc501ef8")
            .expect("registry hash should match");
        assert_eq!(m.app_version, "1.223");
        assert_eq!(m.device.as_deref(), Some("QA402"));
        assert_eq!(m.firmware_version.as_deref(), Some("60"));
    }

    #[test]
    fn firmware_version_lookup_strips_v_prefix() {
        assert_eq!(firmware_for_app_version("v1.223").as_deref(), Some("60"));
        assert_eq!(firmware_for_app_version("1.200").as_deref(), Some("60"));
        assert_eq!(firmware_for_app_version("9.999"), None);
    }

    /* -------------------- signature verification --------------------- */

    /// Repo-local real SB images (git-ignored, present on disk). Guarded so CI
    /// without the fixtures still passes.
    fn fixture_paths() -> Vec<PathBuf> {
        // Tests run with CWD = src-tauri; fixtures live one level up.
        ["../firmwares/qa40x-firmware-v58.sb", "../firmwares/qa40x-firmware-v60.sb"]
            .iter()
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .collect()
    }

    #[test]
    fn real_sb_image_signature_verifies() {
        let fixtures = fixture_paths();
        if fixtures.is_empty() {
            eprintln!("skipping: no firmwares/*.sb fixtures on disk");
            return;
        }
        for path in fixtures {
            let img = std::fs::read(&path).expect("fixture readable");
            let status = verify_sb2_signature(&img);
            assert!(
                status.valid,
                "{} should have a VALID signature (detail: {:?})",
                path.display(),
                status.detail
            );
            let signer = status.signer.expect("valid signature exposes a signer");
            assert!(
                signer.contains("IMG1_1_sha256_2048"),
                "unexpected signer for {}: {}",
                path.display(),
                signer
            );
        }
    }

    #[test]
    fn tampered_signed_region_fails_verification() {
        let fixtures = fixture_paths();
        let Some(path) = fixtures.first() else {
            eprintln!("skipping: no firmwares/*.sb fixtures on disk");
            return;
        };
        let mut img = std::fs::read(path).expect("fixture readable");
        // Sanity: pristine image verifies.
        assert!(verify_sb2_signature(&img).valid);
        // Flip a byte well inside the signed region (past the nonce/header) and
        // confirm the signature no longer verifies.
        img[0x100] ^= 0xFF;
        let status = verify_sb2_signature(&img);
        assert!(
            !status.valid,
            "flipping a signed byte must invalidate the signature"
        );
        // The leaf cert is still parseable, so the signer is still reported.
        assert!(status.signer.is_some());
        assert!(status.detail.is_some());
    }

    #[test]
    fn garbage_image_is_invalid_not_panic() {
        // No "cert" block → defensive invalid, never a panic.
        let junk = vec![0u8; 64];
        let status = verify_sb2_signature(&junk);
        assert!(!status.valid);
        assert!(status.detail.is_some());
    }
}
