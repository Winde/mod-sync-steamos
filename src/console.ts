import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import * as drivers from "./drivers";
import { contentType, readJsonBody } from "./http";
import labels from "./labels";
import { loadPack, packSummary } from "./manifest";
import * as packImage from "./pack-image";
import { libraryFile, normalizePackLibraryName, readPackLibrary, savePackLibrary } from "./pack-library";
import * as recipes from "./recipes";
import { createReviewStore } from "./reviews";
import { projectRoot } from "./root";
import { createDeviceStore } from "./devices";
import { createPairingStore } from "./pairing";
import { createServer } from "./server";
import * as util from "./util";
import type { DeviceView } from "./devices";
import type { Driver } from "./drivers";
import type { PairingStore, PairRequestView } from "./pairing";
import type { ModReview, ReviewInput } from "./reviews";
import type { BuildOption, BuildProgress, ContentsSummary, PackSummary, Recipe, Variant } from "./types";

/**
 * PC-side pack console.
 *
 * The console is the local control surface for the machine that owns the
 * packs. It serves a small UI on 127.0.0.1 only, owns the LAN pack server, and
 * turns pack management into explicit actions: rebuild from a recipe, remove,
 * reveal, and change the token/bind.
 */

export type BindMode = "lan" | "loopback" | "host";

export interface ConsoleWorking {
  source: string;
}

export interface ConsoleConfig {
  version: 1;
  packsDir: string;
  bind: BindMode;
  host: string;
  port: number;
  token: string;
  autoStart: boolean;
  launchAtLogin: boolean;
  minimizeToTray: boolean;
  working: Record<string, ConsoleWorking>;
}

export interface ConsolePack {
  valid: boolean;
  id: string;
  name: string;
  /** The name written by the pack builder; `name` may be a library rename. */
  baseName: string;
  description: string;
  game: { id: string; title: string; appId: number | null; build: string; version: string };
  mod: { id: string; version: string };
  files: number;
  totalBytes: number;
  contents: ContentsSummary | null;
  platforms: Variant[];
  root: string;
  modifiedAt: string;
  recipeId: string | null;
  artUrl: string;
  /** True when the cover was chosen in the console rather than built by the driver. */
  artCustom: boolean;
  /** Console notes kept in the pack's own `library.json`. */
  notes: string;
  /** Review for this game + mod pair, shared by every pack of the mod. */
  review: ModReview | null;
  error: string | null;
}

export interface ConsoleRecipe {
  id: string;
  name: string;
  game: string;
  gameTitle: string;
  modId: string;
  description: string;
  version: string;
  source: string;
  out: string;
  packExists: boolean;
  buildOptions: BuildOption[];
}

export interface ServerStatus {
  running: boolean;
  host: string;
  port: number;
  url: string;
  startedAt: string | null;
  error: string | null;
}

export interface BuildJob {
  id: string;
  recipeId: string;
  packId: string;
  status: "running" | "done" | "error";
  phase: string;
  percent: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  log: string[];
  result: { version: string; files: number; totalBytes: number } | null;
}

export type BuildJobSummary = Omit<BuildJob, "log"> & { log: string[] };

export interface BuildRequest {
  recipeId: string;
  source?: string;
  version?: string;
  copy?: boolean;
  driverOptions?: Record<string, unknown>;
  /** Target pack id; defaults to the recipe id. */
  packId?: string;
  /** Create a new pack instead of replacing an existing one. */
  createNew?: boolean;
  /** Display name applied to a newly created pack. */
  packName?: string;
}

export interface ConsoleState {
  app: {
    version: string;
    packsDir: string;
    recipesDir: string;
    configFile: string;
    platform: NodeJS.Platform;
    tokenStorage: "protected" | "config";
    loginItem: { supported: boolean; error: string | null };
  };
  server: ServerStatus;
  settings: ConsoleConfig;
  packs: ConsolePack[];
  recipes: ConsoleRecipe[];
  lan: { detected: string; addresses: util.LanAddress[] };
  build: BuildJobSummary | null;
  pairRequests: PairRequestView[];
  devices: DeviceView[];
  guide: {
    installCommand: string;
    manualInstallCommand: string;
    firewallCommand: string;
    installUrl: string;
  };
}

export interface LoginItemResult {
  ok: boolean;
  error?: string;
}

export interface ConsoleTokenStore {
  read: () => string | null;
  write: (token: string) => void;
}

export interface ConsoleOptions {
  configFile: string;
  defaultPacksDir?: string;
  version?: string;
  reveal?: (target: string) => void;
  setLaunchAtLogin?: (enabled: boolean) => LoginItemResult;
  onServerChange?: (status: ServerStatus) => void;
  tokenStore?: ConsoleTokenStore;
  /** Paired-device credential store; defaults beside the console config. */
  devicesFile?: string;
  /** Mod review database; defaults beside the console config. */
  reviewsFile?: string;
}

