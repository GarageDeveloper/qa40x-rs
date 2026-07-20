# Third-party licenses

`qa40x-rs Audio Analyzer` is built on open-source components. A full, up-to-date
license audit of the Rust dependency tree can be produced at any time with:

```bash
cargo install cargo-license   # once
cd src-tauri && cargo license  # summary by license
# or, to regenerate the committed attribution file (repo root):
cargo install cargo-about --features cli
cd src-tauri && cargo about generate about.hbs > ../THIRD_PARTY_LICENSES.html
# licence policy gate (allow-list in deny.toml):
cd src-tauri && cargo deny check licenses
```

## Summary of the dependency licenses (audited 2026-07)

The dependency tree is **entirely permissive** and compatible with releasing this
project under MIT OR Apache-2.0:

- The vast majority is **Apache-2.0 OR MIT** or **MIT**.
- Other permissive licenses present: **BSD-2/3-Clause, ISC, Zlib, 0BSD, BSL-1.0,
  Unicode-3.0, CDLA-Permissive-2.0**.
- **No GPL / AGPL / SSPL** is present anywhere in the tree.
- The only weak-copyleft is **MPL-2.0** (a handful of transitive crates such as
  `cssparser`, `selectors`, `option-ext`, pulled in via the WebView/HTML stack).
  MPL-2.0 is **file-level** copyleft: it only obliges you to share *those specific
  files* if you modify them. We do not modify them, so there is **no obligation on
  our own source** — we simply keep their notices in the distributed binary.

## Notable components worth calling out

- **hidapi** (MIT) — USB-HID access used by the firmware flasher. The bundled C
  `hidapi` library is tri-licensed (GPLv3 OR BSD-3 OR the original HIDAPI license);
  the permissive path is used, and its notice is retained.
- **ring** / **rustls** / **webpki-roots** (Apache-2.0 / ISC / CDLA-Permissive) —
  TLS for downloading official installers over HTTPS.
- **Tauri, wry, tao** (Apache-2.0 OR MIT) — the desktop app framework.
- **rustfft, realfft** (MIT / Apache-2.0 OR MIT) — FFT/DSP.

## Attribution obligation

MIT/BSD/ISC/Apache require that their copyright and permission notices be
preserved in redistributions. For binary distribution, ship the generated
`THIRD_PARTY_LICENSES.html` file (see `cargo about` above) alongside the app.

## Ported code

`src-tauri/src/inno.rs` ports the Inno Setup 5.2.0+ executable-decode filter
from **innoextract** (Daniel Scharrer, **zlib License**,
<https://constexpr.org/innoextract/>). The zlib terms are met: origin is not
misrepresented and this note preserves the attribution. Not a build dependency,
so it does not appear in the generated `cargo about` report — hence recorded
here and in `CREDITS.md`.
