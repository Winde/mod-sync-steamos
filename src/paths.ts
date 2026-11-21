"use strict";

/**
 * Platform-specific pack paths.
 *
 * A pack is built once and may be installed on Windows, Linux with Proton, or
 * a native Linux build. Recipes describe those layouts in `platforms`; the
 * installer resolves the profile that matches the game install at runtime.
 */

import os from "node:os";
import path from "node:path";
import { errorMessage } from "./util";
import type {
  LaunchInfo,
  PackFile,
  PlatformProfile,
  Platforms,
  ResolvedTarget,
  SteamGame,
  Variant,
} from "./types";

const VARIANTS: readonly Variant[] = ["windows", "linux-proton", "linux-native"];

const PROFILE_KEYS: readonly (keyof PlatformProfile)[] = [
  "dataDir",
  "saveDir",
  "exe",
  "gameProcess",
  "gameProcessAlt",
  "loader",
  "loaderSupport",
  "shortcut",
  "template",
];

const PATH_KEYS: ReadonlySet<"dataDir" | "saveDir"> = new Set(["dataDir", "saveDir"]);

interface PackPaths {
  platforms?: Platforms;
  launch?: Partial<LaunchInfo>;
}

export interface PathContext {
  platform: NodeJS.Platform;
  variant: Variant;
  home: string;
  dataHome: string;
  localAppData: string;
  appData: string;
  gameRoot: string;
  prefix: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validatePlatforms(platforms: unknown, where = "platforms"): Platforms {
  if (platforms == null) return {};
  if (!isPlainObject(platforms)) throw new Error(`${where}: must be an object`);
  for (const [variant, profile] of Object.entries(platforms)) {
    if (!VARIANTS.includes(variant as Variant)) {
      throw new Error(`${where}: unknown variant ${variant} (expected ${VARIANTS.join(", ")})`);
    }
    if (!isPlainObject(profile)) throw new Error(`${where}.${variant}: must be an object`);
    for (const [key, value] of Object.entries(profile)) {
      if (!(PROFILE_KEYS as readonly string[]).includes(key)) throw new Error(`${where}.${variant}: unknown key ${key}`);
      if (typeof value !== "string" || !value) throw new Error(`${where}.${variant}.${key}: must be a non-empty string`);
      if (key === "template" && (path.isAbsolute(value) || value.split(/[\\/]/).includes(".."))) {
        throw new Error(`${where}.${variant}.template: must stay under templates/linux`);
      }
    }
  }
  return platforms as Platforms;
}

export function mergePlatforms(base?: Platforms | null, override?: Platforms | null): Platforms {
  const out: Platforms = {};
  for (const variant of VARIANTS) {
    const merged = { ...(base && base[variant]), ...(override && override[variant]) };
    if (Object.keys(merged).length) out[variant] = merged;
  }
  return out;
}

export function variantFor(
  game?: { native?: boolean; mode?: string } | null,
  platform: NodeJS.Platform = process.platform,
): Variant {
  if (platform === "win32") return "windows";
  if (game && (game.native === true || game.mode === "native")) return "linux-native";
  return "linux-proton";
}

function dataHome(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

export function contextFor(game: SteamGame | null | undefined, platform: NodeJS.Platform = process.platform): PathContext {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  return {
    platform,
    variant: variantFor(game, platform),
    home,
    dataHome: dataHome(platform),
    localAppData,
    appData: process.env.APPDATA || path.join(home, "AppData", "Roaming"),
    gameRoot: game && game.root ? game.root : "",
    prefix: game && game.prefix ? game.prefix : "",
  };
}

function tokenValue(name: string, ctx: PathContext): string | null {
  switch (name) {
    case "HOME": return ctx.home;
    case "DATA_HOME": return ctx.dataHome;
    case "LOCALAPPDATA": return ctx.localAppData;
    case "APPDATA": return ctx.appData;
    case "PREFIX": return ctx.prefix;
    case "GAME": return ctx.gameRoot;
    default: return null;
  }
}

export function expand(spec: string, ctx: PathContext): string {
  if (!spec) return "";
  let out = spec.replace(/%([A-Z_]+)%/g, (match, name: string) => {
    const value = tokenValue(name, ctx);
    if (value == null) throw new Error(`unknown path token ${match} in ${spec}`);
    if (!value) throw new Error(`path token ${match} is not available for ${ctx.variant}`);
    return value;
  });
  if (out === "~") out = ctx.home;
  else if (out.startsWith("~/") || out.startsWith("~\\")) out = path.join(ctx.home, out.slice(2));
  return path.normalize(out);
}

export function supports(pack: PackPaths | null | undefined, variant: Variant): boolean {
  if (pack && pack.platforms && Object.keys(pack.platforms).length) {
    return !!pack.platforms[variant];
  }
  return variant !== "linux-native";
}

/**
 * Resolve everything the installer needs for the current machine.
 * Missing tokens are reported on `error` instead of throwing, so the
 * dashboard can still render a useful precondition check.
 */
export function resolve(
  pack: PackPaths,
  game: SteamGame | null | undefined,
  platform: NodeJS.Platform = process.platform,
): ResolvedTarget {
  const ctx = contextFor(game, platform);
  const variant = ctx.variant;
  const profile = (pack && pack.platforms && pack.platforms[variant]) || {};
  const launch = (pack && pack.launch) || {};
  const result: ResolvedTarget = {
    variant,
    supported: supports(pack, variant),
    profile,
    dataDir: null,
    saveDir: null,
    exe: profile.exe || launch.exe || "",
    gameProcess: profile.gameProcess || launch.gameProcess || "",
    gameProcessAlt: profile.gameProcessAlt || "",
    loader: profile.loader || "",
    loaderSupport: profile.loaderSupport || "",
    shortcut: profile.shortcut || "",
    template: profile.template || "",
    error: null,
    processes: [],
  };
  result.processes = [result.gameProcess, result.gameProcessAlt].filter(Boolean) as string[];

  for (const key of PATH_KEYS) {
    const spec = profile[key];
    if (!spec) continue;
    try {
      result[key] = expand(spec, ctx);
    } catch (err) {
      result.error = errorMessage(err);
    }
  }
  return result;
}

export function filesFor(files: readonly PackFile[] | null | undefined, variant: Variant): PackFile[] {
  const all = Array.isArray(files) ? files : [];
  return all.filter((file) => !Array.isArray(file.platforms) || file.platforms.includes(variant));
}

export function platformStats(files: readonly PackFile[]): Record<Variant, { files: number; totalBytes: number }> {
  const out = {} as Record<Variant, { files: number; totalBytes: number }>;
  for (const variant of VARIANTS) {
    const selected = filesFor(files, variant);
    out[variant] = {
      files: selected.length,
      totalBytes: selected.reduce((n, file) => n + (file.size || 0), 0),
    };
  }
  return out;
}

export {
  VARIANTS,
  PROFILE_KEYS,
};
