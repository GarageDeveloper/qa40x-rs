/**
 * Firmware dialog (M5 — port of the v1 FirmwareController on the typed IPC
 * facade).
 *
 * QuantAsylum ships `setup_QA40x_<ver>.exe` (Inno Setup 6) whose payload
 * `QA40x.exe` carries the firmware. This panel scans it for NXP Secure-Binary
 * v2.1 images (one per model) and carves them out — from a local file the user
 * picks, or from a GitHub release it downloads — hashes each, checks the
 * hash against the embedded registry of official builds, and verifies the
 * SB2.1 RSA-2048/SHA-256 signature (authenticity, independent of the
 * registry). Dry-run builds and validates the exact flash byte sequence
 * without touching any device; the real flash is gated (connected model
 * match + valid signature) and confirmed.
 */
import "./dialog.css";
import { listen } from "@tauri-apps/api/event";
import { ask as askDialog, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type {
  DryRun,
  ExtractedImage,
  ExtractionResult,
  FlashProgress,
  ReleaseInfo,
  SignatureStatus,
} from "../../gen";
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../../store/store";
import type { AppState } from "../../store/state";
import { toast } from "../../store/actions/ui";
import { openDialog } from "../../ui/dialog";
import { el } from "../../ui/dom";


function shortSha(sha: string): string {
  return sha.length > 16 ? `${sha.slice(0, 8)}…${sha.slice(-8)}` : sha;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

/** A setup*.exe routes through innoextract; anything else is a raw QA40x.exe. */
function isSetupExe(path: string): boolean {
  const base = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return base.startsWith("setup") && base.endsWith(".exe");
}

export function openFirmwareDialog(store: Store<AppState>, ipc: Ipc): void {
  const releaseHost = el("div.fw__releases");
  const resultHost = el("div.fw__result");

  let busy = false;
  let allReleases: ReleaseInfo[] = [];
  let connectedModel: string | null = null;
  /**
   * Whether real flashing is validated on the connected model — the backend's
   * `supports_flash` capability (QA402 yes; QA403 dry-run-only until the KBOOT
   * transport is exercised on that hardware). `flash_firmware` enforces the
   * same gate device-side; this mirror only shapes the UI.
   */
  let flashSupported = false;

  const chooseBtn = el(
    "button.btn.btn--primary",
    {
      "data-testid": "fw-choose",
      title: "Pick a setup_QA40x_*.exe installer or a QA40x.exe",
      onclick: () => void chooseFile(),
    },
    "Choose file…"
  ) as HTMLButtonElement;
  const releasesBtn = el(
    "button.btn",
    { "data-testid": "fw-releases", onclick: () => void loadReleases() },
    "Load releases"
  ) as HTMLButtonElement;

  function setBusy(on: boolean): void {
    busy = on;
    chooseBtn.disabled = on;
    releasesBtn.disabled = on;
    releaseHost
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = on));
  }

  function note(text: string): HTMLElement {
    return el("p.fw__note", {}, text);
  }

  function renderEmptyResult(): void {
    resultHost.replaceChildren(
      note("No firmware extracted yet. Choose a file or a release above.")
    );
  }

  /* --------------------------- extraction --------------------------- */

  async function fetchConnectedModel(): Promise<void> {
    try {
      const meta = await ipc.call("get_device_info", {});
      const p = meta?.product ?? "";
      connectedModel = p.includes("QA403") ? "QA403" : p.includes("QA402") ? "QA402" : null;
      flashSupported = meta?.supports_flash ?? false;
    } catch {
      connectedModel = null;
      flashSupported = false;
    }
  }

  async function chooseFile(): Promise<void> {
    if (busy) return;
    let selected: string | null;
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "QA40x installer or app", extensions: ["exe"] }],
      });
      selected = typeof picked === "string" ? picked : null;
    } catch (error) {
      toast(store, "error", `Could not open file dialog: ${String(error)}`);
      return;
    }
    if (!selected) return;
    await extract(selected, isSetupExe(selected) ? "setup" : "exe");
  }

  async function extract(path: string, kind: "setup" | "exe"): Promise<void> {
    setBusy(true);
    resultHost.replaceChildren(
      note(kind === "setup" ? "Extracting installer…" : "Reading QA40x.exe…")
    );
    try {
      const result = await ipc.call(
        kind === "setup" ? "extract_firmware_from_setup" : "extract_firmware_from_exe",
        { path }
      );
      await renderResult(result);
      const genuine = result.images.filter((i) => i.signature.valid).length;
      toast(
        store,
        genuine > 0 ? "success" : "error",
        `Extracted ${result.images.length} firmware image(s) — ${genuine} genuine (signature-valid).`
      );
    } catch (error) {
      renderEmptyResult();
      toast(store, "error", `Extraction failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------- github releases ------------------------ */

  async function loadReleases(): Promise<void> {
    if (busy) return;
    setBusy(true);
    releaseHost.replaceChildren(note("Loading releases from GitHub…"));
    try {
      allReleases = await ipc.call("list_qa40x_releases", {});
      renderFirmwareVersions();
    } catch (error) {
      releaseHost.replaceChildren(el("p.fw__error", {}, String(error)));
    } finally {
      setBusy(false);
    }
  }

  /** Step 1: pick a firmware version (releases grouped by firmware_version). */
  function renderFirmwareVersions(): void {
    releaseHost.replaceChildren();
    if (allReleases.length === 0) {
      releaseHost.append(note("No releases found."));
      return;
    }
    const groups = new Map<string, ReleaseInfo[]>();
    for (const r of allReleases) {
      const key = r.firmware_version ?? " unknown";
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === " unknown") return 1;
      if (b === " unknown") return -1;
      return Number(b) - Number(a);
    });

    releaseHost.append(
      note("Choose a firmware version, then the release to download it from:")
    );
    for (const key of keys) {
      const rels = groups.get(key)!;
      const label = key === " unknown" ? "Older / unknown" : `Firmware ${key}`;
      const downloadable = rels.filter((r) => r.setup_asset_url).length;
      releaseHost.append(
        el(
          "button.fw__fw-choice",
          { onclick: () => renderReleasesForVersion(key, label) },
          el("span.fw__fw-name", {}, label),
          el(
            "span.fw__fw-count",
            {},
            `${rels.length} release${rels.length > 1 ? "s" : ""}` +
              (downloadable < rels.length ? ` · ${downloadable} downloadable` : "")
          ),
          el("span.fw__fw-arrow", {}, "→")
        )
      );
    }
  }

  /** Step 2: the releases shipping the chosen firmware version. */
  function renderReleasesForVersion(key: string, label: string): void {
    releaseHost.replaceChildren();
    const rels = allReleases.filter((r) => (r.firmware_version ?? " unknown") === key);
    releaseHost.append(
      el(
        "div.fw__releases-head",
        {},
        el("button.btn.btn--small", { onclick: () => renderFirmwareVersions() }, "← Versions"),
        el("span.fw__releases-title", {}, `${label} — pick a release`)
      )
    );
    for (const r of rels) {
      releaseHost.append(
        el(
          "div.fw__release-item",
          {},
          el(
            "div.fw__release-meta",
            {},
            el("span.fw__release-ver", {}, r.app_version),
            r.mentions_firmware
              ? el(
                  "span.fw__chip.fw__chip--flag",
                  { title: "Release notes mention firmware" },
                  "firmware"
                )
              : "",
            r.published_at
              ? el("span.fw__release-date", {}, formatDate(r.published_at))
              : ""
          ),
          r.setup_asset_url
            ? el(
                "button.btn.btn--small",
                { onclick: () => void downloadAndExtract(r) },
                "Download + Extract"
              )
            : el(
                "span.fw__release-noasset",
                { title: "This release has no setup_QA40x_*.exe asset" },
                "no installer"
              )
        )
      );
    }
  }

  async function downloadAndExtract(r: ReleaseInfo): Promise<void> {
    if (busy || !r.setup_asset_url) return;
    setBusy(true);
    resultHost.replaceChildren(note(`Downloading ${r.app_version}…`));
    try {
      const localPath = await ipc.call("download_qa40x_setup", { url: r.setup_asset_url });
      resultHost.replaceChildren(note(`Extracting ${r.app_version}…`));
      const result = await ipc.call("extract_firmware_from_setup", { path: localPath });
      await renderResult(result);
      const genuine = result.images.filter((i) => i.signature.valid).length;
      toast(
        store,
        genuine > 0 ? "success" : "error",
        `Extracted ${r.app_version}: ${genuine} genuine (signature-valid).`
      );
    } catch (error) {
      renderEmptyResult();
      toast(store, "error", `Download/extract failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  /* ----------------------------- result ----------------------------- */

  async function renderResult(result: ExtractionResult): Promise<void> {
    await fetchConnectedModel();
    resultHost.replaceChildren(
      el(
        "p.fw__source-caption",
        {},
        el("span.fw__source-file", {}, result.app_exe_name),
        el(
          "span.fw__source-kind",
          {},
          ` · ${result.source_kind === "setup" ? "installer" : "app binary"}`
        )
      )
    );
    if (result.images.length === 0) {
      resultHost.append(el("p.fw__error", {}, "No firmware images found in this file."));
      return;
    }
    if (result.images.length >= 2) {
      resultHost.append(
        note(
          connectedModel
            ? `This installer bundles a firmware for each model — flash the ${connectedModel} image (highlighted, matching your connected unit).`
            : "This installer bundles a firmware for each model (QA402 and QA403) — flash the one matching your unit."
        )
      );
    }
    for (const img of result.images) {
      resultHost.append(
        renderImageCard(img, connectedModel !== null && img.device === connectedModel)
      );
    }
  }

  /** Authenticity banner: the SB2.1 image's embedded RSA-2048/SHA-256
   * signature — proof of genuine firmware even for unregistered builds. */
  function signatureBanner(sig: SignatureStatus): HTMLElement {
    if (sig.valid) {
      return el(
        "div.fw__signature.fw__signature--valid",
        { title: sig.detail ?? "RSA-2048 / SHA-256" },
        "✓ ",
        el("strong", {}, "Signature valid"),
        " — genuine QuantAsylum firmware",
        sig.signer ? el("span.fw__signer", {}, ` (signer: ${sig.signer})`) : ""
      );
    }
    return el(
      "div.fw__signature.fw__signature--invalid",
      { title: sig.detail ?? "signature did not verify" },
      "✗ ",
      el("strong", {}, "Signature invalid"),
      sig.detail ? ` — ${sig.detail}` : ""
    );
  }

  function renderImageCard(img: ExtractedImage, isMine: boolean): HTMLElement {
    const fw = img.match?.firmware_version;
    const chip = img.known
      ? el(
          "span.fw__chip.fw__chip--known",
          {
            title:
              "Byte-identical to an official release build we have gathered (registry hit).",
          },
          `Known — official ${img.match!.app_version}${fw ? `, firmware ${fw}` : ""}`
        )
      : el(
          "span.fw__chip.fw__chip--unknown",
          {
            title:
              "Not in our hash registry (each build is re-nonced, so this is expected " +
              "for builds we have not gathered). Authenticity is decided by the " +
              "signature check, independently.",
          },
          "Unknown build"
        );

    const out = el("div.fw__out");

    // Gate: only the connected unit's own model, only a genuine image.
    let reason = "";
    if (!connectedModel) reason = "Connect your QA40x first";
    else if (!isMine)
      reason = `Connect a ${img.device} to flash this image (a ${connectedModel} is connected)`;
    else if (!flashSupported)
      reason = `Real flashing is not yet validated on ${connectedModel} hardware — dry-run works.`;
    else if (!img.signature.valid)
      reason = "Refusing to flash an image whose signature is not valid";
    const flashBtn = el(
      "button.btn",
      {
        title: reason || `Flash this ${img.device} firmware to your connected unit`,
        onclick: () => void flashImage(img, out),
      },
      "Flash…"
    ) as HTMLButtonElement;
    flashBtn.disabled = reason !== "";
    if (reason === "") flashBtn.classList.add("btn--primary");

    const dryBtn = el(
      "button.btn",
      {
        "data-testid": `fw-dry-run-${img.device}`,
        title:
          "Build and validate the exact bytes a real flash would send — nothing is written to any device",
        onclick: () => void dryRun(img, out),
      },
      "Dry-run"
    );

    const card = el(
      "div.fw__card",
      {},
      el(
        "div.fw__card-head",
        {},
        el(
          "span.fw__device",
          {
            title:
              "Device this firmware is for, inferred from the image size and order " +
              "(the QA402 image is always 52724 bytes; the QA403 image is the second one).",
          },
          img.device
        ),
        isMine ? el("span.fw__mine", {}, "← your device") : "",
        chip
      ),
      signatureBanner(img.signature),
      el(
        "dl.fw__meta",
        {},
        el("dt", {}, "Firmware"),
        el("dd", {}, fw ?? "unverified"),
        el("dt", {}, "Size"),
        el("dd", {}, `${img.size.toLocaleString()} B`),
        el("dt", {}, "SHA-256"),
        el("dd.fw__sha", { title: img.sha256 }, shortSha(img.sha256))
      ),
      el("div.fw__actions", {}, flashBtn, dryBtn, reason ? el("span.fw__reason", {}, reason) : ""),
      out
    );
    card.classList.toggle("fw__card--mine", isMine);
    return card;
  }

  /* ------------------------- dry-run + flash ------------------------ */

  async function dryRun(img: ExtractedImage, out: HTMLElement): Promise<void> {
    out.replaceChildren(note("Building flash sequence…"));
    const row = (k: string, v: string): HTMLElement[] => [el("dt", {}, k), el("dd", {}, v)];
    try {
      const d: DryRun = await ipc.call("flash_dry_run", { sha256: img.sha256 });
      const ok = d.reconstitutes_ok;
      out.replaceChildren(
        el(
          ok ? "div.fw__dry.fw__dry--ok" : "div.fw__dry.fw__dry--bad",
          { "data-testid": "fw-dry-result" },
          el(
            "div.fw__dry-head",
            {},
            ok ? "✓ Dry-run valid — no device touched" : "✗ Dry-run mismatch"
          ),
          el(
            "dl.fw__meta",
            {},
            ...row(
              "Enter bootloader",
              `reg 0x0F ⇐ ${d.bootloader_entry_hex[0]}, then ${d.bootloader_entry_hex[1]}`
            ),
            ...row("Command", `ReceiveSbFile — ${d.command_report_hex}`),
            ...row(
              "Payload",
              `${d.total_bytes.toLocaleString()} B → ${d.data_report_count.toLocaleString()} HID reports × ${d.data_payload_bytes} B`
            ),
            ...row("Wire SHA-256", shortSha(d.wire_sha256)),
            ...row(
              "Reconstitutes",
              ok ? "data reports rebuild the wire image exactly ✓" : "MISMATCH"
            )
          )
        )
      );
    } catch (error) {
      out.replaceChildren(el("p.fw__error", {}, String(error)));
    }
  }

  /** REAL flash — confirmed, gated, progress-tracked. Never auto-run. */
  async function flashImage(img: ExtractedImage, out: HTMLElement): Promise<void> {
    if (busy || !flashSupported) return;
    const fwv = img.match?.firmware_version
      ? `firmware v${img.match.firmware_version}`
      : "this firmware";
    const ok = await askDialog(
      `Flash the ${img.device} ${fwv} to your connected unit?\n\n` +
        `• The device enters its bootloader and is rewritten.\n` +
        `• Do NOT unplug until it reports success.\n` +
        `• After success you must unplug, wait a few seconds, and replug — it will not restart by itself.\n\n` +
        `For a first flash on a unit, re-flashing the SAME version it already runs is the safest check. Proceed?`,
      { title: "Flash firmware", kind: "warning" }
    );
    if (!ok) return;

    setBusy(true);
    const label = note("Entering bootloader…");
    const fill = el("div.fw__prog-fill");
    out.replaceChildren(label, el("div.fw__prog-bar", {}, fill));

    const offP = await listen<FlashProgress>("firmware-flash-progress", (e) => {
      const { sent, total } = e.payload;
      const pct = total ? Math.round((sent / total) * 100) : 0;
      fill.style.width = `${pct}%`;
      label.textContent = `Flashing… ${sent.toLocaleString()} / ${total.toLocaleString()} B (${pct}%)`;
    });
    const offPhase = await listen<string>("firmware-flash-phase", (e) => {
      if (e.payload === "waiting-for-bootloader")
        label.textContent = "Waiting for the NXP bootloader…";
    });

    try {
      await ipc.call("flash_firmware", { sha256: img.sha256 });
      fill.style.width = "100%";
      out.replaceChildren(
        el(
          "div.fw__dry.fw__dry--ok",
          {},
          el("div.fw__dry-head", {}, "✓ Flash succeeded"),
          note(
            "Now unplug the device, wait a few seconds, then plug it back in. It will not restart on its own."
          )
        )
      );
      toast(store, "success", "Flash succeeded — unplug, wait, then replug the device.");
    } catch (error) {
      out.replaceChildren(
        el(
          "div.fw__dry.fw__dry--bad",
          {},
          el("div.fw__dry-head", {}, "✗ Flash failed"),
          el("p.fw__error", {}, String(error))
        )
      );
      toast(store, "error", `Flash failed: ${String(error)}`);
    } finally {
      offP();
      offPhase();
      setBusy(false);
    }
  }

  /* ------------------------------ body ------------------------------ */

  renderEmptyResult();
  const body = el(
    "div.fw",
    {},
    el(
      "section.fw__section",
      {},
      el("h3.fw__title", {}, "Source"),
      note(
        "Extract the official firmware from a QuantAsylum installer or app. " +
          "Nothing is written to your device — this only reads and verifies."
      ),
      el("div.fw__row", {}, chooseBtn, el("span.fw__gh", {}, "From GitHub releases"), releasesBtn)
    ),
    el(
      "section.fw__section",
      {},
      el("h3.fw__title", {}, "Extracted firmware"),
      resultHost
    ),
    releaseHost
  );

  const handle = openDialog({
    title: "Firmware",
    body,
    actions: [el("button.btn", { onclick: () => handle.close() }, "Close")],
    testid: "firmware-dialog",
  });
}
