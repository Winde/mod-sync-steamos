const fs = require("node:fs");
const path = require("node:path");
const {
  ensureDir, materialize, readJson, writeJson, safeJoin, walkFiles, isGameRunning,
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
  const existed = fs.existsSync(dir);
  const owned = !existed || fs.existsSync(path.join(dir, ".modsync-bg3le"));
  ensureDir(dir);
  fs.cpSync(source, dir, { recursive: true, force: true });
  fs.chmodSync(path.join(dir, "build", "libbg3le.so"), 0o644);
  fs.writeFileSync(path.join(dir, ".modsync-bg3le"), "bundled by ModSync\n");

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
    created: owned,
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
    if (!fs.existsSync(real)) {
      throw new Error(`Cannot restore ${bg3}: ${real} is missing. Reinstall the game files, then retry uninstall.`);
    }
    fs.rmSync(bg3, { force: true });
    fs.renameSync(real, bg3);
  } else if (fs.existsSync(real)) {
    // Steam replaced bin/bg3 with a fresh game binary; keep it and drop the stale copy.
    fs.rmSync(real, { force: true });
  }
  if (loader.dir && loader.created !== false) {
    fs.rmSync(loader.dir, { recursive: true, force: true });
  }
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

function planRevert({ pack, root }) {
  const packRoot = path.join(root, "packs", pack.id);
  const applied = readApplied(packRoot);
  const errors = [];
  const warnings = [];
  const actions = [];
  if (!applied) {
    return {
      ok: true,
      errors,
      warnings,
      actions: ["Remove the pack directory (no applied game files were recorded)"],
      applied: null,
    };
  }

  if (isGameRunning(["bg3", "bg3.bg3le-real"])) {
    errors.push("Baldur's Gate 3 is running. Close it before uninstalling.");
  }

  const roots = { data: applied.dataDir, game: applied.gameRoot };
  for (const [scope, base] of Object.entries(roots)) {
    const list = applied[scope] || [];
    if (list.length && !base) errors.push(`The ${scope} install path is missing.`);
    if (base && list.length) {
      try { fs.accessSync(base, fs.constants.W_OK); } catch { errors.push(`No write access to ${base}.`); }
    }
  }

  for (const entry of applied.backups || []) {
    const backup = backupPath(packRoot, entry.scope, entry.rel);
    if (!fs.existsSync(backup)) errors.push(`Missing backup for ${entry.scope}/${entry.rel}; refusing to uninstall.`);
    if (!roots[entry.scope]) errors.push(`No ${entry.scope} install path for ${entry.rel}.`);
  }

  if (applied.data && applied.data.length) {
    actions.push(`Remove ${applied.data.length} pack file(s) from the game data folder`);
  }
  if (applied.game && applied.game.length) {
    actions.push(`Remove ${applied.game.length} game file(s) from the game folder`);
  }
  if (applied.backups && applied.backups.length) {
    actions.push(`Restore ${applied.backups.length} original file(s) from backup`);
  }

  if (applied.nativeLoader) {
    const bg3 = applied.gameRoot ? path.join(applied.gameRoot, "bin", "bg3") : "";
    const real = applied.gameRoot ? path.join(applied.gameRoot, "bin", "bg3.bg3le-real") : "";
    if (bg3 && isBg3leWrapper(bg3)) {
      if (!fs.existsSync(real)) {
        errors.push(`Cannot restore the original game binary: ${real} is missing.`);
      } else {
        actions.push("Restore the original Baldur's Gate 3 executable");
      }
    } else if (real && fs.existsSync(real)) {
      warnings.push("Steam replaced bin/bg3; the stale BG3LE copy will be removed.");
    } else {
      warnings.push("The BG3LE wrapper is absent; no game executable change to undo.");
    }

    if (applied.nativeLoader.dir) {
      if (applied.nativeLoader.created === false) {
        warnings.push("The BG3LE directory existed before this pack and will be left in place.");
      } else if (fs.existsSync(applied.nativeLoader.dir)) {
        actions.push(`Remove the bundled BG3LE directory ${applied.nativeLoader.dir}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, actions, applied };
}

function revertBg3({ pack, root, log = () => {}, dryRun = false }) {
  const plan = planRevert({ pack, root });
  if (!plan.ok) throw new Error(`Uninstall preflight failed: ${plan.errors.join("; ")}`);
  if (dryRun) return { ...plan, reverted: false, dryRun: true };
  const applied = plan.applied;
  if (!applied) return { reverted: false };
  const packRoot = path.join(root, "packs", pack.id);
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
  plan: planRevert,
  rollback,
  dataDirFor,
  readApplied,
};
