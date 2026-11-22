"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const webDir = path.resolve(__dirname, "..", "web");
const html = fs.readFileSync(path.join(webDir, "pc.html"), "utf8");
const script = fs.readFileSync(path.join(webDir, "pc", "pc.js"), "utf8");

function fixture(overrides = {}) {
  return {
    app: {
      version: "0.1.13",
      packsDir: "C:\\ModSync\\packs",
      recipesDir: "C:\\ModSync\\recipes",
      configFile: "C:\\ModSync\\console.json",
      platform: "win32",
      loginItem: { supported: true, error: null },
    },
    server: { running: false, host: "192.168.1.20", port: 8787, url: "", startedAt: null, error: null },
    settings: {
      version: 1,
      packsDir: "C:\\ModSync\\packs",
      bind: "lan",
      host: "",
      port: 8787,
      token: "token-1234",
      autoStart: true,
      launchAtLogin: false,
      minimizeToTray: true,
      working: {},
    },
    packs: [{
      valid: true,
      id: "eldenring-graceborne",
      name: "Graceborne",
      description: "",
      game: { id: "eldenring", title: "ELDEN RING", appId: 1245620, build: "25827938", version: "1.17" },
      mod: { id: "graceborne", version: "0.2.7" },
      files: 1442,
      totalBytes: 7.3 * 1024 * 1024 * 1024,
      contents: {
        source: "me3 profile",
        generatedAt: "2026-11-21T12:00:00.000Z",
        count: 1,
        itemsLabel: "Included packages",
        items: [{ label: "Graceborne", path: "../mods/graceborne/versions/0.2.7/mod", active: true }],
        inactive: [],
      },
      platforms: ["windows", "linux-proton"],
      root: "C:\\ModSync\\packs\\eldenring-graceborne",
      modifiedAt: "2026-11-21T12:00:00.000Z",
      recipeId: "eldenring-graceborne",
      artUrl: "/api/packs/eldenring-graceborne/art/grid",
      error: null,
    }],
    recipes: [{
      id: "eldenring-graceborne",
      name: "Graceborne",
      game: "eldenring",
      gameTitle: "ELDEN RING",
      modId: "graceborne",
      description: "",
      version: "",
      source: "D:\\EldenRingMods",
      out: "C:\\ModSync\\packs\\eldenring-graceborne",
      packExists: true,
      buildOptions: [],
    }],
    lan: { detected: "192.168.1.20", addresses: [{ name: "Ethernet", address: "192.168.1.20" }] },
    build: null,
    pairRequests: [],
    guide: {
      installCommand: "curl -fsSL 'install.sh' | bash -s -- --pc 'http://192.168.1.20:8787' --token 'token-1234'",
      firewallCommand: 'New-NetFirewallRule -DisplayName "ModSync HTTP 8787"',
      installUrl: "https://example.invalid/install.sh",
    },
    ...overrides,
  };
}

function response(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => JSON.stringify(value),
  };
}

function waitFor(window, predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate(window)) return resolve();
      } catch (err) {
        return reject(err);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for the UI"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function boot(fetchImpl, desktop) {
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:8789/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  if (desktop) dom.window.modsyncDesktop = desktop;
  dom.window.fetch = fetchImpl;
  dom.window.eval(script);
  return dom;
}

test("Server console renders packs, settings, and the server control", async () => {
  const dom = await boot(async () => response(fixture()));
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".packtitle")?.textContent === "Graceborne");
    const doc = window.document;
    assert.equal(doc.title, "ModSync Server");
    assert.equal(doc.querySelector("#start-stop").textContent, "Start server");
    assert.match(doc.querySelector("#server-pill-text").textContent, /Server stopped/);
    assert.match(doc.querySelector("#packs").textContent, /7\.3 GB/);
    assert.match(doc.querySelector("#packs").textContent, /Windows · Proton/);
    assert.match(doc.querySelector("#packs").textContent, /1 package/);
    const contentsButton = doc.querySelector('[data-action="contents"]');
    assert.ok(contentsButton);
    assert.equal(contentsButton.tagName, "BUTTON");
    assert.equal(contentsButton.getAttribute("aria-haspopup"), "dialog");
    assert.match(contentsButton.textContent, /View 1 package/);
    contentsButton.click();
    await waitFor(window, (w) => w.document.querySelector(".modal h2")?.textContent === "Graceborne");
    assert.match(doc.querySelector(".modal").textContent, /1 package/);
    assert.match(doc.querySelector(".modal").textContent, /from me3 profile/);
    assert.match(doc.querySelector(".contentslist").textContent, /Graceborne/);
    assert.match(doc.querySelector(".contentslist").textContent, /mods\/graceborne\/versions\/0\.2\.7\/mod/);
    doc.querySelector('[data-action="close-contents"]').click();
    await waitFor(window, (w) => !w.document.querySelector(".modal"));
    assert.equal(doc.querySelector("#packs-dir").value, "C:\\ModSync\\packs");
    assert.equal(doc.querySelector("#server-port").value, "8787");
    assert.equal(doc.querySelector("#server-token").type, "password");
    assert.equal(doc.querySelector("#minimize-tray").checked, true);
    assert.match(doc.querySelector("#guide-body").textContent, /Steam Machine|install/i);
  } finally {
    window.close();
  }
});

