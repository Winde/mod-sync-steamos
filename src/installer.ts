import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ensureDir, writeText, writeJson, sha256File, safeJoin, mapLimit,
  nowStamp, formatBytes, errorMessage,
} from "./util";
import * as steam from "./steam";
import * as preconditions from "./preconditions";
import * as versionStore from "./version-store";
import * as paths from "./paths";
import * as installers from "./installers";
import { projectRoot } from "./root";
import type {
  Confirmations,
  FilesDoc,
  Pack,
  PackFile,
  SteamGame,
} from "./types";

export interface ProgressUpdate {
  phase?: string;
  done?: number;
  total?: number;
  bytesDone?: number;
  bytesTotal?: number;
  file?: string;
}

export interface InstallResult {
  version: string;
  packRoot: string;
  launcher: string;
  desktopFile: string | null;
  files: number;
  totalBytes: number;
}

function renderTemplate(file: string, values: Record<string, unknown>): string {
  let text = fs.readFileSync(file, "utf8");
  for (const [key, value] of Object.entries(values)) {
    text = text.split(`{{${key}}}`).join(String(value));
  }
  return text;
}

export function writeLauncher({
  pack,
  root,
  game,
}: {
  pack: Pack;
  root: string;
  game: SteamGame | null | undefined;
}): string {
  const packRoot = versionStore.packRoot(root, pack.id);
  const target = paths.resolve(pack, game);
  const launcher = versionStore.launcherFile(packRoot, pack.mod.id);
  const templates = path.join(projectRoot, "templates", "linux");
  const defaultTemplates: Record<string, string> = { steam: "launch-steam.sh" };
  const templateName = target.template || defaultTemplates[pack.launch.type];
  if (!templateName) throw new Error(`No launcher template for launch type ${pack.launch.type}.`);
  const templateFile = path.resolve(templates, templateName);
  if (!templateFile.startsWith(path.resolve(templates) + path.sep)) {
    throw new Error(`Launcher template escapes the template directory: ${templateName}`);
  }
  const launcherText = renderTemplate(templateFile, {
    ROOT: packRoot,
    MOD: pack.mod.id,
    GAME: game ? game.root : "",
    PREFIX: game && game.prefix ? game.prefix : "",
    DATA_DIR: target.dataDir || "",
    DATA_HOME: paths.contextFor(game).dataHome,
    STEAM_APP_ID: pack.launch.steamAppId,
    GAME_PROCESS: target.gameProcess,
    EXE: target.exe,
    SAVE_FILE: pack.loader?.saveFile || "",
    LOADER: target.loader ? path.join(packRoot, target.loader) : "",
    LOADER_SUPPORT: target.loaderSupport ? path.join(packRoot, target.loaderSupport) : "",
    LOADER_REL: target.loader,
    LOADER_SUPPORT_REL: target.loaderSupport,
  });
  writeText(launcher, launcherText, 0o755);
  return launcher;
}

function snapshotLoaderFiles({
  packRoot,
  pack,
  version,
  files,
}: {
  packRoot: string;
  pack: Pack;
  version: string;
  files: PackFile[];
}): void {
  const versionDir = versionStore.versionDir(packRoot, pack.mod.id, version);
  for (const file of files) {
    if (!file.target.startsWith("tools/")) continue;
    const source = safeJoin(packRoot, file.target);
    if (!fs.existsSync(source)) continue;
    const target = safeJoin(versionDir, file.target);
    ensureDir(path.dirname(target));
    fs.copyFileSync(source, target);
    if (file.mode) fs.chmodSync(target, Number.parseInt(file.mode, 8));
  }
}

function abortError(): Error {
  const err = new Error("Canceled");
  err.name = "AbortError";
  return err;
}

async function downloadResumable(
  url: string,
  dest: string,
  token: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  let start = 0;
  try { start = fs.statSync(dest).size; } catch { /* no partial download yet */ }
  const headers: Record<string, string> = { "x-modsync-token": token };
  if (start > 0) headers.Range = `bytes=${start}-`;
  const res = await fetch(url, { headers, signal });
  if (res.status === 416) return; // already complete; caller verifies hash
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  const append = res.status === 206 && start > 0;
  if (!res.body) throw new Error(`HTTP ${res.status}: empty body`);
  await pipeline(
    Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
    fs.createWriteStream(dest, { flags: append ? "a" : "w" }),
  );
}

