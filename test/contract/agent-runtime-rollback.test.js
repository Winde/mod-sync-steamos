"use strict";

/**
 * Contract: loader files are snapshotted per installed version, so rollback
 * keeps the runtime that belonged to the selected payload. The launcher reads
 * the snapshot for current.txt instead of the shared root runtime.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  activatePack,
  buildPack,
  makeSteamEnv,
  pollJob,
  readJson,
  remove,
  request,
  startAgent,
  startRepository,
  tempDir,
  workingInstall,
  write,
} = require("../../test-support/harness");

const PACK_ID = "eldenring-graceborne";
const MOD_ID = "graceborne";
const V1 = "0.2.5";
const V2 = "0.2.7";

function setRuntime(source, tag) {
  write(source, "tools/me3-linux/bin/me3", tag);
  for (const name of ["me3.exe", "me3-launcher.exe", "me3_mod_host.dll"]) {
    write(source, `tools/me3-linux/bin/win64/${name}`, `${tag}-${name}`);
    write(source, `tools/me3-win/bin/${name}`, `${tag}-${name}`);
  }
}

test("rollback keeps the loader snapshot for each version", { timeout: 120000 }, async (t) => {
  const source = workingInstall({ versions: [V1, V2] });
  const buildRoot = tempDir("modsync-runtime-build-");
  const packsDir = tempDir("modsync-runtime-repo-");
  const tv = tempDir("modsync-runtime-tv-");
  const steam = makeSteamEnv();

  setRuntime(source, "runtime-v1");
  const v1Root = path.join(buildRoot, "v1");
  await buildPack({ source, out: v1Root, version: V1 });

  setRuntime(source, "runtime-v2");
  const v2Root = path.join(buildRoot, "v2");
  await buildPack({ source, out: v2Root, version: V2 });

  activatePack(packsDir, { packRoot: v1Root, pack: readJson(path.join(v1Root, "pack.json")) });
  const repo = await startRepository({ packsDir, token: "runtime-token" });
  const agent = await startAgent({
    pcUrl: repo.base,
    token: repo.token,
    root: tv,
    env: steam.env,
  });
  t.after(async () => {
    await agent.stop();
    await repo.stop();
    remove(source);
    remove(buildRoot);
    remove(packsDir);
    remove(tv);
    remove(steam.base);
  });

  async function install() {
    const started = await request(agent.base, "/api/install", {
      method: "POST",
      body: { packId: PACK_ID },
    });
    assert.equal(started.status, 202);
    await pollJob(agent.base, started.json.jobId);
  }

  const installedRoot = path.join(tv, "packs", PACK_ID);
  const runtimeRel = process.platform === "win32"
    ? "tools/me3-win/bin/me3.exe"
    : "tools/me3-linux/bin/me3";
  const runtimeContent = (tag) => process.platform === "win32" ? `${tag}-me3.exe` : tag;

  await install();
  assert.equal(
    fs.readFileSync(path.join(installedRoot, "mods", MOD_ID, "versions", V1, runtimeRel), "utf8"),
    runtimeContent("runtime-v1"),
  );

  activatePack(packsDir, { packRoot: v2Root, pack: readJson(path.join(v2Root, "pack.json")) });
  await install();
  assert.equal(
    fs.readFileSync(path.join(installedRoot, "mods", MOD_ID, "versions", V2, runtimeRel), "utf8"),
    runtimeContent("runtime-v2"),
  );

  const rolled = await request(agent.base, "/api/rollback", {
    method: "POST",
    body: { packId: PACK_ID },
  });
  assert.equal(rolled.status, 200);
  assert.equal(
    fs.readFileSync(path.join(installedRoot, "mods", MOD_ID, "current.txt"), "utf8").trim(),
    V1,
  );
  assert.equal(
    fs.readFileSync(path.join(installedRoot, "mods", MOD_ID, "versions", V1, runtimeRel), "utf8"),
    runtimeContent("runtime-v1"),
  );

  const launcher = fs.readFileSync(
    path.join(installedRoot, "launchers", `launch-${MOD_ID}.sh`),
    "utf8",
  );
  assert.match(launcher, /LOADER_REL="tools\/me3-/);
  assert.match(launcher, /mods\/\$MOD\/versions\/\$VER\/\$LOADER_REL/);
});
