/**
 * Colour harmonies in OKLCH.
 *
 * Harmonies are hue rotations. Doing them in OKLCH (not HSL) keeps the rotated
 * colours at the same *perceived* lightness and chroma — a complement of a
 * muted brown comes back an equally muted blue, not a neon one. clampChroma
 * pulls anything that lands outside the sRGB gamut back to the edge instead of
 * letting the hex conversion clip it to garbage.
 */
import { oklch, formatHex, clampChroma } from "culori";

export type HarmonyType =
  | "complementary"
  | "analogous"
  | "triadic"
  | "split"
  | "tetradic"
  | "monochromatic";

// Hue offsets (degrees) per harmony. Monochromatic is handled separately —
// it varies lightness, not hue.
const ROTATIONS: Record<Exclude<HarmonyType, "monochromatic">, number[]> = {
  complementary: [0, 180],
  analogous: [-30, 0, 30],
  triadic: [0, 120, 240],
  split: [0, 150, 210],
  tetradic: [0, 90, 180, 270],
};

const toHex = (c: { mode: "oklch"; l: number; c: number; h: number }): string =>
  formatHex(clampChroma(c, "oklch"));

/** Colours of `type` derived from `baseHex`. Returns [] if the hex won't parse. */
export function harmonize(baseHex: string, type: HarmonyType): string[] {
  const base = oklch(baseHex);
  if (!base) return [];
  const l = base.l;
  const c = base.c;
  const h = base.h ?? 0;

  if (type === "monochromatic") {
    // Five lightness stops at a fixed hue — a shading ramp for one colour.
    return [0.35, 0.5, 0.62, 0.74, 0.86].map((L) => toHex({ mode: "oklch", l: L, c, h }));
  }

  return ROTATIONS[type].map((deg) =>
    toHex({ mode: "oklch", l, c, h: (h + deg + 360) % 360 })
  );
}

/**
 * Recolour a whole palette into variants — the source of the "Variantes" export.
 * Each variant rotates every colour's hue by the same offset in OKLCH, so the
 * internal relationships (shading, contrast) survive and greys/blacks (chroma 0)
 * stay put. The first entry is offset 0 = the untouched original ("base").
 * Monochromatic shifts lightness instead of hue.
 */
// Lightness steps crossed with each hue offset — turns 2-4 hue rotations into a
// plentiful, coherent set (normal / lighter / darker of each hue) without ever
// looking random, since every colour moves together in OKLCH.
const LIGHT_STEPS = [0, 0.1, -0.1];

const recolor = (colors: string[], deg: number, dL: number): string[] =>
  colors.map((hex) => {
    const o = oklch(hex);
    if (!o) return hex;
    return toHex({
      mode: "oklch",
      l: Math.max(0, Math.min(1, o.l + dL)),
      c: o.c,
      h: ((o.h ?? 0) + deg + 360) % 360,
    });
  });

export function paletteVariants(
  colors: string[],
  type: HarmonyType,
): { label: string; colors: string[] }[] {
  if (type === "monochromatic") {
    // A pure shading ramp: seven lightness stops, no hue change.
    const deltas = [0, 0.08, -0.08, 0.16, -0.16, 0.24, -0.24];
    return deltas.map((d) => ({
      label: d === 0 ? "base" : `${d > 0 ? "+" : ""}${Math.round(d * 100)}L`,
      colors: recolor(colors, 0, d),
    }));
  }
  // hue offsets × lightness steps, base (0°, 0L) first.
  const out: { label: string; colors: string[] }[] = [];
  for (const dL of LIGHT_STEPS) {
    for (const deg of ROTATIONS[type]) {
      const lTag = dL > 0 ? " ↑" : dL < 0 ? " ↓" : "";
      out.push({
        label: deg === 0 && dL === 0 ? "base" : `${deg}°${lTag}`,
        colors: recolor(colors, deg, dL),
      });
    }
  }
  return out;
}

export const HARMONY_LABELS: Record<HarmonyType, string> = {
  complementary: "complementary",
  analogous: "analogous",
  triadic: "triadic",
  split: "split-comp",
  tetradic: "tetradic",
  monochromatic: "mono",
};
