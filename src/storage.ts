import fs from "node:fs";
import path from "node:path";
import { readJson, freeBytes } from "./util";
import * as versionStore from "./version-store";
import * as installers from "./installers";
import * as linux from "./platforms/linux";
import type {
  ClearPlan,
  ClearResult,
  Pack,
  PackStorage,
  StorageReport,
  StorageVersion,
} from "./types";

export function dirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirBytes(abs);
      else if (entry.isFile()) total += fs.statSync(abs).size;
    } catch { /* skip files that vanished mid-scan */ }
  }
  return total;
}

function modIdFor(packRoot: string, pack: Pack | null): string {
  if (pack && pack.mod && pack.mod.id) return pack.mod.id;
  const modsDir = path.join(packRoot, "mods");
  if (!fs.existsSync(modsDir)) return "";
  const first = fs.readdirSync(modsDir, { withFileTypes: true }).find((e) => e.isDirectory());
  return first ? first.name : "";
}

export function packStorage(packRoot: string): PackStorage {
  let pack: Pack | null = null;
  try { pack = readJson<Pack>(versionStore.packFile(packRoot)); } catch { /* pack.json is optional for a damaged pack */ }
  const id = pack && pack.id ? pack.id : path.basename(packRoot);
  const modId = modIdFor(packRoot, pack);
  const versionsDir = modId ? versionStore.versionsDir(packRoot, modId) : "";
  const current = modId ? versionStore.readCurrent(packRoot, modId) : "";
  const totalBytes = dirBytes(packRoot);

  const versions: StorageVersion[] = [];
  let stagingBytes = 0;
  let backupBytes = 0;
  if (versionsDir && fs.existsSync(versionsDir)) {
    for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(versionsDir, entry.name);
      const bytes = dirBytes(abs);
      if (versionStore.isStaging(entry.name)) stagingBytes += bytes;
      else if (versionStore.isBackup(entry.name)) backupBytes += bytes;
      else versions.push({ version: entry.name, bytes, current: entry.name === current });
    }
  }
  versions.sort((a, b) => versionStore.compareVersions(a.version, b.version));

  const versionsBytes = versions.reduce((n, v) => n + v.bytes, 0);
  const oldBytes = versions.filter((v) => !v.current).reduce((n, v) => n + v.bytes, 0) + backupBytes;
  const otherBytes = Math.max(0, totalBytes - versionsBytes - stagingBytes - backupBytes);

  return {
    id,
    name: pack && pack.name ? pack.name : id,
    modId,
    installed: !!current,
    currentVersion: current || null,
    totalBytes,
    versionsBytes,
    stagingBytes,
    backupBytes,
    oldBytes,
    otherBytes,
    versions,
  };
}

export function computeStorage(root: string): StorageReport {
  const packsDir = versionStore.packsDir(root);
  const packs: PackStorage[] = [];
  if (fs.existsSync(packsDir)) {
    for (const entry of fs.readdirSync(packsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      packs.push(packStorage(path.join(packsDir, entry.name)));
    }
  }
  packs.sort((a, b) => a.name.localeCompare(b.name));
  const packsBytes = packs.reduce((n, p) => n + p.totalBytes, 0);
  const logsBytes = dirBytes(path.join(root, "logs"));
  const rootBytes = dirBytes(root);
  return {
    freeBytes: freeBytes(root),
    rootBytes,
    packsBytes,
    logsBytes,
    otherBytes: Math.max(0, rootBytes - packsBytes - logsBytes),
    packs,
  };
}

function validPackId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9._-]+$/.test(id) && path.basename(id) === id;
}

function removeProfile(packRoot: string, pack: Pack | null, version: string): void {
  if (!pack || !version) return;
  const profile = versionStore.profileFile(packRoot, pack, version);
  if (profile && fs.existsSync(profile)) fs.rmSync(profile, { force: true });
}