test("Server console shows a pending TV request and approves it", async () => {
  let posted = null;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/api/pair/approve") && init.method === "POST") {
      posted = JSON.parse(init.body);
      return response({ ok: true, pairRequests: [] });
    }
    if (String(url).endsWith("/api/state")) {
      return response(fixture({
        pairRequests: [{
          id: "req-1",
          device: "Living room TV",
          address: "192.168.1.50",
          createdAt: "2026-11-21T12:00:00.000Z",
        }],
      }));
    }
    return response({});
  };
  const dom = await boot(fetchImpl);
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".packtitle")?.textContent === "Graceborne");
    const doc = window.document;
    assert.match(doc.querySelector(".pairlist").textContent, /Living room TV/);
    assert.match(doc.querySelector(".pairlist").textContent, /192\.168\.1\.50/);
    doc.querySelector('[data-action="pair-approve"]').click();
    await waitFor(window, () => posted !== null);
    assert.deepEqual(posted, { id: "req-1" });
  } finally {
    window.close();
  }
});

test("Server console starts the server and opens the rebuild dialog", async () => {
  let running = false;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/server/start")) {
      running = true;
      return response(fixture().server);
    }
    if (String(url).endsWith("/api/state")) {
      const state = fixture();
      if (running) {
        state.server = {
          running: true,
          host: "192.168.1.20",
          port: 8787,
          url: "http://192.168.1.20:8787",
          startedAt: new Date().toISOString(),
          error: null,
        };
      }
      return response(state);
    }
    return response({});
  };
  const dom = await boot(fetchImpl);
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".packtitle")?.textContent === "Graceborne");
    const doc = window.document;
    doc.querySelector('[data-action="toggle-server"]').click();
    await waitFor(window, (w) => w.document.querySelector("#server-pill").classList.contains("online"));
    assert.match(doc.querySelector("#server-body").textContent, /Serving/);
    assert.match(doc.querySelector("#server-body").textContent, /192\.168\.1\.20:8787/);

    doc.querySelector('[data-action="build"]').click();
    await waitFor(window, (w) => !!w.document.querySelector("#build-form"));
    assert.equal(doc.querySelector("#build-source").value, "D:\\EldenRingMods");
    assert.match(doc.querySelector("#build-recipe").textContent, /Graceborne/);
  } finally {
    window.close();
  }
});

test("Server console renders driver build options and submits them", async () => {
  let posted = null;
  const bg3Recipe = {
    id: "bg3-modded",
    name: "BG3 Modded",
    game: "bg3",
    gameTitle: "Baldur's Gate 3",
    modId: "bg3",
    description: "",
    version: "",
    source: "D:\\BG3Mods",
    out: "C:\\ModSync\\packs\\bg3-modded",
    packExists: false,
    buildOptions: [
      {
        key: "gameRoot",
        label: "BG3 game folder",
        type: "directory",
        optional: true,
        placeholder: "Detected from Steam",
        help: "Reads DWrite.dll and ScriptExtenderSettings.json.",
      },
      {
        key: "bg3leRoot",
        label: "BG3LE folder",
        type: "directory",
        optional: true,
        placeholder: "Downloaded automatically",
        help: "Native Linux loader bundled in the pack.",
      },
    ],
  };
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/api/build") && init.method === "POST") {
      posted = JSON.parse(init.body);
      return response({
        id: "job-1",
        recipeId: posted.recipeId,
        packId: posted.recipeId,
        status: "running",
        phase: "copying",
        percent: 0,
        error: null,
        startedAt: "2026-11-21T12:00:00.000Z",
        finishedAt: null,
        log: [],
        result: null,
      }, 202);
    }
    if (String(url).endsWith("/api/state")) {
      return response(fixture({ recipes: [bg3Recipe], build: null }));
    }
    return response({});
  };
  const dom = await boot(fetchImpl);
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".packtitle")?.textContent === "Graceborne");
    const doc = window.document;
    doc.querySelector('[data-action="build"]').click();
    await waitFor(window, (w) => !!w.document.querySelector("#build-form"));
    assert.match(doc.querySelector("#build-form").textContent, /BG3 game folder/);
    assert.match(doc.querySelector("#build-form").textContent, /BG3LE folder/);

    const setInput = (id, value) => {
      const input = doc.querySelector(id);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    };
    setInput("#build-option-gameRoot", "D:\\Steam\\BG3");
    setInput("#build-option-bg3leRoot", "D:\\BG3LE");

    doc.querySelector("#build-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(window, () => posted !== null);
    assert.deepEqual(posted.driverOptions, { gameRoot: "D:\\Steam\\BG3", bg3leRoot: "D:\\BG3LE" });
  } finally {
    window.close();
  }
});