export async function installPack({
  pack,
  filesDoc,
  remoteBase,
  token,
  root,
  game,
  signal,
  confirmed = {},
  progress = () => {},
  log = () => {},
}: {
  pack: Pack;
  filesDoc: FilesDoc;
  remoteBase: string;
  token: string;
  root: string;
  game: SteamGame | null;
  signal?: AbortSignal;
  confirmed?: Confirmations[string];
  progress?: (update: ProgressUpdate) => void;
  log?: (message: string) => void;
}): Promise<InstallResult> {
  const version = pack.mod.version;
  const packRoot = versionStore.packRoot(root, pack.id);
  const payloadPrefix = versionStore.payloadPrefix(pack.mod.id, version);
  const staging = versionStore.stagingDir(packRoot, pack.mod.id, version);
  const versionDir = versionStore.versionDir(packRoot, pack.mod.id, version);
  const target = paths.resolve(pack, game);
  const files = paths.filesFor(filesDoc.files, target.variant);
  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  if (!game) throw new Error(`${pack.game.title} was not found in the Steam libraries.`);
  if (!files.length) throw new Error(`This pack has no files for ${target.variant}.`);
  if (!target.supported) {
    throw new Error(`${pack.game.title} is the ${target.variant} build, but this pack does not support it.`);
  }
  if (target.error) throw new Error(target.error);

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

  let done = 0;
  let bytesDone = 0;
  let lastReport = 0;
  const counted = new Map<string, number>();
  const setCounted = (file: PackFile, n: number): void => {
    const key = file.target;
    const prev = counted.get(key) || 0;
    const next = Math.max(0, Math.min(file.size, n));
    if (next === prev) return;
    counted.set(key, next);
    bytesDone += next - prev;
  };
  const pathFor = (file: PackFile): string => {
    const isPayload = file.target.startsWith(payloadPrefix);
    return isPayload
      ? path.join(staging, file.target.slice(payloadPrefix.length))
      : safeJoin(packRoot, file.target);
  };

  // Resume baseline: count what is already on disk so the bar starts where the
  // previous run stopped instead of at 0%.
  for (const file of files) {
    const targetPath = pathFor(file);
    let have = 0;
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isFile() && stat.size === file.size) have = file.size;
    } catch { /* target not present */ }
    if (!have) {
      try {
        const part = `${targetPath}.part`;
        if (fs.existsSync(part)) have = Math.min(fs.statSync(part).size, file.size);
      } catch { /* part not present */ }
    }
    if (have > 0) setCounted(file, have);
  }
  if (bytesDone > 0) {
    progress({ phase: "verify", done, total: files.length, bytesDone, bytesTotal: totalBytes });
    log(`Resume: ${formatBytes(bytesDone)} already on disk; verifying.`);
  }

  const report = (file: string): void => {
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

  log(`Installing ${pack.name} ${version} for ${target.variant}: ${files.length} of ${filesDoc.files.length} files, ${formatBytes(totalBytes)}`);

  await mapLimit(files, 6, async (file) => {
    if (signal?.aborted) throw abortError();
    const targetPath = pathFor(file);
    ensureDir(path.dirname(targetPath));
    const tmp = `${targetPath}.part`;
    const url = `${remoteBase}/api/packs/${encodeURIComponent(pack.id)}/file?path=${encodeURIComponent(file.source)}`;

    // Resume: a file that is already complete is skipped.
    if (fs.existsSync(targetPath)) {
      try {
        if ((await sha256File(targetPath)) === file.sha256) {
          done++;
          setCounted(file, file.size);
          report(file.target);
          return;
        }
      } catch { /* re-download a file that cannot be hashed */ }
      fs.rmSync(targetPath, { force: true });
      setCounted(file, 0);
    }

    let lastError: unknown = null;
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
        if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true });
        fs.renameSync(tmp, targetPath);
        if (file.mode) fs.chmodSync(targetPath, Number.parseInt(file.mode, 8));
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw abortError();
        if (attempt === 3) throw new Error(`${file.source}: ${errorMessage(err)}`);
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
  snapshotLoaderFiles({ packRoot, pack, version, files });

  const adapter = installers.forPack(pack);
  if (adapter && adapter.apply) {
    progress({ phase: "apply" });
    adapter.apply({ pack, root, game, version, log });
  }

  progress({ phase: "launcher" });
  const launcher = writeLauncher({ pack, root, game });

  const icon = path.join(packRoot, pack.art.icon || "");
  const shortcutName = target.shortcut || (pack.launch.mode !== "default" ? pack.name : "");
  let desktopFile: string | null = null;
  if (process.platform === "linux") {
    log(`Launcher: ${launcher}`);
    if (!shortcutName) {
      log(`Default exe: use the regular Steam link for ${pack.game.title}. No non-Steam shortcut was added.`);
    } else {
      const desktopText = `[Desktop Entry]
Type=Application
Name=${shortcutName}
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
          name: shortcutName,
          icon,
          allowOverlay: pack.launch.allowOverlay !== false,
          art: {
            grid: path.join(packRoot, pack.art.grid || ""),
            hero: path.join(packRoot, pack.art.hero || ""),
            logo: path.join(packRoot, pack.art.logo || ""),
            header: pack.art.header ? path.join(packRoot, pack.art.header) : "",
            portrait: pack.art.portrait ? path.join(packRoot, pack.art.portrait) : "",
            icon,
          },
        });
        log(`Steam shortcut ${shortcut.action}: app ${shortcut.appId}. Restart Steam if it is not visible.`);
      } catch (err) {
        log(`Steam shortcut was not added automatically: ${errorMessage(err)}`);
      }
    }
  } else {
    log(`Launcher: ${launcher} (Linux integration skipped on ${process.platform}.)`);
  }
  progress({ phase: "done" });
  return { version, packRoot, launcher, desktopFile, files: files.length, totalBytes };
}

export function rollback({
  pack,
  root,
  log = () => {},
}: {
  pack: Pack;
  root: string;
  log?: (message: string) => void;
}): { previous: string; current: string } {
  const packRoot = versionStore.packRoot(root, pack.id);
  const current = versionStore.readCurrent(packRoot, pack.mod.id);
  const versions = versionStore.listVersions(packRoot, pack.mod.id);
  const idx = versions.indexOf(current);
  if (idx <= 0) throw new Error("No previous version to roll back to.");
  const previous = versions[idx - 1];
  const adapter = installers.forPack(pack);
  if (adapter && adapter.rollback) {
    adapter.rollback({ pack, root, version: previous, log });
  } else {
    const profile = versionStore.profileFile(packRoot, pack, previous);
    if (profile && !fs.existsSync(profile)) throw new Error(`Profile for ${previous} is missing.`);
  }
  versionStore.writeCurrent(packRoot, pack.mod.id, previous);
  log(`Rolled back ${pack.name} to ${previous}`);
  return { previous, current };
}
