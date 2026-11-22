import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureDir, writeJson, writeText, walkFiles, materialize,
  sha256File, formatBytes,
} from "../util";
import * as steam from "../steam";
import * as paths from "../paths";
import { projectRoot } from "../root";
import * as bg3le from "../loaders/bg3le";
import type {
  BuildOption,
  BuildPackOptions,
  BuildPackResult,
  ContentsInput,
  ContentsSummary,
  GameInfo,
  Note,
  Pack,
  PackFile,
  Platforms,
  SteamGame,
  Variant,
} from "../types";

const WINDOWS_EXTENDER_PLATFORMS: Variant[] = ["windows", "linux-proton"];
const GAME: GameInfo = {
  id: "bg3",
  title: "Baldur's Gate 3",
  store: "steam",
  appId: 1086940,
  installDir: "Baldurs Gate 3",
  exe: "bin/bg3.exe",
  linuxExe: "bin/bg3",
  build: "25605617",
  version: "Patch 8",
  prefix: true,
};

const DEFAULT_PLATFORMS: Platforms = {
  windows: {
    dataDir: "%LOCALAPPDATA%/Larian Studios/Baldur's Gate 3",
    saveDir: "%LOCALAPPDATA%/Larian Studios/Baldur's Gate 3/PlayerProfiles",
    exe: "bin/bg3.exe",
    gameProcess: "bg3.exe",
  },
  "linux-proton": {
    dataDir: "%PREFIX%/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3",
    saveDir: "%PREFIX%/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/PlayerProfiles",
    exe: "bin/bg3.exe",
    gameProcess: "bg3.exe",
  },
  "linux-native": {
    dataDir: "%DATA_HOME%/Larian Studios/Baldur's Gate 3",
    saveDir: "%DATA_HOME%/Larian Studios/Baldur's Gate 3/PlayerProfiles",
    exe: "bin/bg3",
    gameProcess: "bg3",
    shortcut: "Baldur's Gate 3 (with mods)",
    template: "games/bg3-native.sh",
  },
};

export function defaultSource(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Larian Studios", "Baldur's Gate 3");
  }
  const game: SteamGame | null = steam.findGame(GAME) || null;
  if (game) {
    const resolved = paths.resolve({ platforms: DEFAULT_PLATFORMS }, game);
    if (resolved.dataDir) return resolved.dataDir;
  }
  return paths.expand("%DATA_HOME%/Larian Studios/Baldur's Gate 3", paths.contextFor(null));
}

export function buildOptions(): BuildOption[] {
  return [
    {
      key: "gameRoot",
      label: "BG3 game folder",
      type: "directory",
      optional: true,
      placeholder: "Detected from Steam",
      help: "Reads bin/DWrite.dll and ScriptExtenderSettings.json for the Windows and Proton script extender.",
    },
    {
      key: "bg3leRoot",
      label: "BG3LE folder",
      type: "directory",
      optional: true,
      placeholder: "Downloaded automatically",
      help: "Native Linux loader bundled in the pack. Leave empty to use the pinned BG3LE release.",
    },
  ];
}

function defaultVersion(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, ".");
}

const BUILTIN_MODULES = new Set(["GustavX", "HonourX"]);

interface Bg3Mod {
  name: string;
  id: string;
  folder: string;
  version64: string;
  md5: string;
  publishHandle: string;
  builtin: boolean;
  [key: string]: unknown;
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: "\"",
};

function decodeXmlEntities(value: string): string {
  return String(value).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const hex = code[1]?.toLowerCase() === "x";
      const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return XML_ENTITIES[code.toLowerCase()] ?? match;
  });
}

export function parseModSettings(xml: string): Bg3Mod[] {
  const mods: Bg3Mod[] = [];
  for (const match of String(xml).matchAll(/<node id="ModuleShortDesc">([\s\S]*?)<\/node>/g)) {
    const attrs: Record<string, string> = {};
    for (const attr of match[1].matchAll(/<attribute id="([^"]+)"[^>]*value="([^"]*)"/g)) {
      attrs[attr[1]] = decodeXmlEntities(attr[2]);
    }
    if (!attrs.Name) continue;
    const folder = attrs.Folder || "";
    mods.push({
      name: attrs.Name,
      id: attrs.UUID || folder || attrs.Name,
      folder,
      version64: attrs.Version64 || "",
      md5: attrs.MD5 || "",
      publishHandle: attrs.PublishHandle || "",
      builtin: BUILTIN_MODULES.has(folder) || BUILTIN_MODULES.has(attrs.Name),
    });
  }
  return mods;
}

