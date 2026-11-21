"use strict";

/**
 * Contract: the TV agent exposes state, install, job, and launch endpoints.
 * The tests assert HTTP responses and the resulting files on disk, never
 * importing `src/agent.js` or `src/installer.js`.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  activatePack,
  buildPackSet,
  makeSteamEnv,
  pollJob,
  readJson,
  remove,
  request,
  setLaunchGameProcess,
  sha256File,
  startAgent,
  startRepository,
  tempDir,
  walk,
} = require("../../test-support/harness");

const PACK_ID = "eldenring-graceborne";
const MOD_ID = "graceborne";
const VERSION = "0.2.7";
const GAME_PROCESS = "modsync-test-not-running.exe";
const PLATFORM = process.platform === "win32" ? "windows" : "linux-proton";

function selectedFiles() {
  return filesDoc.files.filter((file) => !file.platforms || file.platforms.includes(PLATFORM));
}

let fixture;
let built;
let filesDoc;
let packsDir;
let repo;
let steam;

before(async () => {
  fixture = await buildPackSet({ versions: [VERSION] });
  built = fixture.packs[VERSION];
  filesDoc = built.files;
  setLaunchGameProcess(built.packRoot, GAME_PROCESS);
  packsDir = tempDir("modsync-agent-repo-");
  activatePack(packsDir, built);
  repo = await startRepository({ packsDir, token: "agent-contract-token" });
  steam = makeSteamEnv();
});

after(async () => {
  if (repo) await repo.stop();
  if (fixture) fixture.cleanup();
  remove(packsDir);
  remove(steam?.base);
});

async function startTv(t, prefix = "modsync-tv-", options = {}) {
  const root = tempDir(prefix);
  const agent = await startAgent({
    pcUrl: repo.base,
    token: repo.token,
    root,
    env: steam.env,
    ...options,
  });
  t.after(async () => {
    await agent.stop();
    remove(root);
  });
  return { root, agent };
}

async function install(agent) {
  const started = await request(agent.base, "/api/install", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(started.status, 202);
  assert.ok(started.json.jobId, "install returns a job id");
  const job = await pollJob(agent.base, started.json.jobId);
  assert.equal(job.status, "done");
  return job;
}

test("state reports the pack, game, and passing preconditions", { timeout: 60000 }, async (t) => {
  const { agent } = await startTv(t);

  const res = await request(agent.base, "/api/state");
  assert.equal(res.status, 200);
  const state = res.json;

  assert.equal(state.pc.online, true);
  assert.equal(state.pc.url, repo.base);
  assert.ok(Number.isFinite(state.diskFreeBytes));

  const pack = state.packs.find((p) => p.id === PACK_ID);
  assert.ok(pack, "state contains the pack");
  assert.equal(pack.installed, false);
  assert.equal(pack.status, "not-installed");
  assert.equal(pack.blocked, false);
  assert.equal(pack.local, false);
  assert.equal(pack.canRollback, false);
  assert.deepEqual(pack.versions, []);

  const checks = Object.fromEntries(pack.preconditions.checks.map((check) => [check.type, check]));
  for (const type of ["game-installed", "game-build", "game-not-running", "disk-free"]) {
    assert.equal(checks[type].status, "pass", `precondition ${type} passes`);
    assert.equal(checks[type].blocked, false);
  }
  assert.equal(checks["proton-prefix"].status, "pass");
  assert.equal(state.game.title, "ELDEN RING");
  assert.equal(state.game.running, false);
});

test("install writes the complete TV contract", { timeout: 60000 }, async (t) => {
  const { root, agent } = await startTv(t);

  const job = await install(agent);
  assert.equal(job.type, "install");
  assert.equal(job.packId, PACK_ID);
  assert.equal(job.done, selectedFiles().length);
  assert.equal(job.total, selectedFiles().length);
  assert.ok(job.bytesDone > 0);
  assert.ok(job.bytesTotal > 0);

  const packRoot = path.join(root, "packs", PACK_ID);
  for (const file of selectedFiles()) {
    const target = path.join(packRoot, file.target);
    assert.ok(fs.existsSync(target), `installed: ${file.target}`);
    assert.equal(fs.statSync(target).size, file.size, `size: ${file.target}`);
    assert.equal(sha256File(target), file.sha256, `sha256: ${file.target}`);
    if (process.platform !== "win32" && file.mode) {
      assert.equal((fs.statSync(target).mode & 0o777).toString(8), file.mode, `mode: ${file.target}`);
    }
  }

  const currentPath = path.join(packRoot, "mods", MOD_ID, "current.txt");
  assert.equal(fs.readFileSync(currentPath, "utf8").trim(), VERSION);

  const versionDir = path.join(packRoot, "mods", MOD_ID, "versions", VERSION);
  assert.ok(fs.existsSync(versionDir));
  assert.ok(fs.existsSync(path.join(packRoot, "pack.json")));
  assert.ok(fs.existsSync(path.join(packRoot, "files.json")));

  const launcher = path.join(packRoot, "launchers", `launch-${MOD_ID}.sh`);
  assert.ok(fs.existsSync(launcher));
  const launcherText = fs.readFileSync(launcher, "utf8");
  assert.ok(launcherText.includes("--online false"));
  assert.ok(launcherText.includes("ER0000.graceborne.sl2"));

  assert.deepEqual(walk(packRoot).filter((file) => file.endsWith(".part")), []);

  if (process.platform === "linux") {
    assert.ok(fs.existsSync(path.join(steam.home, ".local", "share", "applications", `${MOD_ID}.desktop`)));
    assert.ok(fs.existsSync(path.join(steam.home, "Desktop", `${MOD_ID}.desktop`)));

    const configDir = path.join(steam.steamRoot, "userdata", "12345678", "config");
    assert.ok(fs.existsSync(path.join(configDir, "shortcuts.vdf")), "Steam shortcut is written");
    const gridArt = fs.readdirSync(path.join(configDir, "grid"));
    assert.ok(gridArt.length >= 3, "Steam art is copied");
  }

  const afterState = await request(agent.base, "/api/state");
  const pack = afterState.json.packs.find((p) => p.id === PACK_ID);
  assert.equal(pack.installed, true);
  assert.equal(pack.installedVersion, VERSION);
  assert.equal(pack.status, "up-to-date");
  assert.equal(pack.local, true);
  assert.equal(pack.canRollback, false);
  assert.deepEqual(pack.versions, [VERSION]);
  assert.ok(pack.launcher, "state reports the launcher");
});

test("install resumes a partially downloaded staging file", { timeout: 60000 }, async (t) => {
  const { root, agent } = await startTv(t, "modsync-tv-resume-");

  const sample = selectedFiles().find(
    (file) => file.target.startsWith(`mods/${MOD_ID}/versions/${VERSION}/`) && file.size > 8,
  );
  assert.ok(sample, "fixture has a payload file to resume");

  const sourceBytes = fs.readFileSync(path.join(built.packRoot, sample.source));
  const half = Math.floor(sourceBytes.length / 2);
  const payloadPrefix = `mods/${MOD_ID}/versions/${VERSION}/`;
  const stagingDir = path.join(
    root,
    "packs",
    PACK_ID,
    "mods",
    MOD_ID,
    "versions",
    `.staging-${VERSION}`,
  );
  const partFile = path.join(stagingDir, sample.target.slice(payloadPrefix.length)) + ".part";
  fs.mkdirSync(path.dirname(partFile), { recursive: true });
  fs.writeFileSync(partFile, sourceBytes.subarray(0, half));

  // A second payload file is already complete; it should be verified and
  // counted, not downloaded again.
  const complete = selectedFiles().find(
    (file) => file.target.startsWith(payloadPrefix) && file.source !== sample.source && file.size > 0,
  );
  assert.ok(complete, "fixture has a second payload file");
  const completeTarget = path.join(stagingDir, complete.target.slice(payloadPrefix.length));
  fs.mkdirSync(path.dirname(completeTarget), { recursive: true });
  fs.copyFileSync(path.join(built.packRoot, complete.source), completeTarget);

  const job = await install(agent);
  const totalBytes = selectedFiles().reduce((n, file) => n + file.size, 0);
  assert.equal(job.bytesTotal, totalBytes);
  assert.equal(job.bytesDone, totalBytes);
  assert.match((job.log || []).join("\n"), /Resume: .*already on disk/);

  const target = path.join(root, "packs", PACK_ID, ...sample.target.split("/"));
  assert.deepEqual(fs.readFileSync(target), sourceBytes);
  assert.equal(sha256File(target), sample.sha256);
  assert.deepEqual(walk(path.join(root, "packs", PACK_ID)).filter((file) => file.endsWith(".part")), []);
});

test("launch refuses before the pack is installed", { timeout: 60000 }, async (t) => {
  const { agent } = await startTv(t);

  const res = await request(agent.base, "/api/launch", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(res.status, 500);
  assert.ok(res.json.error, "launch returns an error");
});

test("launch starts the generated launcher", {
  timeout: 60000,
  skip: process.platform !== "linux",
}, async (t) => {
  const { agent } = await startTv(t);
  await install(agent);

  const res = await request(agent.base, "/api/launch", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.launcher.endsWith(`launch-${MOD_ID}.sh`));
});

test("agent config tolerates a UTF-8 BOM", { timeout: 60000 }, async (t) => {
  const { agent } = await startTv(t, "modsync-tv-bom-", { bom: true });

  const res = await request(agent.base, "/api/state");
  assert.equal(res.status, 200);
  assert.equal(res.json.pc.online, true);
  assert.ok(res.json.packs.some((pack) => pack.id === PACK_ID));
});

test("the agent serves the dashboard assets", { timeout: 60000 }, async (t) => {
  const { agent } = await startTv(t);

  const index = await request(agent.base, "/");
  assert.equal(index.status, 200);
  assert.match(index.text, /MODSYNC/);
  assert.match(index.text, /\/app\.js/);

  const script = await request(agent.base, "/app.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);

  const style = await request(agent.base, "/style.css");
  assert.equal(style.status, 200);
  assert.match(style.headers.get("content-type"), /text\/css/);

  const icon = await request(agent.base, "/icon.png");
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/png");

  for (const name of ["modsync-header.png", "modsync-portrait.png"]) {
    const art = await request(agent.base, `/${name}`);
    assert.equal(art.status, 200, `${name} is served`);
    assert.equal(art.headers.get("content-type"), "image/png");
  }
});
