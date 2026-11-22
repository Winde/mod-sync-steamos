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
  updatedAt: string;
}

export interface PackLibraryInput {
  name?: unknown;
  notes?: unknown;
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
    if (!name && !notes) return null;
    const entry: PackLibraryEntry = {
      schema: 1,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    };
    if (name) entry.name = name;
    if (notes) entry.notes = notes;
    return entry;
  } catch {
    return null;
  }
}

/**
 * Apply a partial update. An omitted field keeps its current value; an empty
 * string clears it. Clearing both removes the sidecar.
 */
export function savePackLibrary(packRoot: string, input: PackLibraryInput): PackLibraryEntry | null {
  const current = readPackLibrary(packRoot);
  const name = input.name === undefined ? current?.name || "" : normalizePackLibraryName(input.name);
  const notes = input.notes === undefined ? current?.notes || "" : normalizeNotes(input.notes);
  if (!name && !notes) {
    fs.rmSync(libraryFile(packRoot), { force: true });
    return null;
  }
  const entry: PackLibraryEntry = {
    schema: 1,
    updatedAt: new Date().toISOString(),
  };
  if (name) entry.name = name;
  if (notes) entry.notes = notes;
  writeJson(libraryFile(packRoot), entry);
  return entry;
}
