"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const h = require("../test-support/harness");
const { auditPackRoot } = require("../scripts/audit-packs");

test("a built Elden Ring pack passes the multi-platform audit", async (t) => {
  const fixture = await h.buildPackSet({ versions: ["0.2.7"] });
  t.after(() => fixture.cleanup());

  const result = auditPackRoot(fixture.packs["0.2.7"].packRoot);
  assert.deepEqual(result.errors, []);
  assert.ok(result.platforms.windows, "the pack has a Windows profile");
  assert.ok(result.platforms["linux-proton"], "the pack has a Proton profile");
});

test("a built BG3 pack passes the multi-platform audit", async (t) => {
  const source = h.bg3WorkingInstall({ version: "2026.11.21" });
  const bg3le = h.bg3leRuntime();
  const gameRoot = h.tempDir("modsync-audit-bg3-game-");
  const out = h.tempDir("modsync-audit-bg3-pack-");
  h.write(gameRoot, "bin/DWrite.dll", "dwrite");
  h.write(gameRoot, "bin/ScriptExtenderSettings.json", "{}");
  t.after(() => {
    h.remove(source);
    h.remove(bg3le);
    h.remove(gameRoot);
    h.remove(out);
  });

  await h.buildBg3Pack({
    source,
    out,
    version: "2026.11.21",
    gameRoot,
    bg3le,
  });

  const result = auditPackRoot(out);
  assert.deepEqual(result.errors, []);
  assert.ok(result.platforms.windows, "the pack has a Windows profile");
  assert.ok(result.platforms["linux-proton"], "the pack has a Proton profile");
  assert.ok(result.platforms["linux-native"], "the pack has a native Linux profile");
});
