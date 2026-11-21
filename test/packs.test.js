const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { auditPackRoot } = require("../scripts/audit-packs");

const packsDir = path.resolve(__dirname, "..", "packs");

for (const id of ["bg3-modded", "eldenring-graceborne"]) {
  test(`the committed ${id} pack passes the multi-platform audit`, () => {
    const root = path.join(packsDir, id);
    if (!fs.existsSync(path.join(root, "pack.json"))) return;
    const result = auditPackRoot(root);
    assert.deepEqual(result.errors, []);
    assert.ok(result.platforms.windows, "the pack has a Windows profile");
    assert.ok(result.platforms["linux-proton"], "the pack has a Proton profile");
  });
}
