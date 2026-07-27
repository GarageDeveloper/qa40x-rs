//! Data export endpoints (issue #30): plain file writes + clipboard image.
//!
//! The frontend builds the CSV/PNG bytes itself (provenance headers, canvas
//! composition) and asks the user for a destination through the dialog
//! plugin; these commands only put bytes where the webview can't — on disk
//! and on the system clipboard. No network side effects, ever (the REST
//! server dispatches its own fixed path table and can't reach commands).

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;

/// The only two things this app exports. Rejecting anything else keeps a
/// hypothetical future frontend-content injection from escalating into an
/// arbitrary file write (review hardening note) at zero UX cost: the save
/// dialog's filters always produce one of these.
fn allowed_extension(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".csv") || lower.ends_with(".png")
}

/// Write `contents_base64` (decoded) to `path` — the path comes from the
/// user's own save-dialog pick, so no directory scoping applies.
#[tauri::command]
pub async fn export_write_file(path: String, contents_base64: String) -> Result<(), String> {
    if !allowed_extension(&path) {
        return Err(format!("refusing non-export extension: {path}"));
    }
    let bytes = B64
        .decode(contents_base64.as_bytes())
        .map_err(|e| format!("invalid base64 payload: {e}"))?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("writing {path}: {e}"))
}

/// Put the composed tile PNG on the system clipboard. PNG-in (the same
/// bytes the file lane writes) keeps the IPC payload compressed — a raw
/// RGBA lane shipped ~34 MB per Retina copy; the decode below rides the
/// `image` crate arboard already pulls in for its own `image-data` feature.
#[tauri::command]
pub async fn export_copy_image(png_base64: String) -> Result<(), String> {
    let bytes = B64
        .decode(png_base64.as_bytes())
        .map_err(|e| format!("invalid base64 payload: {e}"))?;
    let rgba = decode_png_rgba(&bytes)?;
    // arboard talks to the OS pasteboard synchronously — keep it off the
    // async runtime's worker threads. (On X11 arboard keeps a process-wide
    // serving thread, so the image outlives this local handle.)
    tokio::task::spawn_blocking(move || {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
        clipboard
            .set_image(arboard::ImageData {
                width: rgba.0 as usize,
                height: rgba.1 as usize,
                bytes: rgba.2.into(),
            })
            .map_err(|e| format!("clipboard: {e}"))
    })
    .await
    .map_err(|e| format!("clipboard task: {e}"))?
}

/// PNG bytes → (width, height, tightly-packed RGBA8). Split out of the
/// command so the decode path is unit-testable without a clipboard.
fn decode_png_rgba(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|e| format!("decoding png: {e}"))?;
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    Ok((w, h, rgba.into_raw()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A valid 1×1 red PNG, base64 (generated once with the `image` crate).
    fn tiny_png_bytes() -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        let img = image::RgbaImage::from_pixel(1, 1, image::Rgba([255, 0, 0, 255]));
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut buf, image::ImageFormat::Png)
            .expect("encode tiny png");
        buf.into_inner()
    }

    #[tokio::test]
    async fn write_file_round_trips_and_rejects_foreign_extensions() {
        let dir = std::env::temp_dir().join("qa40x-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.csv");
        let payload = B64.encode(b"# qa40x-rs data export\nfrequency_hz,x\n");
        export_write_file(path.to_string_lossy().into_owned(), payload.clone())
            .await
            .expect("csv write");
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .starts_with("# qa40x-rs data export"));

        // Anything but .csv/.png is refused BEFORE touching the filesystem.
        let err = export_write_file(dir.join("out.sh").to_string_lossy().into_owned(), payload)
            .await
            .unwrap_err();
        assert!(err.contains("refusing"), "{err}");
        assert!(!dir.join("out.sh").exists());
    }

    #[tokio::test]
    async fn write_file_rejects_bad_base64() {
        let dir = std::env::temp_dir().join("qa40x-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bad.csv");
        let err = export_write_file(path.to_string_lossy().into_owned(), "!!!".into())
            .await
            .unwrap_err();
        assert!(err.contains("invalid base64"), "{err}");
        assert!(!path.exists());
    }

    #[test]
    fn png_decode_yields_tightly_packed_rgba() {
        let (w, h, rgba) = decode_png_rgba(&tiny_png_bytes()).expect("decode");
        assert_eq!((w, h), (1, 1));
        assert_eq!(rgba, vec![255, 0, 0, 255]);
    }

    #[test]
    fn png_decode_refuses_garbage() {
        let err = decode_png_rgba(b"not a png").unwrap_err();
        assert!(err.contains("decoding png"), "{err}");
    }
}
