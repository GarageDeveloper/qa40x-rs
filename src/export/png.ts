/**
 * Tile → PNG composition (issue #30). Grabs the tile's live chart canvas
 * PIXELS (same trick as the drag ghost — cloneNode yields blank canvases)
 * and composites them under a title line and over small provenance footer
 * lines, on an opaque theme background so the file reads outside the app.
 *
 * DOM-in, bytes-out; the save/clipboard side effects live in export.ts.
 */

/** Composited tile image, in both forms the two sinks want: PNG bytes for
 * a file, raw RGBA for the Rust clipboard command (no decoder Rust-side). */
export interface TileImage {
  pngBase64: string;
  rgbaBase64: string;
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
 * Null when the tile has no rendered canvas yet (nothing to export). */
export async function composeTileImage(
  tileRoot: HTMLElement,
  title: string,
  footerLines: string[]
): Promise<TileImage | null> {
  const src = tileRoot.querySelector<HTMLCanvasElement>(".tile__chart canvas");
  if (!src || src.width === 0 || src.height === 0) return null;

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
  const rgba = ctx.getImageData(0, 0, out.width, out.height);
  const rgbaBase64 = bytesToBase64(new Uint8Array(rgba.data.buffer));
  return { pngBase64, rgbaBase64, width: out.width, height: out.height };
}
