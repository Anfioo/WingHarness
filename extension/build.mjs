// Package the extension for each browser. Chrome/Edge/Brave and Firefox share
// everything but the manifest (service worker vs background scripts, and
// Firefox's add-on id), so the build assembles one folder per browser under
// dist/ and zips each of them. Run: `node build.mjs`.
//
// For quick Chromium testing you don't even need this — load the extension/
// folder unpacked as-is. The build is for a clean Firefox folder and for zips.
// No dependencies: the zip writer below is a few dozen lines over node:zlib.

import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

/** Copy the shared payload (source + icons) plus a chosen manifest into a target. */
function assemble(name, manifestFile) {
  const out = join(dist, name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(root, "src"), join(out, "src"), { recursive: true });
  cpSync(join(root, "icons"), join(out, "icons"), { recursive: true });
  cpSync(join(root, manifestFile), join(out, "manifest.json"));
  console.log(`built dist/${name}`);
  return out;
}

// ---- Minimal zip writer (store/deflate, no dependencies) ------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed date/time, the only timestamp format zip understands. */
function dosTimestamp(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(full, name));
    else if (entry.isFile()) out.push({ name, data: readFileSync(full) });
  }
  return out;
}

function zipDirectory(sourceDir, outFile) {
  const files = listFiles(sourceDir);
  const { time, date } = dosTimestamp(new Date());
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const deflated = deflateRawSync(file.data, { level: 9 });
    const useDeflate = deflated.length < file.data.length;
    const payload = useDeflate ? deflated : file.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8); // flags
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt16LE(0, 30); // extra field length
    entry.writeUInt16LE(0, 32); // comment length
    entry.writeUInt16LE(0, 34); // disk number
    entry.writeUInt16LE(0, 36); // internal attributes
    entry.writeUInt32LE(0, 38); // external attributes
    entry.writeUInt32LE(offset, 42); // local header offset

    chunks.push(local, nameBuf, payload);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // central directory disk
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  writeFileSync(outFile, Buffer.concat([...chunks, centralBuf, end]));
  console.log(`zipped ${files.length} files → ${outFile.slice(root.length + 1)}`);
}

const version = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).version;
mkdirSync(dist, { recursive: true });

for (const [name, manifest] of [
  ["chrome", "manifest.json"],
  ["firefox", "manifest.firefox.json"],
]) {
  const out = assemble(name, manifest);
  zipDirectory(out, join(dist, `wingharness-${name}-${version}.zip`));
}
