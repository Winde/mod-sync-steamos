import fs from "node:fs";
import path from "node:path";
import {
  ensureDir, writeJson, writeText, walkFiles, materialize,
  sha256File, modeFor, formatBytes,
} from "../util";
import * as paths from "../paths";
import type {
  BuildPackOptions,
  BuildPackResult,
  ContentsSummary,
  GameInfo,
  Pack,
  PackFile,
  Platforms,
  Recipe,
  Variant,
} from "../types";

const GAME: GameInfo = {
  id: "eldenring",
  title: "ELDEN RING",
  store: "steam",
  appId: 1245620,
  installDir: "ELDEN RING",
  exe: "Game/eldenring.exe",
  build: "25827938",
  version: "1.17",
  prefix: true,
};

const DEFAULT_PLATFORMS: Platforms = {
  windows: {
    exe: "Game/eldenring.exe",
    gameProcess: "eldenring.exe",
    loader: "tools/me3-win/bin/me3.exe",
    template: "loaders/me3.sh",
  },
  "linux-proton": {
    exe: "Game/eldenring.exe",
    gameProcess: "eldenring.exe",
    loader: "tools/me3-linux/bin/me3",
    template: "loaders/me3.sh",
  },
};

const TOOL_PLATFORMS: Record<string, Variant[]> = {
  "me3-linux/": ["linux-proton"],
  "me3-win/": ["windows"],
};

function platformsForTool(rel: string, windowsBinaries: string): Variant[] | null {
  if (rel.startsWith("me3-win/") && windowsBinaries === "tools/me3-win/bin") {
    // Linux me3 needs the launcher and host DLL, not the Windows CLI.
    return rel.endsWith("/me3.exe") ? ["windows"] : ["windows", "linux-proton"];
  }
  const prefix = Object.keys(TOOL_PLATFORMS).find((candidate) => rel.startsWith(candidate));
  return prefix ? TOOL_PLATFORMS[prefix] : null;
}

export function defaultSource(): string {
  return "D:\\EldenRingMods";
}

interface Me3Block {
  type: string;
  [key: string]: unknown;
}

export function parseMe3Profile(text: string): { packages: Me3Block[]; natives: Me3Block[] } {
  const packages: Me3Block[] = [];
  const natives: Me3Block[] = [];
  let block: Me3Block | null = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const section = /^\[\[(.+)\]\]$/.exec(line);
    if (section) {
      block = { type: section[1] };
      if (section[1] === "packages") packages.push(block);
      else if (section[1] === "natives") natives.push(block);
      else block = null;
      continue;
    }
    if (line.startsWith("[")) { block = null; continue; }
    if (!block) continue;
    const kv = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const rawValue = kv[2].trim();
    let value: string | boolean | string[] = rawValue;
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
      value = rawValue.slice(1, -1);
    } else if (rawValue === "true") value = true;
    else if (rawValue === "false") value = false;
    else if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      value = rawValue.slice(1, -1).split(",").map((v) => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    block[kv[1]] = value;
  }
  return { packages, natives };
}

export function contentsFor(recipe: Recipe, source: string, version: string): ContentsSummary {
  const profile = path.join(source, "profiles", `${recipe.modId}-${version}.me3`);
  const parsed = parseMe3Profile(fs.readFileSync(profile, "utf8"));
  const packages = parsed.packages.map((entry, index) => {
    const entryPath = typeof entry.path === "string" ? entry.path : "";
    return {
      path: entryPath,
      label: index === 0 ? recipe.name : (entryPath.split("/").filter(Boolean).pop() || ""),
      enabled: entry.enabled !== false,
      loadAfter: entry.load_after || [],
      loadBefore: entry.load_before || [],
    };
  });
  const natives = parsed.natives.map((entry) => {
    const entryPath = typeof entry.path === "string" ? entry.path : "";
    return {
      path: entryPath,
      label: entryPath.split("/").filter(Boolean).pop() || "",
      enabled: entry.enabled !== false,
      optional: entry.optional === true,
    };
  });
  return {
    kind: "packages",
    source: "me3 profile",
    generatedAt: new Date().toISOString(),
    count: packages.length,
    packages,
    natives,
  };
}

function requirePath(p: string, label: string): void {
  if (!fs.existsSync(p)) throw new Error(`${label} not found: ${p}`);
}

