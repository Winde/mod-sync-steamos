"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const h = require("../test-support/harness");
const { createConsole } = require("../dist/src/console");

function addVersion(source, version) {
  for (const [rel, body] of [
    [`mods/graceborne/versions/${version}/mod/regulation.bin`, `regulation-${version}`],
    [`mods/graceborne/versions/${version}/mod/parts/test.partsbndsc.dcx`, `part-${version}`],
    [`profiles/graceborne-${version}.me3`, `[[packages]]
id = "GraceBorne"
path = '../mods/graceborne/versions/${version}/mod'
enabled = true
load_after = []
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

test("Pack library keeps a renamed pack and notes in the pack folder", async (t) => {
  const root = h.tempDir("modsync-library-");
  const packsDir = path.join(root, "packs");
  const source = h.workingInstall({ versions: ["0.2.7"] });
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

  const control = await service.listen();
  const libraryResponse = await fetch(`${control}/api/packs/eldenring-graceborne/library`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: control },
    body: JSON.stringify({ name: "  Graceborne Remastered  ", notes: "Works with the 1.17 build." }),
  });
  assert.equal(libraryResponse.status, 200);
  let packs = (await libraryResponse.json()).packs;
  assert.equal(packs.length, 1);
  assert.equal(packs[0].name, "Graceborne Remastered");
  assert.equal(packs[0].baseName, "Graceborne");
  assert.equal(packs[0].notes, "Works with the 1.17 build.");

  const libraryFile = path.join(packsDir, "eldenring-graceborne", "library.json");
  const library = h.readJson(libraryFile);
  assert.equal(library.schema, 1);
  assert.equal(library.name, "Graceborne Remastered");
  assert.equal(library.notes, "Works with the 1.17 build.");
  assert.ok(library.updatedAt);

  // An omitted field keeps its current value.
  packs = service.updatePackLibrary("eldenring-graceborne", { name: "Graceborne Plus" });
  assert.equal(packs[0].name, "Graceborne Plus");
  assert.equal(packs[0].notes, "Works with the 1.17 build.");
  assert.equal(h.readJson(libraryFile).name, "Graceborne Plus");

  // The LAN server serves the renamed pack and attaches the console notes.
  await service.updateSettings({ bind: "loopback", port: 0, token: "library-token", autoStart: false });
  const status = await service.startServer();
  assert.equal(status.running, true);
  const served = await fetch(`${status.url}/api/packs?token=library-token`).then((res) => res.json());
  assert.equal(served.length, 1);
  assert.equal(served[0].name, "Graceborne Plus");
  assert.equal(served[0].baseName, "Graceborne");
  assert.ok(served[0].notes.some((note) => (
    typeof note === "object"
    && note.title === "Server notes"
    && note.body === "Works with the 1.17 build."
  )));

  // Clearing both fields removes the sidecar and restores pack.json's name.
  packs = service.updatePackLibrary("eldenring-graceborne", { name: "", notes: "" });
  assert.equal(fs.existsSync(libraryFile), false);
  assert.equal(packs[0].name, "Graceborne");
  assert.equal(packs[0].notes, "");

  // A rebuild starts a clean library instead of carrying the name and notes.
  service.updatePackLibrary("eldenring-graceborne", { name: "Graceborne Rebuilt", notes: "Written for 0.2.7." });
  assert.ok(fs.existsSync(libraryFile));
  addVersion(source, "0.2.8");
  service.startBuild({ recipeId: "eldenring-graceborne", source, version: "0.2.8" });
  const rebuilt = await waitForBuild(service);
  assert.equal(rebuilt.status, "done", rebuilt.error || "");
  packs = service.listPacks();
  assert.equal(packs[0].mod.version, "0.2.8");
  assert.equal(packs[0].name, "Graceborne");
  assert.equal(packs[0].notes, "");
  assert.equal(fs.existsSync(libraryFile), false);
  await service.stopServer();
});

test("A rebuild can create a second pack from the same recipe", async (t) => {
  const root = h.tempDir("modsync-new-pack-");
  const packsDir = path.join(root, "packs");
  const source = h.workingInstall({ versions: ["0.2.7"] });
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
  assert.equal((await waitForBuild(service)).status, "done");
  service.updatePackLibrary("eldenring-graceborne", { name: "Original Pack", notes: "Keep me." });

  const started = service.startBuild({
    recipeId: "eldenring-graceborne",
    source,
    version: "0.2.7",
    packId: "graceborne-copy",
    createNew: true,
    packName: "Graceborne Copy",
  });
  assert.equal(started.packId, "graceborne-copy");
  const copied = await waitForBuild(service);
  assert.equal(copied.status, "done", copied.error || "");
  assert.equal(copied.packId, "graceborne-copy");

  let packs = service.listPacks();
  assert.equal(packs.length, 2);
  const original = packs.find((pack) => pack.id === "eldenring-graceborne");
  const copy = packs.find((pack) => pack.id === "graceborne-copy");
  assert.ok(original);
  assert.ok(copy);
  assert.equal(original.name, "Original Pack");
  assert.equal(original.notes, "Keep me.");
  assert.equal(copy.name, "Graceborne Copy");
  assert.equal(copy.baseName, "Graceborne");
  assert.equal(copy.notes, "");
  assert.equal(copy.recipeId, "eldenring-graceborne");
  const copyRoot = path.join(packsDir, "graceborne-copy");
  assert.equal(h.readJson(path.join(copyRoot, "pack.json")).id, "graceborne-copy");
  assert.equal(h.readJson(path.join(copyRoot, "pack.json")).recipe, "eldenring-graceborne");
  assert.equal(h.readJson(path.join(copyRoot, "files.json")).pack, "graceborne-copy");
  assert.ok(fs.existsSync(path.join(copyRoot, "library.json")));

  assert.throws(
    () => service.startBuild({
      recipeId: "eldenring-graceborne",
      source,
      version: "0.2.7",
      packId: "graceborne-copy",
      createNew: true,
      packName: "Another",
    }),
    /already exists/,
  );

  // Rebuilding the new pack clears its library but leaves the original alone.
  service.startBuild({ recipeId: "eldenring-graceborne", source, version: "0.2.7", packId: "graceborne-copy" });
  const rebuilt = await waitForBuild(service);
  assert.equal(rebuilt.status, "done", rebuilt.error || "");
  packs = service.listPacks();
  const rebuiltCopy = packs.find((pack) => pack.id === "graceborne-copy");
  assert.equal(rebuiltCopy.name, "Graceborne");
  assert.equal(rebuiltCopy.notes, "");
  assert.equal(fs.existsSync(path.join(copyRoot, "library.json")), false);
  assert.ok(fs.existsSync(path.join(packsDir, "eldenring-graceborne", "library.json")));
});

test("Mod reviews are stored per included mod, not per pack", async (t) => {
  const root = h.tempDir("modsync-reviews-");
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

  let packs = service.listPacks();
  assert.equal(packs[0].contents.items[0].modId, "Graceborne");

  // Packs built before reviews were per mod have no item id. Their label still
  // matches the id a later rebuild writes for the same mod.
  const manifestFile = path.join(packsDir, "eldenring-graceborne", "pack.json");
  const manifest = h.readJson(manifestFile);
  delete manifest.contents.items[0].id;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  packs = service.listPacks();
  const item = packs[0].contents.items[0];
  assert.equal(item.label, "Graceborne");
  assert.equal(item.modId, "Graceborne");
  assert.equal(item.review, null);

  const reviewFile = path.join(root, "state", "reviews.json");
  const control = await service.listen();
  const reviewResponse = await fetch(`${control}/api/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: control },
    body: JSON.stringify({
      gameId: "eldenring",
      modId: item.modId,
      name: item.label,
      rating: 5,
      body: "  Best overhaul for 1.17.  ",
    }),
  });
  assert.equal(reviewResponse.status, 200);
  const review = (await reviewResponse.json()).review;
  assert.equal(review.rating, 5);
  assert.equal(review.body, "Best overhaul for 1.17.");
  assert.ok(review.updatedAt);

  packs = service.listPacks();
  assert.deepEqual(packs[0].contents.items[0].review, review);
  const key = "g:eldenring::m:Graceborne";
  const db = h.readJson(reviewFile);
  assert.equal(db.schema, 2);
  assert.equal(db.reviews[key].gameId, "eldenring");
  assert.equal(db.reviews[key].modId, "Graceborne");
  assert.equal(db.reviews[key].name, "Graceborne");
  assert.equal(db.reviews[key].rating, 5);
  assert.equal(db.reviews[key].body, "Best overhaul for 1.17.");

  // A rebuild and a removal of the pack keep the review because it belongs to
  // the mod, and the mod keeps the same id in both builds.
  addVersion(source, "0.2.8");
  service.startBuild({ recipeId: "eldenring-graceborne", source, version: "0.2.8" });
  const rebuilt = await waitForBuild(service);
  assert.equal(rebuilt.status, "done", rebuilt.error || "");
  packs = service.listPacks();
  assert.equal(packs[0].mod.version, "0.2.8");
  assert.equal(packs[0].contents.items[0].modId, "Graceborne");
  assert.equal(packs[0].contents.items[0].review.rating, 5);

  await service.removePack("eldenring-graceborne");
  assert.equal(service.listPacks().length, 0);
  assert.equal(h.readJson(reviewFile).reviews[key].rating, 5);

  // Clearing both the rating and the text removes the entry and the file.
  assert.equal(service.saveReview({ gameId: "eldenring", modId: "Graceborne", name: "Graceborne", rating: 0, body: "   " }), null);
  assert.equal(fs.existsSync(reviewFile), false);

  assert.throws(
    () => service.saveReview({ gameId: "eldenring", modId: "Graceborne", name: "Graceborne", rating: 9, body: "Nope" }),
    /Rating must be a whole number/,
  );
});
