//! Data export endpoints (issue #30): plain file writes + clipboard image.
//!
//! The frontend builds the CSV/PNG bytes itself (provenance headers, canvas
//! composition) and asks the user for a destination through the dialog
//! plugin; these commands only put bytes where the webview can't — on disk
//! and on the system clipboard. No network side effects, ever.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;

/// Write `contents_base64` (decoded) to `path` — the path comes from the
/// user's own save-dialog pick, so no directory scoping applies.
#[tauri::command]
pub async fn export_write_file(path: String, contents_base64: String) -> Result<(), String> {
    let bytes = B64
        .decode(contents_base64.as_bytes())
        .map_err(|e| format!("invalid base64 payload: {e}"))?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("writing {path}: {e}"))
}

/// Put a raw RGBA image (straight from `canvas.getImageData`) on the system
/// clipboard. RGBA-in rather than PNG-in keeps the Rust side free of an
/// image decoder; arboard re-encodes per platform convention.
#[tauri::command]
pub async fn export_copy_image(
    width: u32,
    height: u32,
    rgba_base64: String,
) -> Result<(), String> {
    let bytes = B64
        .decode(rgba_base64.as_bytes())
        .map_err(|e| format!("invalid base64 payload: {e}"))?;
    let expected = (width as usize) * (height as usize) * 4;
    if bytes.len() != expected {
        return Err(format!(
            "image size mismatch: {}x{} wants {expected} bytes, got {}",
            width,
            height,
            bytes.len()
        ));
    }
    // arboard talks to the OS pasteboard synchronously — keep it off the
    // async runtime's worker threads.
    tokio::task::spawn_blocking(move || {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
        clipboard
            .set_image(arboard::ImageData {
                width: width as usize,
                height: height as usize,
                bytes: bytes.into(),
            })
            .map_err(|e| format!("clipboard: {e}"))
    })
    .await
    .map_err(|e| format!("clipboard task: {e}"))?
}
