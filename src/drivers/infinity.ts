import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureDir,
  formatBytes,
  materialize,
  relPosix,
  sha256File,
  walkFiles,
  writeJson,
  writeText,
} from "../util";
import * as steam from "../steam";
import * as depot from "../steam-depot";
import * as paths from "../paths";
import * as infinityloader from "../loaders/infinityloader";
import { runTar } from "../tar";
import { projectRoot } from "../root";
import type {
  BuildOption,
  BuildPackOptions,
  BuildPackResult,
  ContentsInput,
  ContentsSummary,
  GameInfo,
  InfinityLoaderManifest,
  InfinityManifest,
  InstallInfo,
  LaunchInfo,
  LoaderInfo,
  Note,
  Pack,
  PackFile,
  PlatformProfile,
  Platforms,
  PreconditionConfig,
  Recipe,
  Variant,
} from "../types";

/**
 * Shared Infinity Engine snapshot builder.
 *
 * The EE games (BG1EE, BG2EE, IWDEE, PSTEE) all install WeiDU mods into
 * `override/` and patch the active `lang/<lang>/dialog.tlk`. The differences
 * are the Steam app/exe, optional InfinityLoader/EEex, and native Linux names;
 * the thin drivers in this directory only supply those table entries.
 *
 * Base files are identified from Steam's installed depot manifests, so the
 * builder does not depend on any particular mod set or a clean reference copy.
 */

export interface InfinityGame extends GameInfo {
  /** EEex/InfinityLoader is available for this game. */
  loaderSupported: boolean;
  /** Native Linux process name when it differs from the executable name. */
  nativeProcess?: string;
  /** Optional DLC app/depot (BG1EE Siege of Dragonspear). */
  dlcAppId?: number;
  dlcDepotIds?: number[];
  gameNotes?: Note[];
}

const BULK_DIRS = new Set(["data", "movies", "music", "bin", "dlc"]);
const SKIP_BASE_DIRS = new Set(["manuals"]);
const RUNTIME_DIRS = new Set(["scripts", "portraits", "worldmap", "eeex_scripts"]);
const SOURCE_ARTIFACT_DIRS = new Set([
  "_downloads",
  "weidu_external",
  "infinityloader_crash",
  ".openchamber",
  ".git",
  "node_modules",
]);

export const BG1: InfinityGame = {
  id: "bg1",
  title: "Baldur's Gate: Enhanced Edition",
  store: "steam",
  appId: 228280,
  installDir: "Baldur's Gate Enhanced Edition",
  exe: "Baldur.exe",
  linuxExe: "BaldursGate",
  nativeProcess: "BaldursGate",
  prefix: true,
  loaderSupported: true,
  dlcAppId: 385970,
  dlcDepotIds: [385970],
};

export const BG2: InfinityGame = {
  id: "bg2",
  title: "Baldur's Gate II: Enhanced Edition",
  store: "steam",
  appId: 257350,
  installDir: "Baldur's Gate II Enhanced Edition",
  exe: "Baldur.exe",
  linuxExe: "BaldursGateII",
  nativeProcess: "BaldursGateII",
  prefix: true,
  loaderSupported: true,
};

export const IWDEE: InfinityGame = {
  id: "iwdee",
  title: "Icewind Dale: Enhanced Edition",
  store: "steam",
  appId: 321800,
  installDir: "Icewind Dale Enhanced Edition",
  exe: "icewind.exe",
  linuxExe: "IcewindDale",
  nativeProcess: "IcewindDale",
  prefix: true,
  loaderSupported: true,
};

export const PSTEE: InfinityGame = {
  id: "pstee",
  title: "Planescape: Torment: Enhanced Edition",
  store: "steam",
  appId: 466300,
  installDir: "Planescape Torment Enhanced Edition",
  exe: "Torment.exe",
  linuxExe: "Torment64",
  nativeProcess: "Torment64",
  prefix: true,
  loaderSupported: false,
};

export interface WeiDUMod {
  tp2: string;
  folder: string;
  components: number;
}

export interface WeiDUInfo {
  components: number;
  mods: WeiDUMod[];
  lines: string[];
}

interface BuildOptions {
  includeDirs: string[];
  extraFiles: string[];
  includeBaseData: boolean;
}

export interface SelectedFiles {
  override: string;
  rootFiles: string[];
  dialogs: string[];
  modifiedBase: string[];
  warnings: string[];
  excluded: Array<{ path: string; reason: string }>;
  included: number;
  bytes: number;
}

