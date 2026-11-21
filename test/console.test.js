"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const h = require("../test-support/harness");
const { createConsole } = require("../dist/src/console");

function addVersion(source, version) {
  for (const [rel, body] of [
    [`mods/graceborne/versions/${version}/mod/regulation.bin`, `regulation-${version}`],
    [`mods/graceborne/versions/${version}/mod/parts/test.partsbndsc.dcx`, `part-${version}`],
    [`profiles/graceborne-${version}.me3`, `profile ${version}\n`],
  ]) {
    h.write(source, rel, body);
  }
  h.write(source, "mods/graceborne/current.txt", `${version}\n`);
}

async function waitForBuild(service, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await service.state();
    if (state.build && state.build.status !== "running") return state.build;
    await h.sleep(50);
  }
  throw new Error("build did not finish");
}

test("Server console lists, rebuilds, serves, and removes packs", async (t) => {
  const root = h.tempDir("modsync-console-");
  const packsDir = path.join(root, "packs");
  const source = h.workingInstall({ versions: ["0.2.7"] });
  const configFile = path.join(root, "state", "console.json");
  let loginCalls = 0;
  const service = createConsole({
    configFile,
    defaultPacksDir: packsDir,
    version: "0.0.0-test",
    reveal: () => {},
    setLaunchAtLogin: () => { loginCalls++; return { ok: true }; },
  });
  t.after(async () => {
    await service.close();
    h.remove(root);
    h.remove(source);
  });

  const control = await service.listen();
  const controlState = await fetch(`${control}/api/state`).then((res) => res.json());
  assert.equal(controlState.app.version, "0.0.0-test");
  assert.equal(controlState.settings.packsDir, packsDir);
  assert.equal(controlState.packs.length, 0);
  assert.deepEqual(
    controlState.recipes.find((recipe) => recipe.id === "eldenring-graceborne").buildOptions,
    [],
  );
  assert.deepEqual(
    controlState.recipes.find((recipe) => recipe.id === "bg3-modded").buildOptions.map((option) => option.key),
    ["gameRoot", "bg3leRoot"],
  );
  const localPost = await fetch(`${control}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: control },
    body: JSON.stringify({ autoStart: false }),
  });
  assert.equal(localPost.status, 200);
  const foreignPost = await fetch(`${control}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://example.invalid" },
    body: JSON.stringify({ autoStart: true }),
  });
  assert.equal(foreignPost.status, 403);

  const first = service.startBuild({ recipeId: "eldenring-graceborne", source, version: "0.2.7" });
  assert.equal(first.status, "running");
  const built = await waitForBuild(service);
  assert.equal(built.status, "done", built.error || "");
  assert.equal(built.result.version, "0.2.7");
  assert.equal(service.listPacks().length, 1);
  assert.equal(service.listPacks()[0].mod.version, "0.2.7");

  addVersion(source, "0.2.8");
  service.startBuild({ recipeId: "eldenring-graceborne", source, version: "0.2.8" });
  const updated = await waitForBuild(service);
  assert.equal(updated.status, "done", updated.error || "");
  assert.equal(service.listPacks()[0].mod.version, "0.2.8");

  const settings = await service.updateSettings({ bind: "loopback", port: 0, token: "test-token-1", autoStart: false });
  assert.equal(settings.settings.token, "test-token-1");
  const status = await service.startServer();
  assert.equal(status.running, true);
  assert.match(status.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const authorized = await fetch(`${status.url}/api/packs?token=test-token-1`);
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).length, 1);
  assert.equal((await fetch(`${status.url}/api/packs`)).status, 403);

  const rotated = await service.updateSettings({ token: "test-token-2" });
  assert.equal(rotated.server.running, true);
  assert.equal((await fetch(`${rotated.server.url}/api/packs?token=test-token-1`)).status, 403);
  assert.equal((await fetch(`${rotated.server.url}/api/packs?token=test-token-2`)).status, 200);

  const stopped = await service.stopServer();
  assert.equal(stopped.running, false);

  await service.removePack("eldenring-graceborne");
  assert.equal(service.listPacks().length, 0);
  assert.equal(fs.existsSync(path.join(packsDir, "eldenring-graceborne")), false);

  const toggled = await service.updateSettings({ launchAtLogin: true, minimizeToTray: false });
  assert.equal(toggled.settings.launchAtLogin, true);
  assert.equal(toggled.settings.minimizeToTray, false);
  assert.equal(loginCalls, 1);
  assert.equal(h.readJson(configFile).launchAtLogin, true);
  assert.equal(h.readJson(configFile).minimizeToTray, false);
});

test("Server console keeps the token out of the config when protected storage is available", async (t) => {
  const root = h.tempDir("modsync-console-token-");
  const configFile = path.join(root, "state", "console.json");
  const packsDir = path.join(root, "packs");
  let stored = null;
  const tokenStore = {
    read: () => stored,
    write: (value) => { stored = value; },
  };
  const service = createConsole({ configFile, defaultPacksDir: packsDir, tokenStore });
  t.after(async () => {
    await service.close();
    h.remove(root);
  });

  const generated = service.config().token;
  assert.ok(generated);
  assert.equal(stored, generated);
  assert.equal((await service.state()).app.tokenStorage, "protected");
  assert.equal(h.readJson(configFile).token, "");

  await service.updateSettings({ token: "new-secret-123" });
  assert.equal(stored, "new-secret-123");
  assert.equal(h.readJson(configFile).token, "");

  const reopened = createConsole({ configFile, defaultPacksDir: packsDir, tokenStore });
  try {
    assert.equal(reopened.config().token, "new-secret-123");
  } finally {
    await reopened.close();
  }
});

test("Server console passes driver build options and progress to a BG3 build", async (t) => {
  const root = h.tempDir("modsync-console-bg3-");
  const packsDir = path.join(root, "packs");
  const source = h.bg3WorkingInstall({ version: "1.2.3" });
  const bg3le = h.bg3leRuntime();
  const gameRoot = h.tempDir("modsync-console-bg3-game-");
  h.write(gameRoot, "bin/DWrite.dll", "dwrite");
  const configFile = path.join(root, "state", "console.json");
  const service = createConsole({
    configFile,
    defaultPacksDir: packsDir,
    version: "0.0.0-test",
    reveal: () => {},
  });
  t.after(async () => {
    await service.close();
    h.remove(root);
    h.remove(source);
    h.remove(bg3le);
    h.remove(gameRoot);
  });

  assert.throws(
    () => service.startBuild({
      recipeId: "bg3-modded",
      source,
      driverOptions: { gameRoot: path.join(root, "missing-game-root") },
    }),
    /BG3 game folder not found/,
  );

  const control = await service.listen();
  const response = await fetch(`${control}/api/build`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: control },
    body: JSON.stringify({
      recipeId: "bg3-modded",
      source,
      version: "1.2.3",
      driverOptions: { gameRoot, bg3leRoot: bg3le },
    }),
  });
  assert.equal(response.status, 202);
  const started = await response.json();
  assert.equal(started.status, "running");
  const built = await waitForBuild(service);
  assert.equal(built.status, "done", built.error || "");
  assert.equal(built.phase, "done");
  assert.equal(built.percent, 100);

  const pack = h.readJson(path.join(packsDir, "bg3-modded", "pack.json"));
  assert.equal(pack.install.options.bg3se, true);
  const doc = h.readJson(path.join(packsDir, "bg3-modded", "files.json"));
  assert.ok(doc.files.some((file) => file.target === "mods/bg3/versions/1.2.3/bg3se/DWrite.dll"));
});
