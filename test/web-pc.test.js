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
    devices: [],
    guide: {
      installCommand: "curl -fsSL 'install.sh' | bash -s -- --pc 'http://192.168.1.20:8787'",
      manualInstallCommand: "curl -fsSL 'install.sh' | bash -s -- --pc 'http://192.168.1.20:8787' --token 'token-1234'",
      firewallCommand: 'New-NetFirewallRule -DisplayName "ModSync HTTP 8787"',
      installUrl: "https://example.invalid/install.sh",
    },
    ...overrides,
  };
}

const deviceSummary = {
  id: "dev-1",
  name: "Living room TV",
  address: "192.168.1.50",
  createdAt: "2026-11-21T12:00:00.000Z",
  lastSeenAt: "2026-11-22T12:00:00.000Z",
  legacy: false,
};

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

test("Server console renames a pack and saves its notes and review", async () => {
  const posted = [];
  const state = fixture();
  state.packs[0].baseName = "Graceborne";
  state.packs[0].notes = "Keep online off.";
  state.packs[0].review = { rating: 3, body: "Solid.", updatedAt: "2026-11-21T12:00:00.000Z" };
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/api/state")) return response(state);
    if (init.method === "POST") {
      posted.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      return response({ ok: true });
    }
    return response({});
  };
  const dom = await boot(fetchImpl);
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".packtitle")?.textContent === "Graceborne");
    const doc = window.document;
    assert.match(doc.querySelector(".packnotes").textContent, /Keep online off/);
    assert.equal(doc.querySelector(".badge.stars").textContent, "★★★☆☆");
    assert.ok(doc.querySelector('[data-action="change-art"]'));

    doc.querySelector('[data-action="edit"]').click();
    await waitFor(window, (w) => !!w.document.querySelector("#pack-display-name"));
    assert.equal(doc.querySelector("#pack-display-name").value, "Graceborne");
    assert.equal(doc.querySelector("#pack-notes").value, "Keep online off.");
    assert.equal(doc.querySelector("#pack-review").value, "Solid.");
    assert.ok(doc.querySelector(".imagefield .artbtn"));
    assert.match(doc.querySelector(".imageactions").textContent, /Choose image/);

    const setValue = (selector, value) => {
      const input = doc.querySelector(selector);
      const proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    };
    setValue("#pack-display-name", "Graceborne Remastered");
    setValue("#pack-notes", "Now tested on the 1.17 build.");
    setValue("#pack-review", "Still great after the patch.");
    doc.querySelectorAll('[data-action="rate"]')[4].click();
    await waitFor(window, (w) => /5 of 5/.test(w.document.querySelector(".modal .stars .hint")?.textContent || ""));

    doc.querySelector(".modalform").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(window, () => posted.length === 2);
    const libraryPost = posted.find((entry) => entry.url.includes("/library"));
    const reviewPost = posted.find((entry) => entry.url.endsWith("/api/reviews"));
    assert.ok(libraryPost);
    assert.deepEqual(libraryPost.body, {
      name: "Graceborne Remastered",
      notes: "Now tested on the 1.17 build.",
    });
    assert.ok(reviewPost);
    assert.deepEqual(reviewPost.body, {
      gameId: "eldenring",
      modId: "graceborne",
      rating: 5,
      body: "Still great after the patch.",
    });
    await waitFor(window, (w) => !w.document.querySelector("#pack-display-name"));
  } finally {
    window.close();
  }
});

function buildResponse(recipeId, packId) {
  return response({
    id: "job-1",
    recipeId,
    packId: packId || recipeId,
    status: "running",
    phase: "preparing",
    percent: 0,
    error: null,
    startedAt: "2026-11-22T12:00:00.000Z",
    finishedAt: null,
    log: [],
    result: null,
  }, 202);
}

async function openRebuildConfirm(window, doc) {
  doc.querySelector('[data-action="build"]').click();
  await waitFor(window, (w) => !!w.document.querySelector("#build-form"));
  doc.querySelector("#build-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(window, (w) => !!w.document.querySelector('[data-action="confirm-rebuild"]'));
}

test("Server console confirms a rebuild and warns that name, notes, and image are cleared", async () => {
  let posted = null;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/api/build") && init.method === "POST") {
      posted = JSON.parse(init.body);
      return buildResponse(posted.recipeId, posted.packId);
    }
    if (String(url).endsWith("/api/state")) return response(fixture());
    return response({});
  };
  const dom = await boot(fetchImpl);
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".packtitle")?.textContent === "Graceborne");
    const doc = window.document;
    await openRebuildConfirm(window, doc);
    const modal = doc.querySelector(".modal");
    assert.match(modal.textContent, /Replace Graceborne\?/);
    assert.match(modal.textContent, /Custom name, notes, and image are cleared/);
    assert.match(modal.textContent, /rating and review are kept/i);
    assert.equal(doc.querySelector('[data-action="rebuild-overwrite"]').checked, true);
    doc.querySelector('[data-action="confirm-rebuild"]').click();
    await waitFor(window, () => posted !== null);
    assert.equal(posted.recipeId, "eldenring-graceborne");
    assert.equal(posted.packId, "eldenring-graceborne");
    assert.equal(posted.createNew, false);
  } finally {
    window.close();
  }
});

