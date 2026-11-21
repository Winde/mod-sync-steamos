const test = require("node:test");
const assert = require("node:assert/strict");
const { validateFiles } = require("../src/manifest");

function pack() {
  return {
    id: "test",
    platforms: { "linux-proton": { exe: "bin/game.exe", gameProcess: "game.exe" } },
  };
}

function doc(files) {
  return { schema: 1, pack: "test", version: "1", files };
}

function file(target, extra = {}) {
  return { source: "payload/a", target, size: 1, sha256: "a".repeat(64), ...extra };
}

test("pack targets must be portable across Linux and Windows", () => {
  assert.throws(() => validateFiles(doc([file("mods\\a.pak")]), pack()), /forward slashes/);
  assert.throws(() => validateFiles(doc([file("mods/../a.pak")]), pack()), /invalid target/);
  assert.throws(() => validateFiles(doc([file("mods/a:b.pak")]), pack()), /Windows-invalid/);
  assert.throws(() => validateFiles(doc([file("mods/CON.txt")]), pack()), /Windows-reserved/);
  assert.throws(() => validateFiles(doc([file("mods/a.")]), pack()), /dot or space/);
});

test("case-insensitive target collisions are rejected before a pack is served", () => {
  assert.throws(
    () => validateFiles(doc([file("Mods/A.pak"), file("mods/a.pak")]), pack()),
    /case-insensitive/,
  );
});

test("platform tags must name known variants", () => {
  assert.throws(
    () => validateFiles(doc([file("mods/a.pak", { platforms: ["dos"] })]), pack()),
    /unknown platform/,
  );
  const loaded = validateFiles(doc([file("mods/a.pak", { platforms: ["windows"] })]), pack());
  assert.deepEqual(loaded.files[0].platforms, ["windows"]);
});
