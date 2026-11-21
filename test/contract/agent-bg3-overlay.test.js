"use strict";

/**
 * Contract: installing, updating, rolling back, and removing a BG3 pack keeps
 * the game data directory reversible. These assertions are black-box: they use
 * the agent HTTP API and the files on disk, not the overlay implementation.
 *
 * This is the safety net for extracting the BG3 apply/revert code into a
 * reusable overlay feature.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  activatePack,
  bg3WorkingInstall,
  bg3leRuntime,
  buildBg3Pack,
  makeSteamEnv,
  pollJob,
  readJson,
  remove,
  request,
  startAgent,
  startRepository,
  tempDir,
  write,
} = require("../../test-support/harness");

const PACK_ID = "bg3-modded";
const MOD_ID = "bg3";

let buildRoot;
let bg3le;
let v1;
let v2;
let steam;
let dataDir;
let gameRoot;
let packsDir;
let tv;
let repo;
let agent;

function dataDirFor(env) {
  if (process.platform === "win32") {
    return path.join(env.env.LOCALAPPDATA, "Larian Studios", "Baldur's Gate 3");
  }
  return path.join(
    env.steamRoot,
    "steamapps",
    "compatdata",
    String(env.appId),
    "pfx",
    "drive_c",
    "users",
    "steamuser",
    "AppData",
    "Local",
    "Larian Studios",
    "Baldur's Gate 3",
  );
}

function activate(root) {
  activatePack(packsDir, {
    packRoot: root,
    pack: readJson(path.join(root, "pack.json")),
  });
}

async function install() {
  const started = await request(agent.base, "/api/install", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(started.status, 202);
  const job = await pollJob(agent.base, started.json.jobId);
  assert.equal(job.status, "done");
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function applied() {
  return readJson(path.join(tv, "packs", PACK_ID, "applied.json"));
}

before(async () => {
  steam = makeSteamEnv({ game: "bg3" });
  gameRoot = steam.gameRoot;
  dataDir = dataDirFor(steam);

  // Vanilla files that the pack must replace and later restore.
  write(dataDir, "Mods/TestMod_uuid.pak", "vanilla-pak");
  write(dataDir, "PlayerProfiles/Public/modsettings.lsx", "vanilla-settings");
  write(dataDir, "PlayerProfiles/Public/save.sav", "save");
  write(dataDir, "Script Extender/Test/Config.json", "vanilla-config");
  write(gameRoot, "bin/DWrite.dll", "vanilla-dll");
  write(gameRoot, "bin/ScriptExtenderSettings.json", "vanilla-settings-json");

  buildRoot = tempDir("modsync-bg3-overlay-");
  bg3le = bg3leRuntime();

  // Build v1 while the game root carries v1's extender.
  const source1 = bg3WorkingInstall({ version: "1.0.0", extras: true });
  write(gameRoot, "bin/DWrite.dll", "v1-dll");
  write(gameRoot, "bin/ScriptExtenderSettings.json", "v1-settings-json");
  v1 = path.join(buildRoot, "v1");
  await buildBg3Pack({ source: source1, out: v1, version: "1.0.0", gameRoot, bg3le });

  // Build v2 without Extra.pak and with different Script Extender files.
  const source2 = bg3WorkingInstall({ version: "2.0.0", extras: false });
  write(gameRoot, "bin/DWrite.dll", "v2-dll");
  write(gameRoot, "bin/ScriptExtenderSettings.json", "v2-settings-json");
  v2 = path.join(buildRoot, "v2");
  await buildBg3Pack({ source: source2, out: v2, version: "2.0.0", gameRoot, bg3le });

  // The TV starts from the vanilla game, not from the builder's staging files.
  write(gameRoot, "bin/DWrite.dll", "vanilla-dll");
  write(gameRoot, "bin/ScriptExtenderSettings.json", "vanilla-settings-json");

  packsDir = tempDir("modsync-bg3-overlay-repo-");
  activate(v1);
  repo = await startRepository({ packsDir, token: "bg3-overlay-token" });
  tv = tempDir("modsync-bg3-overlay-tv-");
  agent = await startAgent({
    pcUrl: repo.base,
    token: repo.token,
    root: tv,
    env: steam.env,
  });
});

after(async () => {
  if (agent) await agent.stop();
  if (repo) await repo.stop();
  remove(packsDir);
  remove(tv);
  remove(buildRoot);
  remove(bg3le);
  remove(steam?.base);
});

test("BG3 install, update, rollback, and pack removal are reversible", { timeout: 120000 }, async () => {
  await install();

  assert.equal(read(path.join(dataDir, "Mods/TestMod_uuid.pak")), "pak-1.0.0");
  assert.equal(read(path.join(dataDir, "Mods/Extra.pak")), "extra-1.0.0");
  assert.match(read(path.join(dataDir, "PlayerProfiles/Public/modsettings.lsx")), /modsync-1\.0\.0/);
  assert.equal(read(path.join(dataDir, "Script Extender/Test/Config.json")), "config-1.0.0");
  assert.equal(read(path.join(gameRoot, "bin/DWrite.dll")), "v1-dll");
  assert.equal(read(path.join(gameRoot, "bin/ScriptExtenderSettings.json")), "v1-settings-json");

  // A default-exe pack uses the generic Steam launcher, not a game template.
  const launcher = read(path.join(tv, "packs", PACK_ID, "launchers", `launch-${MOD_ID}.sh`));
  assert.match(launcher, /steam -applaunch/);
  assert.match(launcher, /steam:\/\/rungameid/);

  let state = applied();
  assert.equal(state.version, "1.0.0");
  assert.ok(state.backups.some((entry) => entry.rel === "Mods/TestMod_uuid.pak"));
  assert.ok(state.backups.some((entry) => entry.rel === "bin/DWrite.dll"));
  assert.ok(state.data.includes("Mods/Extra.pak"));

  // Publish v2 and update. Files owned by v1 are removed, v2 is applied, and
  // the vanilla files are backed up again.
  activate(v2);
  await install();

  assert.equal(read(path.join(dataDir, "Mods/TestMod_uuid.pak")), "pak-2.0.0");
  assert.equal(fs.existsSync(path.join(dataDir, "Mods/Extra.pak")), false);
  assert.match(read(path.join(dataDir, "PlayerProfiles/Public/modsettings.lsx")), /modsync-2\.0\.0/);
  assert.equal(read(path.join(dataDir, "Script Extender/Test/Config.json")), "config-2.0.0");
  assert.equal(read(path.join(gameRoot, "bin/DWrite.dll")), "v2-dll");
  assert.equal(read(path.join(gameRoot, "bin/ScriptExtenderSettings.json")), "v2-settings-json");
  assert.equal(applied().version, "2.0.0");

  const versionsDir = path.join(tv, "packs", PACK_ID, "mods", MOD_ID, "versions");
  assert.ok(fs.existsSync(path.join(versionsDir, "1.0.0")));
  assert.ok(fs.existsSync(path.join(versionsDir, "2.0.0")));

  // Rollback re-applies v1, including the file v2 did not contain.
  const rolled = await request(agent.base, "/api/rollback", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(rolled.status, 200);
  assert.equal(rolled.json.previous, "1.0.0");
  assert.equal(rolled.json.current, "2.0.0");

  assert.equal(read(path.join(tv, "packs", PACK_ID, "mods", MOD_ID, "current.txt")).trim(), "1.0.0");
  assert.equal(read(path.join(dataDir, "Mods/TestMod_uuid.pak")), "pak-1.0.0");
  assert.equal(read(path.join(dataDir, "Mods/Extra.pak")), "extra-1.0.0");
  assert.match(read(path.join(dataDir, "PlayerProfiles/Public/modsettings.lsx")), /modsync-1\.0\.0/);
  assert.equal(read(path.join(dataDir, "Script Extender/Test/Config.json")), "config-1.0.0");
  assert.equal(read(path.join(gameRoot, "bin/DWrite.dll")), "v1-dll");
  assert.equal(applied().version, "1.0.0");

  // Removing the pack reverts the external files to their vanilla contents.
  const cleared = await request(agent.base, "/api/storage/clear", {
    method: "POST",
    body: { packId: PACK_ID, scope: "pack" },
  });
  assert.equal(cleared.status, 200);
  assert.equal(fs.existsSync(path.join(tv, "packs", PACK_ID)), false);

  assert.equal(read(path.join(dataDir, "Mods/TestMod_uuid.pak")), "vanilla-pak");
  assert.equal(fs.existsSync(path.join(dataDir, "Mods/Extra.pak")), false);
  assert.equal(read(path.join(dataDir, "PlayerProfiles/Public/modsettings.lsx")), "vanilla-settings");
  assert.equal(read(path.join(dataDir, "PlayerProfiles/Public/save.sav")), "save");
  assert.equal(read(path.join(dataDir, "Script Extender/Test/Config.json")), "vanilla-config");
  assert.equal(read(path.join(gameRoot, "bin/DWrite.dll")), "vanilla-dll");
  assert.equal(read(path.join(gameRoot, "bin/ScriptExtenderSettings.json")), "vanilla-settings-json");
});