export function defaultSourceFor(game: InfinityGame): string {
  const found = steam.findGame(game);
  if (found) return found.root;
  const libs = steam.libraries();
  if (libs.length) return path.join(libs[0], "steamapps", "common", game.installDir);
  return path.join(os.homedir(), ".steam", "steam", "steamapps", "common", game.installDir);
}

export function buildOptions(): BuildOption[] {
  return [
    {
      key: "includeDirs",
      label: "Extra runtime folders",
      type: "text",
      optional: true,
      placeholder: "folder1, folder2",
      help: "Comma-separated top-level folders that a mod loads at runtime even though WeiDU.log lists it as an installer source.",
    },
    {
      key: "extraFiles",
      label: "Extra runtime files",
      type: "text",
      optional: true,
      placeholder: "Worldmap/custom.tbl, scripts/custom.bs",
      help: "Comma-separated game-relative files or folders to force into the snapshot.",
    },
    {
      key: "includeBaseData",
      label: "Include bulk base data",
      type: "text",
      optional: true,
      placeholder: "no",
      help: "Type yes only for a total conversion that changes data/, lang/ voice data, movies/, music/, bin/ or dlc/.",
    },
  ];
}

function defaultVersion(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, ".");
}

function parseBuildOptions(driverOptions: Record<string, unknown> | undefined): BuildOptions {
  const split = (value: unknown): string[] => String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const flag = (value: unknown): boolean => {
    const text = String(value || "").trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(text);
  };
  return {
    includeDirs: split(driverOptions?.includeDirs).map((entry) => entry.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()),
    extraFiles: split(driverOptions?.extraFiles).map((entry) => entry.replace(/\\/g, "/").replace(/^\/+/, "")),
    includeBaseData: flag(driverOptions?.includeBaseData),
  };
}

export function parseWeiDU(text: string): WeiDUInfo {
  const lines: string[] = [];
  const mods = new Map<string, WeiDUMod>();
  let components = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("~")) continue;
    const match = /^~([^~]+)~/.exec(line);
    if (!match) continue;
    components++;
    lines.push(line);
    const tp2 = match[1].replace(/\\/g, "/");
    const key = tp2.toLowerCase();
    const folder = tp2.split("/")[0] || tp2;
    const entry = mods.get(key) || { tp2, folder, components: 0 };
    entry.components++;
    mods.set(key, entry);
  }
  return { components, mods: [...mods.values()], lines };
}

export function readWeiDU(source: string): WeiDUInfo {
  const file = path.join(source, "WeiDU.log");
  return fs.existsSync(file) ? parseWeiDU(fs.readFileSync(file, "utf8")) : { components: 0, mods: [], lines: [] };
}

