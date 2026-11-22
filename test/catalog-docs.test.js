"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const h = require("../test-support/harness");
const { createConsole } = require("../dist/src/console");
const { writePackDoc } = require("../dist/src/pack-docs");

function addVersion(source, version) {
  for (const [rel, body] of [
    [`mods/graceborne/versions/${version}/mod/regulation.bin`, `regulation-${version}`],
    [`mods/graceborne/versions/${version}/mod/parts/test.partsbndsc.dcx`, `part-${version}`],
    [`profiles/graceborne-${version}.me3`, `[[packages]]
path = '../mods/graceborne/versions/${version}/mod'
enabled = true
load_after = ["extra"]
load_before = []
`],
  ]) {
    h.write(source, rel, body);
  }
  h.write(source, "mods/graceborne/current.txt", `${version}\n`);
}

async function waitForBuild(service, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await service.state();
    if (state.build && state.build.status !== "running") return state.build;
    await h.sleep(50);
  }
  throw new Error("build did not finish");
}

test("the catalog records mods, reviews, docs, and history across pack removal", async (t) => {
  const root = h.tempDir("modsync-catalog-");
  const packsDir = path.join(root, "packs");
  const source = h.workingInstall({ versions: ["0.2.7"] });
  addVersion(source, "0.2.7");
  const configFile = path.join(root, "state", "console.json");
  const service = createConsole({
    configFile,
    defaultPacksDir: packsDir,
    version: "0.0.0-test",
    reveal: () => {},
  });
  t.after(async () => {
    await service.close();
    h.remove(root);
    h.remove(source);
  });

  service.startBuild({ recipeId: "eldenring-graceborne", source, version: "0.2.7" });
  const built = await waitForBuild(service);
  assert.equal(built.status, "done", built.error || "");
  assert.ok(fs.existsSync(path.join(packsDir, "eldenring-graceborne", "DOCS.md")));

  let state = await service.state();
  assert.equal(state.catalog.summary.mods, 1);
  const entry = state.catalog.entries[0];
  assert.equal(entry.name, "Graceborne");
  assert.equal(entry.gameId, "eldenring");
  assert.equal(entry.installMethod, "me3 profile");
  assert.equal(entry.present, true);
  assert.equal(entry.usedBy.length, 1);
  assert.equal(entry.usedBy[0].packName, "Graceborne");
  assert.equal(entry.usedBy[0].packVersion, "0.2.7");
  assert.deepEqual(entry.loadAfter, ["extra"]);
  assert.ok(entry.firstSeenAt);
  assert.ok(entry.lastSeenAt);
  assert.ok(fs.existsSync(path.join(root, "state", "catalog.json")));

  const review = service.saveReview({
    gameId: "eldenring",
    modId: entry.modId,
    name: entry.name,
    rating: 4,
    body: "Keeps the Bloodborne feel.",
  });
  assert.ok(review);
  state = await service.state();
  assert.equal(state.catalog.entries[0].review.rating, 4);
  assert.equal(state.catalog.entries[0].review.body, "Keeps the Bloodborne feel.");

  const docs = service.writePackDocs("eldenring-graceborne");
  assert.ok(fs.existsSync(docs.file));
  assert.match(docs.markdown, /^# Graceborne/m);
  assert.match(docs.markdown, /## Mods/);
  assert.match(docs.markdown, /me3 profile/);
  assert.match(docs.markdown, /Server notes|Keeps the Bloodborne feel|Load order hints/);

  const exported = service.exportCatalog();
  assert.match(exported, /^# Mod catalog/m);
  assert.match(exported, /Graceborne/);
  assert.match(exported, /Keeps the Bloodborne feel\./);
  assert.match(exported, /★★★★☆/);

  // A removed pack loses its current usage, but the mod and review remain in
  // the historical catalog.
  await service.removePack("eldenring-graceborne");
  state = await service.state();
  assert.equal(state.catalog.entries.length, 1);
  assert.equal(state.catalog.entries[0].present, false);
  assert.equal(state.catalog.entries[0].review.rating, 4);
  assert.match(service.exportCatalog(), /No longer in a current pack/);
});

test("writePackDoc generates a self-contained pack document", async (t) => {
  const source = h.workingInstall({ versions: ["1.0.0"] });
  addVersion(source, "1.0.0");
  const packRoot = h.tempDir("modsync-docs-pack-");
  t.after(() => {
    h.remove(source);
    h.remove(packRoot);
  });

  await h.buildPack({ source, out: packRoot, version: "1.0.0" });
  const markdown = writePackDoc(packRoot);
  const file = path.join(packRoot, "DOCS.md");
  assert.equal(fs.readFileSync(file, "utf8"), markdown);
  assert.match(markdown, /^# Graceborne/m);
  assert.match(markdown, /## Pack/);
  assert.match(markdown, /Game \| ELDEN RING/);
  assert.match(markdown, /## Mods/);
  assert.match(markdown, /me3 profile/);
  assert.match(markdown, /Load order hints/);
  assert.match(markdown, /base game and saves are not included/);
});
