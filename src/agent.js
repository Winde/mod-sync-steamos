const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { spawn } = require("node:child_process");
const util = require("./util");
const steam = require("./steam");
const installer = require("./installer");
const preconditions = require("./preconditions");
const paths = require("./paths");
const storage = require("./storage");
const versionStore = require("./version-store");

function contentType(p) {
  switch (path.extname(p).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".js": return "text/javascript";
    case ".css": return "text/css";
    case ".html": return "text/html";
    default: return "application/octet-stream";
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) reject(new Error("body too large")); });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function jobSummary(job) {
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

function createAgent(config) {
  const root = config.root || path.join(os.homedir(), "ModSync");
  const port = Number(config.port || 8788);
  const pcUrl = String(config.pcUrl || "").replace(/\/+$/, "");
  const token = config.token || "";
  if (config.steamRoot) process.env.STEAM_ROOT = String(config.steamRoot);
  if (Array.isArray(config.steamLibraries)) steam.setExtraLibraries(config.steamLibraries);
  const webDir = path.join(__dirname, "..", "web");
  const jobs = new Map();
  let activeJob = null;
  let lastJob = null;
  let remoteCache = { at: 0, packs: [], error: null };
  const artCache = new Map();
  const confirmFile = path.join(root, "state", "preconditions.json");

  const packRoot = (id) => versionStore.packRoot(root, id);

  function localPack(id) {
    const file = versionStore.packFile(packRoot(id));
    if (!fs.existsSync(file)) return null;
    try { return util.readJson(file); } catch { return null; }
  }

  function localPacks() {
    const dir = versionStore.packsDir(root);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => localPack(e.name))
      .filter(Boolean);
  }

  function localSummary(pack) {
    let files = 0;
    let totalBytes = 0;
    let platformFiles = null;
    let platformBytes = null;
    try {
      const doc = util.readJson(versionStore.filesDocFile(packRoot(pack.id), pack));
      if (Array.isArray(doc.files)) {
        files = doc.files.length;
        totalBytes = doc.files.reduce((n, f) => n + (f.size || 0), 0);
        const stats = paths.platformStats(doc.files);
        platformFiles = Object.fromEntries(paths.VARIANTS.map((variant) => [variant, stats[variant].files]));
        platformBytes = Object.fromEntries(paths.VARIANTS.map((variant) => [variant, stats[variant].totalBytes]));
      }
    } catch { }
    return { ...pack, files, totalBytes, platformFiles, platformBytes };
  }

  function readConfirmations() {
    try { return util.readJson(confirmFile); } catch { return {}; }
  }

  function setConfirmation(packId, checkId, confirmed) {
    const all = readConfirmations();
    const forPack = all[packId] || (all[packId] = {});
    if (confirmed) forPack[checkId] = { confirmedAt: new Date().toISOString() };
    else delete forPack[checkId];
    util.ensureDir(path.dirname(confirmFile));
    util.writeJson(confirmFile, all);
    return { packId, checkId, confirmed };
  }

  async function fetchRemote(force = false) {
    if (!force && Date.now() - remoteCache.at < 2500) return remoteCache;
    if (!pcUrl) return (remoteCache = { at: Date.now(), packs: [], error: "PC URL is not configured" });
    try {
      const packs = await util.fetchJson(`${pcUrl}/api/packs`, { headers: { "x-modsync-token": token } });
      remoteCache = { at: Date.now(), packs, error: null };
    } catch (err) {
      remoteCache = { at: Date.now(), packs: [], error: err.message };
    }
    return remoteCache;
  }

  function localInfo(pack) {
    const pr = packRoot(pack.id);
    const current = versionStore.readCurrent(pr, pack.mod.id);
    const versions = versionStore.listVersions(pr, pack.mod.id);
    const launcher = versionStore.launcherFile(pr, pack.mod.id);
    const desktop = path.join(os.homedir(), ".local", "share", "applications", `${pack.mod.id}.desktop`);
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

  async function gameState(pack) {
    if (!pack) return null;
    const g = steam.findGame(pack.game);
    const target = paths.resolve(pack, g);
    return {
      title: pack.game.title,
      expectedBuild: pack.game.build || null,
      path: g ? g.root : null,
      build: g ? g.build : null,
      mode: g ? g.mode : null,
      variant: target.variant,
      supported: target.supported,
      prefixReady: g ? g.prefixReady : null,
      running: util.isGameRunning(target.processes),
      ok: !!g
        && (!pack.game.build || g.build === String(pack.game.build))
        && target.supported
        && (target.variant !== "linux-proton" || !pack.game.prefix || g.prefixReady),
    };
  }

  async function state() {
    const remote = await fetchRemote();
    const confirmed = readConfirmations();
    const local = new Map(localPacks().map((p) => [p.id, p]));
    const merged = new Map();
    for (const p of remote.packs || []) merged.set(p.id, p);
    for (const [id, pack] of local) {
      if (!merged.has(id)) merged.set(id, localSummary(pack));
    }
    const packs = [...merged.values()].map((p) => {
      const li = localInfo(p);
      const game = steam.findGame(p.game);
      const target = paths.resolve(p, game);
      const variant = target.variant;
      const selected = {
        ...p,
        files: p.platformFiles?.[variant] ?? p.files,
        totalBytes: p.platformBytes?.[variant] ?? p.totalBytes,
      };
      const pre = preconditions.evaluatePreconditions({
        pack: p,
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
    const first = packs[0];
    return {
      agent: { version: "0.1.0", root, port },
      pc: { url: pcUrl, online: !remote.error && !!pcUrl, error: remote.error || null },
      game: await gameState(first),
      packs,
      diskFreeBytes: util.freeBytes(root),
      job: activeJob ? jobSummary(activeJob) : (lastJob ? jobSummary(lastJob) : null),
    };
  }

  async function getPack(id) {
    const remote = await fetchRemote(true);
    const summary = (remote.packs || []).find((p) => p.id === id);
    if (!summary) throw new Error(`Pack not found: ${id}`);
    const pack = await util.fetchJson(`${pcUrl}/api/packs/${encodeURIComponent(id)}/pack.json`, { headers: { "x-modsync-token": token } });
    const files = await util.fetchJson(`${pcUrl}/api/packs/${encodeURIComponent(id)}/files.json`, { headers: { "x-modsync-token": token } });
    return { pack, files };
  }

  function startInstallJob(packId) {
    if (activeJob) throw new Error("Another job is already running.");
    const job = {
      id: crypto.randomUUID(),
      type: "install",
      packId,
      status: "running",
      phase: "preparing",
      done: 0,
      total: 0,
      bytesDone: 0,
      bytesTotal: 0,
      log: [],
      controller: new AbortController(),
      startedAt: new Date().toISOString(),
    };
    jobs.set(job.id, job);
    activeJob = job;
    lastJob = job;
    const log = (msg) => {
      const line = `[${new Date().toISOString()}] ${msg}`;
      job.log.push(line);
      if (job.log.length > 500) job.log.shift();
      try {
        util.ensureDir(path.join(root, "logs"));
        fs.appendFileSync(path.join(root, "logs", "install.log"), line + "\n");
      } catch { }
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
        progress: (p) => Object.assign(job, p),
        log,
      });
      job.status = "done";
      job.phase = "done";
      log("Install complete.");
    })().catch((err) => {
      if (err.name === "AbortError" || job.controller.signal.aborted) {
        job.status = "canceled";
        job.phase = "canceled";
        log("Canceled. Completed files are kept; Resume continues.");
      } else {
        job.status = "error";
        job.phase = "error";
        job.error = err.message;
        log(`ERROR: ${err.message}`);
      }
    }).finally(() => {
      activeJob = null;
    });
    return job;
  }

  function cancelJob(id) {
    const job = jobs.get(id) || activeJob;
    if (!job || job.status !== "running") throw new Error("No running job.");
    job.controller.abort();
    return { ok: true };
  }

  async function launchPack(packId) {
    const pack = localPack(packId);
    if (!pack) throw new Error("Pack is not installed on this TV.");
    const info = localInfo(pack);
    if (!info.installed) throw new Error("Pack is not installed.");
    if (!info.launcher) throw new Error("Launcher is missing. Reinstall the pack.");
    const target = paths.resolve(pack, steam.findGame(pack.game));
    if (util.isGameRunning(target.processes)) throw new Error("The game is already running.");
    const child = spawn("bash", [info.launcher], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, launcher: info.launcher };
  }

  async function art(packId, key) {
    const cacheKey = `${packId}:${key}`;
    if (artCache.has(cacheKey)) return artCache.get(cacheKey);
    const pr = packRoot(packId);
    const localPackFile = versionStore.packFile(pr);
    if (fs.existsSync(localPackFile)) {
      try {
        const pack = util.readJson(localPackFile);
        if (pack.art && pack.art[key]) {
          const file = path.join(pr, pack.art[key]);
          if (fs.existsSync(file)) {
            const buf = fs.readFileSync(file);
            artCache.set(cacheKey, buf);
            return buf;
          }
        }
      } catch { }
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
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, name: "modsync-agent", version: "0.1.0" }));
      }
      if (url.pathname === "/api/state") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(await state()));
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
        const body = await readBody(req);
        if (body.scope !== "logs" && body.packId) {
          try {
            const pack = util.readJson(versionStore.packFile(versionStore.packRoot(root, body.packId)));
            const target = paths.resolve(pack, steam.findGame(pack.game));
            if (util.isGameRunning(target.processes)) {
              res.writeHead(409, { "content-type": "application/json" });
              return res.end(JSON.stringify({ error: "Close the game before removing installed files." }));
            }
          } catch { }
        }
        const out = storage.clearStorage(root, body);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, ...out, storage: storage.computeStorage(root) }));
      }
      if (url.pathname === "/api/preconditions/confirm" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.packId || !body.checkId) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "packId and checkId required" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(setConfirmation(body.packId, body.checkId, body.confirmed !== false)));
      }
      if (url.pathname === "/api/install" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.packId) { res.writeHead(400); return res.end(JSON.stringify({ error: "packId required" })); }
        const job = startInstallJob(body.packId);
        res.writeHead(202, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jobId: job.id }));
      }
      if (url.pathname === "/api/launch" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.packId) { res.writeHead(400); return res.end(JSON.stringify({ error: "packId required" })); }
        const out = await launchPack(body.packId);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(out));
      }
      if (url.pathname === "/api/rollback" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.packId) { res.writeHead(400); return res.end(JSON.stringify({ error: "packId required" })); }
        const pack = localPack(body.packId);
        if (!pack) throw new Error("Pack is not installed on this TV.");
        const out = installer.rollback({ pack, root, log: () => { } });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(out));
      }

      let file = path.join(webDir, url.pathname === "/" ? "index.html" : url.pathname);
      if (!path.resolve(file).startsWith(path.resolve(webDir))) { res.writeHead(403); return res.end("forbidden"); }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": contentType(file) });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return {
    server,
    listen: (cb) => server.listen(port, "127.0.0.1", cb),
    state,
    startInstallJob,
    config: { root, port, pcUrl },
  };
}

module.exports = { createAgent };
