"use strict";

/**
 * Contract: an ER pack carries the loader metadata the TV needs, with the
 * Windows and Linux runtimes tagged per platform. This is the safety net for
 * extracting me3 packaging into a loader feature.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  buildPackSet,
  readJson,
} = require("../../test-support/harness");

test("ER pack exposes one launcher template and platform-tagged runtimes", { timeout: 90000 }, async (t) => {
  const fixture = await buildPackSet({ versions: ["0.2.7"] });
  t.after(() => fixture.cleanup());

  const root = fixture.packs["0.2.7"].packRoot;
  const pack = readJson(path.join(root, "pack.json"));
  const doc = readJson(path.join(root, "files.json"));
  const byTarget = Object.fromEntries(doc.files.map((file) => [file.target, file]));

  assert.equal(pack.loader.type, "me3");
  assert.equal(pack.platforms.windows.template, "loaders/me3.sh");
  assert.equal(pack.platforms["linux-proton"].template, "loaders/me3.sh");
  assert.equal(pack.platforms.windows.loader, "tools/me3-win/bin/me3.exe");
  assert.equal(pack.platforms["linux-proton"].loader, "tools/me3-linux/bin/me3");
  assert.equal(pack.platforms["linux-proton"].loaderSupport, "tools/me3-win/bin");

  assert.ok(byTarget["profiles/graceborne-0.2.7.me3"], "me3 profile is in the file manifest");

  assert.equal(byTarget["tools/me3-linux/bin/me3"].mode, "755");
  assert.deepEqual(byTarget["tools/me3-linux/bin/me3"].platforms, ["linux-proton"]);
  assert.deepEqual(byTarget["tools/me3-win/bin/me3.exe"].platforms, ["windows"]);
  assert.deepEqual(
    byTarget["tools/me3-win/bin/me3_mod_host.dll"].platforms,
    ["windows", "linux-proton"],
  );

  // The launcher template and the loader paths are pack data. The installer
  // must not regain a game-specific check to find them.
  const installedFiles = doc.files.filter((file) => file.target.startsWith("tools/me3-"));
  assert.ok(installedFiles.length >= 4, "both loader runtimes are packaged");
  assert.ok(installedFiles.every((file) => Array.isArray(file.platforms)));
});