function sameFile(a: string, b: string): boolean {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
  if (fs.statSync(a).size !== fs.statSync(b).size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/**
 * Keep one copy of the Windows host binaries. The Linux me3 launcher can use
 * the Windows distribution's bin directory, so the duplicate win64 tree is
 * only kept when the two downloads are not byte-identical.
 */
function copyMe3Runtime(me3Linux: string, me3Win: string, toolsDst: string): string {
  const linuxLoader = path.join(me3Linux, "bin", "me3");
  requirePath(linuxLoader, "me3 Linux loader");
  for (const name of ["me3.exe", "me3-launcher.exe", "me3_mod_host.dll"]) {
    requirePath(path.join(me3Win, "bin", name), `me3 Windows ${name}`);
  }

  const linuxBinDst = path.join(toolsDst, "me3-linux", "bin");
  ensureDir(linuxBinDst);
  fs.copyFileSync(linuxLoader, path.join(linuxBinDst, "me3"));

  const winBinSrc = path.join(me3Win, "bin");
  const winBinDst = path.join(toolsDst, "me3-win", "bin");
  ensureDir(winBinDst);
  for (const name of ["me3.exe", "me3-launcher.exe", "me3_mod_host.dll"]) {
    fs.copyFileSync(path.join(winBinSrc, name), path.join(winBinDst, name));
  }

  const linuxHost = path.join(me3Linux, "bin", "win64");
  const sameHost = ["me3-launcher.exe", "me3_mod_host.dll"].every(
    (name) => sameFile(path.join(linuxHost, name), path.join(winBinSrc, name)),
  );
  let windowsBinaries = "tools/me3-win/bin";
  if (!sameHost && fs.existsSync(linuxHost)) {
    fs.cpSync(linuxHost, path.join(toolsDst, "me3-linux", "bin", "win64"), { recursive: true });
    windowsBinaries = "tools/me3-linux/bin/win64";
  }

  const licenseDst = path.join(toolsDst, "me3");
  ensureDir(licenseDst);
  for (const name of ["LICENSE-MIT", "LICENSE-APACHE"]) {
    const file = path.join(me3Win, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(licenseDst, name));
  }
  return windowsBinaries;
}

export async function buildPack({
  recipe,
  source,
  out,
  link = true,
  version: requestedVersion,
  log = () => {},
}: BuildPackOptions): Promise<BuildPackResult> {
  if (!recipe) throw new Error("ELDEN RING driver needs a pack recipe");
  if (recipe.game !== GAME.id) throw new Error(`Recipe ${recipe.id} is not for ELDEN RING`);
  const modId = recipe.modId;
  const artId = recipe.artId || modId;
  const saveFile = recipe.saveFile || `ER0000.${modId}.sl2`;
  const src = path.resolve(source);
  const dst = path.resolve(out);
  const versionFile = path.join(src, "mods", modId, "current.txt");
  if (!fs.existsSync(versionFile)) throw new Error(`${recipe.name} is not installed at ${src}`);
  const version = String(requestedVersion || fs.readFileSync(versionFile, "utf8")).trim();
  if (!version) throw new Error("version is empty");

  const payloadSrc = path.join(src, "mods", modId, "versions", version);
  const profileSrc = path.join(src, "profiles", `${modId}-${version}.me3`);
  const me3Linux = path.join(src, "tools", "me3-linux");
  const me3Win = path.join(src, "tools", "me3-win");
  const artSrc = path.join(src, "art", artId);
  requirePath(payloadSrc, "mod payload");
  requirePath(profileSrc, "me3 profile");
  requirePath(me3Linux, "me3 Linux runtime");
  requirePath(me3Win, "me3 Windows runtime");
  requirePath(artSrc, "art");

  const platforms = paths.mergePlatforms(DEFAULT_PLATFORMS, recipe.platforms);
  paths.validatePlatforms(platforms, "pack.platforms");

  log(`Packing ${recipe.name} ${version} from ${src}`);
  fs.rmSync(dst, { recursive: true, force: true });
  ensureDir(path.join(dst, "payload", "versions"));

  let links = 0;
  let copies = 0;
  const payloadFiles = walkFiles(payloadSrc);
  for (let i = 0; i < payloadFiles.length; i++) {
    const file = payloadFiles[i];
    const target = path.join(dst, "payload", "versions", version, file.rel);
    const how = materialize(file.abs, target, link);
    if (how === "link") links++; else copies++;
    if ((i + 1) % 250 === 0 || i + 1 === payloadFiles.length) {
      log(`Hardlinking ${i + 1}/${payloadFiles.length}...`);
    }
  }
  log(`Payload: ${links} hardlinks, ${copies} copies`);

  log("Copying profile, tools, and art...");
  fs.cpSync(profileSrc, path.join(dst, "profiles", path.basename(profileSrc)), { recursive: true });
  const windowsBinaries = copyMe3Runtime(me3Linux, me3Win, path.join(dst, "tools"));
  const linuxProfile = platforms["linux-proton"];
  if (linuxProfile) linuxProfile.loaderSupport = windowsBinaries;
  fs.cpSync(artSrc, path.join(dst, "art", artId), { recursive: true });

  const toolFiles = walkFiles(path.join(dst, "tools"));
  const artFiles = walkFiles(path.join(dst, "art", artId));
  const totalEntries = payloadFiles.length + 1 + toolFiles.length + artFiles.length;
  let processed = 0;
  const files: PackFile[] = [];
  const byHash = new Map<string, PackFile>();
  const add = async (sourceRel: string, targetRel: string, platformList?: readonly Variant[] | null): Promise<void> => {
    const abs = path.join(dst, sourceRel);
    const size = fs.statSync(abs).size;
    const sha256 = await sha256File(abs);
    const mode = targetRel === "tools/me3-linux/bin/me3" ? "755" : modeFor(targetRel);
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
    const step = Math.max(1, Math.ceil(totalEntries / 10));
    if (processed === totalEntries || processed % step === 0) {
      log(`Hashing ${processed}/${totalEntries} (${Math.round((processed / totalEntries) * 100)}%)`);
    }
  };

  for (const file of payloadFiles) {
    await add(`payload/versions/${version}/${file.rel}`, `mods/${modId}/versions/${version}/${file.rel}`);
  }
  await add(`profiles/${path.basename(profileSrc)}`, `profiles/${path.basename(profileSrc)}`);
  for (const tool of toolFiles) {
    await add(`tools/${tool.rel}`, `tools/${tool.rel}`, platformsForTool(tool.rel, windowsBinaries));
  }
  for (const art of artFiles) {
    await add(`art/${artId}/${art.rel}`, `art/${artId}/${art.rel}`);
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const contents = contentsFor(recipe, src, version);
  const pack: Pack = {
    schema: 1,
    id: recipe.id,
    name: recipe.name,
    description: recipe.description || "",
    game: { ...GAME },
    platforms,
    mod: { id: modId, version },
    loader: { type: "me3", profile: `profiles/${modId}-${version}.me3` },
    profilePattern: "profiles/{mod}-{version}.me3",
    launch: {
      type: "me3",
      mode: "loader",
      defaultExe: "Game/eldenring.exe",
      exe: "Game/eldenring.exe",
      gameProcess: "eldenring.exe",
      steamAppId: GAME.appId,
      profile: `profiles/${modId}-${version}.me3`,
      saveFile,
    },
    art: {
      grid: `art/${artId}/grid.png`,
      hero: `art/${artId}/hero.png`,
      logo: `art/${artId}/logo.png`,
      icon: `art/${artId}/icon.png`,
    },
    notes: recipe.notes || [],
    preconditions: recipe.preconditions || [],
    contents,
    files: "files.json",
    save: { transfer: "out-of-scope" },
  };
  writeJson(path.join(dst, "pack.json"), pack);
  writeJson(path.join(dst, "files.json"), {
    schema: 1,
    pack: recipe.id,
    version,
    files,
  });
  writeText(path.join(dst, "README.md"), `# ${recipe.name} pack\n\nELDEN RING ${GAME.version} (build ${GAME.build})\n${recipe.name} ${version}\n\nThis pack is mod-only. It contains no base game and no saves.\n`);
  log(`Wrote ${files.length} files, ${formatBytes(totalBytes)}`);
  return { packRoot: dst, pack, files: files.length, totalBytes };
}

export { GAME };
