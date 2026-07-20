/**
 * Status bar (bottom) — the device readout reads as ONE line, left to
 * right: identity (model · serial), the firmware version (clickable — THE
 * path to the firmware update dialog), then live telemetry. The REST
 * indicator sits alone on the right: hidden when stopped, quiet on
 * localhost, amber when exposed on the network (click → App drawer).
 * Fixed height and always present, so connecting never shifts the layout.
 */
import "./panel.css";
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../../store/store";
import { shallowEq } from "../../store/store";
import type { AppState } from "../../store/state";
import { openAppDrawer } from "../appmenu/drawer";
import { openFirmwareDialog } from "../firmware/dialog";
import { el } from "../../ui/dom";

function fmt(value: number, digits: number): string {
  return value.toFixed(digits);
}

export function mountStatusBar(
  host: HTMLElement,
  store: Store<AppState>,
  ipc: Ipc
): void {
  const identity = el("span.status-bar__identity", {
    "data-testid": "device-identity",
  });
  const fwBtn = el("button.status-bar__fw", {
    "data-testid": "btn-firmware",
    title: "Firmware update (extract, verify, flash)",
    onclick: () => openFirmwareDialog(store, ipc),
  });
  const telemetry = el("span.status-bar__telemetry", {
    "data-testid": "device-telemetry",
  });
  const rest = el("button.status-bar__rest", {
    "data-testid": "rest-indicator",
    onclick: () => openAppDrawer(store, ipc),
  });

  host.append(
    el(
      "footer.status-bar",
      {},
      identity,
      fwBtn,
      telemetry,
      el("span.status-bar__spacer"),
      rest
    )
  );

  store.select(
    (s) => s.device,
    (device) => {
      const connected = device.status === "connected" && device.info;
      identity.textContent = connected
        ? `${device.info!.model} · ${device.info!.serial} ·`
        : "No device";

      fwBtn.hidden = !connected;
      fwBtn.textContent = connected ? `fw ${device.info!.firmware_version}` : "";

      const t = device.telemetry;
      telemetry.textContent =
        connected && t
          ? `· USB ${fmt(t.usb_voltage_v, 2)} V · ${Math.round(t.usb_current_ma)} mA` +
            ` · ISO ${Math.round(t.iso_current_ma)} mA · ${fmt(t.temperature_c, 1)} °C`
          : "";
    },
    shallowEq
  );

  store.select(
    (s) => s.ui.rest,
    (r) => {
      const exposed = r?.exposed === true;
      rest.hidden = !r?.running;
      rest.textContent = !r?.running
        ? ""
        : exposed
          ? `⚠ REST LAN ${r.host}:${r.port}`
          : `REST :${r.port}`;
      rest.classList.toggle("status-bar__rest--exposed", exposed);
      rest.title = exposed
        ? "REST is exposed on the network — any host that can reach this " +
          "machine can drive the hardware. Click to manage."
        : "REST automation server (localhost only). Click to manage.";
    },
    shallowEq
  );
}