function normalizePakName(value: string): string {
  return decodeXmlEntities(value)
    .toLowerCase()
    .replace(/\.pak$/i, "")
    .replace(/[^a-z0-9]+/g, "");
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index++;
  return index;
}

/**
 * BG3 mod folders often carry a full UUID while the published pak only keeps
 * its start (`foo_someprefix-xxxx.pak`). Build short aliases from the display
 * name so titles such as "Whispers of the Divine: Aasimar ..." still match
 * `WotD-Aasimar.pak`.
 */
function acronymAliases(value: string): Set<string> {
  const words = decodeXmlEntities(value).match(/[A-Za-z0-9]+/g) || [];
  const aliases = new Set<string>();
  for (let take = 1; take <= words.length; take++) {
    const acronym = words.slice(0, take).map((word) => word[0]).join("");
    for (let upto = take; upto <= words.length; upto++) {
      const alias = normalizePakName(acronym + words.slice(take, upto).join(""));
      if (alias.length >= 6) aliases.add(alias);
    }
  }
  return aliases;
}

function pakScore(mod: Bg3Mod, pak: string): number {
  const stem = normalizePakName(pak);
  if (!stem) return 0;
  const folder = normalizePakName(mod.folder || "");
  const name = normalizePakName(mod.name || "");
  const id = normalizePakName(mod.id || "");
  let score = 0;
  if (id && stem.includes(id)) score = Math.max(score, 990);

  const compare = (value: string, exact: number): number => {
    if (!value) return 0;
    if (value === stem) return exact;
    const prefix = commonPrefixLength(value, stem);
    const shortest = Math.min(value.length, stem.length);
    // Long shared starts cover published paks whose UUID suffix is truncated.
    if (shortest >= 8 && prefix >= 8 && prefix >= Math.ceil(shortest * 0.5)) {
      return exact - 100 + Math.min(prefix, 99);
    }
    return 0;
  };
  score = Math.max(score, compare(folder, 1000), compare(name, 950));
  if (name && acronymAliases(mod.name).has(stem)) score = Math.max(score, 880);
  return score;
}

function matchPaks(mods: Bg3Mod[], paks: string[]): Map<number, string> {
  const pairs: Array<{ mod: number; pak: string; score: number }> = [];
  mods.forEach((mod, index) => {
    for (const pak of paks) {
      const score = pakScore(mod, pak);
      if (score >= 500) pairs.push({ mod: index, pak, score });
    }
  });
  // Assign the strongest matches first so a generic prefix cannot steal the
  // pak that a later mod names exactly (the old `test_...` collision).
  pairs.sort((a, b) => b.score - a.score || a.pak.localeCompare(b.pak) || a.mod - b.mod);
  const byMod = new Map<number, string>();
  const used = new Set<string>();
  for (const pair of pairs) {
    if (byMod.has(pair.mod) || used.has(pair.pak)) continue;
    byMod.set(pair.mod, pair.pak);
    used.add(pair.pak);
  }
  return byMod;
}

function contentsFrom(source: string, paks: string[]): ContentsSummary {
  const xml = fs.readFileSync(path.join(source, "PlayerProfiles", "Public", "modsettings.lsx"), "utf8");
  const mods = parseModSettings(xml).filter((mod) => !mod.builtin);
  const matches = matchPaks(mods, paks);
  const used = new Set(matches.values());
  const inactive = paks.filter((name) => !used.has(name));
  return {
    source: "modsettings.lsx",
    generatedAt: new Date().toISOString(),
    count: mods.length,
    itemsLabel: "Included mods",
    items: mods.map((mod, index) => {
      const file = matches.get(index);
      return {
        label: mod.name,
        path: file ? `Mods/${file}` : undefined,
        active: true,
      };
    }),
    inactive,
  };
}

export function contentsFor({ source }: ContentsInput): ContentsSummary {
  const modsDir = path.join(source, "Mods");
  const paks = fs.existsSync(modsDir)
    ? fs.readdirSync(modsDir).filter((name) => name.toLowerCase().endsWith(".pak")).sort()
    : [];
  return contentsFrom(source, paks);
}

function requireDir(p: string, label: string): void {
  if (!fs.existsSync(p)) throw new Error(`${label} not found: ${p}`);
}

