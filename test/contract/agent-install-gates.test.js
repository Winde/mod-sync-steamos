"use strict";

/**
 * Acceptance: the user-visible install gates survive a refactor of where they
 * are implemented. A mismatched build, a running game, a missing Proton
 * prefix, or a secondary process name must block the install before the TV
 * pack directory is created.
 *
 * The packs declare these checks as preconditions, so moving the policy out of
 * the installer and into `preconditions.js` must not change the outcome.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
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
const GAME_PROCESS = "modsync-test-not-running.exe";

let fixture;

before(async () => {
  fixture = await buildPackSet({ versions: ["0.2.7"] });
});

after(() => {
  if (fixture) fixture.cleanup();
});

async function startScenario(t, { steam, packRoot }) {
  const source = packRoot || fixture.packs["0.2.7"].packRoot;
  const pack = readJson(path.join(source, "pack.json"));
  const packsDir = tempDir("modsync-gates-repo-");
  fs.cpSync(source, path.join(packsDir, pack.id), { recursive: true });

  const repo = await startRepository({ packsDir, token: "gates-token" });
  const tv = tempDir("modsync-gates-tv-");
  const agent = await startAgent({
    pcUrl: repo.base,
    token: repo.token,
    root: tv,
    env: steam.env,
  });

  t.after(async () => {
    await agent.stop();
    await repo.stop();
    remove(packsDir);
    remove(tv);
    remove(steam.base);
  });

  return { agent, tv };
}

async function expectBlocked(t, { steam, packRoot, checkId, errorPattern }) {
  const { agent, tv } = await startScenario(t, { steam, packRoot });

  const state = await request(agent.base, "/api/state");
  assert.equal(state.status, 200);
  const pack = state.json.packs.find((entry) => entry.id === PACK_ID);
  assert.ok(pack, "state contains the pack");
  assert.equal(pack.blocked, true, "the dashboard blocks the pack");

  const check = pack.preconditions.checks.find(
    (entry) => entry.id === checkId || entry.type === checkId,
  );
  assert.ok(check, `state reports precondition ${checkId}`);
  assert.equal(check.blocked, true, `precondition ${checkId} blocks`);

  const started = await request(agent.base, "/api/install", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(started.status, 202);
  await assert.rejects(
    pollJob(agent.base, started.json.jobId),
    errorPattern,
    "the install job reports the gate",
  );

  assert.equal(
    fs.existsSync(path.join(tv, "packs", PACK_ID)),
    false,
    "a blocked install creates no TV pack directory",
  );
}

test("a mismatched game build blocks install", { timeout: 90000 }, async (t) => {
  const steam = makeSteamEnv({ build: "1" });
  await expectBlocked(t, {
    steam,
    checkId: "game-build",
    errorPattern: /build/i,
  });
});

test("a running game blocks install", { timeout: 90000 }, async (t) => {
  const steam = makeSteamEnv();
  const copy = tempDir("modsync-gates-running-");
  fs.cpSync(fixture.packs["0.2.7"].packRoot, copy, { recursive: true });
  t.after(() => remove(copy));
  setLaunchGameProcess(copy, process.platform === "win32" ? "node.exe" : "node");

  await expectBlocked(t, {
    steam,
    packRoot: copy,
    checkId: "game-not-running",
    errorPattern: /running|closed/i,
  });
});

test("the secondary game process also blocks install", { timeout: 90000 }, async (t) => {
  const steam = makeSteamEnv();
  const copy = tempDir("modsync-gates-alt-");
  fs.cpSync(fixture.packs["0.2.7"].packRoot, copy, { recursive: true });
  t.after(() => remove(copy));

  const file = path.join(copy, "pack.json");
  const pack = readJson(file);
  pack.launch.gameProcess = GAME_PROCESS;
  pack.launch.gameProcessAlt = process.platform === "win32" ? "node.exe" : "node";
  for (const profile of Object.values(pack.platforms || {})) {
    profile.gameProcess = GAME_PROCESS;
    profile.gameProcessAlt = process.platform === "win32" ? "node.exe" : "node";
  }
  fs.writeFileSync(file, JSON.stringify(pack, null, 2) + "\n");

  await expectBlocked(t, {
    steam,
    packRoot: copy,
    checkId: "game-not-running",
    errorPattern: /running|closed/i,
  });
});

test("a missing Proton prefix blocks install", {
  skip: process.platform === "win32" ? "Proton is Linux-only" : false,
  timeout: 90000,
}, async (t) => {
  const steam = makeSteamEnv();
  remove(path.join(steam.steamRoot, "steamapps", "compatdata", "1245620"));

  await expectBlocked(t, {
    steam,
    checkId: "proton-prefix",
    errorPattern: /prefix/i,
  });
});
