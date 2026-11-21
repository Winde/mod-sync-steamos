const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const paths = require("../dist/src/paths");

const ctx = {
  variant: "linux-proton",
  home: "/home/pela",
  dataHome: "/home/pela/.local/share",
  localAppData: "/home/pela/AppData/Local",
  appData: "/home/pela/AppData/Roaming",
  gameRoot: "/games/ELDEN RING",
  prefix: "/steam/steamapps/compatdata/1245620/pfx",
};

test("the platform variant follows the installed game build", () => {
  assert.equal(paths.variantFor({ native: true }, "linux"), "linux-native");
  assert.equal(paths.variantFor({ native: false }, "linux"), "linux-proton");
  assert.equal(paths.variantFor({ native: true }, "win32"), "windows");
});

test("path tokens expand for each platform layout", () => {
  assert.equal(
    paths.expand("%PREFIX%/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3", ctx),
    path.normalize("/steam/steamapps/compatdata/1245620/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3"),
  );
  assert.equal(paths.expand("%DATA_HOME%/Larian Studios/Baldur's Gate 3", ctx), path.normalize("/home/pela/.local/share/Larian Studios/Baldur's Gate 3"));
  assert.throws(() => paths.expand("%NOPE%/x", ctx), /unknown path token/);
});

test("platform profiles merge recipe overrides without losing defaults", () => {
  const merged = paths.mergePlatforms(
    { windows: { exe: "bin/game.exe", gameProcess: "game.exe" } },
    { windows: { gameProcess: "other.exe" }, "linux-native": { exe: "bin/game" } },
  );
  assert.equal(merged.windows.exe, "bin/game.exe");
  assert.equal(merged.windows.gameProcess, "other.exe");
  assert.equal(merged["linux-native"].exe, "bin/game");
});

test("an unsupported native build is reported instead of silently using Proton paths", () => {
  const pack = { platforms: { "linux-proton": { exe: "bin/game.exe", gameProcess: "game.exe" } } };
  const resolved = paths.resolve(pack, { root: "/games/game", native: true, mode: "native" }, "linux");
  assert.equal(resolved.variant, "linux-native");
  assert.equal(resolved.supported, false);
});

test("files are selected by platform and totals follow the selection", () => {
  const files = [
    { target: "mods/a.pak", size: 10 },
    { target: "tools/me3-linux/bin/me3", size: 20, platforms: ["linux-proton"] },
    { target: "tools/me3-win/bin/me3.exe", size: 30, platforms: ["windows"] },
  ];
  assert.deepEqual(paths.filesFor(files, "linux-proton").map((f) => f.target), ["mods/a.pak", "tools/me3-linux/bin/me3"]);
  const stats = paths.platformStats(files);
  assert.equal(stats.windows.files, 2);
  assert.equal(stats.windows.totalBytes, 40);
  assert.equal(stats["linux-native"].totalBytes, 10);
});
