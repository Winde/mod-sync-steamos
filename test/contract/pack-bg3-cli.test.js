"use strict";

/**
 * Contract: `modsync pack` builds a BG3 pack with the same external format as
 * the Elden Ring pack: platform-tagged files, a launcher template, install
 * metadata, and normalized contents. The BG3 driver can be refactored freely
 * as long as this output stays valid.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  bg3WorkingInstall,
  bg3leRuntime,
  buildBg3Pack,
  readJson,
  remove,
  sha256,
  tempDir,
  write,
} = require("../../test-support/harness");

const VERSION = "2026.11.21";
const PACK_ID = "bg3-modded";
const MOD_ID = "bg3";

test("BG3 pack CLI produces a complete multi-platform pack contract", { timeout: 90000 }, async (t) => {
  const source = bg3WorkingInstall({ version: VERSION });
  const bg3le = bg3leRuntime();
  const gameRoot = tempDir("modsync-bg3-game-");
  write(gameRoot, "bin/DWrite.dll", "dwrite");
  write(gameRoot, "bin/ScriptExtenderSettings.json", "{}");
  const out = tempDir("modsync-bg3-pack-");

  t.after(() => {
    remove(source);
    remove(bg3le);
    remove(gameRoot);
    remove(out);
  });

  await buildBg3Pack({ source, out, version: VERSION, gameRoot, bg3le });

  const pack = readJson(path.join(out, "pack.json"));
  const doc = readJson(path.join(out, "files.json"));

  assert.equal(pack.schema, 1);
  assert.equal(pack.id, PACK_ID);
  assert.equal(pack.mod.id, MOD_ID);
  assert.equal(pack.mod.version, VERSION);
  assert.equal(pack.game.id, "bg3");
  assert.equal(pack.game.appId, 1086940);
  assert.equal(pack.game.build, "25605617");
  assert.equal(pack.files, "files.json");

  // The install adapter and native template are pack data, not a game check.
  assert.equal(pack.install.type, "bg3");
  assert.equal(pack.install.label, "modsettings + script extender");
  assert.equal(pack.install.dataDir, undefined);
  assert.equal(pack.launch.profile, undefined);
  assert.equal(pack.launch.saveFile, undefined);
  assert.equal(pack.launch.type, "steam");
  assert.equal(pack.launch.mode, "default");
  assert.equal(pack.platforms["linux-native"].exe, "bin/bg3");
  assert.equal(pack.platforms["linux-native"].gameProcess, "bg3.bg3le-real");
  assert.equal(pack.platforms["linux-native"].gameProcessAlt, "bg3");
  assert.equal(pack.platforms["linux-native"].template, "games/bg3-native.sh");

  // Contents are normalized for the dashboard and the refresh script.
  assert.equal(pack.contents.count, 1);
  assert.equal(pack.contents.itemsLabel, "Included mods");
  assert.equal(pack.contents.items[0].label, "Test Mod");
  assert.equal(pack.contents.items[0].path, "Mods/TestMod_uuid.pak");
  assert.deepEqual(pack.contents.inactive, ["Extra.pak"]);

  // Preconditions gate the build the pack was made for.
  const build = pack.preconditions.find((check) => check.type === "game-build");
  assert.ok(build, "BG3 packs declare the game build");
  assert.equal(build.build, "25605617");

  assert.equal(doc.schema, 1);
  assert.equal(doc.pack, PACK_ID);
  assert.equal(doc.version, VERSION);

  const byTarget = Object.fromEntries(doc.files.map((file) => [file.target, file]));
  const prefix = `mods/${MOD_ID}/versions/${VERSION}/`;

  assert.ok(byTarget[`${prefix}Mods/TestMod_uuid.pak`], "pak payload is present");
  assert.equal(byTarget[`${prefix}Mods/TestMod_uuid.pak`].platforms, undefined);
  assert.equal(byTarget[`${prefix}modsettings.lsx`].platforms, undefined);
  assert.deepEqual(
    byTarget[`${prefix}bg3se/DWrite.dll`].platforms,
    ["windows", "linux-proton"],
  );
  assert.deepEqual(
    byTarget["tools/bg3le/build/libbg3le.so"].platforms,
    ["linux-native"],
  );
  assert.equal(byTarget["tools/bg3le/install.py"].mode, "755");
  assert.equal(byTarget["tools/bg3le/build/libbg3le.so"].mode, "644");

  for (const file of doc.files) {
    const sourceFile = path.join(out, file.source);
    assert.ok(fs.existsSync(sourceFile), `source exists: ${file.source}`);
    assert.equal(fs.statSync(sourceFile).size, file.size, `size: ${file.source}`);
    assert.equal(sha256(fs.readFileSync(sourceFile)), file.sha256, `sha256: ${file.source}`);
  }
});
