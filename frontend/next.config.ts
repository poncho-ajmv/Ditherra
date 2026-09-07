import type { NextConfig } from "next";
import { fileURLToPath } from "url";
import { dirname } from "path";

// `next dev` sets no phase env; only the production build exports to ../static.
// In dev, exporting out of the project fights turbopack.root (below), and there's
// nothing to export anyway — dev serves from memory.
const isProd = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  // Static export served same-origin by the backend — production build only.
  ...(isProd ? { output: "export" as const, distDir: "../static" } : {}),
  // Pin the workspace root to this folder. Without it Turbopack walks up, finds
  // the (empty) root lockfile, and resolves node_modules from the repo root —
  // where nothing is installed — so @tailwindcss/postcss "can't be found".
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
};

export default nextConfig;
