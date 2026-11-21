import fs from "node:fs";
import path from "node:path";
import {
  ensureDir,
  isGameRunning,
  nowStamp,
  readJson,
  safeJoin,
  walkFiles,
  writeJson,
} from "../util";
import * as paths from "../paths";
import * as steam from "../steam";
import * as versionStore from "../version-store";
import { extractTar, listTarEntries, validateTarEntries } from "../tar";
import type {
  AdapterPlan,
  InfinityApplied,
  InfinityManifest,
  Pack,
  SteamGame,
} from "../types";

/**
 * Generic Infinity Engine snapshot adapter.
 *
 * It applies a `payload.tar.gz` containing `override/` and `root/` to a game
 * root, backs up every file it replaces, and optionally performs the
 * InfinityLoader executable swap declared in `modsync.json`. Nothing here is
 * game-specific: BG1EE, BG2EE, IWDEE and PSTEE use the same layout.
 */

const APPLIED = "infinity-applied.json";
const ARCHIVE = "payload.tar.gz";

function appliedFile(packRoot: string): string {
  return path.join(packRoot, APPLIED);
}

function readApplied(packRoot: string): InfinityApplied | null {
  try {
    return readJson<InfinityApplied>(appliedFile(packRoot));
  } catch {
    return null;
  }
}

function writeApplied(packRoot: string, applied: InfinityApplied): void {
  writeJson(appliedFile(packRoot), applied);
}

function backupPath(packRoot: string, rel: string): string {
  return path.join(packRoot, "backups", "game", rel);
}

function backupExisting(packRoot: string, applied: InfinityApplied, gameRoot: string, rel: string): void {
  const target = safeJoin(gameRoot, rel);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return;
  const backup = backupPath(packRoot, rel);
  if (!fs.existsSync(backup)) {
    ensureDir(path.dirname(backup));
    fs.copyFileSync(target, backup);
  }
  if (!applied.backups.includes(rel)) applied.backups.push(rel);
}

