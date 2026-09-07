"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Studio } from "@/hooks/useStudio";
import { api, tilesetUrl } from "@/lib/api";
import { floodFill, line, rectOutline, ellipseOutline, outlineCells, type Pt } from "@/lib/pixelOps";
import { paletteVariants, HARMONY_LABELS, type HarmonyType } from "@/lib/harmony";
import { zipBlobs } from "@/lib/zip";
import { imageToSprite } from "@/lib/imageImport";
import { PixelIcon } from "./PixelIcon";

type Tool = "pencil" | "eraser" | "bucket" | "eyedropper" | "dither" | "line" | "rect" | "circle" | "select" | "hand";
const SHAPE_TOOLS: Tool[] = ["line", "rect", "circle"];

// Keyboard shortcut → tool. Matches the letters shown in the tooltips.
const TOOL_KEYS: Record<string, Tool> = {
  b: "pencil", e: "eraser", g: "bucket", i: "eyedropper", d: "dither",
  l: "line", r: "rect", c: "circle", m: "select", h: "hand",
};

type Rect = { x: number; y: number; w: number; h: number };
type FloatCell = { dx: number; dy: number; ci: number };

export function Canvas({ studio }: { studio: Studio }) {
  const t = studio.t;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevPixelsRef = useRef<number[][] | null>(null);
  const prevSizeRef = useRef<number>(0);
  const prevDisplayRef = useRef<number>(0);
  const prevPaletteRef = useRef<string[] | null>(null);
  const rafRef = useRef<number>(0);
  const zoomRef = useRef(false); // mirrors whether the lightbox is open
  const exportOpenRef = useRef(false); // mirrors whether the export dialog is open
  const [pixelInfo, setPixelInfo] = useState("");
  const [isPainting, setIsPainting] = useState(false);
  const [chatMsg, setChatMsg] = useState("");
  const [tilesetErr, setTilesetErr] = useState("");
  const [tilesetBusy, setTilesetBusy] = useState(false);
  const [tool, setTool] = useState<Tool>("pencil");
  // Export dialog
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<"png" | "webp" | "jpg" | "svg">("png");
  const [exportScale, setExportScale] = useState(1);
  const [exportTrim, setExportTrim] = useState(false);
  // Extras section: block tiles get "tileset", every sprite gets "variantes".
  const [extrasTab, setExtrasTab] = useState<"tileset" | "variantes">("tileset");
  const [variantHarmony, setVariantHarmony] = useState<HarmonyType>("complementary");
  // Zoom lightbox — shared by tileset tiles and colour variants. Holds which
  // set ("tile"/"variant") and the index within it, so arrows can step through.
  const [zoom, setZoom] = useState<{ kind: "tile" | "variant"; index: number } | null>(null);
  // Import-image dialog. A picked file is previewed (pixelated at the chosen
  // size) before it's committed — nothing is created until "import" is pressed.
  const [importOpen, setImportOpen] = useState(false);
  const [importSize, setImportSize] = useState(16);
  const [importBusy, setImportBusy] = useState(false);
  const [importErr, setImportErr] = useState("");
  const [importDrag, setImportDrag] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importData, setImportData] = useState<{ colors: string[]; pixels: number[][] } | null>(null);
  const [importPreview, setImportPreview] = useState("");
  const [importOrig, setImportOrig] = useState("");
  const importFileRef = useRef<HTMLInputElement>(null);
  // Zoom: fitScale is the auto-fit pixels-per-pixel; userScale overrides it when
  // the user zooms. canvasDisplaySize is derived so it's always pixel-perfect.
  const [fitScale, setFitScale] = useState(16);
  const [userScale, setUserScale] = useState<number | null>(null);
  const [avail, setAvail] = useState({ w: 512, h: 512 });
  // Shape drag: start corner + the live preview points (not committed until mouseup).
  const shapeStart = useRef<Pt | null>(null);
  const [shapePreview, setShapePreview] = useState<Pt[] | null>(null);
  // Mirror axes. Characters and faces are symmetric; drawing half of one and
  // hand-copying the other half is the slowest thing in pixel art.
  const [mirrorX, setMirrorX] = useState(false);
  const [mirrorY, setMirrorY] = useState(false);

  // Selection (tool M): the marquee rect, plus the "lifted" cells while moving.
  const [selection, setSelection] = useState<Rect | null>(null);
  const selDrag = useRef<{ mode: "mark" | "move"; start: Pt; origin?: Pt } | null>(null);
  const floatCells = useRef<FloatCell[] | null>(null);
  const [floatPos, setFloatPos] = useState<Pt | null>(null);
  const clipboard = useRef<{ w: number; h: number; cells: FloatCell[] } | null>(null);
  // Pan: drag the sprite around inside the viewport without painting.
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  const { pixelData, spriteSize, currentPalette, selectedColorIdx, status } = studio;

  // The size actually DRAWN is the loaded sprite's own dimensions, not the size
  // picker (which only sets the size of the NEXT generation). Mixing the two was
  // the bug where changing the selector broke and overlapped the current canvas.
  const size = pixelData?.length || spriteSize;

  // Zoom level → display size (pixel-perfect: scale is whole screen-px per sprite-px).
  const scale = userScale ?? fitScale;
  const canvasDisplaySize = scale * size;

  // A blank sprite (nothing painted) gets the invitation overlay.
  const isEmptyCanvas = !pixelData || pixelData.every((r) => r.every((c) => c < 0));

  // Reset zoom to fit whenever the drawn size changes (new/loaded/generated
  // sprite of a different size), so a leftover zoom doesn't leave it off-screen.
  useEffect(() => { setUserScale(null); }, [size]);

  // Colours to RENDER with: a sprite loaded from history carries its own colour
  // snapshot (currentGen.colors), so it stays intact even if you delete the
  // palette it was made with. New sprites (no snapshot) fall back to the active
  // palette. This is why deleting palettes no longer blanks your pixel art.
  // Adding colours keeps the snapshot in sync (see syncGenColors in useStudio).
  const paletteColors = studio.currentGen?.colors ?? currentPalette?.colors ?? null;

  // ── Undo / redo ──
  // Grid snapshots, capped so a long session can't grow the stack unbounded.
  const undoStack = useRef<number[][][]>([]);
  const redoStack = useRef<number[][][]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const syncHist = () => {
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(redoStack.current.length > 0);
  };
  // Latest grid, read by keyboard handlers registered once.
  const pixelsRef = useRef<number[][] | null>(pixelData);
  useEffect(() => { pixelsRef.current = pixelData; }, [pixelData]);

  const clone = (g: number[][]) => g.map((r) => [...r]);
  const pushHistory = () => {
    if (!pixelsRef.current) return;
    undoStack.current.push(clone(pixelsRef.current));
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
    syncHist();
  };
  // Cells where `target` differs from `cur` — the delta to send to setPixels.
  const diffTo = (cur: number[][], target: number[][]) => {
    const updates: { x: number; y: number; color: number }[] = [];
    for (let y = 0; y < target.length; y++)
      for (let x = 0; x < target[y].length; x++)
        if (cur[y]?.[x] !== target[y][x]) updates.push({ x, y, color: target[y][x] });
    return updates;
  };
  const undo = useCallback(() => {
    const cur = pixelsRef.current;
    const prev = undoStack.current.pop();
    if (!cur || !prev) return;
    redoStack.current.push(clone(cur));
    studio.setPixels(diffTo(cur, prev));
    syncHist();
  }, [studio]);
  const redo = useCallback(() => {
    const cur = pixelsRef.current;
    const next = redoStack.current.pop();
    if (!cur || !next) return;
    undoStack.current.push(clone(cur));
    studio.setPixels(diffTo(cur, next));
    syncHist();
  }, [studio]);

  // Keyboard: tool letters + undo/redo. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (zoomRef.current || exportOpenRef.current) return; // an overlay owns the keyboard
      if (e.key === "Escape") { shapeStart.current = null; setShapePreview(null); setSelection(null); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && selection) {
        pushHistory();
        const clears: { x: number; y: number; color: number }[] = [];
        for (let dy = 0; dy < selection.h; dy++)
          for (let dx = 0; dx < selection.w; dx++)
            clears.push({ x: selection.x + dx, y: selection.y + dy, color: -1 });
        studio.setPixels(clears);
        void studio.flushPixels();
        e.preventDefault();
        return;
      }
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && k === "y") { e.preventDefault(); redo(); return; }
      // Copy the selection's cells (relative), paste at the current selection.
      if ((e.metaKey || e.ctrlKey) && k === "c" && selection) {
        const px = pixelsRef.current;
        const cells: FloatCell[] = [];
        if (px) for (let dy = 0; dy < selection.h; dy++)
          for (let dx = 0; dx < selection.w; dx++) {
            const ci = px[selection.y + dy]?.[selection.x + dx] ?? -1;
            if (ci >= 0) cells.push({ dx, dy, ci });
          }
        clipboard.current = { w: selection.w, h: selection.h, cells };
        e.preventDefault();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && k === "v" && clipboard.current) {
        const cb = clipboard.current;
        const ox = selection ? selection.x : 0, oy = selection ? selection.y : 0;
        pushHistory();
        studio.setPixels(cb.cells.map((c) => ({ x: ox + c.dx, y: oy + c.dy, color: c.ci })));
        setSelection({ x: ox, y: oy, w: cb.w, h: cb.h });
        void studio.flushPixels();
        e.preventDefault();
        return;
      }
      if (!e.metaKey && !e.ctrlKey && TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, selection, studio]);

  // Resize canvas to fill available space
  useEffect(() => {
    const resize = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      // Leave room for toolbars (top + left ~56px), info bar, chat, padding.
      const availW = rect.width - 120;
      const availH = rect.height - 160;
      setAvail({ w: availW, h: availH });
      const available = Math.min(availW, availH);
      const maxSize = Math.max(256, Math.min(available, 800));
      setFitScale(Math.floor(maxSize / size));
    };
    resize();
    // ResizeObserver, not a window listener: dragging a splitter changes this
    // container without the window ever resizing, and the canvas has to follow.
    const observer = new ResizeObserver(resize);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [size]);

  // The preview itself is cleared in useStudio on sprite switch; here we reset the
  // local error state and everything else scoped to one sprite. Undo history in
  // particular: it survived the switch, so Ctrl+Z replayed the previous sprite's
  // grid onto the new one — and across different sizes that wrote garbage.
  useEffect(() => {
    setTilesetErr("");
    undoStack.current = [];
    redoStack.current = [];
    syncHist();
    clipboard.current = null;
    floatCells.current = null;
    selDrag.current = null;
    setFloatPos(null);
    setSelection(null);
  }, [studio.activeGenId]);

  // Checkerboard colours from the active theme's CSS variables, so the
  // transparency grid follows dark/light without hardcoding hex here.
  const checkerColors = useCallback((): [string, string] => {
    const root = getComputedStyle(document.documentElement);
    return [
      root.getPropertyValue("--canvas-light").trim() || "#34322c",
      root.getPropertyValue("--canvas-dark").trim() || "#211f1b",
    ];
  }, [studio.theme]);

  // Full canvas redraw
  const drawFull = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pixelData || !paletteColors) return;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    const scale = Math.floor(canvasDisplaySize / size);
    canvas.width = size * scale;
    canvas.height = size * scale;

    const [cL, cD] = checkerColors();
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? cL : cD;
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    for (let y = 0; y < pixelData.length; y++)
      for (let x = 0; x < (pixelData[y]?.length || 0); x++) {
        const idx = pixelData[y][x];
        if (idx >= 0 && idx < paletteColors.length) {
          ctx.fillStyle = paletteColors[idx];
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    if (scale > 6) {
      ctx.strokeStyle = "rgba(255,255,255,0.03)";
      for (let i = 0; i <= size; i++) {
        ctx.beginPath(); ctx.moveTo(i * scale + 0.5, 0); ctx.lineTo(i * scale + 0.5, canvas.height); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i * scale + 0.5); ctx.lineTo(canvas.width, i * scale + 0.5); ctx.stroke();
      }
    }
    prevPixelsRef.current = pixelData.map((row: number[]) => [...row]);
    prevSizeRef.current = size;
    prevDisplayRef.current = canvasDisplaySize;
    prevPaletteRef.current = [...paletteColors];
  }, [pixelData, size, paletteColors, canvasDisplaySize, checkerColors]);

  // Diff-only pixel update
  const drawDiff = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pixelData || !paletteColors || !prevPixelsRef.current) return;
    const ctx = canvas.getContext("2d")!;
    const scale = Math.floor(canvasDisplaySize / size);

    const [cL, cD] = checkerColors();
    for (let y = 0; y < pixelData.length; y++)
      for (let x = 0; x < (pixelData[y]?.length || 0); x++) {
        const newIdx = pixelData[y][x];
        const oldIdx = prevPixelsRef.current[y]?.[x] ?? -1;
        if (newIdx !== oldIdx) {
          ctx.fillStyle = (x + y) % 2 === 0 ? cL : cD;
          ctx.fillRect(x * scale, y * scale, scale, scale);
          if (newIdx >= 0 && newIdx < paletteColors.length) {
            ctx.fillStyle = paletteColors[newIdx];
            ctx.fillRect(x * scale, y * scale, scale, scale);
          }
        }
      }
    prevPixelsRef.current = pixelData.map((row: number[]) => [...row]);
  }, [pixelData, size, paletteColors, canvasDisplaySize, checkerColors]);

  // Render — decides between full and diff
  const prevThemeRef = useRef(studio.theme);
  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const themeChanged = prevThemeRef.current !== studio.theme;
      prevThemeRef.current = studio.theme;
      // Only drawFull resizes the canvas buffer. If the display size changed
      // (zoom, or a fitScale recompute after import/resize) but we ran a diff,
      // the old-size buffer gets stretched → blurry + misaligned painting.
      const displayChanged = prevDisplayRef.current !== canvasDisplaySize;
      const needsFull =
        displayChanged ||
        themeChanged ||   // the checkerboard colours changed under every cell
        shapePreview !== null ||   // redraw the base so the old preview is cleared
        floatPos !== null ||       // ditto for the floating selection
        !prevPixelsRef.current ||
        prevSizeRef.current !== size ||
        !prevPaletteRef.current ||
        prevPaletteRef.current.length !== paletteColors?.length ||
        prevPaletteRef.current.some((c: string, i: number) => c !== paletteColors?.[i]);
      if (needsFull) drawFull(); else drawDiff();
      // Draw the in-progress shape on top — not committed until mouseup.
      if (shapePreview && shapePreview.length && paletteColors) {
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext("2d")!;
          const scale = Math.floor(canvasDisplaySize / size);
          ctx.fillStyle = paletteColors[selectedColorIdx] ?? paletteColors[0] ?? "#ffffff";
          for (const pt of shapePreview) ctx.fillRect(pt.x * scale, pt.y * scale, scale, scale);
        }
      }
      // Draw the floating selection (each cell keeps its own colour).
      if (floatCells.current && floatPos && paletteColors) {
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext("2d")!;
          const sc = Math.floor(canvasDisplaySize / size);
          for (const c of floatCells.current) {
            ctx.fillStyle = paletteColors[c.ci] ?? "#ffffff";
            ctx.fillRect((floatPos.x + c.dx) * sc, (floatPos.y + c.dy) * sc, sc, sc);
          }
        }
      }
    });
    return () => cancelAnimationFrame(rafRef.current);
  }, [pixelData, size, paletteColors, canvasDisplaySize, drawFull, drawDiff, studio.theme, shapePreview, selectedColorIdx, floatPos]);

  // Get pixel coordinates from mouse event
  const getPixel = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = canvasDisplaySize / size;
    const x = Math.floor((e.clientX - rect.left) / scale);
    const y = Math.floor((e.clientY - rect.top) / scale);
    if (x < 0 || x >= size || y < 0 || y >= size) return null;
    return { x, y };
  }, [size, canvasDisplaySize]);

  // Paint one pixel; right button (or the eraser tool) clears it.
  // Every stroke and every shape ends up here, which is why mirroring lives in
  // one function instead of in each tool. Undo, paste and select-move do NOT
  // route through it — reflecting those would corrupt the thing you moved.
  const mirrored = (cells: { x: number; y: number; color: number }[]) => {
    if (!mirrorX && !mirrorY) return cells;
    const seen = new Set<string>();
    const out: typeof cells = [];
    for (const c of cells) {
      // A pixel on the axis maps onto itself; dedupe or it gets written twice.
      const twins = [c, ...(mirrorX ? [{ ...c, x: size - 1 - c.x }] : []),
                        ...(mirrorY ? [{ ...c, y: size - 1 - c.y }] : []),
                        ...(mirrorX && mirrorY ? [{ ...c, x: size - 1 - c.x, y: size - 1 - c.y }] : [])];
      for (const t of twins) {
        const k = `${t.x},${t.y}`;
        if (!seen.has(k)) { seen.add(k); out.push(t); }
      }
    }
    return out;
  };

  const paintAt = (p: { x: number; y: number }, e: React.MouseEvent) => {
    const erase = tool === "eraser" || e.buttons === 2 || e.button === 2;
    // Dither paints a 50% checker: every other cell, leaving the rest as they
    // are. Dragged over an existing fill that is exactly how you blend two
    // colours at this resolution.
    if (tool === "dither" && (p.x + p.y) % 2 !== 0) return;
    studio.setPixels(mirrored([{ x: p.x, y: p.y, color: erase ? -1 : selectedColorIdx }]));
  };

  // One-shot, not a tool: it acts on the whole sprite, there is nothing to drag.
  const addOutline = () => {
    if (!pixelData) return;
    const cells = outlineCells(pixelData, selectedColorIdx);
    if (!cells.length) return;
    pushHistory();
    studio.setPixels(cells);
    void studio.flushPixels();
  };

  // Points of the current shape from its start to `end`. Shift constrains:
  // line → 45° steps, rect/circle → square.
  const computeShape = (end: Pt, shift: boolean): Pt[] => {
    const s = shapeStart.current!;
    let ex = end.x, ey = end.y;
    if (shift) {
      const dx = ex - s.x, dy = ey - s.y;
      if (tool === "line") {
        const adx = Math.abs(dx), ady = Math.abs(dy);
        if (adx > ady * 2) ey = s.y;              // horizontal
        else if (ady > adx * 2) ex = s.x;          // vertical
        else { const m = Math.min(adx, ady); ex = s.x + Math.sign(dx) * m; ey = s.y + Math.sign(dy) * m; }
      } else {
        const m = Math.min(Math.abs(dx), Math.abs(dy)); // square
        ex = s.x + Math.sign(dx) * m; ey = s.y + Math.sign(dy) * m;
      }
    }
    if (tool === "line") return line(s.x, s.y, ex, ey);
    if (tool === "rect") return rectOutline(s.x, s.y, ex, ey);
    return ellipseOutline(s.x, s.y, ex, ey);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    // Hand tool pans the viewport; it never touches pixels.
    if (tool === "hand") {
      const vp = viewportRef.current;
      if (vp) panRef.current = { x: e.clientX, y: e.clientY, sl: vp.scrollLeft, st: vp.scrollTop };
      return;
    }

    const p = getPixel(e);
    if (!p || !pixelData) return;

    if (tool === "eyedropper") {
      const idx = pixelData[p.y]?.[p.x] ?? -1;
      if (idx >= 0) studio.setSelectedColorIdx(idx);
      return;
    }

    if (tool === "select") {
      const inside = selection && p.x >= selection.x && p.x < selection.x + selection.w &&
                     p.y >= selection.y && p.y < selection.y + selection.h;
      if (inside && selection) {
        // Lift the region's pixels and clear the hole — they float until release.
        pushHistory();
        const cells: FloatCell[] = [];
        const clears: { x: number; y: number; color: number }[] = [];
        for (let dy = 0; dy < selection.h; dy++)
          for (let dx = 0; dx < selection.w; dx++) {
            const ci = pixelData[selection.y + dy]?.[selection.x + dx] ?? -1;
            if (ci >= 0) cells.push({ dx, dy, ci });
            clears.push({ x: selection.x + dx, y: selection.y + dy, color: -1 });
          }
        floatCells.current = cells;
        studio.setPixels(clears);
        selDrag.current = { mode: "move", start: p, origin: { x: selection.x, y: selection.y } };
        setFloatPos({ x: selection.x, y: selection.y });
      } else {
        selDrag.current = { mode: "mark", start: p };
        setSelection({ x: p.x, y: p.y, w: 1, h: 1 });
      }
      return;
    }

    if (SHAPE_TOOLS.includes(tool)) {
      // Begin a shape — history + commit happen on release, so Esc can cancel.
      shapeStart.current = p;
      setShapePreview([p]);
      return;
    }

    pushHistory();   // snapshot before the edit, so undo can restore it

    if (tool === "bucket") {
      const erase = e.button === 2;
      studio.setPixels(floodFill(pixelData, p.x, p.y, erase ? -1 : selectedColorIdx));
      return;
    }

    // pencil / eraser — freehand stroke
    setIsPainting(true);
    paintAt(p, e);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    // Panning: scroll the viewport by the drag delta.
    if (panRef.current && viewportRef.current) {
      viewportRef.current.scrollLeft = panRef.current.sl - (e.clientX - panRef.current.x);
      viewportRef.current.scrollTop = panRef.current.st - (e.clientY - panRef.current.y);
      return;
    }

    const p = getPixel(e);
    if (p && pixelData) {
      const idx = pixelData[p.y]?.[p.x] ?? -1;
      const cn = idx >= 0 && paletteColors ? paletteColors[idx] : "empty";
      setPixelInfo(`${p.x},${p.y} [${idx}] ${cn}`);
    }
    if (selDrag.current && p) {
      const d = selDrag.current;
      if (d.mode === "mark") {
        setSelection({
          x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y),
          w: Math.abs(p.x - d.start.x) + 1, h: Math.abs(p.y - d.start.y) + 1,
        });
      } else if (d.origin) {
        setFloatPos({ x: d.origin.x + (p.x - d.start.x), y: d.origin.y + (p.y - d.start.y) });
      }
      return;
    }
    if (shapeStart.current && p) { setShapePreview(computeShape(p, e.shiftKey)); return; }
    if (isPainting && p) paintAt(p, e);
  };

  // Flush on release so a stroke is saved right away, not up to 500ms later
  // (which loses the last edits if the tab closes in that window).
  const handleMouseUp = () => {
    if (panRef.current) { panRef.current = null; return; }
    // Finish a selection drag.
    if (selDrag.current) {
      const d = selDrag.current;
      if (d.mode === "mark") {
        // A plain click (no drag) clears the selection.
        setSelection((s) => (s && s.w <= 1 && s.h <= 1 ? null : s));
      } else if (d.mode === "move" && floatCells.current && floatPos) {
        studio.setPixels(floatCells.current.map((c) => ({ x: floatPos.x + c.dx, y: floatPos.y + c.dy, color: c.ci })));
        setSelection((s) => (s ? { ...s, x: floatPos.x, y: floatPos.y } : s));
        floatCells.current = null;
        setFloatPos(null);
      }
      selDrag.current = null;
      void studio.flushPixels();
      return;
    }
    // Commit a shape if one was being dragged.
    if (shapeStart.current) {
      if (shapePreview && shapePreview.length) {
        pushHistory();
        const erase = tool === "eraser"; // shapes always paint with selected colour
        studio.setPixels(mirrored(shapePreview.map((pt) => ({ ...pt, color: erase ? -1 : selectedColorIdx }))));
      }
      shapeStart.current = null;
      setShapePreview(null);
      void studio.flushPixels();
      return;
    }
    setIsPainting(false);
    void studio.flushPixels();
  };

  // Export — format (png/webp/jpg/svg), integer scale, optional transparency trim.
  const download = (href: string, name: string) => {
    const a = document.createElement("a");
    a.download = name; a.href = href; a.click();
    if (href.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  const exportImage = (format: "png" | "webp" | "jpg" | "svg", scaleMul: number, trim: boolean) => {
    if (!pixelData || !paletteColors) return;
    // Bounding box of non-empty pixels when trimming; the full sprite otherwise.
    let minX = 0, minY = 0, maxX = size - 1, maxY = size - 1;
    if (trim) {
      minX = size; minY = size; maxX = -1; maxY = -1;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if ((pixelData[y]?.[x] ?? -1) >= 0) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      if (maxX < 0) return; // nothing to export
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;

    if (format === "svg") {
      // Each pixel is one <rect> — vectorial, scales forever with crisp edges.
      let rects = "";
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const idx = pixelData[y]?.[x] ?? -1;
        if (idx >= 0 && idx < paletteColors.length)
          rects += `<rect x="${x - minX}" y="${y - minY}" width="1" height="1" fill="${paletteColors[idx]}"/>`;
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scaleMul}" height="${h * scaleMul}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${rects}</svg>`;
      download(URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })), `sprite_${w}x${h}.svg`);
      return;
    }

    const c = document.createElement("canvas");
    c.width = w * scaleMul; c.height = h * scaleMul;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    if (format === "jpg") { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height); } // no alpha in jpg
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const idx = pixelData[y]?.[x] ?? -1;
      if (idx >= 0 && idx < paletteColors.length) {
        ctx.fillStyle = paletteColors[idx];
        ctx.fillRect((x - minX) * scaleMul, (y - minY) * scaleMul, scaleMul, scaleMul);
      }
    }
    const mime = format === "webp" ? "image/webp" : format === "jpg" ? "image/jpeg" : "image/png";
    c.toBlob((blob) => { if (blob) download(URL.createObjectURL(blob), `sprite_${w}x${h}.${format}`); }, mime, 0.95);
  };

  // ── Variants (algorithmic recolour, no LLM) ──
  // Draw the sprite with an arbitrary palette to an offscreen canvas. Shared by
  // the variant previews and their downloads so both look identical.
  const rasterize = useCallback((colors: string[], scaleMul: number): HTMLCanvasElement | null => {
    if (!pixelData) return null;
    const c = document.createElement("canvas");
    c.width = size * scaleMul; c.height = size * scaleMul;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const idx = pixelData[y]?.[x] ?? -1;
      if (idx >= 0 && idx < colors.length) {
        ctx.fillStyle = colors[idx];
        ctx.fillRect(x * scaleMul, y * scaleMul, scaleMul, scaleMul);
      }
    }
    return c;
  }, [pixelData, size]);

  // The recoloured palettes for the chosen harmony (first = untouched base).
  const variants = useMemo(
    () => (paletteColors ? paletteVariants(paletteColors, variantHarmony) : []),
    [paletteColors, variantHarmony],
  );
  // Preview thumbnails as data URLs. `rasterize` depends on pixelData, so without
  // the exportOpen gate this re-encoded up to 21 PNGs on every painted pixel — with
  // the dialog closed. That was the canvas lag.
  const variantThumbs = useMemo(() => {
    if (!exportOpen) return [];
    const s = Math.max(2, Math.min(8, Math.floor(128 / size)));
    return variants.map((v) => rasterize(v.colors, s)?.toDataURL() ?? "");
  }, [exportOpen, variants, rasterize, size]);

  // Lightbox keyboard: Esc closes, ←/→ step through the current set.
  useEffect(() => {
    zoomRef.current = !!zoom;
    if (!zoom) return;
    const count = zoom.kind === "variant" ? variants.length : (studio.tilesetPreview?.files.length ?? 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setZoom(null); }
      else if (e.key === "ArrowLeft" && count) { e.preventDefault(); setZoom((z) => z && { ...z, index: (z.index - 1 + count) % count }); }
      else if (e.key === "ArrowRight" && count) { e.preventDefault(); setZoom((z) => z && { ...z, index: (z.index + 1) % count }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom, variants.length, studio.tilesetPreview]);

  // Esc closes the export dialog — unless the zoom lightbox is on top of it, in
  // which case Esc belongs to the lightbox (handled above).
  useEffect(() => {
    exportOpenRef.current = exportOpen;
    if (!exportOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !zoomRef.current) { e.preventDefault(); setExportOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exportOpen]);

  const canvasToBlob = (c: HTMLCanvasElement) =>
    new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
  // Filesystem-safe slug for a variant label (°, arrows → underscores).
  const safe = (s: string) => s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || "base";

  const downloadVariant = async (v: { label: string; colors: string[] }) => {
    const c = rasterize(v.colors, exportScale);
    if (!c) return;
    const b = await canvasToBlob(c);
    if (b) download(URL.createObjectURL(b), `sprite_${size}x${size}_${safe(v.label)}.png`);
  };
  // All variants in one .zip (built in the browser, no server round-trip).
  const downloadAllVariants = async () => {
    const files: { name: string; blob: Blob }[] = [];
    for (const v of variants) {
      const c = rasterize(v.colors, exportScale);
      const b = c && (await canvasToBlob(c));
      if (b) files.push({ name: `${size}x${size}_${safe(v.label)}.png`, blob: b });
    }
    if (files.length) download(URL.createObjectURL(await zipBlobs(files)), `variants_${variantHarmony}.zip`);
  };

  // Tileset downloads (files live on the server; fetch each as a blob).
  const fetchBlob = (url: string) => fetch(url).then((r) => r.blob());
  const downloadTile = async (name: string, file: string) =>
    download(URL.createObjectURL(await fetchBlob(tilesetUrl(name, file))), file);
  const downloadTilesetZip = async () => {
    const p = studio.tilesetPreview;
    if (!p) return;
    const files = await Promise.all(p.files.map(async (f) => ({ name: f, blob: await fetchBlob(tilesetUrl(p.name, f)) })));
    download(URL.createObjectURL(await zipBlobs(files)), `${p.name}.zip`);
  };

  // Pick a file (from the picker or a drop) — just stage it; the preview effect
  // does the pixelating so the size can be changed and re-previewed freely.
  const pickImport = (file: File) => {
    // Don't gate on MIME — dropped files often have an empty or wrong type, and
    // the decoder tries hard to read it anyway. A real failure surfaces below.
    setImportErr("");
    setImportOrig((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
    setImportFile(file);
  };
  const resetImport = () => {
    setImportOrig((prev) => { if (prev) URL.revokeObjectURL(prev); return ""; });
    setImportFile(null); setImportData(null); setImportPreview(""); setImportErr("");
  };

  // Re-pixelate whenever the file or size changes; render a scaled-up preview.
  useEffect(() => {
    if (!importFile) { setImportData(null); setImportPreview(""); return; }
    let cancelled = false;
    (async () => {
      try {
        const d = await imageToSprite(importFile, importSize);
        if (cancelled) return;
        const n = d.pixels.length;
        const s = Math.max(1, Math.round(224 / n));
        const c = document.createElement("canvas");
        c.width = n * s; c.height = n * s;
        const ctx = c.getContext("2d")!;
        ctx.imageSmoothingEnabled = false;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          const i = d.pixels[y][x];
          if (i >= 0) { ctx.fillStyle = d.colors[i]; ctx.fillRect(x * s, y * s, s, s); }
        }
        setImportData(d);
        setImportPreview(c.toDataURL());
      } catch {
        if (!cancelled) { setImportErr(t("importFailed")); setImportData(null); setImportPreview(""); }
      }
    })();
    return () => { cancelled = true; };
  }, [importFile, importSize, t]);

  // Commit the previewed sprite to history and open it, ready to edit.
  const confirmImport = async () => {
    if (!importFile) return;
    setImportBusy(true); setImportErr("");
    try {
      // Recompute from the file at the CURRENT size so size and pixels always
      // match — never trust the preview, which may lag a rapid size change.
      const { colors, pixels } = await imageToSprite(importFile, importSize);
      await studio.importSprite(importSize, colors, pixels);
      setImportOpen(false);
      resetImport();
    } catch (e: any) {
      setImportErr(e.message || t("importFailed"));
    }
    setImportBusy(false);
  };

  // Tileset — the name is derived automatically from the sprite (prompt slug +
  // id), so the user never has to invent one.
  const autoTilesetName = () => {
    const slug = (studio.currentGen?.prompt || "tile")
      .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "tile";
    return `${slug}_${studio.currentGen?.id ?? Date.now()}`;
  };
  const genTileset = async () => {
    if (!studio.currentGen || !pixelData || tilesetBusy) return;
    setTilesetBusy(true); setTilesetErr("");
    try {
      const name = autoTilesetName();
      const res = await api<{ name: string; files: string[] }>("/tileset", {
        method: "POST",
        body: JSON.stringify({ generation_id: studio.currentGen.id, name }),
      });
      studio.setTilesetPreview({ name, files: res.files });
    } catch (e: any) {
      setTilesetErr(e.message);
    } finally {
      setTilesetBusy(false);
    }
  };

  // Chat
  const handleChat = async () => {
    if (!chatMsg.trim()) return;
    const msg = chatMsg.trim();
    setChatMsg("");
    await studio.sendChat(msg);
  };

  // Zoom in steps of one screen-pixel-per-sprite-pixel, pixel-perfect always.
  // Cap well above any fit scale (an 8×8 fits at ~90) so zooming in never clamps
  // *below* the current fit and shrinks the sprite — that was the "bug".
  const zoomIn = () => setUserScale((s) => Math.min(128, (s ?? fitScale) + 2));
  const zoomOut = () => setUserScale((s) => Math.max(1, (s ?? fitScale) - 2));
  const zoomFit = () => setUserScale(null);

  const toolBtn = (id: Tool, labelKey: Parameters<typeof t>[0]) => (
    <button
      key={id}
      aria-label={t(labelKey)}
      aria-pressed={tool === id}
      data-tip={t(labelKey)} data-tip-side="right"
      onClick={() => setTool(id)}
      className="icon-btn"
      style={{
        width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center",
        color: tool === id ? "var(--bg)" : "var(--text-dim)",
        background: tool === id ? "var(--accent)" : "var(--surface)",
        borderColor: tool === id ? "var(--accent)" : "var(--border)",
      }}
    >
      <PixelIcon name={id} size={17} />
    </button>
  );

  return (
    <div
      ref={containerRef}
      className="flex-1 flex flex-col overflow-hidden relative"
      style={{ minWidth: 0, background: "var(--bg)" }}
    >
      {/* Subtle dot grid background */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(circle, var(--border) 0.5px, transparent 0.5px)",
          backgroundSize: "24px 24px",
          opacity: 0.4,
        }}
      />

      {/* Empty-canvas invitation — turns the blank artboard into a prompt to act.
          Sits above the canvas but ignores the pointer so drawing still works. */}
      {isEmptyCanvas && !studio.isGenerating && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none" style={{ paddingLeft: 44 }}>
          {/* Without a sprite there is nothing to draw on — strokes would land
              nowhere. Say that, instead of inviting a stroke the app can't keep. */}
          <div style={{ textAlign: "center", maxWidth: 320 }}>
            <div style={{ fontSize: 16, color: "var(--text-dim)", marginBottom: 8 }}>
              {studio.activeGenId ? t("emptyTitle") : t("noSpriteTitle")}
            </div>
            <div style={{ fontSize: "var(--t-small)", color: "var(--text-faint)", lineHeight: 1.7, marginBottom: 18 }}>
              {studio.activeGenId ? t("emptyHint") : t("noSpriteHint")}
            </div>
            <div className="mono" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: "var(--t-micro)", color: "var(--text-dim)" }}>
              {(!studio.activeGenId ? [] : [["B", "toolPencil"], ["G", "toolBucket"], ["M", "toolSelect"]] as [string, Parameters<typeof t>[0]][]).map(([key, lbl], i) => (
                <span key={key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {i > 0 && <span style={{ width: 1, height: 12, background: "var(--border)" }} />}
                  <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 18, height: 18, padding: "0 4px", border: "1px solid var(--border-hover)", background: "var(--surface)", color: "var(--text-dim)" }}>{key}</span>
                  {t(lbl)}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center w-full flex-1 min-h-0">

        {/* ── Command band ──
            View controls left (they act on what you're looking at), file I/O
            pinned right (it acts on the file). Grouping is 2px inside a group
            and 16px between, so the eye parses three controls, not nine. */}
        <div className="band w-full" style={{ order: -2, gap: 16 }}>
          {/* Prominent STOP while generating — cancels the agent so it stops
              spending tokens, and keeps whatever's painted so far. */}
          {studio.isGenerating && (
            <button
              onClick={studio.skipAndFinalize}
              className="mono"
              style={{
                display: "flex", alignItems: "center", gap: 6, height: 22, padding: "0 10px",
                background: "var(--danger)", color: "#fff", border: "none", cursor: "pointer",
                fontSize: "var(--t-micro)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600,
              }}
            >
              <PixelIcon name="stop" size={11} /> {t("stop")}
            </button>
          )}

          <span className="mono" style={{
            display: "inline-flex", alignItems: "center", height: 20, padding: "0 6px",
            background: "var(--surface-hover)", border: "1px solid var(--border)",
            fontSize: "var(--t-small)", color: "var(--text)",
          }}>
            {size}×{size}
          </span>

          <div className="flex items-center" style={{ gap: 2 }}>
            <button className="icon-btn" onClick={undo} disabled={!canUndo} aria-label={t("undo")} data-tip={t("undo")}
              style={{ padding: "4px 5px" }}>
              <PixelIcon name="undo" size={15} />
            </button>
            <button className="icon-btn" onClick={redo} disabled={!canRedo} aria-label={t("redo")} data-tip={t("redo")}
              style={{ padding: "4px 5px" }}>
              <PixelIcon name="redo" size={15} />
            </button>
          </div>

          {/* Zoom is one welded control: − readout + , then the fit reset. The
              readout shows pixels-per-pixel (×42), which is what `scale` really
              is — rendering it as 4200% made a correct number look like a bug. */}
          <div className="flex items-center" style={{ gap: 2 }}>
            <button className="icon-btn" onClick={zoomOut} aria-label={t("zoomOut")} data-tip={t("zoomOut")} style={{ padding: "4px 5px" }}>
              <PixelIcon name="zoomOut" size={15} />
            </button>
            <span className="zoom-readout" data-tip={t("zoom")}>×{scale}</span>
            <button className="icon-btn" onClick={zoomIn} aria-label={t("zoomIn")} data-tip={t("zoomIn")} style={{ padding: "4px 5px" }}>
              <PixelIcon name="zoomIn" size={15} />
            </button>
            <button className="btn" onClick={zoomFit} data-tip={t("zoomFit")} style={{ marginLeft: 2, height: 22, padding: "0 10px" }}>
              {t("zoomFit")}
            </button>
          </div>

          {/* The gap in the middle of the band had nothing in it, and the one
              fact you can't see anywhere on the artboard is which engine is
              about to paint. It sits between the view controls and the file
              actions because it belongs to neither. */}
          <span
            className="mono"
            style={{
              flex: 1, minWidth: 0, textAlign: "center",
              fontSize: "var(--t-micro)", color: "var(--text-faint)",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}
            title={studio.model || studio.settings?.default_model || ""}
          >
            {(studio.model || studio.settings?.default_model)
              ? `${(studio.model || studio.settings!.default_model!).split("/").slice(1).join("/")} · ${
                  t(studio.quality === "draft" ? "qualityDraft"
                    : studio.quality === "high" ? "qualityHigh"
                    : studio.quality === "max" ? "qualityMax" : "qualityNormal")}`
              : t("statusNoProvider")}
          </span>

          <div className="flex items-center" style={{ gap: 6 }}>
            <button className="btn" onClick={() => { setImportSize(size); resetImport(); setImportOpen(true); }}
              style={{ display: "flex", alignItems: "center", gap: 6, height: 22, padding: "0 10px" }}>
              <PixelIcon name="upload" size={12} /> {t("import")}
            </button>
            {/* The one accented control up here: exporting is what you came to do. */}
            <button className="btn" onClick={() => setExportOpen(true)}
              style={{ display: "flex", alignItems: "center", gap: 6, height: 22, padding: "0 10px", borderColor: "var(--accent)", color: "var(--accent)" }}>
              <PixelIcon name="download" size={12} /> {t("export")}
            </button>
          </div>
        </div>

        {/* Tool rail (pinned left) + canvas (centred in the rest) */}
        <div className="flex items-start gap-2 w-full flex-1 min-h-0 pl-2">
          <div className="flex flex-col gap-1 shrink-0">
            {toolBtn("pencil", "toolPencil")}
            {toolBtn("eraser", "toolEraser")}
            {toolBtn("bucket", "toolBucket")}
            {toolBtn("eyedropper", "toolEyedropper")}
            {toolBtn("dither", "toolDither")}
            <div style={{ height: 1, background: "var(--border)", margin: "3px 2px" }} />
            {toolBtn("line", "toolLine")}
            {toolBtn("rect", "toolRect")}
            {toolBtn("circle", "toolCircle")}
            <div style={{ height: 1, background: "var(--border)", margin: "3px 2px" }} />
            {toolBtn("select", "toolSelect")}
            {toolBtn("hand", "toolHand")}

            {/* Below the rule: state you toggle and one action, not tools you
                select. Same column because they belong to drawing, separated
                because they behave differently. */}
            <div style={{ height: 1, background: "var(--border)", margin: "3px 2px" }} />
            <button
              className="icon-btn"
              aria-label={t("mirrorX")}
              aria-pressed={mirrorX}
              data-tip={t("mirrorX")} data-tip-side="right"
              onClick={() => setMirrorX((v) => !v)}
              style={{
                width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center",
                color: mirrorX ? "var(--bg)" : "var(--text-dim)",
                background: mirrorX ? "var(--accent)" : "var(--surface)",
                borderColor: mirrorX ? "var(--accent)" : "var(--border)",
              }}
            >
              <PixelIcon name="mirror" size={17} />
            </button>
            <button
              className="icon-btn"
              aria-label={t("mirrorY")}
              aria-pressed={mirrorY}
              data-tip={t("mirrorY")} data-tip-side="right"
              onClick={() => setMirrorY((v) => !v)}
              style={{
                width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center",
                color: mirrorY ? "var(--bg)" : "var(--text-dim)",
                background: mirrorY ? "var(--accent)" : "var(--surface)",
                borderColor: mirrorY ? "var(--accent)" : "var(--border)",
                transform: "rotate(90deg)",
              }}
            >
              <PixelIcon name="mirror" size={17} />
            </button>
            <button
              className="icon-btn"
              aria-label={t("outline")}
              data-tip={t("outline")} data-tip-side="right"
              onClick={addOutline}
              disabled={isEmptyCanvas}
              style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <PixelIcon name="outline" size={17} />
            </button>
          </div>

          {/* Fixed-size viewport: the canvas zooms and scrolls inside it, so it
              never pushes the toolbars — they stay put. margin:auto centres the
              sprite when it fits and lets you scroll to it when it doesn't. */}
          <div className="flex-1 flex justify-center min-w-0">
          <div ref={viewportRef} style={{ overflow: "auto", width: avail.w, height: avail.h, display: "flex" }}>
            <div style={{ margin: "auto", flexShrink: 0, position: "relative", width: canvasDisplaySize, height: canvasDisplaySize }}>
              <motion.canvas
                ref={canvasRef}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
                style={{
                  imageRendering: "pixelated",
                  width: canvasDisplaySize,
                  height: canvasDisplaySize,
                  border: "1px solid var(--border)",
                  cursor: tool === "hand" ? (panRef.current ? "grabbing" : "grab") : tool === "eyedropper" ? "copy" : "crosshair",
                  display: "block",
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={() => { setIsPainting(false); panRef.current = null; }}
                onContextMenu={(e) => e.preventDefault()}
              />
              {/* Selection marquee — follows the floating block while moving. */}
              {tool === "select" && selection && (
                <div
                  style={{
                    position: "absolute", pointerEvents: "none",
                    left: (floatPos ? floatPos.x : selection.x) * scale,
                    top: (floatPos ? floatPos.y : selection.y) * scale,
                    width: selection.w * scale,
                    height: selection.h * scale,
                    border: "1.5px dashed var(--accent)",
                    boxShadow: "0 0 0 1px rgba(0,0,0,0.45)",
                  }}
                />
              )}
            </div>
          </div>
          </div>
        </div>

        {/* ── Context rail ──
            Nothing in here is clickable: live state on the left, reference on
            the right. The keys are drawn as keys, which you scan; the sentence
            they replaced had to be read. */}
        <div className="rail w-full" style={{ order: -1, marginBottom: 12 }}>
          <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-dim)" }}>{pixelInfo || "\u00a0"}</span>
          <span className="flex items-center" style={{ gap: 5 }}>
            {([
              [["B", "E", "G", "I"], "hintDraw"],
              [["L", "R", "C"], "hintShapes"],
              // Spelled out, not \u21e7/\u2318: Pixelify Sans is a pixel face with no
              // glyph for either, so they rendered as tofu. Real keycaps say
              // "shift" anyway \u2014 the symbol was never the clearer option.
              [["SHIFT"], "hintStraight"],
              [["CMD", "Z"], "undo"],
            ] as [string[], Parameters<typeof t>[0]][]).map(([keys, label], i) => (
              <span key={label} className="flex items-center" style={{ gap: 5 }}>
                {i > 0 && <span style={{ width: 1, height: 12, background: "var(--border)" }} />}
                {keys.map((k) => <span key={k} className="keycap">{k}</span>)}
                {t(label)}
              </span>
            ))}
          </span>
        </div>

        {/* Chat input (visible after generation completes) */}
        <AnimatePresence>
          {status.type === "complete" && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="flex gap-1 mt-3"
              style={{ width: Math.min(canvasDisplaySize, 520) }}
            >
              <input
                type="text"
                value={chatMsg}
                onChange={(e) => setChatMsg(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleChat()}
                placeholder={t("chatPlaceholder")}
                disabled={studio.isGenerating}
                style={{ flex: 1 }}
              />
              <button className="btn" onClick={handleChat} disabled={studio.isGenerating}>{t("send")}</button>
            </motion.div>
          )}
        </AnimatePresence>

      </div>

      {/* ── Export dialog ── */}
      {exportOpen && (() => {
        const isBlock = studio.settings?.sprite_types?.[
          studio.generations.find((g) => g.id === studio.activeGenId)?.sprite_type ?? "block"
        ]?.has_tileset;
        return (
          <div className="overlay" onClick={() => setExportOpen(false)}>
            <div
              className="dialog"
              onClick={(e) => e.stopPropagation()}
              style={{ width: 360, maxWidth: "92vw", height: 620, minWidth: 300, minHeight: 320, maxHeight: "90vh", resize: "both", overflow: "auto" }}
            >
              <div className="dialog-head">
                <span className="mono" style={{ fontSize: "var(--t-small)", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
                  <PixelIcon name="download" size={13} /> {t("export")}
                </span>
                <button className="icon-btn" onClick={() => setExportOpen(false)} aria-label={t("close")} style={{ display: "flex" }}>
                  <PixelIcon name="close" size={13} />
                </button>
              </div>
              <div className="dialog-body">
                <div className="panel-section">
                  <div className="label">{t("format")}</div>
                  {/* These four labels were hardcoded Spanish in an app that
                      ships nine languages — a German user read them in Spanish. */}
                  <select
                    value={exportFormat}
                    aria-label={t("format")}
                    onChange={(e) => setExportFormat(e.target.value as typeof exportFormat)}
                  >
                    {([["png", "fmtPng"], ["webp", "fmtWebp"], ["svg", "fmtSvg"], ["jpg", "fmtJpg"]] as const).map(
                      ([v, k]) => <option key={v} value={v}>{t(k)}</option>,
                    )}
                  </select>

                  <div className="label" style={{ marginTop: 12 }}>{t("scaleLabel")}</div>
                  <div className="segmented">
                    {[1, 2, 4, 8, 16, 32].map((n) => (
                      <button key={n} aria-pressed={exportScale === n} onClick={() => setExportScale(n)}>{n}x</button>
                    ))}
                  </div>
                  <div className="mono" style={{ fontSize: "var(--t-micro)", color: "var(--text-dim)", marginTop: 6 }}>
                    {size}×{size} → <span style={{ color: "var(--text)" }}>{size * exportScale}×{size * exportScale} px</span>
                    {exportFormat === "svg" ? ` · ${t("fmtVector")}` : ` · ${t("fmtNearest")}`}
                  </div>

                  {/* A real checkbox under the painted one: it was a <label> with
                      a <span> drawn to look checked — no input, no role, no way to
                      reach or toggle it from the keyboard. The input is visually
                      hidden but still focusable, and the box mirrors :checked. */}
                  <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={exportTrim}
                      onChange={(e) => setExportTrim(e.target.checked)}
                      style={{ position: "absolute", opacity: 0, width: 14, height: 14, margin: 0, cursor: "pointer" }}
                    />
                    <span aria-hidden="true" style={{
                      width: 14, height: 14, flexShrink: 0, border: "1px solid var(--accent)",
                      background: exportTrim ? "var(--accent)" : "transparent",
                      color: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {exportTrim && <PixelIcon name="check" size={10} />}
                    </span>
                    <span style={{ fontSize: "var(--t-small)" }}>
                      {t("trimTransparency")} <span style={{ color: "var(--text-faint)" }}>{t("trimHint")}</span>
                    </span>
                  </label>

                  <button
                    className="btn btn-primary w-full mt-3"
                    onClick={() => { exportImage(exportFormat, exportScale, exportTrim); setExportOpen(false); }}
                  >
                    {t("export")} {exportFormat.toUpperCase()}
                  </button>
                </div>

                <div className="panel-section">
                  <div className="label">{t("extras")}</div>
                  {isBlock && (
                    <div className="segmented" style={{ marginBottom: 12 }}>
                      <button aria-pressed={extrasTab === "tileset"} onClick={() => setExtrasTab("tileset")}>{t("tilesetTab")}</button>
                      <button aria-pressed={extrasTab === "variantes"} onClick={() => setExtrasTab("variantes")}>{t("variantsTab")}</button>
                    </div>
                  )}

                  {isBlock && extrasTab === "tileset" ? (
                    <>
                      <p style={{ fontSize: "var(--t-micro)", color: "var(--text-dim)", marginBottom: 10, lineHeight: 1.5 }}>
                        {t("tilesetExplain")}
                      </p>
                      <button className="btn btn-primary w-full" disabled={tilesetBusy} onClick={genTileset}>
                        {tilesetBusy ? t("buildingTileset") : t("generateTileset")}
                      </button>
                      {tilesetErr && (
                        <div className="mono" style={{ fontSize: "var(--t-micro)", color: "var(--danger)", marginTop: 6 }}>
                          {tilesetErr}
                        </div>
                      )}
                      {studio.tilesetPreview && (
                        <>
                          <div className="mono" style={{ fontSize: "var(--t-micro)", color: "var(--text-faint)", marginTop: 10, marginBottom: 6 }}>
                            {studio.tilesetPreview.name} · {t("tilesetClickHint")}
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                            {studio.tilesetPreview.files.map((f, ti) => {
                              const mask = Number(f.split("_").pop()?.replace(".png", "")) || 0;
                              const sides = ([[1, "N"], [2, "E"], [4, "S"], [8, "W"]] as [number, string][])
                                .filter(([bit]) => mask & bit).map(([, s]) => s).join("") || "·";
                              return (
                                <div key={f} className="text-center">
                                  <button
                                    className="group"
                                    onClick={() => setZoom({ kind: "tile", index: ti })}
                                    title={`${sides} · ${t("zoom")}`}
                                    style={{ position: "relative", padding: 0, width: "100%", aspectRatio: "1", border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer", lineHeight: 0, display: "block" }}
                                  >
                                    <img
                                      src={tilesetUrl(studio.tilesetPreview!.name, f)}
                                      alt={f}
                                      style={{ width: "100%", height: "100%", imageRendering: "pixelated", display: "block" }}
                                    />
                                    <span
                                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                                      onClick={(e) => { e.stopPropagation(); downloadTile(studio.tilesetPreview!.name, f); }}
                                      style={{ position: "absolute", top: 2, right: 2, color: "var(--accent)", background: "var(--bg)", display: "flex", padding: 1 }}
                                    >
                                      <PixelIcon name="download" size={10} />
                                    </span>
                                  </button>
                                  <div className="mono" style={{ fontSize: "8px", color: "var(--text-faint)", marginTop: 1 }}>{sides}</div>
                                </div>
                              );
                            })}
                          </div>
                          <button className="btn w-full mt-3" onClick={downloadTilesetZip}>{t("downloadAll")}</button>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <p style={{ fontSize: "var(--t-micro)", color: "var(--text-dim)", marginBottom: 10, lineHeight: 1.5 }}>
                        {t("variantsExplain")}
                      </p>
                      {/* Harmony chips — same idiom as the palette panel */}
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5, marginBottom: 12 }}>
                        {(Object.keys(HARMONY_LABELS) as HarmonyType[]).map((k) => (
                          <button
                            key={k}
                            className="mono"
                            aria-pressed={variantHarmony === k}
                            onClick={() => setVariantHarmony(k)}
                            style={{
                              fontSize: "var(--t-micro)", padding: "5px 4px", cursor: "pointer",
                              textTransform: "lowercase", letterSpacing: "0.02em",
                              border: `1px solid ${variantHarmony === k ? "var(--accent)" : "var(--border)"}`,
                              background: variantHarmony === k ? "var(--accent-dim)" : "var(--surface)",
                              color: variantHarmony === k ? "var(--accent)" : "var(--text-dim)",
                            }}
                          >
                            {HARMONY_LABELS[k]}
                          </button>
                        ))}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                        {variants.map((v, i) => (
                          <button
                            key={v.label + i}
                            className="group"
                            onClick={() => setZoom({ kind: "variant", index: i })}
                            title={`${v.label} · ${t("zoom")}`}
                            style={{ position: "relative", padding: 0, background: "var(--surface)", border: `1px solid ${i === 0 ? "var(--accent)" : "var(--border)"}`, cursor: "pointer", lineHeight: 0 }}
                          >
                            {i === 0 && (
                              <span style={{ position: "absolute", top: 2, left: 2, zIndex: 1, fontSize: "7px", letterSpacing: "0.1em", textTransform: "uppercase", background: "var(--accent)", color: "var(--bg)", padding: "1px 3px" }}>base</span>
                            )}
                            <span
                              className="opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={(e) => { e.stopPropagation(); downloadVariant(v); }}
                              style={{ position: "absolute", top: 3, right: 3, zIndex: 1, color: "var(--accent)", background: "var(--bg)", display: "flex", padding: 1 }}
                            >
                              <PixelIcon name="download" size={11} />
                            </span>
                            <img src={variantThumbs[i]} alt={v.label} style={{ width: "100%", aspectRatio: "1", imageRendering: "pixelated", display: "block", background: "var(--bg)" }} />
                          </button>
                        ))}
                      </div>
                      <button className="btn w-full mt-3" onClick={downloadAllVariants}>{t("downloadAll")}</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Import image dialog ── */}
      {importOpen && (
        <div className="overlay" onClick={() => { if (!importBusy) setImportOpen(false); }}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
            <div className="dialog-head">
              <span className="mono" style={{ fontSize: "var(--t-small)", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
                <PixelIcon name="upload" size={13} /> {t("importTitle")}
              </span>
              <button className="icon-btn" onClick={() => setImportOpen(false)} aria-label={t("close")} style={{ display: "flex" }}>
                <PixelIcon name="close" size={13} />
              </button>
            </div>
            <div className="dialog-body">
              <div className="panel-section">
                <div className="label">{t("size")}</div>
                <div className="segmented">
                  {[8, 16, 32, 64].map((n) => (
                    <button key={n} aria-pressed={importSize === n} disabled={importBusy} onClick={() => setImportSize(n)}>{n}</button>
                  ))}
                </div>

                {!importFile ? (
                  <>
                    <p style={{ fontSize: "var(--t-micro)", color: "var(--text-dim)", lineHeight: 1.5, marginTop: 10 }}>
                      {t("importHint")}
                    </p>
                    <div
                      onClick={() => importFileRef.current?.click()}
                      onDragOver={(e) => { e.preventDefault(); setImportDrag(true); }}
                      onDragLeave={() => setImportDrag(false)}
                      onDrop={(e) => { e.preventDefault(); setImportDrag(false); const f = e.dataTransfer.files?.[0]; if (f) pickImport(f); }}
                      style={{
                        marginTop: 12, padding: "28px 16px", textAlign: "center",
                        border: `1px dashed ${importDrag ? "var(--accent)" : "var(--border-hover)"}`,
                        background: importDrag ? "var(--accent-dim)" : "var(--surface)",
                        color: "var(--text-dim)", cursor: "pointer",
                      }}
                    >
                      <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                        <PixelIcon name="upload" size={22} />
                        <span style={{ fontSize: "var(--t-small)" }}>
                          {t("dropImage")} <span style={{ color: "var(--accent)" }}>{t("chooseImage")}</span>
                        </span>
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Preview: original → pixelated result at the chosen size. */}
                    <div style={{ display: "flex", gap: 12, marginTop: 12, alignItems: "center", justifyContent: "center" }}>
                      {importOrig && (
                        <img src={importOrig} alt="original" style={{ width: 104, height: 104, objectFit: "contain", border: "1px solid var(--border)", background: "var(--surface)" }} />
                      )}
                      <span style={{ color: "var(--text-faint)", display: "flex" }}><PixelIcon name="arrowRight" size={14} /></span>
                      {importPreview ? (
                        <img src={importPreview} alt="preview" style={{ width: 104, height: 104, imageRendering: "pixelated", objectFit: "contain", border: "1px solid var(--accent)", background: "var(--surface)" }} />
                      ) : (
                        <div style={{ width: 104, height: 104, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--border)" }}>
                          <span className="mono" style={{ fontSize: "var(--t-micro)", color: "var(--text-faint)" }}>{t("importing")}</span>
                        </div>
                      )}
                    </div>
                    <div className="mono" style={{ textAlign: "center", marginTop: 8, fontSize: "var(--t-micro)", color: "var(--text-faint)" }}>
                      {importSize}×{importSize}{importData ? ` · ${importData.colors.length} ${t("colorsWord")}` : ""}
                    </div>
                    <div className="flex gap-1 mt-3">
                      <button className="btn flex-1" disabled={importBusy} onClick={() => importFileRef.current?.click()}>{t("chooseImage")}</button>
                      <button className="btn btn-primary flex-1" disabled={importBusy || !importFile} onClick={confirmImport}>
                        {importBusy ? t("importing") : t("import")}
                      </button>
                    </div>
                  </>
                )}

                <input
                  ref={importFileRef}
                  type="file"
                  accept="image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,.avif"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) pickImport(f); e.target.value = ""; }}
                />
                {importErr && (
                  <div className="mono" style={{ fontSize: "var(--t-micro)", color: "var(--danger)", marginTop: 8 }}>{importErr}</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Zoom lightbox (shared by tiles + variants) ── */}
      {zoom && (() => {
        const isTile = zoom.kind === "tile";
        const tp = studio.tilesetPreview;
        const count = isTile ? (tp?.files.length ?? 0) : variants.length;
        if (!count) return null;
        const idx = Math.min(zoom.index, count - 1);
        let src = "", label = "", doDownload = () => {};
        if (isTile && tp) {
          const f = tp.files[idx];
          const mask = Number(f.split("_").pop()?.replace(".png", "")) || 0;
          const sides = ([[1, "N"], [2, "E"], [4, "S"], [8, "W"]] as [number, string][])
            .filter(([bit]) => mask & bit).map(([, s]) => s).join("") || "·";
          src = tilesetUrl(tp.name, f); label = `tile · ${sides}`; doDownload = () => downloadTile(tp.name, f);
        } else {
          const v = variants[idx]; src = variantThumbs[idx]; label = v.label; doDownload = () => downloadVariant(v);
        }
        const step = (d: number) => setZoom((z) => z && { ...z, index: (idx + d + count) % count });
        const navBtn = (d: number, rot: boolean) => (
          <button className="icon-btn" onClick={() => step(d)} aria-label={d < 0 ? "prev" : "next"} style={{ display: "flex", padding: "6px 7px" }}>
            <span style={{ display: "flex", transform: rot ? "rotate(180deg)" : "none" }}><PixelIcon name="chevronRight" size={14} /></span>
          </button>
        );
        return (
          <div className="overlay" onClick={() => setZoom(null)} style={{ zIndex: 60 }}>
            <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ width: "auto", maxWidth: "92vw", maxHeight: "92vh" }}>
              <div className="dialog-head">
                <span className="mono" style={{ fontSize: "var(--t-small)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {label} <span style={{ color: "var(--text-faint)" }}>· {idx + 1}/{count}</span>
                </span>
                <button className="icon-btn" onClick={() => setZoom(null)} aria-label={t("close")} style={{ display: "flex" }}>
                  <PixelIcon name="close" size={13} />
                </button>
              </div>
              <div style={{ padding: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {count > 1 && navBtn(-1, true)}
                  <img
                    src={src}
                    alt={label}
                    style={{ width: "min(64vh, 400px)", height: "min(64vh, 400px)", imageRendering: "pixelated", border: "1px solid var(--border)", background: "var(--surface)" }}
                  />
                  {count > 1 && navBtn(1, false)}
                </div>
                <button
                  className="btn btn-primary w-full"
                  onClick={doDownload}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
                >
                  <PixelIcon name="download" size={12} /> {t("download")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
