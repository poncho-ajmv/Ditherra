"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Studio } from "@/hooks/useStudio";
import { MAX_PALETTE_COLORS } from "@/hooks/useStudio";
import { referenceUrl } from "@/lib/api";
import { harmonize, HARMONY_LABELS, type HarmonyType } from "@/lib/harmony";
import { PixelIcon } from "./PixelIcon";

export function ControlPanel({ studio }: { studio: Studio }) {
  const [addHex, setAddHex] = useState("#8B5E3C");
  const [isGenRef, setIsGenRef] = useState(false);

  const [spriteType, setSpriteType] = useState("block");
  const [refModel, setRefModel] = useState("");

  const [harmony, setHarmony] = useState<HarmonyType>("complementary");
  const [palMenu, setPalMenu] = useState(false);
  const [editingPal, setEditingPal] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  // Inline revise box — replaces a native prompt() so it stays in the app style.
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseText, setReviseText] = useState("");
  const [refError, setRefError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // page.tsx renders a loading screen until settings are fetched, so it's set here.
  const s = studio.settings!;
  const t = studio.t;
  // Owned by useStudio now, so the command band can name the active engine.
  const activeModel = studio.model || s.default_model || "";
  const quality = studio.quality;
  const setQuality = studio.setQuality;

  // The eyedropper (and clicking a swatch) changes selectedColorIdx from the
  // canvas; mirror that into the work colour so the picker, hex and harmonies
  // follow. Without this the eyedropper looked like it did nothing.
  useEffect(() => {
    const c = studio.currentPalette?.colors[studio.selectedColorIdx];
    if (c) setAddHex(c);
  }, [studio.selectedColorIdx, studio.currentPalette]);

  // State, not a ref: the folded header shows the first words of the prompt,
  // and a ref read during render never updates. One less ref, too.
  const [prompt, setPrompt] = useState("");
  const sysRef = useRef<HTMLTextAreaElement>(null);
  const activeRefModel = refModel || s.default_image_model || "";

  // Size is fixed once there's a drawn/generated image — changing it under an
  // existing sprite is the source of the resize bugs. It's only free to change
  // on an empty canvas; to get a new size, start a "Nuevo" (blank) sprite.
  const canvasHasContent = studio.pixelData?.some((r: number[]) => r.some((c) => c >= 0)) ?? false;
  const sizeLocked = studio.isGenerating || canvasHasContent;
  const pickSize = (n: number) => {
    if (n === studio.spriteSize) return;
    // On an active-but-empty blank, recreate it at the new size so canvas and
    // backend agree; with nothing active yet, just set the next-generation size.
    if (studio.activeGenId != null) studio.newSprite(n);
    else studio.setSpriteSize(n);
  };

  const handleGenerate = async () => {
    const text = prompt.trim();
    if (!text || !studio.currentPalette) return;
    await studio.generate({
      prompt: text,
      size: studio.spriteSize,
      model: activeModel,
      spriteType,
      systemPrompt: sysRef.current?.value,
      quality,
    });
  };

  const handleGenRef = async () => {
    const text = prompt.trim();
    if (!text) return;
    setIsGenRef(true);
    setRefError("");
    try {
      await studio.generateReference(text, activeRefModel, spriteType, studio.spriteSize);
    } catch (e: any) {
      setRefError(e.message);
    }
    setIsGenRef(false);
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setRefError("");
    try {
      await studio.uploadReference(file);
    } catch (err: any) {
      setRefError(err.message);
    }
    e.target.value = "";
  };

  const submitRevise = async () => {
    const fb = reviseText.trim();
    if (!fb) return;
    setRefError("");
    try {
      await studio.reviseReference(prompt, fb, activeRefModel, spriteType, studio.spriteSize);
      setReviseText("");
      setReviseOpen(false);
    } catch (e: any) {
      setRefError(e.message);
    }
  };

  const fieldHint = { fontSize: "var(--t-micro)", color: "var(--text-faint)", marginBottom: 3 } as const;

  const paletteCount = studio.currentPalette?.colors.length ?? 0;
  const paletteFull = paletteCount >= MAX_PALETTE_COLORS;

  // Sections fold. Everything opens by default — you close what you have
  // already decided, and the closed header shows the choice rather than the
  // title, so a folded panel still answers "how is this sprite set up".
  const [closed, setClosed] = useState<Set<string>>(new Set());
  // localStorage doesn't exist during the static export, so this can't be a
  // useState initialiser — same reason and same shape as the preferences in
  // useStudio. Costs one extra render on mount.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("ditherra.closedSections") || "[]");
      if (Array.isArray(saved)) setClosed(new Set(saved));
    } catch { /* nothing saved yet, or it was mangled — open everything */ }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */
  const toggleSection = (id: string) => {
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      localStorage.setItem("ditherra.closedSections", JSON.stringify([...next]));
      return next;
    });
  };

  const section = (id: string, n: number, label: string, summary: React.ReactNode, body: React.ReactNode) => {
    const open = !closed.has(id);
    return (
      <div key={id}>
        <button className="sec-head" aria-expanded={open} onClick={() => toggleSection(id)}>
          <span className="sec-chev"><PixelIcon name="chevronDown" size={11} /></span>
          <span className="label"><span style={{ color: "var(--text-faint)" }}>{n} · </span>{label}</span>
          {!open && <span className="sec-sum">{summary}</span>}
        </button>
        {open && <div className="sec-body">{body}</div>}
      </div>
    );
  };

  // What each folded header says. The palette shows its own swatches: the
  // colours are the information, a word describing them is not.
  const paletteSummary = (
    <>
      {(studio.currentPalette?.colors ?? []).slice(0, 6).map((c: string, i: number) => (
        <span key={i} style={{ width: 9, height: 9, flexShrink: 0, background: c }} />
      ))}
      {paletteCount > 6 && <span style={{ marginLeft: 2 }}>+{paletteCount - 6}</span>}
    </>
  );


  return (
    <div
      className="shrink-0 flex flex-col h-screen overflow-hidden"
      style={{ width: studio.panelWidth }}
    >

      {/* Header — brand only; settings now lives in the panel footer. Shares
          .band with the artboard and history columns so the rule runs straight
          across all three instead of stepping at every splitter. */}
      <div className="band">
        <div className="mono" style={{ fontSize: "16px", fontWeight: 600, letterSpacing: "0.1em" }}>DITHERRA</div>
      </div>

      {/* The palette label rides the shared context rail, at the same height as
          the artboard's coordinates and the history count. */}
      <div className="rail">
        <span className="label" style={{ marginBottom: 0 }}>{t("activePalette")}</span>
        <span className="mono" style={{ color: paletteFull ? "var(--danger)" : "var(--text-faint)" }}>
          {paletteCount}/{MAX_PALETTE_COLORS}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">

        {/* ── 1 · Engine — the precondition: without a model nothing else matters ── */}
        {section("engine", 1, t("engine"),
          activeModel ? `${activeModel.split("/").slice(1).join("/")} · ${t(quality === "draft" ? "qualityDraft" : quality === "normal" ? "qualityNormal" : quality === "high" ? "qualityHigh" : "qualityMax")}` : t("statusNoProvider"),
          <>
                    <div style={fieldHint}>{t("model")}</div>
                    {s.models.length === 0 ? (
                      // Empty means no provider is configured — say so, rather than showing
                      // an empty select the user has to guess about.
                      <div style={{ fontSize: "var(--t-small)", color: "var(--danger)", lineHeight: 1.55 }}>
                        {t("noProvider")}
                        <br />
                        <button
                          className="btn mt-1.5"
                          onClick={() => studio.setSettingsOpen(true)}
                        >
                          {t("openSettings")}
                        </button>
                      </div>
                    ) : (
                      <select value={activeModel} aria-label={t("model")} onChange={(e) => studio.setModel(e.target.value)}>
                        {s.models.map((m: string) => {
                          const hasVision = Boolean(s.capabilities[m]?.vision);
                          return (
                            <option key={m} value={m}>
                              {`${hasVision ? "* " : ""}${m}${hasVision ? ` · ${t("seesImages")}` : ""}`}
                            </option>
                          );
                        })}
                      </select>
                    )}

                    {/* Quality is passes: each one is another round of look-and-fix, which is
                        where the quality comes from — and where the tokens go. */}
                    <div style={{ ...fieldHint, marginTop: 8 }}>{t("quality")}</div>
                    <div className="segmented" title={t("qualityHint")}>
                      {([
                        ["draft", "qualityDraft"],
                        ["normal", "qualityNormal"],
                        ["high", "qualityHigh"],
                        ["max", "qualityMax"],
                      ] as const).map(([q, label]) => (
                        <button key={q} aria-pressed={quality === q} onClick={() => setQuality(q)}
                          data-tip={q === "max" ? t("qualityMaxHint") : undefined}>
                          {t(label)}
                        </button>
                      ))}
                    </div>
                    {/* Max is a different kind of run, not just a bigger number — say so
                        where the choice is made rather than hiding it in a tooltip. */}
                    {quality === "max" && (
                      <div style={{ ...fieldHint, marginTop: 6, color: "var(--text-faint)", whiteSpace: "normal", lineHeight: 1.6 }}>
                        {t("qualityMaxHint")}
                        {!studio.costMatters && ` ${t("qualityMaxUncapped")}`}
                      </div>
                    )}
          </>
        )}

        {/* ── 2 · Palette — the colours everything downstream is limited to ── */}
        {section("palette", 2, t("palette"), paletteSummary,
          <>
                    {/* Custom palette menu — mini-swatches, per-row delete, and a "new
                        palette" action the native <select> can't offer. */}
                    <div style={{ position: "relative" }}>
                      <button
                        className="mono"
                        onClick={() => setPalMenu((v) => !v)}
                        aria-expanded={palMenu}
                        style={{
                          width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
                          background: "var(--surface)", border: `1px solid ${palMenu ? "var(--accent)" : "var(--border)"}`,
                          padding: "6px 10px", fontSize: "var(--t-small)", color: "var(--text)", cursor: "pointer",
                        }}
                      >
                        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {studio.currentPalette?.name ?? "—"}
                        </span>
                        <span style={{ color: "var(--text-faint)", display: "flex", transform: palMenu ? "rotate(180deg)" : "none" }}><PixelIcon name="chevronDown" size={12} /></span>
                      </button>

                      {palMenu && (
                        <>
                          <div onClick={() => setPalMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                          <div style={{
                            position: "absolute", left: 0, right: 0, top: "100%", zIndex: 41,
                            background: "var(--surface)", border: "1px solid var(--accent)", borderTop: "none",
                            maxHeight: 300, overflowY: "auto",
                          }}>
                            {studio.palettes.map((p: any) => {
                              const active = p.id === studio.currentPalette?.id;
                              const over = p.colors.length > MAX_PALETTE_COLORS;
                              const editing = editingPal === p.id;
                              const saveName = () => { studio.renamePalette(p.id, editName); setEditingPal(null); };
                              return (
                                <div
                                  key={p.id}
                                  onClick={() => { if (!editing) studio.selectPalette(p.id); }}
                                  onDoubleClick={() => { setEditingPal(p.id); setEditName(p.name); }}
                                  title={t("renameHint")}
                                  style={{
                                    display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", cursor: "pointer",
                                    borderLeft: `2px solid ${active ? "var(--accent)" : "transparent"}`,
                                    background: active ? "var(--accent-dim)" : "transparent",
                                    borderBottom: "1px solid var(--border)",
                                  }}
                                >
                                  <div style={{ display: "flex", gap: 1, flexShrink: 0 }}>
                                    {p.colors.slice(0, 3).map((c: string, i: number) => (
                                      <span key={i} style={{ width: 9, height: 9, background: c }} />
                                    ))}
                                  </div>
                                  {editing ? (
                                    <input
                                      className="mono"
                                      value={editName}
                                      autoFocus
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => setEditName(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") saveName();
                                        else if (e.key === "Escape") setEditingPal(null);
                                      }}
                                      onBlur={saveName}
                                      style={{ fontSize: "var(--t-small)", flex: 1, padding: "2px 4px" }}
                                    />
                                  ) : (
                                    <span className="mono" style={{ fontSize: "var(--t-small)", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                      {p.name}
                                    </span>
                                  )}
                                  {!editing && (
                                    <span className="mono" style={{ fontSize: "var(--t-micro)", color: over ? "var(--danger)" : "var(--text-faint)" }}>
                                      {p.colors.length}{over ? " ⚠" : ""}
                                    </span>
                                  )}
                                  {!editing && (
                                    <button
                                      aria-label={t("deletePalette")}
                                      title={t("deletePalette")}
                                      onClick={(e) => { e.stopPropagation(); studio.deletePalette(p.id); }}
                                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger)", padding: 2, display: "flex" }}
                                    >
                                      <PixelIcon name="close" size={13} />
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                            <div
                              onClick={() => { studio.newPalette(); setPalMenu(false); }}
                              className="mono"
                              style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 10px", cursor: "pointer", color: "var(--accent)", fontSize: "var(--t-small)" }}
                            >
                              <PixelIcon name="plus" size={13} /> {t("newPalette")}
                            </div>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Swatches — picking one makes it the work colour, so the harmonies
                        below always derive from the swatch you're looking at. */}
                    <div className="flex flex-wrap gap-[2px] mt-2.5">
                      {studio.currentPalette?.colors.map((c: string, i: number) => (
                        <motion.button
                          key={i}
                          whileHover={{ scale: 1.15 }}
                          whileTap={{ scale: 0.95 }}
                          className="relative"
                          style={{
                            width: 22,
                            height: 22,
                            background: c,
                            border: "none",
                            cursor: "pointer",
                            outline: i === studio.selectedColorIdx ? "2px solid var(--accent)" : "1px solid var(--border)",
                            outlineOffset: i === studio.selectedColorIdx ? "1px" : "0",
                            zIndex: i === studio.selectedColorIdx ? 2 : 1,
                          }}
                          onClick={() => { studio.setSelectedColorIdx(i); setAddHex(c); }}
                          title={`${i}: ${c}`}
                        />
                      ))}
                    </div>

                    {/* ── Work colour: one colour shared by the swatch, picker and harmonies ── */}
                    <div className="mt-2.5" style={{ border: "1px solid var(--border)", padding: 8, background: "var(--surface)" }}>
                      <div style={{ ...fieldHint, marginBottom: 6 }}>{t("workColour")}</div>
                      <div className="flex gap-2 items-stretch">
                        {/* The big swatch IS the picker — click to open the colour selector. */}
                        <input
                          type="color"
                          value={addHex}
                          onChange={(e) => setAddHex(e.target.value)}
                          aria-label={t("workColour")}
                          style={{ width: 46, height: 46, padding: 0, border: "1px solid var(--border)", background: "transparent", cursor: "pointer", borderRadius: 0, flexShrink: 0 }}
                        />
                        <div className="flex-1 flex flex-col gap-1.5">
                          <input
                            type="text"
                            value={addHex}
                            onChange={(e) => setAddHex(e.target.value)}
                            maxLength={7}
                            className="mono"
                            style={{ fontSize: "var(--t-small)" }}
                          />
                          <button className="btn" onClick={() => studio.addColor(addHex)}>{t("addToPalette")}</button>
                        </div>
                      </div>
                      <div style={{ fontSize: "var(--t-micro)", color: "var(--text-faint)", lineHeight: 1.4, marginTop: 6 }}>
                        {t("workColourHint")}
                      </div>
                    </div>

                    {/* ── Harmonies — OKLCH rotations of the work colour above ── */}
                    <div className="mt-2" style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <div style={{ ...fieldHint, marginBottom: 6 }}>{t("harmonies")} · OKLCH</div>
                      <div className="flex flex-wrap gap-1">
                        {(Object.keys(HARMONY_LABELS) as HarmonyType[]).map((h) => (
                          <button
                            key={h}
                            aria-pressed={harmony === h}
                            onClick={() => setHarmony(h)}
                            className="mono"
                            style={{
                              fontSize: "var(--t-micro)",
                              padding: "3px 7px",
                              border: `1px solid ${harmony === h ? "var(--accent)" : "var(--border)"}`,
                              background: "transparent",
                              cursor: "pointer",
                              color: harmony === h ? "var(--accent)" : "var(--text-dim)",
                            }}
                          >
                            {HARMONY_LABELS[h]}
                          </button>
                        ))}
                      </div>

                      {(() => {
                        const preview = harmonize(addHex, harmony);
                        if (!preview.length) return null;
                        return (
                          <>
                            {/* base → derived, so the relationship is explicit */}
                            <div className="flex items-center gap-1.5 mt-2">
                              <div className="text-center" style={{ flexShrink: 0 }}>
                                <div style={{ width: 34, height: 24, background: addHex, outline: "2px solid var(--accent)", outlineOffset: -1 }} title={addHex} />
                                <div className="mono" style={{ fontSize: "8px", color: "var(--accent)", marginTop: 2 }}>base</div>
                              </div>
                              <span style={{ color: "var(--text-faint)", display: "flex" }}><PixelIcon name="arrowRight" size={12} /></span>
                              <div className="flex gap-[2px] flex-1">
                                {preview.map((c, i) => (
                                  <button
                                    key={i}
                                    onClick={() => studio.addColor(c)}
                                    title={`${c} — ${t("addToPalette")}`}
                                    style={{ flex: 1, height: 24, background: c, border: "1px solid var(--border)", cursor: "pointer" }}
                                  />
                                ))}
                              </div>
                            </div>
                            <button className="btn w-full mt-2" onClick={() => studio.addColors(preview)}>
                              {t("addAll")} ({preview.length})
                            </button>
                            <div style={{ fontSize: "var(--t-micro)", color: "var(--text-faint)", textAlign: "center", marginTop: 4 }}>
                              {t("clickToAddOne")}
                            </div>
                          </>
                        );
                      })()}
                    </div>
          </>
        )}

        {/* ── 3 · Describe ── */}
        {section("describe", 3, t("describe"),
          prompt.trim(),
          <>
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder={t("promptPlaceholder")}
                      rows={6}
                      style={{ minHeight: 120 }}
                    />

                    <div className="grid grid-cols-2 gap-2 mt-2.5">
                      <div>
                        <div style={fieldHint}>{t("type")}</div>
                        <select value={spriteType} aria-label={t("type")} onChange={(e) => setSpriteType(e.target.value)}>
                          {Object.entries(s.sprite_types || {}).map(([k, v]: [string, { label: string }]) => (
                            <option key={k} value={k}>{v.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <div style={fieldHint}>{t("size")}</div>
                        {/* Segmented, not a dropdown: four fixed sizes read faster as buttons. */}
                        <div className="segmented">
                          {[8, 16, 32, 64].map((n) => (
                            <button
                              key={n}
                              aria-pressed={studio.spriteSize === n}
                              disabled={sizeLocked}
                              title={canvasHasContent ? t("sizeLocked") : undefined}
                              onClick={() => pickSize(n)}
                              style={{ opacity: sizeLocked ? 0.4 : 1, cursor: sizeLocked ? "not-allowed" : "pointer" }}
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
          </>
        )}

        {/* ── 4 · Reference — optional concept art the agent looks at while
             it paints. It used to sit BELOW the generate button that consumes
             it, so a new user generated without ever seeing it. ── */}
        {section("reference", 4, t("reference"),
          studio.refConfirmed ? t("confirmed") : studio.referenceId ? t("revise") : "",
          <>
                    {/* Confirming concept art and then picking a blind model is a silent
                        dead end: the reference is simply never looked at. Say it here. */}
                    {studio.refConfirmed && activeModel && !s.capabilities[activeModel]?.vision && (
                      <p style={{ fontSize: "var(--t-small)", color: "var(--danger)", lineHeight: 1.55, marginBottom: 8 }}>
                        {t("modelCannotSee")}
                      </p>
                    )}
                    <div style={{ ...fieldHint }}>
                      {t("conceptModel")}
                      <span className="mono" style={{ float: "right" }}>{studio.spriteSize}×{studio.spriteSize}</span>
                    </div>
                    {s.image_models.length === 0 ? (
                      <div style={{ fontSize: "var(--t-small)", color: "var(--text-faint)", lineHeight: 1.55 }}>
                        {t("conceptNeedsGemini")}
                      </div>
                    ) : (
                      // Native <select> for the disabled options: a provider you can't use
                      // yet stays visible with its reason and simply can't be picked.
                      // Keyboard, screen reader and mobile pickers come free.
                      <select value={activeRefModel} aria-label={t("conceptModel")} onChange={(e) => setRefModel(e.target.value)}>
                        {(s.image_model_options ?? s.image_models.map((m: string) => ({ id: m, available: true, reason: "" })))
                          .map((o) => (
                            <option key={o.id} value={o.id} disabled={!o.available}>
                              {o.reason ? `${o.id} — ${o.reason}` : o.id}
                            </option>
                          ))}
                      </select>
                    )}

                    {s.google_credential === "antigravity" && (
                      <div style={{ fontSize: "var(--t-micro)", color: "var(--text-faint)", marginTop: 4, lineHeight: 1.5 }}>
                        {t("viaAntigravity")}
                      </div>
                    )}

                    <div className="flex gap-1 mt-2">
                      <button className="btn flex-1" onClick={handleGenRef} disabled={isGenRef || s.image_models.length === 0}>
                        {isGenRef ? t("generating") : t("generate")}
                      </button>
                      <button className="btn flex-1" onClick={() => fileRef.current?.click()}>{t("upload")}</button>
                      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
                    </div>

                    {refError && (
                      <div className="mono" style={{ fontSize: "var(--t-micro)", color: "var(--danger)", marginTop: 6 }}>
                        {refError}
                      </div>
                    )}

                    {/* Reference preview */}
                    <AnimatePresence>
                      {studio.referenceId && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="mt-2 overflow-hidden"
                        >
                          <img
                            src={referenceUrl(studio.referenceId)}
                            alt="reference"
                            className="w-full"
                            style={{ border: "1px solid var(--border)", display: "block" }}
                          />
                          <div className="flex gap-1 mt-1.5">
                            <button
                              className={`btn flex-1 ${studio.refConfirmed ? "btn-primary" : ""}`}
                              onClick={studio.confirmReference}
                            >
                              {studio.refConfirmed ? t("confirmed") : t("confirm")}
                            </button>
                            <button className="btn flex-1" aria-pressed={reviseOpen} onClick={() => { setReviseOpen((v) => !v); setRefError(""); }}>{t("revise")}</button>
                            <button className="btn btn-danger" onClick={studio.clearReference} aria-label={t("clear")} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}><PixelIcon name="close" size={12} /></button>
                          </div>

                          {reviseOpen && (
                            <div className="mt-1.5">
                              <input
                                type="text"
                                value={reviseText}
                                onChange={(e) => { setReviseText(e.target.value); setRefError(""); }}
                                onKeyDown={(e) => { if (e.key === "Enter") submitRevise(); if (e.key === "Escape") setReviseOpen(false); }}
                                placeholder={t("reviseQuestion")}
                                autoFocus
                              />
                              <button className="btn btn-primary w-full mt-1.5" disabled={!reviseText.trim()} onClick={submitRevise}>
                                {t("revise")}
                              </button>
                            </div>
                          )}
                          {/* Confirming already builds the "From image" palette; this hint
                              tells the user that's what the confirm button also does. */}
                          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-faint)", textAlign: "center", marginTop: 6 }}>
                            {t("confirmBuildsPalette")}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
          </>
        )}

        <div className="panel-section">
          <details style={{ color: "var(--text-dim)", fontSize: "var(--t-small)" }}>
            <summary className="cursor-pointer select-none label" style={{ marginBottom: 0 }}>
              {t("systemPrompt")}
            </summary>
            <textarea
              ref={sysRef}
              defaultValue={s.system_prompt}
              rows={3}
              className="mt-2"
              style={{ fontSize: "var(--t-small)", minHeight: 40 }}
            />
          </details>
        </div>
      </div>

      {/* ── The action, pinned. It used to live in the scroll, so how far away
           it sat depended on how much you had unfolded. ── */}
      <div className="panel-foot">
                <div className="flex gap-1">
                  <button
                    className="btn btn-primary flex-1"
                    onClick={handleGenerate}
                    disabled={studio.isGenerating || !activeModel}
                  >
                    {studio.isGenerating ? t("painting") : t("generateSprite")}
                  </button>
                  {studio.isGenerating && (
                    <motion.button
                      initial={{ opacity: 0, width: 0 }}
                      animate={{ opacity: 1, width: "auto" }}
                      className="btn"
                      onClick={studio.skipAndFinalize}
                    >
                      {t("skip")}
                    </motion.button>
                  )}
                </div>

                {/* Status */}
                <AnimatePresence>
                  {studio.status.message && (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      style={{
                        fontSize: "var(--t-small)",
                        marginTop: 6,
                        wordBreak: "break-word",
                        lineHeight: 1.4,
                        // A long provider error (deepseek can return a paragraph) used
                        // to shove the whole palette down. Cap it and let it scroll.
                        maxHeight: 96,
                        overflowY: "auto",
                        color:
                          studio.status.type === "generating" ? "var(--accent)" :
                          studio.status.type === "complete" ? "var(--success)" :
                          studio.status.type === "error" ? "var(--danger)" :
                          "var(--text-dim)",
                      }}
                    >
                      {studio.status.message}
                    </motion.div>
                  )}
                </AnimatePresence>
      </div>
    </div>
  );
}
