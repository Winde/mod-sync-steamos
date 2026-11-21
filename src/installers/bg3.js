const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ensureDir, materialize, readJson, writeJson, safeJoin, walkFiles,
} = require("../util");

function dataDirFor(pack, game) {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Larian Studios", "Baldur's Gate 3");
  }
  if (!game || !game.prefix) throw new Error("Baldur's Gate 3 Proton prefix was not found. Launch the vanilla game once from Steam.");
  return path.join(game.prefix, pack.launch.dataDir || pack.install.dataDir);
}

function appliedFile(packRoot) {
  return path.join(packRoot, "applied.json");
}

function readApplied(packRoot) {
  try { return readJson(appliedFile(packRoot)); } catch { return null; }
}

function backupPath(packRoot, scope, rel) {
  return path.join(packRoot, "backups", scope, rel);
}

function backupFile(packRoot, scope, base, rel) {
  const target = safeJoin(base, rel);
  const backup = backupPath(packRoot, scope, rel);
  if (!fs.existsSync(target)) return fs.existsSync(backup);
  if (!fs.existsSync(backup)) {
    ensureDir(path.dirname(backup));
    fs.copyFileSync(target, backup);
  }
  return true;
}

function restoreBackups(packRoot, applied) {
  for (const entry of applied.backups || []) {
    const backup = backupPath(packRoot, entry.scope, entry.rel);
    if (!fs.existsSync(backup)) continue;
    const base = entry.scope === "game" ? applied.gameRoot : applied.dataDir;
    if (!base) continue;
    const target = safeJoin(base, entry.rel);
    ensureDir(path.dirname(target));
    fs.copyFileSync(backup, target);
  }
}

function removeApplied(packRoot, applied) {
  if (applied.dataDir) {
    for (const rel of applied.data || []) {
      try { fs.rmSync(safeJoin(applied.dataDir, rel), { force: true }); } catch { }
    }
  }
  if (applied.gameRoot) {
    for (const rel of applied.game || []) {
      try { fs.rmSync(safeJoin(applied.gameRoot, rel), { force: true }); } catch { }
    }
  }
}

function applyBg3({ pack, root, game, version, log = () => {} }) {
  const packRoot = path.join(root, "packs", pack.id);
  const src = path.join(packRoot, "mods", pack.mod.id, "versions", version);
  if (!fs.existsSync(src)) throw new Error(`BG3 version payload is missing: ${src}`);
  const dataDir = dataDirFor(pack, game);
  const gameRoot = game && game.root ? game.root : "";
  if (!gameRoot) throw new Error("Baldur's Gate 3 game root was not found.");

  const previous = readApplied(packRoot);
  if (previous) {
    log(`Removing applied files for ${previous.version}...`);
    removeApplied(packRoot, previous);
    restoreBackups(packRoot, previous);
  }

  const applied = {
    packId: pack.id,
    version,
    dataDir,
    gameRoot,
    data: [],
    game: [],
    backups: [],
  };

  const modsSrc = path.join(src, "Mods");
  const modsDst = path.join(dataDir, "Mods");
  ensureDir(modsDst);
  const paks = fs.existsSync(modsSrc)
    ? fs.readdirSync(modsSrc).filter((name) => name.toLowerCase().endsWith(".pak"))
    : [];
  for (const name of paks) {
    const rel = `Mods/${name}`;
    if (backupFile(packRoot, "data", dataDir, rel)) {
      applied.backups.push({ scope: "data", rel });
    }
    materialize(path.join(modsSrc, name), path.join(modsDst, name), true);
    applied.data.push(rel);
  }

  const profileSrc = path.join(src, "modsettings.lsx");
  if (fs.existsSync(profileSrc)) {
    const rel = "PlayerProfiles/Public/modsettings.lsx";
    if (backupFile(packRoot, "data", dataDir, rel)) {
      applied.backups.push({ scope: "data", rel });
    }
    const target = safeJoin(dataDir, rel);
    ensureDir(path.dirname(target));
    fs.copyFileSync(profileSrc, target);
    applied.data.push(rel);
  }

  for (const [name, rel] of [
    ["DWrite.dll", "bin/DWrite.dll"],
    ["ScriptExtenderSettings.json", "bin/ScriptExtenderSettings.json"],
  ]) {
    const source = path.join(src, "bg3se", name);
    if (!fs.existsSync(source)) continue;
    if (backupFile(packRoot, "game", gameRoot, rel)) {
      applied.backups.push({ scope: "game", rel });
    }
    const target = safeJoin(gameRoot, rel);
    ensureDir(path.dirname(target));
    fs.copyFileSync(source, target);
    applied.game.push(rel);
  }

  const extSrc = path.join(src, "Script Extender");
  if (fs.existsSync(extSrc)) {
    for (const file of walkFiles(extSrc)) {
      const rel = `Script Extender/${file.rel}`;
      if (backupFile(packRoot, "data", dataDir, rel)) {
        applied.backups.push({ scope: "data", rel });
      }
      const target = safeJoin(dataDir, rel);
      ensureDir(path.dirname(target));
      fs.copyFileSync(file.abs, target);
      applied.data.push(rel);
    }
  }

  writeJson(appliedFile(packRoot), applied);
  log(`Applied BG3 ${version}: ${paks.length} mods, ${applied.game.length} loader files.`);
  return applied;
}

function revertBg3({ pack, root, log = () => {} }) {
  const packRoot = path.join(root, "packs", pack.id);
  const applied = readApplied(packRoot);
  if (!applied) return { reverted: false };
  removeApplied(packRoot, applied);
  restoreBackups(packRoot, applied);
  fs.rmSync(appliedFile(packRoot), { force: true });
  log(`Reverted BG3 files for ${applied.version}.`);
  return { reverted: true, version: applied.version };
}

module.exports = { applyBg3, revertBg3, dataDirFor, readApplied };
