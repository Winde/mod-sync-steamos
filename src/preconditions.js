const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("./util");
const steam = require("./steam");
const paths = require("./paths");

const CHECK_TYPES = new Set([
  "game-installed",
  "game-build",
  "game-not-running",
  "proton-prefix",
  "disk-free",
  "path-exists",
  "dlc-installed",
  "manual",
]);

const NOTE_TONES = new Set(["info", "warning", "error", "success"]);

function normalizeNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes.map((n) => {
    if (typeof n === "string") return { title: "", body: n, tone: "info" };
    return { title: n.title || "", body: n.body || "", tone: n.tone || "info" };
  }).filter((n) => n.body);
}

function validatePreconditions(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error("pack.json.preconditions: must be an array");
  const seen = new Set();
  for (const check of list) {
    if (!check || typeof check !== "object") throw new Error("pack.json.preconditions: check must be an object");
    if (typeof check.id !== "string" || !check.id) throw new Error("pack.json.preconditions: missing id");
    if (seen.has(check.id)) throw new Error(`pack.json.preconditions: duplicate id ${check.id}`);
    seen.add(check.id);
    if (typeof check.type !== "string" || !CHECK_TYPES.has(check.type)) {
      throw new Error(`pack.json.preconditions: ${check.id} has unknown type ${check.type}`);
    }
    if (check.required != null && typeof check.required !== "boolean") {
      throw new Error(`pack.json.preconditions: ${check.id} required must be a boolean`);
    }
    if (check.title != null && typeof check.title !== "string") {
      throw new Error(`pack.json.preconditions: ${check.id} title must be a string`);
    }
    if (check.hint != null && typeof check.hint !== "string") {
      throw new Error(`pack.json.preconditions: ${check.id} hint must be a string`);
    }
    if (check.platforms != null) {
      if (!Array.isArray(check.platforms) || !check.platforms.length) {
        throw new Error(`pack.json.preconditions: ${check.id} platforms must be a non-empty array`);
      }
      for (const variant of check.platforms) {
        if (!paths.VARIANTS.includes(variant)) {
          throw new Error(`pack.json.preconditions: ${check.id} unknown platform ${variant}`);
        }
      }
    }
    if (check.type === "path-exists" && check.scope != null && !["home", "game", "tv", "target"].includes(check.scope)) {
      throw new Error(`pack.json.preconditions: ${check.id} scope must be home, game, tv, or target`);
    }
    if (check.type === "game-build" && check.build != null && typeof check.build !== "string") {
      throw new Error(`pack.json.preconditions: ${check.id} build must be a string`);
    }
    if (check.type === "disk-free" && check.bytes != null && !Number.isFinite(check.bytes)) {
      throw new Error(`pack.json.preconditions: ${check.id} bytes must be a number`);
    }
    if (check.type === "disk-free" && check.scope != null && !["tv", "game", "target"].includes(check.scope)) {
      throw new Error(`pack.json.preconditions: ${check.id} scope must be tv, game, or target`);
    }
    if (check.type === "path-exists") {
      const paths = check.paths || (check.path ? [check.path] : []);
      if (!Array.isArray(paths) || !paths.length) throw new Error(`pack.json.preconditions: ${check.id} needs path or paths`);
    }
    if (check.type === "dlc-installed") {
      if (check.depotIds != null && (!Array.isArray(check.depotIds) || check.depotIds.some((n) => !Number.isInteger(n)))) {
        throw new Error(`pack.json.preconditions: ${check.id} depotIds must be integers`);
      }
      if (check.paths != null && (!Array.isArray(check.paths) || check.paths.some((p) => typeof p !== "string"))) {
        throw new Error(`pack.json.preconditions: ${check.id} paths must be strings`);
      }
    }
  }
  return list;
}

function validateNotes(notes) {
  if (notes == null) return [];
  if (!Array.isArray(notes)) throw new Error("pack.json.notes: must be an array");
  for (const note of notes) {
    if (typeof note === "string") continue;
    if (!note || typeof note !== "object") throw new Error("pack.json.notes: note must be a string or object");
    if (typeof note.body !== "string" || !note.body) throw new Error("pack.json.notes: note body is required");
    if (note.title != null && typeof note.title !== "string") throw new Error("pack.json.notes: note title must be a string");
    if (note.tone != null && !NOTE_TONES.has(note.tone)) throw new Error(`pack.json.notes: unknown tone ${note.tone}`);
  }
  return notes;
}

function pass(detail) { return { status: "pass", detail }; }
function fail(detail) { return { status: "fail", detail }; }
function unknown(detail) { return { status: "unknown", detail }; }

function installedDepots(game) {
  if (!game || !game.library) return null;
  return steam.readInstalledDepots(game.library, game.appId);
}

function checkDlc(check, { pack, game }) {
  const found = [];
  const tried = [];

  if (check.dlcAppId) {
    tried.push(`app ${check.dlcAppId}`);
    if (steam.findAppManifest(check.dlcAppId)) found.push("Steam manifest");
  }
  if (Array.isArray(check.depotIds) && check.depotIds.length) {
    tried.push(`depots ${check.depotIds.join(", ")}`);
    const depots = installedDepots(game);
    if (depots) {
      const hit = check.depotIds.filter((id) => depots.includes(id));
      if (hit.length) found.push(`depot ${hit[0]}`);
    }
  }
  if (Array.isArray(check.paths) && check.paths.length) {
    tried.push(check.paths.join(" or "));
    if (game) {
      const hit = check.paths.find((p) => {
        try { return fs.existsSync(util.safeJoin(game.root, p)); } catch { return false; }
      });
      if (hit) found.push(hit);
    }
  }

  if (!tried.length) return unknown("No dlcAppId, depotIds, or paths configured.");
  if (found.length) return pass(`Detected: ${found[0]}`);
  return fail(`Not detected (${tried.join("; ")}).`);
}

