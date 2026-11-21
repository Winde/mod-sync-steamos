"use strict";

/**
 * TDD for step 1: the installer must not add policy that the pack did not
 * declare. These tests intentionally omit one precondition from a valid pack;
 * the install should then be allowed by the core.
 *
 * They are expected to fail until the hidden build, prefix, running, and
 * hardcoded disk-reserve checks are removed from `src/installer.js`.
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
  startAgent,
  startRepository,
  tempDir,
} = require("../../test-support/harness");

const PACK_ID = "eldenring-graceborne";
const MOD_ID = "graceborne";

let fixture;

before(async () => {
  fixture = await buildPackSet({ versions: ["0.2.7"] });
});

after(() => {
  if (fixture) fixture.cleanup();
});

function copyPackWithoutPrecondition(source, checkIds) {
  const base = tempDir("modsync-policy-pack-");
  const root = path.join(base, "pack");
  fs.cpSync(source, root, { recursive: true });

  const file = path.join(root, "pack.json");
  const pack = readJson(file);
  pack.preconditions = (pack.preconditions || []).filter(
    (check) => !checkIds.includes(check.id) && !checkIds.includes(check.type),
  );
  fs.writeFileSync(file, JSON.stringify(pack, null, 2) + "\n");
  return { base, root };
}

function lowSpaceEnv(steam) {
  const dir = tempDir("modsync-policy-low-space-");
  const file = path.join(dir, "low-space.cjs");
  fs.writeFileSync(
    file,
    'const fs = require("node:fs");\n' +
      "fs.statfsSync = () => ({ bavail: 1, bsize: 1 });\n",
  );
  const preload = `--require "${file.replace(/\\/g, "/")}"`;
  return {
    dir,
    env: {
      ...steam.env,
      NODE_OPTIONS: [steam.env.NODE_OPTIONS, preload].filter(Boolean).join(" "),
    },
  };
}

function setGameProcess(packRoot, processName) {
  const file = path.join(packRoot, "pack.json");
  const pack = readJson(file);
  pack.launch.gameProcess = processName;
  delete pack.launch.gameProcessAlt;
  for (const profile of Object.values(pack.platforms || {})) {
    profile.gameProcess = processName;
    delete profile.gameProcessAlt;
  }
  fs.writeFileSync(file, JSON.stringify(pack, null, 2) + "\n");
}

async function startScenario(t, { steam, packRoot, env }) {
  const pack = readJson(path.join(packRoot, "pack.json"));
  const packsDir = tempDir("modsync-policy-repo-");
  fs.cpSync(packRoot, path.join(packsDir, pack.id), { recursive: true });

  const repo = await startRepository({ packsDir, token: "policy-token" });
  const tv = tempDir("modsync-policy-tv-");
  const agent = await startAgent({
    pcUrl: repo.base,
    token: repo.token,
    root: tv,
    env: env || steam.env,
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

async function install(agent) {
  const started = await request(agent.base, "/api/install", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(started.status, 202);
  return pollJob(agent.base, started.json.jobId);
}

async function expectUnblocked(agent) {
  const state = await request(agent.base, "/api/state");
  assert.equal(state.status, 200);
  const pack = state.json.packs.find((entry) => entry.id === PACK_ID);
  assert.ok(pack, "state contains the pack");
  assert.equal(pack.blocked, false, "the pack is not blocked by a removed check");
}

test("a pack that omits game-build installs despite a different Steam build", { timeout: 90000 }, async (t) => {
  const { base, root } = copyPackWithoutPrecondition(
    fixture.packs["0.2.7"].packRoot,
    ["game-build"],
  );
  t.after(() => remove(base));

  const steam = makeSteamEnv({ build: "1" });
  const { agent, tv } = await startScenario(t, { steam, packRoot: root });

  await expectUnblocked(agent);
  const job = await install(agent);
  assert.equal(job.status, "done");
  assert.equal(
    fs.readFileSync(path.join(tv, "packs", PACK_ID, "mods", MOD_ID, "current.txt"), "utf8").trim(),
    "0.2.7",
  );
});

test("a pack that omits disk-free installs with less than 1 GiB free", { timeout: 90000 }, async (t) => {
  const { base, root } = copyPackWithoutPrecondition(
    fixture.packs["0.2.7"].packRoot,
    ["disk-free"],
  );
  t.after(() => remove(base));

  const steam = makeSteamEnv();
  const low = lowSpaceEnv(steam);
  t.after(() => remove(low.dir));
  const { agent, tv } = await startScenario(t, {
    steam,
    packRoot: root,
    env: low.env,
  });

  const state = await request(agent.base, "/api/state");
  assert.equal(state.json.diskFreeBytes, 1, "the low-space stub is active");
  await expectUnblocked(agent);
  const job = await install(agent);
  assert.equal(job.status, "done");
  assert.equal(
    fs.readFileSync(path.join(tv, "packs", PACK_ID, "mods", MOD_ID, "current.txt"), "utf8").trim(),
    "0.2.7",
  );
});

test("a pack that omits game-not-running installs while the game is running", { timeout: 90000 }, async (t) => {
  const { base, root } = copyPackWithoutPrecondition(
    fixture.packs["0.2.7"].packRoot,
    ["game-closed", "game-not-running"],
  );
  t.after(() => remove(base));
  setGameProcess(root, process.platform === "win32" ? "node.exe" : "node");

  const steam = makeSteamEnv();
  const { agent, tv } = await startScenario(t, { steam, packRoot: root });

  await expectUnblocked(agent);
  const job = await install(agent);
  assert.equal(job.status, "done");
  assert.equal(
    fs.readFileSync(path.join(tv, "packs", PACK_ID, "mods", MOD_ID, "current.txt"), "utf8").trim(),
    "0.2.7",
  );
});

test("a pack that omits proton-prefix installs without a prefix on Linux", {
  skip: process.platform === "win32" ? "Proton is Linux-only" : false,
  timeout: 90000,
}, async (t) => {
  const { base, root } = copyPackWithoutPrecondition(
    fixture.packs["0.2.7"].packRoot,
    ["proton-prefix"],
  );
  t.after(() => remove(base));

  const steam = makeSteamEnv();
  remove(path.join(steam.steamRoot, "steamapps", "compatdata", "1245620"));
  const { agent, tv } = await startScenario(t, { steam, packRoot: root });

  await expectUnblocked(agent);
  const job = await install(agent);
  assert.equal(job.status, "done");
  assert.equal(
    fs.readFileSync(path.join(tv, "packs", PACK_ID, "mods", MOD_ID, "current.txt"), "utf8").trim(),
    "0.2.7",
  );
});
