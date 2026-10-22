// Snapshots every theme tweakcn publishes into `src/lib/theme/presets.json`.
//
// tweakcn's editor shows these themes one at a time as a shadcn registry item
// (`pnpm dlx shadcn@latest add https://tweakcn.com/r/themes/<id>.json`), which
// rewrites `src/index.css` wholesale — one theme per project, chosen once. The
// registry index below publishes every theme with its light and dark variables
// in a single document, which is what lets the app carry all of them and switch
// between them at runtime instead.
//
// Re-run with `pnpm themes:fetch` to pick up themes added upstream.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outputPath = path.join(rootDir, "src", "lib", "theme", "presets.json");

const REGISTRY_URL = "https://tweakcn.com/r/themes/registry.json";

// Dropped because nothing in this app reaches them: the chart namespace has no
// consumers, and the six shadow scalars are only inputs to the expanded
// `--shadow-*` values tweakcn ships alongside them.
const OMITTED = new Set([
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "shadow-color",
  "shadow-opacity",
  "shadow-blur",
  "shadow-spread",
  "shadow-offset-x",
  "shadow-offset-y",
]);

function pick(mode) {
  const picked = {};
  for (const [name, value] of Object.entries(mode)) {
    if (!OMITTED.has(name)) picked[name] = value;
  }
  return picked;
}

const response = await fetch(REGISTRY_URL);
if (!response.ok) {
  throw new Error(`registry request failed: ${response.status} ${response.statusText}`);
}

const registry = await response.json();
const presets = registry.items.map((item) => ({
  id: item.name,
  label: item.title,
  light: pick(item.cssVars.light),
  dark: pick(item.cssVars.dark),
}));

// 2-space indent and a trailing newline match what `prettier --check`, which
// `pnpm check` runs over `src/**/*.json`, expects of this file.
await writeFile(outputPath, `${JSON.stringify(presets, null, 2)}\n`, "utf8");

console.log(`wrote ${presets.length} themes to ${path.relative(rootDir, outputPath)}`);
