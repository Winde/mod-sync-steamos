const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readJson, readText, freeBytes } = require("./util");

function dirBytes(dir) {
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

function modIdFor(packRoot, pack) {
  if (pack && pack.mod && pack.mod.id) return pack.mod.id;
  const modsDir = path.join(packRoot, "mods");
  if (!fs.existsSync(modsDir)) return "";
  const first = fs.readdirSync(modsDir, { withFileTypes: true }).find((e) => e.isDirectory());
  return first ? first.name : "";
}

function packStorage(packRoot) {
  let pack = null;
  try { pack = readJson(path.join(packRoot, "pack.json")); } catch { }
  const id = pack && pack.id ? pack.id : path.basename(packRoot);
  const modId = modIdFor(packRoot, pack);
  const versionsDir = modId ? path.join(packRoot, "mods", modId, "versions") : "";
  const current = modId ? readText(path.join(packRoot, "mods", modId, "current.txt")).trim() : "";
  const totalBytes = dirBytes(packRoot);

  const versions = [];
  let stagingBytes = 0;
  let backupBytes = 0;
  if (versionsDir && fs.existsSync(versionsDir)) {
    for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(versionsDir, entry.name);
      const bytes = dirBytes(abs);
      if (entry.name.startsWith(".staging-")) stagingBytes += bytes;
      else if (entry.name.includes(".bak-")) backupBytes += bytes;
      else versions.push({ version: entry.name, bytes, current: entry.name === current });
    }
  }
  versions.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));

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

function computeStorage(root) {
  const packsDir = path.join(root, "packs");
  const packs = [];
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

function validPackId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9._-]+$/.test(id) && path.basename(id) === id;
}

function removeProfile(packRoot, modId, version) {
  if (!modId || !version) return;
  const profile = path.join(packRoot, "profiles", `${modId}-${version}.me3`);
  if (fs.existsSync(profile)) fs.rmSync(profile, { force: true });
}

function removeDesktopShortcuts(modId) {
  if (process.platform !== "linux" || !modId) return;
  for (const file of [
    path.join(os.homedir(), ".local", "share", "applications", `${modId}.desktop`),
    path.join(os.homedir(), "Desktop", `${modId}.desktop`),
  ]) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
}

function clearStorage(root, { packId, scope }) {
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
  const packRoot = path.join(root, "packs", packId);
  if (!fs.existsSync(packRoot)) throw new Error(`Pack is not installed: ${packId}`);
  let pack = null;
  try { pack = readJson(path.join(packRoot, "pack.json")); } catch { }
  const modId = modIdFor(packRoot, pack);
  const versionsDir = modId ? path.join(packRoot, "mods", modId, "versions") : "";
  const current = modId ? readText(path.join(packRoot, "mods", modId, "current.txt")).trim() : "";
  const before = dirBytes(packRoot);

  if (scope === "staging") {
    if (versionsDir && fs.existsSync(versionsDir)) {
      for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
        if (entry.name.startsWith(".staging-")) {
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
        if (entry.name.startsWith(".staging-")) continue;
        fs.rmSync(path.join(versionsDir, entry.name), { recursive: true, force: true });
        if (!entry.name.includes(".bak-")) removeProfile(packRoot, modId, entry.name);
      }
    }
  } else if (scope === "pack") {
    fs.rmSync(packRoot, { recursive: true, force: true });
    removeDesktopShortcuts(modId);
  } else {
    throw new Error(`unknown scope: ${scope}`);
  }

  const after = fs.existsSync(packRoot) ? dirBytes(packRoot) : 0;
  return { freedBytes: Math.max(0, before - after), scope, packId };
}

module.exports = { computeStorage, clearStorage, dirBytes, packStorage };
