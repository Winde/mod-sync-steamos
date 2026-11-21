import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray,
} from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConsole } from "../src/console";
import { errorMessage } from "../src/util";
import { projectRoot } from "../src/root";
import type { ConsoleTokenStore, LoginItemResult } from "../src/console";
import type { MenuItemConstructorOptions, OpenDialogOptions } from "electron";

const wantsHidden = process.argv.includes("--hidden");
const wantsDevtools = process.argv.includes("--devtools");
const screenshotArg = process.argv.find((arg) => arg.startsWith("--screenshot="));
const screenshotPath = screenshotArg ? screenshotArg.slice("--screenshot=".length) : "";

app.setName("ModSync Server");
if (process.platform === "win32") app.setAppUserModelId("tv.modsync.server");

let win: BrowserWindow | null = null;
let consoleService: ReturnType<typeof createConsole> | null = null;
let localUrl = "";
let tray: Tray | null = null;
let quitting = false;

function pathArg(name: string): string {
  const index = process.argv.indexOf(name);
  const next = index >= 0 ? process.argv[index + 1] : "";
  if (next && !next.startsWith("--")) return path.resolve(next);
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? path.resolve(match.slice(prefix.length)) : "";
}

function serverConfigPath(): string {
  const fromArg = pathArg("--server-config") || pathArg("--console-config");
  if (fromArg) return fromArg;
  if (process.env.MODSYNC_SERVER_CONFIG) return path.resolve(process.env.MODSYNC_SERVER_CONFIG);
  if (process.env.MODSYNC_CONSOLE_CONFIG) return path.resolve(process.env.MODSYNC_CONSOLE_CONFIG);
  if (!app.isPackaged) return path.join(projectRoot, "state", "console.json");
  return path.join(app.getPath("userData"), "console.json");
}

function defaultPacksDir(): string {
  const fromArg = pathArg("--packs-dir");
  if (fromArg) return fromArg;
  if (process.env.MODSYNC_PACKS_DIR) return path.resolve(process.env.MODSYNC_PACKS_DIR);
  if (!app.isPackaged) return path.join(projectRoot, "packs");
  if (process.platform === "win32") return path.join(app.getPath("documents"), "ModSync", "packs");
  return path.join(os.homedir(), "ModSync", "packs");
}

function loginItemArgs(): string[] {
  if (app.isPackaged) return ["--hidden"];
  return [app.getAppPath(), "--hidden"];
}

function linuxAutostartFile(): string {
  return path.join(os.homedir(), ".config", "autostart", "modsync-server.desktop");
}

function setLinuxAutostart(enabled: boolean): LoginItemResult {
  try {
    const file = linuxAutostartFile();
    if (!enabled) {
      fs.rmSync(file, { force: true });
      return { ok: true };
    }
    const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
    const executable = process.platform === "linux" && process.env.APPIMAGE ? process.env.APPIMAGE : process.execPath;
    const command = [executable, ...loginItemArgs()].map(quote).join(" ");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      "[Desktop Entry]",
      "Type=Application",
      "Name=ModSync Server",
      `Exec=${command}`,
      "X-GNOME-Autostart-enabled=true",
      "Terminal=false",
      "",
    ].join("\n"));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function setLoginAtLogin(enabled: boolean): LoginItemResult {
  if (process.platform === "linux") return setLinuxAutostart(enabled);
  if (process.platform !== "win32" && process.platform !== "darwin") {
    return { ok: false, error: "Sign-in startup is not supported on this platform." };
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: loginItemArgs(),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function createTokenStore(): ConsoleTokenStore | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const file = path.join(path.dirname(serverConfigPath()), "console.token");
  return {
    read: () => {
      if (!fs.existsSync(file)) return null;
      try {
        return safeStorage.decryptString(fs.readFileSync(file));
      } catch {
        return null;
      }
    },
    write: (token) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, safeStorage.encryptString(token));
    },
  };
}

async function startConsole(): Promise<string> {
  if (app.isPackaged) process.env.MODSYNC_STATE_DIR = path.join(app.getPath("userData"), "state");
  const instance = createConsole({
    configFile: serverConfigPath(),
    defaultPacksDir: defaultPacksDir(),
    version: app.getVersion(),
    reveal: (target) => shell.showItemInFolder(target),
    setLaunchAtLogin: setLoginAtLogin,
    onServerChange: () => refreshTray(),
    tokenStore: createTokenStore() ?? undefined,
  });
  consoleService = instance;
  const url = await instance.listen();
  localUrl = url;

  if (instance.config().launchAtLogin) {
    const result = setLoginAtLogin(true);
    if (!result.ok) console.error(`[modsync] login item: ${result.error}`);
  }
  if (instance.config().autoStart) {
    try {
      const status = await instance.startServer();
      console.log(`[modsync] pack server: ${status.url}`);
    } catch (err) {
      console.error(`[modsync] pack server: ${errorMessage(err)}`);
    }
  }
  return url;
}

