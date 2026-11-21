"use strict";

/**
 * The on-disk TV layout lives here.
 *
 * The launcher and rollback already depend on this layout, so keeping it in one
 * module prevents installer, agent, storage, and scripts from inventing their
 * own paths. No behavior is implemented here beyond reading/writing the layout.
 */

const fs = require("node:fs");
const path = require("node:path");
const { readText, writeText } = require("./util");

const STAGING_PREFIX = ".staging-";
const BACKUP_MARK = ".bak-";

function packsDir(root) {
  return path.join(root, "packs");
}

function packRoot(root, packId) {
  return path.join(packsDir(root), packId);
}

function packFile(packRoot) {
  return path.join(packRoot, "pack.json");
}

function filesDocFile(packRoot, pack) {
  return path.join(packRoot, (pack && pack.files) || "files.json");
}

function modDir(packRoot, modId) {
  return path.join(packRoot, "mods", modId);
}

function versionsDir(packRoot, modId) {
  return path.join(modDir(packRoot, modId), "versions");
}

function versionDir(packRoot, modId, version) {
  return path.join(versionsDir(packRoot, modId), version);
}

function stagingDir(packRoot, modId, version) {
  return path.join(versionsDir(packRoot, modId), `${STAGING_PREFIX}${version}`);
}

function backupDir(packRoot, modId, version, stamp) {
  return `${versionDir(packRoot, modId, version)}${BACKUP_MARK}${stamp}`;
}

function currentFile(packRoot, modId) {
  return path.join(modDir(packRoot, modId), "current.txt");
}

function readCurrent(packRoot, modId) {
  return readText(currentFile(packRoot, modId)).trim();
}

function writeCurrent(packRoot, modId, version) {
  writeText(currentFile(packRoot, modId), `${version}\n`);
}

function profileFile(packRoot, modId, version) {
  return path.join(packRoot, "profiles", `${modId}-${version}.me3`);
}

function launcherFile(packRoot, modId) {
  return path.join(packRoot, "launchers", `launch-${modId}.sh`);
}

function payloadPrefix(modId, version) {
  return `mods/${modId}/versions/${version}/`;
}

function isStaging(name) {
  return String(name).startsWith(STAGING_PREFIX);
}

function isBackup(name) {
  return String(name).includes(BACKUP_MARK);
}

function semverParts(version) {
  return String(version).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function listVersions(packRoot, modId) {
  const dir = versionsDir(packRoot, modId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !isBackup(name))
    .sort(compareVersions);
}

function canRollback(packRoot, modId) {
  const current = readCurrent(packRoot, modId);
  if (!current) return false;
  return listVersions(packRoot, modId).indexOf(current) > 0;
}

module.exports = {
  BACKUP_MARK,
  STAGING_PREFIX,
  backupDir,
  canRollback,
  compareVersions,
  currentFile,
  filesDocFile,
  isBackup,
  isStaging,
  launcherFile,
  listVersions,
  modDir,
  packFile,
  packRoot,
  packsDir,
  payloadPrefix,
  profileFile,
  readCurrent,
  stagingDir,
  versionDir,
  versionsDir,
  writeCurrent,
};
