"use strict";

/**
 * TV renderer invariant test.
 *
 * Loads the built React renderer (`web/tv/app.js`) into jsdom and stubs the
 * agent API. It asserts what a person sees and the actions they can take, not
 * React internals.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const webDir = path.resolve(__dirname, "..", "web");
const html = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
const appScript = fs.readFileSync(path.join(webDir, "tv", "app.js"), "utf8");

function packFixture(overrides = {}) {
  return {
    id: "eldenring-graceborne",
    name: "Graceborne",
    description: "",
    game: {
      id: "eldenring",
      title: "ELDEN RING",
      store: "steam",
      appId: 1245620,
      installDir: "ELDEN RING",
      build: "25827938",
      version: "1.17",
      prefix: false,
    },
    mod: { id: "graceborne", version: "0.2.7" },
    launch: { type: "me3", mode: "loader", exe: "Game/eldenring.exe", profile: "profiles/graceborne-0.2.7.me3" },
    art: { grid: "art/graceborne/grid.png", icon: "art/graceborne/icon.png" },
    notes: [],
    preconditions: { checks: [], failedRequired: [], blocked: false },
    contents: { kind: "mods", count: 2, mods: [{ name: "Graceborne" }] },
    install: null,
    loader: { type: "me3" },
    files: 1466,
    totalBytes: 7.3 * 1024 * 1024 * 1024,
    status: "not-installed",
    installed: false,
    installedVersion: null,
    versions: [],
    canRollback: false,
    staging: false,
    local: false,
    blocked: false,
    platform: { variant: "windows", supported: true, error: null },
    ...overrides,
  };
}

function stateFixture(packOrPacks, overrides = {}) {
  return {
    agent: { version: "0.1.0", root: "C:\\ModSync", port: 8788 },
    pc: { url: "http://192.168.1.10:8787", online: true, error: null },
    game: null,
    packs: Array.isArray(packOrPacks) ? packOrPacks : [packOrPacks],
    diskFreeBytes: 120 * 1024 * 1024 * 1024,
    job: null,
    ...overrides,
  };
}

function bg3Fixture(overrides = {}) {
  return packFixture({
    id: "bg3-modded",
    name: "BG3 Modded",
    game: {
      id: "bg3",
      title: "Baldur's Gate 3",
      store: "steam",
      appId: 1086940,
      installDir: "Baldurs Gate 3",
      build: "25605617",
      version: "Patch 8",
      prefix: false,
    },
    mod: { id: "bg3", version: "2026.11.21" },
    launch: { type: "steam", mode: "default", exe: "bin/bg3.exe" },
    ...overrides,
  });
}

function textResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => value,
  };
}

function routedFetch(routes) {
  return async (url, options = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
    const method = String(options.method || "GET").toUpperCase();
    const handler = routes[`${method} ${path}`] || routes[path];
    if (!handler) throw new Error(`no route: ${method} ${path}`);
    return typeof handler === "function" ? handler(options) : handler;
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

async function boot({ fetchImpl }) {
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:8788/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.fetch = fetchImpl;
  window.eval(appScript);
  return dom;
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => JSON.stringify(value),
  };
}

test("renders the selected pack and its install action", async () => {
  const dom = await boot({ fetchImpl: async () => jsonResponse(stateFixture(packFixture())) });
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".hero h1")?.textContent === "Graceborne");
    const doc = window.document;
    assert.equal(doc.title, "ModSync");
    assert.equal(doc.querySelector(".brand .word").textContent, "ModSync");
    assert.equal(doc.querySelector(".hero .bigstatus").textContent, "Ready to install");
    assert.equal(doc.querySelector('[data-key="primary"]').textContent, "Install");
    assert.match(doc.querySelector("#library").textContent, /ELDEN RING/);
    assert.match(doc.querySelector("#library").textContent, /1 pack/);
    assert.match(doc.querySelector(".hero .hint").textContent, /GB/);
    assert.ok(doc.querySelector("#storage-btn").textContent.includes("120.00 GB free"));
  } finally {
    dom.window.close();
  }
});

test("renders an installed pack with update and rollback actions", async () => {
  const pack = packFixture({
    status: "update-available",
    installed: true,
    installedVersion: "0.2.5",
    versions: ["0.2.5", "0.2.7"],
    canRollback: true,
    local: true,
  });
  const dom = await boot({ fetchImpl: async () => jsonResponse(stateFixture(pack)) });
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector('[data-key="primary"]')?.textContent === "Update");
    const doc = window.document;
    assert.equal(doc.querySelector(".hero .bigstatus").textContent, "Installed 0.2.5");
    assert.equal(doc.querySelector('[data-key="play"]').textContent, "Play 0.2.5");
    assert.equal(doc.querySelector('[data-key="rollback"]').textContent, "Roll back");
    assert.equal(doc.querySelector('[data-key="uninstall"]').textContent, "Uninstall");
    assert.match(doc.querySelector(".hero .meta").textContent, /update 0.2.7 available/);
  } finally {
    dom.window.close();
  }
});

test("renders the offline screen when the agent is unreachable", async () => {
  const dom = await boot({
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".empty h1")?.textContent === "Server offline");
    const doc = window.document;
    assert.match(doc.querySelector(".empty").textContent, /Start ModSync Server on the server machine/);
    assert.equal(doc.querySelector("#pc span:last-child").textContent, "Server offline");
    assert.equal(doc.querySelector("#library").innerHTML, "");
  } finally {
    dom.window.close();
  }
});

test("groups packs by game and switches the selected pack", async () => {
  const dom = await boot({
    fetchImpl: async () => jsonResponse(stateFixture([packFixture(), bg3Fixture()])),
  });
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".hero h1")?.textContent === "Graceborne");
    const doc = window.document;
    assert.match(doc.querySelector("#library").textContent, /ELDEN RING/);
    assert.match(doc.querySelector("#library").textContent, /Baldur's Gate 3/);
    doc.querySelector('[data-game="bg3"]').click();
    await waitFor(window, (w) => !!w.document.querySelector('[data-select="bg3-modded"]'));
    doc.querySelector('[data-select="bg3-modded"]').click();
    await waitFor(window, (w) => w.document.querySelector(".hero h1")?.textContent === "BG3 Modded");
    assert.match(doc.querySelector(".hero .kicker").textContent, /Baldur's Gate 3/);
    assert.match(doc.querySelector('[data-key="primary"]').textContent, /Install/);
    doc.querySelector('[data-action="all-games"]').click();
    await waitFor(window, (w) => !!w.document.querySelector('[data-game="eldenring"]'));
    assert.equal(doc.querySelector('[data-select="bg3-modded"]'), null);
  } finally {
    dom.window.close();
  }
});

test("a blocked pack cannot start the download and shows its checks", async () => {
  const blocker = {
    id: "game-build",
    type: "game-build",
    title: "Game is build 25827938 (1.17)",
    hint: "Set the game to update only when launched.",
    required: true,
    confirmable: true,
    status: "fail",
    detail: "Found build 26000000",
    blocked: true,
  };
  const pack = packFixture({
    blocked: true,
    preconditions: { checks: [blocker], blocked: true, failedRequired: [blocker] },
    notes: [{ title: "Stay on 1.17", body: "Do not update the game.", tone: "warning" }],
  });
  const dom = await boot({ fetchImpl: async () => jsonResponse(stateFixture(pack)) });
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".hero h1")?.textContent === "Graceborne");
    const doc = window.document;
    assert.match(doc.querySelector(".hero .callout.error").textContent, /Game is build 25827938/);
    assert.ok(doc.querySelector('[data-key="primary"]').disabled);
    doc.querySelector('[data-action="details"]').click();
    await waitFor(window, (w) => w.document.querySelector("#overlay .panel h2")?.textContent === "Graceborne");
    assert.match(doc.querySelector("#overlay .panel").textContent, /Before you install/);
    assert.match(doc.querySelector("#overlay .panel").textContent, /Stay on 1.17/);
    assert.match(doc.querySelector("#overlay .panel").textContent, /Game is build 25827938/);
    assert.ok(doc.querySelector('#overlay [data-action="confirm-check"]'));
  } finally {
    dom.window.close();
  }
});

test("renders install progress from a running job", async () => {
  const pack = packFixture({ installed: false });
  const job = {
    id: "job-1",
    packId: pack.id,
    status: "running",
    phase: "download",
    done: 31,
    total: 100,
    bytesDone: 50 * 1024 * 1024,
    bytesTotal: 100 * 1024 * 1024,
    log: ["Downloading part 31..."],
  };
  const dom = await boot({
    fetchImpl: routedFetch({
      "/api/state": jsonResponse(stateFixture(pack, { job })),
      "/api/jobs/job-1": jsonResponse(job),
    }),
  });
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".progress .big")?.textContent === "50%");
    const doc = window.document;
    assert.match(doc.querySelector(".progress .small").textContent, /50\.0 MB of 100\.0 MB/);
    assert.match(doc.querySelector(".progress .small").textContent, /31\/100 files/);
    assert.equal(doc.querySelector('[data-key="cancel"]').textContent, "Cancel download");
    assert.match(doc.querySelector(".progress .log").textContent, /Downloading part 31/);
    assert.equal(doc.querySelector("#library").innerHTML, "");
  } finally {
    dom.window.close();
  }
});

test("storage view reports usage and asks before clearing logs", async () => {
  const report = {
    freeBytes: 50 * 1024 * 1024 * 1024,
    rootBytes: 12 * 1024 * 1024 * 1024,
    packsBytes: 10 * 1024 * 1024 * 1024,
    logsBytes: 2 * 1024 * 1024,
    otherBytes: 2 * 1024 * 1024,
    packs: [{
      id: "eldenring-graceborne",
      name: "Graceborne",
      installed: true,
      currentVersion: "0.2.7",
      totalBytes: 10 * 1024 * 1024 * 1024,
      oldBytes: 2 * 1024 * 1024 * 1024,
      otherBytes: 0,
      stagingBytes: 0,
      versions: [{ version: "0.2.7", bytes: 8 * 1024 * 1024 * 1024, current: true }],
    }],
  };
  const dom = await boot({
    fetchImpl: routedFetch({
      "/api/state": jsonResponse(stateFixture(packFixture({ installed: true, installedVersion: "0.2.7", status: "up-to-date" }))),
      "/api/storage": jsonResponse(report),
    }),
  });
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".hero h1")?.textContent === "Graceborne");
    const doc = window.document;
    doc.querySelector("#storage-btn").click();
    await waitFor(window, (w) => /free on this device/.test(w.document.querySelector(".storagewrap .meta")?.textContent || ""));
    assert.match(doc.querySelector(".storagewrap .meta").textContent, /50\.0 GB free on this device/);
    assert.match(doc.querySelector(".storagecard").textContent, /Graceborne/);
    assert.match(doc.querySelector(".storagecard").textContent, /0\.2\.7 · current/);
    assert.match(doc.querySelector(".storagecard").textContent, /Remove old versions/);
    doc.querySelector('[data-action="storage-clear"][data-scope="logs"]').click();
    await waitFor(window, (w) => w.document.querySelector("#overlay .panel h2")?.textContent === "Clear logs?");
    assert.match(doc.querySelector("#overlay .panel").textContent, /2\.0 MB of install and agent logs/);
    assert.ok(doc.querySelector('#overlay [data-key="yes"]'));
    assert.ok(doc.querySelector('#overlay [data-key="no"]'));
  } finally {
    dom.window.close();
  }
});

test("details shows notes, checks, and the recent log", async () => {
  const pack = packFixture({
    installed: true,
    installedVersion: "0.2.7",
    status: "up-to-date",
    canRollback: true,
    local: true,
    versions: ["0.2.5", "0.2.7"],
    notes: [{ title: "Stay offline", body: "Launch the modded shortcut.", tone: "warning" }],
    contents: { kind: "mods", count: 2, mods: [{ name: "Graceborne" }, { name: "Regulation" }] },
    launcher: "C:\\ModSync\\packs\\eldenring-graceborne\\launcher.cmd",
    desktopFile: null,
  });
  const dom = await boot({
    fetchImpl: routedFetch({
      "/api/state": jsonResponse(stateFixture(pack)),
      "/api/logs": textResponse("line one\nline two\n"),
    }),
  });
  const { window } = dom;
  try {
    await waitFor(window, (w) => w.document.querySelector(".hero h1")?.textContent === "Graceborne");
    const doc = window.document;
    doc.querySelector('[data-action="details"]').click();
    await waitFor(window, (w) => w.document.querySelector("#overlay .panel h2")?.textContent === "Graceborne");
    assert.match(doc.querySelector("#overlay .panel").textContent, /Versions kept/);
    assert.match(doc.querySelector("#overlay .panel").textContent, /0\.2\.5, 0\.2\.7/);
    assert.match(doc.querySelector("#overlay .panel").textContent, /Stay offline/);
    assert.match(doc.querySelector("#overlay .panel").textContent, /Graceborne · Regulation/);
    await waitFor(window, (w) => /line one/.test(w.document.querySelector("#overlay .panel pre.log")?.textContent || ""));
    assert.ok(doc.querySelector('#overlay [data-key="back"]'));
    assert.ok(doc.querySelector('#overlay [data-action="rollback"]'));
    assert.ok(doc.querySelector('#overlay [data-action="uninstall"]'));
  } finally {
    dom.window.close();
  }
});
