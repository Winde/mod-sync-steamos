import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";
import { contentType, readJsonBody } from "./http";
import * as util from "./util";
import * as steam from "./steam";
import * as installer from "./installer";
import * as linux from "./platforms/linux";
import * as preconditions from "./preconditions";
import * as paths from "./paths";
import * as storage from "./storage";
import * as versionStore from "./version-store";
import { projectRoot } from "./root";
import type { ProgressUpdate } from "./installer";
import type {
  ArtInfo,
  Confirmations,
  ContentsSummary,
  FilesDoc,
  GameInfo,
  InstallInfo,
  LaunchInfo,
  LoaderInfo,
  ModInfo,
  Note,
  Pack,
  PackSummary,
  Platforms,
  PreconditionsResult,
  Variant,
} from "./types";

interface RequestBody {
  packId?: string;
  checkId?: string;
  confirmed?: boolean;
  scope?: string;
  dryRun?: boolean;
  [key: string]: unknown;
}

export interface AgentConfig {
  root?: string;
  port?: number | string;
  pcUrl?: string;
  token?: string;
  steamRoot?: string;
  steamLibraries?: string[];
}

export interface AgentOptions extends AgentConfig {
  /** Persist a token received through Server approval. */
  saveConnection?: (connection: { pcUrl: string; token: string }) => void;
}

export type PairingPhase = "idle" | "pending" | "approved" | "denied" | "error";

export interface PairingState {
  status: PairingPhase;
  message: string | null;
}

interface Job {
  id: string;
  type: string;
  packId: string;
  status: "running" | "done" | "error" | "canceled";
  phase: string;
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  error: string | null;
  log: string[];
  controller: AbortController;
  startedAt: string;
}

interface JobSummary {
  id: string;
  type: string;
  packId: string;
  status: string;
  phase: string;
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  error: string | null;
  startedAt: string | null;
  log: string[];
}

function jobSummary(job: Job | null | undefined): JobSummary | null {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    packId: job.packId,
    status: job.status,
    phase: job.phase,
    done: job.done || 0,
    total: job.total || 0,
    bytesDone: job.bytesDone || 0,
    bytesTotal: job.bytesTotal || 0,
    error: job.error || null,
    startedAt: job.startedAt || null,
    log: (job.log || []).slice(-60),
  };
}

interface AgentPackInput {
  id: string;
  name: string;
  game: GameInfo;
  mod: ModInfo;
  art?: ArtInfo;
  description?: string;
  files?: number;
  totalBytes?: number;
  platformFiles?: Record<Variant, number> | null;
  platformBytes?: Record<Variant, number> | null;
  launch?: LaunchInfo;
  platforms?: Platforms | null;
  install?: InstallInfo | null;
  loader?: LoaderInfo | null;
  contents?: ContentsSummary | null;
  notes?: Note[];
  preconditions?: unknown;
}

interface LocalInfo {
  installed: boolean;
  installedVersion: string | null;
  versions: string[];
  canRollback: boolean;
  status: string;
  staging: boolean;
  packRoot: string;
  launcher: string | null;
  desktopFile: string | null;
  artUrl: string;
}

interface AgentPackState extends AgentPackInput, LocalInfo {
  platform: { variant: Variant; supported: boolean; error: string | null };
  preconditions: PreconditionsResult;
  blocked: boolean;
  local: boolean;
}

interface AgentState {
  agent: { version: string; root: string; port: number };
  pc: { url: string; online: boolean; error: string | null; auth: "ok" | "rejected" | "unknown" | "unconfigured" };
  pairing: PairingState;
  packs: AgentPackState[];
  diskFreeBytes: number | null;
  job: JobSummary | null;
}

interface RemoteCache {
  at: number;
  packs: PackSummary[];
  error: string | null;
}

export interface Agent {
  server: http.Server;
  listen: (callback?: () => void) => void;
  state: () => Promise<AgentState>;
  startInstallJob: (packId: string) => Job;
  startPairing: () => PairingState;
  config: { root: string; port: number; pcUrl: string };
}

