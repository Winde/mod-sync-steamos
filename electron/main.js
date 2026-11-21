const { app, BrowserWindow, ipcMain, net, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgent } = require("../src/agent");
const { readJson } = require("../src/util");
const {
  RELEASES_PAGE, Updater, currentAppImage, relaunchArgs,
} = require("./updater");

const isSteam = process.env.SteamOS === "1" && process.env.SteamGamepadUI === "1";
const wantsFullscreen = isSteam || process.argv.includes("--fullscreen");
const wantsWindowed = process.argv.includes("--windowed");
const wantsDevtools = process.argv.includes("--devtools");
const screenshotArg = process.argv.find((arg) => arg.startsWith("--screenshot="));
const screenshotPath = screenshotArg ? screenshotArg.slice("--screenshot=".length) : "";

/** How long the closing overlay stays up before the window goes. */
const CLOSING_OVERLAY_MS = 2000;

if (isSteam) app.commandLine.appendSwitch("no-sandbox");
app.setName("ModSync");

let win = null;
let agent = null;
let agentUrl = "";
let updater = null;

function configPath() {
  const index = process.argv.indexOf("--config");
  if (index >= 0 && process.argv[index + 1]) return path.resolve(process.argv[index + 1]);
  if (process.env.MODSYNC_CONFIG) return path.resolve(process.env.MODSYNC_CONFIG);
  const local = path.join(os.homedir(), "ModSync", "agent.json");
  return fs.existsSync(local) ? local : "";
}

function loadConfig() {
  const file = configPath();
  if (file && fs.existsSync(file)) {
    try { return readJson(file); } catch (err) { console.error(`[modsync] ${file}: ${err.message}`); }
  }
  return { root: path.join(os.homedir(), "ModSync") };
}

async function startAgent() {
  const config = loadConfig();
  agent = createAgent({ ...config, port: 0 });
  await new Promise((resolve, reject) => {
    agent.server.once("error", reject);
    agent.server.listen(0, "127.0.0.1", resolve);
  });
  const port = agent.server.address().port;
  agentUrl = `http://127.0.0.1:${port}`;
  return agentUrl;
}

function openExternal(rawUrl) {
  try {
    const { protocol } = new URL(rawUrl);
    if (protocol === "https:" || protocol === "http:") void shell.openExternal(rawUrl);
  } catch { /* ignore */ }
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    fullscreen: wantsFullscreen,
    frame: !wantsFullscreen,
    backgroundColor: "#05070a",
    icon: path.join(__dirname, "..", "web", "icon.png"),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => {
    if (!wantsFullscreen && !wantsWindowed) win.maximize();
    win.show();
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (target.startsWith(url)) return;
    event.preventDefault();
    openExternal(target);
  });
  win.webContents.on("did-fail-load", (_event, code, description, failedUrl) => {
    if (code === -3) return;
    console.error(`[modsync] failed to load ${failedUrl}: ${description} (${code})`);
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.control && input.key.toLowerCase() === "q") { event.preventDefault(); app.quit(); }
    if (input.key === "F11") { event.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
  });
  if (wantsDevtools) win.webContents.openDevTools({ mode: "detach" });

  if (screenshotPath) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage();
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

  void win.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
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
    if (BrowserWindow.getAllWindows().length === 0 && agentUrl) createWindow(agentUrl);
  });

  app.whenReady().then(async () => {
    updater = new Updater({
      currentVersion: () => app.getVersion(),
      appImage: () => currentAppImage(process.env),
      fetch: (url, init) => net.fetch(url, init),
    });

    ipcMain.handle("modsync:version", () => app.getVersion());
    ipcMain.handle("modsync:update-check", async () => {
      try {
        return await updater.check();
      } catch (err) {
        return { current: app.getVersion(), latest: null, available: false, canInstall: false, error: err.message };
      }
    });
    ipcMain.handle("modsync:update-install", async () => {
      const appImage = await updater.install();
      app.relaunch({ execPath: appImage, args: relaunchArgs(process.argv.slice(1)) });
      // The renderer switches to its closing state as soon as this call
      // returns. Hold the window long enough to read it, then quit as before.
      setTimeout(() => app.quit(), CLOSING_OVERLAY_MS);
    });
    ipcMain.handle("modsync:releases", () => shell.openExternal(RELEASES_PAGE));

    const url = await startAgent();
    createWindow(url);
  }).catch((err) => {
    console.error(`[modsync] startup failed: ${err.stack || err.message}`);
    app.quit();
  });
}
