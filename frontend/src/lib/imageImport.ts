/**
 * Turn any uploaded image into an editable sprite: fit it into a size×size grid,
 * average each cell down, then quantise to a small palette. All client-side — the
 * backend just stores the resulting indices + colours like any other sprite.
 */

const loadViaElement = (file: File) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("element decode failed")); };
    img.src = url;
  });

/**
 * Decode any file the browser can read into something drawable — regardless of
 * its declared MIME type or extension. The <img> element handles the common
 * formats plus SVG; createImageBitmap picks up a few blobs it rejects. If both
 * fail the file genuinely isn't a decodable image.
 */
async function decodeImage(file: File): Promise<{ src: CanvasImageSource; w: number; h: number }> {
  try {
    const img = await loadViaElement(file);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w && h) return { src: img, w, h };
  } catch { /* fall through */ }
  try {
    const bmp = await createImageBitmap(file);
    if (bmp.width && bmp.height) return { src: bmp, w: bmp.width, h: bmp.height };
  } catch { /* fall through */ }
  throw new Error("could not read this image — try a PNG or JPG");
}

const toHex = (r: number, g: number, b: number) =>
  `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;

export async function imageToSprite(
  file: File,
  size: number,
  maxColors = 48,
): Promise<{ colors: string[]; pixels: number[][] }> {
  const { src, w: iw, h: ih } = await decodeImage(file);

  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true; // average, don't nearest-pick, when shrinking
  ctx.clearRect(0, 0, size, size);
  // Keep the original proportions (no stretching) — fit inside the square and
  // centre it; empty cells stay transparent.
  const scale = Math.min(size / iw, size / ih);
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  ctx.drawImage(src, Math.floor((size - w) / 2), Math.floor((size - h) / 2), w, h);

  const data = ctx.getImageData(0, 0, size, size).data;

  // Count colours in a coarse (5-bit-per-channel) space so near-identical pixels
  // merge, then keep the most common ones as the palette.
  const counts = new Map<string, { rgb: [number, number, number]; n: number }>();
  const cells: ([number, number, number] | null)[] = [];
  for (let i = 0; i < size * size; i++) {
    if (data[i * 4 + 3] < 128) { cells.push(null); continue; } // transparent → empty
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    cells.push([r, g, b]);
    const key = `${r >> 3},${g >> 3},${b >> 3}`;
    const e = counts.get(key);
    if (e) e.n++; else counts.set(key, { rgb: [r, g, b], n: 1 });
  }

  const palette = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, maxColors).map((e) => e.rgb);
  if (palette.length === 0) palette.push([0, 0, 0]); // fully transparent image
  const colors = palette.map(([r, g, b]) => toHex(r, g, b));

  // Map each cell to its nearest palette colour.
  const pixels: number[][] = [];
  for (let y = 0; y < size; y++) {
    const row: number[] = [];
    for (let x = 0; x < size; x++) {
      const cell = cells[y * size + x];
      if (!cell) { row.push(-1); continue; }
      let best = 0, bd = Infinity;
      for (let p = 0; p < palette.length; p++) {
        const dr = cell[0] - palette[p][0], dg = cell[1] - palette[p][1], db = cell[2] - palette[p][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = p; }
      }
      row.push(best);
    }
    pixels.push(row);
  }

  return { colors, pixels };
}
