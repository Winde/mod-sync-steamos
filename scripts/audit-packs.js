"use strict";

/**
 * Audit built packs for multi-platform mistakes before serving them.
 *
 * Checks that each platform profile exists, that its loader files are present
 * in that platform's download set, that path profiles are portable, and that
 * no target would break on Windows.
 */

const fs = require("node:fs");
const path = require("node:path");
const { loadPack } = require("../src/manifest");
const paths = require("../src/paths");

const EXECUTABLES = new Set(["tools/me3-linux/bin/me3"]);

function executableExpected(target) {
  return target.endsWith(".sh") || EXECUTABLES.has(target);
}

function auditPackRoot(packRoot) {
  const { pack, files } = loadPack(packRoot);
  const errors = [];
  const warnings = [];
  const platforms = {};

  const variants = Object.keys(pack.platforms || {});
  if (!variants.length) errors.push("pack has no platform profiles");
  for (const variant of variants) {
    const selected = paths.filesFor(files.files, variant);
    const targets = new Set(selected.map((file) => file.target));
    const profile = pack.platforms[variant];

    for (const key of ["dataDir", "saveDir"]) {
      const value = profile[key];
      if (value && !value.startsWith("%") && !path.isAbsolute(value)) {
        errors.push(`${variant}: ${key} must be absolute or start with a path token: ${value}`);
      }
    }

    if (profile.loader) {
      if (!targets.has(profile.loader)) {
        errors.push(`${variant}: loader is not downloaded for this platform: ${profile.loader}`);
      } else if (variant.startsWith("linux") && !executableExpected(profile.loader)) {
        errors.push(`${variant}: loader has no executable mode: ${profile.loader}`);
      }
    }

    if (profile.windowsBinaries) {
      for (const name of ["me3-launcher.exe", "me3_mod_host.dll"]) {
        const target = `${profile.windowsBinaries.replace(/\/+$/, "")}/${name}`;
        if (!targets.has(target)) errors.push(`${variant}: windowsBinaries is missing ${target}`);
      }
    }

    for (const file of selected) {
      if (executableExpected(file.target) && file.mode !== "755") {
        errors.push(`${variant}: ${file.target} should have mode 755`);
      }
      for (const tag of file.platforms || []) {
        if (!variants.includes(tag)) warnings.push(`${file.target} is tagged for unused platform ${tag}`);
      }
    }

    platforms[variant] = {
      files: selected.length,
      totalBytes: selected.reduce((n, file) => n + (file.size || 0), 0),
    };
  }

  const byHash = new Map();
  for (const file of files.files) {
    const group = byHash.get(file.sha256) || [];
    group.push(file);
    byHash.set(file.sha256, group);
  }
  const duplicates = [];
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const sources = new Set(group.map((file) => file.source));
    if (sources.size < 2) continue;
    duplicates.push({
      targets: group.map((file) => file.target),
      wastedBytes: group[0].size * (sources.size - 1),
    });
  }
  if (duplicates.length) {
    const wasted = duplicates.reduce((n, group) => n + group.wastedBytes, 0);
    warnings.push(`${duplicates.length} duplicate content group(s), ${wasted} duplicate bytes`);
  }

  return { pack, files, platforms, duplicates, errors, warnings };
}

function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function main() {
  const packsDir = path.resolve(__dirname, "..", "packs");
  const roots = fs.existsSync(packsDir)
    ? fs.readdirSync(packsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(packsDir, entry.name, "pack.json")))
      .map((entry) => path.join(packsDir, entry.name))
    : [];
  if (!roots.length) {
    console.log("No built packs.");
    return;
  }
  let failed = false;
  for (const root of roots) {
    try {
      const result = auditPackRoot(root);
      console.log(`${result.pack.name} ${result.pack.mod.version} (${result.pack.id})`);
      for (const [variant, stats] of Object.entries(result.platforms)) {
        console.log(`  ${variant}: ${stats.files} files, ${formatBytes(stats.totalBytes)}`);
      }
      for (const warning of result.warnings) console.log(`  warning: ${warning}`);
      for (const error of result.errors) console.log(`  ERROR: ${error}`);
      if (result.errors.length) failed = true;
    } catch (err) {
      console.log(`${path.basename(root)}: INVALID (${err.message})`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { auditPackRoot };
