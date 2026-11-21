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
    }],
    lan: { detected: "192.168.1.20", addresses: [{ name: "Ethernet", address: "192.168.1.20" }] },
    build: null,
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

async function boot(fetchImpl) {
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:8789/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
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
    assert.equal(doc.querySelector("#packs-dir").value, "C:\\ModSync\\packs");
    assert.equal(doc.querySelector("#server-port").value, "8787");
    assert.equal(doc.querySelector("#server-token").type, "password");
    assert.match(doc.querySelector("#guide-body").textContent, /Steam Machine|install/i);
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
