const fs = require("node:fs");
const path = require("node:path");
const { readJson, safeJoin } = require("./util");
const { validateNotes, validatePreconditions } = require("./preconditions");
const paths = require("./paths");

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

function requireString(obj, key, where) {
  if (!obj || typeof obj[key] !== "string" || !obj[key]) throw new Error(`${where}: missing ${key}`);
}

function validateTarget(target) {
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

function validatePlatformList(list, where) {
  if (!Array.isArray(list) || !list.length) throw new Error(`${where}: must be a non-empty array`);
  if (new Set(list).size !== list.length) throw new Error(`${where}: duplicate platform`);
  for (const variant of list) {
    if (!paths.VARIANTS.includes(variant)) throw new Error(`${where}: unknown platform ${variant}`);
  }
}

function validatePack(pack) {
  if (!pack || typeof pack !== "object") throw new Error("pack.json: not an object");
  if (pack.schema !== 1) throw new Error("pack.json: schema must be 1");
  requireString(pack, "id", "pack.json");
  requireString(pack, "name", "pack.json");
  if (!pack.game || typeof pack.game !== "object") throw new Error("pack.json: missing game");
  requireString(pack.game, "id", "pack.json.game");
  if (!Number.isInteger(pack.game.appId)) throw new Error("pack.json.game: appId must be an integer");
  requireString(pack.game, "installDir", "pack.json.game");
  if (!pack.mod || typeof pack.mod !== "object") throw new Error("pack.json: missing mod");
  requireString(pack.mod, "id", "pack.json.mod");
  requireString(pack.mod, "version", "pack.json.mod");
  if (!pack.launch || typeof pack.launch !== "object") throw new Error("pack.json: missing launch");
  requireString(pack.launch, "type", "pack.json.launch");
  requireString(pack.launch, "profile", "pack.json.launch");
  requireString(pack.launch, "saveFile", "pack.json.launch");
  if (pack.platforms != null) {
    paths.validatePlatforms(pack.platforms, "pack.json.platforms");
    if (!Object.keys(pack.platforms).length) throw new Error("pack.json.platforms: no profiles");
    for (const [variant, profile] of Object.entries(pack.platforms)) {
      if (!profile.exe) throw new Error(`pack.json.platforms.${variant}: missing exe`);
      if (!profile.gameProcess) throw new Error(`pack.json.platforms.${variant}: missing gameProcess`);
    }
  } else {
    requireString(pack.launch, "exe", "pack.json.launch");
    requireString(pack.launch, "gameProcess", "pack.json.launch");
  }
  if (pack.launch.mode != null && !["default", "alternate-exe", "loader"].includes(pack.launch.mode)) {
    throw new Error("pack.json.launch: mode must be default, alternate-exe, or loader");
  }
  if (pack.launch.defaultExe != null && typeof pack.launch.defaultExe !== "string") {
    throw new Error("pack.json.launch: defaultExe must be a string");
  }
  requireString(pack, "files", "pack.json");
  if (!pack.art || typeof pack.art !== "object") throw new Error("pack.json: missing art");
  for (const key of ["grid", "hero", "logo", "icon"]) {
    if (typeof pack.art[key] !== "string" || !pack.art[key]) {
      // art is optional for the core, but the dashboard expects grid/icon
      if (key === "grid" || key === "icon") throw new Error(`pack.json.art: missing ${key}`);
    }
  }
  validateNotes(pack.notes);
  validatePreconditions(pack.preconditions);
  return pack;
}

function validateFiles(doc, pack) {
  if (!doc || doc.schema !== 1) throw new Error("files.json: schema must be 1");
  if (doc.pack !== pack.id) throw new Error("files.json: pack id mismatch");
  if (!Array.isArray(doc.files) || doc.files.length === 0) throw new Error("files.json: no files");
  const seen = new Map();
  for (const f of doc.files) {
    for (const key of ["source", "target", "sha256", "size"]) {
      if (f[key] == null) throw new Error(`files.json: missing ${key}`);
    }
    if (typeof f.source !== "string") throw new Error("files.json: bad source path");
    validateTarget(f.target);
    const key = f.target.toLowerCase();
    if (seen.has(key)) throw new Error(`files.json: targets collide on case-insensitive systems: ${f.target} and ${seen.get(key)}`);
    seen.set(key, f.target);
    if (f.platforms != null) validatePlatformList(f.platforms, `files.json: ${f.target} platforms`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`files.json: bad sha256 for ${f.source}`);
    if (!Number.isFinite(f.size)) throw new Error(`files.json: bad size for ${f.source}`);
  }
  return doc;
}

function loadPack(packRoot) {
  const pack = validatePack(readJson(path.join(packRoot, "pack.json")));
  const filesPath = safeJoin(packRoot, pack.files);
  if (!fs.existsSync(filesPath)) throw new Error(`missing ${pack.files}`);
  const files = validateFiles(readJson(filesPath), pack);
  return { pack, files, packRoot };
}

function packSummary(packRoot) {
  const { pack, files } = loadPack(packRoot);
  let totalBytes = 0;
  for (const f of files.files) totalBytes += f.size;
  const stats = paths.platformStats(files.files);
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description || "",
    game: pack.game,
    platforms: pack.platforms || null,
    mod: pack.mod,
    launch: pack.launch,
    loader: pack.loader || null,
    install: pack.install || null,
    contents: pack.contents || null,
    art: pack.art,
    notes: pack.notes || [],
    preconditions: pack.preconditions || [],
    files: files.files.length,
    totalBytes,
    platformFiles: Object.fromEntries(paths.VARIANTS.map((variant) => [variant, stats[variant].files])),
    platformBytes: Object.fromEntries(paths.VARIANTS.map((variant) => [variant, stats[variant].totalBytes])),
  };
}

module.exports = { validatePack, validateFiles, loadPack, packSummary };
