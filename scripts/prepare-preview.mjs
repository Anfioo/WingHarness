// Copy the preview engines' assets out of `node_modules` and into `public/`.
//
// The wasm modules and the PDF.js data files do not belong in the JS bundle:
// they are fetched at runtime from fixed paths. Vite serves `public/` as-is, so
// this runs before both `vite dev` and `vite build`.

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

const engines = new URL("public/engines/", root);
await mkdir(engines, { recursive: true });
for (const [source, name] of [
  ["libarchive.js/dist/libarchive.wasm", "libarchive.wasm"],
  ["sql.js/dist/sql-wasm.wasm", "sql-wasm.wasm"],
]) {
  await cp(new URL(`node_modules/${source}`, root), new URL(name, engines));
}

// libarchive.js 2.0.2 treats an archive_read failure as an empty directory.
// Surface libarchive's error after directory iteration, including corrupt files.
const archiveWorker = await readFile(
  new URL("node_modules/libarchive.js/dist/worker-bundle.js", root),
  "utf8"
);
const marker = "yield n}}async _loadFile";
if (archiveWorker.split(marker).length !== 2) {
  throw new Error("libarchive worker changed; revalidate its error-reporting patch.");
}
await writeFile(
  new URL("archive-worker.js", engines),
  archiveWorker.replace(
    marker,
    "yield n}const failure=this._runCode.getError(this._archive);if(failure)throw new Error(failure)}async _loadFile"
  ),
  "utf8"
);

// PDF.js reads these by URL: character maps, the standard fonts, the
// image-decoding wasm modules and the ICC profiles.
const pdfjs = new URL("public/pdfjs/", root);
await mkdir(pdfjs, { recursive: true });
for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  await cp(new URL(`node_modules/pdfjs-dist/${directory}`, root), new URL(`${directory}/`, pdfjs), {
    recursive: true,
  });
}
