# Credits & attribution

`qa40x-rs Audio Analyzer` is an independent, from-scratch Rust/Tauri
implementation. The QA402/QA403 USB protocol was understood by studying the
following **openly-licensed reference material**. We reimplemented the behaviour
in our own code; the hardware register map, byte layout, and magic values are
facts dictated by the device, not copied expression. These references are
gratefully acknowledged:

- **PyQa40x** — QuantAsylum — MIT License
  <https://github.com/QuantAsylum/PyQa40x>
- **QA40x_BareMetal** — QuantAsylum — reference bare-metal interface
  <https://github.com/QuantAsylum/QA40x_BareMetal>
- **ASIO401** — Etienne Dechamps — MIT License
  <https://github.com/dechamps/ASIO401>
  (Its own LICENSE.txt is MIT. The ASIO trademark/SDK note in that file concerns
  the Steinberg ASIO SDK, which this project does **not** use — qa40x-rs is not an
  ASIO driver.)
- **innoextract** — Daniel Scharrer — zlib License
  <https://constexpr.org/innoextract/>
  (The pure-Rust Inno Setup reader in `src-tauri/src/inno.rs` — used to extract
  the app payload from a QuantAsylum installer the user already owns — ports the
  Inno 5.2.0+ executable-decode filter from innoextract's implementation.)

All of the above are permissive (MIT / zlib). This project is offered under MIT OR Apache-2.0
(see `LICENSE-MIT` / `LICENSE-APACHE`); third-party dependency notices are in
`THIRD_PARTY.md`.

Hardware, firmware, and the official software are the property of
**QuantAsylum**. This project is unofficial and not affiliated with, authorized
by, or endorsed by QuantAsylum.
