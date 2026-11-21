const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runTar } = require("../dist/src/tar");
const { apply, revert, plan } = require("../dist/src/installers/infinity");

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function makePack(base) {
  const root = path.join(base, "root");
  const game = path.join(base, "game");
  const packRoot = path.join(root, "packs", "testpack");
  const versionDir = path.join(packRoot, "mods", "testmod", "versions", "1.0.0");
  const stage = path.join(base, "stage");
  fs.mkdirSync(path.join(game, "override"), { recursive: true });
  fs.mkdirSync(path.join(game, "lang", "en_US"), { recursive: true });
  write(path.join(game, "Baldur.exe"), "REALGAME");
  write(path.join(game, "lang", "en_US", "dialog.tlk"), "BASE");

  write(path.join(stage, "override", "mod.itm"), "ITEM");
  write(path.join(stage, "root", "lang", "en_US", "dialog.tlk"), "MODDED");
  write(path.join(stage, "root", "EEex.dll"), "EEEX");
  write(path.join(stage, "meta", "WeiDU.log"), "~TEST\\SETUP.TP2~ #0 #0 // Test: 1.0\n");
  write(path.join(stage, "modsync.json"), JSON.stringify({
    schema: 1,
    game: "bg2",
    build: "1",
    version: "1.0.0",
    language: "en_US",
    source: "snapshot",
    override: "override",
    root: "root",
    meta: "meta",
    dialogs: ["lang/en_US/dialog.tlk"],
    loader: {
      type: "infinityloader",
      exe: "InfinityLoader.exe",
      ini: "InfinityLoader.ini",
      gameExe: "Baldur.exe",
      realExe: "BaldurReal.exe",
      support: "tools/infinityloader",
      supportFiles: ["InfinityLoader.exe", "InfinityLoader.ini"],
    },
    basePrep: [],
    weidu: { mods: 1, components: 1 },
    selection: { included: 2, bytes: 10, modifiedBase: [], warnings: [] },
  }, null, 2));

  fs.mkdirSync(versionDir, { recursive: true });
  const archive = path.join(versionDir, "payload.tar.gz");
  runTar(["-czf", archive, "-C", stage, "override", "root", "meta", "modsync.json"]);

  write(path.join(packRoot, "tools", "infinityloader", "InfinityLoader.exe"), "LOADER");
  write(path.join(packRoot, "tools", "infinityloader", "InfinityLoader.ini"), [
    "[General]",
    "ExeNames=BaldurReal.exe",
    "ExeSwitchAlias=BaldurReal.exe:Baldur.exe",
    "",
  ].join("\n"));

  const pack = {
    schema: 1,
    id: "testpack",
    name: "Test Pack",
    description: "",
    game: { id: "bg2", title: "Baldur's Gate II: Enhanced Edition", appId: 257350, installDir: "Fake" },
    mod: { id: "testmod", version: "1.0.0" },
    launch: { type: "steam", gameProcess: "testgame.exe" },
    platforms: {
      windows: { exe: "Baldur.exe", gameProcess: "testgame.exe" },
    },
    art: { grid: "art/grid.png", icon: "art/icon.png" },
    files: "files.json",
  };
  const steamGame = {
    root: game,
    appId: 257350,
    library: null,
    build: "1",
    mode: "windows",
    native: false,
    prefix: null,
    prefixReady: true,
    platform: "win32",
  };
  return { root, game, packRoot, pack, steamGame };
}

test("the Infinity adapter applies and restores a loader snapshot", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-infinity-apply-"));
  try {
    const { root, game, pack, steamGame } = makePack(base);
    const applied = apply({
      pack,
      root,
      game: steamGame,
      version: "1.0.0",
      platform: "win32",
      log: () => {},
    });

    assert.equal(read(path.join(game, "override", "mod.itm")), "ITEM");
    assert.equal(read(path.join(game, "lang", "en_US", "dialog.tlk")), "MODDED");
    assert.equal(read(path.join(game, "EEex.dll")), "EEEX");
    assert.equal(read(path.join(game, "InfinityLoader.exe")), "LOADER");
    assert.equal(read(path.join(game, "Baldur.exe")), "LOADER");
    assert.equal(read(path.join(game, "BaldurReal.exe")), "REALGAME");
    assert.equal(applied.loader.wasLoader, false);
    assert.equal(applied.loader.createdReal, true);
    assert.ok(fs.existsSync(path.join(packRootFrom(base), "infinity-applied.json")));

    const planResult = plan({ pack, root });
    assert.equal(planResult.ok, true);
    assert.match(planResult.actions.join(" "), /Restore Baldur\.exe/);

    revert({ pack, root, log: () => {} });
    assert.deepEqual(fs.readdirSync(path.join(game, "override")), []);
    assert.equal(read(path.join(game, "lang", "en_US", "dialog.tlk")), "BASE");
    assert.equal(read(path.join(game, "Baldur.exe")), "REALGAME");
    assert.equal(fs.existsSync(path.join(game, "BaldurReal.exe")), false);
    assert.equal(fs.existsSync(path.join(game, "EEex.dll")), false);
    assert.equal(fs.existsSync(path.join(game, "InfinityLoader.exe")), false);
    assert.equal(fs.existsSync(path.join(game, "InfinityLoader.ini")), false);
    assert.equal(fs.existsSync(path.join(packRootFrom(base), "infinity-applied.json")), false);
    assert.equal(plan({ pack, root }).ok, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function packRootFrom(base) {
  return path.join(base, "root", "packs", "testpack");
}
