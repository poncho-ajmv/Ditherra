"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { api, apiRaw, streamSSE, API_BASE } from "@/lib/api";
import { detectLang, translator, type Lang } from "@/lib/i18n";
import type { Palette, Generation, Settings } from "@/lib/types";

type Theme = "dark" | "light";

export const DEFAULT_PANEL = 280;
export const DEFAULT_SIDEBAR = 300;

// The agent renders each palette colour as one character (0-9, A-Z, a-z) when
// it "reads" the canvas — 62 distinct symbols. 50 stays inside that so the agent
// can still tell every colour apart, and the palette rotates (carousel) rather
// than blocking once full.
export const MAX_PALETTE_COLORS = 50;

// The ceiling applied when "cost matters" is on. High enough that a real sprite
// never reaches it — it exists to end a model stuck in a loop, not a sprite that
// is still getting better. Mirrors RUNAWAY_CEILING in agent.py.
export const RUNAWAY_CEILING = 500;

const sameColors = (a: string[], b: string[]) => a.length === b.length && a.every((c, i) => c === b[i]);

export function useStudio() {
  // Settings
  const [settings, setSettings] = useState<Settings | null>(null);
  // Set when the initial load fails, so the app can show an error + retry instead
  // of hanging on "connecting..." forever when the backend is down.
  const [initError, setInitError] = useState<string | null>(null);

  // ── Preferences ──
  // Read on mount rather than at init so the server-rendered HTML and the first
  // client render agree; localStorage doesn't exist during the static export.
  const [theme, setThemeState] = useState<Theme>("dark");
  const [lang, setLangState] = useState<Lang>("en");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // "Does cost matter?" — the only thing it decides is whether a run gets a step
  // ceiling. Off means the agent stops when it is satisfied or when you press
  // STOP, and nothing else. Default on, because the safe default is the one that
  // can't spend your money while you're asleep.
  const [costMatters, setCostMattersState] = useState(true);
  const [panelWidth, setPanelWidthState] = useState(DEFAULT_PANEL);
  const [sidebarWidth, setSidebarWidthState] = useState(DEFAULT_SIDEBAR);

  // localStorage doesn't exist during the static export, so preferences can't be
  // read in a useState initialiser — this is what effects are for. Costs one
  // extra render on mount; the inline script in layout.tsx prevents the flash.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const savedTheme = localStorage.getItem("ditherra.theme") as Theme | null;
    const savedLang = localStorage.getItem("ditherra.lang") as Lang | null;
    if (savedTheme) {
      setThemeState(savedTheme);
      document.documentElement.dataset.theme = savedTheme;
    } else {
      // No choice yet: the CSS already follows the OS, so just mirror it in state.
      setThemeState(window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    }
    setLangState(savedLang ?? detectLang());
    setCostMattersState(localStorage.getItem("ditherra.costMatters") !== "false");
    const panel = Number(localStorage.getItem("ditherra.panelWidth"));
    const side = Number(localStorage.getItem("ditherra.sidebarWidth"));
    if (panel) setPanelWidthState(panel);
    if (side) setSidebarWidthState(side);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("ditherra.theme", next);
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    document.documentElement.lang = next;
    localStorage.setItem("ditherra.lang", next);
  }, []);

  const setCostMatters = useCallback((next: boolean) => {
    setCostMattersState(next);
    localStorage.setItem("ditherra.costMatters", String(next));
  }, []);

  const setPanelWidth = useCallback((n: number) => {
    setPanelWidthState(n);
    localStorage.setItem("ditherra.panelWidth", String(n));
  }, []);

  const setSidebarWidth = useCallback((n: number) => {
    setSidebarWidthState(n);
    localStorage.setItem("ditherra.sidebarWidth", String(n));
  }, []);

  // Memoised so callbacks that depend on it don't capture a stale language.
  const t = useMemo(() => translator(lang), [lang]);

  // Palettes
  const [palettes, setPalettes] = useState<Palette[]>([]);
  const [currentPalette, setCurrentPalette] = useState<Palette | null>(null);
  const [selectedColorIdx, setSelectedColorIdx] = useState(0);

  // Which engine paints. It lived in ControlPanel's local state, so nothing
  // else in the app could name the model that was about to run — including the
  // command band, which had a wide empty gap and nothing to say.
  const [model, setModel] = useState("");
  const [quality, setQuality] = useState("normal");

  // Generation
  const [pixelData, setPixelData] = useState<number[][] | null>(null);
  const [spriteSize, setSpriteSize] = useState(16);
  const [isGenerating, setIsGenerating] = useState(false);
  // `at` is when the line landed. The gap between two lines is the diagnosis:
  // a run that stalls looks identical to one that is working until you can see
  // that thirty seconds passed between step 4 and step 5.
  const [logs, setLogs] = useState<{ step: string; message: string; at: number }[]>([]);
  const [status, setStatus] = useState<{ type: "idle" | "generating" | "complete" | "error"; message: string }>({ type: "idle", message: "" });
  const [activeGenId, setActiveGenId] = useState<number | null>(null);
  const [currentGen, setCurrentGen] = useState<Generation | null>(null);

  // Tileset preview lives here (not in Canvas) so the sidebar can render it
  // between History and Activity. It belongs to one sprite, so it clears on switch.
  const [tilesetPreview, setTilesetPreview] = useState<{ name: string; files: string[] } | null>(null);
  useEffect(() => { setTilesetPreview(null); }, [activeGenId]);

  // History
  const [generations, setGenerations] = useState<Generation[]>([]);

  // Reference
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [refConfirmed, setRefConfirmed] = useState(false);

  // Abort
  const abortRef = useRef<AbortController | null>(null);
  // Monotonic token so a slow history fetch can't overwrite a newer one when you
  // click through sprites fast (the "it stays on the previous one" bug).
  const loadReqRef = useRef(0);

  // ── Init ──
  const loadSettings = useCallback(async () => {
    const s = await api<Settings>("/settings");
    setSettings(s);
    return s;
  }, []);

  const loadPalettes = useCallback(async () => {
    const p = await api<Palette[]>("/palettes");
    setPalettes(p);
    if (p.length > 0 && !currentPalette) {
      setCurrentPalette(p[0]);
    }
    return p;
  }, [currentPalette]);

  const loadHistory = useCallback(async () => {
    const g = await api<Generation[]>("/generations");
    setGenerations(g);
    return g;
  }, []);

  // One entry point for startup. A failed fetch (backend down) rejects with
  // TypeError; catch it so page.tsx can show an error + retry instead of hanging.
  const loadInitial = useCallback(async () => {
    setInitError(null);
    try {
      await Promise.all([loadSettings(), loadPalettes(), loadHistory()]);
    } catch (e) {
      setInitError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSettings, loadHistory]);

  // ── Palette ──
  const selectPalette = useCallback(async (id: number) => {
    const p = palettes.find((p) => p.id === id);
    if (!p) return;
    setSelectedColorIdx(0);
    // Cure a palette that grew past the cap before the limit existed: trim to
    // 36 and persist, so the "106/36" state fixes itself on open.
    if (p.colors.length > MAX_PALETTE_COLORS) {
      const cured = { ...p, colors: p.colors.slice(0, MAX_PALETTE_COLORS) };
      setCurrentPalette(cured);
      setPalettes((prev) => prev.map((x) => (x.id === id ? cured : x)));
      await api(`/palettes/${id}`, { method: "PUT", body: JSON.stringify({ colors: cured.colors }) });
      return;
    }
    setCurrentPalette(p);
  }, [palettes]);

  const deletePalette = useCallback(async (id: number) => {
    await api(`/palettes/${id}`, { method: "DELETE" });
    const remaining = palettes.filter((p) => p.id !== id);
    setPalettes(remaining);
    if (currentPalette?.id === id) {
      setCurrentPalette(remaining[0] ?? null);
      setSelectedColorIdx(0);
    }
  }, [palettes, currentPalette]);

  // Build a palette from a reference image's dominant colours and select it.
  // Reuses the existing "From image" palette instead of piling up new ones.
  const paletteFromReference = useCallback(async (refId: string, name: string) => {
    const { colors } = await api<{ colors: string[] }>(`/reference/${refId}/palette`);
    if (!colors.length) return;
    const trimmed = colors.slice(0, MAX_PALETTE_COLORS);
    const existing = palettes.find((p) => p.name === name);
    if (existing) {
      await api(`/palettes/${existing.id}`, { method: "PUT", body: JSON.stringify({ colors: trimmed }) });
      const upd = { ...existing, colors: trimmed };
      setPalettes((prev) => prev.map((p) => (p.id === existing.id ? upd : p)));
      setCurrentPalette(upd);
    } else {
      const result = await api<Palette>("/palettes", { method: "POST", body: JSON.stringify({ name, colors: trimmed }) });
      setPalettes((prev) => [result, ...prev]);
      setCurrentPalette(result);
    }
    setSelectedColorIdx(0);
  }, [palettes]);

  const renamePalette = useCallback(async (id: number, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await api(`/palettes/${id}`, { method: "PUT", body: JSON.stringify({ name: trimmed }) });
    setPalettes((prev) => prev.map((p) => (p.id === id ? { ...p, name: trimmed } : p)));
    setCurrentPalette((prev) => (prev?.id === id ? { ...prev, name: trimmed } : prev));
  }, []);

  const newPalette = useCallback(async () => {
    // Black + white to paint with straight away; the rest is up to the user.
    const result = await api<Palette>("/palettes", {
      method: "POST",
      body: JSON.stringify({ name: t("newPalette"), colors: ["#000000", "#ffffff"] }),
    });
    setPalettes((prev) => [result, ...prev]);
    setCurrentPalette(result);
    setSelectedColorIdx(0);
  }, [t]);

  // Keep a history-loaded sprite's colour snapshot in sync when you're editing
  // the very palette it's showing, so new colours appear on the canvas at once.
  const syncGenColors = (before: string[], after: string[]) =>
    setCurrentGen((g) => (g?.colors && sameColors(g.colors, before) ? { ...g, colors: after } : g));

  // Carousel: the new colour goes to the front; when the palette is full the
  // oldest (last) ones drop off, so adding never blocks — it rotates.
  const addColor = useCallback(async (hex: string) => {
    if (!currentPalette) return;
    const before = currentPalette.colors;
    const updated = [hex, ...before].slice(0, MAX_PALETTE_COLORS);
    await api(`/palettes/${currentPalette.id}`, { method: "PUT", body: JSON.stringify({ colors: updated }) });
    setCurrentPalette({ ...currentPalette, colors: updated });
    syncGenColors(before, updated);
  }, [currentPalette]);

  // Same carousel for a whole harmony — the set goes to the front in one write.
  const addColors = useCallback(async (hexes: string[]) => {
    if (!currentPalette || !hexes.length) return;
    const before = currentPalette.colors;
    const updated = [...hexes, ...before].slice(0, MAX_PALETTE_COLORS);
    await api(`/palettes/${currentPalette.id}`, { method: "PUT", body: JSON.stringify({ colors: updated }) });
    setCurrentPalette({ ...currentPalette, colors: updated });
    syncGenColors(before, updated);
  }, [currentPalette]);

  // ── Reference ──
  const generateReference = useCallback(async (prompt: string, model: string, spriteType: string, size: number) => {
    const data = await api<{ reference_id: string }>("/reference", {
      method: "POST",
      body: JSON.stringify({ prompt, feedback: null, model, sprite_type: spriteType, size }),
    });
    setReferenceId(data.reference_id);
    setRefConfirmed(false);
    return data.reference_id;
  }, []);

  const reviseReference = useCallback(async (prompt: string, feedback: string, model: string, spriteType: string, size: number) => {
    const res = await api<{ reference_id: string }>("/reference", {
      method: "POST",
      body: JSON.stringify({ prompt, feedback, model, sprite_type: spriteType, size }),
    });
    setReferenceId(res.reference_id);
    setRefConfirmed(false);
    return res.reference_id;
  }, []);

  const uploadReference = useCallback(async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await apiRaw("/reference/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    setReferenceId(data.reference_id);
    setRefConfirmed(false);
    return data.reference_id;
  }, []);

  // Confirming the concept art also builds a palette from its colours, so you
  // paint the sprite with the reference's own palette automatically.
  const confirmReference = useCallback(async () => {
    setRefConfirmed(true);
    if (referenceId) {
      try { await paletteFromReference(referenceId, t("imagePalette")); } catch { /* keep the reference confirmed even if palette build fails */ }
    }
  }, [referenceId, paletteFromReference, t]);
  const clearReference = useCallback(() => {
    setReferenceId(null);
    setRefConfirmed(false);
  }, []);

  const handleSSE = useCallback((event: string, data: any) => {
    switch (event) {
      case "log":
        // Status stays high-level ("painting…"); the per-tool detail belongs in
        // the Activity log, not shoved under the generate button. Only the
        // start/chat headlines are worth surfacing as status.
        setStatus({
          type: "generating",
          message: data.step === "start" || data.step === "chat" ? data.message : t("painting"),
        });
        // capped: an 80-step run re-renders the whole log list on every event
        setLogs((prev) => {
          const line = { step: data.step, message: data.message, at: Date.now() };
          // A waiting line REPLACES the previous one instead of stacking: it is
          // the same fact with a bigger number, and appending one every 20s
          // buried the actual steps under a wall of identical rows.
          if (data.step === "waiting" && prev[prev.length - 1]?.step === "waiting") {
            return [...prev.slice(0, -1), line];
          }
          return [...prev, line].slice(-200);
        });
        break;
      case "pixels":
        setPixelData(data.pixel_data);
        if (data.gen_id) setActiveGenId(data.gen_id);
        break;
      case "complete":
        setStatus({ type: "complete", message: t("complete") });
        setCurrentGen({ id: data.id, image_path: data.image_path } as Generation);
        setActiveGenId(data.id);
        break;
      case "error":
        setStatus({ type: "error", message: data.message });
        setLogs((prev) => [...prev, { step: "error", message: data.message, at: Date.now() }]);
        break;
    }
  }, [t]);

  // ── Generation (SSE) ──
  const generate = useCallback(async (opts: {
    prompt: string;
    size: number;
    model: string;
    spriteType: string;
    systemPrompt?: string;
    quality: string;
  }) => {
    if (!currentPalette?.colors?.length) {
      setStatus({ type: "error", message: t("noPalette") });
      return;
    }

    setSpriteSize(opts.size);
    setPixelData(Array.from({ length: opts.size }, () => Array(opts.size).fill(-1)));
    // Drop any loaded sprite's colour snapshot so the new one renders with the
    // current palette, not the previous sprite's colours.
    setCurrentGen(null);
    setLogs([]);
    setStatus({ type: "generating", message: t("starting") });
    setIsGenerating(true);

    abortRef.current = new AbortController();

    try {
      await streamSSE(
        "/generate",
        {
          prompt: opts.prompt,
          colors: currentPalette?.colors || [],
          size: opts.size,
          system_prompt: opts.systemPrompt || null,
          model: opts.model,
          reference_id: refConfirmed && referenceId ? referenceId : null,
          sprite_type: opts.spriteType,
          quality: opts.quality,
          // null = no step cap. The agent then stops only when it is satisfied
          // or when you press STOP. See the cost setting in Settings.
          step_ceiling: costMatters ? RUNAWAY_CEILING : null,
        },
        handleSSE,
        abortRef.current.signal,
      );
      await loadHistory();
    } catch (e: any) {
      if (e.name !== "AbortError") {
        setStatus({ type: "error", message: e.message });
      }
    }
    setIsGenerating(false);
    abortRef.current = null;
  }, [refConfirmed, referenceId, currentPalette, costMatters, loadHistory, handleSSE, t]);


  // ── Manual pixel edits ──
  // Local state updates instantly; the server write is debounced. Anything that
  // reads pixel_data back from the DB (chat, finalize) must flush first.
  const pendingPixels = useRef<{ x: number; y: number; color: number }[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPixels = useCallback(async () => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    const updates = pendingPixels.current;
    pendingPixels.current = [];
    if (!updates.length || !activeGenId) return;
    try {
      await api(`/generations/${activeGenId}/update_pixels`, {
        method: "POST",
        body: JSON.stringify({ updates }),
      });
    } catch (e: any) {
      // The buffer was cleared before the request, so a failure used to throw
      // those strokes away — you saw an error and kept painting on pixels that
      // were never going to be saved. Put them back at the FRONT, ahead of
      // anything drawn while the request was in flight, so the next flush
      // replays them in the order they were made.
      pendingPixels.current = [...updates, ...pendingPixels.current];
      setStatus({ type: "error", message: `${t("couldNotSave")}: ${e.message}` });
    }
  }, [activeGenId, t]);

  // ── Chat ──
  const sendChat = useCallback(async (message: string) => {
    // Guard reentry: without it, Enter twice launches two concurrent /chat
    // streams that both write pixels to the same generation and race.
    if (!activeGenId || isGenerating) return;
    setIsGenerating(true);
    setStatus({ type: "generating", message: t("editing") });

    try {
      // Flush pending manual edits first, otherwise the agent reads the
      // pre-edit sprite from the DB and paints over your changes.
      await flushPixels();
      await streamSSE("/chat", { generation_id: activeGenId, message }, handleSSE);
      await loadHistory();
    } catch (e: any) {
      setStatus({ type: "error", message: e.message });
    } finally {
      setIsGenerating(false);
    }
  }, [activeGenId, isGenerating, handleSSE, loadHistory, flushPixels, t]);

  // ── Skip ──
  const skipAndFinalize = useCallback(async () => {
    // Tell the backend to stop the agent (stops token spend), then cut the
    // stream and finalize with whatever's painted so far.
    if (activeGenId) { try { await api(`/generations/${activeGenId}/cancel`, { method: "POST" }); } catch { /* proceed to abort anyway */ } }
    if (abortRef.current) abortRef.current.abort();
    if (!activeGenId) return;
    try {
      await flushPixels();
      const res = await api<{ id: number; image_path: string }>(`/generations/${activeGenId}/finalize`, { method: "POST" });
      setStatus({ type: "complete", message: t("finalized") });
      setCurrentGen({ id: res.id, image_path: res.image_path } as Generation);
      await loadHistory();
    } catch (e: any) {
      setStatus({ type: "error", message: e.message });
    }
    setIsGenerating(false);
  }, [activeGenId, loadHistory, flushPixels, t]);

  // ── History ──
  const loadGeneration = useCallback(async (id: number) => {
    const req = ++loadReqRef.current;
    const gen = await api<Generation>(`/generations/${id}`);
    if (loadReqRef.current !== req) return; // a newer click superseded this load
    setCurrentGen(gen);
    if (gen.pixel_data) setPixelData(gen.pixel_data);
    if (gen.size) setSpriteSize(gen.size);
    if (gen.colors) {
      // Adopt the sprite's own colours as the working palette, and reset the
      // selection — a leftover index past this palette's length would make
      // painting a silent no-op (the backend rejects out-of-range indices).
      setCurrentPalette((prev) =>
        prev ? { ...prev, colors: gen.colors! } : { id: -1, name: "sprite", colors: gen.colors! });
      setSelectedColorIdx(0);
    }
    // Historical lines carry the server's own timestamp, so reopening a sprite
    // shows the same gaps you would have watched live.
    if (gen.logs) setLogs(gen.logs.map((l) => ({
      step: l.step, message: l.message || "", at: (l.created_at ?? 0) * 1000,
    })));
    setActiveGenId(gen.id);
    // A loaded sprite is a finished sprite. Without this the chat box — gated on
    // status "complete" — never appeared for anything opened from history, while
    // newSprite and importSprite both set it.
    setStatus({ type: "complete", message: "" });
  }, []);

  // A fresh blank canvas to draw on — no AI. Lands in history like any sprite.
  // Optional size lets the size selector recreate the blank at a new dimension,
  // keeping the backend record and the canvas in sync (no local reshape hacks).
  const newSprite = useCallback(async (size?: number) => {
    const sz = size ?? spriteSize;
    if (size) setSpriteSize(size);
    const colors = currentPalette?.colors ?? ["#000000", "#ffffff"];
    const gen = await api<Generation>("/generations/blank", {
      method: "POST",
      body: JSON.stringify({ size: sz, colors }),
    });
    setCurrentGen(gen);
    setPixelData(gen.pixel_data ?? Array.from({ length: sz }, () => Array(sz).fill(-1)));
    setActiveGenId(gen.id);
    setLogs([]);
    setStatus({ type: "complete", message: "" });
    await loadHistory();
  }, [currentPalette, spriteSize, loadHistory]);

  // Import a pixelated image as a sprite. Its colours become a real, selected
  // palette ("From image", reused across imports) so editing uses one consistent
  // colour set — the same footing as a generated sprite.
  const importSprite = useCallback(async (size: number, colors: string[], pixels: number[][]) => {
    const name = t("imagePalette");
    let pal = palettes.find((p) => p.name === name);
    if (pal) {
      await api(`/palettes/${pal.id}`, { method: "PUT", body: JSON.stringify({ colors }) });
      pal = { ...pal, colors };
      setPalettes((prev) => prev.map((p) => (p.id === pal!.id ? pal! : p)));
    } else {
      pal = await api<Palette>("/palettes", { method: "POST", body: JSON.stringify({ name, colors }) });
      setPalettes((prev) => [pal!, ...prev]);
    }
    setCurrentPalette(pal);
    setSelectedColorIdx(0);

    const gen = await api<Generation>("/generations/import", {
      method: "POST",
      body: JSON.stringify({ size, colors, pixel_data: pixels }),
    });
    setCurrentGen(gen);
    setPixelData(gen.pixel_data ?? pixels);
    setSpriteSize(size);
    setActiveGenId(gen.id);
    setLogs([]);
    setStatus({ type: "complete", message: "" });
    await loadHistory();
    return gen.id;
  }, [palettes, t, loadHistory]);

  // Deletes one or many. The single-sprite case is just a list of one, so the
  // "did I delete the sprite I'm looking at" reset and the history reload live
  // in one place and can't drift apart.
  // ponytail: one DELETE per sprite, sequential. A bulk endpoint would save
  // round trips; at local-history scale it isn't worth an endpoint.
  const deleteGenerations = useCallback(async (ids: number[]) => {
    for (const id of ids) await api(`/generations/${id}`, { method: "DELETE" });
    const remaining = await loadHistory();
    if (activeGenId === null || !ids.includes(activeGenId)) return;

    // The sprite on screen is the one that just got deleted. Land on the next
    // one instead of leaving a canvas behind — it used to be filled with a
    // blank grid and no activeGenId, which looks exactly like a sprite you can
    // draw on but silently drops every stroke (setPixels can't persist without
    // an id). Deleting a multi-selection almost always includes the active
    // sprite, which is what made this easy to hit.
    pendingPixels.current = [];
    setLogs([]);
    if (remaining.length) {
      await loadGeneration(remaining[0].id);
      return;
    }
    // Nothing left to show. pixelData null is the honest empty state: Canvas
    // renders no drawable surface, so it can't pretend to accept strokes.
    setCurrentGen(null);
    setActiveGenId(null);
    setPixelData(null);
    setStatus({ type: "idle", message: "" });
  }, [activeGenId, loadHistory, loadGeneration]);

  const deleteGeneration = useCallback(
    (id: number) => deleteGenerations([id]), [deleteGenerations]);

  // Last-ditch flush if the tab closes within the 500ms debounce window —
  // sendBeacon survives unload where a normal fetch would be cancelled.
  useEffect(() => {
    const onUnload = () => {
      const updates = pendingPixels.current;
      if (updates.length && activeGenId) {
        navigator.sendBeacon(
          `${API_BASE}/generations/${activeGenId}/update_pixels`,
          new Blob([JSON.stringify({ updates })], { type: "application/json" }),
        );
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [activeGenId]);

  // ── Canvas edit ──
  // Apply many pixels in one state update — bucket fill, shapes and undo/redo
  // all change lots of cells at once, and one setState beats N.
  const setPixels = useCallback((updates: { x: number; y: number; color: number }[]) => {
    if (!updates.length) return;
    setPixelData((prev) => {
      if (!prev) return prev;
      const next = prev.map((row) => [...row]);
      for (const { x, y, color } of updates) {
        if (y >= 0 && y < next.length && x >= 0 && x < next[0].length) next[y][x] = color;
      }
      return next;
    });
    if (!activeGenId) return;
    for (const u of updates) pendingPixels.current.push(u);
    if (flushTimer.current) clearTimeout(flushTimer.current);
    // Debounced write; mouseUp flushes immediately and beforeunload uses a
    // beacon, so the 500ms window no longer loses edits on tab close.
    // A failed write pushes its updates back onto the buffer, so the next
    // flush retries them. Still no backoff: the next stroke is the retry.
    flushTimer.current = setTimeout(() => { void flushPixels(); }, 500);
  }, [activeGenId, flushPixels]);

  const setPixel = useCallback(
    (x: number, y: number, color: number) => setPixels([{ x, y, color }]),
    [setPixels]
  );

  return {
    // State
    settings, palettes, currentPalette, selectedColorIdx,
    pixelData, spriteSize, isGenerating, logs, status,
    activeGenId, currentGen, generations,
    referenceId, refConfirmed, initError,
    tilesetPreview, setTilesetPreview,

    // Preferences
    theme, setTheme, lang, setLang, t,
    model, setModel, quality, setQuality,
    costMatters, setCostMatters,
    settingsOpen, setSettingsOpen,
    panelWidth, setPanelWidth, sidebarWidth, setSidebarWidth,

    // Actions
    loadSettings, loadPalettes, loadHistory, loadInitial,
    selectPalette, deletePalette, newPalette, renamePalette, paletteFromReference, setSelectedColorIdx, addColor, addColors,
    generateReference, reviseReference, uploadReference, confirmReference, clearReference,
    generate, sendChat, skipAndFinalize,
    loadGeneration, deleteGeneration, deleteGenerations, newSprite, importSprite,
    setPixel, setPixels, setSpriteSize, setPixelData, flushPixels,
  };
}

export type Studio = ReturnType<typeof useStudio>;
