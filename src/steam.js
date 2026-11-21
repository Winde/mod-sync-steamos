const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

function steamRoots() {
  const roots = [];
  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles(x86)"] || process.env.ProgramFiles;
    if (pf) roots.push(path.join(pf, "Steam"));
  } else {
    roots.push(path.join(os.homedir(), ".steam", "steam"));
    roots.push(path.join(os.homedir(), ".local", "share", "Steam"));
  }
  return [...new Set(roots)].filter((p) => fs.existsSync(p));
}

function libraries() {
  const libs = new Set();
  for (const root of steamRoots()) {
    libs.add(root);
    const vdf = path.join(root, "steamapps", "libraryfolders.vdf");
    if (!fs.existsSync(vdf)) continue;
    const txt = fs.readFileSync(vdf, "utf8");
    for (const m of txt.matchAll(/"path"\s+"([^"]+)"/g)) {
      let p = m[1];
      if (process.platform === "win32") p = p.replace(/\\\\/g, "\\");
      libs.add(p);
    }
  }
  return [...libs].filter((p) => fs.existsSync(p));
}

function readBuild(library, appId) {
  const manifest = path.join(library, "steamapps", `appmanifest_${appId}.acf`);
  if (!fs.existsSync(manifest)) return null;
  const txt = fs.readFileSync(manifest, "utf8");
  let m = txt.match(/"buildid"\s+"(\d+)"/);
  if (m && m[1] !== "0") return m[1];
  m = txt.match(/"TargetBuildID"\s+"(\d+)"/);
  return m ? m[1] : null;
}

function findAppManifest(appId) {
  for (const lib of libraries()) {
    const manifest = path.join(lib, "steamapps", `appmanifest_${appId}.acf`);
    if (fs.existsSync(manifest)) return manifest;
  }
  return null;
}

function readInstalledDepots(library, appId) {
  const manifest = path.join(library, "steamapps", `appmanifest_${appId}.acf`);
  if (!fs.existsSync(manifest)) return null;
  const txt = fs.readFileSync(manifest, "utf8");
  const block = txt.match(/"InstalledDepots"\s*\{([\s\S]*?)\n\t\}/);
  if (!block) return [];
  return [...block[1].matchAll(/"(\d+)"\s*\{/g)].map((m) => Number(m[1]));
}

function findGame(game) {
  if (!game || !game.appId) return null;
  for (const lib of libraries()) {
    const gameRoot = path.join(lib, "steamapps", "common", game.installDir);
    const exe = path.join(gameRoot, game.exe || "Game/eldenring.exe");
    if (!fs.existsSync(exe)) continue;
    const prefix = process.platform === "win32"
      ? null
      : path.join(lib, "steamapps", "compatdata", String(game.appId), "pfx");
    return {
      library: lib,
      root: gameRoot,
      exe,
      build: readBuild(lib, game.appId),
      prefix,
      prefixReady: prefix ? fs.existsSync(prefix) : true,
      platform: process.platform,
    };
  }
  return null;
}

function findUserData() {
  for (const root of steamRoots()) {
    const ud = path.join(root, "userdata");
    if (!fs.existsSync(ud)) continue;
    for (const ent of fs.readdirSync(ud, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const config = path.join(ud, ent.name, "config");
      if (fs.existsSync(config)) return { root, userId: ent.name, configDir: config };
    }
  }
  return null;
}

function shortcutId(str) {
  const u = (zlib.crc32(Buffer.from(str, "utf8")) | 0x80000000) >>> 0;
  return { unsigned: u, signed: u | 0 };
}

async function registerShortcut({ exePath, name, icon, art }) {
  const shortcut = require("steam-shortcut-editor");
  const ud = findUserData();
  if (!ud) throw new Error("Steam userdata/config not found. Add the shortcut manually.");
  const file = path.join(ud.configDir, "shortcuts.vdf");
  const quotedExe = `"${exePath}"`;
  const id = shortcutId(quotedExe + name);
  const startDir = `"${path.dirname(exePath)}${path.sep}"`;

  let obj = { shortcuts: [] };
  if (fs.existsSync(file)) {
    obj = await new Promise((resolve, reject) => {
      shortcut.parseFile(file, { autoConvertArrays: true, autoConvertBooleans: true, dateProperties: ["LastPlayTime"] }, (err, parsed) => {
        if (err) reject(err); else resolve(parsed);
      });
    });
  }
  const list = Array.isArray(obj.shortcuts) ? obj.shortcuts : Object.values(obj.shortcuts || {});
  const entry = {
    appid: id.signed,
    appname: name,
    Exe: quotedExe,
    StartDir: startDir,
    icon: icon || "",
    ShortcutPath: "",
    LaunchOptions: "",
    IsHidden: false,
    AllowDesktopConfig: true,
    AllowOverlay: true,
    OpenVR: false,
    Devkit: false,
    DevkitGameID: "",
    DevkitOverrideAppID: false,
    LastPlayTime: 0,
    FlatpakAppID: "",
    sortas: "",
    tags: [],
  };
  const idx = list.findIndex((s) => String(s.appname || s.AppName || "").toLowerCase() === name.toLowerCase());
  if (idx >= 0) list[idx] = { ...list[idx], ...entry }; else list.push(entry);

  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.modsync-${Date.now()}.bak`);
  }
  await new Promise((resolve, reject) => {
    shortcut.writeFile(file, { shortcuts: list }, (err) => err ? reject(err) : resolve());
  });

  const grid = path.join(ud.configDir, "grid");
  fs.mkdirSync(grid, { recursive: true });
  const src = art || {};
  const pairs = [
    [src.grid, `${id.unsigned}p.png`],
    [src.grid, `${id.unsigned}_grid.png`],
    [src.hero, `${id.unsigned}_hero.png`],
    [src.logo, `${id.unsigned}_logo.png`],
  ];
  for (const [from, to] of pairs) {
    if (from && fs.existsSync(from)) fs.copyFileSync(from, path.join(grid, to));
  }
  return { appId: id.unsigned, configDir: ud.configDir, userId: ud.userId, file };
}

module.exports = {
  steamRoots, libraries, findGame, findUserData, findAppManifest,
  readInstalledDepots, registerShortcut, shortcutId,
};
