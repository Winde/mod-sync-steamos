import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import type { GameInfo, SteamGame } from "./types";

let registryRoots: string[] | null = null;
let extraLibraries: string[] = [];

export function setExtraLibraries(list: unknown): void {
  extraLibraries = Array.isArray(list) ? list.filter((p): p is string => typeof p === "string" && !!p) : [];
}

function addRoot(roots: string[], value: string | null | undefined): void {
  if (value) roots.push(value);
}

function windowsRegistryRoots(): string[] {
  if (registryRoots) return registryRoots;
  const found: string[] = [];
  const queries: Array<[string, string]> = [
    ["HKCU\\Software\\Valve\\Steam", "SteamPath"],
    ["HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"],
    ["HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"],
  ];
  for (const [key, value] of queries) {
    try {
      const out = execFileSync("reg", ["query", key, "/v", value], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const match = new RegExp(`${value}\\s+REG_SZ\\s+(.+)`, "i").exec(out);
      if (match) found.push(match[1].trim());
    } catch { /* registry key missing */ }
  }
  registryRoots = found;
  return found;
}

export function steamRoots(): string[] {
  const roots: string[] = [];
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

export function libraries(): string[] {
  const libs = new Set<string>();
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

interface Manifest {
  file: string;
  installDir: string;
  build: string;
}

export function readManifest(library: string, appId: number): Manifest | null {
  const file = path.join(library, "steamapps", `appmanifest_${appId}.acf`);
  if (!fs.existsSync(file)) return null;
  const txt = fs.readFileSync(file, "utf8");
  const installDir = /"installdir"\s+"([^"]+)"/.exec(txt)?.[1] || "";
  let build = /"buildid"\s+"(\d+)"/.exec(txt)?.[1] || "";
  if (!build || build === "0") build = /"TargetBuildID"\s+"(\d+)"/.exec(txt)?.[1] || "";
  return { file, installDir, build };
}

export function readBuild(library: string, appId: number): string | null {
  const manifest = readManifest(library, appId);
  return manifest ? manifest.build || null : null;
}

export function findAppManifest(appId: number): string | null {
  for (const lib of libraries()) {
    const manifest = path.join(lib, "steamapps", `appmanifest_${appId}.acf`);
    if (fs.existsSync(manifest)) return manifest;
  }
  return null;
}

export function readInstalledDepots(library: string, appId: number): number[] | null {
  const manifest = path.join(library, "steamapps", `appmanifest_${appId}.acf`);
  if (!fs.existsSync(manifest)) return null;
  const txt = fs.readFileSync(manifest, "utf8");
  const block = txt.match(/"InstalledDepots"\s*\{([\s\S]*?)\n\t\}/);
  if (!block) return [];
  return [...block[1].matchAll(/"(\d+)"\s*\{/g)].map((m) => Number(m[1]));
}

export function findGame(game: GameInfo | null | undefined): SteamGame | null {
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
    let prefix: string | null = null;
    if (process.platform !== "win32" && mode !== "native") {
      for (const candidate of libs) {
        const p = path.join(candidate, "steamapps", "compatdata", String(game.appId), "pfx");
        if (fs.existsSync(p)) { prefix = p; break; }
      }
      if (!prefix) prefix = expectedPrefix;
    }
    return {
      library: lib,
      appId: game.appId,
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

export interface SteamUserData {
  root: string;
  userId: string;
  configDir: string;
}

export function findUserData(): SteamUserData | null {
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

export function shortcutId(str: string): { unsigned: number; signed: number } {
  const u = (zlib.crc32(Buffer.from(str, "utf8")) | 0x80000000) >>> 0;
  return { unsigned: u, signed: u | 0 };
}

function unquote(value: unknown): string {
  return String(value || "").replace(/^"|"$/g, "");
}

interface ShortcutEntry {
  appid?: number;
  appname?: string;
  Exe?: string;
  StartDir?: string;
  icon?: string;
  ShortcutPath?: string;
  LaunchOptions?: string;
  IsHidden?: boolean;
  AllowDesktopConfig?: boolean;
  AllowOverlay?: boolean;
  OpenVR?: boolean;
  Devkit?: boolean;
  DevkitGameID?: string;
  DevkitOverrideAppID?: boolean;
  LastPlayTime?: number;
  FlatpakAppID?: string;
  sortas?: string;
  tags?: string[];
  [key: string]: unknown;
}

function sameShortcut(a: ShortcutEntry, b: ShortcutEntry): boolean {
  const nameA = String(a.appname || a.AppName || "").trim().toLowerCase();
  const nameB = String(b.appname || b.AppName || "").trim().toLowerCase();
  if (nameA && nameA === nameB) return true;
  const exeA = unquote(a.Exe || a.exe).replace(/\//g, "\\").toLowerCase();
  const exeB = unquote(b.Exe || b.exe).replace(/\//g, "\\").toLowerCase();
  return !!exeA && exeA === exeB;
}

export function mergeShortcut<T extends ShortcutEntry>(
  list: T[],
  entry: T,
): { list: T[]; action: "added" | "updated"; deduped: number } {
  const out: T[] = [];
  let match: T | null = null;
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

interface ShortcutEditor {
  parseFile(
    file: string,
    options: Record<string, unknown>,
    callback: (err: Error | null, parsed: unknown) => void,
  ): void;
  writeFile(file: string, data: unknown, callback: (err: Error | null) => void): void;
}

function shortcutList(parsed: unknown): ShortcutEntry[] {
  const value = (parsed && typeof parsed === "object" ? parsed : {}) as {
    shortcuts?: ShortcutEntry[] | Record<string, ShortcutEntry>;
  };
  return Array.isArray(value.shortcuts) ? value.shortcuts : Object.values(value.shortcuts || {});
}

function entryAppId(entry: ShortcutEntry): number {
  const stored = Number(entry.appid);
  if (Number.isFinite(stored)) return stored >>> 0;
  return shortcutId(`${entry.Exe || entry.exe || ""}${entry.appname || entry.AppName || ""}`).unsigned;
}

function removeGridArt(configDir: string, id: number): void {
  const grid = path.join(configDir, "grid");
  for (const suffix of [".png", "p.png", "_grid.png", "_hero.png", "_logo.png", "_icon.png"]) {
    fs.rmSync(path.join(grid, `${id}${suffix}`), { force: true });
  }
}

async function readShortcuts(file: string): Promise<unknown> {
  const shortcut = require("steam-shortcut-editor") as ShortcutEditor;
  return new Promise((resolve, reject) => {
    shortcut.parseFile(file, { autoConvertArrays: true, autoConvertBooleans: true, dateProperties: ["LastPlayTime"] }, (err, parsed) => {
      if (err) reject(err); else resolve(parsed);
    });
  });
}

async function writeShortcuts(file: string, list: ShortcutEntry[]): Promise<void> {
  const shortcut = require("steam-shortcut-editor") as ShortcutEditor;
  await new Promise<void>((resolve, reject) => {
    shortcut.writeFile(file, { shortcuts: list }, (err) => err ? reject(err) : resolve());
  });
}

export async function removeShortcut({ exePath }: { exePath: string }): Promise<{ removed: number }> {
  const ud = findUserData();
  if (!ud) return { removed: 0 };
  const file = path.join(ud.configDir, "shortcuts.vdf");
  if (!fs.existsSync(file)) return { removed: 0 };
  const parsed = await readShortcuts(file);
  const target = unquote(exePath).replace(/\//g, "\\").toLowerCase();
  const removed: ShortcutEntry[] = [];
  const keep: ShortcutEntry[] = [];
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
export async function pruneMissingShortcuts({ prefix }: { prefix: string }): Promise<{ removed: number }> {
  const ud = findUserData();
  if (!ud) return { removed: 0 };
  const file = path.join(ud.configDir, "shortcuts.vdf");
  if (!fs.existsSync(file)) return { removed: 0 };
  const parsed = await readShortcuts(file);
  const wanted = unquote(prefix).replace(/\//g, "\\").toLowerCase();
  const base = wanted.endsWith("\\") ? wanted : `${wanted}\\`;
  const removed: ShortcutEntry[] = [];
  const keep: ShortcutEntry[] = [];
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

export interface ShortcutArt {
  grid?: string;
  hero?: string;
  logo?: string;
  icon?: string;
  header?: string;
  portrait?: string;
}

export async function registerShortcut({
  exePath,
  name,
  icon,
  art,
  allowOverlay = true,
}: {
  exePath: string;
  name: string;
  icon?: string;
  art?: ShortcutArt;
  allowOverlay?: boolean;
}): Promise<{
  appId: number;
  configDir: string;
  userId: string;
  file: string;
  action: "added" | "updated";
  deduped: number;
}> {
  const shortcut = require("steam-shortcut-editor") as ShortcutEditor;
  const ud = findUserData();
  if (!ud) throw new Error("Steam userdata/config not found. Add the shortcut manually.");
  const file = path.join(ud.configDir, "shortcuts.vdf");
  const quotedExe = `"${exePath}"`;
  const id = shortcutId(quotedExe + name);
  const startDir = `"${path.dirname(exePath)}${path.sep}"`;

  let obj: { shortcuts: ShortcutEntry[] | Record<string, ShortcutEntry> } = { shortcuts: [] };
  if (fs.existsSync(file)) {
    obj = await new Promise((resolve, reject) => {
      shortcut.parseFile(file, { autoConvertArrays: true, autoConvertBooleans: true, dateProperties: ["LastPlayTime"] }, (err, parsed) => {
        if (err) reject(err); else resolve(parsed as { shortcuts: ShortcutEntry[] | Record<string, ShortcutEntry> });
      });
    });
  }
  const list: ShortcutEntry[] = Array.isArray(obj.shortcuts) ? obj.shortcuts : Object.values(obj.shortcuts || {});
  const entry: ShortcutEntry = {
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
  await new Promise<void>((resolve, reject) => {
    shortcut.writeFile(file, { shortcuts: merged.list }, (err) => err ? reject(err) : resolve());
  });

  const grid = path.join(ud.configDir, "grid");
  fs.mkdirSync(grid, { recursive: true });
  const src = art || {};
  const pairs: Array<[string | undefined, string]> = [
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
