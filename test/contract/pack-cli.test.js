"use strict";

/**
 * Contract: `modsync pack` turns a working install into a pack that the
 * repository can serve. These assertions describe the pack format, not the
 * driver implementation, so the driver can be refactored freely.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  readJson,
  remove,
  runCli,
  sha256,
  tempDir,
  workingInstall,
} = require("../../test-support/harness");

test("pack CLI produces a complete pack contract", { timeout: 60000 }, async (t) => {
  const source = workingInstall({ versions: ["0.2.5", "0.2.7"] });
  const out = tempDir("modsync-pack-");
  t.after(() => {
    remove(source);
    remove(out);
  });

  const result = await runCli([
    "pack",
    "--source", source,
    "--out", out,
    "--version", "0.2.7",
  ]);

  assert.match(result.stdout, /Hardlinking \d+\/\d+/);
  assert.match(result.stdout, /Hashing \d+\/\d+ \(\d+%\)/);

  const pack = readJson(path.join(out, "pack.json"));
  const doc = readJson(path.join(out, "files.json"));

  assert.equal(pack.schema, 1);
  assert.equal(pack.id, "eldenring-graceborne");
  assert.equal(pack.name, "Graceborne");
  assert.equal(pack.mod.version, "0.2.7");
  assert.equal(pack.game.appId, 1245620);
  assert.equal(pack.game.build, "25827938");
  assert.equal(pack.files, "files.json");
  assert.ok(Array.isArray(pack.notes) && pack.notes.length > 0);

  const checks = Object.fromEntries(pack.preconditions.map((check) => [check.type, check]));
  for (const type of ["game-installed", "game-build", "game-not-running", "disk-free"]) {
    assert.equal(checks[type]?.required, true, `expected required precondition ${type}`);
  }
  assert.equal(checks["game-build"].build, "25827938");

  assert.equal(doc.schema, 1);
  assert.equal(doc.pack, pack.id);
  assert.equal(doc.version, "0.2.7");
  assert.ok(Array.isArray(doc.files) && doc.files.length > 0);

  const byTarget = Object.fromEntries(doc.files.map((file) => [file.target, file]));

  const payloadTarget = "mods/graceborne/versions/0.2.7/mod/regulation.bin";
  const payload = byTarget[payloadTarget];
  assert.ok(payload, "payload file is present in files.json");
  assert.equal(payload.source, "payload/versions/0.2.7/mod/regulation.bin");
  assert.equal(payload.size, fs.statSync(path.join(out, payload.source)).size);
  assert.equal(payload.sha256, sha256(fs.readFileSync(path.join(out, payload.source))));
  assert.match(payload.sha256, /^[0-9a-f]{64}$/);

  assert.equal(
    byTarget["profiles/graceborne-0.2.7.me3"].source,
    "profiles/graceborne-0.2.7.me3",
  );
  assert.equal(
    byTarget["art/graceborne/grid.png"].source,
    "art/graceborne/grid.png",
  );

  for (const file of doc.files) {
    const sourceFile = path.join(out, file.source);
    assert.ok(fs.existsSync(sourceFile), `source exists: ${file.source}`);
    assert.ok(!path.isAbsolute(file.target), `target is relative: ${file.target}`);
    assert.ok(!file.target.split("/").includes(".."), `target has no traversal: ${file.target}`);
    assert.equal(fs.statSync(sourceFile).size, file.size, `size: ${file.source}`);
    assert.equal(sha256(fs.readFileSync(sourceFile)), file.sha256, `sha256: ${file.source}`);
  }
});

test("pack CLI builds a requested older version", { timeout: 60000 }, async (t) => {
  const source = workingInstall({ versions: ["0.2.5", "0.2.7"] });
  const out = tempDir("modsync-pack-older-");
  t.after(() => {
    remove(source);
    remove(out);
  });

  await runCli([
    "pack",
    "--source", source,
    "--out", out,
    "--version", "0.2.5",
  ]);

  const pack = readJson(path.join(out, "pack.json"));
  const doc = readJson(path.join(out, "files.json"));

  assert.equal(pack.mod.version, "0.2.5");
  assert.equal(doc.version, "0.2.5");
  assert.ok(doc.files.some((file) => file.target === "mods/graceborne/versions/0.2.5/mod/regulation.bin"));
  assert.ok(!doc.files.some((file) => file.target.includes("/0.2.7/")));
});

test("pack CLI fails when the source install is missing", { timeout: 60000 }, async (t) => {
  const root = tempDir("modsync-pack-missing-");
  t.after(() => remove(root));

  await assert.rejects(
    runCli([
      "pack",
      "--source", path.join(root, "missing"),
      "--out", path.join(root, "pack"),
      "--version", "0.2.7",
    ]),
  );
});
