"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const h = require("../test-support/harness");
const { createAgent } = require("../dist/src/agent");
const { createConsole } = require("../dist/src/console");

async function waitFor(fn, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await h.sleep(50);
  }
  throw new Error("timed out waiting for pairing");
}

async function waitForState(url, predicate, timeoutMs = 10000) {
  return waitFor(async () => {
    const response = await fetch(`${url}/api/state`);
    const state = await response.json();
    return predicate(state) ? state : null;
  }, timeoutMs);
}

test("a TV pairs once and persists the approved token", async (t) => {
  const root = h.tempDir("modsync-pairing-console-");
  const tvRoot = h.tempDir("modsync-pairing-tv-");
  const packsDir = path.join(root, "packs");
  const service = createConsole({
    configFile: path.join(root, "state", "console.json"),
    defaultPacksDir: packsDir,
    version: "0.0.0-test",
    reveal: () => {},
  });
  let agent = null;
  t.after(async () => {
    if (agent) agent.server.close();
    await service.close();
    h.remove(root);
    h.remove(tvRoot);
  });

  await service.updateSettings({ bind: "loopback", port: 0, token: "pair-token", autoStart: false });
  const packServer = await service.startServer();
  const control = await service.listen();

  let saved = null;
  const agentConfig = path.join(tvRoot, "agent.json");
  fs.writeFileSync(agentConfig, JSON.stringify({
    root: tvRoot,
    port: 0,
    pcUrl: packServer.url,
    token: "wrong-token",
  }, null, 2) + "\n");
  agent = createAgent({
    root: tvRoot,
    port: 0,
    pcUrl: packServer.url,
    token: "wrong-token",
    saveConnection: (connection) => {
      saved = connection;
      fs.writeFileSync(agentConfig, JSON.stringify({ root: tvRoot, port: 0, ...connection }, null, 2) + "\n");
    },
  });
  await new Promise((resolve) => agent.listen(resolve));
  const address = agent.server.address();
  const agentUrl = `http://127.0.0.1:${address.port}`;

  const rejected = await waitForState(agentUrl, (state) => state.pc?.auth === "rejected");
  assert.equal(rejected.pc.online, false);
  assert.equal(rejected.pairing.status, "idle");

  const started = await fetch(`${agentUrl}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((response) => response.json());
  assert.equal(started.status, "pending");

  const pending = await waitFor(async () => {
    const state = await service.state();
    return state.pairRequests.find((request) => /^ModSync Client/.test(request.device)) || null;
  });
  assert.equal(pending.address, "127.0.0.1");

  const approved = await fetch(`${control}/api/pair/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: control },
    body: JSON.stringify({ id: pending.id }),
  });
  assert.equal(approved.status, 200);

  const paired = await waitForState(agentUrl, (state) => state.pc?.auth === "ok");
  assert.equal(paired.pc.online, true);
  assert.equal(paired.pairing.status, "approved");
  assert.deepEqual(saved, { pcUrl: packServer.url, token: "pair-token" });
  assert.equal(h.readJson(agentConfig).token, "pair-token");

  const wrong = await fetch(`${packServer.url}/api/packs`, {
    headers: { "x-modsync-token": "wrong-token" },
  });
  assert.equal(wrong.status, 403);
  const right = await fetch(`${packServer.url}/api/packs`, {
    headers: { "x-modsync-token": "pair-token" },
  });
  assert.equal(right.status, 200);

  // A later launch reads the saved token and stays connected without asking
  // the Server to approve the TV again.
  agent.server.close();
  agent = createAgent({ ...h.readJson(agentConfig), port: 0 });
  await new Promise((resolve) => agent.listen(resolve));
  const restartedAddress = agent.server.address();
  const restartedUrl = `http://127.0.0.1:${restartedAddress.port}`;
  const restarted = await waitForState(restartedUrl, (state) => state.pc?.auth === "ok");
  assert.equal(restarted.pc.online, true);
  assert.equal(restarted.pairing.status, "idle");
});
