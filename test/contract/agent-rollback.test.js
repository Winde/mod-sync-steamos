"use strict";

/**
 * Contract: install two versions, keep both on disk, then roll back by moving
 * the `current.txt` pointer. Uses only the agent HTTP API and filesystem
 * outcomes; the version-store implementation can change.
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
  remove,
  request,
  setLaunchGameProcess,
  startAgent,
  startRepository,
  tempDir,
} = require("../../test-support/harness");

const PACK_ID = "eldenring-graceborne";
const MOD_ID = "graceborne";
const GAME_PROCESS = "modsync-test-not-running.exe";

let fixture;
let packsDir;
let repo;
let steam;
let tv;
let agent;

before(async () => {
  fixture = await buildPackSet({ versions: ["0.2.5", "0.2.7"] });
  for (const version of ["0.2.5", "0.2.7"]) {
    setLaunchGameProcess(fixture.packs[version].packRoot, GAME_PROCESS);
  }

  packsDir = tempDir("modsync-rollback-repo-");
  activatePack(packsDir, fixture.packs["0.2.5"]);
  repo = await startRepository({ packsDir, token: "rollback-token" });
  steam = makeSteamEnv();
  tv = tempDir("modsync-tv-rollback-");
  agent = await startAgent({
    pcUrl: repo.base,
    token: repo.token,
    root: tv,
    env: steam.env,
  });
});

after(async () => {
  if (agent) await agent.stop();
  if (repo) await repo.stop();
  if (fixture) fixture.cleanup();
  remove(packsDir);
  remove(tv);
  remove(steam?.base);
});

async function installCurrent() {
  const started = await request(agent.base, "/api/install", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(started.status, 202);
  const job = await pollJob(agent.base, started.json.jobId);
  assert.equal(job.status, "done");
}

function currentVersion() {
  return fs
    .readFileSync(path.join(tv, "packs", PACK_ID, "mods", MOD_ID, "current.txt"), "utf8")
    .trim();
}

test("rollback moves the pointer and keeps both versions installed", { timeout: 90000 }, async () => {
  await installCurrent();
  assert.equal(currentVersion(), "0.2.5");

  // The server reads the pack directory on each request, so swapping it is
  // equivalent to publishing a new pack version on the PC.
  activatePack(packsDir, fixture.packs["0.2.7"]);
  await installCurrent();
  assert.equal(currentVersion(), "0.2.7");

  const versionsDir = path.join(tv, "packs", PACK_ID, "mods", MOD_ID, "versions");
  assert.ok(fs.existsSync(path.join(versionsDir, "0.2.5")));
  assert.ok(fs.existsSync(path.join(versionsDir, "0.2.7")));

  const oldPayload = fs.readFileSync(path.join(versionsDir, "0.2.5", "mod", "regulation.bin"), "utf8");
  const newPayload = fs.readFileSync(path.join(versionsDir, "0.2.7", "mod", "regulation.bin"), "utf8");
  assert.match(oldPayload, /0\.2\.5/);
  assert.match(newPayload, /0\.2\.7/);

  const rolled = await request(agent.base, "/api/rollback", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(rolled.status, 200);
  assert.equal(rolled.json.previous, "0.2.5");
  assert.equal(rolled.json.current, "0.2.7");
  assert.equal(currentVersion(), "0.2.5");

  const state = await request(agent.base, "/api/state");
  const pack = state.json.packs.find((p) => p.id === PACK_ID);
  assert.equal(pack.installedVersion, "0.2.5");
  assert.deepEqual(pack.versions, ["0.2.5", "0.2.7"]);
  assert.equal(pack.status, "update-available");

  const again = await request(agent.base, "/api/rollback", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(again.status, 500);
  assert.ok(again.json.error, "rollback returns an error");
  assert.equal(currentVersion(), "0.2.5");
});