export function createAgent(config: AgentOptions): Agent {
  const root = config.root || path.join(os.homedir(), "ModSync");
  const port = Number(config.port || 8788);
  let pcUrl = String(config.pcUrl || "").replace(/\/+$/, "");
  let token = config.token || "";
  let pairing: PairingState = { status: "idle", message: null };
  let pairingRun = 0;
  const pairWaitMs = 2 * 60 * 1000;
  const fetchTimeoutMs = 8000;
  if (config.steamRoot) process.env.STEAM_ROOT = String(config.steamRoot);
  if (Array.isArray(config.steamLibraries)) steam.setExtraLibraries(config.steamLibraries);
  const webDir = path.join(projectRoot, "web");
  const jobs = new Map<string, Job>();
  let activeJob: Job | null = null;
  let lastJob: Job | null = null;
  let remoteCache: RemoteCache = { at: 0, packs: [], error: null };
  const artCache = new Map<string, Buffer>();
  const confirmFile = path.join(root, "state", "preconditions.json");

  const packRoot = (id: string) => versionStore.packRoot(root, id);

  function localPack(id: string): Pack | null {
    const file = versionStore.packFile(packRoot(id));
    if (!fs.existsSync(file)) return null;
    try { return util.readJson<Pack>(file); } catch { return null; }
  }

  function localPacks(): Pack[] {
    const dir = versionStore.packsDir(root);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => localPack(e.name))
      .filter((p): p is Pack => p !== null);
  }

  function localSummary(pack: Pack): AgentPackInput {
    let files = 0;
    let totalBytes = 0;
    let platformFiles: Record<Variant, number> | null = null;
    let platformBytes: Record<Variant, number> | null = null;
    try {
      const doc = util.readJson<FilesDoc>(versionStore.filesDocFile(packRoot(pack.id), pack));
      if (Array.isArray(doc.files)) {
        files = doc.files.length;
        totalBytes = doc.files.reduce((n, f) => n + (f.size || 0), 0);
        const stats = paths.platformStats(doc.files);
        platformFiles = Object.fromEntries(paths.VARIANTS.map((variant) => [variant, stats[variant].files])) as Record<Variant, number>;
        platformBytes = Object.fromEntries(paths.VARIANTS.map((variant) => [variant, stats[variant].totalBytes])) as Record<Variant, number>;
      }
    } catch { /* files.json is optional for a partially installed pack */ }
    return { ...pack, files, totalBytes, platformFiles, platformBytes };
  }

  function readConfirmations(): Confirmations {
    try { return util.readJson<Confirmations>(confirmFile); } catch { return {}; }
  }

  function setConfirmation(packId: string, checkId: string, confirmed: boolean): { packId: string; checkId: string; confirmed: boolean } {
    const all = readConfirmations();
    const forPack = all[packId] || (all[packId] = {});
    if (confirmed) forPack[checkId] = { confirmedAt: new Date().toISOString() };
    else delete forPack[checkId];
    util.ensureDir(path.dirname(confirmFile));
    util.writeJson(confirmFile, all);
    return { packId, checkId, confirmed };
  }

  async function fetchRemote(force = false): Promise<RemoteCache> {
    if (!force && Date.now() - remoteCache.at < 2500) return remoteCache;
    if (!pcUrl) return (remoteCache = { at: Date.now(), packs: [], error: "PC URL is not configured" });
    try {
      const packs = await util.fetchJson<PackSummary[]>(`${pcUrl}/api/packs`, {
        headers: { "x-modsync-token": token },
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
      remoteCache = { at: Date.now(), packs, error: null };
    } catch (err) {
      const message = util.errorMessage(err);
      if (/HTTP 403\b/.test(message) && pairing.status === "approved") {
        pairing = { status: "idle", message: null };
      }
      remoteCache = { at: Date.now(), packs: [], error: message };
    }
    return remoteCache;
  }

  function startPairing(): PairingState {
    if (!pcUrl) {
      pairing = { status: "error", message: "The Server address is not configured." };
      return pairing;
    }
    if (pairing.status === "pending") return pairing;
    const run = ++pairingRun;
    pairing = { status: "pending", message: "Waiting for approval on the Server." };
    void (async () => {
      try {
        const request = await util.fetchJson<{ requestId?: string }>(`${pcUrl}/api/pair/request`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device: `ModSync Client (${os.hostname()})` }),
          signal: AbortSignal.timeout(fetchTimeoutMs),
        });
        const requestId = String(request.requestId || "");
        if (!requestId) throw new Error("The Server did not return a pairing request id.");
        const deadline = Date.now() + pairWaitMs;
        while (Date.now() < deadline) {
          if (run !== pairingRun) return;
          await new Promise((resolve) => setTimeout(resolve, 1500));
          let result: { status?: string; token?: string } | null = null;
          try {
            result = await util.fetchJson<{ status?: string; token?: string }>(
              `${pcUrl}/api/pair/status?id=${encodeURIComponent(requestId)}`,
              { signal: AbortSignal.timeout(fetchTimeoutMs) },
            );
          } catch (err) {
            if (/HTTP 404\b/.test(util.errorMessage(err))) throw err;
            continue;
          }
          if (result.status === "approved" && result.token) {
            token = result.token;
            remoteCache = { at: 0, packs: [], error: null };
            try { config.saveConnection?.({ pcUrl, token }); } catch { /* the in-memory token still works */ }
            pairing = { status: "approved", message: "Approved. The Server token is saved on this TV." };
            return;
          }
          if (result.status === "denied") {
            pairing = { status: "denied", message: "The Server denied this TV." };
            return;
          }
        }
        pairing = { status: "error", message: "The Server did not approve the request. Try again." };
      } catch (err) {
        if (run !== pairingRun) return;
        pairing = { status: "error", message: util.errorMessage(err) };
      }
    })();
    return pairing;
  }

  function localInfo(pack: { id: string; mod: { id: string; version: string } }): LocalInfo {
    const pr = packRoot(pack.id);
    const current = versionStore.readCurrent(pr, pack.mod.id);
    const versions = versionStore.listVersions(pr, pack.mod.id);
    const launcher = versionStore.launcherFile(pr, pack.mod.id);
    const desktop = linux.desktopFileFor(pack.mod.id);
    return {
      installed: !!current,
      installedVersion: current || null,
      versions,
      canRollback: versionStore.canRollback(pr, pack.mod.id),
      status: !current ? "not-installed" : (current === pack.mod.version ? "up-to-date" : "update-available"),
      staging: fs.existsSync(versionStore.stagingDir(pr, pack.mod.id, pack.mod.version)),
      packRoot: pr,
      launcher: fs.existsSync(launcher) ? launcher : null,
      desktopFile: fs.existsSync(desktop) ? desktop : null,
      artUrl: `/api/art/${encodeURIComponent(pack.id)}/grid`,
    };
  }

  async function state(): Promise<AgentState> {
    const remote = await fetchRemote();
    const confirmed = readConfirmations();
    const local = new Map(localPacks().map((p) => [p.id, p]));
    const merged = new Map<string, AgentPackInput>();
    for (const p of remote.packs || []) merged.set(p.id, p);
    for (const [id, pack] of local) {
      if (!merged.has(id)) merged.set(id, localSummary(pack));
    }
    const packs: AgentPackState[] = [...merged.values()].map((p) => {
      const li = localInfo(p);
      const game = steam.findGame(p.game);
      const target = paths.resolve(p as unknown as Pack, game);
      const variant = target.variant;
      const selected = {
        ...p,
        files: p.platformFiles?.[variant] ?? p.files,
        totalBytes: p.platformBytes?.[variant] ?? p.totalBytes,
      };
      const pre = preconditions.evaluatePreconditions({
        pack: p as unknown as Pack,
        game,
        root,
        totalBytes: selected.totalBytes,
        confirmed: confirmed[p.id] || {},
      });
      return {
        ...selected,
        ...li,
        platform: { variant, supported: target.supported, error: target.error || null },
        preconditions: pre,
        blocked: pre.blocked,
        local: local.has(p.id),
      };
    }).sort((a, b) => {
      const game = String(a.game?.title || "").localeCompare(String(b.game?.title || ""));
      return game || String(a.name || "").localeCompare(String(b.name || ""));
    });
    const auth: AgentState["pc"]["auth"] = !pcUrl
      ? "unconfigured"
      : !remote.error
        ? "ok"
        : /HTTP 403\b/.test(remote.error)
          ? "rejected"
          : "unknown";
    return {
      agent: { version: "0.1.0", root, port },
      pc: { url: pcUrl, online: !remote.error && !!pcUrl, error: remote.error || null, auth },
      pairing,
      packs,
      diskFreeBytes: util.freeBytes(root),
      job: activeJob ? jobSummary(activeJob) : (lastJob ? jobSummary(lastJob) : null),
    };
  }

  async function getPack(id: string): Promise<{ pack: Pack; files: FilesDoc }> {
    const remote = await fetchRemote(true);
    const summary = (remote.packs || []).find((p) => p.id === id);
    if (!summary) throw new Error(`Pack not found: ${id}`);
    const pack = await util.fetchJson<Pack>(`${pcUrl}/api/packs/${encodeURIComponent(id)}/pack.json`, { headers: { "x-modsync-token": token } });
    const files = await util.fetchJson<FilesDoc>(`${pcUrl}/api/packs/${encodeURIComponent(id)}/files.json`, { headers: { "x-modsync-token": token } });
    return { pack, files };
  }

  function startInstallJob(packId: string): Job {
    if (activeJob) throw new Error("Another job is already running.");
    const job: Job = {
      id: crypto.randomUUID(),
      type: "install",
      packId,
      status: "running",
      phase: "preparing",
      done: 0,
      total: 0,
      bytesDone: 0,
      bytesTotal: 0,
      error: null,
      log: [],
      controller: new AbortController(),
      startedAt: new Date().toISOString(),
    };
    jobs.set(job.id, job);
    activeJob = job;
    lastJob = job;
    const log = (msg: string): void => {
      const line = `[${new Date().toISOString()}] ${msg}`;
      job.log.push(line);
      if (job.log.length > 500) job.log.shift();
      try {
        util.ensureDir(path.join(root, "logs"));
        fs.appendFileSync(path.join(root, "logs", "install.log"), line + "\n");
      } catch { /* logging is best-effort */ }
    };
    (async () => {
      const { pack, files } = await getPack(packId);
      const game = steam.findGame(pack.game);
      if (!game) throw new Error(`${pack.game.title} was not found in the Steam libraries.`);
      log(`Installing ${pack.name} ${pack.mod.version}`);
      await installer.installPack({
        pack, filesDoc: files, remoteBase: pcUrl, token, root, game,
        signal: job.controller.signal,
        confirmed: readConfirmations()[packId] || {},
        progress: (p: ProgressUpdate) => { Object.assign(job, p); },
        log,
      });
      job.status = "done";
      job.phase = "done";
      log("Install complete.");
    })().catch((err) => {
      if ((err instanceof Error && err.name === "AbortError") || job.controller.signal.aborted) {
        job.status = "canceled";
        job.phase = "canceled";
        log("Canceled. Completed files are kept; Resume continues.");
      } else {
        job.status = "error";
        job.phase = "error";
        job.error = util.errorMessage(err);
        log(`ERROR: ${util.errorMessage(err)}`);
      }
    }).finally(() => {
      activeJob = null;
    });
    return job;
  }

  function cancelJob(id: string): { ok: boolean } {
    const job = jobs.get(id) || activeJob;
    if (!job || job.status !== "running") throw new Error("No running job.");
    job.controller.abort();
    return { ok: true };
  }

  async function launchPack(packId: string): Promise<{ ok: boolean; launcher: string }> {
    const pack = localPack(packId);
    if (!pack) throw new Error("Pack is not installed on this TV.");
    const info = localInfo(pack);
    if (!info.installed) throw new Error("Pack is not installed.");
    const game = steam.findGame(pack.game);
    const target = paths.resolve(pack, game);
    if (util.isGameRunning(target.processes)) throw new Error("The game is already running.");
    const launcher = linux.writeLauncher({ pack, root, game });
    linux.launch(launcher);
    return { ok: true, launcher };
  }

  async function art(packId: string, key: string): Promise<Buffer> {
    const cacheKey = `${packId}:${key}`;
    const cached = artCache.get(cacheKey);
    if (cached) return cached;
    const pr = packRoot(packId);
    const localPackFile = versionStore.packFile(pr);
    if (fs.existsSync(localPackFile)) {
      try {
        const pack = util.readJson<Pack>(localPackFile);
        const art = pack.art as ArtInfo & Record<string, string | undefined>;
        if (art && art[key]) {
          const file = path.join(pr, art[key]);
          if (fs.existsSync(file)) {
            const buf = fs.readFileSync(file);
            artCache.set(cacheKey, buf);
            return buf;
          }
        }
      } catch { /* fall back to the PC */ }
    }
    const res = await fetch(`${pcUrl}/api/packs/${encodeURIComponent(packId)}/art/${encodeURIComponent(key)}`, {
      headers: { "x-modsync-token": token },
    });
    if (!res.ok) throw new Error(`art HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    artCache.set(cacheKey, buf);
    return buf;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    try {
      if (url.pathname === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, name: "modsync-agent", version: "0.1.0" }));
      }
      if (url.pathname === "/api/state") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(await state()));
      }
      if (url.pathname === "/api/pair" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(startPairing()));
      }
      if (url.pathname === "/api/logs") {
        const text = util.tailFile(path.join(root, "logs", "agent.log"), 120)
          + "\n" + util.tailFile(path.join(root, "logs", "install.log"), 120);
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(text);
      }
      if (url.pathname.startsWith("/api/art/")) {
        const [, , , packId, key] = url.pathname.split("/");
        const buf = await art(decodeURIComponent(packId), decodeURIComponent(key));
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(buf);
      }
      if (url.pathname.startsWith("/api/jobs/") && url.pathname.endsWith("/cancel") && req.method === "POST") {
        const id = url.pathname.split("/")[3];
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(cancelJob(id)));
      }
      if (url.pathname.startsWith("/api/jobs/")) {
        const id = url.pathname.split("/")[3];
        const job = jobs.get(id);
        if (!job) { res.writeHead(404); return res.end("{}"); }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(jobSummary(job)));
      }
      if (url.pathname === "/api/storage" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(storage.computeStorage(root)));
      }
      if (url.pathname === "/api/storage/clear" && req.method === "POST") {
        if (activeJob) {
          res.writeHead(409, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "Cancel the running install first." }));
        }
        const body = await readJsonBody<RequestBody>(req);
        if (body.scope !== "logs" && body.packId) {
          try {
            const pack = util.readJson<Pack>(versionStore.packFile(versionStore.packRoot(root, body.packId)));
            const target = paths.resolve(pack, steam.findGame(pack.game));
            if (util.isGameRunning(target.processes)) {
              res.writeHead(409, { "content-type": "application/json" });
              return res.end(JSON.stringify({ error: "Close the game before removing installed files." }));
            }
          } catch { /* missing pack data just skips the running-game guard */ }
        }
        if (body.dryRun) {
          const plan = storage.planClear(root, { packId: body.packId, scope: String(body.scope || "") });
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify(plan));
        }
        const shortcutPackRoot = body.packId ? versionStore.packRoot(root, body.packId) : "";
        let packForShortcut: Pack | null = null;
        if (shortcutPackRoot) {
          try { packForShortcut = util.readJson<Pack>(versionStore.packFile(shortcutPackRoot)); } catch { /* no pack data */ }
        }
        const shortcutMod = packForShortcut && packForShortcut.mod ? packForShortcut.mod.id : "";
        const shortcutLauncher = shortcutPackRoot && shortcutMod ? versionStore.launcherFile(shortcutPackRoot, shortcutMod) : "";
        const out = storage.clearStorage(root, { packId: body.packId, scope: String(body.scope || "") });
        if (body.scope === "pack" && shortcutLauncher) {
          try { await linux.removeShortcut(shortcutLauncher); } catch { /* Steam data may be absent */ }
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, ...out, storage: storage.computeStorage(root) }));
      }
      if (url.pathname === "/api/preconditions/confirm" && req.method === "POST") {
        const body = await readJsonBody<RequestBody>(req);
        if (!body.packId || !body.checkId) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "packId and checkId required" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(setConfirmation(body.packId, body.checkId, body.confirmed !== false)));
      }
      if (url.pathname === "/api/install" && req.method === "POST") {
        const body = await readJsonBody<RequestBody>(req);
        if (!body.packId) { res.writeHead(400); return res.end(JSON.stringify({ error: "packId required" })); }
        const job = startInstallJob(body.packId);
        res.writeHead(202, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jobId: job.id }));
      }
      if (url.pathname === "/api/launch" && req.method === "POST") {
        const body = await readJsonBody<RequestBody>(req);
        if (!body.packId) { res.writeHead(400); return res.end(JSON.stringify({ error: "packId required" })); }
        const out = await launchPack(body.packId);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(out));
      }
      if (url.pathname === "/api/rollback" && req.method === "POST") {
        const body = await readJsonBody<RequestBody>(req);
        if (!body.packId) { res.writeHead(400); return res.end(JSON.stringify({ error: "packId required" })); }
        const pack = localPack(body.packId);
        if (!pack) throw new Error("Pack is not installed on this TV.");
        const out = installer.rollback({ pack, root, log: () => { } });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(out));
      }

      const file = path.join(webDir, url.pathname === "/" ? "index.html" : url.pathname);
      if (!path.resolve(file).startsWith(path.resolve(webDir))) { res.writeHead(403); return res.end("forbidden"); }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": contentType(file) });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: util.errorMessage(err) }));
    }
  });

  // Refresh generated launchers at app startup so an app update applies new
  // launch behavior without requiring a pack reinstall.
  for (const pack of localPacks()) {
    const game = steam.findGame(pack.game);
    if (!game) continue;
    try { linux.writeLauncher({ pack, root, game }); } catch { /* regenerate on install */ }
  }
  linux.pruneShortcuts(root).catch(() => { /* Steam data may be absent */ });

  return {
    server,
    listen: (cb?: () => void) => server.listen(port, "127.0.0.1", cb),
    state,
    startInstallJob,
    startPairing,
    config: { root, port, pcUrl },
  };
}
