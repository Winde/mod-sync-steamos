const fs = require("node:fs");
const path = require("node:path");
const {
  ensureDir, materialize, readJson, writeJson, safeJoin, walkFiles,
} = require("../util");
const paths = require("../paths");
const steam = require("../steam");

function dataDirFor(pack, game, platform = process.platform) {
  const target = paths.resolve(pack, game, platform);
  if (!target.dataDir) {
    throw new Error(target.error || `Baldur's Gate 3 data directory is not configured for ${target.variant}.`);
  }
  return target.dataDir;
}

const WRAPPER_MARKER = "# ModSync BG3LE wrapper";

function isBg3leWrapper(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/, 4).includes(WRAPPER_MARKER);
  } catch {
    return false;
  }
}

function bg3leDirFor(platform = process.platform) {
  return path.join(paths.contextFor(null, platform).dataHome, "bg3le");
}

function writeBg3leWrapper(file, lib) {
  const body = [
    "#!/bin/sh",
    WRAPPER_MARKER,
    'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    `so=${JSON.stringify(lib)}`,
    'if [ -f "$so" ]; then',
    '  case ":${LD_PRELOAD:-}:" in',
    '    *":$so:"*) ;;',
    '    *) LD_PRELOAD="${LD_PRELOAD:+$LD_PRELOAD:}$so"; export LD_PRELOAD ;;',
    "  esac",
    "fi",
    'exec "$here/bg3.bg3le-real" "$@"',
    "",
  ].join("\n");
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function installNativeLoader({ packRoot, gameRoot, platform = process.platform }) {
  const source = path.join(packRoot, "tools", "bg3le");
  const libSource = path.join(source, "build", "libbg3le.so");
  if (!fs.existsSync(libSource)) {
    throw new Error(`Bundled BG3LE is missing: ${libSource}`);
  }
  const dir = bg3leDirFor(platform);
  ensureDir(dir);
  fs.cpSync(source, dir, { recursive: true, force: true });
  fs.chmodSync(path.join(dir, "build", "libbg3le.so"), 0o644);

  const bg3 = path.join(gameRoot, "bin", "bg3");
  const real = path.join(gameRoot, "bin", "bg3.bg3le-real");
  if (!fs.existsSync(bg3)) throw new Error(`Baldur's Gate 3 native executable not found: ${bg3}`);

  if (isBg3leWrapper(bg3)) {
    if (!fs.existsSync(real)) throw new Error(`BG3LE wrapper is present but ${real} is missing. Reinstall the game files.`);
  } else {
    if (fs.existsSync(real)) fs.rmSync(real, { force: true });
    fs.renameSync(bg3, real);
    writeBg3leWrapper(bg3, path.join(dir, "build", "libbg3le.so"));
  }

  return {
    dir,
    wrapper: "bin/bg3",
    real: "bin/bg3.bg3le-real",
    lib: path.join(dir, "build", "libbg3le.so"),
  };
}

function removeNativeLoader(applied) {
  const loader = applied.nativeLoader;
  if (!loader || !applied.gameRoot) return;
  const bg3 = safeJoin(applied.gameRoot, loader.wrapper);
  const real = safeJoin(applied.gameRoot, loader.real);
  if (fs.existsSync(bg3) && isBg3leWrapper(bg3)) {
    fs.rmSync(bg3, { force: true });
    if (fs.existsSync(real)) fs.renameSync(real, bg3);
  } else if (fs.existsSync(real)) {
    // Steam replaced bin/bg3 with a fresh game binary; keep it and drop the stale copy.
    fs.rmSync(real, { force: true });
  }
  if (loader.dir) fs.rmSync(loader.dir, { recursive: true, force: true });
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
  removeNativeLoader(applied);
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

function applyBg3({ pack, root, game, version, platform = process.platform, log = () => {} }) {
  const packRoot = path.join(root, "packs", pack.id);
  const src = path.join(packRoot, "mods", pack.mod.id, "versions", version);
  if (!fs.existsSync(src)) throw new Error(`BG3 version payload is missing: ${src}`);
  const target = paths.resolve(pack, game, platform);
  const dataDir = dataDirFor(pack, game, platform);
  const gameRoot = game && game.root ? game.root : "";
  if (!gameRoot) throw new Error("Baldur's Gate 3 game root was not found.");
  const native = target.variant === "linux-native";

  const previous = readApplied(packRoot);
  if (previous) {
    log(`Removing applied files for ${previous.version}...`);
    removeApplied(packRoot, previous);
    restoreBackups(packRoot, previous);
  }

  const applied = {
    packId: pack.id,
    version,
    platform: target.variant,
    dataDir,
    gameRoot,
    data: [],
    game: [],
    backups: [],
    skipped: [],
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

  if (native) {
    applied.skipped.push("bg3se");
    log("Native Linux build: skipped the Windows Script Extender binaries.");
  } else {
    for (const [name, rel] of [
      ["DWrite.dll", "bin/DWrite.dll"],
      ["ScriptExtenderSettings.json", "bin/ScriptExtenderSettings.json"],
    ]) {
      const source = path.join(src, "bg3se", name);
      if (!fs.existsSync(source)) continue;
      if (backupFile(packRoot, "game", gameRoot, rel)) {
        applied.backups.push({ scope: "game", rel });
      }
      const file = safeJoin(gameRoot, rel);
      ensureDir(path.dirname(file));
      fs.copyFileSync(source, file);
      applied.game.push(rel);
    }
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

  if (native) {
    applied.nativeLoader = installNativeLoader({ packRoot, gameRoot, platform });
    log(`Native loader: ${applied.nativeLoader.wrapper} preloads ${applied.nativeLoader.lib}`);
  }

  writeJson(appliedFile(packRoot), applied);
  log(`Applied BG3 ${version} for ${target.variant}: ${paks.length} mods, ${applied.game.length} loader files.`);
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

function rollback({ pack, root, version, log = () => {} }) {
  const game = steam.findGame(pack.game);
  if (!game) throw new Error(`${pack.game.title} was not found in the Steam libraries.`);
  return applyBg3({ pack, root, game, version, log });
}

module.exports = {
  apply: applyBg3,
  revert: revertBg3,
  applyBg3,
  revertBg3,
  rollback,
  dataDirFor,
  readApplied,
};
