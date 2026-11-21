"use strict";

/**
 * Browser-app smoke test.
 *
 * Loads the real `web/labels.js` and `web/app.js` into jsdom and stubs the
 * agent API. It asserts what a person sees, not module internals, so the
 * renderer can move to TypeScript without rewriting the test.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const webDir = path.resolve(__dirname, "..", "web");
const html = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
const labelsScript = fs.readFileSync(path.join(webDir, "labels.js"), "utf8");
const appScript = fs.readFileSync(path.join(webDir, "app.js"), "utf8");

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

function stateFixture(pack) {
  return {
    agent: { version: "0.1.0", root: "C:\\ModSync", port: 8788 },
    pc: { url: "http://192.168.1.10:8787", online: true, error: null },
    game: null,
    packs: [pack],
    diskFreeBytes: 120 * 1024 * 1024 * 1024,
    job: null,
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
  window.eval(labelsScript);
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
    await waitFor(window, (w) => w.document.querySelector(".empty h1")?.textContent === "PC offline");
    const doc = window.document;
    assert.match(doc.querySelector(".empty").textContent, /Start modsync serve on the PC/);
    assert.equal(doc.querySelector("#pc span:last-child").textContent, "PC offline");
    assert.equal(doc.querySelector("#library").innerHTML, "");
  } finally {
    dom.window.close();
  }
});
