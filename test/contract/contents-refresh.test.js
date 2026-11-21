"use strict";

/**
 * Contract: `scripts/refresh-contents.js` refreshes every built pack through
 * the driver API, not through a game-specific branch. The script is part of
 * the PC workflow, so this stays a black-box CLI/script test.
 *
 * The test uses both an Elden Ring pack and a BG3 pack. Any refactor of the
 * contents interface must keep both outputs valid.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  bg3WorkingInstall,
  bg3leRuntime,
  buildBg3Pack,
  buildPackSet,
  readJson,
  remove,
  runScript,
  tempDir,
  write,
} = require("../../test-support/harness");

test("contents refresh works for the Elden Ring and BG3 drivers", { timeout: 120000 }, async (t) => {
  const er = await buildPackSet({ versions: ["0.2.7"] });
  const bg3Source = bg3WorkingInstall({ version: "1.0.0" });
  const bg3le = bg3leRuntime();
  const bg3GameRoot = tempDir("modsync-contents-game-");
  const bg3Out = tempDir("modsync-contents-bg3-");
  const packsDir = tempDir("modsync-contents-packs-");

  t.after(() => {
    er.cleanup();
    remove(bg3Source);
    remove(bg3le);
    remove(bg3GameRoot);
    remove(bg3Out);
    remove(packsDir);
  });

  // The shared Elden Ring fixture uses a placeholder profile; give the refresh
  // script a real me3 package list to read.
  write(er.source, "profiles/graceborne-0.2.7.me3", `[[packages]]
path = "../mods/graceborne/versions/0.2.7/mod"
enabled = true
load_after = []
load_before = []
`);

  write(bg3GameRoot, "bin/DWrite.dll", "dwrite");
  await buildBg3Pack({
    source: bg3Source,
    out: bg3Out,
    version: "1.0.0",
    gameRoot: bg3GameRoot,
    bg3le,
  });

  fs.cpSync(er.packs["0.2.7"].packRoot, path.join(packsDir, "eldenring-graceborne"), { recursive: true });
  fs.cpSync(bg3Out, path.join(packsDir, "bg3-modded"), { recursive: true });

  // Poison the stored contents so the refresh must actually rewrite them.
  for (const id of ["eldenring-graceborne", "bg3-modded"]) {
    const file = path.join(packsDir, id, "pack.json");
    const pack = readJson(file);
    pack.contents = { kind: "stale", count: 999 };
    fs.writeFileSync(file, JSON.stringify(pack, null, 2) + "\n");
  }

  await runScript("scripts/refresh-contents.js", [
    "--packs", packsDir,
    "--pack", "eldenring-graceborne",
    "--source", er.source,
  ]);
  await runScript("scripts/refresh-contents.js", [
    "--packs", packsDir,
    "--pack", "bg3-modded",
    "--source", bg3Source,
  ]);

  const eldenRing = readJson(path.join(packsDir, "eldenring-graceborne", "pack.json"));
  assert.equal(eldenRing.contents.count, 1);
  assert.equal(eldenRing.contents.source, "me3 profile");
  assert.equal(eldenRing.contents.itemsLabel, "Included packages");
  assert.equal(eldenRing.contents.items.length, 1);

  const bg3 = readJson(path.join(packsDir, "bg3-modded", "pack.json"));
  assert.equal(bg3.contents.count, 1);
  assert.equal(bg3.contents.source, "modsettings.lsx");
  assert.equal(bg3.contents.itemsLabel, "Included mods");
  assert.equal(bg3.contents.items.length, 1);
  assert.deepEqual(bg3.contents.inactive, ["Extra.pak"]);
});
