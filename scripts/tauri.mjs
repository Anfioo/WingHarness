#!/usr/bin/env node
// Thin wrapper around the Tauri CLI.
//
// `dev` gets one extra config merged in: `src-tauri/tauri.dev.conf.json`
// overrides the app identifier, which is what the single-instance plugin and
// the `%APPDATA%` data directory key off. Without it a dev build and an
// installed build count as the same app, so starting one while the other runs
// just exits with code 0. Every other subcommand is forwarded unchanged, so
// `tauri build` keeps the real identifier.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Absolute, so the command does not depend on the working directory.
const devConfig = path.join(root, "src-tauri", "tauri.dev.conf.json");
const cli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");

const args = process.argv.slice(2);
const forwarded =
  args[0] === "dev" ? ["dev", "--config", devConfig, ...args.slice(1)] : args;

const { status, error } = spawnSync(process.execPath, [cli, ...forwarded], { stdio: "inherit" });
if (error) throw error;
process.exit(status ?? 1);