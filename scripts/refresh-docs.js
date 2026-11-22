#!/usr/bin/env node
/**
 * Regenerate DOCS.md for every built pack without touching their contents.
 *
 *   node scripts/refresh-docs.js
 *   node scripts/refresh-docs.js --packs "D:\\ModSync\\packs"
 *   node scripts/refresh-docs.js --pack bg3-modded
 */
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { writePackDoc } = require("../dist/src/pack-docs");

const repoRoot = path.resolve(__dirname, "..");

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { pack: { type: "string" }, packs: { type: "string" } },
  });
  const packsDir = path.resolve(values.packs || path.join(repoRoot, "packs"));
  if (!fs.existsSync(packsDir)) {
    console.log(`Packs folder not found: ${packsDir}`);
    return;
  }
  let changed = 0;
  for (const entry of fs.readdirSync(packsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (values.pack && entry.name !== values.pack) continue;
    const packRoot = path.join(packsDir, entry.name);
    if (!fs.existsSync(path.join(packRoot, "pack.json"))) continue;
    try {
      writePackDoc(packRoot);
      changed++;
      console.log(`${entry.name}: docs written`);
    } catch (err) {
      console.warn(`${entry.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!changed) console.log("No packs changed.");
}

main();
