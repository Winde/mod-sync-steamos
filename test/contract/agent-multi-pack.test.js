"use strict";

/**
 * Contract: `/api/state` lists remote and local packs together and sorts them
 * by game then pack name. This is the data source for the Games view; the DOM
 * itself is not exercised here.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  activatePack,
  buildPackSet,
  makeSteamEnv,
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
let packsDir;
let repo;
let steam;
let tv;
let agent;

before(async () => {
  fixture = await buildPackSet({ versions: ["0.2.7"] });
  const built = fixture.packs["0.2.7"];
  setLaunchGameProcess(built.packRoot, GAME_PROCESS);

  packsDir = tempDir("modsync-multi-repo-");
  activatePack(packsDir, built);

  // A second pack with a title that sorts before ELDEN RING. The payload is
  // irrelevant to /api/state; only a valid pack.json/files.json are needed.
  const alphaRoot = path.join(packsDir, "alpha-pack");
  fs.cpSync(built.packRoot, alphaRoot, { recursive: true });
  const alpha = readJson(path.join(alphaRoot, "pack.json"));
  alpha.id = "alpha-pack";
  alpha.name = "Alpha Pack";
  alpha.game = { ...alpha.game, id: "alpha", title: "A Game" };
  fs.writeFileSync(path.join(alphaRoot, "pack.json"), JSON.stringify(alpha, null, 2) + "\n");
  const alphaFiles = readJson(path.join(alphaRoot, "files.json"));
  alphaFiles.pack = "alpha-pack";
  fs.writeFileSync(path.join(alphaRoot, "files.json"), JSON.stringify(alphaFiles, null, 2) + "\n");

  repo = await startRepository({ packsDir, token: "multi-token" });
  steam = makeSteamEnv();
  tv = tempDir("modsync-tv-multi-");
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

test("state lists multiple packs sorted by game then name", { timeout: 60000 }, async () => {
  const res = await request(agent.base, "/api/state");
  assert.equal(res.status, 200);

  const packs = res.json.packs;
  assert.equal(packs.length, 2);
  assert.deepEqual(packs.map((p) => p.game.title), ["A Game", "ELDEN RING"]);
  assert.deepEqual(packs.map((p) => p.id), ["alpha-pack", PACK_ID]);
  assert.ok(packs.every((p) => p.local === false));
  assert.ok(packs.every((p) => p.installed === false));
  assert.ok(packs.every((p) => p.canRollback === false));
});
