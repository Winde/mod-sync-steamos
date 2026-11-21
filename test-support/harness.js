"use strict";

/**
 * Black-box test harness.
 *
 * Contract tests use this module instead of importing `src/` internals. They
 * exercise the CLI, the HTTP APIs, and the resulting files on disk, so modules
 * can be moved or split without rewriting the tests.
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const cli = path.join(repoRoot, "bin", "modsync.js");

// A 1x1 PNG; enough for the art endpoints and pack builder.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

function tempDir(prefix = "modsync-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function remove(dir) {
  if (!dir) return;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function write(root, rel, data, mode) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  if (mode != null) fs.chmodSync(file, mode);
  return file;
}

function writeJson(root, rel, value) {
  return write(root, rel, JSON.stringify(value, null, 2) + "\n");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function prefixBom(file) {
  fs.writeFileSync(file, "\uFEFF" + fs.readFileSync(file, "utf8"));
  return file;
}

function walk(root, base = root, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Create a working install shaped like the one the Elden Ring driver expects:
 * mods/graceborne/versions/<version>, profiles/*.me3, tools/me3-*, art.
 */
function workingInstall({ versions = ["0.2.7"], payloadBytes = 0 } = {}) {
  const root = tempDir("modsync-source-");
  for (const version of versions) {
    write(
      root,
      `mods/graceborne/versions/${version}/mod/regulation.bin`,
      Buffer.from(`regulation-${version}-${"x".repeat(64)}`),
    );
    write(
      root,
      `mods/graceborne/versions/${version}/mod/parts/test.partsbnd.dcx`,
      Buffer.from(`part-${version}-${"y".repeat(32)}`),
    );
    if (payloadBytes > 0) {
      write(
        root,
        `mods/graceborne/versions/${version}/mod/padding.bin`,
        Buffer.alloc(payloadBytes, 7),
      );
    }
    write(root, `profiles/graceborne-${version}.me3`, `profile ${version}\n`);
  }
  write(root, "mods/graceborne/current.txt", `${versions[versions.length - 1]}\n`);
  write(root, "tools/me3-linux/bin/me3", "#!/bin/sh\nexit 0\n", 0o755);
  write(root, "tools/me3-linux/win64/me3.exe", "fake me3 windows\n");
  write(root, "tools/me3-win/bin/me3.exe", "fake me3 windows\n");
  for (const name of ["grid", "hero", "logo", "icon"]) {
    write(root, `art/graceborne/${name}.png`, PNG);
  }
  return root;
}

