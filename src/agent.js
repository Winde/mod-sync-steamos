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
    log: (job.log || []).slice(-60),
  };
}

function createAgent(config) {
  const root = config.root || path.join(os.homedir(), "ModSync");
  const port = Number(config.port || 8788);
  const pcUrl = String(config.pcUrl || "").replace(/\/+$/, "");
  const token = config.token || "";
  const webDir = path.join(__dirname, "..", "web");
  const jobs = new Map();
  let activeJob = null;
  let lastJob = null;
  let remoteCache = { at: 0, packs: [], error: null };
  const artCache = new Map();

  const packRoot = (id) => path.join(root, "packs", id);

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
    const versionsDir = path.join(pr, "mods", pack.mod.id, "versions");
    const current = util.readText(path.join(pr, "mods", pack.mod.id, "current.txt")).trim();
    const versions = fs.existsSync(versionsDir)
      ? fs.readdirSync(versionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((n) => !n.startsWith(".") && !n.includes(".bak-"))
        .sort(installer.compareVersions)
      : [];
    const launcher = path.join(pr, "launchers", `launch-${pack.mod.id}.sh`);
    const desktop = path.join(os.homedir(), ".local", "share", "applications", `${pack.mod.id}.desktop`);
    return {
      installed: !!current,
      installedVersion: current || null,
      versions,
      status: !current ? "not-installed" : (current === pack.mod.version ? "up-to-date" : "update-available"),
      packRoot: pr,
      launcher: fs.existsSync(launcher) ? launcher : null,
      desktopFile: fs.existsSync(desktop) ? desktop : null,
      artUrl: `/api/art/${encodeURIComponent(pack.id)}/grid`,
    };
  }

  async function gameState(pack) {
    if (!pack) return null;
    const g = steam.findGame(pack.game);
    return {
      title: pack.game.title,
      expectedBuild: pack.game.build || null,
      path: g ? g.root : null,
      build: g ? g.build : null,
      prefixReady: g ? g.prefixReady : null,
      running: util.isGameRunning(pack.launch && pack.launch.gameProcess),
      ok: !!g
        && (!pack.game.build || g.build === String(pack.game.build))
        && (process.platform === "win32" || !pack.game.prefix || g.prefixReady),
    };
  }

  async function state() {
    const remote = await fetchRemote();
    const packs = (remote.packs || []).map((p) => ({ ...p, ...localInfo(p) }));
    const first = (remote.packs || [])[0];
    return {
      agent: { version: "0.1.0", root, port },
      pc: { url: pcUrl, online: !remote.error && !!pcUrl, error: remote.error || null },
      game: await gameState(first),
      packs,
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
        progress: (p) => Object.assign(job, p),
        log,
      });
      job.status = "done";
      job.phase = "done";
      log("Install complete.");
    })().catch((err) => {
      job.status = "error";
      job.phase = "error";
      job.error = err.message;
      log(`ERROR: ${err.message}`);
    }).finally(() => {
      activeJob = null;
    });
    return job;
  }

  async function launchPack(packId) {
    const { pack } = await getPack(packId);
    const info = localInfo(pack);
    if (!info.installed) throw new Error("Pack is not installed.");
    if (!info.launcher) throw new Error("Launcher is missing. Reinstall the pack.");
    if (util.isGameRunning(pack.launch.gameProcess)) throw new Error("The game is already running.");
    const child = spawn("bash", [info.launcher], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, launcher: info.launcher };
  }

  async function art(packId, key) {
    const cacheKey = `${packId}:${key}`;
    if (artCache.has(cacheKey)) return artCache.get(cacheKey);
    const pr = packRoot(packId);
    const localPack = path.join(pr, "pack.json");
    if (fs.existsSync(localPack)) {
      try {
        const pack = util.readJson(localPack);
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
      if (url.pathname.startsWith("/api/jobs/")) {
        const id = url.pathname.split("/")[3];
        const job = jobs.get(id);
        if (!job) { res.writeHead(404); return res.end("{}"); }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(jobSummary(job)));
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
        const { pack } = await getPack(body.packId);
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