export function readLanguage(source: string): string {
  const file = path.join(source, "weidu.conf");
  if (fs.existsSync(file)) {
    const match = /lang_dir\s*=\s*([^\s#;]+)/i.exec(fs.readFileSync(file, "utf8"));
    if (match) return match[1].trim();
  }
  return "en_US";
}

function isTlk(rel: string): boolean {
  return /^(?:lang\/[^/]+\/)?dialogf?\.tlk$/i.test(rel);
}

function isBulk(rel: string): boolean {
  const top = rel.split("/")[0].toLowerCase();
  return BULK_DIRS.has(top) || (top === "lang" && !isTlk(rel));
}

function isArtifact(rel: string): boolean {
  const lower = rel.toLowerCase();
  const base = lower.split("/").pop() || lower;
  if (lower.split("/").some((segment) => SOURCE_ARTIFACT_DIRS.has(segment))) return true;
  if (/^setup-/.test(base) || /\.debug$/.test(base)) return true;
  if (/^weidu\.(log|conf)$/.test(base)) return true;
  if (/\.bak(?:-|$)/.test(base)) return true;
  if (base.startsWith("_")) return true;
  if (/\.(?:log|dmp|md|html|txt|csv|tsv|bat|cmd|command|sh)$/.test(base)) return true;
  if (/\.(?:zip|7z|rar|tar|tgz|gz|exe|msi|dmg|pkg)$/.test(base)) return true;
  if (/^readme/i.test(base) || /^version history/i.test(base) || base === ".gitignore") return true;
  return false;
}

function sha1File(file: string): string {
  const hash = crypto.createHash("sha1");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function baseChanged(file: string, entry: depot.DepotFile | null): boolean {
  if (!entry) return false;
  const stat = fs.statSync(file);
  if (stat.size !== entry.size) return true;
  if (entry.sha1 && stat.size <= 8 * 1024 * 1024) return sha1File(file) !== entry.sha1;
  return false;
}

function realExeFor(gameExe: string): string {
  const ext = path.extname(gameExe);
  return `${path.basename(gameExe, ext)}Real${ext}`;
}

function gameExecutableName(game: InfinityGame, loader: infinityloader.LoaderInfo | null, rel: string): boolean {
  const lower = rel.toLowerCase();
  const names = new Set([
    game.exe,
    game.exe ? realExeFor(game.exe) : "",
    game.linuxExe,
    loader?.gameExe,
    loader?.realExe,
    loader?.exe,
    ...(loader?.supportFiles || []),
  ].filter((name): name is string => !!name).map((name) => path.basename(name).toLowerCase()));
  return names.has(lower);
}

function orphanedLoader(source: string, game: InfinityGame, loader: infinityloader.LoaderInfo | null): string | null {
  if (!game.loaderSupported || loader) return null;
  const artifacts = [
    "InfinityLoader.db",
    "InfinityLoaderCommon.dll",
    "InfinityLoaderDLL.dll",
    "LuaBindings.dll",
    "EEex.dll",
  ].filter((name) => fs.existsSync(path.join(source, name)));
  const gameExe = game.exe;
  if (!gameExe) return artifacts.length ? artifacts[0] : null;
  const real = realExeFor(gameExe);
  let swapped = false;
  try {
    swapped = fs.existsSync(path.join(source, real))
      && fs.existsSync(path.join(source, gameExe))
      && fs.statSync(path.join(source, gameExe)).size < 1024 * 1024;
  } catch { /* stat failed */ }
  if (!artifacts.length && !swapped) return null;
  return artifacts[0] || `${gameExe} (loader stub)`;
}

export function selectFiles({
  source,
  game,
  base,
  loader,
  options,
  weidu,
  language,
  log,
}: {
  source: string;
  game: InfinityGame;
  base: depot.BaseFileSet | null;
  loader: infinityloader.LoaderInfo | null;
  options: BuildOptions;
  weidu: WeiDUInfo;
  language: string;
  log: (message: string) => void;
}): SelectedFiles {
  const rootFiles = new Set<string>();
  const dialogs = new Set<string>();
  const modifiedBase = new Set<string>();
  const warnings: string[] = [];
  const excluded: Array<{ path: string; reason: string }> = [];
  let bytes = 0;
  let included = 0;

  const includeDirs = new Set(options.includeDirs);
  const modFolders = new Set(weidu.mods.map((mod) => mod.folder.toLowerCase()));
  const seen = new Set<string>();

  const consider = (rel: string, force = false): void => {
    const normalized = rel.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized || seen.has(normalized)) return;
    if (!force && gameExecutableName(game, loader, normalized)) {
      excluded.push({ path: normalized, reason: loader ? "loader/executable" : "game executable" });
      return;
    }
    if (!force && isArtifact(normalized)) {
      excluded.push({ path: normalized, reason: "installer/log/artifact" });
      return;
    }
    const abs = path.join(source, normalized);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
    const entry = depot.baseFile(base, normalized);
    if (entry) {
      if (!baseChanged(abs, entry)) {
        excluded.push({ path: normalized, reason: "unchanged base file" });
        return;
      }
      if (loader && gameExecutableName(game, loader, normalized)) {
        excluded.push({ path: normalized, reason: "loader/executable changed by the loader" });
        return;
      }
      if (isBulk(normalized) && !options.includeBaseData && !isTlk(normalized) && normalized.split("/")[0].toLowerCase() !== "scripts") {
        excluded.push({ path: normalized, reason: "modified base file in bulk data (set includeBaseData)" });
        warnings.push(`${normalized} is a modified base file under bulk data and was excluded.`);
        return;
      }
      seen.add(normalized);
      rootFiles.add(normalized);
      modifiedBase.add(normalized);
      if (isTlk(normalized)) dialogs.add(normalized);
      bytes += fs.statSync(abs).size;
      included++;
      warnings.push(`${normalized} is a modified base file and is included.`);
      return;
    }
    if (isBulk(normalized) && !options.includeBaseData) {
      excluded.push({ path: normalized, reason: "mod file in bulk base data (set includeBaseData)" });
      warnings.push(`${normalized} is not in the base manifest but is under bulk data and was excluded.`);
      return;
    }
    seen.add(normalized);
    rootFiles.add(normalized);
    if (isTlk(normalized)) dialogs.add(normalized);
    bytes += fs.statSync(abs).size;
    included++;
  };

  const override = path.join(source, "override");
  if (fs.existsSync(override)) {
    for (const file of walkFiles(override)) {
      const rel = `override/${file.rel}`;
      seen.add(rel);
      included++;
      bytes += file.size;
    }
  }

  for (const name of ["dialog.tlk", "dialogf.tlk"]) {
    const rel = `lang/${language}/${name}`;
    if (fs.existsSync(path.join(source, rel))) consider(rel);
  }
  for (const name of ["dialog.tlk", "dialogf.tlk"]) {
    if (fs.existsSync(path.join(source, name))) consider(name);
  }

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const name = entry.name;
    if (entry.isFile()) {
      consider(name);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const lower = name.toLowerCase();
    if (lower === "override") continue;
    if (SOURCE_ARTIFACT_DIRS.has(lower)) {
      excluded.push({ path: `${name}/`, reason: "installer/cache directory" });
      continue;
    }
    if (lower === "lang") {
      if (options.includeBaseData) {
        for (const file of walkFiles(path.join(source, name))) consider(`${name}/${file.rel}`);
      } else {
        excluded.push({ path: `${name}/`, reason: "base language data; active TLK handled separately" });
      }
      continue;
    }
    if (BULK_DIRS.has(lower) || SKIP_BASE_DIRS.has(lower)) {
      if (options.includeBaseData && BULK_DIRS.has(lower)) {
        for (const file of walkFiles(path.join(source, name))) consider(`${name}/${file.rel}`);
      } else {
        excluded.push({ path: `${name}/`, reason: SKIP_BASE_DIRS.has(lower) ? "base documentation" : "base data directory" });
      }
      continue;
    }
    if (modFolders.has(lower) && !includeDirs.has(lower)) {
      excluded.push({ path: `${name}/`, reason: "WeiDU installer source folder" });
      continue;
    }
    if (includeDirs.has(lower) || RUNTIME_DIRS.has(lower)) {
      for (const file of walkFiles(path.join(source, name))) consider(`${name}/${file.rel}`);
      continue;
    }
    excluded.push({ path: `${name}/`, reason: "unknown/tooling folder (set includeDirs if it is runtime)" });
  }

  for (const extra of options.extraFiles) {
    const abs = path.join(source, extra);
    if (!fs.existsSync(abs)) {
      warnings.push(`Extra file not found: ${extra}`);
      continue;
    }
    if (fs.statSync(abs).isDirectory()) {
      for (const file of walkFiles(abs)) consider(`${extra.replace(/\/+$/, "")}/${file.rel}`, true);
    } else {
      consider(extra, true);
    }
  }

  log(`Selected ${included} files, ${formatBytes(bytes)}; ${excluded.length} excluded paths.`);
  return {
    override: fs.existsSync(override) ? override : "",
    rootFiles: [...rootFiles],
    dialogs: [...dialogs],
    modifiedBase: [...modifiedBase],
    warnings,
    excluded,
    included,
    bytes,
  };
}

export function contentsForGame(game: InfinityGame, { source }: ContentsInput): ContentsSummary {
  const weidu = readWeiDU(source);
  if (weidu.mods.length) {
    return {
      source: "WeiDU.log",
      generatedAt: new Date().toISOString(),
      count: weidu.mods.length,
      itemsLabel: "Installed mods",
      items: weidu.mods.map((mod) => ({
        label: mod.components > 1 ? `${mod.folder} (${mod.components})` : mod.folder,
        path: mod.tp2,
        active: true,
      })),
      inactive: [],
    };
  }
  const override = path.join(source, "override");
  const files = fs.existsSync(override) ? walkFiles(override) : [];
  return {
    source: "override/",
    generatedAt: new Date().toISOString(),
    count: files.length,
    itemsLabel: "Manual overlay files",
    items: files.length
      ? [{ label: `Manual overlay (${files.length} files)`, path: "override/", active: true }]
      : [],
    inactive: [],
  };
}

function buildPlatforms(game: InfinityGame, loader: infinityloader.LoaderInfo | null, recipe: Recipe): Platforms {
  const gameExe = game.exe || game.linuxExe || "";
  const common: PlatformProfile = {
    exe: gameExe,
    gameProcess: loader ? loader.realExe : gameExe,
  };
  if (loader) {
    common.gameProcessAlt = loader.gameExe;
    common.loader = `${infinityloader.SUPPORT_DIR}/${loader.exe}`;
    common.loaderSupport = infinityloader.SUPPORT_DIR;
  }
  const windows: PlatformProfile = { ...common };
  const proton: PlatformProfile = { ...common };
  if (loader) {
    proton.shortcut = `${game.title} (with mods)`;
    proton.template = infinityloader.TEMPLATE;
  }
  const platforms: Platforms = {
    windows,
    "linux-proton": proton,
  };
  if (!loader && game.linuxExe) {
    platforms["linux-native"] = {
      exe: game.linuxExe,
      gameProcess: game.nativeProcess || game.linuxExe,
    };
  }
  const merged = paths.mergePlatforms(platforms, recipe.platforms);
  if (loader) delete merged["linux-native"];
  return merged;
}

function buildPreconditions({
  game,
  build,
  installedDepots,
  bytes,
  recipe,
}: {
  game: InfinityGame;
  build: string;
  installedDepots: number[] | null;
  bytes: number;
  recipe: Recipe;
}): PreconditionConfig[] {
  const reserve = Math.max(1024 * 1024 * 1024, bytes + 512 * 1024 * 1024);
  const auto: PreconditionConfig[] = [
    { id: "game", type: "game-installed", required: true, title: `${game.title} is installed` },
    ...(build ? [{
      id: "build",
      type: "game-build",
      required: true,
      build,
      confirmable: true,
      title: `Game build ${build}`,
    } as PreconditionConfig] : []),
    {
      id: "prefix",
      type: "proton-prefix",
      required: true,
      title: "Game data location is ready",
      hint: "Launch the vanilla game once from Steam.",
    },
    { id: "closed", type: "game-not-running", required: true, title: "Game is closed" },
    {
      id: "space-tv",
      type: "disk-free",
      required: true,
      scope: "tv",
      reserveBytes: reserve,
      title: "Enough space for the pack",
    },
    {
      id: "space-game",
      type: "disk-free",
      required: true,
      scope: "game",
      reserveBytes: reserve,
      title: "Enough space in the game folder",
    },
  ];
  if (game.dlcAppId && installedDepots && installedDepots.includes(game.dlcAppId)) {
    auto.push({
      id: "dlc",
      type: "dlc-installed",
      required: true,
      dlcAppId: game.dlcAppId,
      depotIds: game.dlcDepotIds || [game.dlcAppId],
      title: "The game DLC is installed",
    });
  }
  const byId = new Map<string, PreconditionConfig>();
  for (const check of auto) byId.set(check.id, check);
  for (const check of recipe.preconditions || []) byId.set(check.id, check);
  return [...byId.values()];
}

function buildNotes({
  game,
  loader,
  weidu,
  language,
  selected,
  base,
  basePrep,
  recipe,
}: {
  game: InfinityGame;
  loader: infinityloader.LoaderInfo | null;
  weidu: WeiDUInfo;
  language: string;
  selected: SelectedFiles;
  base: depot.BaseFileSet | null;
  basePrep: string[];
  recipe: Recipe;
}): Note[] {
  const notes: Note[] = [...(game.gameNotes || []), ...(recipe.notes || [])];
  notes.push({
    title: "Snapshot pack",
    body: `${weidu.components} components across ${weidu.mods.length} mods. The pack contains the mod runtime only; no base game and no saves.`,
    tone: "info",
  });
  notes.push({
    title: "Language",
    body: `Active WeiDU language: ${language}. The pack replaces the active text table${selected.dialogs.length ? ` (${selected.dialogs.join(", ")})` : ""} when it was modified.`,
    tone: "info",
  });
  if (loader) {
    notes.push({
      title: "InfinityLoader/EEex",
      body: `Includes InfinityLoader. The installer swaps ${loader.gameExe} and restores it on rollback. On SteamOS use Proton; native Linux is not supported by this snapshot.`,
      tone: "warning",
    });
  } else {
    notes.push({
      title: "No Windows loader detected",
      body: "This snapshot is data-only and can run on the native Linux build as well as Proton.",
      tone: "info",
    });
  }
  notes.push({
    title: "Clean target",
    body: "The installer replaces override/ and the active text table and refuses to mix with another WeiDU install. Start from a clean game, or from the declared base-preparation state.",
    tone: "warning",
  });
  if (basePrep.length) {
    notes.push({
      title: "Base preparation required",
      body: `Install these base-preparation mods on the target first: ${basePrep.join(", ")}. They are not part of the snapshot.`,
      tone: "warning",
    });
  }
  if (!base) {
    notes.push({
      title: "Selection fallback",
      body: "Steam depot manifests were not available. The builder used conservative rules; review meta/selection.json before serving.",
      tone: "warning",
    });
  }
  if (selected.modifiedBase.length) {
    notes.push({
      title: "Modified base files",
      body: `Included because mods changed them: ${selected.modifiedBase.slice(0, 8).join(", ")}${selected.modifiedBase.length > 8 ? ", ..." : ""}.`,
      tone: "info",
    });
  }
  if (selected.warnings.length) {
    notes.push({
      title: "Selection warnings",
      body: `${selected.warnings.length} file selection warning(s); see meta/selection.json.`,
      tone: "warning",
    });
  }
  notes.push({
    title: "Saves",
    body: "Saves are not included and are not synced.",
    tone: "warning",
  });
  return notes;
}

function copyArt({ src, dst, artId }: { src: string; dst: string; artId: string }): void {
  const artSource = path.join(projectRoot, "web");
  const artDest = path.join(dst, "art", artId);
  ensureDir(artDest);
  for (const [from, to] of [
    ["modsync-grid.png", "grid.png"],
    ["modsync-hero.png", "hero.png"],
    ["modsync-logo.png", "logo.png"],
    ["icon.png", "icon.png"],
    ["modsync-header.png", "header.png"],
    ["modsync-portrait.png", "portrait.png"],
  ]) {
    const file = path.join(artSource, from);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(artDest, to));
  }
}

function detectBuild(game: InfinityGame): string {
  const found = steam.findGame(game);
  return found?.build || "";
}

function packGameInfo(game: InfinityGame, build: string): GameInfo {
  const info: GameInfo = {
    id: game.id,
    title: game.title,
    store: game.store,
    appId: game.appId,
    installDir: game.installDir,
    exe: game.exe,
    prefix: game.prefix,
  };
  if (game.linuxExe) info.linuxExe = game.linuxExe;
  if (build) info.build = build;
  if (game.version) info.version = game.version;
  return info;
}

export async function buildPackFor(game: InfinityGame, {
  recipe,
  source,
  out,
  link = true,
  version: requestedVersion,
  driverOptions,
  progress = () => {},
  log = () => {},
}: BuildPackOptions): Promise<BuildPackResult> {
  if (recipe.game !== game.id) throw new Error(`Recipe ${recipe.id} is not for ${game.title}`);
  const src = path.resolve(source);
  const dst = path.resolve(out);
  if (!fs.existsSync(src)) throw new Error(`Game folder not found: ${src}`);
  const weidu = readWeiDU(src);
  const override = path.join(src, "override");
  const overrideFiles = fs.existsSync(override) ? walkFiles(override) : [];
  if (!weidu.components && !overrideFiles.length) {
    throw new Error("No WeiDU mods or override files found. Install mods before building a snapshot pack.");
  }
  if (weidu.mods.some((mod) => /(^|\/)EET[^/]*\.TP2$/i.test(mod.tp2) || /EET_END/i.test(mod.tp2))) {
    throw new Error("EET is a total conversion and is not supported by snapshot mode.");
  }

  const options = parseBuildOptions(driverOptions);
  const language = readLanguage(src);
  const version = String(requestedVersion || recipe.version || defaultVersion());
  const build = detectBuild(game);
  const installed = steam.findGame(game);
  const installedDepots = installed?.library ? steam.readInstalledDepots(installed.library, game.appId) : null;
  const base = depot.readBaseFileSet(game.appId);
  const loader = game.loaderSupported ? infinityloader.detectLoader(src, game) : null;
  const orphan = orphanedLoader(src, game, loader);
  if (orphan) {
    throw new Error(
      `Found InfinityLoader/EEex files (${orphan}) but InfinityLoader.exe/InfinityLoader.ini are missing. ` +
      "Repair EEex by running setup-EEex.exe, or remove the remaining loader files before building a no-loader pack.",
    );
  }

  if (!build) log("Steam build id not found; the pack will not pin a game build.");
  if (!base) log("Steam depot manifests not available; using conservative base/mod selection.");
  if (loader?.rewritten) log(`InfinityLoader.ini will be normalized for ${loader.gameExe} -> ${loader.realExe}.`);
  log(`Snapshot ${game.title} ${build || ""} from ${src}`);
  log(`Mods: ${weidu.mods.length}, components: ${weidu.components}; language: ${language}.`);

  progress({ phase: "copying", done: 0, total: 1 });
  const selected = selectFiles({ source: src, game, base, loader, options, weidu, language, log });
  if (!selected.included) throw new Error("No runtime files were selected.");

  fs.rmSync(dst, { recursive: true, force: true });
  const stageRoot = path.join(dst, ".stage");
  const rootStage = path.join(stageRoot, "root");
  const metaStage = path.join(stageRoot, "meta");
  ensureDir(rootStage);
  ensureDir(metaStage);
  ensureDir(path.join(dst, "payload", "versions", version));

  for (const rel of selected.rootFiles) {
    materialize(path.join(src, rel), path.join(rootStage, rel), link);
  }
  if (fs.existsSync(path.join(src, "WeiDU.log"))) {
    fs.copyFileSync(path.join(src, "WeiDU.log"), path.join(metaStage, "WeiDU.log"));
  }
  const selectionDoc = {
    schema: 1,
    game: game.id,
    build,
    language,
    baseManifest: !!base,
    included: selected.included,
    bytes: selected.bytes,
    rootFiles: selected.rootFiles,
    dialogs: selected.dialogs,
    modifiedBase: selected.modifiedBase,
    excluded: selected.excluded,
    warnings: selected.warnings,
    includeDirs: options.includeDirs,
    includeBaseData: options.includeBaseData,
  };
  writeJson(path.join(metaStage, "selection.json"), selectionDoc);

  let overrideStage: string | null = null;
  if (!selected.override) {
    overrideStage = path.join(stageRoot, "override");
    ensureDir(overrideStage);
  }

  const basePrep = weidu.mods
    .filter((mod) => /(^|\/)DLCMERGER[^/]*\.TP2$/i.test(mod.tp2))
    .map((mod) => mod.tp2);
  const loaderManifest: InfinityLoaderManifest | null = loader ? {
    type: loader.type,
    exe: loader.exe,
    ini: loader.ini,
    gameExe: loader.gameExe,
    realExe: loader.realExe,
    support: infinityloader.SUPPORT_DIR,
    supportFiles: loader.supportFiles,
  } : null;
  const manifest: InfinityManifest = {
    schema: 1,
    game: game.id,
    build,
    version,
    language,
    source: "snapshot",
    override: "override",
    root: "root",
    meta: "meta",
    dialogs: selected.dialogs,
    loader: loaderManifest,
    basePrep,
    weidu: { mods: weidu.mods.length, components: weidu.components },
    selection: {
      included: selected.included,
      bytes: selected.bytes,
      modifiedBase: selected.modifiedBase,
      warnings: selected.warnings,
    },
  };
  writeJson(path.join(stageRoot, "modsync.json"), manifest);

  if (loader) {
    const toolsDir = path.join(dst, infinityloader.SUPPORT_DIR);
    ensureDir(toolsDir);
    for (const name of loader.supportFiles) {
      if (name === loader.ini) continue;
      materialize(path.join(src, name), path.join(toolsDir, name), link);
    }
    const iniText = fs.readFileSync(path.join(src, loader.ini), "utf8");
    writeText(path.join(toolsDir, loader.ini), infinityloader.normalizeIni(iniText, loader.gameExe, loader.realExe));
  }

  const tarPath = path.join(dst, "payload", "versions", version, "payload.tar.gz");
  const tarArgs = ["-czf", tarPath];
  if (selected.override) tarArgs.push("-C", src, "override");
  else tarArgs.push("-C", stageRoot, "override");
  tarArgs.push("-C", stageRoot, "root", "meta", "modsync.json");
  log(`Creating ${path.basename(tarPath)} from ${selected.included} selected files...`);
  try {
    runTar(tarArgs);
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
  progress({ phase: "copying", done: 1, total: 1, bytesDone: selected.bytes, bytesTotal: selected.bytes });

  progress({ phase: "hashing", done: 0, total: 1 });
  const tarSize = fs.statSync(tarPath).size;
  const tarHash = await sha256File(tarPath);
  progress({ phase: "hashing", done: 1, total: 1 });
  log(`Payload: ${formatBytes(tarSize)}`);

  const modId = recipe.modId;
  const artId = recipe.artId || game.id;
  copyArt({ src, dst, artId });
  const files: PackFile[] = [
    {
      source: `payload/versions/${version}/payload.tar.gz`,
      target: `mods/${modId}/versions/${version}/payload.tar.gz`,
      size: tarSize,
      sha256: tarHash,
      mode: "644",
    },
  ];
  const loaderPlatforms: Variant[] = ["windows", "linux-proton"];
  if (loader) {
    for (const name of loader.supportFiles) {
      const rel = `${infinityloader.SUPPORT_DIR}/${name}`;
      const abs = path.join(dst, "tools", rel.slice("tools/".length));
      const size = fs.statSync(abs).size;
      files.push({
        source: `tools/${rel.slice("tools/".length)}`,
        target: `tools/${rel.slice("tools/".length)}`,
        size,
        sha256: await sha256File(abs),
        mode: infinityloader.modeForTarget(name),
        platforms: loaderPlatforms,
      });
    }
  }
  for (const art of walkFiles(path.join(dst, "art", artId))) {
    files.push({
      source: `art/${artId}/${art.rel}`,
      target: `art/${artId}/${art.rel}`,
      size: art.size,
      sha256: await sha256File(art.abs),
    });
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  const platforms = buildPlatforms(game, loader, recipe);
  const gameExe = game.exe || game.linuxExe || "";
  const launch: LaunchInfo = {
    type: "steam",
    mode: "default",
    exe: gameExe,
    gameProcess: loader ? loader.realExe : gameExe,
    steamAppId: game.appId,
  };
  if (loader) launch.gameProcessAlt = loader.gameExe;
  const loaderInfo: LoaderInfo | undefined = loader ? {
    type: loader.type,
    options: {
      support: infinityloader.SUPPORT_DIR,
      exe: loader.exe,
      ini: loader.ini,
      gameExe: loader.gameExe,
      realExe: loader.realExe,
    },
  } : undefined;
  const install: InstallInfo = {
    type: "infinity",
    label: loader ? "Game overlay + InfinityLoader" : "Game overlay",
  };
  const contents = contentsForGame(game, { recipe, source: src, version });
  const notes = buildNotes({ game, loader, weidu, language, selected, base, basePrep, recipe });
  const preconditions = buildPreconditions({ game, build, installedDepots, bytes: selected.bytes, recipe });
  const description = recipe.description
    || (weidu.components
      ? `${game.title} snapshot with ${weidu.mods.length} mods / ${weidu.components} components.`
      : `${game.title} manual override snapshot.`);
  const pack: Pack = {
    schema: 1,
    id: recipe.id,
    name: recipe.name,
    description,
    game: packGameInfo(game, build),
    platforms,
    mod: { id: modId, version },
    launch,
    install,
    art: {
      grid: `art/${artId}/grid.png`,
      hero: `art/${artId}/hero.png`,
      logo: `art/${artId}/logo.png`,
      icon: `art/${artId}/icon.png`,
      header: `art/${artId}/header.png`,
      portrait: `art/${artId}/portrait.png`,
    },
    notes,
    preconditions,
    contents,
    files: "files.json",
  };
  if (loaderInfo) pack.loader = loaderInfo;
  writeJson(path.join(dst, "pack.json"), pack);
  writeJson(path.join(dst, "files.json"), { schema: 1, pack: pack.id, version, files });
  writeText(path.join(dst, "README.md"), [
    `# ${recipe.name} pack`,
    "",
    `${game.title}${build ? ` build ${build}` : ""}`,
    `${weidu.mods.length} mods / ${weidu.components} components, snapshot ${version}`,
    loader ? `Loader: InfinityLoader (${loader.gameExe} -> ${loader.realExe})` : "Loader: none",
    "",
    "Mod runtime only. No base game, no saves.",
    "",
  ].join("\n"));
  log(`Wrote ${files.length} files, ${formatBytes(totalBytes)}.`);
  return { packRoot: dst, pack, files: files.length, totalBytes };
}