function copyIntoGame({
  packRoot,
  applied,
  gameRoot,
  source,
  rel,
}: {
  packRoot: string;
  applied: InfinityApplied;
  gameRoot: string;
  source: string;
  rel: string;
}): void {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Pack file missing: ${source}`);
  backupExisting(packRoot, applied, gameRoot, rel);
  const target = safeJoin(gameRoot, rel);
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
  if (!applied.files.includes(rel)) applied.files.push(rel);
}

function weiduTp2s(gameRoot: string): string[] {
  const file = path.join(gameRoot, "WeiDU.log");
  if (!fs.existsSync(file)) return [];
  const out: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^~([^~]+)~/.exec(line.trim());
    if (match) out.push(match[1].replace(/\\/g, "/").toLowerCase());
  }
  return out;
}

function processNames(pack: Pack): string[] {
  const names = new Set<string>();
  if (pack.launch.gameProcess) names.add(pack.launch.gameProcess);
  if (pack.launch.gameProcessAlt) names.add(pack.launch.gameProcessAlt);
  for (const profile of Object.values(pack.platforms || {})) {
    if (profile.gameProcess) names.add(profile.gameProcess);
    if (profile.gameProcessAlt) names.add(profile.gameProcessAlt);
  }
  return [...names].filter(Boolean);
}

function restoreOverlay({
  packRoot,
  gameRoot,
  applied,
}: {
  packRoot: string;
  gameRoot: string;
  applied: InfinityApplied;
}): void {
  for (const rel of applied.files) {
    try { fs.rmSync(safeJoin(gameRoot, rel), { force: true }); } catch { /* already gone */ }
  }
  for (const rel of applied.backups) {
    const backup = backupPath(packRoot, rel);
    if (!fs.existsSync(backup)) continue;
    const target = safeJoin(gameRoot, rel);
    ensureDir(path.dirname(target));
    fs.copyFileSync(backup, target);
  }
  const override = path.join(gameRoot, "override");
  fs.rmSync(override, { recursive: true, force: true });
  if (applied.overrideBackup) {
    const backup = path.join(packRoot, applied.overrideBackup);
    if (fs.existsSync(backup)) fs.cpSync(backup, override, { recursive: true });
  } else if (applied.overrideExisted) {
    ensureDir(override);
  }
  if (applied.loader) {
    const gameExe = safeJoin(gameRoot, applied.loader.gameExe);
    const realExe = safeJoin(gameRoot, applied.loader.realExe);
    if (!applied.loader.wasLoader) {
      if (applied.loader.gameExeBackup && fs.existsSync(backupPath(packRoot, applied.loader.gameExeBackup))) {
        fs.copyFileSync(backupPath(packRoot, applied.loader.gameExeBackup), gameExe);
      } else if (applied.loader.createdReal && fs.existsSync(realExe)) {
        fs.renameSync(realExe, gameExe);
      }
      if (applied.loader.createdReal && fs.existsSync(realExe)) fs.rmSync(realExe, { force: true });
    }
  }
}

function applyVersion({
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
}): InfinityApplied {
  if (!game || !game.root) throw new Error(`${pack.game.title} was not found.`);
  const gameRoot = game.root;
  const target = paths.resolve(pack, game, platform);
  if (target.variant === "linux-native" && pack.loader) {
    throw new Error("This pack uses InfinityLoader, which requires Windows or Proton; native Linux is not supported.");
  }
  if (isGameRunning(processNames(pack))) throw new Error(`${pack.game.title} is running. Close it before installing.`);
  const packRoot = versionStore.packRoot(root, pack.id);
  const versionDir = versionStore.versionDir(packRoot, pack.mod.id, version);
  const archive = path.join(versionDir, ARCHIVE);
  if (!fs.existsSync(archive)) throw new Error(`Snapshot archive is missing: ${archive}`);

  const entries = listTarEntries(archive);
  validateTarEntries(entries, ["override", "root", "meta", "modsync.json"]);

  const temp = path.join(gameRoot, `.modsync-infinity-${nowStamp()}`);
  fs.rmSync(temp, { recursive: true, force: true });
  ensureDir(temp);
  let applied: InfinityApplied | null = null;
  try {
    extractTar(archive, temp);
    const manifest = readJson<InfinityManifest>(path.join(temp, "modsync.json"));
    const previous = readApplied(packRoot);
    if (previous) {
      log(`Restoring the previous ${previous.version} state...`);
      restoreOverlay({ packRoot, gameRoot, applied: previous });
      fs.rmSync(appliedFile(packRoot), { force: true });
    }

    const allowedPrep = new Set(manifest.basePrep.map((tp2) => tp2.toLowerCase()));
    const targetMods = weiduTp2s(gameRoot);
    if (targetMods.length && !targetMods.every((tp2) => allowedPrep.has(tp2))) {
      throw new Error(
        "This game already has a WeiDU install. Start from a clean game, " +
        `or install only the declared base-preparation mods (${manifest.basePrep.join(", ") || "none"}).`,
      );
    }
    const override = path.join(gameRoot, "override");
    if (!targetMods.length && fs.existsSync(override) && fs.readdirSync(override).length) {
      throw new Error("The game already has files in override/. Start from a clean install.");
    }

    const overrideSource = path.join(temp, manifest.override);
    if (!fs.existsSync(overrideSource)) throw new Error("Snapshot archive has no override/ directory.");
    const rootSource = path.join(temp, manifest.root);

    applied = {
      packId: pack.id,
      version,
      platform: target.variant,
      gameRoot,
      overrideExisted: fs.existsSync(override),
      overrideBackup: null,
      files: [],
      backups: [],
      loader: null,
      installedAt: new Date().toISOString(),
    };

    if (fs.existsSync(override)) {
      if (fs.readdirSync(override).length) {
        const backupRel = path.join("backups", `override-${nowStamp()}`);
        const backup = path.join(packRoot, backupRel);
        ensureDir(path.dirname(backup));
        fs.cpSync(override, backup, { recursive: true });
        applied.overrideBackup = backupRel;
      }
      fs.rmSync(override, { recursive: true, force: true });
    }
    fs.renameSync(overrideSource, override);
    log("Installed override/.");

    if (fs.existsSync(rootSource)) {
      for (const file of walkFiles(rootSource)) {
        copyIntoGame({ packRoot, applied, gameRoot, source: file.abs, rel: file.rel });
      }
    }

    if (manifest.loader) {
      const support = path.join(packRoot, manifest.loader.support);
      const fallback = path.join(versionDir, manifest.loader.support);
      const supportDir = fs.existsSync(support) ? support : fallback;
      if (!fs.existsSync(supportDir)) throw new Error(`Loader support folder is missing: ${manifest.loader.support}`);
      for (const name of manifest.loader.supportFiles) {
        copyIntoGame({
          packRoot,
          applied,
          gameRoot,
          source: path.join(supportDir, name),
          rel: name,
        });
      }
      const loaderPath = safeJoin(gameRoot, manifest.loader.exe);
      if (!fs.existsSync(loaderPath)) throw new Error(`InfinityLoader.exe is missing after apply: ${loaderPath}`);
      const gameExe = safeJoin(gameRoot, manifest.loader.gameExe);
      const realExe = safeJoin(gameRoot, manifest.loader.realExe);
      const loaderSize = fs.statSync(loaderPath).size;
      const gameExists = fs.existsSync(gameExe);
      const realExists = fs.existsSync(realExe);
      const wasLoader = gameExists && fs.statSync(gameExe).size === loaderSize;
      applied.loader = {
        gameExe: manifest.loader.gameExe,
        realExe: manifest.loader.realExe,
        wasLoader,
        createdReal: false,
        gameExeBackup: null,
      };
      if (!realExists) {
        if (!gameExists) throw new Error(`Game executable is missing: ${manifest.loader.gameExe}`);
        if (wasLoader) {
          throw new Error(
            `${manifest.loader.realExe} is missing and ${manifest.loader.gameExe} is already the loader; verify the game files.`,
          );
        }
        fs.renameSync(gameExe, realExe);
        applied.loader.createdReal = true;
      }
      if (!wasLoader) {
        backupExisting(packRoot, applied, gameRoot, manifest.loader.gameExe);
        applied.loader.gameExeBackup = manifest.loader.gameExe;
      }
      fs.copyFileSync(loaderPath, gameExe);
      if (process.platform !== "win32") fs.chmodSync(gameExe, 0o755);
      log(`Loader installed: ${manifest.loader.gameExe} -> ${manifest.loader.realExe}.`);
    }

    writeApplied(packRoot, applied);
    log(`Applied ${pack.name} ${version} for ${target.variant}.`);
    return applied;
  } catch (err) {
    if (applied) {
      try { restoreOverlay({ packRoot, gameRoot, applied }); } catch { /* best effort */ }
    }
    throw err;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function planRevert({ pack, root }: { pack: Pack; root: string }): AdapterPlan & { applied?: InfinityApplied | null } {
  const packRoot = versionStore.packRoot(root, pack.id);
  const applied = readApplied(packRoot);
  if (!applied) {
    return {
      ok: true,
      errors: [],
      warnings: [],
      actions: ["Remove the pack directory (no game files were applied)"],
      applied: null,
    };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const actions: string[] = [];
  const game = steam.findGame(pack.game);
  const detected = game?.root;
  const gameRoot = applied.gameRoot && fs.existsSync(applied.gameRoot) ? applied.gameRoot : detected;
  if (!gameRoot || !fs.existsSync(gameRoot)) {
    warnings.push("Game folder not found; only the pack files will be removed.");
    return { ok: true, errors, warnings, actions: ["Remove the pack directory"], applied };
  }
  if (isGameRunning(processNames(pack))) errors.push(`${pack.game.title} is running. Close it before uninstalling.`);
  for (const rel of applied.backups) {
    if (!fs.existsSync(backupPath(packRoot, rel))) errors.push(`Missing backup for ${rel}.`);
  }
  if (applied.overrideBackup && !fs.existsSync(path.join(packRoot, applied.overrideBackup))) {
    errors.push(`Missing override backup: ${applied.overrideBackup}.`);
  }
  if (applied.files.length) actions.push(`Remove ${applied.files.length} pack file(s) from the game folder`);
  if (applied.backups.length) actions.push(`Restore ${applied.backups.length} original file(s)`);
  if (applied.overrideBackup) actions.push("Restore the previous override/ folder");
  if (applied.loader) actions.push(`Restore ${applied.loader.gameExe}`);
  return { ok: errors.length === 0, errors, warnings, actions, applied };
}

export function applyInfinity({
  pack,
  root,
  game,
  version,
  platform,
  log = () => {},
}: {
  pack: Pack;
  root: string;
  game: SteamGame | null | undefined;
  version: string;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}): InfinityApplied {
  return applyVersion({ pack, root, game, version, platform, log });
}

export function revertInfinity({
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
  const packRoot = versionStore.packRoot(root, pack.id);
  const game = steam.findGame(pack.game);
  const gameRoot = applied.gameRoot && fs.existsSync(applied.gameRoot) ? applied.gameRoot : game?.root;
  if (gameRoot && fs.existsSync(gameRoot)) {
    restoreOverlay({ packRoot, gameRoot, applied });
  }
  fs.rmSync(appliedFile(packRoot), { force: true });
  log(`Reverted Infinity Engine files for ${applied.version}.`);
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
}): InfinityApplied {
  const game = steam.findGame(pack.game);
  if (!game) throw new Error(`${pack.game.title} was not found in the Steam libraries.`);
  return applyVersion({ pack, root, game, version, log });
}

export {
  applyInfinity as apply,
  revertInfinity as revert,
  planRevert as plan,
};