function copyTree(src: string, dst: string): void {
  fs.cpSync(src, dst, { recursive: true });
}

export async function buildPack({
  recipe,
  source,
  out,
  link = true,
  version: requestedVersion,
  driverOptions,
  progress = () => {},
  log = () => {},
}: BuildPackOptions): Promise<BuildPackResult> {
  if (recipe.game !== GAME.id) throw new Error(`Recipe ${recipe.id} is not for Baldur's Gate 3`);
  const packId = recipe.id;
  const modId = recipe.modId;
  const packName = recipe.name;
  const packDescription = recipe.description || "";
  const src = path.resolve(source);
  const dst = path.resolve(out);
  const version = String(requestedVersion || defaultVersion());
  const modsDir = path.join(src, "Mods");
  const modsettings = path.join(src, "PlayerProfiles", "Public", "modsettings.lsx");
  const scriptExtender = path.join(src, "Script Extender");
  const game: SteamGame | null = steam.findGame(GAME) || null;
  const requestedGameRoot = typeof driverOptions?.gameRoot === "string" ? driverOptions.gameRoot : "";
  const gameRoot = requestedGameRoot ? path.resolve(requestedGameRoot) : (game ? game.root : "");
  const requestedBg3le = typeof driverOptions?.bg3leRoot === "string" ? driverOptions.bg3leRoot : "";

  requireDir(modsDir, "BG3 Mods folder");
  requireDir(path.dirname(modsettings), "BG3 profile folder");
  if (!fs.existsSync(modsettings)) throw new Error(`modsettings.lsx not found: ${modsettings}`);

  const paks = fs.readdirSync(modsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".pak"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  if (!paks.length) throw new Error(`No .pak files in ${modsDir}`);

  const platforms = paths.mergePlatforms(DEFAULT_PLATFORMS, recipe.platforms);
  paths.validatePlatforms(platforms, "pack.platforms");

  log(`Packing BG3 mods ${version} from ${src}`);
  fs.rmSync(dst, { recursive: true, force: true });
  const payload = path.join(dst, "payload", "versions", version);
  ensureDir(path.join(payload, "Mods"));
  ensureDir(path.join(payload, "bg3se"));

  const bg3leRoot = requestedBg3le ? path.resolve(requestedBg3le) : await bg3le.ensureBg3le();
  log(`Including BG3LE ${bg3le.VERSION} for native Linux`);
  copyTree(bg3leRoot, path.join(dst, "tools", "bg3le"));

  let copied = 0;
  let bytes = 0;
  progress({ phase: "copying", done: 0, total: paks.length });
  for (const name of paks) {
    const from = path.join(modsDir, name);
    const to = path.join(payload, "Mods", name);
    materialize(from, to, link);
    bytes += fs.statSync(to).size;
    copied++;
    if (copied % 10 === 0 || copied === paks.length) {
      progress({ phase: "copying", done: copied, total: paks.length, bytesDone: bytes });
      log(`Mods ${copied}/${paks.length} (${formatBytes(bytes)})`);
    }
  }

  fs.copyFileSync(modsettings, path.join(payload, "modsettings.lsx"));

  let bg3seFiles = 0;
  if (gameRoot) {
    const dll = path.join(gameRoot, "bin", "DWrite.dll");
    const settings = path.join(gameRoot, "bin", "ScriptExtenderSettings.json");
    if (fs.existsSync(dll)) {
      fs.copyFileSync(dll, path.join(payload, "bg3se", "DWrite.dll"));
      bg3seFiles++;
    }
    if (fs.existsSync(settings)) {
      fs.copyFileSync(settings, path.join(payload, "bg3se", "ScriptExtenderSettings.json"));
      bg3seFiles++;
    }
  }
  if (fs.existsSync(scriptExtender)) {
    copyTree(scriptExtender, path.join(payload, "Script Extender"));
    bg3seFiles += walkFiles(scriptExtender).length;
  }
  log(`BG3SE files: ${bg3seFiles}${gameRoot ? "" : " (game root not found)"}`);

  const artSrc = path.join(projectRoot, "web");
  const artDst = path.join(dst, "art", modId);
  ensureDir(artDst);
  for (const [from, to] of [
    ["modsync-grid.png", "grid.png"],
    ["modsync-hero.png", "hero.png"],
    ["modsync-logo.png", "logo.png"],
    ["icon.png", "icon.png"],
    ["modsync-header.png", "header.png"],
    ["modsync-portrait.png", "portrait.png"],
  ]) {
    const file = path.join(artSrc, from);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(artDst, to));
  }

  const files: PackFile[] = [];
  let processed = 0;
  const payloadFiles = walkFiles(payload);
  const bg3leFiles = walkFiles(path.join(dst, "tools", "bg3le"));
  const artFiles = walkFiles(artDst);
  const total = payloadFiles.length + bg3leFiles.length + artFiles.length;
  const byHash = new Map<string, PackFile>();
  const add = async (sourceRel: string, targetRel: string, platformList?: readonly Variant[] | null): Promise<void> => {
    const abs = path.join(dst, sourceRel);
    const size = fs.statSync(abs).size;
    const sha256 = await sha256File(abs);
    const mode = bg3le.modeForTarget(targetRel);
    const entry: PackFile = { source: sourceRel, target: targetRel, size, sha256, mode };
    if (platformList) entry.platforms = [...platformList];
    const shared = byHash.get(sha256);
    if (shared) {
      // Keep one copy on the PC; the installer still writes every target.
      entry.source = shared.source;
      fs.rmSync(abs, { force: true });
    } else {
      byHash.set(sha256, entry);
    }
    files.push(entry);
    processed++;
    const step = Math.max(1, Math.ceil(total / 10));
    if (processed === total || processed % step === 0) {
      progress({ phase: "hashing", done: processed, total });
      log(`Hashing ${processed}/${total}`);
    }
  };

  const extenderFile = (rel: string) => rel === "bg3se" || rel.startsWith("bg3se/");
  for (const file of payloadFiles) {
    await add(
      `payload/versions/${version}/${file.rel}`,
      `mods/${modId}/versions/${version}/${file.rel}`,
      extenderFile(file.rel) ? WINDOWS_EXTENDER_PLATFORMS : null,
    );
  }
  for (const file of bg3leFiles) {
    await add(`tools/bg3le/${file.rel}`, `tools/bg3le/${file.rel}`, ["linux-native"]);
  }
  for (const art of artFiles) {
    await add(`art/${modId}/${art.rel}`, `art/${modId}/${art.rel}`);
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const notes: Note[] = [...(recipe.notes || [])];
  notes.push({
    title: "Script Extender",
    body: bg3seFiles
      ? "BG3 Script Extender (DWrite.dll) is included for Windows and Proton. The native Linux build keeps Steam's game binary untouched and installs the bundled BG3LE files in the standard per-user location; the current launcher does not preload BG3LE, so Script Extender mods may not load."
      : "This pack has no BG3 Script Extender files. Install BG3SE (Windows/Proton) or BG3LE (native Linux) before using Script Extender mods.",
    tone: bg3seFiles ? "info" : "warning",
  });
  const contents = contentsFrom(src, paks);
  const preconditions = recipe.preconditions || [];

  const pack: Pack = {
    schema: 1,
    id: packId,
    name: packName,
    description: packDescription,
    game: { ...GAME },
    platforms,
    mod: { id: modId, version },
    loader: { type: "bg3se", profile: `mods/${modId}/versions/${version}/modsettings.lsx` },
    launch: {
      type: "steam",
      mode: "default",
      exe: "bin/bg3.exe",
      gameProcess: "bg3.exe",
      steamAppId: GAME.appId,
    },
    install: {
      type: "bg3",
      label: "modsettings + script extender",
    },
    art: {
      grid: `art/${modId}/grid.png`,
      hero: `art/${modId}/hero.png`,
      logo: `art/${modId}/logo.png`,
      icon: `art/${modId}/icon.png`,
      header: `art/${modId}/header.png`,
      portrait: `art/${modId}/portrait.png`,
    },
    notes,
    preconditions,
    contents,
    files: "files.json",
  };

  writeJson(path.join(dst, "pack.json"), pack);
  writeJson(path.join(dst, "files.json"), { schema: 1, pack: packId, version, files });
  writeText(path.join(dst, "README.md"), `# ${packName} pack\n\nBaldur's Gate 3 ${GAME.version} (build ${GAME.build})\n${paks.length} mods, ${version}\n\nMods and modsettings only. No base game, no saves.\n`);
  log(`Wrote ${files.length} files, ${formatBytes(totalBytes)}`);
  return { packRoot: dst, pack, files: files.length, totalBytes };
}

export { GAME };
