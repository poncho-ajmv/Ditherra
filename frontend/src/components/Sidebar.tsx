"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Studio } from "@/hooks/useStudio";
import { imageUrl } from "@/lib/api";
import { PixelIcon } from "./PixelIcon";

// The sidebar preview lives next to the sprite: gen_x.png → gen_x_preview.png.
// The double-replace guards the case where image_path already carries _preview.
const previewUrl = (imagePath: string) =>
  imageUrl(imagePath.replace(".png", "_preview.png").replace("_preview_preview", "_preview"));

export function Sidebar({ studio }: { studio: Studio }) {
  const t = studio.t;
  const logEndRef = useRef<HTMLDivElement>(null);
  // Activity is collapsed by default — it matters while the agent paints, not
  // after, so it shouldn't hold a permanent half of the column.
  const [showActivity, setShowActivity] = useState(false);
  const [logCopied, setLogCopied] = useState(false);

  // Delete needs two confirmations. step 1 = first ask, step 2 = second ask with
  // the buttons swapped + recoloured, so it can't be dismissed by double-clicking.
  // `ids` is a list so one sprite and a whole selection take the same path.
  const [confirm, setConfirm] = useState<{ ids: number[]; step: number } | null>(null);

  // Multi-select for bulk delete. Cmd/Ctrl+click toggles one, Shift+click takes
  // the range from the last one touched — the same idiom as Finder and every
  // file list, so there's nothing new to learn and no extra chrome to draw.
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const lastPicked = useRef<number | null>(null);
  // Derived, not synced: an id whose sprite is gone simply stops counting. No
  // effect to prune the set, so it can never disagree with the list on screen.
  const selected = useMemo(() => {
    if (!picked.size) return picked;
    const live = new Set(studio.generations.map((g: { id: number }) => g.id));
    return new Set([...picked].filter((id) => live.has(id)));
  }, [picked, studio.generations]);

  const pickTile = (e: React.MouseEvent, id: number) => {
    const ids = studio.generations.map((g: { id: number }) => g.id);
    if (e.metaKey || e.ctrlKey) {
      setPicked((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      });
      lastPicked.current = id;
      return;
    }
    if (e.shiftKey && lastPicked.current !== null) {
      const a = ids.indexOf(lastPicked.current);
      const b = ids.indexOf(id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setPicked((prev) => new Set([...prev, ...ids.slice(lo, hi + 1)]));
        return;
      }
    }
    // A plain click is "open this one", which also means "I'm done selecting".
    setPicked(new Set());
    lastPicked.current = id;
    studio.loadGeneration(id);
  };

  // Resizable height, dragged via the handle and remembered across sessions.
  const [activityHeight, setActivityHeight] = useState(200);
  const drag = useRef({ y: 0, h: 0 });
  useEffect(() => {
    const saved = Number(localStorage.getItem("ditherra.activityHeight"));
    if (saved) setActivityHeight(saved);
  }, []);
  const resizeTo = (n: number) => {
    const c = Math.max(80, Math.min(500, n));
    setActivityHeight(c);
    localStorage.setItem("ditherra.activityHeight", String(c));
  };

  // Auto-open the log while a generation runs, so progress is visible without a click.
  useEffect(() => {
    if (studio.isGenerating) setShowActivity(true);
  }, [studio.isGenerating]);

  useEffect(() => {
    if (showActivity) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [studio.logs, showActivity]);

  const s = studio.settings;

  // Live thumbnail of the sprite as it streams in, so the history tile grows
  // alongside the canvas instead of only appearing once finished.
  const liveThumb = useMemo(() => {
    if (!studio.isGenerating || !studio.pixelData) return null;
    const px = studio.pixelData;
    const colors = studio.currentGen?.colors ?? studio.currentPalette?.colors ?? [];
    const n = px.length;
    if (!n) return null;
    const c = document.createElement("canvas");
    c.width = n; c.height = n;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = px[y]?.[x] ?? -1;
      if (i >= 0 && i < colors.length) { ctx.fillStyle = colors[i]; ctx.fillRect(x, y, 1, 1); }
    }
    return c.toDataURL();
  }, [studio.isGenerating, studio.pixelData, studio.currentGen, studio.currentPalette]);

  const activeInList = studio.generations.some((g: any) => g.id === studio.activeGenId);
  const showLiveTile = studio.isGenerating && liveThumb && !activeInList;

  return (
    <div className="shrink-0 flex flex-col h-screen" style={{ width: studio.sidebarWidth }}>

      {/* ── Settings row — sits above History, with live provider status.
          Sized to match the section headers so it reads as part of the chrome. ── */}
      <button
        className="cfg-row shrink-0 flex items-center gap-2 px-3"
        onClick={() => studio.setSettingsOpen(true)}
        aria-label={t("settings")}
        title={!s || s.models.length === 0 ? t("noProvider") : t("settings")}
        style={{ height: 34, borderBottom: "2px solid var(--rule)", background: "var(--band)", width: "100%", cursor: "pointer", color: "var(--text-dim)", textAlign: "left", overflow: "hidden" }}
      >
        <PixelIcon name="settings" size={15} />
        <span className="mono" style={{ flex: 1, fontSize: "var(--t-small)", letterSpacing: "0.02em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t("settings")}</span>
        <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: !s || s.models.length === 0 ? "var(--danger)" : "var(--success)" }} />
        <span className="mono" style={{ fontSize: "var(--t-micro)", color: "var(--text-faint)", whiteSpace: "nowrap", flexShrink: 0 }}>
          {!s || s.models.length === 0 ? t("statusNoProvider") : t("statusConnected")}
        </span>
      </button>

      {/* ── History gallery ── */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* The rail carries the count at rest and turns into the action bar the
            moment something is selected — same 22px, no layout shift, and the
            delete is where you were already looking. */}
        <div className="rail">
          {selected.size > 0 ? (
            <>
              <span className="mono" style={{ color: "var(--accent)" }}>
                {selected.size} {t("selected")}
              </span>
              <span className="flex items-center" style={{ gap: 8 }}>
                <button
                  className="mono"
                  onClick={() => setPicked(new Set())}
                  style={{ background: "none", border: "none", color: "var(--text-faint)", cursor: "pointer", fontSize: "var(--t-micro)" }}
                >
                  {t("cancel")}
                </button>
                <button
                  className="mono"
                  onClick={() => setConfirm({ ids: [...selected], step: 1 })}
                  style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: "var(--t-micro)" }}
                >
                  {t("deleteWord")}
                </button>
              </span>
            </>
          ) : (
            <>
              <span className="label" style={{ marginBottom: 0 }}>{t("history")}</span>
              {studio.generations.length > 0 && <span className="mono">{studio.generations.length}</span>}
            </>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-2">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
              {/* Always-present "new blank canvas" tile. */}
              <button
                onClick={() => studio.newSprite()}
                title={t("newSprite")}
                style={{
                  aspectRatio: "1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
                  background: "transparent", border: "1px dashed var(--border-hover)", cursor: "pointer", color: "var(--text-dim)",
                }}
              >
                <PixelIcon name="imageNew" size={20} />
                <span className="mono" style={{ fontSize: "8px", textTransform: "uppercase", letterSpacing: "0.1em" }}>{t("newSprite")}</span>
              </button>

              {/* Live tile — the in-progress generation, before it lands in history. */}
              {showLiveTile && (
                <div className="relative" style={{ aspectRatio: "1", background: "var(--surface)", border: "2px solid var(--accent)" }}>
                  <img src={liveThumb!} alt="generando" style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "pixelated", display: "block" }} />
                  <motion.span
                    animate={{ opacity: [1, 0.3, 1] }}
                    transition={{ duration: 1.2, repeat: Infinity }}
                    style={{ position: "absolute", top: 3, left: 3, width: 5, height: 5, borderRadius: "50%", background: "var(--accent)" }}
                  />
                </div>
              )}

              <AnimatePresence initial={false}>
                {studio.generations.map((g: any) => {
                  const isActive = studio.currentGen?.id === g.id;
                  // While this sprite is the one being generated/edited, show the
                  // live streaming thumbnail instead of its stale saved preview.
                  const live = studio.isGenerating && g.id === studio.activeGenId && liveThumb;
                  const src = live ? liveThumb : g.image_path ? previewUrl(g.image_path) : null;
                  const isPicked = selected.has(g.id);
                  return (
                    // The delete control used to be a <span role="button"> INSIDE
                    // this button. Nested interactive content is invalid HTML and
                    // unreachable by keyboard — the only way to delete a sprite
                    // was a mouse. They are siblings now, both real buttons.
                    <motion.div
                      key={g.id}
                      layout
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      className="relative group"
                      style={{ aspectRatio: "1" }}
                    >
                    <button
                      onClick={(e) => pickTile(e, g.id)}
                      aria-pressed={isPicked}
                      aria-label={g.prompt || `sprite ${g.id}`}
                      style={{
                        width: "100%", height: "100%", display: "block",
                        padding: 0, cursor: "pointer",
                        background: isPicked ? "var(--accent-dim)" : "var(--surface)",
                        border: `${isActive || isPicked ? 2 : 1}px solid ${
                          isPicked ? "var(--accent)" : isActive ? "var(--accent)" : "var(--border)"}`,
                      }}
                    >
                      {src ? (
                        <img
                          src={src}
                          alt="sprite"
                          style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "pixelated", display: "block" }}
                          onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }}
                        />
                      ) : (
                        <div style={{ width: "100%", height: "100%" }} />
                      )}
                      {live && (
                        <motion.span
                          animate={{ opacity: [1, 0.3, 1] }}
                          transition={{ duration: 1.2, repeat: Infinity }}
                          style={{ position: "absolute", top: 3, left: 3, width: 5, height: 5, borderRadius: "50%", background: "var(--accent)" }}
                        />
                      )}

                      {/* Selected tiles carry a mark, so the state survives the
                          tile scrolling past the accent border being subtle. */}
                      {isPicked && (
                        <span style={{
                          position: "absolute", top: 2, left: 2, width: 14, height: 14,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          background: "var(--accent)", color: "var(--bg)",
                        }}>
                          <PixelIcon name="check" size={10} />
                        </span>
                      )}

                      {/* The prompt, on hover. A 26px thumbnail can't tell you
                          which sprite this is; its own name can. */}
                      {g.prompt && (
                        <span
                          className="mono opacity-0 group-hover:opacity-100 transition-opacity"
                          style={{
                            position: "absolute", left: 0, right: 0, bottom: 0,
                            padding: "1px 3px", fontSize: "8px", lineHeight: 1.5,
                            background: "var(--bg)", color: "var(--text-dim)",
                            borderTop: "1px solid var(--border)",
                            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            textAlign: "left", pointerEvents: "none",
                          }}
                        >
                          {g.prompt}
                        </span>
                      )}

                      </button>

                      {/* A sibling, not a child. focus-visible keeps it reachable
                          by keyboard even though hover is what reveals it. */}
                      <button
                        aria-label={`${t("deleteWord")} ${g.prompt || g.id}`}
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                        onClick={() => setConfirm({ ids: [g.id], step: 1 })}
                        style={{
                          position: "absolute", top: 2, right: 2, width: 16, height: 16,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          color: "var(--danger)",
                          background: "var(--bg)", border: "1px solid var(--border)", cursor: "pointer",
                        }}
                      >
                        <PixelIcon name="close" size={11} />
                      </button>

                      {/* Size tag, bottom-left */}
                      <span
                        className="mono"
                        style={{
                          position: "absolute", bottom: 2, left: 2, fontSize: "8px",
                          color: "var(--text-faint)", background: "var(--bg)", padding: "0 3px",
                        }}
                      >
                        {g.size}
                      </span>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
        </div>
      </div>

      {/* ── Activity (collapsed by default, resizable when open) ── */}
      {/* Drag handle — only useful when the panel is open. Arrow keys nudge it. */}
      {showActivity && (
        <div
          className="splitter-h"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("activity")}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { y: e.clientY, h: activityHeight };
          }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
            // Drag up (smaller clientY) grows the panel.
            resizeTo(drag.current.h - (e.clientY - drag.current.y));
          }}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 40 : 8;
            if (e.key === "ArrowUp") resizeTo(activityHeight + step);
            else if (e.key === "ArrowDown") resizeTo(activityHeight - step);
            else return;
            e.preventDefault();
          }}
        />
      )}
      <div style={{ borderTop: showActivity ? "none" : "1px solid var(--border)" }} className="shrink-0 flex flex-col">
        <div className="px-3.5 py-2.5 flex items-center justify-between" style={{ gap: 8 }}>
          <button
            aria-expanded={showActivity}
            onClick={() => setShowActivity((v) => !v)}
            className="flex items-center"
            style={{ gap: 6, background: "none", border: "none", cursor: "pointer", flex: 1, textAlign: "left" }}
          >
            <span style={{ color: "var(--text-faint)", display: "flex", transform: showActivity ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}><PixelIcon name="chevronRight" size={12} /></span>
            <span className="label" style={{ marginBottom: 0 }}>{t("activity")}</span>
            {studio.logs.length > 0 && (
              <span className="mono" style={{ fontSize: "var(--t-eyebrow)", color: "var(--text-faint)" }}>
                {studio.logs.length}
              </span>
            )}
          </button>
          {/* A log you can't get out of the app is a log you can't ask anyone
              about. One click puts the whole thing on the clipboard, timings
              included. */}
          {studio.logs.length > 0 && (
            <button
              className="mono"
              aria-label={t("copy")}
              onClick={() => {
                const text = studio.logs
                  .map((l: { step: string; message: string; at: number }) =>
                    `${l.at ? new Date(l.at).toISOString().slice(11, 19) : "--:--:--"}  [${l.step}] ${l.message}`)
                  .join("\n");
                navigator.clipboard?.writeText(text).then(
                  () => { setLogCopied(true); setTimeout(() => setLogCopied(false), 1500); },
                  () => { /* clipboard blocked; the lines are selectable */ },
                );
              }}
              style={{
                display: "flex", alignItems: "center", gap: 4, padding: "2px 6px",
                background: "none", border: "1px solid var(--border)", cursor: "pointer",
                color: logCopied ? "var(--success)" : "var(--text-faint)", fontSize: "var(--t-eyebrow)",
              }}
            >
              <PixelIcon name={logCopied ? "check" : "download"} size={10} /> {t("copy")}
            </button>
          )}
        </div>

        {showActivity && (
          <div className="overflow-y-auto px-3 pb-3" style={{ height: activityHeight }}>
            {studio.logs.length === 0 ? (
              <div style={{ fontSize: "var(--t-small)", color: "var(--text-faint)", padding: "4px 0", lineHeight: 1.5 }}>
                {t("activityWaiting")}
              </div>
            ) : (
              studio.logs.map((l: { step: string; message: string; at: number }, i: number) => {
                // The gap since the previous line is the thing you are actually
                // looking for when a run misbehaves — a 40s hole between two
                // steps says more than either step does.
                const prev = studio.logs[i - 1];
                const gap = prev?.at && l.at ? (l.at - prev.at) / 1000 : 0;
                const slow = gap >= 2;
                const kind = l.step?.includes("error") ? "var(--danger)"
                  : l.step?.includes("complete") ? "var(--success)"
                  : l.step?.startsWith("waiting") ? "var(--text-faint)"
                  : "var(--accent)";
                return (
                  <div
                    key={i}
                    className="mono"
                    style={{ fontSize: "var(--t-micro)", padding: "3px 0", borderBottom: "1px solid var(--border)", lineHeight: 1.4 }}
                  >
                    {/* One flowing line, terminal-style. Splitting the meta and
                        the message onto two rows doubled the height of every
                        entry and pushed the history gallery off screen. */}
                    <span style={{ color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
                      {l.at ? new Date(l.at).toTimeString().slice(0, 8) : "--:--:--"}
                    </span>{" "}
                    <span style={{ fontWeight: 500, color: kind }}>{l.step}</span>
                    {gap > 0 && (
                      <span style={{ color: slow ? "var(--danger)" : "var(--text-faint)" }}>
                        {" "}+{gap < 10 ? gap.toFixed(1) : Math.round(gap)}s
                      </span>
                    )}{" "}
                    <span style={{ color: "var(--text-dim)", wordBreak: "break-word" }}>{l.message}</span>
                  </div>
                );
              })
            )}
            <div ref={logEndRef} />
          </div>
        )}
      </div>

      {/* ── Live status (only while generating) ── */}
      <AnimatePresence>
        {studio.isGenerating && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="shrink-0 flex items-center gap-2 px-3 py-2.5"
            style={{ borderTop: "1px solid var(--border)", background: "var(--surface)" }}
          >
            <motion.span
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 1.2, repeat: Infinity }}
              style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }}
            />
            <span className="mono" style={{ fontSize: "var(--t-micro)", color: "var(--accent)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {studio.status.message || t("painting")}
            </span>
            <button
              className="mono"
              onClick={studio.skipAndFinalize}
              style={{ fontSize: "var(--t-micro)", color: "var(--text-dim)", background: "none", border: "none", cursor: "pointer" }}
            >
              {t("skip")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Delete confirmation (two steps) ── */}
      <AnimatePresence>
        {confirm && (() => {
          const green = { background: "var(--success)", color: "#0d1a0d", border: "none" };
          const blue = { background: "#3a72c4", color: "#fff", border: "none" };
          const step2 = confirm.step === 2;
          const cancelBtn = (
            <button
              key="cancel"
              className="mono"
              onClick={() => setConfirm(null)}
              style={{ flex: 1, padding: "7px 0", cursor: "pointer", ...(step2 ? blue : { background: "var(--surface)", color: "var(--text-dim)", border: "1px solid var(--border)" }) }}
            >
              {t("cancel")}
            </button>
          );
          const sureBtn = (
            <button
              key="sure"
              className="mono"
              onClick={() =>
                step2
                  ? (studio.deleteGenerations(confirm.ids), setPicked(new Set()), setConfirm(null))
                  : setConfirm({ ids: confirm.ids, step: 2 })
              }
              style={{ flex: 1, padding: "7px 0", cursor: "pointer", ...(step2 ? green : { background: "var(--danger)", color: "#fff", border: "none" }) }}
            >
              {t("sure")}
            </button>
          );
          return (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setConfirm(null)}
              style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{ width: 260, padding: 18, background: "var(--bg)", border: "1px solid var(--border)" }}
              >
                <p style={{ fontSize: "var(--t-body)", color: "var(--text)", marginBottom: 14, textAlign: "center" }}>
                  {step2 ? t("deleteReally")
                    : confirm.ids.length > 1 ? `${t("deleteManyConfirm")} (${confirm.ids.length})`
                    : t("deleteConfirm")}
                </p>
                {/* Step 2 swaps the button order so a double-click can't sail through. */}
                <div style={{ display: "flex", gap: 8 }}>
                  {step2 ? [sureBtn, cancelBtn] : [cancelBtn, sureBtn]}
                </div>
              </div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
}
