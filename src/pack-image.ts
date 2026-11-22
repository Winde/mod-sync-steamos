import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadPack } from "./manifest";
import { readPackLibrary, savePackLibrary } from "./pack-library";
import { safeJoin, writeJson } from "./util";
import type { Pack, PackFile } from "./types";

/**
 * Console-selected pack cover.
 *
 * The image is written into the pack itself: the file, `files.json`, and
 * `pack.json.art.grid` are updated together, so the LAN server and the Client
 * see the same cover. `library.json` remembers the previous grid so the
 * console can remove the custom image without guessing.
 */

export const PACK_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function assertPackImage(png: Buffer): void {
  if (!png.length || png.length > PACK_IMAGE_MAX_BYTES) {
    throw new Error(`Pack image must be a PNG no larger than ${PACK_IMAGE_MAX_BYTES / 1024 / 1024} MB.`);
  }
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Pack image must be a PNG file.");
  }
}

function imagePathFor(pack: Pack): string {
  const segment = String(pack.mod.id || "pack").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "pack";
  return `art/${segment}/modsync-cover.png`;
}

function gridFallback(pack: Pack): string {
  const segment = String(pack.mod.id || "pack").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "pack";
  return `art/${segment}/grid.png`;
}

function filesPath(packRoot: string, pack: Pack): string {
  return path.join(packRoot, pack.files || "files.json");
}

function removeEntry(files: { files: PackFile[] }, target: string): void {
  files.files = files.files.filter((file) => file.target !== target && file.source !== target);
}

export interface PackImageResult {
  image: string;
  original: string;
  removed: boolean;
}

export function setPackImage(packRoot: string, png: Buffer): PackImageResult {
  assertPackImage(png);
  const { pack, files } = loadPack(packRoot);
  const library = readPackLibrary(packRoot);
  const target = imagePathFor(pack);
  const original = library?.imageOriginal || (pack.art.grid && pack.art.grid !== target ? pack.art.grid : gridFallback(pack));
  const previous = library?.image;

  if (previous && previous !== target) {
    removeEntry(files, previous);
    fs.rmSync(safeJoin(packRoot, previous), { force: true });
  }

  const destination = safeJoin(packRoot, target);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, png, { mode: 0o644 });

  const sha256 = crypto.createHash("sha256").update(png).digest("hex");
  const entry: PackFile = {
    source: target,
    target,
    size: png.length,
    sha256,
    mode: "644",
  };
  files.files = files.files.filter((file) => file.target !== target);
  files.files.push(entry);

  pack.art.grid = target;
  writeJson(filesPath(packRoot, pack), files);
  writeJson(path.join(packRoot, "pack.json"), pack);
  savePackLibrary(packRoot, { image: target, imageOriginal: original });

  return { image: target, original, removed: false };
}

export function clearPackImage(packRoot: string): PackImageResult | null {
  const { pack, files } = loadPack(packRoot);
  const library = readPackLibrary(packRoot);
  if (!library?.image) return null;

  const image = library.image;
  const original = library.imageOriginal || gridFallback(pack);
  removeEntry(files, image);
  fs.rmSync(safeJoin(packRoot, image), { force: true });

  pack.art.grid = original;
  writeJson(filesPath(packRoot, pack), files);
  writeJson(path.join(packRoot, "pack.json"), pack);
  savePackLibrary(packRoot, { image: "", imageOriginal: "" });

  return { image: original, original, removed: true };
}
