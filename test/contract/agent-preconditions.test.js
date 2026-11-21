"use strict";

/**
 * Contract: required `manual` checks block the pack until the user confirms
 * them; confirmation state is stored on the TV and can be revoked. Tested via
 * `/api/state` and `/api/preconditions/confirm`.
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
const CHECK_ID = "manual-contract-check";

let fixture;
let packsDir;
let repo;
let steam;
let tv;
let agent;

before(async () => {
  fixture = await buildPackSet({ versions: ["0.2.7"] });
  const built = fixture.packs["0.2.7"];

  const file = path.join(built.packRoot, "pack.json");
  const pack = readJson(file);
  pack.preconditions.unshift({
    id: CHECK_ID,
    type: "manual",
    required: true,
    title: "Contract manual check",
    hint: "Confirm this in the dashboard.",
  });
  fs.writeFileSync(file, JSON.stringify(pack, null, 2) + "\n");
  setLaunchGameProcess(built.packRoot, "modsync-test-not-running.exe");

  packsDir = tempDir("modsync-pre-repo-");
  activatePack(packsDir, built);
  repo = await startRepository({ packsDir, token: "precondition-token" });
  steam = makeSteamEnv();
  tv = tempDir("modsync-tv-preconditions-");
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

async function packState() {
  const res = await request(agent.base, "/api/state");
  assert.equal(res.status, 200);
  const pack = res.json.packs.find((p) => p.id === PACK_ID);
  assert.ok(pack, "state contains the pack");
  return pack;
}

test("manual checks block, confirm, and unblock again", { timeout: 60000 }, async () => {
  let pack = await packState();
  assert.equal(pack.blocked, true);

  let check = pack.preconditions.checks.find((c) => c.id === CHECK_ID);
  assert.ok(check, "manual check is reported");
  assert.equal(check.required, true);
  assert.equal(check.confirmable, true);
  assert.equal(check.status, "unknown");
  assert.equal(check.blocked, true);

  const confirmed = await request(agent.base, "/api/preconditions/confirm", {
    method: "POST",
    body: { packId: PACK_ID, checkId: CHECK_ID, confirmed: true },
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json.packId, PACK_ID);
  assert.equal(confirmed.json.checkId, CHECK_ID);
  assert.equal(confirmed.json.confirmed, true);

  pack = await packState();
  assert.equal(pack.blocked, false);
  check = pack.preconditions.checks.find((c) => c.id === CHECK_ID);
  assert.equal(check.status, "pass");
  assert.equal(check.blocked, false);

  const revoked = await request(agent.base, "/api/preconditions/confirm", {
    method: "POST",
    body: { packId: PACK_ID, checkId: CHECK_ID, confirmed: false },
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.packId, PACK_ID);
  assert.equal(revoked.json.checkId, CHECK_ID);
  assert.equal(revoked.json.confirmed, false);

  pack = await packState();
  assert.equal(pack.blocked, true);
  check = pack.preconditions.checks.find((c) => c.id === CHECK_ID);
  assert.equal(check.status, "unknown");
});

test("confirmation endpoint validates its input", { timeout: 60000 }, async () => {
  const res = await request(agent.base, "/api/preconditions/confirm", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(res.status, 400);
  assert.ok(res.json.error, "invalid confirmation returns an error");
});
