"use strict";

/**
 * Contract: `/api/storage` reports ModSync usage and `/api/storage/clear`
 * frees only the requested scope. Tested through HTTP and filesystem
 * outcomes, never through `src/storage.js`.
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

  packsDir = tempDir("modsync-storage-repo-");
  activatePack(packsDir, fixture.packs["0.2.5"]);
  repo = await startRepository({ packsDir, token: "storage-token" });
  steam = makeSteamEnv();
  tv = tempDir("modsync-tv-storage-");
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

async function install() {
  const started = await request(agent.base, "/api/install", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(started.status, 202);
  const job = await pollJob(agent.base, started.json.jobId);
  assert.equal(job.status, "done");
}

async function storage() {
  const res = await request(agent.base, "/api/storage");
  assert.equal(res.status, 200);
  return res.json;
}

function clear(body) {
  return request(agent.base, "/api/storage/clear", { method: "POST", body });
}

test("storage reports and clears staging, old versions, logs, and packs", { timeout: 90000 }, async () => {
  await install();
  activatePack(packsDir, fixture.packs["0.2.7"]);
  await install();

  const packRoot = path.join(tv, "packs", PACK_ID);
  const versionsDir = path.join(packRoot, "mods", MOD_ID, "versions");

  const staging = path.join(versionsDir, ".staging-0.2.7");
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, "partial.bin"), Buffer.alloc(4096, 7));

  const backup = path.join(versionsDir, "0.2.7.bak-20260101-000000");
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, "old.bin"), Buffer.alloc(1024, 9));

  fs.mkdirSync(path.join(tv, "logs"), { recursive: true });
  fs.writeFileSync(path.join(tv, "logs", "keep.log"), "x".repeat(100));

  const save = path.join(steam.steamRoot, "steamapps", "common", "ELDEN RING", "Game", "ER0000.sl2");
  fs.writeFileSync(save, "save");
  const outside = path.join(tv, "keep.txt");
  fs.writeFileSync(outside, "keep");

  let s = await storage();
  assert.ok(Number.isFinite(s.freeBytes));
  assert.ok(s.rootBytes >= s.packsBytes);
  assert.ok(s.logsBytes > 0);
  assert.equal(s.packs.length, 1);

  let pack = s.packs[0];
  assert.equal(pack.id, PACK_ID);
  assert.equal(pack.currentVersion, "0.2.7");
  assert.equal(pack.installed, true);
  assert.equal(pack.versions.length, 2);
  assert.ok(pack.versions.some((v) => v.version === "0.2.7" && v.current));
  assert.ok(pack.versions.some((v) => v.version === "0.2.5" && !v.current));
  assert.ok(pack.stagingBytes >= 4096);
  assert.ok(pack.backupBytes >= 1024);
  assert.ok(pack.oldBytes > 0);
  assert.ok(pack.otherBytes > 0);
  assert.ok(pack.totalBytes >= pack.versionsBytes + pack.stagingBytes + pack.backupBytes);

  let out = await clear({ packId: PACK_ID, scope: "staging" });
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  assert.ok(out.json.freedBytes > 0);
  assert.equal(out.json.storage.packs[0].stagingBytes, 0);
  assert.ok(fs.existsSync(path.join(versionsDir, "0.2.5")));
  assert.ok(fs.existsSync(path.join(versionsDir, "0.2.7")));

  out = await clear({ packId: PACK_ID, scope: "old-versions" });
  assert.equal(out.status, 200);
  assert.ok(out.json.freedBytes > 0);
  assert.equal(fs.existsSync(path.join(versionsDir, "0.2.5")), false);
  assert.equal(fs.existsSync(backup), false);
  assert.ok(fs.existsSync(path.join(versionsDir, "0.2.7")));
  assert.equal(fs.existsSync(path.join(packRoot, "profiles", "graceborne-0.2.5.me3")), false);
  assert.ok(fs.existsSync(path.join(packRoot, "profiles", "graceborne-0.2.7.me3")));

  s = await storage();
  assert.equal(s.packs[0].versions.length, 1);
  assert.equal(s.packs[0].oldBytes, 0);

  out = await clear({ scope: "logs" });
  assert.equal(out.status, 200);
  assert.equal(out.json.storage.logsBytes, 0);
  assert.ok(fs.existsSync(packRoot));

  out = await clear({ packId: PACK_ID, scope: "nope" });
  assert.equal(out.status, 500);
  assert.ok(out.json.error);

  out = await clear({ packId: "../x", scope: "pack" });
  assert.equal(out.status, 500);
  assert.ok(out.json.error);

  out = await clear({ packId: PACK_ID, scope: "pack" });
  assert.equal(out.status, 200);
  assert.ok(out.json.freedBytes > 0);
  assert.equal(fs.existsSync(packRoot), false);
  assert.ok(fs.existsSync(save), "the game/save tree is untouched");
  assert.ok(fs.existsSync(outside), "files outside the pack root are untouched");
  if (process.platform === "linux") {
    assert.equal(
      fs.existsSync(path.join(steam.home, ".local", "share", "applications", `${MOD_ID}.desktop`)),
      false,
      "the pack desktop shortcut is removed",
    );
  }
  s = await storage();
  assert.equal(s.packs.length, 0);
});

test("storage clear refuses while the game is running", { timeout: 60000 }, async (t) => {
  const root = tempDir("modsync-tv-storage-guard-");
  const guardAgent = await startAgent({
    pcUrl: repo.base,
    token: repo.token,
    root,
    env: steam.env,
  });
  t.after(async () => {
    await guardAgent.stop();
    remove(root);
  });

  const started = await request(guardAgent.base, "/api/install", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(started.status, 202);
  await pollJob(guardAgent.base, started.json.jobId);

  setLaunchGameProcess(path.join(root, "packs", PACK_ID), process.platform === "win32" ? "node.exe" : "node");

  const out = await request(guardAgent.base, "/api/storage/clear", {
    method: "POST",
    body: { packId: PACK_ID, scope: "pack" },
  });
  assert.equal(out.status, 409);
  assert.ok(out.json.error, "the running game blocks removal");
  assert.ok(fs.existsSync(path.join(root, "packs", PACK_ID)));
});

test("storage clear refuses while an install job is running", { timeout: 120000 }, async (t) => {
  const set = await buildPackSet({ versions: ["0.2.7"], payloadBytes: 32 * 1024 * 1024 });
  const bigPacks = tempDir("modsync-storage-big-repo-");
  activatePack(bigPacks, set.packs["0.2.7"]);
  setLaunchGameProcess(path.join(bigPacks, PACK_ID), GAME_PROCESS);
  const bigRepo = await startRepository({ packsDir: bigPacks, token: "storage-big-token" });
  const bigSteam = makeSteamEnv();
  const bigTv = tempDir("modsync-tv-storage-big-");
  const bigAgent = await startAgent({
    pcUrl: bigRepo.base,
    token: bigRepo.token,
    root: bigTv,
    env: bigSteam.env,
  });

  t.after(async () => {
    await bigAgent.stop();
    await bigRepo.stop();
    set.cleanup();
    remove(bigPacks);
    remove(bigTv);
    remove(bigSteam.base);
  });

  const started = await request(bigAgent.base, "/api/install", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(started.status, 202);

  const blocked = await request(bigAgent.base, "/api/storage/clear", {
    method: "POST",
    body: { packId: PACK_ID, scope: "staging" },
  });
  assert.equal(blocked.status, 409);
  assert.ok(blocked.json.error, "a running install blocks storage clearing");

  const job = await pollJob(bigAgent.base, started.json.jobId);
  assert.equal(job.status, "done");
});