test("Pack library points the library at an existing packs folder", async () => {
  let posted = null;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/api/settings") && init.method === "POST") {
      posted = JSON.parse(init.body);
      return response(stateWithPacksDir(posted.packsDir));
    }
    if (String(url).endsWith("/api/state")) {
      return response(stateWithPacksDir(posted ? posted.packsDir : "C:\\ModSync\\packs"));
    }
    return response({});
  };
  function stateWithPacksDir(packsDir) {
    const state = fixture(packsDir === "C:\\ModSync\\packs" ? {} : { packs: [] });
    state.settings = { ...state.settings, packsDir };
    state.app = { ...state.app, packsDir };
    return state;
  }
  const dom = await boot(fetchImpl);
  const { window } = dom;
  window.modsyncDesktop = { pickFolder: async () => "D:\\Library\\packs" };
  try {
    await waitFor(window, (w) => w.document.querySelector(".packtitle")?.textContent === "Graceborne");
    const doc = window.document;
    doc.querySelector('[data-action="change-packs"]').click();
    await waitFor(window, () => posted !== null);
    assert.deepEqual(posted, { packsDir: "D:\\Library\\packs" });
    await waitFor(window, (w) => w.document.querySelector("#packs-dir").value === "D:\\Library\\packs");
    assert.match(doc.querySelector("#packs-summary").textContent, /D:\\Library\\packs/);
  } finally {
    window.close();
  }
});

test("Pack library focuses the settings field without the desktop bridge", async () => {
  const dom = await boot(async (url) => {
    return response(String(url).endsWith("/api/state") ? fixture() : {});
  });
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".packtitle")?.textContent === "Graceborne");
    const doc = window.document;
    doc.querySelector('[data-action="change-packs"]').click();
    await waitFor(window, (w) => w.document.activeElement === w.document.querySelector("#packs-dir"));
    assert.equal(doc.activeElement.id, "packs-dir");
  } finally {
    window.close();
  }
});

test("Server console checks for updates and links to the release", async () => {
  let opened = 0;
  const dom = await boot(
    async (url) => response(String(url).endsWith("/api/state") ? fixture() : {}),
    {
      checkUpdate: async () => ({ current: "0.4.0", latest: "0.6.0", available: true, canInstall: false }),
      openReleases: async () => { opened++; },
    },
  );
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".packtitle")?.textContent === "Graceborne");
    const doc = window.document;
    const check = doc.querySelector("#check-updates");
    assert.equal(check.textContent, "Check for updates");
    check.click();
    await waitFor(window, (w) => w.document.querySelector("#open-releases")?.textContent === "Update 0.6.0");
    doc.querySelector("#open-releases").click();
    await waitFor(window, () => opened === 1);
  } finally {
    window.close();
  }
});

test("Server console installs a Windows update after confirmation", async () => {
  let installed = 0;
  let opened = 0;
  let reportProgress = null;
  const dom = await boot(
    async (url) => response(String(url).endsWith("/api/state") ? fixture() : {}),
    {
      checkUpdate: async () => ({ current: "0.4.0", latest: "0.6.0", available: true, canInstall: true }),
      installUpdate: async () => {
        installed++;
        reportProgress?.({ phase: "download", received: 50, total: 100 });
        reportProgress?.({ phase: "download", received: 100, total: 100 });
      },
      onUpdateProgress: (callback) => {
        reportProgress = callback;
        return () => { reportProgress = null; };
      },
      openReleases: async () => { opened++; },
    },
  );
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".packtitle")?.textContent === "Graceborne");
    const doc = window.document;
    doc.querySelector("#check-updates").click();
    await waitFor(window, (w) => w.document.querySelector("#open-releases")?.textContent === "Install 0.6.0");
    doc.querySelector("#open-releases").click();
    await waitFor(window, (w) => w.document.querySelector(".modal h2")?.textContent === "Update ModSync Server to 0.6.0?");
    assert.equal(opened, 0);
    doc.querySelector('[data-action="install-update"]').click();
    await waitFor(window, () => installed === 1);
    await waitFor(window, (w) => /Downloading ModSync Server 0\.6\.0/.test(w.document.querySelector(".callout.installing")?.textContent || ""));
    await waitFor(window, (w) => /100%/.test(w.document.querySelector(".progressmeta")?.textContent || ""));
    assert.match(doc.querySelector(".progressmeta").textContent, /100(\.0)? B of 100(\.0)? B/);
  } finally {
    window.close();
  }
});
