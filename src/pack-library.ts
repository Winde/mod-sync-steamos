import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./util";

/**
 * Per-pack library metadata that is not part of the generated manifest.
 *
 * `pack.json` and `files.json` are owned by the pack builder, so a rename or a
 * console note is kept in a sidecar inside the pack folder instead. The sidecar
 * travels with the pack directory. A rebuild starts from a fresh pack, so the
 * console clears the sidecar rather than carrying it into the new build.
 */

export const LIBRARY_FILE = "library.json";
export const LIBRARY_NAME_MAX = 120;
export const LIBRARY_NOTES_MAX = 4000;

export interface PackLibraryEntry {
  schema: 1;
  name?: string;
  notes?: string;
  /** Pack-relative path of the console-selected cover, e.g. `art/bg3/modsync-cover.png`. */
  image?: string;
  /** The `art.grid` value to restore when the custom cover is removed. */
  imageOriginal?: string;
  updatedAt: string;
}

export interface PackLibraryInput {
  name?: unknown;
  notes?: unknown;
  image?: unknown;
  imageOriginal?: unknown;
}

export function libraryFile(packRoot: string): string {
  return path.join(packRoot, LIBRARY_FILE);
}

export function normalizePackLibraryName(value: unknown): string {
  const name = String(value == null ? "" : value).trim();
  if (name.length > LIBRARY_NAME_MAX) {
    throw new Error(`Pack name must be at most ${LIBRARY_NAME_MAX} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Pack name cannot contain line breaks or control characters.");
  }
  return name;
}

function safePackImagePath(value: unknown): string {
  const rel = String(value == null ? "" : value).trim().replace(/\\/g, "/");
  if (!rel) return "";
  if (!rel.startsWith("art/") || rel.split("/").includes("..") || rel.includes("\u0000")) return "";
  return rel;
}

export function normalizePackImagePath(value: unknown): string {
  const rel = String(value == null ? "" : value).trim().replace(/\\/g, "/");
  if (!rel) return "";
  if (!rel.startsWith("art/") || rel.split("/").includes("..") || rel.includes("\u0000")) {
    throw new Error("Pack image path must be a relative path under art/.");
  }
  return rel;
}

function normalizeNotes(value: unknown): string {
  const notes = String(value == null ? "" : value).trim();
  if (notes.length > LIBRARY_NOTES_MAX) {
    throw new Error(`Pack notes must be at most ${LIBRARY_NOTES_MAX} characters.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes)) {
    throw new Error("Pack notes cannot contain control characters.");
  }
  return notes;
}

export function readPackLibrary(packRoot: string): PackLibraryEntry | null {
  const file = libraryFile(packRoot);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = readJson<Record<string, unknown>>(file);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const notes = typeof raw.notes === "string" ? raw.notes.trim() : "";
    const image = safePackImagePath(raw.image);
    const imageOriginal = safePackImagePath(raw.imageOriginal);
    if (!name && !notes && !image) return null;
    const entry: PackLibraryEntry = {
      schema: 1,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    };
    if (name) entry.name = name;
    if (notes) entry.notes = notes;
    if (image) {
      entry.image = image;
      if (imageOriginal) entry.imageOriginal = imageOriginal;
    }
    return entry;
  } catch {
    return null;
  }
}

/**
 * Apply a partial update. An omitted field keeps its current value; an empty
 * string clears it. Clearing every field removes the sidecar.
 */
export function savePackLibrary(packRoot: string, input: PackLibraryInput): PackLibraryEntry | null {
  const current = readPackLibrary(packRoot);
  const name = input.name === undefined ? current?.name || "" : normalizePackLibraryName(input.name);
  const notes = input.notes === undefined ? current?.notes || "" : normalizeNotes(input.notes);
  const image = input.image === undefined ? current?.image || "" : normalizePackImagePath(input.image);
  const imageOriginal = input.imageOriginal === undefined
    ? current?.imageOriginal || ""
    : normalizePackImagePath(input.imageOriginal);
  if (!name && !notes && !image) {
    fs.rmSync(libraryFile(packRoot), { force: true });
    return null;
  }
  const entry: PackLibraryEntry = {
    schema: 1,
    updatedAt: new Date().toISOString(),
  };
  if (name) entry.name = name;
  if (notes) entry.notes = notes;
  if (image) {
    entry.image = image;
    if (imageOriginal) entry.imageOriginal = imageOriginal;
  }
  writeJson(libraryFile(packRoot), entry);
  return entry;
}
