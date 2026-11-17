// Installing the `codeg-server` archive the release publishes.
//
// Production Codeg has no checkout: every fork release attaches
// `codeg-server-web-<tag>-windows-x64.zip` — the executable with the `web/`
// export beside it — and a fixed `server.json` describing it. `codeg-server`
// then runs out of `<data dir>/codeg-server/`, whose two paths the settings page
// shows read-only.
//
// The steps are the runtime installer's, in the same order and through the same
// helpers: the moin engine downloads, the backend verifies the checksum, 7z-wasm
// unpacks in a worker, and one command per file writes the result. What differs
// is only what is checked — the manifest's SHA-256 and the two things the
// archive has to contain — and where the files land.
import {
  codegInstallClear,
  codegInstallFinish,
  codegInstallReadArchive,
  codegInstallWriteFile,
  codegReleaseCheck,
  type CodegInstall,
  type CodegRelease,
} from "@/commands";
import {
  downloadArchive,
  extractArchive,
  type DownloadStats,
  type ExtractedFile,
} from "@/lib/runtime/install";

/** The executable the archive has to carry, at its root. */
const BINARY = "codeg-server.exe";
/** The export folder it has to carry beside the executable. */
const WEB_DIR = "web/";

export type CodegInstallProgress =
  | ({ phase: "download" } & DownloadStats)
  | { phase: "extract" }
  | { phase: "write"; value: number; done: number; total: number };

/** Asks the published manifests what the newest archive is. */
export function checkCodegRelease(): Promise<CodegRelease> {
  return codegReleaseCheck();
}

/**
 * Downloads, verifies, unpacks and records one release.
 *
 * Replacing an install wipes the folder first: an update that merged into the
 * previous export would leave files the new build no longer has, which the new
 * server would happily serve. The server therefore has to be stopped — the
 * backend refuses otherwise, and on Windows its running image could not be
 * replaced anyway.
 */
export async function installCodegServer(
  release: CodegRelease,
  onProgress?: (progress: CodegInstallProgress) => void
): Promise<CodegInstall> {
  const source = await downloadArchive(
    release.url,
    (stats) => onProgress?.({ phase: "download", ...stats }),
    (path) => codegInstallReadArchive(path, release.sha256, release.size)
  );

  onProgress?.({ phase: "extract" });
  const files = await extractArchive(source);
  assertLayout(files);

  await codegInstallClear();
  onProgress?.({ phase: "write", value: 0, done: 0, total: files.length });
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    await codegInstallWriteFile(file.path, new Uint8Array(file.buffer));
    onProgress?.({
      phase: "write",
      value: (index + 1) / files.length,
      done: index + 1,
      total: files.length,
    });
  }

  return codegInstallFinish(release);
}

/**
 * Refuses an archive the server could not run from, before anything is deleted.
 *
 * The backend checks the same two things once the files are written, but by then
 * the previous install is already gone — so the cheap check happens first, while
 * a refusal still costs nothing.
 */
function assertLayout(files: ExtractedFile[]): void {
  const paths = files.map((file) => file.path.replace(/\\/g, "/").toLowerCase());
  if (!paths.includes(BINARY.toLowerCase())) {
    throw new Error(`The archive does not contain ${BINARY} at its root.`);
  }
  if (!paths.some((path) => path.startsWith(WEB_DIR))) {
    throw new Error(`The archive does not contain the ${WEB_DIR} folder beside ${BINARY}.`);
  }
}
