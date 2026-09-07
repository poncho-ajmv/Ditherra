"use client";

import { useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { useStudio } from "@/hooks/useStudio";
import { ControlPanel } from "@/components/ControlPanel";
import { Canvas } from "@/components/Canvas";
import { Sidebar } from "@/components/Sidebar";
import { SettingsDialog } from "@/components/SettingsDialog";
import { Splitter } from "@/components/Splitter";
import { DEFAULT_PANEL, DEFAULT_SIDEBAR } from "@/hooks/useStudio";

export default function Home() {
  const studio = useStudio();

  const load = useCallback(() => {
    studio.loadInitial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  // Backend unreachable: show the error and a retry, not an endless spinner.
  if (studio.initError) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 px-6 text-center">
        <span style={{ fontSize: "13px", color: "var(--text)" }}>
          {studio.t("cantReachEngine")}
        </span>
        <span style={{ fontSize: "11px", color: "var(--text-faint)", maxWidth: 360 }}>
          {studio.initError}
        </span>
        <button
          onClick={load}
          style={{ fontSize: "11px", padding: "6px 14px", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)" }}
        >
          {studio.t("retry")}
        </button>
      </div>
    );
  }

  if (!studio.settings) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-3">
        <motion.div
          animate={{ rotate: 45, scale: [1, 1.2, 1] }}
          transition={{ duration: 1.5, repeat: Infinity }}
          style={{ width: 8, height: 8, background: "var(--accent)" }}
        />
        <span style={{ fontSize: "11px", color: "var(--text-faint)" }}>
          connecting to engine...
        </span>
      </div>
    );
  }

  return (
    <div className="h-screen flex overflow-hidden">
      <ControlPanel studio={studio} />
      <Splitter
        width={studio.panelWidth}
        setWidth={studio.setPanelWidth}
        edge="left"
        label={studio.t("resizeControls")}
        defaultWidth={DEFAULT_PANEL}
      />
      <Canvas studio={studio} />
      <Splitter
        width={studio.sidebarWidth}
        setWidth={studio.setSidebarWidth}
        edge="right"
        label={studio.t("resizeHistory")}
        defaultWidth={DEFAULT_SIDEBAR}
      />
      <Sidebar studio={studio} />
      <SettingsDialog studio={studio} />
    </div>
  );
}
