"use strict";

/**
 * Contract: a native Linux BG3 pack installs the bundled BG3LE runtime, wraps
 * bin/bg3, and reverts the wrapper and mod files on removal. This is the
 * safety net for moving the native-loader behavior into a loader feature.
 *
 * The fixture is Linux-only; Windows has no native BG3 build.
 */

const test = require("node:test");
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
const skip = process.platform === "win32" ? "native Linux BG3 fixture" : false;

test("native BG3 install wraps the game and reverts cleanly", { skip, timeout: 120000 }, async (t) => {
  const steam = makeSteamEnv({ game: "bg3", native: true });
  const gameRoot = steam.gameRoot;
  const dataHome = steam.env.XDG_DATA_HOME;
  const dataDir = path.join(dataHome, "Larian Studios", "Baldur's Gate 3");
  const buildRoot = tempDir("modsync-bg3-native-");
  const bg3le = bg3leRuntime();
  const source = bg3WorkingInstall({ version: "1.0.0" });
  const packsDir = tempDir("modsync-bg3-native-repo-");
  const tv = tempDir("modsync-bg3-native-tv-");

  let repo = null;
  let agent = null;
  t.after(async () => {
    if (agent) await agent.stop();
    if (repo) await repo.stop();
    remove(buildRoot);
    remove(bg3le);
    remove(packsDir);
    remove(tv);
    remove(steam.base);
  });

  write(gameRoot, "bin/bg3", "vanilla-native");
  write(dataDir, "Mods/TestMod_uuid.pak", "vanilla-native-pak");
  write(dataDir, "PlayerProfiles/Public/modsettings.lsx", "vanilla-native-settings");

  // The builder reads BG3SE from the game root; the native installer must not
  // copy those Windows binaries onto the TV.
  write(gameRoot, "bin/DWrite.dll", "builder-dwrite");
  const packRoot = path.join(buildRoot, "pack");
  await buildBg3Pack({
    source,
    out: packRoot,
    version: "1.0.0",
    gameRoot,
    bg3le,
  });
  fs.rmSync(path.join(gameRoot, "bin/DWrite.dll"), { force: true });

  activatePack(packsDir, {
    packRoot,
    pack: readJson(path.join(packRoot, "pack.json")),
  });
  repo = await startRepository({ packsDir, token: "bg3-native-token" });
  agent = await startAgent({
    pcUrl: repo.base,
    token: repo.token,
    root: tv,
    env: steam.env,
  });

  const started = await request(agent.base, "/api/install", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(started.status, 202);
  await pollJob(agent.base, started.json.jobId);

  const installedRoot = path.join(tv, "packs", PACK_ID);
  const applied = readJson(path.join(installedRoot, "applied.json"));
  assert.equal(applied.version, "1.0.0");
  assert.equal(applied.platform, "linux-native");
  assert.deepEqual(applied.skipped, ["bg3se"]);
  assert.equal(applied.nativeLoader.wrapper, "bin/bg3");
  assert.equal(applied.nativeLoader.real, "bin/bg3.bg3le-real");

  const loaderSnapshot = path.join(
    installedRoot,
    "mods",
    MOD_ID,
    "versions",
    "1.0.0",
    "tools",
    "bg3le",
    "build",
    "libbg3le.so",
  );
  assert.equal(fs.readFileSync(loaderSnapshot, "utf8"), "bg3le-0.4.6");

  assert.equal(fs.readFileSync(path.join(dataDir, "Mods/TestMod_uuid.pak"), "utf8"), "pak-1.0.0");
  assert.match(
    fs.readFileSync(path.join(dataDir, "PlayerProfiles/Public/modsettings.lsx"), "utf8"),
    /modsync-1\.0\.0/,
  );
  assert.equal(
    fs.readFileSync(path.join(dataHome, "bg3le", "build", "libbg3le.so"), "utf8"),
    "bg3le-0.4.6",
  );
  assert.equal(fs.existsSync(path.join(gameRoot, "bin/DWrite.dll")), false);

  const wrapper = fs.readFileSync(path.join(gameRoot, "bin/bg3"), "utf8");
  assert.match(wrapper, /ModSync BG3LE wrapper/);
  assert.match(wrapper, /bg3\.bg3le-real/);
  assert.equal(
    fs.readFileSync(path.join(gameRoot, "bin/bg3.bg3le-real"), "utf8"),
    "vanilla-native",
  );

  const launcher = fs.readFileSync(
    path.join(installedRoot, "launchers", `launch-${MOD_ID}.sh`),
    "utf8",
  );
  assert.match(launcher, /ModSync BG3LE wrapper/);
  assert.match(launcher, /bg3\.bg3le-real/);
  assert.match(launcher, /mods\/\$MOD\/versions\/\$VER\/tools\/bg3le/);

  // Removing the pack restores the original binary and vanilla data files.
  const cleared = await request(agent.base, "/api/storage/clear", {
    method: "POST",
    body: { packId: PACK_ID, scope: "pack" },
  });
  assert.equal(cleared.status, 200);

  assert.equal(fs.readFileSync(path.join(gameRoot, "bin/bg3"), "utf8"), "vanilla-native");
  assert.equal(fs.existsSync(path.join(gameRoot, "bin/bg3.bg3le-real")), false);
  assert.equal(fs.existsSync(path.join(dataHome, "bg3le")), false);
  assert.equal(fs.existsSync(path.join(gameRoot, "bin/DWrite.dll")), false);
  assert.equal(
    fs.readFileSync(path.join(dataDir, "Mods/TestMod_uuid.pak"), "utf8"),
    "vanilla-native-pak",
  );
  assert.equal(
    fs.readFileSync(path.join(dataDir, "PlayerProfiles/Public/modsettings.lsx"), "utf8"),
    "vanilla-native-settings",
  );
  assert.equal(fs.existsSync(path.join(dataDir, "Script Extender/Test/Config.json")), false);
  assert.equal(fs.existsSync(installedRoot), false);
});
