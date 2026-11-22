"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const h = require("../test-support/harness");
const { createConsole } = require("../dist/src/console");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function waitForBuild(service, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await service.state();
    if (state.build && state.build.status !== "running") return state.build;
    await h.sleep(50);
  }
  throw new Error("build did not finish");
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

test("a pack cover is written into the pack and can be cleared", async (t) => {
  const root = h.tempDir("modsync-pack-image-");
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

  const packRoot = path.join(packsDir, "eldenring-graceborne");
  const packFile = path.join(packRoot, "pack.json");
  const filesFile = path.join(packRoot, "files.json");
  const libraryFile = path.join(packRoot, "library.json");
  const coverFile = path.join(root, "cover.png");
  fs.writeFileSync(coverFile, PNG);

  let packs = service.listPacks();
  assert.equal(packs[0].artCustom, false);

  packs = service.updatePackImage("eldenring-graceborne", { path: coverFile });
  assert.equal(packs[0].artCustom, true);
  const withCover = h.readJson(packFile);
  assert.equal(withCover.art.grid, "art/graceborne/modsync-cover.png");
  assert.deepEqual(fs.readFileSync(path.join(packRoot, withCover.art.grid)), PNG);
  const coverEntry = h.readJson(filesFile).files.find((file) => file.target === withCover.art.grid);
  assert.ok(coverEntry);
  assert.equal(coverEntry.source, withCover.art.grid);
  assert.equal(coverEntry.size, PNG.length);
  assert.equal(coverEntry.sha256, sha256(PNG));
  assert.equal(coverEntry.mode, "644");
  const library = h.readJson(libraryFile);
  assert.equal(library.image, withCover.art.grid);
  assert.equal(library.imageOriginal, "art/graceborne/grid.png");

  // Name and notes keep the image fields when they are saved.
  service.updatePackLibrary("eldenring-graceborne", { name: "Graceborne", notes: "Cover selected." });
  assert.equal(h.readJson(libraryFile).image, withCover.art.grid);
  assert.equal(h.readJson(libraryFile).notes, "Cover selected.");

  // The control API serves the selected image.
  const control = await service.listen();
  const served = await fetch(`${control}/api/packs/eldenring-graceborne/art/grid`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

  packs = service.clearPackImage("eldenring-graceborne");
  assert.equal(packs[0].artCustom, false);
  const cleared = h.readJson(packFile);
  assert.equal(cleared.art.grid, "art/graceborne/grid.png");
  assert.equal(fs.existsSync(path.join(packRoot, "art/graceborne/modsync-cover.png")), false);
  assert.equal(h.readJson(filesFile).files.some((file) => file.target === "art/graceborne/modsync-cover.png"), false);
  assert.equal(h.readJson(libraryFile).image, undefined);
  assert.equal(h.readJson(libraryFile).notes, "Cover selected.");

  // A browser-style data URL works too.
  packs = service.updatePackImage("eldenring-graceborne", {
    data: `data:image/png;base64,${PNG.toString("base64")}`,
  });
  assert.equal(packs[0].artCustom, true);

  const notPng = path.join(root, "cover.txt");
  fs.writeFileSync(notPng, "not an image");
  assert.throws(() => service.updatePackImage("eldenring-graceborne", { path: notPng }), /PNG/);
  assert.throws(
    () => service.updatePackImage("eldenring-graceborne", { data: "data:text/plain;base64,bm90" }),
    /PNG/,
  );

  // The image endpoint uses the same path through the control API.
  const response = await fetch(`${control}/api/packs/eldenring-graceborne/image/clear`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: control },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.packs[0].artCustom, false);
});
