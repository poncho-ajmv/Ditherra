/**
 * Grid pixel operations shared by the editor tools.
 */

export type PixelUpdate = { x: number; y: number; color: number };
export type Pt = { x: number; y: number };

/** Bresenham line from (x0,y0) to (x1,y1), inclusive. */
export function line(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const pts: Pt[] = [];
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  for (;;) {
    pts.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return pts;
}

/** Outline of the rectangle spanning the two corners (dedup'd). */
export function rectOutline(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const xmin = Math.min(x0, x1), xmax = Math.max(x0, x1);
  const ymin = Math.min(y0, y1), ymax = Math.max(y0, y1);
  const pts: Pt[] = [];
  const seen = new Set<string>();
  const add = (x: number, y: number) => {
    const k = `${x},${y}`;
    if (!seen.has(k)) { seen.add(k); pts.push({ x, y }); }
  };
  for (let x = xmin; x <= xmax; x++) { add(x, ymin); add(x, ymax); }
  for (let y = ymin; y <= ymax; y++) { add(xmin, y); add(xmax, y); }
  return pts;
}

/** Ellipse outline fit to the bounding box of the two corners. Sampled by angle
 *  and dedup'd — fine for sprite sizes (≤64). */
export function ellipseOutline(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
  const pts: Pt[] = [];
  const seen = new Set<string>();
  const steps = Math.max(16, Math.ceil((rx + ry) * 6));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    const x = Math.round(cx + rx * Math.cos(a));
    const y = Math.round(cy + ry * Math.sin(a));
    const k = `${x},${y}`;
    if (!seen.has(k)) { seen.add(k); pts.push({ x, y }); }
  }
  return pts;
}

/**
 * Flood fill from (x,y): every 4-connected cell holding the same colour as the
 * start becomes `replacement`. Returns the cells that change (empty if the
 * start already is `replacement`, so a no-op doesn't touch history).
 */
export function floodFill(
  grid: number[][],
  x: number,
  y: number,
  replacement: number
): PixelUpdate[] {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  if (y < 0 || y >= h || x < 0 || x >= w) return [];
  const target = grid[y][x];
  if (target === replacement) return [];

  const out: PixelUpdate[] = [];
  const seen = new Set<number>();
  const stack: [number, number][] = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop()!;
    if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
    const key = cy * w + cx;
    if (seen.has(key)) continue;
    if (grid[cy][cx] !== target) continue;
    seen.add(key);
    out.push({ x: cx, y: cy, color: replacement });
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
  return out;
}

/**
 * Cells that touch a filled pixel but are empty themselves — the silhouette's
 * outer ring. Returned as updates so it goes through the same path as a stroke
 * (undoable, saved, mirrored if you want it to be).
 *
 * 4-neighbour on purpose: 8-neighbour rounds off corners, which at 16px reads
 * as blur rather than as an outline.
 */
export function outlineCells(
  pixels: number[][],
  color: number,
): { x: number; y: number; color: number }[] {
  const h = pixels.length;
  const out: { x: number; y: number; color: number }[] = [];
  for (let y = 0; y < h; y++) {
    const w = pixels[y].length;
    for (let x = 0; x < w; x++) {
      if (pixels[y][x] >= 0) continue;              // already painted
      const touches =
        (pixels[y - 1]?.[x] ?? -1) >= 0 ||
        (pixels[y + 1]?.[x] ?? -1) >= 0 ||
        (pixels[y]?.[x - 1] ?? -1) >= 0 ||
        (pixels[y]?.[x + 1] ?? -1) >= 0;
      if (touches) out.push({ x, y, color });
    }
  }
  return out;
}
