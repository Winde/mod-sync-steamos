#!/usr/bin/env node
/**
 * Refresh the normalized `contents` block in built packs from the current
 * source installs. The game driver owns discovery; this only wires it up.
 *
 *   node scripts/refresh-contents.js
 *   node scripts/refresh-contents.js --pack eldenring-graceborne
 *   node scripts/refresh-contents.js --source "D:\EldenRingMods"
 */
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { loadRecipe } = require("../src/recipes");
const { driverFor } = require("../src/drivers");
const bg3 = require("../src/drivers/bg3");

const repoRoot = path.resolve(__dirname, "..");

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { pack: { type: "string" }, source: { type: "string" }, packs: { type: "string" } },
  });
  const packsDir = path.resolve(values.packs || path.join(repoRoot, "packs"));
  const entries = fs.existsSync(packsDir)
    ? fs.readdirSync(packsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    : [];
  let changed = 0;
  for (const entry of entries) {
    if (values.pack && entry.name !== values.pack) continue;
    const packRoot = path.join(packsDir, entry.name);
    const packFile = path.join(packRoot, "pack.json");
    if (!fs.existsSync(packFile)) continue;
    const pack = JSON.parse(fs.readFileSync(packFile, "utf8"));
    let recipe;
    try { recipe = loadRecipe(pack.id); } catch {
      console.log(`${pack.id}: no recipe, skipped`);
      continue;
    }
    const driver = driverFor(pack.game.id);
    const source = values.source || driver.defaultSource();
    const contents = pack.game.id === "bg3"
      ? bg3.discover(source)
      : driver.contentsFor(recipe, source, pack.mod.version);
    pack.contents = contents;
    fs.writeFileSync(packFile, JSON.stringify(pack, null, 2) + "\n");
    changed++;
    console.log(`${pack.id}: ${contents.kind} ${contents.count} (${contents.paks ?? contents.packages?.length ?? 0} files)`);
  }
  if (!changed) console.log("No packs changed.");
}

main();
