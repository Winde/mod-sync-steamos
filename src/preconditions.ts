import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as util from "./util";
import * as steam from "./steam";
import * as paths from "./paths";
import type {
  CheckResult,
  CheckStatus,
  Confirmations,
  NormalizedNote,
  Note,
  NoteTone,
  Pack,
  PreconditionConfig,
  PreconditionsResult,
  ResolvedTarget,
  SteamGame,
} from "./types";

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

const NOTE_TONES = new Set<NoteTone>(["info", "warning", "error", "success"]);

export function normalizeNotes(notes: readonly Note[] | null | undefined): NormalizedNote[] {
  if (!Array.isArray(notes)) return [];
  return notes.map((n) => {
    if (typeof n === "string") return { title: "", body: n, tone: "info" as const };
    return { title: n.title || "", body: n.body || "", tone: n.tone || "info" };
  }).filter((n) => n.body);
}

export function validatePreconditions(list: unknown): PreconditionConfig[] {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error("pack.json.preconditions: must be an array");
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("pack.json.preconditions: check must be an object");
    }
    const check = raw as Record<string, unknown>;
    if (typeof check.id !== "string" || !check.id) throw new Error("pack.json.preconditions: missing id");
    if (seen.has(check.id)) throw new Error(`pack.json.preconditions: duplicate id ${check.id}`);
    seen.add(check.id);
    if (typeof check.type !== "string" || !CHECK_TYPES.has(check.type)) {
      throw new Error(`pack.json.preconditions: ${check.id} has unknown type ${String(check.type)}`);
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
        if (typeof variant !== "string" || !(paths.VARIANTS as readonly string[]).includes(variant)) {
          throw new Error(`pack.json.preconditions: ${check.id} unknown platform ${String(variant)}`);
        }
      }
    }
    if (check.type === "path-exists" && check.scope != null && !["home", "game", "tv", "target"].includes(String(check.scope))) {
      throw new Error(`pack.json.preconditions: ${check.id} scope must be home, game, tv, or target`);
    }
    if (check.type === "game-build" && check.build != null && typeof check.build !== "string") {
      throw new Error(`pack.json.preconditions: ${check.id} build must be a string`);
    }
    if (check.type === "disk-free" && check.bytes != null && !Number.isFinite(check.bytes)) {
      throw new Error(`pack.json.preconditions: ${check.id} bytes must be a number`);
    }
    if (check.type === "disk-free" && check.scope != null && !["tv", "game", "target"].includes(String(check.scope))) {
      throw new Error(`pack.json.preconditions: ${check.id} scope must be tv, game, or target`);
    }
    if (check.type === "path-exists") {
      const candidates = check.paths || (check.path ? [check.path] : []);
      if (!Array.isArray(candidates) || !candidates.length) {
        throw new Error(`pack.json.preconditions: ${check.id} needs path or paths`);
      }
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
  return list as PreconditionConfig[];
}

export function validateNotes(notes: unknown): Note[] {
  if (notes == null) return [];
  if (!Array.isArray(notes)) throw new Error("pack.json.notes: must be an array");
  for (const raw of notes) {
    if (typeof raw === "string") continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("pack.json.notes: note must be a string or object");
    const note = raw as Record<string, unknown>;
    if (typeof note.body !== "string" || !note.body) throw new Error("pack.json.notes: note body is required");
    if (note.title != null && typeof note.title !== "string") throw new Error("pack.json.notes: note title must be a string");
    if (note.tone != null && (typeof note.tone !== "string" || !NOTE_TONES.has(note.tone as NoteTone))) {
      throw new Error(`pack.json.notes: unknown tone ${String(note.tone)}`);
    }
  }
  return notes as Note[];
}

interface CheckOutcome {
  status: CheckStatus;
  detail: string;
}

function pass(detail: string): CheckOutcome { return { status: "pass", detail }; }
function fail(detail: string): CheckOutcome { return { status: "fail", detail }; }
function unknown(detail: string): CheckOutcome { return { status: "unknown", detail }; }

function installedDepots(game: SteamGame | null | undefined): number[] | null {
  if (!game || !game.library) return null;
  return steam.readInstalledDepots(game.library, game.appId);
}

function checkDlc(
  check: PreconditionConfig,
  { pack, game }: { pack: Pack; game: SteamGame | null | undefined },
): CheckOutcome {
  const found: string[] = [];
  const tried: string[] = [];

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

interface CheckContext {
  pack: Pack;
  game: SteamGame | null | undefined;
  root: string;
  totalBytes: number;
  target: ResolvedTarget;
}

function checkOne(check: PreconditionConfig, { pack, game, root, totalBytes, target }: CheckContext): CheckOutcome {
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
      const reserve = typeof check.reserveBytes === "number" && Number.isFinite(check.reserveBytes)
        ? check.reserveBytes
        : 1024 * 1024 * 1024;
      const need = typeof check.bytes === "number" && Number.isFinite(check.bytes)
        ? check.bytes
        : (totalBytes || 0) + reserve;
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
      const candidates = check.paths || (check.path ? [check.path] : []);
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

export function evaluatePreconditions({
  pack,
  game,
  root,
  totalBytes,
  confirmed = {},
}: {
  pack: Pack;
  game: SteamGame | null | undefined;
  root: string;
  totalBytes?: number;
  confirmed?: Confirmations[string];
}): PreconditionsResult {
  const checks = Array.isArray(pack.preconditions) ? pack.preconditions : [];
  const target = paths.resolve(pack, game);
  const results: CheckResult[] = checks.map((check) => {
    let result: CheckOutcome = Array.isArray(check.platforms) && !check.platforms.includes(target.variant)
      ? pass(`Not needed for ${target.variant}.`)
      : checkOne(check, { pack, game, root, totalBytes: totalBytes || 0, target });
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

function defaultTitle(check: PreconditionConfig, pack: Pack): string {
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

export function firstBlocker(preconditions: PreconditionsResult | null | undefined): CheckResult | null {
  if (!preconditions || !preconditions.checks) return null;
  return preconditions.checks.find((c) => c.blocked) || preconditions.checks.find((c) => c.status === "fail") || null;
}

export {
  CHECK_TYPES,
  NOTE_TONES,
};
