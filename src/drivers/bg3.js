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

function requireDir(p, label) {
  if (!fs.existsSync(p)) throw new Error(`${label} not found: ${p}`);
}

function copyTree(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

async function buildPack({ source, out, link = true, version: requestedVersion, gameRoot: requestedGameRoot, log = () => {} }) {
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
    await add(`payload/versions/${version}/${file.rel}`, `mods/${MOD_ID}/versions/${version}/${file.rel}`);
  }
  for (const art of artFiles) {
    await add(`art/${MOD_ID}/${art.rel}`, `art/${MOD_ID}/${art.rel}`);
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const notes = [
    {
      title: "Close Baldur's Gate 3 before installing",
      body: "The pack writes mods and modsettings into the game's Proton prefix. Close the game and its launcher first.",
      tone: "warning",
    },
    {
      title: "Script Extender",
      body: bg3seFiles
        ? "BG3 Script Extender is included and applied with the pack."
        : "This pack has no BG3 Script Extender files. Install BG3SE in the game before using Script Extender mods.",
      tone: bg3seFiles ? "info" : "warning",
    },
    {
      title: "Saves",
      body: "Saves are not part of the pack and are not synced. Adding or removing mods can affect existing saves.",
      tone: "warning",
    },
  ];

  const pack = {
    schema: 1,
    id: PACK_ID,
    name: "BG3 Modded",
    description: "Baldur's Gate 3 mod snapshot with modsettings and Script Extender",
    game: { ...GAME },
    mod: { id: MOD_ID, version },
    loader: { type: "bg3se", profile: `mods/${MOD_ID}/versions/${version}/modsettings.lsx` },
    launch: {
      type: "steam",
      exe: "bin/bg3.exe",
      gameProcess: "bg3.exe",
      steamAppId: GAME.appId,
      profile: `mods/${MOD_ID}/versions/${version}/modsettings.lsx`,
      saveFile: "PlayerProfiles/Public",
      dataDir: "drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3",
    },
    install: {
      type: "bg3",
      dataDir: "drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3",
      bg3se: bg3seFiles > 0,
    },
    art: {
      grid: `art/${MOD_ID}/grid.png`,
      hero: `art/${MOD_ID}/hero.png`,
      logo: `art/${MOD_ID}/logo.png`,
      icon: `art/${MOD_ID}/icon.png`,
      header: `art/${MOD_ID}/header.png`,
      portrait: `art/${MOD_ID}/portrait.png`,
    },
    notes,
    preconditions: [
      { id: "game-installed", type: "game-installed", required: true, title: "Baldur's Gate 3 is installed" },
      { id: "game-build", type: "game-build", required: true, build: GAME.build, title: "Game is build 25605617 (Patch 8)" },
      { id: "proton-prefix", type: "proton-prefix", required: true, title: "Proton prefix exists", hint: "Launch the vanilla game once from Steam." },
      { id: "game-closed", type: "game-not-running", required: true, title: "Game is closed" },
      { id: "disk-free", type: "disk-free", required: true, reserveBytes: 1024 * 1024 * 1024, title: "Enough free space" },
    ],
    files: "files.json",
    save: { transfer: "out-of-scope" },
  };

  writeJson(path.join(dst, "pack.json"), pack);
  writeJson(path.join(dst, "files.json"), { schema: 1, pack: PACK_ID, version, files });
  writeText(path.join(dst, "README.md"), `# BG3 Modded pack\n\nBaldur's Gate 3 ${GAME.version} (build ${GAME.build})\n${paks.length} mods, ${version}\n\nMods and modsettings only. No base game, no saves.\n`);
  log(`Wrote ${files.length} files, ${formatBytes(totalBytes)}`);
  return { packRoot: dst, pack, files: files.length, totalBytes };
}

module.exports = { buildPack, defaultSource, PACK_ID, MOD_ID, GAME };
