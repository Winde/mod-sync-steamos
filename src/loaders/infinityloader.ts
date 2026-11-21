import fs from "node:fs";
import path from "node:path";
import type { GameInfo } from "../types";

/**
 * InfinityLoader/EEex layout.
 *
 * InfinityLoader is a small Windows launcher that starts the real game
 * executable, injects the EEex DLLs and applies its in-memory patches. The
 * loader is installed under the normal game executable name; the real game is
 * renamed. The names are declared in InfinityLoader.ini and differ by game
 * (Baldur.exe/BaldurReal.exe, icewind.exe/..., etc.), so nothing here assumes
 * a particular game.
 */

export const TYPE = "infinityloader";
export const TEMPLATE = "games/infinity.sh";
export const SUPPORT_DIR = "tools/infinityloader";

const SUPPORT_FILES = [
  "InfinityLoader.exe",
  "InfinityLoader.db",
  "InfinityLoader.ini",
  "InfinityLoaderCommon.dll",
  "InfinityLoaderDLL.dll",
  "InfinityLoaderUtil.dll",
  "LuaBindings.dll",
  "LuaBindingsCore.dll",
  "LuaProvider.dll",
] as const;

export interface LoaderInfo {
  type: typeof TYPE;
  exe: string;
  ini: string;
  gameExe: string;
  realExe: string;
  supportFiles: string[];
  /** The source install already launches the loader under gameExe. */
  swapped: boolean;
  /** The source ini used the game exe directly; the pack rewrites it. */
  rewritten: boolean;
}

export function supportFiles(): readonly string[] {
  return SUPPORT_FILES;
}

export function modeForTarget(rel: string): string {
  const name = path.basename(rel).toLowerCase();
  return name.endsWith(".exe") || name.endsWith(".sh") ? "755" : "644";
}

export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key.toLowerCase()] = value;
  }
  return out;
}

function splitList(value: string | undefined): string[] {
  return String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function existsIn(root: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(root, rel));
  } catch {
    return false;
  }
}

function aliasMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of splitList(value)) {
    const colon = entry.indexOf(":");
    if (colon <= 0) continue;
    const real = entry.slice(0, colon).trim();
    const game = entry.slice(colon + 1).trim();
    if (real && game) map.set(path.basename(real).toLowerCase(), path.basename(game));
  }
  return map;
}

function realNameFor(gameExe: string): string {
  const ext = path.extname(gameExe);
  const base = path.basename(gameExe, ext);
  return `${base}Real${ext}`;
}

function setIniValue(text: string, key: string, value: string): string {
  const lines = String(text).split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${key}\\s*=`, "i");
  const index = lines.findIndex((line) => pattern.test(line));
  const next = `${key}=${value}`;
  if (index >= 0) lines[index] = next;
  else lines.push(next);
  return lines.join("\n");
}

/**
 * Keep other loader settings, but make sure the ini points at the renamed
 * executable and has the alias needed for pattern selection.
 */
export function normalizeIni(text: string, gameExe: string, realExe: string): string {
  let out = setIniValue(text, "ExeNames", realExe);
  const current = parseIni(out).exeswitchalias || "";
  const alias = `${realExe}:${gameExe}`;
  const entries = splitList(current);
  const hasAlias = entries.some((entry) => {
    const colon = entry.indexOf(":");
    if (colon <= 0) return false;
    return path.basename(entry.slice(0, colon)).toLowerCase() === realExe.toLowerCase()
      && path.basename(entry.slice(colon + 1)).toLowerCase() === gameExe.toLowerCase();
  });
  if (!hasAlias) entries.push(alias);
  out = setIniValue(out, "ExeSwitchAlias", entries.join(","));
  return out.endsWith("\n") ? out : `${out}\n`;
}

/**
 * Detect InfinityLoader in a working install. Returns null when the loader is
 * not installed, or when the install is native Linux (the loader is a Windows
 * binary and cannot launch the native executable).
 */
export function detectLoader(source: string, game: GameInfo): LoaderInfo | null {
  const exe = "InfinityLoader.exe";
  const ini = "InfinityLoader.ini";
  if (!existsIn(source, exe) || !existsIn(source, ini)) return null;
  const iniText = fs.readFileSync(path.join(source, ini), "utf8");
  const values = parseIni(iniText);
  const exeNames = splitList(values.exenames).map((entry) => path.basename(entry));
  const aliases = aliasMap(values.exeswitchalias);
  let realExe = exeNames.find((entry) => existsIn(source, entry)) || exeNames[0] || "";
  if (!realExe) return null;
  const gameExe = aliases.get(realExe.toLowerCase()) || path.basename(game.exe || realExe);
  if (!gameExe) throw new Error("InfinityLoader.ini has no usable game executable name.");
  const rewritten = gameExe.toLowerCase() === realExe.toLowerCase();
  if (rewritten) realExe = realNameFor(gameExe);
  const support = SUPPORT_FILES.filter((name) => existsIn(source, name));
  const loaderPath = path.join(source, exe);
  const gamePath = path.join(source, gameExe);
  const swapped = !rewritten && fs.existsSync(gamePath)
    && fs.statSync(gamePath).size === fs.statSync(loaderPath).size;
  return {
    type: TYPE,
    exe,
    ini,
    gameExe,
    realExe,
    supportFiles: support,
    swapped,
    rewritten,
  };
}
