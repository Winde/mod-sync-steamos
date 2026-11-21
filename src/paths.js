"use strict";

/**
 * Platform-specific pack paths.
 *
 * A pack is built once and may be installed on Windows, Linux with Proton, or
 * a native Linux build. Recipes describe those layouts in `platforms`; the
 * installer resolves the profile that matches the game install at runtime.
 */

const os = require("node:os");
const path = require("node:path");

const VARIANTS = ["windows", "linux-proton", "linux-native"];

const PROFILE_KEYS = [
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

const PATH_KEYS = new Set(["dataDir", "saveDir"]);

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validatePlatforms(platforms, where = "platforms") {
  if (platforms == null) return {};
  if (!isPlainObject(platforms)) throw new Error(`${where}: must be an object`);
  for (const [variant, profile] of Object.entries(platforms)) {
    if (!VARIANTS.includes(variant)) {
      throw new Error(`${where}: unknown variant ${variant} (expected ${VARIANTS.join(", ")})`);
    }
    if (!isPlainObject(profile)) throw new Error(`${where}.${variant}: must be an object`);
    for (const [key, value] of Object.entries(profile)) {
      if (!PROFILE_KEYS.includes(key)) throw new Error(`${where}.${variant}: unknown key ${key}`);
      if (typeof value !== "string" || !value) throw new Error(`${where}.${variant}.${key}: must be a non-empty string`);
      if (key === "template" && (path.isAbsolute(value) || value.split(/[\\/]/).includes(".."))) {
        throw new Error(`${where}.${variant}.template: must stay under templates/linux`);
      }
    }
  }
  return platforms;
}

function mergePlatforms(base, override) {
  const out = {};
  for (const variant of VARIANTS) {
    const merged = { ...(base && base[variant]), ...(override && override[variant]) };
    if (Object.keys(merged).length) out[variant] = merged;
  }
  return out;
}

function variantFor(game, platform = process.platform) {
  if (platform === "win32") return "windows";
  if (game && (game.native === true || game.mode === "native")) return "linux-native";
  return "linux-proton";
}

function dataHome(platform = process.platform) {
  if (platform === "win32") {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

function contextFor(game, platform = process.platform) {
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

function tokenValue(name, ctx) {
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

function expand(spec, ctx) {
  if (typeof spec !== "string" || !spec) return "";
  let out = spec.replace(/%([A-Z_]+)%/g, (match, name) => {
    const value = tokenValue(name, ctx);
    if (value == null) throw new Error(`unknown path token ${match} in ${spec}`);
    if (!value) throw new Error(`path token ${match} is not available for ${ctx.variant}`);
    return value;
  });
  if (out === "~") out = ctx.home;
  else if (out.startsWith("~/") || out.startsWith("~\\")) out = path.join(ctx.home, out.slice(2));
  return path.normalize(out);
}

function supports(pack, variant) {
  if (pack && pack.platforms && Object.keys(pack.platforms).length) {
    return !!pack.platforms[variant];
  }
  return variant !== "linux-native";
}

function legacyDataDir(pack, ctx) {
  const raw = (pack && pack.install && pack.install.dataDir)
    || (pack && pack.launch && pack.launch.dataDir)
    || "";
  if (!raw) return "";
  if (path.isAbsolute(raw) || raw.startsWith("~") || raw.includes("%")) return raw;
  if (ctx.prefix) return path.join(ctx.prefix, raw);
  return "";
}

/**
 * Resolve everything the installer needs for the current machine.
 * Missing tokens are reported on `error` instead of throwing, so the
 * dashboard can still render a useful precondition check.
 */
function resolve(pack, game, platform = process.platform) {
  const ctx = contextFor(game, platform);
  const variant = ctx.variant;
  const profile = (pack && pack.platforms && pack.platforms[variant]) || {};
  const launch = (pack && pack.launch) || {};
  const result = {
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
  };
  result.processes = [result.gameProcess, result.gameProcessAlt].filter(Boolean);

  const dataDirSpec = profile.dataDir || legacyDataDir(pack, ctx);
  for (const key of PATH_KEYS) {
    const spec = key === "dataDir" ? dataDirSpec : profile[key];
    if (!spec) continue;
    try {
      result[key] = expand(spec, ctx);
    } catch (err) {
      result.error = err.message;
    }
  }
  return result;
}

function filesFor(files, variant) {
  const all = Array.isArray(files) ? files : [];
  return all.filter((file) => !Array.isArray(file.platforms) || file.platforms.includes(variant));
}

function platformStats(files) {
  const out = {};
  for (const variant of VARIANTS) {
    const selected = filesFor(files, variant);
    out[variant] = {
      files: selected.length,
      totalBytes: selected.reduce((n, file) => n + (file.size || 0), 0),
    };
  }
  return out;
}

module.exports = {
  VARIANTS,
  PROFILE_KEYS,
  contextFor,
  expand,
  filesFor,
  mergePlatforms,
  platformStats,
  resolve,
  supports,
  validatePlatforms,
  variantFor,
};
