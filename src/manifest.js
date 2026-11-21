const fs = require("node:fs");
const path = require("node:path");
const { readJson, safeJoin } = require("./util");

function requireString(obj, key, where) {
  if (!obj || typeof obj[key] !== "string" || !obj[key]) throw new Error(`${where}: missing ${key}`);
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
  requireString(pack.launch, "exe", "pack.json.launch");
  requireString(pack.launch, "gameProcess", "pack.json.launch");
  requireString(pack.launch, "profile", "pack.json.launch");
  requireString(pack.launch, "saveFile", "pack.json.launch");
  requireString(pack, "files", "pack.json");
  if (!pack.art || typeof pack.art !== "object") throw new Error("pack.json: missing art");
  for (const key of ["grid", "hero", "logo", "icon"]) {
    if (typeof pack.art[key] !== "string" || !pack.art[key]) {
      // art is optional for the core, but the dashboard expects grid/icon
      if (key === "grid" || key === "icon") throw new Error(`pack.json.art: missing ${key}`);
    }
  }
  return pack;
}

function validateFiles(doc, pack) {
  if (!doc || doc.schema !== 1) throw new Error("files.json: schema must be 1");
  if (doc.pack !== pack.id) throw new Error("files.json: pack id mismatch");
  if (!Array.isArray(doc.files) || doc.files.length === 0) throw new Error("files.json: no files");
  for (const f of doc.files) {
    for (const key of ["source", "target", "sha256", "size"]) {
      if (f[key] == null) throw new Error(`files.json: missing ${key}`);
    }
    if (typeof f.source !== "string" || typeof f.target !== "string") throw new Error("files.json: bad path");
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
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description || "",
    game: pack.game,
    mod: pack.mod,
    art: pack.art,
    files: files.files.length,
    totalBytes,
  };
}

module.exports = { validatePack, validateFiles, loadPack, packSummary };
