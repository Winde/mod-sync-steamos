"use strict";

/**
 * TDD slice: the version store owns the on-disk TV layout. These tests are
 * written before the module exists. They specify behavior only; the contract
 * suite still guards installer/agent behavior during the refactor.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const store = require("../src/version-store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "modsync-version-store-"));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("compareVersions orders numeric components", () => {
  assert.ok(store.compareVersions("0.2.10", "0.2.9") > 0);
  assert.ok(store.compareVersions("0.2.7", "0.2.5") > 0);
  assert.equal(store.compareVersions("0.2.7", "0.2.7"), 0);
});

test("listVersions sorts installed versions and ignores staging/backups", () => {
  const root = tempDir();
  const packRoot = store.packRoot(root, "pack");
  for (const version of ["0.2.10", "0.2.9", "0.2.5"]) {
    fs.mkdirSync(store.versionDir(packRoot, "mod", version), { recursive: true });
  }
  fs.mkdirSync(store.stagingDir(packRoot, "mod", "0.2.11"), { recursive: true });
  fs.mkdirSync(store.backupDir(packRoot, "mod", "0.2.9", "20260101-000000"), { recursive: true });
  fs.mkdirSync(store.versionDir(packRoot, "mod", ".hidden"), { recursive: true });

  assert.deepEqual(store.listVersions(packRoot, "mod"), ["0.2.5", "0.2.9", "0.2.10"]);
  cleanup(root);
});

test("the current pointer reads and writes the version", () => {
  const root = tempDir();
  const packRoot = store.packRoot(root, "pack");

  assert.equal(store.readCurrent(packRoot, "mod"), "");
  store.writeCurrent(packRoot, "mod", "0.2.7");
  assert.equal(store.readCurrent(packRoot, "mod"), "0.2.7");
  assert.equal(fs.readFileSync(store.currentFile(packRoot, "mod"), "utf8"), "0.2.7\n");
  cleanup(root);
});

test("canRollback is true only when the current version has a predecessor", () => {
  const root = tempDir();
  const packRoot = store.packRoot(root, "pack");
  for (const version of ["0.2.5", "0.2.7"]) {
    fs.mkdirSync(store.versionDir(packRoot, "mod", version), { recursive: true });
  }

  assert.equal(store.canRollback(packRoot, "mod"), false, "no current version");
  store.writeCurrent(packRoot, "mod", "0.2.5");
  assert.equal(store.canRollback(packRoot, "mod"), false, "first version");
  store.writeCurrent(packRoot, "mod", "0.2.7");
  assert.equal(store.canRollback(packRoot, "mod"), true, "second version");
  cleanup(root);
});

test("path helpers match the TV layout", () => {
  const root = tempDir();
  const packRoot = store.packRoot(root, "eldenring-graceborne");

  assert.equal(packRoot, path.join(root, "packs", "eldenring-graceborne"));
  assert.equal(
    store.currentFile(packRoot, "graceborne"),
    path.join(packRoot, "mods", "graceborne", "current.txt"),
  );
  assert.equal(
    store.versionDir(packRoot, "graceborne", "0.2.7"),
    path.join(packRoot, "mods", "graceborne", "versions", "0.2.7"),
  );
  assert.equal(
    store.stagingDir(packRoot, "graceborne", "0.2.7"),
    path.join(packRoot, "mods", "graceborne", "versions", ".staging-0.2.7"),
  );
  assert.equal(
    store.backupDir(packRoot, "graceborne", "0.2.7", "20260101-000000"),
    path.join(packRoot, "mods", "graceborne", "versions", "0.2.7.bak-20260101-000000"),
  );
  assert.equal(
    store.profileFile(packRoot, "graceborne", "0.2.7"),
    path.join(packRoot, "profiles", "graceborne-0.2.7.me3"),
  );
  assert.equal(
    store.launcherFile(packRoot, "graceborne"),
    path.join(packRoot, "launchers", "launch-graceborne.sh"),
  );
  assert.equal(
    store.filesDocFile(packRoot, { files: "files.json" }),
    path.join(packRoot, "files.json"),
  );
  assert.equal(store.payloadPrefix("graceborne", "0.2.7"), "mods/graceborne/versions/0.2.7/");
  cleanup(root);
});
