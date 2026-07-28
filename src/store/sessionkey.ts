/**
 * Session-key primitives (issue #25 lot E2) — a LEAF module, imported by
 * both state.ts and selectors/session.ts so neither needs a runtime import
 * of the other (E2 review #8: the previous state.ts ↔ session.ts pair had
 * a real value-import cycle that a later module-level access would have
 * turned into a TDZ/undefined surprise, bundler-order dependent).
 *
 * A session key is the backend runtime SLOT, stringified. Keyed by slot,
 * NOT by device id: `connect()` writes `status: "connecting"` before any id
 * is known (the legacy arg-less `connect_device` path — pinned by
 * devices.pw.ts's `connectDeviceIds() === [null]`), and the per-session
 * module maps (streamGen, stopInFlight, the capture memo) need a key that
 * never changes under them. The slot is knowable a priori: slot 0 belongs
 * to the connect/demo flows (registry.rs: open/open_first_physical/
 * open_virtual all target it); added units live on slots ≥ 1 (E1 contract).
 * E3 persists the slot for the same reason — a doc carried to another
 * bench must not be bench-bound.
 */
export type SessionKey = string;

/** The default runtime's session — the connect/demo flows' slot. */
export const SLOT0: SessionKey = "slot-0";

export function sessionKeyForSlot(slot: number): SessionKey {
  return `slot-${slot}`;
}

export function slotOfSessionKey(key: SessionKey): number {
  return Number(key.slice("slot-".length));
}
