# Contributing to qa40x-rs

Thanks for your interest! This is a young project — issues, measurements and
code are all welcome.

## Ground rules

- **Security issues**: never in a public issue — see [SECURITY.md](SECURITY.md)
  (GitHub private vulnerability reporting).
- **Licensing**: the project is dual-licensed MIT OR Apache-2.0. By submitting
  a contribution you agree to license it under the same terms.
- **Clean-room policy**: this is an unofficial, clean-room interoperability project.
  Do not contribute anything derived from decompiled QuantAsylum software or
  other proprietary sources — behavioural observations (USB captures of your
  own device, measurements) are fine, vendor code is not.

## Getting started

```bash
npm install
npm run tauri dev      # run the app (device optional — the UI runs without one)
```

Before opening a PR, make sure these pass:

```bash
npx tsc --noEmit                        # frontend types
npm test                                # vitest unit tests
npm run test:e2e                        # Playwright suite (fake device, no hardware)
cargo test  --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
```

Notes:

- `src/gen/` is generated from the Rust types (`npm run gen:types`) — never
  edit those files by hand; change the Rust source and regenerate.
- Dependency changes: keep `cargo deny check licenses` green (allow-list in
  `src-tauri/deny.toml`) and regenerate `THIRD_PARTY_LICENSES.html`
  (see THIRD_PARTY.md).
- Hardware-dependent tests skip automatically when no QA402/QA403 (or local
  fixtures) are present; mention in the PR if you ran them against real
  hardware and on which model.

## Measurements & bug reports

The most valuable bug report for an analyzer app includes: your device model
and firmware version, the measurement setup (loopback? DUT?), what the official
QA40x app reports for the same signal, and what qa40x-rs reports.