export interface Console {
  listen: () => Promise<string>;
  close: () => Promise<void>;
  config: () => ConsoleConfig;
  state: () => Promise<ConsoleState>;
  serverStatus: () => ServerStatus;
  startServer: () => Promise<ServerStatus>;
  stopServer: () => Promise<ServerStatus>;
  updateSettings: (input: Partial<ConsoleConfig> & { workingSource?: { recipeId: string; source: string } }) => Promise<ConsoleState>;
  listPacks: () => ConsolePack[];
  listRecipes: () => ConsoleRecipe[];
  startBuild: (input: BuildRequest) => BuildJobSummary;
  updatePackLibrary: (id: string, input: { name?: unknown; notes?: unknown }) => ConsolePack[];
  updatePackImage: (id: string, input: { path?: unknown; data?: unknown }) => ConsolePack[];
  clearPackImage: (id: string) => ConsolePack[];
  saveReview: (input: ReviewInput) => ModReview | null;
  removePack: (id: string) => Promise<void>;
  revealPack: (id: string) => void;
  revealPacksDir: () => void;
  revokeDevice: (id: string) => DeviceView[];
  revokeAllDevices: () => DeviceView[];
  isRunning: () => boolean;
}

interface ServerRuntime {
  server: http.Server;
  pairing: PairingStore;
  host: string;
  port: number;
  url: string;
  startedAt: string;
}

const DEFAULT_PORT = 8787;
const TOKEN_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PACK_ID = /^[a-zA-Z0-9._-]+$/;

// Each phase owns a slice of the bar so switching from one driver phase to the
// next never moves progress backwards.
const PHASE_PERCENT: Record<string, readonly [number, number]> = {
  preparing: [0, 1],
  copying: [1, 35],
  hashing: [35, 95],
  swapping: [95, 99],
};

function normalizeDriverOptions(driver: Driver, input: unknown): Record<string, unknown> {
  const values = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const out: Record<string, unknown> = {};
  for (const option of driver.buildOptions()) {
    const raw = values[option.key];
    if (raw != null && typeof raw !== "string") {
      throw new Error(`${option.label} must be text.`);
    }
    const value = String(raw ?? "").trim();
    if (!value) {
      if (!option.optional) throw new Error(`${option.label} is required.`);
      continue;
    }
    if (option.type === "directory") {
      const resolved = path.resolve(value);
      let isDirectory = false;
      try {
        isDirectory = fs.statSync(resolved).isDirectory();
      } catch {
        isDirectory = false;
      }
      if (!isDirectory) throw new Error(`${option.label} not found: ${resolved}`);
      out[option.key] = resolved;
      continue;
    }
    out[option.key] = value;
  }
  return out;
}

function percentForProgress(update: BuildProgress): number | null {
  const range = PHASE_PERCENT[update.phase];
  if (!range) return null;
  let ratio: number | null = null;
  if (update.bytesDone != null && update.bytesTotal) {
    ratio = update.bytesDone / update.bytesTotal;
  } else if (update.done != null && update.total) {
    ratio = update.done / update.total;
  }
  if (ratio == null) return null;
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.round(range[0] + (range[1] - range[0]) * clamped);
}

function randomToken(): string {
  let out = "";
  const bytes = crypto.randomBytes(20);
  for (const byte of bytes) out += TOKEN_CHARS[byte % TOKEN_CHARS.length];
  return out;
}

