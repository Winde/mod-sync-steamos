const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ensureDir, readText, writeText, writeJson, sha256File, safeJoin, mapLimit,
  fetchToFile, nowStamp, isGameRunning,
} = require("./util");
const steam = require("./steam");

function semverParts(v) {
  return String(v).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
}

function compareVersions(a, b) {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function packRootFor(root, pack) {
  return path.join(root, "packs", pack.id);
}

function listVersions(packRoot, pack) {
  const dir = path.join(packRoot, "mods", pack.mod.id, "versions");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => !n.startsWith(".") && !n.includes(".bak-"))
    .sort(compareVersions);
}

function renderTemplate(file, values) {
  let text = fs.readFileSync(file, "utf8");
  for (const [key, value] of Object.entries(values)) {
    text = text.split(`{{${key}}}`).join(String(value));
  }
  return text;
}

async function installPack({ pack, filesDoc, remoteBase, token, root, game, progress = () => {}, log = () => {} }) {
  const version = pack.mod.version;
  const packRoot = packRootFor(root, pack);
  const payloadPrefix = `mods/${pack.mod.id}/versions/${version}/`;
  const staging = path.join(packRoot, "mods", pack.mod.id, "versions", `.staging-${version}`);
  const versionDir = path.join(packRoot, "mods", pack.mod.id, "versions", version);

  if (isGameRunning(pack.launch.gameProcess)) {
    throw new Error(`${pack.game.title} is running. Close it before installing.`);
  }
  if (game && pack.game.build && game.build && game.build !== String(pack.game.build)) {
    throw new Error(`Expected ${pack.game.title} build ${pack.game.build}; found ${game.build}.`);
  }
  if (game && pack.game.prefix && process.platform !== "win32" && !game.prefixReady) {
    throw new Error("Launch ELDEN RING once via Steam first so the Proton prefix exists.");
  }

  fs.rmSync(staging, { recursive: true, force: true });
  ensureDir(staging);
  ensureDir(path.join(packRoot, "logs"));
  writeJson(path.join(packRoot, "pack.json"), pack);
  writeJson(path.join(packRoot, "files.json"), filesDoc);

  const files = filesDoc.files;
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  let bytesDone = 0;
  let lastReport = 0;

  log(`Installing ${pack.name} ${version}: ${files.length} files, ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);

  await mapLimit(files, 6, async (file) => {
    const isPayload = file.target.startsWith(payloadPrefix);
    const target = isPayload
      ? path.join(staging, file.target.slice(payloadPrefix.length))
      : safeJoin(packRoot, file.target);
    ensureDir(path.dirname(target));
    const tmp = `${target}.part`;
    const url = `${remoteBase}/api/packs/${encodeURIComponent(pack.id)}/file?path=${encodeURIComponent(file.source)}`;
    await fetchToFile(url, tmp, { headers: { "x-modsync-token": token } });
    const hash = await sha256File(tmp);
    if (hash !== file.sha256) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`Hash mismatch: ${file.source}`);
    }
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    fs.renameSync(tmp, target);
    if (file.mode) fs.chmodSync(target, Number.parseInt(file.mode, 8));
    done++;
    bytesDone += file.size;
    const now = Date.now();
    if (now - lastReport > 750 || done === files.length) {
      lastReport = now;
      progress({
        phase: "download",
        done,
        total: files.length,
        bytesDone,
        bytesTotal: totalBytes,
        file: file.target,
      });
    }
  });

  if (fs.existsSync(versionDir)) {
    const backup = `${versionDir}.bak-${nowStamp()}`;
    fs.renameSync(versionDir, backup);
    log(`Previous ${version} moved to ${backup}`);
  }
  fs.renameSync(staging, versionDir);
  writeText(path.join(packRoot, "mods", pack.mod.id, "current.txt"), `${version}\n`);

  progress({ phase: "launcher" });
  const templates = path.join(__dirname, "..", "templates", "linux");
  const gameExe = game && game.exe ? game.exe : path.join(packRoot, "..", "..", "Game", "eldenring.exe");
  const launcher = path.join(packRoot, "launchers", `launch-${pack.mod.id}.sh`);
  const launcherText = renderTemplate(path.join(templates, "launch-mod.sh"), {
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
  const desktopFile = path.join(apps, `${pack.mod.id}.desktop`);
  writeText(desktopFile, desktopText);
  const userDesktop = path.join(os.homedir(), "Desktop", `${pack.mod.id}.desktop`);
  try { writeText(userDesktop, desktopText); } catch { /* Desktop may not exist */ }

  log(`Launcher: ${launcher}`);
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
      },
    });
    log(`Steam shortcut added: app ${shortcut.appId}. Restart Steam if it is not visible.`);
  } catch (err) {
    log(`Steam shortcut was not added automatically: ${err.message}`);
  }
  progress({ phase: "done" });
  return { version, packRoot, launcher, desktopFile, files: files.length, totalBytes };
}

function rollback({ pack, root, log = () => {} }) {
  const packRoot = packRootFor(root, pack);
  const current = readText(path.join(packRoot, "mods", pack.mod.id, "current.txt")).trim();
  const versions = listVersions(packRoot, pack);
  const idx = versions.indexOf(current);
  if (idx <= 0) throw new Error("No previous version to roll back to.");
  const previous = versions[idx - 1];
  const profile = path.join(packRoot, "profiles", `${pack.mod.id}-${previous}.me3`);
  if (!fs.existsSync(profile)) throw new Error(`Profile for ${previous} is missing.`);
  writeText(path.join(packRoot, "mods", pack.mod.id, "current.txt"), `${previous}\n`);
  log(`Rolled back ${pack.name} to ${previous}`);
  return { previous, current };
}

module.exports = { installPack, rollback, listVersions, compareVersions, packRootFor };
