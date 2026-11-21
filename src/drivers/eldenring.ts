import fs from "node:fs";
import path from "node:path";
import {
  ensureDir, writeJson, writeText, walkFiles, materialize,
  sha256File, formatBytes,
} from "../util";
import * as me3 from "../loaders/me3";
import * as paths from "../paths";
import type {
  BuildPackOptions,
  BuildPackResult,
  GameInfo,
  Pack,
  PackFile,
  Platforms,
  Variant,
} from "../types";

export { contentsFor, parseMe3Profile } from "../loaders/me3";

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
    template: me3.TEMPLATE,
  },
  "linux-proton": {
    exe: "Game/eldenring.exe",
    gameProcess: "eldenring.exe",
    loader: "tools/me3-linux/bin/me3",
    template: me3.TEMPLATE,
  },
};

export function defaultSource(): string {
  return "D:\\EldenRingMods";
}

function requirePath(p: string, label: string): void {
  if (!fs.existsSync(p)) throw new Error(`${label} not found: ${p}`);
}

export async function buildPack({
  recipe,
  source,
  out,
  link = true,
  version: requestedVersion,
  log = () => {},
}: BuildPackOptions): Promise<BuildPackResult> {
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
  const profileSrc = me3.profileFile(src, modId, version);
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
  const windowsBinaries = me3.copyRuntime(me3Linux, me3Win, path.join(dst, "tools"));
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
    const mode = me3.modeForTarget(targetRel);
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
    await add(`tools/${tool.rel}`, `tools/${tool.rel}`, me3.platformsForTool(tool.rel, windowsBinaries));
  }
  for (const art of artFiles) {
    await add(`art/${artId}/${art.rel}`, `art/${artId}/${art.rel}`);
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const contents = me3.contentsFor({ recipe, source: src, version });
  const pack: Pack = {
    schema: 1,
    id: recipe.id,
    name: recipe.name,
    description: recipe.description || "",
    game: { ...GAME },
    platforms,
    mod: { id: modId, version },
    loader: {
      type: me3.TYPE,
      profile: `profiles/${modId}-${version}.me3`,
      saveFile,
    },
    profilePattern: me3.PROFILE_PATTERN,
    launch: {
      type: me3.TYPE,
      mode: "loader",
      defaultExe: "Game/eldenring.exe",
      exe: "Game/eldenring.exe",
      gameProcess: "eldenring.exe",
      steamAppId: GAME.appId,
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
