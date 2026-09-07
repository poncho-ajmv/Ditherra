"use client";

import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "@/lib/api";
import { LANGUAGES, languageLabel, type Lang } from "@/lib/i18n";
import type { Studio } from "@/hooks/useStudio";
import type { TFn } from "@/lib/i18n";
import type { CodexAccount, CodexLogin, ProviderStatus, ProviderTest } from "@/lib/types";
import { priceTier } from "@/lib/providerMeta";
import { PixelIcon } from "./PixelIcon";

const TIER_KEY = {
  free: "tierFree", cheap: "tierCheap", mid: "tierMid",
  premium: "tierPremium", varies: "tierVaries",
} as const;

// ponytail: cosmetic bar scale only — the real count is the label. 200k = full bar.
const TOKEN_BAR_CEILING = 200_000;
const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const AMBER = "#d99a3a";
// The always-visible health of a provider: a dot colour + a one-word status, so
// you can read "is this usable" without expanding anything.
function health(p: ProviderStatus, r: ProviderTest | undefined, t: TFn): { color: string; label: string; text: string; hollow?: boolean } {
  if (p.kind === "codex" && !p.configured) {
    return { color: "transparent", hollow: true, label: t("statusDisconnected"), text: "var(--text-faint)" };
  }
  if (!p.local && p.locked) return { color: "var(--success)", label: t("statusReady"), text: "var(--text-dim)" };
  if (!p.local && !p.configured) return { color: "transparent", hollow: true, label: t("statusNoKey"), text: "var(--text-faint)" };
  if (!r) return { color: AMBER, label: t("statusUntested"), text: "var(--text-dim)" };
  const green = "var(--success)", red = "var(--danger)", dim = "var(--text-dim)";
  switch (r.code) {
    case "ok":
      return { color: green, label: `${t("statusReady")} · ${r.models} ${t("modelsShort")}`, text: dim };
    case "no_endpoint":
      // SDK providers (Gemini) have no HTTP /models to probe — a saved key is
      // "ready"; a bad one only surfaces when you actually generate.
      return { color: green, label: t("statusReady"), text: dim };
    case "unauthorized":
      return { color: red, label: t("statusInvalid"), text: red };   // genuinely rejected key
    case "timeout":
    case "refused":
      return { color: AMBER, label: t("statusNoConn"), text: AMBER };  // network, not the key
    default:
      return { color: AMBER, label: t("statusCheck"), text: AMBER };   // no_models / error / etc
  }
}

export function SettingsDialog({ studio }: { studio: Studio }) {
  // AnimatePresence unmounts the panel when closed, so SettingsPanel's mount
  // effect is exactly "the user just opened settings".
  return (
    <AnimatePresence>
      {studio.settingsOpen && <SettingsPanel studio={studio} />}
    </AnimatePresence>
  );
}

