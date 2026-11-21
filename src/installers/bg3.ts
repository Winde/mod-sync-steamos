import fs from "node:fs";
import path from "node:path";
import { ensureDir, safeJoin, walkFiles } from "../util";
import * as overlay from "./overlay";
import * as paths from "../paths";
import * as steam from "../steam";
import type { Pack, SteamGame } from "../types";
import type { OverlayState } from "./overlay";

export function dataDirFor(
  pack: Pack,
  game: SteamGame | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const target = paths.resolve(pack, game, platform);
  if (!target.dataDir) {
    throw new Error(target.error || `Baldur's Gate 3 data directory is not configured for ${target.variant}.`);
  }
  return target.dataDir;
}

const WRAPPER_MARKER = "# ModSync BG3LE wrapper";

function isBg3leWrapper(file: string): boolean {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/, 4).includes(WRAPPER_MARKER);
  } catch {
    return false;
  }
}

function bg3leDirFor(platform: NodeJS.Platform = process.platform): string {
  return path.join(paths.contextFor(null, platform).dataHome, "bg3le");
}

function writeBg3leWrapper(file: string, lib: string): void {
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

export interface AppliedNativeLoader {
  dir: string;
  created: boolean;
  wrapper: string;
  real: string;
  lib: string;
}

export interface AppliedState extends OverlayState {
  nativeLoader?: AppliedNativeLoader;
}

function installNativeLoader({
  packRoot,
  pack,
  version,
  gameRoot,
  platform = process.platform,
}: {
  packRoot: string;
  pack: Pack;
  version: string;
  gameRoot: string;
  platform?: NodeJS.Platform;
}): AppliedNativeLoader {
  const versioned = path.join(packRoot, "mods", pack.mod.id, "versions", version, "tools", "bg3le");
  const source = fs.existsSync(versioned) ? versioned : path.join(packRoot, "tools", "bg3le");
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

function removeNativeLoader(applied: AppliedState): void {
  const loader = applied.nativeLoader;
  const gameRoot = applied.roots.game;
  if (!loader || !gameRoot) return;
  const bg3 = safeJoin(gameRoot, loader.wrapper);
  const real = safeJoin(gameRoot, loader.real);
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

export function readApplied(packRoot: string): AppliedState | null {
  return overlay.readState(packRoot) as AppliedState | null;
}

export function applyBg3({
  pack,
  root,
  game,
  version,
  platform = process.platform,
  log = () => {},
}: {
  pack: Pack;
  root: string;
  game: SteamGame | null | undefined;
  version: string;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}): AppliedState {
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
    removeNativeLoader(previous);
    overlay.clearState(packRoot, previous);
  }

  const applied = overlay.createState({
    packId: pack.id,
    version,
    platform: target.variant,
    roots: { data: dataDir, game: gameRoot },
  }) as AppliedState;

  const modsSrc = path.join(src, "Mods");
  const paks = fs.existsSync(modsSrc)
    ? fs.readdirSync(modsSrc).filter((name) => name.toLowerCase().endsWith(".pak"))
    : [];
  for (const name of paks) {
    overlay.applyFile({
      packRoot,
      state: applied,
      scope: "data",
      rel: `Mods/${name}`,
      source: path.join(modsSrc, name),
      link: true,
    });
  }

  const profileSrc = path.join(src, "modsettings.lsx");
  if (fs.existsSync(profileSrc)) {
    overlay.applyFile({
      packRoot,
      state: applied,
      scope: "data",
      rel: "PlayerProfiles/Public/modsettings.lsx",
      source: profileSrc,
    });
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
      overlay.applyFile({
        packRoot,
        state: applied,
        scope: "game",
        rel,
        source,
      });
    }
  }

  const extSrc = path.join(src, "Script Extender");
  if (fs.existsSync(extSrc)) {
    for (const file of walkFiles(extSrc)) {
      overlay.applyFile({
        packRoot,
        state: applied,
        scope: "data",
        rel: `Script Extender/${file.rel}`,
        source: file.abs,
      });
    }
  }

  if (native) {
    applied.nativeLoader = installNativeLoader({ packRoot, pack, version, gameRoot, platform });
    log(`Native loader: ${applied.nativeLoader.wrapper} preloads ${applied.nativeLoader.lib}`);
  }

  overlay.writeState(packRoot, applied);
  const gameFiles = applied.files.filter((entry) => entry.scope === "game").length;
  log(`Applied BG3 ${version} for ${target.variant}: ${paks.length} mods, ${gameFiles} loader files.`);
  return applied;
}

export interface RevertPlan {
  ok: boolean;
  errors: string[];
  warnings: string[];
  actions: string[];
  applied: AppliedState | null;
}

export function planRevert({ pack, root }: { pack: Pack; root: string }): RevertPlan {
  const packRoot = path.join(root, "packs", pack.id);
  const applied = readApplied(packRoot);
  const errors: string[] = [];
  const warnings: string[] = [];
  const actions: string[] = [];
  if (!applied) {
    return {
      ok: true,
      errors,
      warnings,
      actions: ["Remove the pack directory (no applied game files were recorded)"],
      applied: null,
    };
  }

  const plan = overlay.planState({
    packRoot,
    state: applied,
    processNames: ["bg3", "bg3.bg3le-real"],
    processLabel: "Baldur's Gate 3",
  });
  errors.push(...plan.errors);
  warnings.push(...plan.warnings);
  actions.push(...plan.actions);

  if (applied.nativeLoader) {
    const gameRoot = applied.roots.game;
    const bg3 = gameRoot ? path.join(gameRoot, "bin", "bg3") : "";
    const real = gameRoot ? path.join(gameRoot, "bin", "bg3.bg3le-real") : "";
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

export function revertBg3({
  pack,
  root,
  log = () => {},
  dryRun = false,
}: {
  pack: Pack;
  root: string;
  log?: (message: string) => void;
  dryRun?: boolean;
}): { reverted: boolean; version?: string; dryRun?: boolean; [key: string]: unknown } {
  const plan = planRevert({ pack, root });
  if (!plan.ok) throw new Error(`Uninstall preflight failed: ${plan.errors.join("; ")}`);
  if (dryRun) return { ...plan, reverted: false, dryRun: true };
  const applied = plan.applied;
  if (!applied) return { reverted: false };
  const packRoot = path.join(root, "packs", pack.id);
  removeNativeLoader(applied);
  overlay.clearState(packRoot, applied);
  log(`Reverted BG3 files for ${applied.version}.`);
  return { reverted: true, version: applied.version };
}

export function rollback({
  pack,
  root,
  version,
  log = () => {},
}: {
  pack: Pack;
  root: string;
  version: string;
  log?: (message: string) => void;
}): AppliedState {
  const game: SteamGame | null = steam.findGame(pack.game) || null;
  if (!game) throw new Error(`${pack.game.title} was not found in the Steam libraries.`);
  return applyBg3({ pack, root, game, version, log });
}

export {
  applyBg3 as apply,
  revertBg3 as revert,
  planRevert as plan,
};
