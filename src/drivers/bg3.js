const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ensureDir, writeJson, writeText, walkFiles, materialize,
  sha256File, modeFor, formatBytes,
} = require("../util");
const steam = require("../steam");

const PACK_ID = "bg3-modded";
const MOD_ID = "bg3";
const GAME = {
  id: "bg3",
  title: "Baldur's Gate 3",
  store: "steam",
  appId: 1086940,
  installDir: "Baldurs Gate 3",
  exe: "bin/bg3.exe",
  build: "25605617",
  version: "Patch 8",
  prefix: true,
};

function defaultSource() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Larian Studios", "Baldur's Gate 3");
  }
  const game = steam.findGame(GAME);
  return game
    ? path.join(game.prefix, "drive_c", "users", "steamuser", "AppData", "Local", "Larian Studios", "Baldur's Gate 3")
    : path.join(os.homedir(), ".local", "share", "Larian Studios", "Baldur's Gate 3");
}

function defaultVersion() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, ".");
}

const BUILTIN_MODULES = new Set(["GustavX", "HonourX"]);

function parseModSettings(xml) {
  const mods = [];
  for (const match of String(xml).matchAll(/<node id="ModuleShortDesc">([\s\S]*?)<\/node>/g)) {
    const attrs = {};
    for (const attr of match[1].matchAll(/<attribute id="([^"]+)"[^>]*value="([^"]*)"/g)) {
      attrs[attr[1]] = attr[2];
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

function matchPak(mod, paks, used) {
  const folder = String(mod.folder || "").toLowerCase();
  const short = folder.split("_")[0];
  const id = String(mod.id || "").toLowerCase();
  return paks.find((name) => {
    if (used.has(name)) return false;
    const lower = name.toLowerCase();
    return (folder && lower.startsWith(folder))
      || (short && lower.startsWith(short))
      || (id && lower.includes(id));
  }) || null;
}

function contentsFor(source, paks) {
  const xml = fs.readFileSync(path.join(source, "PlayerProfiles", "Public", "modsettings.lsx"), "utf8");
  const mods = parseModSettings(xml);
  const used = new Set();
  for (const mod of mods) {
    if (mod.builtin) continue;
    const file = matchPak(mod, paks, used);
    if (file) {
      mod.file = `Mods/${file}`;
      used.add(file);
    }
  }
  return {
    kind: "mods",
    source: "modsettings.lsx",
    generatedAt: new Date().toISOString(),
    count: mods.filter((mod) => !mod.builtin).length,
    modules: mods.length,
    paks: paks.length,
    inactivePaks: paks.filter((name) => !used.has(name)),
    mods,
  };
}

function discover(source) {
  const modsDir = path.join(source, "Mods");
  const paks = fs.existsSync(modsDir)
    ? fs.readdirSync(modsDir).filter((name) => name.toLowerCase().endsWith(".pak")).sort()
    : [];
  return contentsFor(source, paks);
}

function requireDir(p, label) {
  if (!fs.existsSync(p)) throw new Error(`${label} not found: ${p}`);
}

function copyTree(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

async function buildPack({ recipe, source, out, link = true, version: requestedVersion, gameRoot: requestedGameRoot, log = () => {} }) {
  if (recipe && recipe.game !== GAME.id) throw new Error(`Recipe ${recipe.id} is not for Baldur's Gate 3`);
  const packId = recipe && recipe.id ? recipe.id : PACK_ID;
  const modId = recipe && recipe.modId ? recipe.modId : MOD_ID;
  const packName = recipe && recipe.name ? recipe.name : "BG3 Modded";
  const packDescription = recipe && recipe.description
    ? recipe.description
    : "Baldur's Gate 3 mod snapshot with modsettings and Script Extender";
  const src = path.resolve(source || defaultSource());
  const dst = path.resolve(out);
  const version = String(requestedVersion || defaultVersion());
  const modsDir = path.join(src, "Mods");
  const modsettings = path.join(src, "PlayerProfiles", "Public", "modsettings.lsx");
  const scriptExtender = path.join(src, "Script Extender");
  const game = steam.findGame(GAME);
  const gameRoot = requestedGameRoot ? path.resolve(requestedGameRoot) : (game ? game.root : "");

  requireDir(modsDir, "BG3 Mods folder");
  requireDir(path.dirname(modsettings), "BG3 profile folder");
  if (!fs.existsSync(modsettings)) throw new Error(`modsettings.lsx not found: ${modsettings}`);

  const paks = fs.readdirSync(modsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".pak"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  if (!paks.length) throw new Error(`No .pak files in ${modsDir}`);

  log(`Packing BG3 mods ${version} from ${src}`);
  fs.rmSync(dst, { recursive: true, force: true });
  const payload = path.join(dst, "payload", "versions", version);
  ensureDir(path.join(payload, "Mods"));
  ensureDir(path.join(payload, "bg3se"));

  let copied = 0;
  let bytes = 0;
  for (const name of paks) {
    const from = path.join(modsDir, name);
    const to = path.join(payload, "Mods", name);
    materialize(from, to, link);
    bytes += fs.statSync(to).size;
    copied++;
    if (copied % 10 === 0 || copied === paks.length) {
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

  const artSrc = path.resolve(__dirname, "..", "..", "web");
  const artDst = path.join(dst, "art", MOD_ID);
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

  const files = [];
  let processed = 0;
  const payloadFiles = walkFiles(payload);
  const artFiles = walkFiles(artDst);
  const total = payloadFiles.length + artFiles.length;
  const add = async (sourceRel, targetRel) => {
    const abs = path.join(dst, sourceRel);
    const size = fs.statSync(abs).size;
    const sha256 = await sha256File(abs);
    files.push({ source: sourceRel, target: targetRel, size, sha256, mode: modeFor(targetRel) });
    processed++;
    const step = Math.max(1, Math.ceil(total / 10));
    if (processed === total || processed % step === 0) {
      log(`Hashing ${processed}/${total} (${Math.round((processed / total) * 100)}%)`);
    }
  };

  for (const file of payloadFiles) {
    await add(`payload/versions/${version}/${file.rel}`, `mods/${modId}/versions/${version}/${file.rel}`);
  }
  for (const art of artFiles) {
    await add(`art/${modId}/${art.rel}`, `art/${modId}/${art.rel}`);
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const notes = [...(recipe && Array.isArray(recipe.notes) ? recipe.notes : [])];
  notes.push({
    title: "Script Extender",
    body: bg3seFiles
      ? "BG3 Script Extender is included and applied with the pack."
      : "This pack has no BG3 Script Extender files. Install BG3SE in the game before using Script Extender mods.",
    tone: bg3seFiles ? "info" : "warning",
  });
  const contents = contentsFor(src, paks);
  const preconditions = recipe && Array.isArray(recipe.preconditions)
    ? recipe.preconditions
    : [
      { id: "game-installed", type: "game-installed", required: true, title: "Baldur's Gate 3 is installed" },
      { id: "game-build", type: "game-build", required: true, build: GAME.build, title: `Game is build ${GAME.build} (${GAME.version})` },
      { id: "proton-prefix", type: "proton-prefix", required: true, title: "Proton prefix exists", hint: "Launch the vanilla game once from Steam." },
      { id: "game-closed", type: "game-not-running", required: true, title: "Game is closed" },
      { id: "disk-free", type: "disk-free", required: true, reserveBytes: 1024 * 1024 * 1024, title: "Enough space for the pack" },
      { id: "disk-free-game", type: "disk-free", scope: "game", required: true, reserveBytes: 1024 * 1024 * 1024, title: "Enough space to apply the pack" },
    ];

  const pack = {
    schema: 1,
    id: packId,
    name: packName,
    description: packDescription,
    game: { ...GAME },
    mod: { id: modId, version },
    loader: { type: "bg3se", profile: `mods/${modId}/versions/${version}/modsettings.lsx` },
    launch: {
      type: "steam",
      exe: "bin/bg3.exe",
      gameProcess: "bg3.exe",
      steamAppId: GAME.appId,
      profile: `mods/${modId}/versions/${version}/modsettings.lsx`,
      saveFile: "PlayerProfiles/Public",
      dataDir: "drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3",
    },
    install: {
      type: "bg3",
      dataDir: "drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3",
      bg3se: bg3seFiles > 0,
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
    save: { transfer: "out-of-scope" },
  };

  writeJson(path.join(dst, "pack.json"), pack);
  writeJson(path.join(dst, "files.json"), { schema: 1, pack: packId, version, files });
  writeText(path.join(dst, "README.md"), `# ${packName} pack\n\nBaldur's Gate 3 ${GAME.version} (build ${GAME.build})\n${paks.length} mods, ${version}\n\nMods and modsettings only. No base game, no saves.\n`);
  log(`Wrote ${files.length} files, ${formatBytes(totalBytes)}`);
  return { packRoot: dst, pack, files: files.length, totalBytes };
}

module.exports = { buildPack, defaultSource, discover, contentsFor, parseModSettings, PACK_ID, MOD_ID, GAME };
