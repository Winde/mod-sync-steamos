import fs from "node:fs";
import path from "node:path";
import { findAppManifest, libraries, steamRoots } from "./steam";

/**
 * Steam's installed depot manifests.
 *
 * The appmanifest lists each installed depot and the manifest id Steam used.
 * Steam keeps the manifest itself in `<steam-root>/depotcache/`. The manifest
 * is a small protobuf `ContentManifest`; the file mappings give us the exact
 * base-game file list for the installed build, including separate executable
 * and DLC depots.
 *
 * This is a local, read-only source of truth for "what is base game" and is
 * used by snapshot pack builders. It deliberately does not hash the game on
 * disk; the file list and sizes are enough to classify base vs. mod files.
 */

export interface DepotRef {
  depotId: number;
  manifestId: string;
}

export interface DepotFile {
  /** Game-relative path with forward slashes. */
  path: string;
  size: number;
  /** Hex SHA-1 of the file content, when the manifest provides it. */
  sha1?: string;
  depotId: number;
}

export interface BaseFileSet {
  appId: number;
  build: string;
  depots: DepotRef[];
  files: Map<string, DepotFile>;
}

function appManifestBuild(file: string): string {
  const txt = fs.readFileSync(file, "utf8");
  let build = /"buildid"\s+"(\d+)"/.exec(txt)?.[1] || "";
  if (!build || build === "0") build = /"TargetBuildID"\s+"(\d+)"/.exec(txt)?.[1] || "";
  return build;
}

export function readInstalledDepotRefs(appId: number): DepotRef[] {
  const file = findAppManifest(appId);
  if (!file) return [];
  const txt = fs.readFileSync(file, "utf8");
  const block = txt.match(/"InstalledDepots"\s*\{([\s\S]*?)\n\t\}/);
  if (!block) return [];
  const refs: DepotRef[] = [];
  for (const match of block[1].matchAll(/"(\d+)"\s*\{\s*"manifest"\s+"(\d+)"/g)) {
    refs.push({ depotId: Number(match[1]), manifestId: match[2] });
  }
  return refs;
}

function depotCacheRoots(): string[] {
  const roots = new Set<string>();
  for (const root of [...steamRoots(), ...libraries()]) {
    roots.add(path.join(root, "depotcache"));
    roots.add(path.join(root, "steamapps", "depotcache"));
  }
  return [...roots];
}

export function findDepotManifest(depotId: number, manifestId: string): string | null {
  const name = `${depotId}_${manifestId}.manifest`;
  for (const root of depotCacheRoots()) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

interface VarintResult {
  value: number;
  next: number;
}

function readVarint(buf: Buffer, offset: number, end = buf.length): VarintResult | null {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < end && shift < 53) {
    const byte = buf[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: pos };
    shift += 7;
  }
  return null;
}

function readBytes(buf: Buffer, offset: number, end: number): { start: number; end: number; next: number } | null {
  const length = readVarint(buf, offset, end);
  if (!length) return null;
  const start = length.next;
  const next = start + length.value;
  if (next > end) return null;
  return { start, end: next, next };
}

function readFileMapping(buf: Buffer, start: number, end: number, depotId: number): DepotFile | null {
  let pos = start;
  let name = "";
  let size = 0;
  let sha1 = "";
  while (pos < end) {
    const key = readVarint(buf, pos, end);
    if (!key) return null;
    pos = key.next;
    const field = key.value >> 3;
    const wire = key.value & 7;
    if (wire === 2) {
      const bytes = readBytes(buf, pos, end);
      if (!bytes) return null;
      if (field === 1) name = buf.toString("utf8", bytes.start, bytes.end);
      else if (field === 5) sha1 = buf.toString("hex", bytes.start, bytes.end);
      pos = bytes.next;
    } else if (wire === 0) {
      const value = readVarint(buf, pos, end);
      if (!value) return null;
      if (field === 2) size = value.value;
      pos = value.next;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      return null;
    }
  }
  if (!name) return null;
  return {
    path: name.replace(/\\/g, "/"),
    size,
    sha1: sha1 || undefined,
    depotId,
  };
}

/**
 * Parse a Steam `ContentManifest` buffer. Steam prefixes the protobuf with an
 * 8-byte header; the tests can pass a bare protobuf as well.
 */
export function parseContentManifest(buffer: Buffer, depotId = 0): DepotFile[] {
  let offset = 0;
  if (buffer.length >= 9 && (buffer[8] & 7) === 2 && (buffer[8] >> 3) === 1) offset = 8;
  const files: DepotFile[] = [];
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    if (!key) break;
    offset = key.next;
    const field = key.value >> 3;
    const wire = key.value & 7;
    if (wire === 2) {
      const bytes = readBytes(buffer, offset, buffer.length);
      if (!bytes) break;
      if (field === 1) {
        const file = readFileMapping(buffer, bytes.start, bytes.end, depotId);
        if (file) files.push(file);
      }
      offset = bytes.next;
    } else if (wire === 0) {
      const value = readVarint(buffer, offset);
      if (!value) break;
      offset = value.next;
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 5) {
      offset += 4;
    } else {
      // A trailing footer/signature or an unknown group; the file mappings are
      // already complete by then.
      break;
    }
  }
  return files;
}

/**
 * Return the base file set for an installed Steam app. Returns null when the
 * app is not installed or Steam no longer has every depot manifest cached;
 * callers use that as the signal to fall back to conservative selection.
 */
export function readBaseFileSet(appId: number): BaseFileSet | null {
  const manifest = findAppManifest(appId);
  if (!manifest) return null;
  const depots = readInstalledDepotRefs(appId);
  if (!depots.length) return null;
  const files = new Map<string, DepotFile>();
  for (const depot of depots) {
    const file = findDepotManifest(depot.depotId, depot.manifestId);
    if (!file) return null;
    let parsed: DepotFile[];
    try {
      parsed = parseContentManifest(fs.readFileSync(file), depot.depotId);
    } catch {
      return null;
    }
    for (const entry of parsed) {
      if (!entry.path || entry.size === 0) continue;
      // Prefer the first depot entry; duplicate content in later depots is
      // still the same base path.
      files.set(entry.path.toLowerCase(), entry);
    }
  }
  return {
    appId,
    build: appManifestBuild(manifest),
    depots,
    files,
  };
}

export function baseFile(set: BaseFileSet | null, rel: string): DepotFile | null {
  if (!set) return null;
  return set.files.get(rel.replace(/\\/g, "/").toLowerCase()) || null;
}
