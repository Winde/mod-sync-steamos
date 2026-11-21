const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

let registryRoots = null;
let extraLibraries = [];

function setExtraLibraries(list) {
  extraLibraries = Array.isArray(list) ? list.filter((p) => typeof p === "string" && p) : [];
}

function addRoot(roots, value) {
  if (value) roots.push(value);
}

function windowsRegistryRoots() {
  if (registryRoots) return registryRoots;
  const found = [];
  const queries = [
    ["HKCU\\Software\\Valve\\Steam", "SteamPath"],
    ["HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"],
    ["HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"],
  ];
  for (const [key, value] of queries) {
    try {
      const out = execFileSync("reg", ["query", key, "/v", value], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const match = new RegExp(`${value}\\s+REG_SZ\\s+(.+)`, "i").exec(out);
      if (match) found.push(match[1].trim());
    } catch { }
  }
  registryRoots = found;
  return found;
}

function steamRoots() {
  const roots = [];
  if (process.platform === "win32") {
    addRoot(roots, process.env.STEAM_ROOT);
    const pf = process.env["ProgramFiles(x86)"] || process.env.ProgramFiles;
    if (pf) addRoot(roots, path.join(pf, "Steam"));
    for (const root of windowsRegistryRoots()) addRoot(roots, root);
  } else {
    addRoot(roots, process.env.STEAM_ROOT);
    addRoot(roots, path.join(os.homedir(), ".steam", "steam"));
    addRoot(roots, path.join(os.homedir(), ".steam", "root"));
    addRoot(roots, path.join(os.homedir(), ".local", "share", "Steam"));
    addRoot(roots, path.join(os.homedir(), ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"));
    addRoot(roots, path.join(os.homedir(), ".var", "app", "com.valvesoftware.Steam", ".steam", "steam"));
    addRoot(roots, path.join(os.homedir(), ".snap", "steam", "common", ".local", "share", "Steam"));
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
  for (const lib of extraLibraries) libs.add(lib);
  return [...libs].filter((p) => fs.existsSync(p));
}

function readManifest(library, appId) {
  const file = path.join(library, "steamapps", `appmanifest_${appId}.acf`);
  if (!fs.existsSync(file)) return null;
  const txt = fs.readFileSync(file, "utf8");
  const installDir = /"installdir"\s+"([^"]+)"/.exec(txt)?.[1] || "";
  let build = /"buildid"\s+"(\d+)"/.exec(txt)?.[1] || "";
  if (!build || build === "0") build = /"TargetBuildID"\s+"(\d+)"/.exec(txt)?.[1] || "";
  return { file, installDir, build };
}

function readBuild(library, appId) {
  const manifest = readManifest(library, appId);
  return manifest ? manifest.build || null : null;
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
  const libs = libraries();
  for (const lib of libs) {
    const manifest = readManifest(lib, game.appId);
    const installDir = (manifest && manifest.installDir) || game.installDir;
    if (!installDir) continue;
    const gameRoot = path.join(lib, "steamapps", "common", installDir);
    if (!fs.existsSync(gameRoot)) continue;
    const exe = game.exe ? path.join(gameRoot, game.exe) : null;
    const nativeExe = game.linuxExe ? path.join(gameRoot, game.linuxExe) : null;
    const exeReady = !!exe && fs.existsSync(exe);
    const nativeExeReady = !!nativeExe && fs.existsSync(nativeExe);
    const mode = process.platform === "win32"
      ? "windows"
      : (nativeExeReady && !exeReady ? "native" : "proton");
    const expectedPrefix = process.platform === "win32"
      ? null
      : path.join(lib, "steamapps", "compatdata", String(game.appId), "pfx");
    let prefix = null;
    if (process.platform !== "win32" && mode !== "native") {
      for (const candidate of libs) {
        const p = path.join(candidate, "steamapps", "compatdata", String(game.appId), "pfx");
        if (fs.existsSync(p)) { prefix = p; break; }
      }
      if (!prefix) prefix = expectedPrefix;
    }
    return {
      library: lib,
      root: gameRoot,
      installDir,
      exe: exeReady ? exe : (nativeExeReady ? nativeExe : null),
      build: manifest ? manifest.build || null : null,
      mode,
      native: mode === "native",
      prefix,
      prefixReady: mode === "native" ? false : (prefix ? fs.existsSync(prefix) : true),
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

function unquote(value) {
  return String(value || "").replace(/^"|"$/g, "");
}

function sameShortcut(a, b) {
  const nameA = String(a.appname || a.AppName || "").trim().toLowerCase();
  const nameB = String(b.appname || b.AppName || "").trim().toLowerCase();
  if (nameA && nameA === nameB) return true;
  const exeA = unquote(a.Exe || a.exe).replace(/\//g, "\\").toLowerCase();
  const exeB = unquote(b.Exe || b.exe).replace(/\//g, "\\").toLowerCase();
  return !!exeA && exeA === exeB;
}

function mergeShortcut(list, entry) {
  const out = [];
  let match = null;
  let deduped = 0;
  for (const item of list) {
    if (!match && sameShortcut(item, entry)) {
      match = { ...item, ...entry };
      out.push(match);
    } else if (match && sameShortcut(item, entry)) {
      deduped++;
    } else {
      out.push(item);
    }
  }
  if (!match) {
    out.push(entry);
    return { list: out, action: "added", deduped };
  }
  return { list: out, action: "updated", deduped };
}

function shortcutList(parsed) {
  return Array.isArray(parsed.shortcuts) ? parsed.shortcuts : Object.values(parsed.shortcuts || {});
}

function entryAppId(entry) {
  const stored = Number(entry.appid);
  if (Number.isFinite(stored)) return stored >>> 0;
  return shortcutId(`${entry.Exe || entry.exe || ""}${entry.appname || entry.AppName || ""}`).unsigned;
}

function removeGridArt(configDir, id) {
  const grid = path.join(configDir, "grid");
  for (const suffix of [".png", "p.png", "_grid.png", "_hero.png", "_logo.png", "_icon.png"]) {
    fs.rmSync(path.join(grid, `${id}${suffix}`), { force: true });
  }
}

async function readShortcuts(file) {
  const shortcut = require("steam-shortcut-editor");
  return new Promise((resolve, reject) => {
    shortcut.parseFile(file, { autoConvertArrays: true, autoConvertBooleans: true, dateProperties: ["LastPlayTime"] }, (err, parsed) => {
      if (err) reject(err); else resolve(parsed);
    });
  });
}

async function writeShortcuts(file, list) {
  const shortcut = require("steam-shortcut-editor");
  await new Promise((resolve, reject) => {
    shortcut.writeFile(file, { shortcuts: list }, (err) => err ? reject(err) : resolve());
  });
}

async function removeShortcut({ exePath }) {
  const ud = findUserData();
  if (!ud) return { removed: 0 };
  const file = path.join(ud.configDir, "shortcuts.vdf");
  if (!fs.existsSync(file)) return { removed: 0 };
  const parsed = await readShortcuts(file);
  const target = unquote(exePath).replace(/\//g, "\\").toLowerCase();
  const removed = [];
  const keep = [];
  for (const item of shortcutList(parsed)) {
    const exe = unquote(item.Exe || item.exe).replace(/\//g, "\\").toLowerCase();
    if (target && exe === target) removed.push(item); else keep.push(item);
  }
  if (!removed.length) return { removed: 0 };
  fs.copyFileSync(file, `${file}.modsync-${Date.now()}.bak`);
  await writeShortcuts(file, keep);
  for (const item of removed) removeGridArt(ud.configDir, entryAppId(item));
  return { removed: removed.length };
}

/**
 * Remove shortcuts whose executable lives under this ModSync root but no
 * longer exists. Used at startup to clean up after a pack was removed.
 */
async function pruneMissingShortcuts({ prefix }) {
  const ud = findUserData();
  if (!ud) return { removed: 0 };
  const file = path.join(ud.configDir, "shortcuts.vdf");
  if (!fs.existsSync(file)) return { removed: 0 };
  const parsed = await readShortcuts(file);
  const wanted = unquote(prefix).replace(/\//g, "\\").toLowerCase();
  const base = wanted.endsWith("\\") ? wanted : `${wanted}\\`;
  const removed = [];
  const keep = [];
  for (const item of shortcutList(parsed)) {
    const raw = unquote(item.Exe || item.exe);
    const exe = raw.replace(/\//g, "\\").toLowerCase();
    if (base && exe.startsWith(base) && !fs.existsSync(raw)) removed.push(item);
    else keep.push(item);
  }
  if (!removed.length) return { removed: 0 };
  fs.copyFileSync(file, `${file}.modsync-${Date.now()}.bak`);
  await writeShortcuts(file, keep);
  for (const item of removed) removeGridArt(ud.configDir, entryAppId(item));
  return { removed: removed.length };
}

async function registerShortcut({ exePath, name, icon, art, allowOverlay = true }) {
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
    AllowOverlay: allowOverlay !== false,
    OpenVR: false,
    Devkit: false,
    DevkitGameID: "",
    DevkitOverrideAppID: false,
    LastPlayTime: 0,
    FlatpakAppID: "",
    sortas: "",
    tags: [],
  };
  const merged = mergeShortcut(list, entry);

  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.modsync-${Date.now()}.bak`);
  }
  await new Promise((resolve, reject) => {
    shortcut.writeFile(file, { shortcuts: merged.list }, (err) => err ? reject(err) : resolve());
  });

  const grid = path.join(ud.configDir, "grid");
  fs.mkdirSync(grid, { recursive: true });
  const src = art || {};
  const pairs = [
    [src.header, `${id.unsigned}.png`],
    [src.portrait || src.grid, `${id.unsigned}p.png`],
    [src.grid, `${id.unsigned}_grid.png`],
    [src.hero, `${id.unsigned}_hero.png`],
    [src.logo, `${id.unsigned}_logo.png`],
    [src.icon, `${id.unsigned}_icon.png`],
  ];
  for (const [from, to] of pairs) {
    if (from && fs.existsSync(from)) fs.copyFileSync(from, path.join(grid, to));
  }
  return {
    appId: id.unsigned,
    configDir: ud.configDir,
    userId: ud.userId,
    file,
    action: merged.action,
    deduped: merged.deduped,
  };
}

module.exports = {
  steamRoots, libraries, findGame, findUserData, findAppManifest, readManifest,
  readInstalledDepots, registerShortcut, removeShortcut, pruneMissingShortcuts,
  shortcutId, mergeShortcut, setExtraLibraries,
};
