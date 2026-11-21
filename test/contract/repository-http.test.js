"use strict";

/**
 * Contract: the PC repository is an HTTP service. Tests cover auth, the pack
 * catalog, pack documents, file streaming with resume, and the landing page.
 * They only use HTTP, so `server.js` can be split into routes/static/repo.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  activatePack,
  buildPackSet,
  readJson,
  remove,
  request,
  runCli,
  startRepository,
  tempDir,
} = require("../../test-support/harness");

const PACK_ID = "eldenring-graceborne";
const TOKEN = "contract-token";

let fixture;
let packsDir;
let repo;
let filesDoc;

before(async () => {
  fixture = await buildPackSet({ versions: ["0.2.7"] });
  filesDoc = readJson(path.join(fixture.packs["0.2.7"].packRoot, "files.json"));
  packsDir = tempDir("modsync-repo-");
  activatePack(packsDir, fixture.packs["0.2.7"]);
  repo = await startRepository({ packsDir, token: TOKEN });
});

after(async () => {
  if (repo) await repo.stop();
  if (fixture) fixture.cleanup();
  remove(packsDir);
});

test("health is public and catalog requires the token", { timeout: 60000 }, async () => {
  const health = await request(repo.base, "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);

  const denied = await request(repo.base, "/api/packs");
  assert.equal(denied.status, 403);

  const packs = await request(repo.base, "/api/packs", { token: TOKEN });
  assert.equal(packs.status, 200);
  assert.ok(Array.isArray(packs.json));
  assert.equal(packs.json.length, 1);

  const summary = packs.json[0];
  assert.equal(summary.id, PACK_ID);
  assert.equal(summary.mod.version, "0.2.7");
  assert.equal(summary.game.appId, 1245620);
  assert.ok(summary.files > 0);
  assert.ok(summary.totalBytes > 0);
});

test("pack documents are served from the manifest", { timeout: 60000 }, async () => {
  const pack = await request(repo.base, `/api/packs/${PACK_ID}/pack.json`, { token: TOKEN });
  assert.equal(pack.status, 200);
  assert.equal(pack.json.id, PACK_ID);
  assert.equal(pack.json.mod.version, "0.2.7");
  assert.equal(pack.json.files, "files.json");

  const files = await request(repo.base, `/api/packs/${PACK_ID}/files.json`, { token: TOKEN });
  assert.equal(files.status, 200);
  assert.equal(files.json.pack, PACK_ID);
  assert.equal(files.json.version, "0.2.7");
  assert.ok(Array.isArray(files.json.files));
  assert.deepEqual(files.json.files.map((file) => file.source), filesDoc.files.map((file) => file.source));

  const art = await request(repo.base, `/api/packs/${PACK_ID}/art/grid`, { token: TOKEN });
  assert.equal(art.status, 200);
  assert.equal(art.headers.get("content-type"), "image/png");
  assert.ok(art.buf.length > 0);

  const unknown = await request(repo.base, "/api/packs/does-not-exist/pack.json", { token: TOKEN });
  assert.equal(unknown.status, 404);
});

test("pack files stream fully and support byte ranges", { timeout: 60000 }, async () => {
  const sample = filesDoc.files.find((file) => file.target.endsWith("/mod/regulation.bin"));
  assert.ok(sample, "fixture has a regulation.bin payload file");

  const expected = fs.readFileSync(path.join(fixture.packs["0.2.7"].packRoot, sample.source));
  const url = `/api/packs/${PACK_ID}/file?path=${encodeURIComponent(sample.source)}`;

  const full = await request(repo.base, url, { token: TOKEN });
  assert.equal(full.status, 200);
  assert.deepEqual(full.buf, expected);

  const first = await request(repo.base, url, {
    token: TOKEN,
    headers: { Range: "bytes=0-3" },
  });
  assert.equal(first.status, 206);
  assert.equal(first.text, expected.subarray(0, 4).toString("utf8"));
  assert.equal(first.headers.get("content-range"), `bytes 0-3/${expected.length}`);
  assert.equal(first.headers.get("accept-ranges"), "bytes");

  const tail = await request(repo.base, url, {
    token: TOKEN,
    headers: { Range: "bytes=4-" },
  });
  assert.equal(tail.status, 206);
  assert.deepEqual(tail.buf, expected.subarray(4));

  const invalid = await request(repo.base, url, {
    token: TOKEN,
    headers: { Range: `bytes=${expected.length}-` },
  });
  assert.equal(invalid.status, 416);

  const notInManifest = await request(
    repo.base,
    `/api/packs/${PACK_ID}/file?path=${encodeURIComponent("../../pack.json")}`,
    { token: TOKEN },
  );
  assert.equal(notInManifest.status, 404);

  const missingPath = await request(repo.base, `/api/packs/${PACK_ID}/file`, { token: TOKEN });
  assert.equal(missingPath.status, 400);
});

test("landing page is available", { timeout: 60000 }, async () => {
  const landing = await request(repo.base, "/");
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get("content-type"), /text\/html/);
  assert.match(landing.text, /Graceborne/);
});

test("serve defaults to loopback", { timeout: 60000 }, async () => {
  const loop = await startRepository({ packsDir, token: TOKEN, host: null });
  try {
    const health = await request(loop.base, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
  } finally {
    await loop.stop();
  }
});

test("serve refuses to bind all interfaces", { timeout: 60000 }, async () => {
  await assert.rejects(
    runCli([
      "serve",
      "--packs", packsDir,
      "--host", "0.0.0.0",
      "--port", "0",
    ]),
  );
});
