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
  for (const name of ["me3.exe", "me3-launcher.exe", "me3_mod_host.dll"]) {
    write(root, `tools/me3-linux/bin/win64/${name}`, `fake me3 windows ${name}\n`);
    write(root, `tools/me3-win/bin/${name}`, `fake me3 windows ${name}\n`);
  }
  return root;
}

function bg3ModSettings(version = "") {
  return `<!-- modsync-${version} -->
<save><version major="4" minor="8"/><region id="ModuleSettings"><node id="root"><children>
  <node id="Mods"><children>
    <node id="ModuleShortDesc">
      <attribute id="Folder" type="LSString" value="TestMod_uuid"/>
      <attribute id="MD5" type="LSString" value="d41d8cd98f00b204e9800998ecf8427e"/>
      <attribute id="Name" type="LSString" value="Test Mod"/>
      <attribute id="PublishHandle" type="uint64" value="1"/>
      <attribute id="UUID" type="guid" value="11111111-1111-1111-1111-111111111111"/>
      <attribute id="Version64" type="int64" value="36028797018963968"/>
    </node>
  </children></node>
</children></node></region></save>`;
}

/** Create a working BG3 data directory shaped like the pack builder expects. */
function bg3WorkingInstall({ version = "1.0.0", extras = true } = {}) {
  const root = tempDir("modsync-bg3-source-");
  write(root, "Mods/TestMod_uuid.pak", `pak-${version}`);
  if (extras) write(root, "Mods/Extra.pak", `extra-${version}`);
  write(root, "PlayerProfiles/Public/modsettings.lsx", bg3ModSettings(version));
  write(root, "Script Extender/Test/Config.json", `config-${version}`);
  return root;
}

/** Create a fake cached BG3LE release; no network access. */
function bg3leRuntime(version = "0.4.6") {
  const root = tempDir("modsync-bg3le-");
  write(root, "build/libbg3le.so", `bg3le-${version}`);
  write(root, "install.py", "# installer\n");
  write(root, "installer/bg3le-launch", "#!/bin/sh\n");
  write(root, "client/bg3lua", "#!/bin/sh\n");
  return root;
}

async function buildBg3Pack({ source, out, version, gameRoot, bg3le }) {
  return runCli([
    "pack",
    "--recipe", "bg3-modded",
    "--source", source,
    "--out", out,
    "--version", version,
    "--game-root", gameRoot,
  ], { env: { ...process.env, BG3LE_DIR: bg3le } });
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

function runScript(script, args = [], { env = process.env, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
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
      reject(new Error(`script timed out: ${script} ${args.join(" ")}\n${stdout}\n${stderr}`));
    }, timeout);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`script failed (${code}): ${script} ${args.join(" ")}\n${stdout}\n${stderr}`));
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

const STEAM_FIXTURES = {
  eldenring: {
    appId: 1245620,
    installDir: "ELDEN RING",
    build: "25827938",
    exe: "Game/eldenring.exe",
  },
  bg3: {
    appId: 1086940,
    installDir: "Baldurs Gate 3",
    build: "25605617",
    exe: "bin/bg3.exe",
    linuxExe: "bin/bg3",
  },
};

/**
 * Build an environment whose Steam library contains a fake game install.
 * Pass the returned env to the agent child process.
 *
 * `game` selects the fake app; `native` selects the native Linux fixture for
 * games that expose a Linux executable (currently BG3).
 */
function makeSteamEnv({ game = "eldenring", build, layout = "standard", native = false } = {}) {
  const spec = STEAM_FIXTURES[game];
  if (!spec) throw new Error(`unknown Steam fixture game: ${game}`);
  const appBuild = build || spec.build;
  const base = tempDir(`modsync-steam-${game}-`);
  const env = { ...process.env };
  let home;
  let steamRoot;

  if (process.platform === "win32") {
    const programFiles = path.join(base, "ProgramFiles");
    env["ProgramFiles(x86)"] = programFiles;
    env.ProgramFiles = programFiles;
    steamRoot = path.join(programFiles, "Steam");
    home = path.join(base, "home");
    env.LOCALAPPDATA = path.join(home, "AppData", "Local");
    env.APPDATA = path.join(home, "AppData", "Roaming");
  } else {
    home = path.join(base, "home");
    env.HOME = home;
    env.XDG_DATA_HOME = path.join(home, ".local", "share");
    env.LOCALAPPDATA = path.join(home, "AppData", "Local");
    env.APPDATA = path.join(home, "AppData", "Roaming");
    if (layout === "flatpak") {
      steamRoot = path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam");
    } else {
      steamRoot = path.join(home, ".local", "share", "Steam");
    }
  }

  const steamapps = path.join(steamRoot, "steamapps");
  const gameRoot = path.join(steamapps, "common", spec.installDir);
  const useNative = process.platform !== "win32" && native && spec.linuxExe;
  fs.mkdirSync(path.dirname(path.join(gameRoot, spec.exe)), { recursive: true });
  if (useNative) {
    fs.writeFileSync(path.join(gameRoot, spec.linuxExe), "");
  } else {
    fs.writeFileSync(path.join(gameRoot, spec.exe), "");
  }
  fs.mkdirSync(path.join(steamRoot, "userdata", "12345678", "config"), { recursive: true });

  if (process.platform !== "win32" && !useNative) {
    fs.mkdirSync(path.join(steamapps, "compatdata", String(spec.appId), "pfx"), { recursive: true });
  }

  fs.writeFileSync(
    path.join(steamapps, `appmanifest_${spec.appId}.acf`),
    `"AppState"
{
\t"appid"\t\t"${spec.appId}"
\t"buildid"\t\t"${appBuild}"
\t"InstalledDepots"
\t{
\t\t"${spec.appId + 1}"
\t\t{
\t\t}
\t}
}
`,
  );
  fs.mkdirSync(home, { recursive: true });
  return { base, env, home, steamRoot, gameRoot, appId: spec.appId, native: useNative };
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
  for (const profile of Object.values(pack.platforms || {})) profile.gameProcess = processName;
  fs.writeFileSync(file, JSON.stringify(pack, null, 2) + "\n");
  return pack;
}

module.exports = {
  PNG,
  activatePack,
  bg3WorkingInstall,
  bg3leRuntime,
  buildBg3Pack,
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
  runScript,
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
