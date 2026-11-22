import fs from "node:fs";
import path from "node:path";
import { ensureDir, walkFiles } from "../util";
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

/**
 * The native Linux build must keep Steam's own `bin/bg3` in place. BG3LE
 * identifies the game process by the basename of /proc/self/exe and refuses
 * to attach to anything else, so renaming the game binary disables it. The
 * loader lives in the same per-user layout its own installer uses instead.
 */
function bg3leDirFor(platform: NodeJS.Platform = process.platform): string {
  return path.join(paths.contextFor(null, platform).dataHome, "bg3le");
}

function firstFile(candidates: readonly string[]): string | null {
  for (const file of candidates) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

export interface AppliedNativeLoader {
  dir: string;
  created: boolean;
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
  const libSource = firstFile([
    path.join(source, "lib", "libbg3le.so"),
    path.join(source, "build", "libbg3le.so"),
  ]);
  if (!libSource) throw new Error(`Bundled BG3LE is missing: ${source}`);
  const launchSource = firstFile([
    path.join(source, "bin", "bg3le-launch"),
    path.join(source, "installer", "bg3le-launch"),
  ]);
  const clientSource = firstFile([path.join(source, "client", "bg3lua")]);
  const versionSource = firstFile([path.join(source, "VERSION")]);

  const bg3 = path.join(gameRoot, "bin", "bg3");
  if (!fs.existsSync(bg3)) throw new Error(`Baldur's Gate 3 native executable not found: ${bg3}`);

  const dir = bg3leDirFor(platform);
  const existed = fs.existsSync(dir);
  const owned = !existed || fs.existsSync(path.join(dir, ".modsync-bg3le"));
  ensureDir(path.join(dir, "lib"));
  fs.copyFileSync(libSource, path.join(dir, "lib", "libbg3le.so"));
  fs.chmodSync(path.join(dir, "lib", "libbg3le.so"), 0o644);
  if (launchSource) {
    ensureDir(path.join(dir, "bin"));
    fs.copyFileSync(launchSource, path.join(dir, "bin", "bg3le-launch"));
    fs.chmodSync(path.join(dir, "bin", "bg3le-launch"), 0o755);
  }
  if (clientSource) {
    ensureDir(path.join(dir, "client"));
    fs.copyFileSync(clientSource, path.join(dir, "client", "bg3lua"));
    fs.chmodSync(path.join(dir, "client", "bg3lua"), 0o755);
  }
  const versionText = versionSource ? fs.readFileSync(versionSource, "utf8").trim() : "";
  fs.writeFileSync(path.join(dir, "version"), `${versionText || `bg3le-bundled-${version}`}\n`);
  fs.writeFileSync(path.join(dir, ".modsync-bg3le"), "bundled by ModSync\n");

  return {
    dir,
    created: owned,
    lib: path.join(dir, "lib", "libbg3le.so"),
  };
}

function removeNativeLoader(applied: AppliedState): void {
  const loader = applied.nativeLoader;
  if (!loader) return;
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
    log(`Native loader: installed ${applied.nativeLoader.lib}; the game binary is left untouched.`);
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
    processNames: ["bg3"],
    processLabel: "Baldur's Gate 3",
  });
  errors.push(...plan.errors);
  warnings.push(...plan.warnings);
  actions.push(...plan.actions);

  if (applied.nativeLoader) {
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
