import { invoke } from "@tauri-apps/api/core";
import { invokeCommand } from "@/commands/base";
import type { RuntimeKind, RuntimeTarget } from "./types";

/** Where a runtime installs to, and whether its binary is already there. */
export function runtimeTarget(kind: RuntimeKind): Promise<RuntimeTarget> {
  return invokeCommand<{ kind: RuntimeKind }, RuntimeTarget>("runtime_target", { kind });
}

/** Read a locally picked `.7z`/`.zip` into the webview as raw bytes. */
export async function runtimeReadArchive(path: string): Promise<Uint8Array> {
  const body = await invoke<ArrayBuffer>("runtime_read_archive", { path });
  return new Uint8Array(body);
}

/**
 * Write one unpacked file into the runtime directory.
 *
 * The command takes a raw body, so the bytes never pass through JSON:
 * `[kind: 1 byte][name length: u32 LE][name: UTF-8][content]`. Everything else
 * the command needs is inside the body, which keeps a 60 MiB executable from
 * turning into an array of numbers.
 */
export async function runtimeWriteFile(
  kind: RuntimeKind,
  relativePath: string,
  bytes: Uint8Array
): Promise<void> {
  const name = new TextEncoder().encode(relativePath.replace(/\\/g, "/"));
  const payload = new Uint8Array(5 + name.length + bytes.length);
  payload[0] = kind === "clash" ? 0 : 1;
  new DataView(payload.buffer).setUint32(1, name.length, true);
  payload.set(name, 5);
  payload.set(bytes, 5 + name.length);
  await invoke("runtime_write_file", payload);
}