function normalizeToken(value: unknown): string {
  const token = String(value == null ? "" : value).trim();
  if (token.length < 4) throw new Error("Token must be at least 4 characters.");
  if (token.length > 200) throw new Error("Token must be at most 200 characters.");
  if (/[\s,']/.test(token)) throw new Error("Token cannot contain spaces, commas, or single quotes.");
  return token;
}

function portValue(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error("Port must be a number from 0 to 65535.");
  return n;
}

function modeValue(value: unknown): BindMode {
  return value === "loopback" || value === "host" ? value : "lan";
}

function sendJson(res: http.ServerResponse, code: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, err: unknown, code = 500): void {
  sendJson(res, code, { error: util.errorMessage(err) });
}

function isInside(root: string, target: string): boolean {
  const base = path.resolve(root);
  const abs = path.resolve(target);
  return abs === base || abs.startsWith(base + path.sep);
}

function sameToken(a: string, b: string): boolean {
  return a === b;
}

function defaultConfig(packsDir: string): ConsoleConfig {
  return {
    version: 1,
    packsDir,
    bind: "lan",
    host: "",
    port: DEFAULT_PORT,
    token: randomToken(),
    autoStart: true,
    launchAtLogin: false,
    minimizeToTray: true,
    working: {},
  };
}

function normalizeConfig(raw: unknown, fallback: ConsoleConfig): ConsoleConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const working: Record<string, ConsoleWorking> = {};
  if (source.working && typeof source.working === "object" && !Array.isArray(source.working)) {
    for (const [id, entry] of Object.entries(source.working as Record<string, unknown>)) {
      if (!PACK_ID.test(id)) continue;
      const value = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
      if (typeof value.source === "string" && value.source.trim()) working[id] = { source: value.source.trim() };
    }
  }
  let token = fallback.token;
  try { token = normalizeToken(source.token); } catch { /* keep the generated token */ }
  return {
    version: 1,
    packsDir: typeof source.packsDir === "string" && source.packsDir.trim()
      ? path.resolve(source.packsDir.trim())
      : fallback.packsDir,
    bind: modeValue(source.bind),
    host: typeof source.host === "string" ? source.host.trim() : fallback.host,
    port: (() => { try { return portValue(source.port); } catch { return fallback.port; } })(),
    token,
    autoStart: typeof source.autoStart === "boolean" ? source.autoStart : fallback.autoStart,
    launchAtLogin: typeof source.launchAtLogin === "boolean" ? source.launchAtLogin : fallback.launchAtLogin,
    minimizeToTray: typeof source.minimizeToTray === "boolean" ? source.minimizeToTray : fallback.minimizeToTray,
    working,
  };
}

export function createConsole(options: ConsoleOptions): Console {
  const configFile = path.resolve(options.configFile);
  const defaultPacksDir = path.resolve(options.defaultPacksDir || path.join(projectRoot, "packs"));
  const webDir = path.join(projectRoot, "web");
  let tokenStorage = options.tokenStore || null;
  let config = loadConfig();
  const devicesFile = path.resolve(options.devicesFile || path.join(path.dirname(configFile), "devices.json"));
  const devices = createDeviceStore({ file: devicesFile, legacyToken: config.token });
  const reviewsFile = path.resolve(options.reviewsFile || path.join(path.dirname(configFile), "reviews.json"));
  const reviews = createReviewStore(reviewsFile);
  let runtime: ServerRuntime | null = null;
  let serverError: string | null = null;
  let loginError: string | null = null;
  let activeJob: BuildJob | null = null;
  let lastJob: BuildJob | null = null;
  let controlServer: http.Server | null = null;
  let recipeCache: { at: number; value: ConsoleRecipe[] } | null = null;

  function loadConfig(): ConsoleConfig {
    const fallback = defaultConfig(defaultPacksDir);
    let cfg: ConsoleConfig;
    if (!fs.existsSync(configFile)) {
      seedFromCli(fallback);
      cfg = fallback;
    } else {
      try {
        cfg = normalizeConfig(util.readJson<unknown>(configFile), fallback);
      } catch {
        cfg = fallback;
      }
    }
    if (!cfg.token) cfg.token = randomToken();
    if (tokenStorage) {
      let stored: string | null = null;
      try {
        stored = tokenStorage.read();
      } catch {
        stored = null;
      }
      if (stored) {
        try {
          cfg.token = normalizeToken(stored);
        } catch { /* keep the config token */ }
      } else {
        try {
          tokenStorage.write(cfg.token);
        } catch {
          // Fall back to the config file rather than losing the only copy.
          tokenStorage = null;
        }
      }
    }
    saveConfig(cfg);
    return cfg;
  }

  function seedFromCli(cfg: ConsoleConfig): void {
    const cliFile = path.join(path.dirname(configFile), "config.json");
    if (!fs.existsSync(cliFile)) return;
    try {
      const cli = util.readJson<Record<string, unknown>>(cliFile);
      if (typeof cli.recipe === "string" && PACK_ID.test(cli.recipe) && typeof cli.source === "string" && cli.source.trim()) {
        cfg.working[cli.recipe] = { source: path.resolve(cli.source.trim()) };
      }
      if (typeof cli.out === "string" && cli.out.trim()) {
        // A remembered CLI output is a pack directory, while the console owns
        // the packs directory. Keep the parent only when it is unambiguous.
        const out = path.resolve(cli.out.trim());
        if (path.basename(out) === cli.recipe) cfg.packsDir = path.dirname(out);
      }
    } catch { /* a broken CLI config must not block the console */ }
  }

  function saveConfig(next: ConsoleConfig = config): void {
    util.ensureDir(path.dirname(configFile));
    // When protected storage is active the config file never sees the token.
    util.writeJson(configFile, { ...next, token: tokenStorage ? "" : next.token });
  }

  function serverStatus(): ServerStatus {
    return {
      running: !!runtime,
      host: runtime ? runtime.host : plannedHost(),
      port: runtime ? runtime.port : config.port,
      url: runtime ? runtime.url : plannedUrl(),
      startedAt: runtime ? runtime.startedAt : null,
      error: serverError,
    };
  }

  function plannedHost(): string {
    try {
      return resolveHost();
    } catch {
      return config.bind === "loopback" ? "127.0.0.1" : config.host || "";
    }
  }

  function plannedUrl(): string {
    const host = plannedHost();
    return host ? `http://${host}:${config.port}` : "";
  }

  function resolveHost(): string {
    if (config.bind === "loopback") return "127.0.0.1";
    if (config.bind === "host") {
      const host = config.host.trim();
      if (!host) throw new Error("Choose a bind address or use the LAN option.");
      return host;
    }
    const detected = util.detectLanIp();
    if (detected === "127.0.0.1") {
      throw new Error("No private LAN IPv4 found. Connect to the LAN or choose loopback.");
    }
    return detected;
  }

  function emit(): void {
    try { options.onServerChange?.(serverStatus()); } catch { /* tray updates must not break the server */ }
  }

  function buildRoot(): string {
    return path.join(config.packsDir, ".modsync-build");
  }

  function cleanBuildRoot(): void {
    try { fs.rmSync(buildRoot(), { recursive: true, force: true }); } catch { /* a running app may hold the folder */ }
  }

  function packRoot(id: string): string {
    if (!PACK_ID.test(id) || id === "." || id === ".." || path.basename(id) !== id) throw new Error("Invalid pack id.");
    return path.join(config.packsDir, id);
  }

  function listRecipes(): ConsoleRecipe[] {
    if (recipeCache && Date.now() - recipeCache.at < 5000) return recipeCache.value;
    let all: Recipe[];
    try { all = recipes.listRecipes(); } catch { return []; }
    const out: ConsoleRecipe[] = [];
    for (const recipe of all) {
      let gameTitle = recipe.game;
      let source = "";
      let buildOptions: BuildOption[] = [];
      try {
        const driver = drivers.driverFor(recipe.game);
        gameTitle = driver.GAME.title || recipe.game;
        source = config.working[recipe.id]?.source || driver.defaultSource();
        buildOptions = driver.buildOptions();
      } catch { /* an unknown driver is still useful to see */ }
      out.push({
        id: recipe.id,
        name: recipe.name,
        game: recipe.game,
        gameTitle,
        modId: recipe.modId,
        description: recipe.description || "",
        version: recipe.version || "",
        source,
        out: path.join(config.packsDir, recipe.id),
        packExists: fs.existsSync(path.join(config.packsDir, recipe.id, "pack.json")),
        buildOptions,
      });
    }
    recipeCache = { at: Date.now(), value: out };
    return out;
  }

  function listPacks(): ConsolePack[] {
    if (!fs.existsSync(config.packsDir)) return [];
    const recipeIds = new Set(listRecipes().map((recipe) => recipe.id));
    const out: ConsolePack[] = [];
    for (const entry of fs.readdirSync(config.packsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const root = path.join(config.packsDir, entry.name);
      const manifest = path.join(root, "pack.json");
      if (!fs.existsSync(manifest)) continue;
      let modifiedAt = "";
      try { modifiedAt = fs.statSync(manifest).mtime.toISOString(); } catch { /* keep empty */ }
      try {
        const summary: PackSummary = packSummary(root);
        const library = readPackLibrary(root);
        out.push({
          valid: true,
          id: summary.id,
          name: summary.name,
          baseName: summary.baseName,
          notes: library?.notes || "",
          review: reviews.get(summary.game.id, summary.mod.id),
          description: summary.description || "",
          game: {
            id: summary.game.id,
            title: summary.game.title || summary.game.id,
            appId: typeof summary.game.appId === "number" ? summary.game.appId : null,
            build: summary.game.build || "",
            version: summary.game.version || "",
          },
          mod: { id: summary.mod.id, version: summary.mod.version },
          files: summary.files,
          totalBytes: summary.totalBytes,
          contents: summary.contents,
          platforms: summary.platforms ? Object.keys(summary.platforms) as Variant[] : ["windows", "linux-proton"],
          root,
          modifiedAt,
          recipeId: summary.recipe && recipeIds.has(summary.recipe)
            ? summary.recipe
            : recipeIds.has(summary.id) ? summary.id : null,
          artUrl: `/api/packs/${encodeURIComponent(summary.id)}/art/grid?v=${encodeURIComponent(modifiedAt)}`,
          artCustom: !!library?.image,
          error: null,
        });
      } catch (err) {
        out.push({
          valid: false,
          id: entry.name,
          name: entry.name,
          baseName: entry.name,
          notes: "",
          review: null,
          description: "",
          game: { id: "", title: "", appId: null, build: "", version: "" },
          mod: { id: "", version: "" },
          files: 0,
          totalBytes: 0,
          contents: null,
          platforms: [],
          root,
          modifiedAt,
          recipeId: recipeIds.has(entry.name) ? entry.name : null,
          artUrl: "",
          artCustom: false,
          error: util.errorMessage(err),
        });
      }
    }
    return out.sort((a, b) => {
      const game = a.game.title.localeCompare(b.game.title);
      return game || a.name.localeCompare(b.name);
    });
  }

  function jobSummary(job: BuildJob | null): BuildJobSummary | null {
    if (!job) return null;
    return {
      id: job.id,
      recipeId: job.recipeId,
      packId: job.packId,
      status: job.status,
      phase: job.phase,
      percent: job.percent,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      log: job.log.slice(-80),
      result: job.result,
    };
  }

  function guide(): ConsoleState["guide"] {
    const base = runtime ? runtime.url : plannedUrl();
    const host = runtime ? runtime.host : plannedHost();
    const loopback = host === "127.0.0.1" || host === "localhost";
    return {
      installUrl: labels.installUrl,
      installCommand: loopback
        ? "Loopback only — change Bind to the LAN option to get the Client install command."
        : base
          ? labels.serve.installPairing(base)
          : "Start the server to get the Client install command.",
      manualInstallCommand: loopback || !base ? "" : labels.serve.install(base, config.token),
      firewallCommand: labels.serve.firewall(runtime ? runtime.port : config.port),
    };
  }

  async function state(): Promise<ConsoleState> {
    return {
      app: {
        version: options.version || "0.0.0",
        packsDir: config.packsDir,
        recipesDir: recipes.recipesDir,
        configFile,
        platform: process.platform,
        tokenStorage: tokenStorage ? "protected" : "config",
        loginItem: { supported: !!options.setLaunchAtLogin, error: loginError },
      },
      server: serverStatus(),
      settings: { ...config, working: { ...config.working } },
      packs: listPacks(),
      recipes: listRecipes(),
      lan: { detected: util.detectLanIp(), addresses: util.lanAddresses() },
      build: jobSummary(activeJob || lastJob),
      pairRequests: runtime ? runtime.pairing.list() : [],
      devices: devices.list(),
      guide: guide(),
    };
  }

  async function startServer(): Promise<ServerStatus> {
    if (runtime) return serverStatus();
    let host: string;
    try {
      host = resolveHost();
    } catch (err) {
      serverError = util.errorMessage(err);
      emit();
      throw err;
    }
    const port = config.port;
    const token = config.token;
    if (host === "0.0.0.0") {
      serverError = "Refusing to bind all interfaces. Choose one LAN address.";
      emit();
      throw new Error(serverError);
    }
    const pairing = createPairingStore({
      tokenFactory: ({ device, address, deviceId }) => devices.issue({ name: device, address, deviceId }).token,
    });
    const server = createServer({
      packsDir: config.packsDir,
      token,
      devices,
      pairing,
      baseUrl: `http://${host}:${port}`,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    } catch (err) {
      serverError = util.errorMessage(err);
      emit();
      throw err;
    }
    const address = server.address();
    const actualPort = address && typeof address === "object" ? address.port : port;
    runtime = {
      server,
      pairing: server.pairing,
      host,
      port: actualPort,
      url: `http://${host}:${actualPort}`,
      startedAt: new Date().toISOString(),
    };
    serverError = null;
    server.on("error", (err) => {
      serverError = util.errorMessage(err);
      emit();
    });
    server.on("close", () => {
      if (runtime && runtime.server === server) {
        runtime = null;
        emit();
      }
    });
    emit();
    return serverStatus();
  }

  async function stopServer(): Promise<ServerStatus> {
    const current = runtime;
    if (!current) {
      serverError = null;
      return serverStatus();
    }
    await new Promise<void>((resolve) => {
      let closed = false;
      const finish = (): void => {
        if (closed) return;
        closed = true;
        resolve();
      };
      current.server.close(() => finish());
      // A keep-alive download can delay close indefinitely. Give active
      // requests a short grace period, then close their sockets.
      const timer = setTimeout(() => {
        try { current.server.closeAllConnections(); } catch { /* older Node */ }
        finish();
      }, 1500);
      timer.unref();
    });
    runtime = null;
    serverError = null;
    emit();
    return serverStatus();
  }

  function applyLaunchAtLogin(enabled: boolean): void {
    if (!options.setLaunchAtLogin) return;
    const result = options.setLaunchAtLogin(enabled);
    loginError = result.ok ? null : result.error || "Could not update the Windows login item.";
  }

  async function updateSettings(input: Partial<ConsoleConfig> & { workingSource?: { recipeId: string; source: string } }): Promise<ConsoleState> {
    const before = config;
    const next: ConsoleConfig = {
      ...config,
      working: { ...config.working },
    };
    if (activeJob && input.packsDir != null && path.resolve(String(input.packsDir)) !== before.packsDir) {
      throw new Error("Wait for the running build before changing the packs folder.");
    }
    if (input.packsDir != null) {
      const dir = String(input.packsDir).trim();
      if (!dir) throw new Error("Packs folder cannot be empty.");
      next.packsDir = path.resolve(dir);
      util.ensureDir(next.packsDir);
    }
    if (input.bind != null) next.bind = modeValue(input.bind);
    if (input.host != null) next.host = String(input.host).trim();
    if (next.bind === "host" && !next.host) throw new Error("Enter a bind address or choose the LAN option.");
    if (next.host === "0.0.0.0") throw new Error("Refusing to bind all interfaces. Choose one LAN address.");
    if (input.port != null) next.port = portValue(input.port);
    if (input.token != null) next.token = normalizeToken(input.token);
    if (input.autoStart != null) next.autoStart = input.autoStart === true;
    if (input.launchAtLogin != null) next.launchAtLogin = input.launchAtLogin === true;
    if (input.minimizeToTray != null) next.minimizeToTray = input.minimizeToTray === true;
    if (input.workingSource) {
      const { recipeId, source } = input.workingSource;
      if (!PACK_ID.test(recipeId)) throw new Error("Invalid recipe id.");
      if (!source.trim()) throw new Error("Working install cannot be empty.");
      next.working[recipeId] = { source: path.resolve(source.trim()) };
    }
    if (tokenStorage) {
      try {
        tokenStorage.write(next.token);
      } catch {
        // A failed protected write must not lose the token; fall back to the
        // config file so the next launch still has a usable value.
        tokenStorage = null;
      }
    }
    config = next;
    recipeCache = null;
    saveConfig(config);
    if (!sameToken(next.token, before.token)) devices.setLegacyToken(next.token);
    if (next.launchAtLogin !== before.launchAtLogin) applyLaunchAtLogin(next.launchAtLogin);
    if (runtime) {
      const restart = next.packsDir !== before.packsDir
        || next.bind !== before.bind
        || next.host !== before.host
        || next.port !== before.port
        || !sameToken(next.token, before.token);
      if (restart) {
        await stopServer();
        await startServer();
      }
    }
    return state();
  }

  function revokeDevice(id: string): DeviceView[] {
    const key = String(id || "").trim();
    if (!key) throw new Error("Device id is required.");
    if (!devices.revoke(key)) throw new Error("Device not found.");
    emit();
    return devices.list();
  }

  function revokeAllDevices(): DeviceView[] {
    devices.revokeAll();
    emit();
    return devices.list();
  }

  function startBuild(input: BuildRequest): BuildJobSummary {
    if (activeJob) throw new Error("A build is already running.");
    if (!PACK_ID.test(String(input.recipeId || ""))) throw new Error("Invalid recipe id.");
    const recipe = recipes.loadRecipe(String(input.recipeId || ""));
    const driver = drivers.driverFor(recipe.game);
    const driverOptions = normalizeDriverOptions(driver, input.driverOptions);
    const requestedVersion = String(input.version || "").trim();
    if (requestedVersion && !/^[A-Za-z0-9._+-]+$/.test(requestedVersion)) {
      throw new Error("Version can only use letters, numbers, dots, dashes, underscores, and plus signs.");
    }
    const requestedPackId = String(input.packId || "").trim();
    const packId = requestedPackId || recipe.id;
    if (!PACK_ID.test(packId) || packId === "." || packId === "..") throw new Error("Invalid pack id.");
    const createNew = input.createNew === true;
    if (createNew) {
      if (!requestedPackId) throw new Error("Choose a pack id for the new pack.");
      if (fs.existsSync(packRoot(packId))) throw new Error(`A pack already exists with that id: ${packId}`);
      if (recipes.listRecipes().some((entry) => entry.id === packId)) {
        throw new Error(`That pack id belongs to a recipe: ${packId}`);
      }
    } else if (packId !== recipe.id && !fs.existsSync(packRoot(packId))) {
      throw new Error(`Pack not found: ${packId}`);
    }
    const newPackName = createNew ? normalizePackLibraryName(input.packName) : "";
    const remembered = config.working[recipe.id]?.source || "";
    const source = path.resolve(String(input.source || remembered || driver.defaultSource()));
    if (!fs.existsSync(source)) throw new Error(`Working install not found: ${source}`);
    config.working[recipe.id] = { source };
    recipeCache = null;
    saveConfig(config);
    const finalOut = packRoot(packId);
    const stamp = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const staging = buildRoot();
    const tempOut = path.join(staging, `${packId}-${stamp}`);
    const backup = path.join(staging, `${packId}-previous-${stamp}`);
    const job: BuildJob = {
      id: crypto.randomUUID(),
      recipeId: recipe.id,
      packId,
      status: "running",
      phase: "preparing",
      percent: 0,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      log: [],
      result: null,
    };
    activeJob = job;
    lastJob = job;
    const log = (line: string): void => {
      job.log.push(line);
      if (job.log.length > 400) job.log.shift();
    };
    const progress = (update: BuildProgress): void => {
      if (update.phase) job.phase = update.phase;
      const percent = percentForProgress(update);
      if (percent != null) job.percent = Math.max(job.percent, Math.min(99, percent));
    };
    util.ensureDir(staging);

    void (async () => {
      try {
        log(`Building ${recipe.name} ${requestedVersion}`.trim());
        log(`Source: ${source}`);
        if (packId !== recipe.id) log(`Target pack: ${packId}`);
        const result = await driver.buildPack({
          recipe,
          source,
          out: tempOut,
          link: input.copy !== true,
          version: requestedVersion,
          driverOptions,
          progress,
          log,
        });
        if (packId !== recipe.id) {
          // The builders write the recipe id. A derived pack keeps the recipe
          // in pack.json so the console can still offer "Rebuild from install".
          const packFile = path.join(tempOut, "pack.json");
          const packDoc = util.readJson<Record<string, unknown>>(packFile);
          packDoc.id = packId;
          packDoc.recipe = recipe.id;
          util.writeJson(packFile, packDoc);
          const filesRel = typeof packDoc.files === "string" && packDoc.files ? packDoc.files : "files.json";
          const filesFile = util.safeJoin(tempOut, filesRel);
          const filesDoc = util.readJson<Record<string, unknown>>(filesFile);
          filesDoc.pack = packId;
          util.writeJson(filesFile, filesDoc);
        }
        // A rebuild starts with a clean library. Custom names, notes, and the
        // selected cover belong to one built pack and are not carried into the
        // replacement.
        fs.rmSync(libraryFile(tempOut), { force: true });
        job.phase = "swapping";
        if (fs.existsSync(finalOut)) {
          fs.rmSync(backup, { recursive: true, force: true });
          fs.renameSync(finalOut, backup);
        }
        try {
          fs.renameSync(tempOut, finalOut);
        } catch (err) {
          if (fs.existsSync(backup) && !fs.existsSync(finalOut)) fs.renameSync(backup, finalOut);
          throw err;
        }
        fs.rmSync(backup, { recursive: true, force: true });
        if (createNew && newPackName) {
          try {
            savePackLibrary(finalOut, { name: newPackName });
          } catch (err) {
            log(`Could not save the new pack name: ${util.errorMessage(err)}`);
          }
        }
        config.working[recipe.id] = { source };
        recipeCache = null;
        saveConfig(config);
        job.status = "done";
        job.phase = "done";
        job.percent = 100;
        job.finishedAt = new Date().toISOString();
        job.result = { version: result.pack.mod.version, files: result.files, totalBytes: result.totalBytes };
        log(`Done: ${result.pack.mod.version}, ${result.files} files, ${util.formatBytes(result.totalBytes)}`);
      } catch (err) {
        job.status = "error";
        job.phase = "error";
        job.error = util.errorMessage(err);
        job.finishedAt = new Date().toISOString();
        log(`ERROR: ${job.error}`);
        try { fs.rmSync(tempOut, { recursive: true, force: true }); } catch { /* best effort */ }
      } finally {
        activeJob = null;
        emit();
      }
    })();
    return jobSummary(job)!;
  }

  function clearReadOnly(dir: string): void {
    try { fs.chmodSync(dir, 0o777); } catch { /* best effort */ }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        clearReadOnly(abs);
      } else {
        try { fs.chmodSync(abs, 0o666); } catch { /* best effort */ }
      }
    }
  }

  async function removeTree(target: string): Promise<void> {
    let last: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
        return;
      } catch (err) {
        last = err;
        const code = (err as NodeJS.ErrnoException).code || "";
        if (!["ENOTEMPTY", "EPERM", "EACCES", "EBUSY"].includes(code)) throw err;
        clearReadOnly(target);
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw last;
  }

  function updatePackLibrary(id: string, input: { name?: unknown; notes?: unknown }): ConsolePack[] {
    const root = packRoot(id);
    if (!fs.existsSync(path.join(root, "pack.json"))) throw new Error(`Pack not found: ${id}`);
    savePackLibrary(root, { name: input.name, notes: input.notes });
    return listPacks();
  }

  function updatePackImage(id: string, input: { path?: unknown; data?: unknown }): ConsolePack[] {
    const root = packRoot(id);
    if (!fs.existsSync(path.join(root, "pack.json"))) throw new Error(`Pack not found: ${id}`);

    let png: Buffer;
    const source = typeof input.path === "string" ? input.path.trim() : "";
    if (source) {
      const file = path.resolve(source);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Image not found: ${file}`);
      if (fs.statSync(file).size > packImage.PACK_IMAGE_MAX_BYTES) {
        throw new Error(`Pack image must be no larger than ${packImage.PACK_IMAGE_MAX_BYTES / 1024 / 1024} MB.`);
      }
      png = fs.readFileSync(file);
    } else if (typeof input.data === "string") {
      const match = /^data:image\/png;base64,([\s\S]+)$/i.exec(input.data.trim());
      if (!match) throw new Error("Choose a PNG image.");
      png = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
    } else {
      throw new Error("Choose an image first.");
    }

    packImage.setPackImage(root, png);
    return listPacks();
  }

  function clearPackImage(id: string): ConsolePack[] {
    const root = packRoot(id);
    if (!fs.existsSync(path.join(root, "pack.json"))) throw new Error(`Pack not found: ${id}`);
    packImage.clearPackImage(root);
    return listPacks();
  }

  function saveReview(input: ReviewInput): ModReview | null {
    return reviews.set(input);
  }

  async function removePack(id: string): Promise<void> {
    if (activeJob && activeJob.packId === id) throw new Error("Wait for the running build before removing this pack.");
    const root = packRoot(id);
    if (!isInside(config.packsDir, root) || root === path.resolve(config.packsDir)) throw new Error("Invalid pack folder.");
    if (!fs.existsSync(root)) throw new Error(`Pack not found: ${id}`);
    const wasRunning = !!runtime;
    if (wasRunning) await stopServer();
    try {
      await removeTree(root);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code || "";
      if (["ENOTEMPTY", "EPERM", "EACCES", "EBUSY"].includes(code)) {
        throw new Error(`Could not remove ${id}: ${util.errorMessage(err)}. Close the game, loader, or Explorer preview using this folder, then try again.`);
      }
      throw err;
    } finally {
      if (wasRunning) {
        try { await startServer(); } catch { /* the server error is surfaced in state */ }
      }
    }
    recipeCache = null;
  }

  function revealPack(id: string): void {
    const root = packRoot(id);
    if (!fs.existsSync(root)) throw new Error(`Pack not found: ${id}`);
    if (!options.reveal) throw new Error("Opening folders is only available in the desktop app.");
    options.reveal(root);
  }

  function revealPacksDir(): void {
    util.ensureDir(config.packsDir);
    if (!options.reveal) throw new Error("Opening folders is only available in the desktop app.");
    options.reveal(config.packsDir);
  }

  function packArt(id: string, key: string): Buffer {
    if (!PACK_ID.test(id) || !/^[a-zA-Z]+$/.test(key)) throw new Error("Invalid art request.");
    const root = packRoot(id);
    const { pack } = loadPack(root);
    const art = pack.art as Record<string, string | undefined>;
    const rel = art[key];
    if (!rel) throw new Error("Art not found.");
    const file = util.safeJoin(root, rel);
    if (!fs.existsSync(file)) throw new Error("Art file is missing.");
    return fs.readFileSync(file);
  }

  function requestAllowed(req: http.IncomingMessage): boolean {
    const host = String(req.headers.host || "");
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false;
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return false;
    return true;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!requestAllowed(req)) return sendJson(res, 403, { error: "local access only" });
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const method = (req.method || "GET").toUpperCase();

    if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true, name: "modsync-pc" });
    if (url.pathname === "/api/state" && method === "GET") {
      return sendJson(res, 200, await state());
    }
    if (url.pathname === "/api/status" && method === "GET") {
      return sendJson(res, 200, { server: serverStatus(), build: jobSummary(activeJob || lastJob) });
    }
    if (url.pathname === "/api/server/start" && method === "POST") {
      try { return sendJson(res, 200, await startServer()); } catch (err) {
        serverError = util.errorMessage(err);
        emit();
        return sendError(res, err);
      }
    }
    if (url.pathname === "/api/server/stop" && method === "POST") {
      return sendJson(res, 200, await stopServer());
    }
    if ((url.pathname === "/api/pair/approve" || url.pathname === "/api/pair/deny") && method === "POST") {
      const body = await readJsonBody(req);
      const id = String(body.id || "");
      if (!runtime) return sendJson(res, 409, { error: "Start the pack server before approving a TV." });
      const accepted = url.pathname.endsWith("/approve")
        ? runtime.pairing.approve(id)
        : runtime.pairing.deny(id);
      if (!accepted) return sendJson(res, 404, { error: "Pairing request not found or expired." });
      return sendJson(res, 200, { ok: true, pairRequests: runtime.pairing.list() });
    }
    if (url.pathname === "/api/devices/revoke" && method === "POST") {
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 200, { ok: true, devices: revokeDevice(String(body.id || "")) });
      } catch (err) {
        return sendJson(res, 404, { error: util.errorMessage(err) });
      }
    }
    if (url.pathname === "/api/devices/revoke-all" && method === "POST") {
      return sendJson(res, 200, { ok: true, devices: revokeAllDevices() });
    }
    if (url.pathname === "/api/settings" && method === "POST") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await updateSettings(body as Partial<ConsoleConfig> & { workingSource?: { recipeId: string; source: string } }));
    }
    if (url.pathname === "/api/build" && method === "POST") {
      const body = await readJsonBody(req);
      return sendJson(res, 202, startBuild({
        recipeId: String(body.recipeId || ""),
        source: body.source == null ? undefined : String(body.source),
        version: body.version == null ? undefined : String(body.version),
        copy: body.copy === true,
        packId: body.packId == null ? undefined : String(body.packId),
        createNew: body.createNew === true,
        packName: body.packName == null ? undefined : String(body.packName),
        driverOptions: body.driverOptions && typeof body.driverOptions === "object" && !Array.isArray(body.driverOptions)
          ? body.driverOptions as Record<string, unknown>
          : undefined,
      }));
    }
    if (url.pathname === "/api/packs/remove" && method === "POST") {
      const body = await readJsonBody(req);
      if (body.confirm !== true) {
        return sendJson(res, 400, { error: "Pack removal needs explicit confirmation." });
      }
      await removePack(String(body.id || ""));
      return sendJson(res, 200, { ok: true, packs: listPacks() });
    }
    if (url.pathname === "/api/reviews" && method === "POST") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, {
        ok: true,
        review: saveReview({
          gameId: body.gameId,
          modId: body.modId,
          rating: body.rating,
          body: body.body,
        }),
      });
    }
    if (url.pathname === "/api/reveal/packs" && method === "POST") {
      revealPacksDir();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname.startsWith("/api/packs/") && method === "POST" && url.pathname.endsWith("/image")) {
      const id = decodeURIComponent(url.pathname.split("/")[3] || "");
      const body = await readJsonBody(req, 12_000_000);
      return sendJson(res, 200, {
        ok: true,
        packs: updatePackImage(id, { path: body.path, data: body.data }),
      });
    }
    if (url.pathname.startsWith("/api/packs/") && method === "POST" && url.pathname.endsWith("/image/clear")) {
      const id = decodeURIComponent(url.pathname.split("/")[3] || "");
      return sendJson(res, 200, { ok: true, packs: clearPackImage(id) });
    }
    if (url.pathname.startsWith("/api/packs/") && method === "POST" && url.pathname.endsWith("/library")) {
      const id = decodeURIComponent(url.pathname.split("/")[3] || "");
      const body = await readJsonBody(req);
      return sendJson(res, 200, {
        ok: true,
        packs: updatePackLibrary(id, { name: body.name, notes: body.notes }),
      });
    }
    if (url.pathname.startsWith("/api/packs/") && method === "POST" && url.pathname.endsWith("/reveal")) {
      const id = decodeURIComponent(url.pathname.split("/")[3] || "");
      revealPack(id);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname.startsWith("/api/packs/") && method === "GET" && url.pathname.includes("/art/")) {
      const parts = url.pathname.split("/");
      const id = decodeURIComponent(parts[3] || "");
      const key = decodeURIComponent(parts[5] || "");
      const buf = packArt(id, key);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": buf.length,
        "cache-control": "public, max-age=300",
      });
      res.end(buf);
      return;
    }

    if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
    const rel = url.pathname === "/" ? "pc.html" : decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const file = path.resolve(webDir, rel);
    if (!isInside(webDir, file)) return sendJson(res, 403, { error: "forbidden" });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": contentType(file), "cache-control": "no-cache" });
    if (method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  }

  function listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        handle(req, res).catch((err) => {
          if (!res.headersSent) sendError(res, err);
          else res.end();
        });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const address = server.address();
        const port = address && typeof address === "object" ? address.port : 0;
        controlServer = server;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  async function close(): Promise<void> {
    await stopServer();
    cleanBuildRoot();
    const server = controlServer;
    controlServer = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      try { server.closeAllConnections(); } catch { /* older Node */ }
    });
  }

  cleanBuildRoot();

  return {
    listen,
    close,
    config: () => ({ ...config, working: { ...config.working } }),
    state,
    serverStatus,
    startServer,
    stopServer,
    updateSettings,
    listPacks,
    listRecipes,
    startBuild,
    updatePackLibrary,
    updatePackImage,
    clearPackImage,
    saveReview,
    removePack,
    revealPack,
    revealPacksDir,
    revokeDevice,
    revokeAllDevices,
    isRunning: () => !!runtime,
  };
}

export { randomToken, normalizeToken, normalizeConfig, defaultConfig, DEFAULT_PORT };
