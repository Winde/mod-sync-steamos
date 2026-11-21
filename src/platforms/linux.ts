import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { writeText, errorMessage, isGameRunning } from "../util";
import * as paths from "../paths";
import * as steam from "../steam";
import * as versionStore from "../version-store";
import type { Pack, SteamGame } from "../types";

/**
 * Linux/SteamOS platform decorator.
 *
 * Generated launchers are shell scripts; desktop entries and Steam shortcuts
 * are only applied on Linux. The launcher writer is kept callable on other
 * hosts so pack installs and tests can still produce the same artifacts.
 */

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
  const template = paths.resolveLauncherTemplate(target.template, pack.launch.type);
  const launcherText = renderTemplate(template.file, {
    ROOT: packRoot,
    MOD: pack.mod.id,
    GAME: game ? game.root : "",
    PREFIX: game && game.prefix ? game.prefix : "",
    DATA_DIR: target.dataDir || "",
    DATA_HOME: paths.contextFor(game).dataHome,
    STEAM_APP_ID: pack.launch.steamAppId,
    GAME_PROCESS: target.gameProcess,
    GAME_PROCESSES: target.processes.join(" "),
    PROFILE_PATTERN: pack.profilePattern || "",
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

export function desktopFileFor(modId: string): string {
  return path.join(os.homedir(), ".local", "share", "applications", `${modId}.desktop`);
}

function run(command: string, args: string[], timeout = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (err) => err ? reject(err) : resolve());
  });
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await run("sh", ["-c", `command -v ${command}`], 5000);
    return true;
  } catch {
    return false;
  }
}

function steamRunning(): boolean {
  if (process.env.SteamGamepadUI === "1" || process.env.SteamOS === "1") return true;
  return isGameRunning(["steam"]);
}

async function addThroughSteam(desktopFile: string): Promise<void> {
  if (await commandExists("steamos-add-to-steam")) {
    await run("steamos-add-to-steam", [desktopFile]);
    return;
  }
  fs.writeFileSync("/tmp/addnonsteamgamefile", "");
  const url = `steam://addnonsteamgame/${encodeURIComponent(desktopFile)}`;
  try {
    await run("steam", [url]);
  } catch {
    await run("xdg-open", [url]);
  }
}

async function waitForShortcut(targets: string[], timeoutMs = 20000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const appId = steam.findShortcutAppId(targets);
    if (appId != null) return appId;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

/** Install the desktop entry and Steam shortcut; returns the desktop file path. */
export async function installShortcut({
  pack,
  root,
  game,
  launcher,
  log = () => {},
}: {
  pack: Pack;
  root: string;
  game: SteamGame | null | undefined;
  launcher: string;
  log?: (message: string) => void;
}): Promise<string | null> {
  const packRoot = versionStore.packRoot(root, pack.id);
  const target = paths.resolve(pack, game);
  const icon = path.join(packRoot, pack.art.icon || "");
  const shortcutName = target.shortcut || (pack.launch.mode !== "default" ? pack.name : "");
  log(`Launcher: ${launcher}`);

  if (!shortcutName) {
    log(`Default exe: use the regular Steam link for ${pack.game.title}. No non-Steam shortcut was added.`);
    return null;
  }

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
  const desktopFile = path.join(apps, `${pack.mod.id}.desktop`);
  writeText(desktopFile, desktopText);
  const userDesktop = path.join(os.homedir(), "Desktop", `${pack.mod.id}.desktop`);
  try { writeText(userDesktop, desktopText); } catch { /* Desktop may not exist */ }

  log(`Shortcut: ${desktopFile}`);
  const art = {
    grid: path.join(packRoot, pack.art.grid || ""),
    hero: path.join(packRoot, pack.art.hero || ""),
    logo: path.join(packRoot, pack.art.logo || ""),
    header: pack.art.header ? path.join(packRoot, pack.art.header) : "",
    portrait: pack.art.portrait ? path.join(packRoot, pack.art.portrait) : "",
    icon,
  };

  const existing = steam.findShortcutAppId([desktopFile, launcher]);
  if (existing != null) {
    steam.applyShortcutArt({ appId: existing, art });
    log(`Steam shortcut reused: app ${existing}.`);
    return desktopFile;
  }

  if (steamRunning()) {
    try {
      await addThroughSteam(desktopFile);
      const appId = await waitForShortcut([desktopFile, launcher]);
      if (appId != null) {
        steam.applyShortcutArt({ appId, art });
        log(`Steam shortcut added: app ${appId}.`);
        return desktopFile;
      }
      log("Steam did not write the shortcut in time; adding it directly. Restart Steam if it is not visible.");
    } catch (err) {
      log(`Steam shortcut add failed: ${errorMessage(err)}; adding it directly. Restart Steam if it is not visible.`);
    }
  }

  try {
    const shortcut = await steam.registerShortcut({
      exePath: launcher,
      name: shortcutName,
      icon,
      allowOverlay: pack.launch.allowOverlay !== false,
      art,
    });
    log(`Steam shortcut ${shortcut.action}: app ${shortcut.appId}. Restart Steam if it is not visible.`);
  } catch (err) {
    log(`Steam shortcut was not added automatically: ${errorMessage(err)}`);
  }
  return desktopFile;
}

export function removeDesktopShortcuts(modId: string): void {
  if (process.platform !== "linux" || !modId) return;
  for (const file of [
    desktopFileFor(modId),
    path.join(os.homedir(), "Desktop", `${modId}.desktop`),
  ]) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
}

export function launch(launcher: string): void {
  const child = spawn("bash", [launcher], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function removeShortcut(launcher: string): Promise<void> {
  await steam.removeShortcut({ exePath: launcher });
}

export async function pruneShortcuts(root: string): Promise<void> {
  await steam.pruneMissingShortcuts({ prefix: path.join(root, "packs") + path.sep });
}
