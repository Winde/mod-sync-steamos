const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { validatePack, validateFiles } = require("../src/manifest");
const { safeJoin, formatBytes } = require("../src/util");
const { compareVersions } = require("../src/installer");
const { shortcutId } = require("../src/steam");
const { parseRange } = require("../src/server");

const pack = {
  schema: 1,
  id: "eldenring-graceborne",
  name: "Graceborne",
  game: { id: "eldenring", title: "ELDEN RING", store: "steam", appId: 1245620, installDir: "ELDEN RING", build: "25827938", version: "1.17", prefix: true },
  mod: { id: "graceborne", version: "0.2.7" },
  launch: { type: "me3", exe: "Game/eldenring.exe", gameProcess: "eldenring.exe", steamAppId: 1245620, profile: "profiles/graceborne-0.2.7.me3", saveFile: "ER0000.graceborne.sl2", me3: "tools/me3-linux/bin/me3", windowsBinaries: "tools/me3-linux/win64" },
  art: { grid: "art/graceborne/grid.png", hero: "art/graceborne/hero.png", logo: "art/graceborne/logo.png", icon: "art/graceborne/icon.png" },
  files: "files.json",
};

test("manifest validates a Graceborne pack", () => {
  assert.equal(validatePack(pack).id, "eldenring-graceborne");
});

test("files manifest validates and rejects bad hashes", () => {
  const files = { schema: 1, pack: pack.id, version: "0.2.7", files: [{ source: "payload/a", target: "mods/a", size: 1, sha256: "a".repeat(64) }] };
  assert.equal(validateFiles(files, pack).files.length, 1);
  files.files[0].sha256 = "nope";
  assert.throws(() => validateFiles(files, pack), /sha256/);
});

test("safeJoin blocks traversal", () => {
  assert.throws(() => safeJoin("C:\\root", "../evil"), /escapes/);
  assert.equal(safeJoin("C:\\root", "a/b"), path.resolve("C:\\root", "a/b"));
});

test("version ordering", () => {
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
  assert.ok(compareVersions("0.2.7", "0.2.5") > 0);
});

test("shortcut ids are stable and unsigned", () => {
  const id = shortcutId('"C:\\launchers\\Graceborne.cmd"Graceborne');
  assert.ok(Number.isInteger(id.unsigned));
  assert.ok(id.unsigned > 0);
  assert.equal(typeof id.signed, "number");
});

test("formatBytes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.match(formatBytes(1024 * 1024), /MB/);
});

test("HTTP Range parsing supports resume", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=100-", 1000), { start: 100, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=900-2000", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=1000-", 1000), { invalid: true });
  assert.deepEqual(parseRange("chunks=1-2", 1000), { invalid: true });
  assert.equal(parseRange(null, 1000), null);
});