function runCli(args, { env = process.env, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { }
      reject(new Error(`CLI timed out: ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, timeout);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`CLI failed (${code}): ${args.join(" ")}\n${stdout}\n${stderr}`));
    });
  });
}

async function buildPack({ source, out, version }) {
  const result = await runCli([
    "pack",
    "--recipe", "eldenring-graceborne",
    "--source", source,
    "--out", out,
    "--version", version,
  ]);
  return {
    packRoot: out,
    pack: readJson(path.join(out, "pack.json")),
    files: readJson(path.join(out, "files.json")),
    output: result.stdout,
  };
}

async function buildPackSet({ versions = ["0.2.7"], payloadBytes = 0 } = {}) {
  const source = workingInstall({ versions, payloadBytes });
  const root = tempDir("modsync-builds-");
  const packs = {};
  for (const version of versions) {
    packs[version] = await buildPack({
      source,
      out: path.join(root, `build-${version}`),
      version,
    });
  }
  return {
    source,
    root,
    packs,
    cleanup() {
      remove(source);
      remove(root);
    },
  };
}

/**
 * Build an environment whose Steam library contains a fake ELDEN RING install.
 * Pass the returned env to the agent child process.
 */
function makeSteamEnv({ build = "25827938", layout = "standard" } = {}) {
  const base = tempDir("modsync-steam-");
  const env = { ...process.env };
  let home;
  let steamRoot;

  if (process.platform === "win32") {
    const programFiles = path.join(base, "ProgramFiles");
    env["ProgramFiles(x86)"] = programFiles;
    env.ProgramFiles = programFiles;
    steamRoot = path.join(programFiles, "Steam");
    home = path.join(base, "home");
  } else {
    home = path.join(base, "home");
    env.HOME = home;
    if (layout === "flatpak") {
      steamRoot = path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam");
    } else {
      steamRoot = path.join(home, ".local", "share", "Steam");
    }
  }

  const steamapps = path.join(steamRoot, "steamapps");
  const gameRoot = path.join(steamapps, "common", "ELDEN RING");
  fs.mkdirSync(path.join(gameRoot, "Game"), { recursive: true });
  fs.writeFileSync(path.join(gameRoot, "Game", "eldenring.exe"), "");
  fs.mkdirSync(path.join(steamRoot, "userdata", "12345678", "config"), { recursive: true });

  if (process.platform !== "win32") {
    fs.mkdirSync(path.join(steamapps, "compatdata", "1245620", "pfx"), { recursive: true });
  }

  fs.writeFileSync(
    path.join(steamapps, "appmanifest_1245620.acf"),
    `"AppState"
{
\t"appid"\t\t"1245620"
\t"buildid"\t\t"${build}"
\t"InstalledDepots"
\t{
\t\t"1245621"
\t\t{
\t\t}
\t}
}
`,
  );
  fs.mkdirSync(home, { recursive: true });
  return { base, env, home, steamRoot };
}

function startCliChild(args, { env = process.env } = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = "";
  child.stdout.on("data", (data) => { child.output += data; });
  child.stderr.on("data", (data) => { child.output += data; });
  return child;
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    let timer;
    const done = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { }
      done();
    }, 3000);
    child.once("exit", done);
    child.once("close", done);
    try { child.kill(); } catch { done(); }
  });
}

async function waitForHttp(url, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return res;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`);
}

async function startRepository({ packsDir, token = "test-token", host = "127.0.0.1" } = {}) {
  const port = await freePort();
  const args = [
    "serve",
    "--packs", packsDir,
    "--port", String(port),
    "--token", token,
    "--skip-bootstrap",
  ];
  if (host) args.push("--host", host);
  const child = startCliChild(args);
  const base = `http://${host || "127.0.0.1"}:${port}`;
  try {
    await waitForHttp(`${base}/api/health`);
  } catch (err) {
    await stopChild(child);
    throw new Error(`${err.message}\n--- serve output ---\n${child.output}`);
  }
  return { base, port, token, child, stop: () => stopChild(child) };
}

async function startAgent({ pcUrl, token = "", root, env = process.env, bom = false } = {}) {
  const port = await freePort();
  fs.mkdirSync(root, { recursive: true });
  const config = path.join(root, "agent.json");
  const text = JSON.stringify({ pcUrl, token, root, port }, null, 2) + "\n";
  fs.writeFileSync(config, (bom ? "\uFEFF" : "") + text);
  const child = startCliChild(["agent", "--config", config], { env });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${base}/api/health`);
  } catch (err) {
    await stopChild(child);
    throw new Error(`${err.message}\n--- agent output ---\n${child.output}`);
  }
  return { base, port, root, config, child, stop: () => stopChild(child) };
}

async function request(base, pathname, { method = "GET", token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h["x-modsync-token"] = token;
  let payload;
  if (body !== undefined) {
    if (typeof body === "string" || Buffer.isBuffer(body)) {
      payload = body;
    } else {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
  }
  const res = await fetch(`${base}${pathname}`, { method, headers: h, body: payload });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { }
  return { status: res.status, headers: res.headers, buf, text, json };
}

async function pollJob(base, id, { timeout = 60000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const res = await request(base, `/api/jobs/${encodeURIComponent(id)}`);
    if (res.status !== 200) throw new Error(`job ${id}: HTTP ${res.status} ${res.text}`);
    last = res.json;
    if (last.status === "error") {
      throw new Error(`job ${id} failed: ${last.error}\n${(last.log || []).join("\n")}`);
    }
    if (last.status === "canceled") throw new Error(`job ${id} canceled`);
    if (last.status === "done") return last;
    await sleep(100);
  }
  throw new Error(`job ${id} timed out: ${JSON.stringify(last)}`);
}

/** Copy a built pack into the repository under its pack id. */
function activatePack(packsDir, built) {
  fs.mkdirSync(packsDir, { recursive: true });
  const dest = path.join(packsDir, built.pack.id);
  remove(dest);
  fs.cpSync(built.packRoot, dest, { recursive: true });
  return dest;
}

/** Avoid matching a real running game while keeping the pack otherwise valid. */
function setLaunchGameProcess(packRoot, processName) {
  const file = path.join(packRoot, "pack.json");
  const pack = readJson(file);
  pack.launch.gameProcess = processName;
  fs.writeFileSync(file, JSON.stringify(pack, null, 2) + "\n");
  return pack;
}

module.exports = {
  PNG,
  activatePack,
  buildPack,
  buildPackSet,
  freePort,
  makeSteamEnv,
  pollJob,
  prefixBom,
  readJson,
  remove,
  request,
  runCli,
  setLaunchGameProcess,
  sha256,
  sha256File,
  sleep,
  startAgent,
  startRepository,
  stopChild,
  tempDir,
  walk,
  workingInstall,
  write,
  writeJson,
};
