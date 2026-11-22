import fs from "node:fs";
import path from "node:path";
import { readJson, safeJoin } from "./util";
import { validateNotes, validatePreconditions } from "./preconditions";
import { readPackLibrary } from "./pack-library";
import * as paths from "./paths";
import type {
  ArtInfo,
  ContentsSummary,
  FilesDoc,
  GameInfo,
  InstallInfo,
  LaunchInfo,
  LoaderInfo,
  ModInfo,
  Note,
  Pack,
  PackFile,
  PackSummary,
  Platforms,
  PreconditionConfig,
  Variant,
} from "./types";

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

function requireString(obj: Record<string, unknown> | null | undefined, key: string, where: string): void {
  if (!obj || typeof obj[key] !== "string" || !obj[key]) throw new Error(`${where}: missing ${key}`);
}

function validateTarget(target: unknown): void {
  if (typeof target !== "string" || !target) throw new Error("files.json: missing target");
  if (target.includes("\\")) throw new Error(`files.json: target must use forward slashes: ${target}`);
  if (path.posix.isAbsolute(target)) throw new Error(`files.json: absolute target not allowed: ${target}`);
  const segments = target.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`files.json: invalid target: ${target}`);
  }
  for (const segment of segments) {
    if (/[<>:"|?*\u0000-\u001f]/.test(segment)) {
      throw new Error(`files.json: Windows-invalid character in target: ${target}`);
    }
    if (/[. ]$/.test(segment)) {
      throw new Error(`files.json: target segment ends with a dot or space: ${target}`);
    }
    if (WINDOWS_RESERVED.test(segment)) {
      throw new Error(`files.json: Windows-reserved name in target: ${target}`);
    }
  }
}

function validatePlatformList(list: unknown, where: string): Variant[] {
  if (!Array.isArray(list) || !list.length) throw new Error(`${where}: must be a non-empty array`);
  if (new Set(list).size !== list.length) throw new Error(`${where}: duplicate platform`);
  for (const variant of list) {
    if (typeof variant !== "string" || !(paths.VARIANTS as readonly string[]).includes(variant)) {
      throw new Error(`${where}: unknown platform ${String(variant)}`);
    }
  }
  return list as Variant[];
}

export function validatePack(pack: unknown): Pack {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) throw new Error("pack.json: not an object");
  const p = pack as Record<string, unknown>;
  if (p.schema !== 1) throw new Error("pack.json: schema must be 1");
  requireString(p, "id", "pack.json");
  if (p.recipe != null && (typeof p.recipe !== "string" || !p.recipe)) {
    throw new Error("pack.json: recipe must be a non-empty string");
  }
  requireString(p, "name", "pack.json");
  if (!p.game || typeof p.game !== "object" || Array.isArray(p.game)) throw new Error("pack.json: missing game");
  const game = p.game as Record<string, unknown>;
  requireString(game, "id", "pack.json.game");
  if (!Number.isInteger(game.appId)) throw new Error("pack.json.game: appId must be an integer");
  requireString(game, "installDir", "pack.json.game");
  if (!p.mod || typeof p.mod !== "object" || Array.isArray(p.mod)) throw new Error("pack.json: missing mod");
  const mod = p.mod as Record<string, unknown>;
  requireString(mod, "id", "pack.json.mod");
  requireString(mod, "version", "pack.json.mod");
  if (!p.launch || typeof p.launch !== "object" || Array.isArray(p.launch)) throw new Error("pack.json: missing launch");
  const launch = p.launch as Record<string, unknown>;
  requireString(launch, "type", "pack.json.launch");
  if (p.profilePattern != null) {
    if (typeof p.profilePattern !== "string" || !p.profilePattern.includes("{version}")) {
      throw new Error("pack.json.profilePattern must be a string containing {version}");
    }
  }
  if (p.install != null) {
    if (typeof p.install !== "object" || Array.isArray(p.install)) throw new Error("pack.json.install must be an object");
    const install = p.install as Record<string, unknown>;
    requireString(install, "type", "pack.json.install");
    if (install.label != null && typeof install.label !== "string") {
      throw new Error("pack.json.install.label must be a string");
    }
  }
  if (p.platforms != null) {
    const platforms = paths.validatePlatforms(p.platforms, "pack.json.platforms");
    if (!Object.keys(platforms).length) throw new Error("pack.json.platforms: no profiles");
    for (const [variant, profile] of Object.entries(platforms)) {
      if (!profile.exe) throw new Error(`pack.json.platforms.${variant}: missing exe`);
      if (!profile.gameProcess) throw new Error(`pack.json.platforms.${variant}: missing gameProcess`);
    }
  } else {
    requireString(launch, "exe", "pack.json.launch");
    requireString(launch, "gameProcess", "pack.json.launch");
  }
  if (launch.mode != null && (typeof launch.mode !== "string" || !["default", "alternate-exe", "loader"].includes(launch.mode))) {
    throw new Error("pack.json.launch: mode must be default, alternate-exe, or loader");
  }
  requireString(p, "files", "pack.json");
  if (!p.art || typeof p.art !== "object" || Array.isArray(p.art)) throw new Error("pack.json: missing art");
  const art = p.art as Record<string, unknown>;
  for (const key of ["grid", "hero", "logo", "icon"]) {
    if (typeof art[key] !== "string" || !art[key]) {
      // art is optional for the core, but the dashboard expects grid/icon
      if (key === "grid" || key === "icon") throw new Error(`pack.json.art: missing ${key}`);
    }
  }
  validateNotes(p.notes);
  validatePreconditions(p.preconditions);
  return p as unknown as Pack;
}