function openExternal(rawUrl: string): void {
  try {
    const { protocol } = new URL(rawUrl);
    if (protocol === "https:" || protocol === "http:") void shell.openExternal(rawUrl);
  } catch { /* ignore malformed URLs */ }
}

function createWindow(url: string): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: "#05070a",
    icon: path.join(projectRoot, "web", "icon.png"),
    show: false,
    title: "ModSync Server",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-server.js"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win = window;

  window.setMenuBarVisibility(false);
  window.once("ready-to-show", () => {
    if (wantsHidden && !screenshotPath) return;
    window.maximize();
    window.show();
  });
  window.on("minimize", () => {
    if (consoleService?.config().minimizeToTray) window.hide();
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on("closed", () => {
    if (win === window) win = null;
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternal(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (target.startsWith(url)) return;
    event.preventDefault();
    openExternal(target);
  });
  window.webContents.on("did-fail-load", (_event, code, description, failedUrl) => {
    if (code === -3) return;
    console.error(`[modsync] failed to load ${failedUrl}: ${description} (${code})`);
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.control && input.key.toLowerCase() === "q") { event.preventDefault(); app.quit(); }
    if (input.key === "F11") { event.preventDefault(); window.setFullScreen(!window.isFullScreen()); }
  });
  if (wantsDevtools) window.webContents.openDevTools({ mode: "detach" });

  if (screenshotPath) {
    window.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const image = await window.webContents.capturePage();
          fs.writeFileSync(screenshotPath, image.toPNG());
          console.log(`[modsync] screenshot: ${screenshotPath}`);
        } catch (err) {
          console.error("[modsync] screenshot failed", err);
        } finally {
          app.quit();
        }
      }, 4000);
    });
  }

  void window.loadURL(url);
}

function showWindow(): void {
  if (!win) {
    if (!localUrl) return;
    createWindow(localUrl);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function togglePackServer(): Promise<void> {
  if (!consoleService) return;
  const running = consoleService.serverStatus().running;
  try {
    if (running) await consoleService.stopServer();
    else await consoleService.startServer();
  } catch (err) {
    await dialog.showMessageBox({
      type: "error",
      title: "ModSync Server",
      message: running ? "Could not stop the pack server." : "Could not start the pack server.",
      detail: errorMessage(err),
    });
  }
  refreshTray();
}

function refreshTray(): void {
  if (!tray || !consoleService) return;
  const status = consoleService.serverStatus();
  tray.setToolTip(status.running ? `ModSync Server - serving ${status.url}` : "ModSync Server - server stopped");
  const template: MenuItemConstructorOptions[] = [
    { label: "Open ModSync Server", click: () => showWindow() },
    { type: "separator" },
    {
      label: status.running ? "Stop pack server" : "Start pack server",
      click: () => { void togglePackServer(); },
    },
    {
      label: "Open packs folder",
      click: () => {
        try { consoleService?.revealPacksDir(); } catch { /* only fails outside the desktop app */ }
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => { app.quit(); } },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray(): void {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(projectRoot, "web", "icon.png"));
  if (icon.isEmpty()) return;
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.on("double-click", () => showWindow());
  refreshTray();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow();
  });

  app.on("window-all-closed", () => {
    // The tray keeps the server console alive.
  });

  app.on("before-quit", () => {
    quitting = true;
    if (consoleService) void consoleService.close();
    consoleService = null;
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) showWindow();
  });

  app.whenReady().then(async () => {
    ipcMain.handle("modsync:version", () => app.getVersion());
    ipcMain.handle("modsync:releases", () => shell.openExternal("https://github.com/Winde/mod-sync-steamos/releases"));
    ipcMain.handle("modsync:pick-folder", async (event, title?: string) => {
      const parent = BrowserWindow.fromWebContents(event.sender) || undefined;
      const options: OpenDialogOptions = {
        title: typeof title === "string" && title.trim() ? title : "Choose a folder",
        properties: ["openDirectory", "createDirectory"],
      };
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] || null;
    });

    const url = await startConsole();
    console.log(`[modsync] server console: ${url}`);
    createTray();
    if (!wantsHidden || screenshotPath) createWindow(url);
  }).catch((err) => {
    console.error(`[modsync] startup failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    app.quit();
  });
}