/** One line per outcome, and it names the fix rather than the error. */
function TestResult({ r, t }: { r: ProviderTest; t: TFn }) {
  const good = r.code === "ok";
  // Gemini and other SDK providers can't be probed over HTTP — that's not a
  // failure, so it reads neutral (not the alarming red of a rejected key).
  const neutral = r.code === "no_endpoint";
  const message = {
    ok: "testOk", no_models: "testNoModels", refused: "testRefused",
    timeout: "testTimeout", unauthorized: "testUnauthorized",
    not_found: "testNotFound", no_key: "testNoKey",
    no_endpoint: "testNoEndpoint", error: "testError",
  }[r.code] as Parameters<TFn>[0];

  return (
    <motion.div
      initial={{ opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex gap-2 mt-2"
      role="status"
    >
      <span
        className={`cell ${good ? "cell-ok" : neutral ? "cell-on" : "cell-bad"}`}
        style={{ marginTop: 3 }}
        aria-hidden="true"
      />
      <div style={{ fontSize: "var(--t-small)", lineHeight: 1.55, color: good || neutral ? "var(--text)" : "var(--danger)" }}>
        {t(message)}
        {good && (
          <div style={{ color: "var(--text-faint)" }}>
            {r.models} {t("modelsAvailable")} · {r.tool_models} {t("canCallTools")}
            {r.sample?.length ? <><br /><span className="mono">{r.sample.join(", ")}</span></> : null}
          </div>
        )}
        {r.code === "no_models" && (
          <div style={{ color: "var(--text-faint)" }}>{t("pullAModel")}</div>
        )}
        {!good && r.detail && (
          <div style={{ color: "var(--text-faint)" }}>{r.detail}</div>
        )}
      </div>
    </motion.div>
  );
}

function SettingsPanel({ studio }: { studio: Studio }) {
  const { t, setSettingsOpen } = studio;
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  // Which pane of the rail is showing. Credentials and preferences are two
  // different jobs with opposite density needs; stacking them in one scroll is
  // what buried everything under the provider list.
  const [section, setSection] = useState<"providers" | "generation" | "appearance" | "about">("providers");
  // The selected provider's detail renders in a fixed pane below the table, so
  // choosing one never pushes the rows below it around.
  const [selected, setSelected] = useState<string | null>(null);
  // The draft that was last probed, and how it went. Compared by value, so
  // editing the field invalidates the result without another state to reset.
  const [tested, setTested] = useState<{ key: string; ok: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, ProviderTest>>({});
  const [showAllApi, setShowAllApi] = useState(false);
  const [codexLogin, setCodexLogin] = useState<CodexLogin | null>(null);

  const load = useCallback(async () => {
    try {
      setProviders(await api<ProviderStatus[]>("/providers"));
    } catch {
      setProviders([]);
    }
  }, []);

  const loadStudioSettings = studio.loadSettings;

  // Opening settings is the moment to refresh the real token count.
  useEffect(() => {
    void load();
    void loadStudioSettings();
  }, [load, loadStudioSettings]);

  const usage = studio.settings?.session_usage;

  // Escape closes, matching every other dialog the user has ever used.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSettingsOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSettingsOpen]);

  // candidate: probe a key the user typed but hasn't saved. The server uses it
  // for the request and never writes it, so a bad key never reaches disk.
  const runTest = async (name: string, candidate?: string) => {
    setTesting(name);
    try {
      const r = await api<ProviderTest>(`/providers/${name}/test`, {
        method: "POST",
        body: JSON.stringify({ key: candidate?.trim() || null }),
      });
      setResult((prev) => ({ ...prev, [name]: r }));
      if (candidate?.trim()) setTested({ key: candidate.trim(), ok: r.code === "ok" });
      if (r.code === "ok" && !candidate) {
        await load();
        await studio.loadSettings();   // new models may be selectable now
      }
    } catch (e) {
      setResult((prev) => ({ ...prev, [name]: {
        code: "error", detail: e instanceof Error ? e.message : String(e),
      } }));
    }
    setTesting(null);
  };

  // Like runTest but without the per-row spinner — used to populate every
  // provider's status when settings opens and by "test all".
  const runTestSilent = useCallback(async (name: string) => {
    try {
      const r = await api<ProviderTest>(`/providers/${name}/test`, { method: "POST" });
      setResult((prev) => ({ ...prev, [name]: r }));
    } catch { /* leave it "untested" */ }
  }, []);

  const [testedOnce, setTestedOnce] = useState(false);
  const [testingGroup, setTestingGroup] = useState<string | null>(null);

  // Auto-probe configured providers once, so their real status is on screen
  // the moment the panel opens instead of a wall of "untested".
  useEffect(() => {
    if (!providers.length || testedOnce) return;
    setTestedOnce(true);
    providers.filter((p) => p.configured).forEach((p) => void runTestSilent(p.name));
  }, [providers, testedOnce, runTestSilent]);

  const testGroup = async (key: string, group: ProviderStatus[]) => {
    setTestingGroup(key);
    await Promise.all(group.filter((p) => p.configured).map((p) => runTestSilent(p.name)));
    await load();
    await studio.loadSettings();
    setTestingGroup(null);
  };

  // The default model is global; picking one of a provider's models here makes it
  // the app-wide default (empty falls back to the first available).
  const setDefault = async (model: string) => {
    try {
      await api("/settings/default_model", { method: "PUT", body: JSON.stringify({ model: model || null }) });
      await studio.loadSettings();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const saveKey = async (name: string) => {
    if (!draft.trim()) return;
    // Saving is never blocked: a test can fail because the provider is down,
    // and a disabled button explains nothing. Say what we know and let the
    // user decide.
    const probe = tested?.key === draft.trim() ? tested : null;
    setBusy(true);
    try {
      await api(`/providers/${name}/key`, { method: "PUT", body: JSON.stringify({ key: draft.trim() }) });
      setDraft("");
      setTested(null);
      setNote(!probe ? t("saveUntestedWarn") : probe.ok ? t("keySaved") : t("saveFailedWarn"));
      await load();
      await studio.loadSettings();   // the model dropdown may have filled up
      if (!probe) await runTest(name);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const removeKey = async (name: string) => {
    setBusy(true);
    try {
      await api(`/providers/${name}/key`, { method: "DELETE" });
      setDraft("");
      setTested(null);
      setNote(t("keyRemoved"));
      setResult((prev) => ({ ...prev, [name]: undefined as never }));
      await load();
      await studio.loadSettings();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const connectCodex = async () => {
    const loginWindow = window.open("about:blank", "_blank");
    setBusy(true);
    setNote("");
    try {
      const login = await api<CodexLogin>("/codex/login", { method: "POST" });
      setCodexLogin(login);
      if (loginWindow) {
        loginWindow.opener = null;
        loginWindow.location.href = login.authUrl;
      }
    } catch (e) {
      loginWindow?.close();
      setNote(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const disconnectCodex = async () => {
    setBusy(true);
    try {
      await api("/codex/logout", { method: "POST" });
      setCodexLogin(null);
      await load();
      await loadStudioSettings();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  useEffect(() => {
    if (!codexLogin) return;
    let stopped = false;
    const check = async () => {
      try {
        const account = await api<CodexAccount>("/codex/account");
        if (account.configured && !stopped) {
          setCodexLogin(null);
          await load();
          await loadStudioSettings();
        }
      } catch { /* keep waiting; the login page may still be open */ }
    };
    const timer = window.setInterval(() => void check(), 1200);
    void check();
    return () => { stopped = true; window.clearInterval(timer); };
  }, [codexLogin, load, loadStudioSettings]);

  // One provider row — the button plus its expandable key/test panel. Shared by
  // the local and cloud groups so they can't drift apart.
  // Ready first, then anything needing attention, then unconfigured. The order
  // IS the recommendation, which is why the RECOMENDADO badges that used to sit
  // scattered mid-list are gone: a badge repeating the sort order is noise.
  const rank = (p: ProviderStatus) => {
    const h = health(p, result[p.name], t);
    if (h.hollow) return 2;
    return h.color === "var(--danger)" || h.color === AMBER ? 1 : 0;
  };

  const priceWord = (p: ProviderStatus) =>
    p.local ? t("priceLocal")
      : ["antigravity", "codex"].includes(p.kind) ? t("priceAccount")
      : t(TIER_KEY[priceTier(p.name)]);

  // Three lines and no more: name, what it gives you, what it costs. The way a
  // board goes wrong is cards that grow, so nothing else is allowed in here.
  const card = (p: ProviderStatus) => {
    const h = health(p, result[p.name], t);
    const broken = h.color === "var(--danger)";
    const on = selected === p.name;
    return (
      <button
        key={p.name}
        className={`prov-card${h.hollow ? " is-off" : ""}`}
        aria-current={on}
        onClick={() => {
          setSelected(on ? null : p.name);
          setDraft(""); setTested(null); setNote("");
        }}
      >
        <span className="prov-card-name" style={{ color: h.hollow ? "var(--text-dim)" : "var(--text)" }}>
          <span
            className="prov-sq"
            aria-hidden="true"
            style={{
              background: h.hollow ? "transparent" : h.color,
              border: h.hollow ? "1px solid var(--border-hover)" : "none",
            }}
          />
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
        </span>
        {/* A broken provider says what is missing, right here. The card is not
            washed red: a big alarm block reads as "something broke" when in
            fact one field is absent. */}
        {/* One line, one separator. Two adjacent spans rendered as
            "3 modeloscuenta" — the count and the price had nothing between
            them. A local provider with no models isn't "0 models", it's off. */}
        <span className="prov-card-sub" style={broken ? { color: "var(--danger)" } : h.hollow ? { color: "var(--text-faint)" } : undefined}>
          {broken ? h.label
            : p.local && !p.models ? t("statusOff")
            : p.configured ? `${p.models} ${t("modelsShort")} · ${priceWord(p)}`
            : `${t("statusNoKey")} · ${priceWord(p)}`}
        </span>
      </button>
    );
  };

  const group = (eyebrow: string, hint: string, list: ProviderStatus[], extra?: React.ReactNode) =>
    list.length === 0 ? null : (
      <div key={eyebrow}>
        <div className="provider-section-head">
          <span className="label" style={{ marginBottom: 0 }}>{eyebrow}</span>
          <span className="provider-group-hint">· {hint}</span>
        </div>
        <div className="prov-grid">{list.map(card)}</div>
        {extra}
      </div>
    );

  const detail = (p: ProviderStatus) => {
    const providerModels = (studio.settings?.models ?? []).filter((m) => m.startsWith(`${p.name}/`));
    const primaryModel = studio.settings?.default_model ?? "";
    const isPrimary = providerModels.includes(primaryModel);
    return (
      <div style={{ borderTop: "2px solid var(--rule)", background: "var(--surface)", padding: "10px 12px" }}>
        <div className="mono" style={{ fontSize: "var(--t-title)", marginBottom: 6 }}>{p.name}</div>
        {p.note && (
          <p style={{ fontSize: "var(--t-small)", color: "var(--text-faint)", lineHeight: 1.55, marginBottom: 8 }}>
            {p.note}
          </p>
        )}

        {/* A provider that says "no key" or "off" without saying where to go is
            a dead end. Local ones link to the installer, the rest to the page
            that mints a key.

            Gated on rank, not on `configured`: a local provider needs no key, so
            it is "configured" even while nothing is listening on its port — which
            is exactly when you need the link most. rank 0 means genuinely ready,
            and only then is the link noise. */}
        {p.setup_url && rank(p) > 0 && (
          <a
            className="btn"
            href={p.setup_url}
            target="_blank"
            rel="noreferrer noopener"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8 }}
          >
            {p.local ? t("installIt") : t("getAKey")} <PixelIcon name="arrowRight" size={11} />
          </a>
        )}

        {/* Installing Ollama gives you an empty Ollama — the connection works and
            there is still nothing to paint with. Only shown once it answers but
            has no models, so each step appears when it's the one you need. */}
        {p.setup_cmd && result[p.name]?.code === "no_models" && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: "var(--t-micro)", color: "var(--text-faint)", marginBottom: 3 }}>
              {t("pullAModel")}
            </div>
            <button
              className="mono"
              aria-label={t("copy")}
              onClick={() => {
                navigator.clipboard?.writeText(p.setup_cmd!).then(
                  () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
                  () => { /* clipboard blocked — the text is right there to select */ },
                );
              }}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%",
                padding: "6px 8px", cursor: "pointer", textAlign: "left",
                background: "var(--surface-hover)", border: "1px solid var(--border)",
                color: "var(--text)", fontSize: "var(--t-small)",
              }}
            >
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{p.setup_cmd}</span>
              <span style={{ display: "flex", color: copied ? "var(--success)" : "var(--text-faint)" }}>
                <PixelIcon name={copied ? "check" : "download"} size={11} />
              </span>
            </button>
          </div>
        )}

        {p.kind === "codex" ? (
          <>
            {p.configured ? (
              <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                <span style={{ fontSize: "var(--t-small)", color: "var(--text-dim)" }}>
                  {p.account_email || t("statusReady")}
                  {p.account_plan ? ` · ${p.account_plan}` : ""}
                </span>
                <button className="btn btn-danger" disabled={busy} onClick={disconnectCodex}>
                  {t("disconnectCodex")}
                </button>
              </div>
            ) : codexLogin ? (
              <div style={{ fontSize: "var(--t-small)", color: "var(--text-dim)", lineHeight: 1.6 }}>
                <a href={codexLogin.authUrl} target="_blank" rel="noreferrer">
                  {t("codexOpenLogin")}
                </a>
                <div style={{ color: "var(--text-faint)" }}>{t("codexConnecting")}</div>
              </div>
            ) : (
              <button className="btn" disabled={busy} onClick={connectCodex}>
                {t("connectCodex")}
              </button>
            )}
            {p.error && <p style={{ color: "var(--danger)", fontSize: "var(--t-small)", marginTop: 6 }}>{p.error}</p>}
          </>
        ) : p.local ? (
          <p style={{ fontSize: "var(--t-small)", color: "var(--text-dim)" }}>
            {p.configured ? `${p.models} ${t("modelsAvailable")}` : t("runsLocally")}
          </p>
        ) : p.locked ? (
          <p style={{ fontSize: "var(--t-small)", color: "var(--text-dim)" }}>
            {t("fromEnvironment")} — <code>{p.key_env}</code>
          </p>
        ) : (
          <>
            <div style={{ fontSize: "var(--t-micro)", color: "var(--text-faint)", marginBottom: 3 }}>
              {t("apiKey")} — <code>{p.key_env}</code>
            </div>
            <div className="flex gap-1">
              <input
                type="password"
                value={draft}
                autoComplete="off"
                spellCheck={false}
                placeholder={t("keyPlaceholder")}
                onChange={(e) => { setDraft(e.target.value); setTested(null); }}
                onKeyDown={(e) => e.key === "Enter" && saveKey(p.name)}
              />
              <button
                className="btn"
                disabled={busy || !draft.trim() || testing !== null}
                onClick={() => void runTest(p.name, draft)}
              >
                {testing === p.name ? t("testing") : t("testThisKey")}
              </button>
              <button
                className={`btn${tested?.key === draft.trim() && tested.ok ? " btn-primary" : ""}`}
                disabled={busy || !draft.trim()}
                onClick={() => saveKey(p.name)}
              >
                {t("saveKey")}
              </button>
            </div>
            {p.configured && (
              <button
                className="btn btn-danger mt-1.5"
                disabled={busy}
                onClick={() => removeKey(p.name)}
              >
                {t("removeKey")}
              </button>
            )}
          </>
        )}

        {/* Every provider gets this, local ones included —
            "is Ollama even running" had no answer before. */}
        {(p.kind !== "codex" || p.configured) && !draft.trim() && (
          <div className="flex items-center gap-2 mt-2">
            <button
              className="btn"
              disabled={testing !== null}
              onClick={() => void runTest(p.name)}
            >
              {testing === p.name ? t("testing") : t("testConnection")}
            </button>
          </div>
        )}

        {result[p.name] && <TestResult r={result[p.name]} t={t} />}

        {/* Default-model picker — only when this provider actually has
            usable models. Picking one makes it the app-wide default. */}
        {(() => {
          if (providerModels.length === 0) return null;
          // Native <select>: a custom popover would be clipped by this
          // row's height-animation overflow. Only echo the default if it's
          // actually one of this provider's models.
          return (
            <div className="mt-3">
              <div style={{ fontSize: "var(--t-micro)", color: "var(--text-faint)", marginBottom: 4 }}>{t("primaryModel")}</div>
              <select
                value={isPrimary ? primaryModel : ""}
                aria-label={t("primaryModel")}
                onChange={(e) => void setDefault(e.target.value)}
              >
                <option value="">{t("pickModel")}</option>
                {providerModels.map((m) => (
                  <option key={m} value={m}>{m.split("/").slice(1).join("/")}</option>
                ))}
              </select>
            </div>
          );
        })()}
      </div>
    );
  };

  const ordered = [...providers].sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name));
  // Grouped by how you pay for it — your account, your machine, or your card.
  // That is the decision being made here; connection state is the square.
  const isAccount = (p: ProviderStatus) => ["antigravity", "codex"].includes(p.kind);
  const accounts = ordered.filter(isAccount);
  const onDevice = ordered.filter((p) => p.local && !isAccount(p));
  const withKey = ordered.filter((p) => !p.local && !isAccount(p));
  // Only the API group folds: the other two are two cards each and always fit.
  const keyShown = showAllApi ? withKey : withKey.filter((p) => rank(p) < 2 || p.configured);
  const hidden = withKey.length - keyShown.length;
  const tally = [0, 0, 0];   // ready, needs attention, no credential
  for (const p of ordered) tally[rank(p)]++;

  const railItem = (id: typeof section, label: string) => (
    <button key={id} aria-current={section === id} onClick={() => setSection(id)}>{label}</button>
  );

  return (
    <motion.div
      className="overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      onClick={() => setSettingsOpen(false)}
    >
      <motion.div
        className="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings")}
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.14 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <span className="mono" style={{ fontSize: "var(--t-small)", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>
            {t("settings")}
          </span>
          <button className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label={t("close")}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
            <PixelIcon name="close" size={13} />
          </button>
        </div>

        <div className="dialog-body" style={{ display: "flex", padding: 0, alignItems: "stretch" }}>
          <nav className="settings-rail" aria-label={t("settings")}>
            {railItem("providers", t("providers"))}
            {railItem("generation", t("generate"))}
            {railItem("appearance", t("appearance"))}
            {railItem("about", t("about"))}
          </nav>

          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflowY: "auto" }}>
            {section === "providers" && (
              <>
                {/* The promise about where keys go belongs BEFORE the field that
                    takes one, not in small grey type after the whole list. */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                              padding: "7px 12px", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ fontSize: "var(--t-micro)", color: "var(--text-faint)", lineHeight: 1.5 }}>
                    {t("keysStayHere")}
                  </span>
                  <button className="provider-test-group mono" disabled={testingGroup !== null}
                          onClick={() => void testGroup("all", providers)}>
                    <PixelIcon name="redo" size={11} /> {testingGroup ? t("testing") : t("testAll")}
                  </button>
                </div>

                {/* The whole state in one line, so you don't read fifteen rows
                    to learn that one thing is wrong. */}
                <div className="mono" style={{ padding: "5px 12px", fontSize: "var(--t-micro)", color: "var(--text-dim)",
                                               background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
                  {tally[0]} {t("statusReady")}
                  {tally[1] > 0 && <span style={{ color: "var(--danger)" }}> · {tally[1]} {t("statusCheck")}</span>}
                  <span style={{ color: "var(--text-faint)" }}> · {tally[2]} {t("statusNoKey")}</span>
                </div>

                {group(t("connectedAccounts"), t("connectedAccountsHint"), accounts)}
                {group(t("localProviders"), t("nothingLeavesMachine"), onDevice)}
                {group(t("apiProviders"), t("apiProvidersHint"), keyShown, (
                  <>
                    {hidden > 0 && (
                      <button className="mono" onClick={() => setShowAllApi(true)}
                              style={{ width: "100%", padding: "0 0 9px", background: "none", border: "none",
                                       color: "var(--text-faint)", fontSize: "var(--t-micro)", cursor: "pointer" }}>
                        + {hidden} {t("showMoreProviders")}
                      </button>
                    )}
                    {showAllApi && (
                      <button className="mono" onClick={() => setShowAllApi(false)}
                              style={{ width: "100%", padding: "0 0 9px", background: "none", border: "none",
                                       color: "var(--text-faint)", fontSize: "var(--t-micro)", cursor: "pointer" }}>
                        {t("showLess")}
                      </button>
                    )}
                  </>
                ))}

                {/* Fixed pane: it replaces the row's detail, never pushes it. */}
                {selected && providers.find((p) => p.name === selected) &&
                  detail(providers.find((p) => p.name === selected)!)}

                {note && <p style={{ fontSize: "var(--t-small)", color: "var(--accent)", padding: "8px 12px" }}>{note}</p>}
              </>
            )}

            {section === "generation" && (
              <>

              {/* ── Provider-reported usage for the current session ── */}
              <div className="panel-section">
                <div className="label">{t("sessionUsage")}</div>
                <div className="session-usage-detail">
                  {usage?.reported ? (
                    <>
                      <div className="session-usage-copy">~{formatTokens(usage.total)} {t("tokensThisSession")}</div>
                      <div className="session-usage-track">
                        <div style={{ width: `${Math.min(100, (usage.total / TOKEN_BAR_CEILING) * 100)}%` }} />
                      </div>
                    </>
                  ) : (
                    <p className="session-usage-copy">{t("usageNotReported")}</p>
                  )}
                </div>
              </div>

              {/* ── Generation limits ──
                  The only thing this decides is whether a run gets a step
                  ceiling. It sits next to the providers because that is where
                  the money is, and it is the one setting that can cost some. */}
              <div className="panel-section">
                <div className="label">{t("limits")}</div>
                <div style={{ fontSize: "var(--t-micro)", color: "var(--text-faint)", marginBottom: 6, lineHeight: 1.6 }}>
                  {t("limitsHint")}
                </div>
                <div className="segmented">
                  {([[true, "costMatters"], [false, "costDoesntMatter"]] as const).map(([v, label]) => (
                    <button
                      key={String(v)}
                      aria-pressed={studio.costMatters === v}
                      onClick={() => studio.setCostMatters(v)}
                    >
                      {t(label)}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: "var(--t-micro)", color: "var(--text-faint)", marginTop: 6, lineHeight: 1.6 }}>
                  {studio.costMatters ? t("costMattersHint") : t("costDoesntMatterHint")}
                </div>
              </div>

              </>
            )}

            {section === "appearance" && (
              <>
              <div className="panel-section">
                <div className="label">{t("theme")}</div>
                <div style={{ fontSize: "var(--t-micro)", color: "var(--text-faint)", marginBottom: 4 }}>{t("theme")}</div>
                <div className="segmented">
                  {(["dark", "light"] as const).map((v) => (
                    <button
                      key={v}
                      aria-pressed={studio.theme === v}
                      onClick={() => studio.setTheme(v)}
                    >
                      {t(v)}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Language ── */}
              <div className="panel-section">
                <div className="label">{t("language")}</div>
                <select value={studio.lang} aria-label={t("language")}
                        onChange={(e) => studio.setLang(e.target.value as Lang)}>
                  {(Object.keys(LANGUAGES) as Lang[]).map((code) => (
                    <option key={code} value={code}>{languageLabel(code, studio.lang)}</option>
                  ))}
                </select>
              </div>

              </>
            )}

            {section === "about" && (
              <>
              <div className="panel-section">
                <div className="label">{t("providers")}</div>
                <p style={{ fontSize: "var(--t-small)", color: "var(--text-faint)", lineHeight: 1.55 }}>
                  {t("providersHint")}
                </p>
              </div>
              <div className="panel-section">
                <div className="label">{t("credits")}</div>
                <div style={{ fontSize: "var(--t-small)", color: "var(--text-faint)", lineHeight: 1.6 }}>
                  <a
                    className="btn developer-credit"
                    href="https://github.com/poncho-ajmv"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <span>{t("leadDeveloper")}</span>
                    <span>poncho-ajmv <PixelIcon name="arrowRight" size={12} /></span>
                  </a>
                  <p className="mt-1.5">
                    {t("aboutFork")}{" "}
                    <a
                      href="https://github.com/EYamanS"
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ color: "var(--accent)" }}
                    >
                      github.com/EYamanS
                    </a>
                  </p>
                </div>
              </div>
              </>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
