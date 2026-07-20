/**
 * Tiny DOM helpers — retained nodes + keyed reconciliation instead of the
 * legacy rebuild-everything-per-frame (plan §3.5). ~80 lines, no framework.
 */

type Attrs = Record<string, string | boolean | EventListener | undefined>;

/**
 * Create an element: `el("button.btn.btn--primary", { onclick }, "Run")`.
 * Class names ride on the tag; attributes starting with "on" become
 * listeners; boolean attrs toggle.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}`,
  attrs: Attrs = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = (spec as string).split(".");
  const node = document.createElement(tag) as HTMLElementTagNameMap[K];
  if (classes.length) node.className = classes.join(" ");
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, value as string);
    }
  }
  node.append(...children);
  return node;
}

export interface KeyedRenderer<T> {
  /** Build the DOM structure for a new item (called once per key). */
  create(item: T): HTMLElement;
  /**
   * Apply the item's current values to the node. Called on every
   * reconcile, INCLUDING right after `create` — so `create` builds
   * structure and `update` owns all value/state application.
   */
  update(node: HTMLElement, item: T): void;
}

/**
 * Reconcile `host`'s children against `items` by key: existing nodes are
 * moved/updated, missing ones created, stale ones removed. Per-frame
 * updates touch textContent/attributes only — nodes survive.
 */
export function keyedList<T>(
  host: HTMLElement,
  items: T[],
  keyOf: (item: T) => string,
  renderer: KeyedRenderer<T>
): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(host.children)) {
    const key = (child as HTMLElement).dataset.key;
    if (key !== undefined) existing.set(key, child as HTMLElement);
  }

  let cursor: ChildNode | null = host.firstChild;
  for (const item of items) {
    const key = keyOf(item);
    let node = existing.get(key);
    if (node) {
      existing.delete(key);
    } else {
      node = renderer.create(item);
      node.dataset.key = key;
    }
    renderer.update(node, item);
    if (node !== cursor) {
      host.insertBefore(node, cursor);
    } else {
      cursor = cursor.nextSibling;
    }
  }
  for (const stale of existing.values()) stale.remove();
}