export function planClear(root: string, { packId, scope }: { packId?: string; scope: string }): ClearPlan {
  if (scope === "logs") {
    return { ok: true, scope, actions: ["Clear the log files"], errors: [], warnings: [] };
  }
  if (!validPackId(packId)) throw new Error("invalid pack id");
  const packRoot = versionStore.packRoot(root, packId);
  if (!fs.existsSync(packRoot)) throw new Error(`Pack is not installed: ${packId}`);
  let pack: Pack | null = null;
  try { pack = readJson<Pack>(versionStore.packFile(packRoot)); } catch { /* use the folder name */ }

  if (scope === "pack") {
    const adapter = pack ? installers.forPack(pack) : null;
    if (pack && adapter && adapter.plan) {
      const plan = adapter.plan({ pack, root });
      return { ...plan, scope, packId };
    }
    return {
      ok: true,
      scope,
      packId,
      actions: [`Delete the pack directory ${packRoot}`],
      errors: [],
      warnings: [],
    };
  }
  if (scope === "staging" || scope === "old-versions") {
    return {
      ok: true,
      scope,
      packId,
      actions: [scope === "staging" ? "Remove partial downloads" : "Remove kept old versions"],
      errors: [],
      warnings: [],
    };
  }
  throw new Error(`unknown scope: ${scope}`);
}

export function clearStorage(root: string, { packId, scope }: { packId?: string; scope: string }): ClearResult {
  if (scope === "logs") {
    const logs = path.join(root, "logs");
    const before = dirBytes(logs);
    if (fs.existsSync(logs)) {
      for (const entry of fs.readdirSync(logs, { withFileTypes: true })) {
        fs.rmSync(path.join(logs, entry.name), { recursive: true, force: true });
      }
    }
    return { freedBytes: before, scope };
  }

  if (!validPackId(packId)) throw new Error("invalid pack id");
  const packRoot = versionStore.packRoot(root, packId);
  if (!fs.existsSync(packRoot)) throw new Error(`Pack is not installed: ${packId}`);
  let pack: Pack | null = null;
  try { pack = readJson<Pack>(versionStore.packFile(packRoot)); } catch { /* use the folder name */ }
  const modId = modIdFor(packRoot, pack);
  const versionsDir = modId ? versionStore.versionsDir(packRoot, modId) : "";
  const current = modId ? versionStore.readCurrent(packRoot, modId) : "";
  const before = dirBytes(packRoot);

  if (scope === "staging") {
    if (versionsDir && fs.existsSync(versionsDir)) {
      for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
        if (versionStore.isStaging(entry.name)) {
          fs.rmSync(path.join(versionsDir, entry.name), { recursive: true, force: true });
        }
      }
    }
  } else if (scope === "old-versions") {
    if (!current) throw new Error("No current version; refusing to remove versions.");
    if (versionsDir && fs.existsSync(versionsDir)) {
      for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === current) continue;
        if (versionStore.isStaging(entry.name)) continue;
        fs.rmSync(path.join(versionsDir, entry.name), { recursive: true, force: true });
        if (!versionStore.isBackup(entry.name)) removeProfile(packRoot, pack, entry.name);
      }
    }
  } else if (scope === "pack") {
    const plan = planClear(root, { packId, scope });
    if (!plan.ok) throw new Error(`Uninstall preflight failed: ${plan.errors.join("; ")}`);
    const adapter = pack ? installers.forPack(pack) : null;
    if (pack && adapter && adapter.revert) {
      // If the game-side revert fails, keep the pack root and its backups so
      // the user can retry instead of losing the only record of applied files.
      adapter.revert({ pack, root, log: () => { } });
    }
    fs.rmSync(packRoot, { recursive: true, force: true });
    linux.removeDesktopShortcuts(modId);
  } else {
    throw new Error(`unknown scope: ${scope}`);
  }

  const after = fs.existsSync(packRoot) ? dirBytes(packRoot) : 0;
  return { freedBytes: Math.max(0, before - after), scope, packId };
}
