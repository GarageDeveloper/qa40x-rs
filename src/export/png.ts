/**
 * Tile → PNG composition (issue #30). Grabs the tile's live chart canvas
 * PIXELS (same trick as the drag ghost — cloneNode yields blank canvases)
 * and composites them under a title line and over small provenance footer
 * lines, on an opaque theme background so the file reads outside the app.
 *
 * DOM-in, bytes-out; the save/clipboard side effects live in export.ts.
 * One PNG lane only — the clipboard path ships the SAME bytes and lets the
 * backend decode (review finding #8: an eager RGBA lane base64'd ~25 MB of
 * raw pixels per Retina export, and 34 MB more through IPC on copy).
 */

/** Composited tile image: PNG bytes + pixel dimensions. */
export interface TileImage {
  pngBase64: string;
  width: number;
  height: number;
}

/** Base64 of raw bytes, chunked (String.fromCharCode has an argument cap). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Compose the tile's chart canvas with a title band and provenance footer.
 * Null when there is nothing meaningful to export: no canvas yet, a
 * display:none tile (offsetParent null — e.g. NOT the focused one while ⛶
 * focus holds the grid; its ResizeObserver clamped the canvas to a 40 px
 * floor and the chart drew nothing — review finding #1: exporting that
 * "successfully" hands the user a confident, empty image), or a canvas too
 * small for the chart's own plot margins to leave any plot area. */
export async function composeTileImage(
  tileRoot: HTMLElement,
  title: string,
  footerLines: string[]
): Promise<TileImage | null> {
  const src = tileRoot.querySelector<HTMLCanvasElement>(".tile__chart canvas");
  if (!src || src.offsetParent === null) return null;
  // canvas.ts margins: 54+16 px horizontal, 14+32 vertical — below ~half
  // that nothing was drawn (drawStatic bails on a non-positive plot).
  if (src.clientWidth <= 80 || src.clientHeight <= 56) return null;
  if (src.width === 0 || src.height === 0) return null;

  const dpr = window.devicePixelRatio || 1;
  const style = getComputedStyle(tileRoot);
  const background = style.backgroundColor || "#111";
  const foreground = style.color || "#ddd";
  const fontFamily = style.fontFamily || "sans-serif";

  const pad = Math.round(8 * dpr);
  const titlePx = Math.round(12 * dpr);
  const footerPx = Math.round(9 * dpr);
  const titleBand = titlePx + 2 * pad;
  const footerBand = footerLines.length * (footerPx + Math.round(2 * dpr)) + pad;

  const out = document.createElement("canvas");
  out.width = src.width + 2 * pad;
  out.height = src.height + titleBand + footerBand + pad;
  const ctx = out.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.fillStyle = foreground;
  ctx.font = `${titlePx}px ${fontFamily}`;
  ctx.textBaseline = "top";
  ctx.fillText(title, pad, pad);
  ctx.drawImage(src, pad, titleBand);
  ctx.globalAlpha = 0.75;
  ctx.font = `${footerPx}px ${fontFamily}`;
  footerLines.forEach((line, i) => {
    ctx.fillText(
      line,
      pad,
      titleBand + src.height + pad + i * (footerPx + Math.round(2 * dpr))
    );
  });
  ctx.globalAlpha = 1;

  const blob = await new Promise<Blob | null>((resolve) =>
    out.toBlob(resolve, "image/png")
  );
  if (!blob) return null;
  const pngBase64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  return { pngBase64, width: out.width, height: out.height };
}
