/**
 * Test fixtures for the devices slice — a NON-test module so both
 * actions/devices.test.ts and selectors/devices.test.ts can share
 * `fakeEntry` without one importing the other (importing a *.test.ts module
 * re-registers and re-runs its whole suite under the importer's file).
 */
import type { DeviceEntry, DeviceList } from "../../gen";

export function fakeEntry(
  id: string,
  opts: { virtual?: boolean; open?: boolean; model?: "QA402" | "QA403" } = {}
): DeviceEntry {
  const model = opts.model ?? (opts.virtual ? "QA403" : "QA402");
  const rates =
    model === "QA403" ? [48000, 96000, 192000, 384000] : [48000, 96000, 192000];
  return {
    id,
    source_id: opts.virtual ? "virtual" : "usb",
    source_kind: opts.virtual ? "Virtual" : "Usb",
    source_label: opts.virtual ? "Built-in virtual" : "USB",
    model,
    serial: id.split("/")[1],
    serial_synthetic: false,
    product: `${model} Audio Analyzer`,
    firmware_version: opts.open ? 60 : null,
    is_virtual: opts.virtual ?? false,
    capabilities: {
      model_name: model,
      input_channels: 2,
      output_channels: 2,
      sample_rates_hz: rates,
      input_ranges_dbv: [0, 6, 12, 18, 24, 30, 36, 42],
      output_ranges_dbv: [-12, -2, 8, 18],
      min_output_vrms: 1e-6,
      max_output_vrms: 7.943,
      max_input_vrms: 89.13,
      min_measurement_hz: 5,
      max_measurement_hz: rates[rates.length - 1] / 2,
      calibration: opts.open ? { FactoryEeprom: { page_bytes: 512 } } : "Unknown",
      supports_flash: false,
      is_virtual: opts.virtual ?? false,
    },
    open: opts.open ?? false,
  };
}

/** A DeviceList whose `open` mirrors the entries' own flags. */
export function fakeList(...devices: DeviceEntry[]): DeviceList {
  return { devices, open: devices.filter((d) => d.open).map((d) => d.id) };
}