export function validateFiles(doc: unknown, pack: Pack): FilesDoc {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("files.json: not an object");
  const d = doc as Record<string, unknown>;
  if (d.schema !== 1) throw new Error("files.json: schema must be 1");
  if (d.pack !== pack.id) throw new Error("files.json: pack id mismatch");
  if (!Array.isArray(d.files) || d.files.length === 0) throw new Error("files.json: no files");
  const seen = new Map<string, string>();
  for (const raw of d.files) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("files.json: file must be an object");
    const f = raw as Record<string, unknown>;
    for (const key of ["source", "target", "sha256", "size"]) {
      if (f[key] == null) throw new Error(`files.json: missing ${key}`);
    }
    if (typeof f.source !== "string") throw new Error("files.json: bad source path");
    validateTarget(f.target);
    const target = f.target as string;
    const key = target.toLowerCase();
    if (seen.has(key)) throw new Error(`files.json: targets collide on case-insensitive systems: ${target} and ${seen.get(key)}`);
    seen.set(key, target);
    if (f.platforms != null) validatePlatformList(f.platforms, `files.json: ${target} platforms`);
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`files.json: bad sha256 for ${f.source}`);
    if (!Number.isFinite(f.size)) throw new Error(`files.json: bad size for ${f.source}`);
  }
  return d as unknown as FilesDoc;
}

export function loadPack(packRoot: string): { pack: Pack; files: FilesDoc; packRoot: string } {
  const pack = validatePack(readJson(path.join(packRoot, "pack.json")));
  const filesPath = safeJoin(packRoot, pack.files);
  if (!fs.existsSync(filesPath)) throw new Error(`missing ${pack.files}`);
  const files = validateFiles(readJson(filesPath), pack);
  return { pack, files, packRoot };
}

export function packSummary(packRoot: string): PackSummary {
  const { pack, files } = loadPack(packRoot);
  let totalBytes = 0;
  for (const f of files.files) totalBytes += f.size;
  const stats = paths.platformStats(files.files);
  const library = readPackLibrary(packRoot);
  const notes: Note[] = [...(pack.notes || [])];
  if (library?.notes) notes.push({ title: "Server notes", body: library.notes, tone: "info" });
  return {
    id: pack.id,
    recipe: pack.recipe,
    name: library?.name || pack.name,
    baseName: pack.name,
    description: pack.description || "",
    game: pack.game,
    platforms: pack.platforms || null,
    mod: pack.mod,
    launch: pack.launch,
    loader: pack.loader || null,
    install: pack.install || null,
    contents: pack.contents || null,
    art: pack.art,
    notes,
    preconditions: pack.preconditions || [],
    files: files.files.length,
    totalBytes,
    platformFiles: Object.fromEntries(paths.VARIANTS.map((variant) => [variant, stats[variant].files])) as Record<Variant, number>,
    platformBytes: Object.fromEntries(paths.VARIANTS.map((variant) => [variant, stats[variant].totalBytes])) as Record<Variant, number>,
  };
}

// Keep the types available to consumers that infer the JSON shape.
export type {
  ArtInfo,
  ContentsSummary,
  GameInfo,
  InstallInfo,
  LaunchInfo,
  LoaderInfo,
  ModInfo,
  Note,
  Pack,
  PackFile,
  PackSummary,
  Platforms,
  PreconditionConfig,
};