function checkOne(check, { pack, game, root, totalBytes, target }) {
  switch (check.type) {
    case "game-installed":
      return game
        ? pass(`${pack.game.title} at ${game.root} (${game.mode || "unknown"}).`)
        : fail(`${pack.game.title} was not found in Steam libraries (${steam.libraries().join(", ") || "none"}).`);
    case "game-build": {
      const expected = String(check.build || pack.game.build || "");
      if (!game) return unknown("Game not found.");
      if (!game.build) return unknown("Steam build id is missing.");
      return String(game.build) === expected
        ? pass(`Build ${game.build}`)
        : fail(`Build ${game.build}; this pack needs ${expected}.`);
    }
    case "game-not-running":
      return util.isGameRunning(target.processes)
        ? fail(`${pack.game.title} is running.`)
        : pass(`${pack.game.title} is closed.`);
    case "proton-prefix":
      if (process.platform === "win32") return pass("Not needed on Windows.");
      if (!game) return unknown("Game not found.");
      if (game.native) {
        return target.supported
          ? pass("Native Linux build; no Proton prefix needed.")
          : fail(`${pack.game.title} is the native Linux build, but this pack needs Proton. In Steam, open Properties, Compatibility, and force a Proton version.`);
      }
      if (game.prefixReady) return pass("Proton prefix exists.");
      {
        const checked = steam.libraries().map((lib) => path.join(lib, "steamapps", "compatdata", String(pack.game.appId), "pfx"));
        return fail(`Proton prefix is missing${checked.length ? ` (checked ${checked.join(", ")})` : ""}.`);
      }
    case "disk-free": {
      const reserve = Number.isFinite(check.reserveBytes) ? check.reserveBytes : 1024 * 1024 * 1024;
      const need = Number.isFinite(check.bytes) ? check.bytes : (totalBytes || 0) + reserve;
      const base = check.scope === "game"
        ? (game && game.root)
        : check.scope === "target" ? target.dataDir : root;
      if (!base) return unknown("Install target not found.");
      const free = util.freeBytes(base);
      if (free == null) return unknown("Free space could not be read.");
      return free >= need
        ? pass(`${util.formatBytes(free)} free at ${base}.`)
        : fail(`${util.formatBytes(free)} free at ${base}; need ${util.formatBytes(need)}.`);
    }
    case "path-exists": {
      const candidates = check.paths || [check.path];
      const base = check.scope === "tv"
        ? root
        : check.scope === "home" ? os.homedir()
        : check.scope === "target" ? target.dataDir
        : (game && game.root);
      if (!base) return unknown("Install target not found.");
      for (const rel of candidates) {
        try {
          if (fs.existsSync(util.safeJoin(base, rel))) return pass(`Found ${rel}.`);
        } catch { /* invalid path counts as missing */ }
      }
      return fail(`Missing ${candidates.join(" or ")}.`);
    }
    case "dlc-installed":
      return checkDlc(check, { pack, game });
    case "manual":
      return unknown("Needs confirmation.");
    default:
      return unknown(`Unknown check type ${check.type}.`);
  }
}

function evaluatePreconditions({ pack, game, root, totalBytes, confirmed = {} }) {
  const checks = Array.isArray(pack.preconditions) ? pack.preconditions : [];
  const target = paths.resolve(pack, game);
  const results = checks.map((check) => {
    let result = Array.isArray(check.platforms) && !check.platforms.includes(target.variant)
      ? pass(`Not needed for ${target.variant}.`)
      : checkOne(check, { pack, game, root, totalBytes, target });
    const confirmable = check.type === "manual" || check.confirmable === true;
    if (result.status !== "pass" && confirmable && confirmed[check.id]) {
      result = pass("Confirmed on this TV.");
    }
    const required = check.required === true;
    const blocked = required && (result.status === "fail"
      || (result.status === "unknown" && check.allowUnknown !== true));
    return {
      id: check.id,
      type: check.type,
      title: check.title || defaultTitle(check, pack),
      hint: check.hint || "",
      required,
      confirmable,
      status: result.status,
      detail: result.detail,
      blocked,
    };
  });
  return {
    checks: results,
    blocked: results.some((c) => c.blocked),
    failedRequired: results.filter((c) => c.blocked),
  };
}

function defaultTitle(check, pack) {
  switch (check.type) {
    case "game-installed": return `${pack.game.title} is installed`;
    case "game-build": return `${pack.game.title} build ${check.build || pack.game.build}`;
    case "game-not-running": return "Game is closed";
    case "proton-prefix": return "Game data location is ready";
    case "disk-free":
      if (check.scope === "game") return "Enough space in the game library";
      if (check.scope === "target") return "Enough space in the game data folder";
      return "Enough free space";
    case "path-exists": return "Required files exist";
    case "dlc-installed": return "DLC is installed";
    case "manual": return "Manual check";
    default: return check.id;
  }
}

function firstBlocker(preconditions) {
  if (!preconditions || !preconditions.checks) return null;
  return preconditions.checks.find((c) => c.blocked) || preconditions.checks.find((c) => c.status === "fail") || null;
}

module.exports = {
  CHECK_TYPES,
  NOTE_TONES,
  normalizeNotes,
  validateNotes,
  validatePreconditions,
  evaluatePreconditions,
  firstBlocker,
};
