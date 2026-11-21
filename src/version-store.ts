"use strict";

/**
 * The on-disk TV layout lives here.
 *
 * The launcher and rollback already depend on this layout, so keeping it in one
 * module prevents installer, agent, storage, and scripts from inventing their
 * own paths. No behavior is implemented here beyond reading/writing the layout.
 */

import fs from "node:fs";
import path from "node:path";
import { readText, writeText } from "./util";

const STAGING_PREFIX = ".staging-";
const BACKUP_MARK = ".bak-";

interface PackRef {
  files?: string;
  profilePattern?: string;
  mod: { id: string };
}

export function packsDir(root: string): string {
  return path.join(root, "packs");
}

export function packRoot(root: string, packId: string): string {
  return path.join(packsDir(root), packId);
}

export function packFile(packRoot: string): string {
  return path.join(packRoot, "pack.json");
}

export function filesDocFile(packRoot: string, pack?: PackRef | null): string {
  return path.join(packRoot, (pack && pack.files) || "files.json");
}

export function modDir(packRoot: string, modId: string): string {
  return path.join(packRoot, "mods", modId);
}

export function versionsDir(packRoot: string, modId: string): string {
  return path.join(modDir(packRoot, modId), "versions");
}

export function versionDir(packRoot: string, modId: string, version: string): string {
  return path.join(versionsDir(packRoot, modId), version);
}

export function stagingDir(packRoot: string, modId: string, version: string): string {
  return path.join(versionsDir(packRoot, modId), `${STAGING_PREFIX}${version}`);
}

export function backupDir(packRoot: string, modId: string, version: string, stamp: string): string {
  return `${versionDir(packRoot, modId, version)}${BACKUP_MARK}${stamp}`;
}

export function currentFile(packRoot: string, modId: string): string {
  return path.join(modDir(packRoot, modId), "current.txt");
}

export function readCurrent(packRoot: string, modId: string): string {
  return readText(currentFile(packRoot, modId)).trim();
}

export function writeCurrent(packRoot: string, modId: string, version: string): void {
  writeText(currentFile(packRoot, modId), `${version}\n`);
}

export function profileFile(packRoot: string, pack: PackRef | null | undefined, version: string): string | null {
  if (!pack || !pack.profilePattern) return null;
  const rel = pack.profilePattern
    .replace(/\{mod\}/g, pack.mod.id)
    .replace(/\{version\}/g, version);
  return path.join(packRoot, rel);
}

export function launcherFile(packRoot: string, modId: string): string {
  return path.join(packRoot, "launchers", `launch-${modId}.sh`);
}

export function payloadPrefix(modId: string, version: string): string {
  return `mods/${modId}/versions/${version}/`;
}

export function isStaging(name: string): boolean {
  return String(name).startsWith(STAGING_PREFIX);
}

export function isBackup(name: string): boolean {
  return String(name).includes(BACKUP_MARK);
}

function semverParts(version: string): number[] {
  return String(version).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

export function listVersions(packRoot: string, modId: string): string[] {
  const dir = versionsDir(packRoot, modId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !isBackup(name))
    .sort(compareVersions);
}

export function canRollback(packRoot: string, modId: string): boolean {
  const current = readCurrent(packRoot, modId);
  if (!current) return false;
  return listVersions(packRoot, modId).indexOf(current) > 0;
}

export {
  BACKUP_MARK,
  STAGING_PREFIX,
};
