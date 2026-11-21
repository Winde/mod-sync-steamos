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
const { loadRecipe } = require("../dist/src/recipes");
const { driverFor } = require("../dist/src/drivers");

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
    const contents = driver.contentsFor({
      recipe,
      source,
      version: pack.mod.version,
    });
    pack.contents = contents;
    fs.writeFileSync(packFile, JSON.stringify(pack, null, 2) + "\n");
    changed++;
    const itemCount = contents.items?.length ?? 0;
    console.log(`${pack.id}: ${contents.count} items (${itemCount} files)`);
  }
  if (!changed) console.log("No packs changed.");
}

main();
