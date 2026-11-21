const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { computeStorage, clearStorage } = require("../src/storage");

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-storage-"));
  const packRoot = path.join(root, "packs", "demo");
  const versions = path.join(packRoot, "mods", "demo", "versions");
  fs.mkdirSync(path.join(versions, "1"), { recursive: true });
  fs.mkdirSync(path.join(versions, "2"), { recursive: true });
  fs.writeFileSync(path.join(packRoot, "pack.json"), JSON.stringify({
    id: "demo",
    name: "Demo",
    mod: { id: "demo", version: "2" },
    profilePattern: "profiles/{mod}-{version}.me3",
  }));
  fs.writeFileSync(path.join(versions, "1", "a.bin"), Buffer.alloc(100, 1));
  fs.writeFileSync(path.join(versions, "2", "b.bin"), Buffer.alloc(200, 2));
  fs.mkdirSync(path.join(packRoot, "profiles"), { recursive: true });
  fs.writeFileSync(path.join(packRoot, "profiles", "demo-1.me3"), "one");
  fs.writeFileSync(path.join(packRoot, "profiles", "demo-2.me3"), "two");
  fs.writeFileSync(path.join(packRoot, "mods", "demo", "current.txt"), "2\n");
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, "logs", "agent.log"), "log line\n");
  return { root, packRoot, versions };
}

test("storage reports versions, current, and old bytes", () => {
  const { root } = setup();
  const s = computeStorage(root);
  assert.equal(s.packs.length, 1);
  assert.equal(s.packs[0].currentVersion, "2");
  assert.equal(s.packs[0].versions.length, 2);
  assert.ok(s.packs[0].totalBytes > 300);
  assert.ok(s.packs[0].oldBytes >= 100);
  assert.ok(s.logsBytes > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("clear staging removes only partial downloads", () => {
  const { root, versions } = setup();
  fs.mkdirSync(path.join(versions, ".staging-2"), { recursive: true });
  fs.writeFileSync(path.join(versions, ".staging-2", "part.bin"), Buffer.alloc(50, 3));
  assert.ok(computeStorage(root).packs[0].stagingBytes > 0);
  const out = clearStorage(root, { packId: "demo", scope: "staging" });
  assert.ok(out.freedBytes > 0);
  assert.equal(computeStorage(root).packs[0].stagingBytes, 0);
  assert.ok(fs.existsSync(path.join(versions, "2")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("remove old versions keeps the current version and its profile", () => {
  const { root, packRoot, versions } = setup();
  const out = clearStorage(root, { packId: "demo", scope: "old-versions" });
  assert.ok(out.freedBytes >= 100);
  assert.equal(fs.existsSync(path.join(versions, "1")), false);
  assert.ok(fs.existsSync(path.join(versions, "2")));
  assert.equal(fs.existsSync(path.join(packRoot, "profiles", "demo-1.me3")), false);
  assert.ok(fs.existsSync(path.join(packRoot, "profiles", "demo-2.me3")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("remove pack deletes only the pack root", () => {
  const { root, packRoot } = setup();
  const out = clearStorage(root, { packId: "demo", scope: "pack" });
  assert.ok(out.freedBytes > 0);
  assert.equal(fs.existsSync(packRoot), false);
  assert.ok(fs.existsSync(path.join(root, "logs", "agent.log")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("clear logs keeps packs", () => {
  const { root, packRoot } = setup();
  const out = clearStorage(root, { scope: "logs" });
  assert.ok(out.freedBytes > 0);
  assert.ok(fs.existsSync(packRoot));
  assert.equal(computeStorage(root).logsBytes, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("invalid pack ids are rejected", () => {
  const { root } = setup();
  assert.throws(() => clearStorage(root, { packId: "../x", scope: "pack" }), /invalid pack id/);
  fs.rmSync(root, { recursive: true, force: true });
});
