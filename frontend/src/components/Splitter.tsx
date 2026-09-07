"use client";

import { useRef } from "react";

export const MIN_PANEL = 160;
export const MAX_PANEL = 760;

const clamp = (n: number) => Math.max(MIN_PANEL, Math.min(MAX_PANEL, n));

/**
 * The divider between two panels — and the handle that moves it.
 *
 * The line you see is the thing you drag, so the panels don't need their own
 * borders. Pointer capture keeps the drag alive when the cursor outruns the
 * 5px strip, which is most of the time.
 */
export function Splitter({
  width,
  setWidth,
  edge,
  label,
  defaultWidth,
}: {
  width: number;
  setWidth: (n: number) => void;
  /** Which side the panel being resized is on. */
  edge: "left" | "right";
  label: string;
  /** Restored on double-click. */
  defaultWidth: number;
}) {
  const startX = useRef(0);
  const startWidth = useRef(0);

  const grow = (dx: number) => (edge === "left" ? dx : -dx);

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={MIN_PANEL}
      aria-valuemax={MAX_PANEL}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        startX.current = e.clientX;
        startWidth.current = width;
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        setWidth(clamp(startWidth.current + grow(e.clientX - startX.current)));
      }}
      onDoubleClick={() => setWidth(defaultWidth)}
      onKeyDown={(e) => {
        // Arrows nudge, Shift jumps — a splitter you can only reach with a mouse
        // is a splitter half the people can't use.
        const step = e.shiftKey ? 40 : 8;
        if (e.key === "ArrowLeft") setWidth(clamp(width + grow(-step)));
        else if (e.key === "ArrowRight") setWidth(clamp(width + grow(step)));
        else if (e.key === "Home") setWidth(defaultWidth);
        else return;
        e.preventDefault();
      }}
    />
  );
}