test("Server console can create a new pack instead of replacing one", async () => {
  let posted = null;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/api/build") && init.method === "POST") {
      posted = JSON.parse(init.body);
      return buildResponse(posted.recipeId, posted.packId);
    }
    if (String(url).endsWith("/api/state")) return response(fixture());
    return response({});
  };
  const dom = await boot(fetchImpl);
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".packtitle")?.textContent === "Graceborne");
    const doc = window.document;
    await openRebuildConfirm(window, doc);
    doc.querySelector('[data-action="rebuild-new"]').click();
    await waitFor(window, (w) => !!w.document.querySelector("#new-pack-name"));
    assert.equal(doc.querySelector("#new-pack-name").value, "Graceborne copy");
    assert.equal(doc.querySelector("#new-pack-id").value, "graceborne-copy");

    const setValue = (selector, value) => {
      const input = doc.querySelector(selector);
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    };
    setValue("#new-pack-name", "My Graceborne");
    await waitFor(window, (w) => w.document.querySelector("#new-pack-id").value === "my-graceborne");
    doc.querySelector('[data-action="confirm-rebuild"]').click();
    await waitFor(window, () => posted !== null);
    assert.equal(posted.packId, "my-graceborne");
    assert.equal(posted.createNew, true);
    assert.equal(posted.packName, "My Graceborne");
  } finally {
    window.close();
  }
});

test("Pack library filters packs by game", async () => {
  const state = fixture();
  const bg3 = {
    ...state.packs[0],
    id: "bg3-modded",
    name: "BG3 Modded",
    game: { id: "bg3", title: "Baldur's Gate 3", appId: 1086940, build: "4.1", version: "4.1" },
    mod: { id: "bg3", version: "1.2.3" },
    recipeId: "bg3-modded",
    root: "C:\\ModSync\\packs\\bg3-modded",
    artUrl: "/api/packs/bg3-modded/art/grid",
  };
  state.packs = [state.packs[0], bg3];
  const dom = await boot(async (url) => response(String(url).endsWith("/api/state") ? state : {}));
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelectorAll(".packcard").length === 2);
    const doc = window.document;
    const select = doc.querySelector("#game-filter");
    assert.ok(select);
    assert.equal(select.options.length, 3);
    const choose = (value) => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(select, value);
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    };
    choose("bg3");
    await waitFor(window, (w) => w.document.querySelectorAll(".packcard").length === 1);
    assert.equal(doc.querySelector(".packtitle").textContent, "BG3 Modded");
    choose("");
    await waitFor(window, (w) => w.document.querySelectorAll(".packcard").length === 2);
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

test("Server console lists paired devices and revokes one", async () => {
  let posted = null;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/api/devices/revoke") && init.method === "POST") {
      posted = JSON.parse(init.body);
      return response({ ok: true, devices: [] });
    }
    if (String(url).endsWith("/api/state")) return response(fixture({ devices: [deviceSummary] }));
    return response({});
  };
  const dom = await boot(fetchImpl);
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".packtitle")?.textContent === "Graceborne");
    const doc = window.document;
    const row = doc.querySelector(".devicerow");
    assert.match(row.textContent, /Living room TV/);
    assert.match(row.textContent, /192\.168\.1\.50/);
    row.querySelector('[data-action="revoke-device"]').click();
    await waitFor(window, () => posted !== null);
    assert.deepEqual(posted, { id: "dev-1" });
    await waitFor(window, (w) => !w.document.querySelector(".devicerow"));
  } finally {
    window.close();
  }
});

test("Server console revokes all paired devices after confirmation", async () => {
  let posted = 0;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/api/devices/revoke-all") && init.method === "POST") {
      posted++;
      return response({ ok: true, devices: [] });
    }
    if (String(url).endsWith("/api/state")) return response(fixture({ devices: [deviceSummary] }));
    return response({});
  };
  const dom = await boot(fetchImpl);
  const { window } = dom;
  window.confirm = () => true;
  try {
    await waitFor(window, (w) => w.document.querySelector(".packtitle")?.textContent === "Graceborne");
    window.document.querySelector('[data-action="revoke-all-devices"]').click();
    await waitFor(window, () => posted === 1);
    await waitFor(window, (w) => !w.document.querySelector(".devicerow"));
  } finally {
    window.close();
  }
});

test("Server console keeps the manual token out of the normal install command", async () => {
  const dom = await boot(async (url) => response(String(url).endsWith("/api/state") ? fixture() : {}));
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".packtitle")?.textContent === "Graceborne");
    const doc = window.document;
    const command = doc.querySelector("#guide-body .codeblock").textContent;
    assert.match(command, /--pc/);
    assert.doesNotMatch(command, /--token/);
    assert.ok(doc.querySelector(".servercard").textContent.includes("pair automatically"));
  } finally {
    window.close();
  }
});
