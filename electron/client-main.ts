import { app, BrowserWindow, ipcMain, net, shell } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent } from "../src/agent";
import { errorMessage, readJson, writeJson } from "../src/util";
import { projectRoot } from "../src/root";
import {
  RELEASES_PAGE, Updater, currentAppImage, relaunchArgs,
} from "./updater";
import type { AgentConfig } from "../src/agent";

const isSteam = process.env.SteamOS === "1" && process.env.SteamGamepadUI === "1";
const wantsFullscreen = isSteam || process.argv.includes("--fullscreen");
const wantsWindowed = process.argv.includes("--windowed");
const wantsDevtools = process.argv.includes("--devtools");
const screenshotArg = process.argv.find((arg) => arg.startsWith("--screenshot="));
const screenshotPath = screenshotArg ? screenshotArg.slice("--screenshot=".length) : "";

/** How long the closing overlay stays up before the window goes. */
const CLOSING_OVERLAY_MS = 2000;

if (isSteam) app.commandLine.appendSwitch("no-sandbox");
app.setName("ModSync Client");

let win: BrowserWindow | null = null;
let agent: ReturnType<typeof createAgent> | null = null;
let localUrl = "";

function pathArg(name: string): string {
  const index = process.argv.indexOf(name);
  const next = index >= 0 ? process.argv[index + 1] : "";
  if (next && !next.startsWith("--")) return path.resolve(next);
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? path.resolve(match.slice(prefix.length)) : "";
}

function configPath(): string {
  const fromArg = pathArg("--config");
  if (fromArg) return fromArg;
  if (process.env.MODSYNC_CONFIG) return path.resolve(process.env.MODSYNC_CONFIG);
  const local = path.join(os.homedir(), "ModSync", "agent.json");
  return fs.existsSync(local) ? local : "";
}

function loadConfig(): AgentConfig {
  const file = configPath();
  const config: AgentConfig = { root: path.join(os.homedir(), "ModSync") };
  if (file && fs.existsSync(file)) {
    try { Object.assign(config, readJson<AgentConfig>(file)); } catch (err) { console.error(`[modsync] ${file}: ${errorMessage(err)}`); }
  }
  if (!config.deviceId) {
    config.deviceId = crypto.randomUUID();
    const target = file || path.join(os.homedir(), "ModSync", "agent.json");
    try {
      let current: Record<string, unknown> = {};
      try { current = readJson<Record<string, unknown>>(target); } catch { /* first run writes a new file */ }
      writeJson(target, { ...current, deviceId: config.deviceId });
    } catch (err) {
      console.error(`[modsync] ${target}: ${errorMessage(err)}`);
    }
  }
  return config;
}

function saveConnection(connection: { pcUrl: string; token: string }): void {
  const file = configPath() || path.join(os.homedir(), "ModSync", "agent.json");
  let current: Record<string, unknown> = {};
  try { current = readJson<Record<string, unknown>>(file); } catch { /* first pair writes a new file */ }
  writeJson(file, { ...current, pcUrl: connection.pcUrl, token: connection.token });
}

async function startAgent(): Promise<string> {
  const config = loadConfig();
  const instance = createAgent({ ...config, port: 0, saveConnection });
  agent = instance;
  await new Promise<void>((resolve, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(0, "127.0.0.1", resolve);
  });
  const address = instance.server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  localUrl = `http://127.0.0.1:${port}`;
  return localUrl;
}

function openExternal(rawUrl: string): void {
  try {
    const { protocol } = new URL(rawUrl);
    if (protocol === "https:" || protocol === "http:") void shell.openExternal(rawUrl);
  } catch { /* ignore malformed URLs */ }
}

function createWindow(url: string): void {
  const window = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 800,
    minHeight: 520,
    fullscreen: wantsFullscreen,
    frame: !wantsFullscreen,
    backgroundColor: "#05070a",
    icon: path.join(projectRoot, "web", "icon.png"),
    show: false,
    title: "ModSync",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-client.js"),
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
    if (!wantsFullscreen && !wantsWindowed) window.maximize();
    window.show();
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    if (agent) agent.server.close();
    agent = null;
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && localUrl) createWindow(localUrl);
  });

  app.whenReady().then(async () => {
    const updateService = new Updater({
      currentVersion: () => app.getVersion(),
      appImage: () => currentAppImage(process.env),
      fetch: (url, init) => net.fetch(url, init) as Promise<Response>,
    });

    ipcMain.handle("modsync:version", () => app.getVersion());
    ipcMain.handle("modsync:update-check", async () => {
      try {
        return await updateService.check();
      } catch (err) {
        return { current: app.getVersion(), latest: null, available: false, canInstall: false, error: errorMessage(err) };
      }
    });
    ipcMain.handle("modsync:update-install", async () => {
      const installed = await updateService.install();
      if (installed.kind !== "appimage") throw new Error("This copy of ModSync cannot install the update.");
      app.relaunch({ execPath: installed.path, args: relaunchArgs(process.argv.slice(1)) });
      setTimeout(() => app.quit(), CLOSING_OVERLAY_MS);
    });
    ipcMain.handle("modsync:releases", () => shell.openExternal(RELEASES_PAGE));

    const url = await startAgent();
    createWindow(url);
  }).catch((err) => {
    console.error(`[modsync] startup failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    app.quit();
  });
}
