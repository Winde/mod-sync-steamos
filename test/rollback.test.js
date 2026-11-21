const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { rollback } = require("../src/installer");
const { listVersions } = require("../src/version-store");

test("rollback switches current.txt to the previous installed version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-rollback-"));
  const pack = { id: "eldenring-graceborne", name: "Graceborne", mod: { id: "graceborne" }, profilePattern: "profiles/{mod}-{version}.me3" };
  const packRoot = path.join(root, "packs", pack.id);
  fs.mkdirSync(path.join(packRoot, "mods", "graceborne", "versions", "0.2.5"), { recursive: true });
  fs.mkdirSync(path.join(packRoot, "mods", "graceborne", "versions", "0.2.7"), { recursive: true });
  fs.mkdirSync(path.join(packRoot, "profiles"), { recursive: true });
  fs.writeFileSync(path.join(packRoot, "profiles", "graceborne-0.2.5.me3"), "");
  fs.writeFileSync(path.join(packRoot, "profiles", "graceborne-0.2.7.me3"), "");
  fs.writeFileSync(path.join(packRoot, "mods", "graceborne", "current.txt"), "0.2.7\n");

  assert.deepEqual(listVersions(packRoot, pack.mod.id), ["0.2.5", "0.2.7"]);
  const result = rollback({ pack, root, log: () => {} });
  assert.equal(result.previous, "0.2.5");
  assert.equal(fs.readFileSync(path.join(packRoot, "mods", "graceborne", "current.txt"), "utf8").trim(), "0.2.5");
  fs.rmSync(root, { recursive: true, force: true });
});

test("rollback refuses when there is no previous version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-rollback-"));
  const pack = { id: "eldenring-graceborne", name: "Graceborne", mod: { id: "graceborne" }, profilePattern: "profiles/{mod}-{version}.me3" };
  const packRoot = path.join(root, "packs", pack.id);
  fs.mkdirSync(path.join(packRoot, "mods", "graceborne", "versions", "0.2.7"), { recursive: true });
  fs.mkdirSync(path.join(packRoot, "profiles"), { recursive: true });
  fs.writeFileSync(path.join(packRoot, "profiles", "graceborne-0.2.7.me3"), "");
  fs.writeFileSync(path.join(packRoot, "mods", "graceborne", "current.txt"), "0.2.7\n");
  assert.throws(() => rollback({ pack, root, log: () => {} }), /No previous/);
  fs.rmSync(root, { recursive: true, force: true });
});
