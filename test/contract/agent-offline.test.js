const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("../../test-support/harness");

test("installed packs remain visible and playable when the PC is offline", async () => {
  const set = await h.buildPackSet({ versions: ["0.2.7"] });
  const repo = await h.startRepository({ packsDir: set.root, token: "offline-token" });
  const tvRoot = h.tempDir("modsync-tv-offline-");
  const steam = h.makeSteamEnv();
  const agent = await h.startAgent({
    pcUrl: repo.base,
    token: repo.token,
    root: tvRoot,
    env: steam.env,
  });

  try {
    const install = await h.request(agent.base, "/api/install", {
      method: "POST",
      body: { packId: set.packs["0.2.7"].pack.id },
    });
    assert.equal(install.status, 202, install.text);
    await h.pollJob(agent.base, install.json.jobId);

    await repo.stop();
    await h.sleep(3000);

    const state = await h.request(agent.base, "/api/state");
    assert.equal(state.status, 200);
    assert.equal(state.json.pc.online, false);
    assert.equal(state.json.packs.length, 1);
    assert.equal(state.json.packs[0].installedVersion, "0.2.7");
    assert.equal(state.json.packs[0].status, "up-to-date");
    assert.equal(state.json.packs[0].local, true);
  } finally {
    await agent.stop();
    await repo.stop();
    h.remove(tvRoot);
    h.remove(steam.base);
    set.cleanup();
  }
});
