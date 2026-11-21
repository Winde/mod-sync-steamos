const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const {
  ensureDir, writeText, writeJson, sha256File, safeJoin, mapLimit,
  nowStamp, isGameRunning, freeBytes, formatBytes,
} = require("./util");
const steam = require("./steam");
const preconditions = require("./preconditions");
const versionStore = require("./version-store");
const bg3 = require("./installers/bg3");

function renderTemplate(file, values) {
  let text = fs.readFileSync(file, "utf8");
  for (const [key, value] of Object.entries(values)) {
    text = text.split(`{{${key}}}`).join(String(value));
  }
  return text;
}

function abortError() {
  const err = new Error("Canceled");
  err.name = "AbortError";
  return err;
}

async function downloadResumable(url, dest, token, signal) {
  let start = 0;
  try { start = fs.statSync(dest).size; } catch { }
  const headers = { "x-modsync-token": token };
  if (start > 0) headers.Range = `bytes=${start}-`;
  const res = await fetch(url, { headers, signal });
  if (res.status === 416) return; // already complete; caller verifies hash
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  const append = res.status === 206 && start > 0;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest, { flags: append ? "a" : "w" }));
}

async function installPack({ pack, filesDoc, remoteBase, token, root, game, signal, confirmed = {}, progress = () => {}, log = () => {} }) {
  const version = pack.mod.version;
  const packRoot = versionStore.packRoot(root, pack.id);
  const payloadPrefix = versionStore.payloadPrefix(pack.mod.id, version);
  const staging = versionStore.stagingDir(packRoot, pack.mod.id, version);
  const versionDir = versionStore.versionDir(packRoot, pack.mod.id, version);
  const files = filesDoc.files;
  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  if (isGameRunning(pack.launch.gameProcess)) {
    throw new Error(`${pack.game.title} is running. Close it before installing.`);
  }
  if (game && pack.game.build && game.build && game.build !== String(pack.game.build)) {
    throw new Error(`Expected ${pack.game.title} build ${pack.game.build}; found ${game.build}.`);
  }
  if (game && pack.game.prefix && process.platform !== "win32" && !game.prefixReady) {
    throw new Error("Launch ELDEN RING once via Steam first so the Proton prefix exists.");
  }

  const pre = preconditions.evaluatePreconditions({ pack, game, root, totalBytes, confirmed });
  if (pre.blocked) {
    const first = pre.failedRequired[0];
    throw new Error(`Precondition failed: ${first.title}${first.detail ? ` — ${first.detail}` : ""}`);
  }

  if (signal?.aborted) throw abortError();
  ensureDir(root);
  ensureDir(staging);
  ensureDir(path.join(packRoot, "logs"));
  writeJson(versionStore.packFile(packRoot), pack);
  writeJson(versionStore.filesDocFile(packRoot, pack), filesDoc);

  const free = freeBytes(root);
  const need = totalBytes + 1024 * 1024 * 1024;
  if (free != null && free < need) {
    throw new Error(`Not enough space on the TV: ${formatBytes(free)} free, need about ${formatBytes(need)}.`);
  }
  let done = 0;
  let bytesDone = 0;
  let lastReport = 0;
  const counted = new Map();
  const setCounted = (file, n) => {
    const prev = counted.get(file.source) || 0;
    const next = Math.max(0, Math.min(file.size, n));
    if (next === prev) return;
    counted.set(file.source, next);
    bytesDone += next - prev;
  };
  const pathFor = (file) => {
    const isPayload = file.target.startsWith(payloadPrefix);
    return isPayload
      ? path.join(staging, file.target.slice(payloadPrefix.length))
      : safeJoin(packRoot, file.target);
  };

  // Resume baseline: count what is already on disk so the bar starts where the
  // previous run stopped instead of at 0%.
  for (const file of files) {
    const target = pathFor(file);
    let have = 0;
    try {
      const stat = fs.statSync(target);
      if (stat.isFile() && stat.size === file.size) have = file.size;
    } catch { /* target not present */ }
    if (!have) {
      try {
        const part = `${target}.part`;
        if (fs.existsSync(part)) have = Math.min(fs.statSync(part).size, file.size);
      } catch { /* part not present */ }
    }
    if (have > 0) setCounted(file, have);
  }
  if (bytesDone > 0) {
    progress({ phase: "verify", done, total: files.length, bytesDone, bytesTotal: totalBytes });
    log(`Resume: ${formatBytes(bytesDone)} already on disk; verifying.`);
  }

  const report = (file) => {
    const now = Date.now();
    if (now - lastReport > 750 || done === files.length) {
      lastReport = now;
      progress({
        phase: "download",
        done,
        total: files.length,
        bytesDone,
        bytesTotal: totalBytes,
        file,
      });
    }
  };

  log(`Installing ${pack.name} ${version}: ${files.length} files, ${formatBytes(totalBytes)}`);
  log(free != null ? `Free space: ${formatBytes(free)}` : "Free space: unknown");

  await mapLimit(files, 6, async (file) => {
    if (signal?.aborted) throw abortError();
    const target = pathFor(file);
    ensureDir(path.dirname(target));
    const tmp = `${target}.part`;
    const url = `${remoteBase}/api/packs/${encodeURIComponent(pack.id)}/file?path=${encodeURIComponent(file.source)}`;

    // Resume: a file that is already complete is skipped.
    if (fs.existsSync(target)) {
      try {
        if ((await sha256File(target)) === file.sha256) {
          done++;
          setCounted(file, file.size);
          report(file.target);
          return;
        }
      } catch { }
      fs.rmSync(target, { force: true });
      setCounted(file, 0);
    }

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (signal?.aborted) throw abortError();
      try {
        await downloadResumable(url, tmp, token, signal);
        const hash = await sha256File(tmp);
        if (hash !== file.sha256) {
          fs.rmSync(tmp, { force: true });
          setCounted(file, 0);
          throw new Error("hash mismatch");
        }
        if (fs.existsSync(target)) fs.rmSync(target, { force: true });
        fs.renameSync(tmp, target);
        if (file.mode) fs.chmodSync(target, Number.parseInt(file.mode, 8));
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (signal?.aborted || err.name === "AbortError") throw abortError();
        if (attempt === 3) throw new Error(`${file.source}: ${err.message}`);
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    if (lastError) throw lastError;
    done++;
    setCounted(file, file.size);
    report(file.target);
  });

  if (fs.existsSync(versionDir)) {
    const backup = versionStore.backupDir(packRoot, pack.mod.id, version, nowStamp());
    fs.renameSync(versionDir, backup);
    log(`Previous ${version} moved to ${backup}`);
  }
  fs.renameSync(staging, versionDir);
  versionStore.writeCurrent(packRoot, pack.mod.id, version);

  if (pack.install && pack.install.type === "bg3") {
    progress({ phase: "apply" });
    bg3.applyBg3({ pack, root, game, version, log });
  }

  progress({ phase: "launcher" });
  const templates = path.join(__dirname, "..", "templates", "linux");
  const launcher = versionStore.launcherFile(packRoot, pack.mod.id);
  const isSteam = pack.launch.type === "steam";
  const launcherText = isSteam
    ? renderTemplate(path.join(templates, "launch-bg3.sh"), {
      ROOT: packRoot,
      MOD: pack.mod.id,
      GAME: game ? game.root : "",
      PREFIX: game && game.prefix ? game.prefix : "",
      DATA_DIR: game && game.prefix ? path.join(game.prefix, pack.launch.dataDir) : "",
      STEAM_APP_ID: pack.launch.steamAppId,
      GAME_PROCESS: pack.launch.gameProcess,
    })
    : renderTemplate(path.join(templates, "launch-mod.sh"), {
      ROOT: packRoot,
      MOD: pack.mod.id,
      GAME: game ? game.root : "",
      EXE: pack.launch.exe,
      GAME_PROCESS: pack.launch.gameProcess,
      STEAM_APP_ID: pack.launch.steamAppId,
      SAVE_FILE: pack.launch.saveFile,
      ME3: path.join(packRoot, pack.launch.me3),
      WIN64: path.join(packRoot, pack.launch.windowsBinaries),
    });
  writeText(launcher, launcherText, 0o755);

  const icon = path.join(packRoot, pack.art.icon);
  let desktopFile = null;
  if (process.platform === "linux") {
    log(`Launcher: ${launcher}`);
    if (pack.launch.mode === "default") {
      log(`Default exe: use the regular Steam link for ${pack.game.title}. No non-Steam shortcut was added.`);
    } else {
      const desktopText = `[Desktop Entry]
Type=Application
Name=${pack.name}
Comment=${pack.description || "Modded " + pack.game.title}
Exec=${launcher}
Path=${packRoot}
Icon=${icon}
Terminal=false
Categories=Game;
`;
      const apps = path.join(os.homedir(), ".local", "share", "applications");
      desktopFile = path.join(apps, `${pack.mod.id}.desktop`);
      writeText(desktopFile, desktopText);
      const userDesktop = path.join(os.homedir(), "Desktop", `${pack.mod.id}.desktop`);
      try { writeText(userDesktop, desktopText); } catch { /* Desktop may not exist */ }

      log(`Shortcut: ${desktopFile}`);
      try {
        const shortcut = await steam.registerShortcut({
          exePath: launcher,
          name: pack.name,
          icon,
          art: {
            grid: path.join(packRoot, pack.art.grid),
            hero: path.join(packRoot, pack.art.hero),
            logo: path.join(packRoot, pack.art.logo),
            header: pack.art.header ? path.join(packRoot, pack.art.header) : "",
            portrait: pack.art.portrait ? path.join(packRoot, pack.art.portrait) : "",
            icon,
          },
        });
        log(`Steam shortcut ${shortcut.action}: app ${shortcut.appId}. Restart Steam if it is not visible.`);
      } catch (err) {
        log(`Steam shortcut was not added automatically: ${err.message}`);
      }
    }
  } else {
    log(`Launcher: ${launcher} (Linux integration skipped on ${process.platform}.)`);
  }
  progress({ phase: "done" });
  return { version, packRoot, launcher, desktopFile, files: files.length, totalBytes };
}

function rollback({ pack, root, log = () => {} }) {
  const packRoot = versionStore.packRoot(root, pack.id);
  const current = versionStore.readCurrent(packRoot, pack.mod.id);
  const versions = versionStore.listVersions(packRoot, pack.mod.id);
  const idx = versions.indexOf(current);
  if (idx <= 0) throw new Error("No previous version to roll back to.");
  const previous = versions[idx - 1];
  const isBg3 = pack.install && pack.install.type === "bg3";
  const profile = isBg3
    ? path.join(versionStore.versionDir(packRoot, pack.mod.id, previous), "modsettings.lsx")
    : versionStore.profileFile(packRoot, pack.mod.id, previous);
  if (!fs.existsSync(profile)) throw new Error(`Profile for ${previous} is missing.`);
  const game = isBg3 ? steam.findGame(pack.game) : null;
  if (isBg3 && !game) throw new Error(`${pack.game.title} was not found in the Steam libraries.`);
  if (isBg3) bg3.applyBg3({ pack, root, game, version: previous, log });
  versionStore.writeCurrent(packRoot, pack.mod.id, previous);
  log(`Rolled back ${pack.name} to ${previous}`);
  return { previous, current };
}

module.exports = { installPack, rollback };
