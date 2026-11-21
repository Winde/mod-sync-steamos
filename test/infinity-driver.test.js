const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildPackFor, BG2, PSTEE, selectFiles } = require("../dist/src/drivers/infinity");
const { loadRecipe } = require("../dist/src/recipes");
const { loadPack } = require("../dist/src/manifest");
const { listTarEntries, extractTar } = require("../dist/src/tar");

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function fakeGame(base, appId, installDir) {
  return { ...base, appId, installDir };
}

function loaderIni(name = "BaldurReal.exe", gameExe = "Baldur.exe") {
  return [
    "[General]",
    `ExeNames=${name}`,
    `ExeSwitchAlias=${name}:${gameExe}`,
    "",
  ].join("\n");
}

test("the Infinity driver builds a generic snapshot with InfinityLoader", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-infinity-driver-"));
  const source = path.join(base, "game");
  const out = path.join(base, "pack");
  try {
    const game = fakeGame(BG2, 999999, "Fake BG2");
    write(path.join(source, "override", "mod.itm"), "item");
    write(path.join(source, "lang", "en_US", "dialog.tlk"), "modded text");
    write(path.join(source, "WeiDU.log"), [
      "// Log of Currently Installed WeiDU Mods",
      "~MODA\\SETUP-MODA.TP2~ #0 #0 // Mod A: 1.0",
      "~MODB\\SETUP-MODB.TP2~ #0 #0 // Mod B: 1.0",
      "",
    ].join("\n"));
    write(path.join(source, "Baldur.exe"), "real-game");
    write(path.join(source, "BaldurReal.exe"), "real-game-renamed");
    write(path.join(source, "InfinityLoader.exe"), "loader");
    write(path.join(source, "InfinityLoader.ini"), loaderIni());
    write(path.join(source, "EEex.dll"), "eeex");
    write(path.join(source, "EEex.ini"), "eeex-ini");
    write(path.join(source, "engine.lua"), "engine");
    write(path.join(source, "chitin.key"), "key");
    write(path.join(source, "extra.bin"), "extra");
    write(path.join(source, "scripts", "mod.bs"), "script");
    write(path.join(source, "moda", "SETUP-MODA.TP2"), "tp2");
    write(path.join(source, "moda", "runtime.lua"), "runtime");
    write(path.join(source, "modb", "SETUP-MODB.TP2"), "tp2");
    write(path.join(source, "data", "base.bif"), "base");
    write(path.join(source, "data", "new.bif"), "new");
    write(path.join(source, "setup-ignored.exe"), "installer");
    write(path.join(source, "installer.log"), "log");
    write(path.join(source, "_downloads", "mod.zip"), "zip");
    write(path.join(source, "Worldmap", "runtime.lua"), "runtime");

    assert.deepEqual(
      require("../dist/src/drivers/infinity").buildOptions().map((option) => option.key),
      ["includeDirs", "extraFiles", "includeBaseData"],
    );
    const recipe = loadRecipe("bg2ee-modded");
    const result = await buildPackFor(game, {
      recipe,
      source,
      out,
      version: "1.0.0",
      link: false,
      driverOptions: { includeDirs: "moda" },
    });

    assert.equal(result.pack.id, "bg2ee-modded");
    assert.equal(result.pack.install.type, "infinity");
    assert.equal(result.pack.mod.id, "bg2");
    assert.equal(result.pack.launch.gameProcess, "BaldurReal.exe");
    assert.equal(result.pack.platforms["linux-proton"].template, "games/infinity.sh");
    assert.equal(result.pack.platforms["linux-proton"].loader, "tools/infinityloader/InfinityLoader.exe");
    assert.equal(result.pack.platforms["linux-proton"].loaderSupport, "tools/infinityloader");
    assert.equal(result.pack.platforms["linux-native"], undefined);
    assert.equal(result.pack.loader.options.gameExe, "Baldur.exe");
    assert.equal(result.pack.loader.options.realExe, "BaldurReal.exe");
    assert.equal(result.pack.contents.count, 2);
    assert.equal(result.pack.contents.itemsLabel, "Installed mods");
    assert.deepEqual(result.pack.contents.items.map((item) => item.label), ["MODA", "MODB"]);

    const loaded = loadPack(out);
    const targets = loaded.files.files.map((file) => file.target);
    assert.ok(targets.includes("mods/bg2/versions/1.0.0/payload.tar.gz"));
    assert.ok(targets.includes("tools/infinityloader/InfinityLoader.exe"));
    assert.ok(targets.includes("tools/infinityloader/InfinityLoader.ini"));
    assert.equal(targets.filter((target) => target.startsWith("tools/")).every((target) => {
      const file = loaded.files.files.find((candidate) => candidate.target === target);
      return file && Array.isArray(file.platforms) && file.platforms.includes("windows") && file.platforms.includes("linux-proton");
    }), true);

    const archive = path.join(out, "payload", "versions", "1.0.0", "payload.tar.gz");
    const entries = listTarEntries(archive);
    assert.ok(entries.includes("override/mod.itm"));
    assert.ok(entries.includes("root/lang/en_US/dialog.tlk"));
    assert.ok(entries.includes("root/EEex.dll"));
    assert.ok(entries.includes("root/engine.lua"));
    assert.ok(entries.includes("root/chitin.key"));
    assert.ok(entries.includes("root/scripts/mod.bs"));
    assert.ok(entries.includes("root/moda/runtime.lua"));
    assert.ok(entries.includes("root/Worldmap/runtime.lua"));
    assert.ok(entries.includes("meta/WeiDU.log"));
    assert.ok(entries.includes("modsync.json"));
    assert.ok(!entries.includes("root/Baldur.exe"));
    assert.ok(!entries.includes("root/BaldurReal.exe"));
    assert.ok(!entries.includes("root/InfinityLoader.exe"));
    assert.ok(!entries.includes("root/InfinityLoader.ini"));
    assert.ok(!entries.includes("root/data/base.bif"));
    assert.ok(!entries.includes("root/data/new.bif"));
    assert.ok(!entries.includes("root/modb/SETUP-MODB.TP2"));
    assert.ok(!entries.includes("root/setup-ignored.exe"));
    assert.ok(!entries.includes("root/installer.log"));

    const unpacked = path.join(base, "unpacked");
    fs.mkdirSync(unpacked);
    extractTar(archive, unpacked);
    const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, "modsync.json"), "utf8"));
    assert.equal(manifest.game, "bg2");
    assert.equal(manifest.source, "snapshot");
    assert.equal(manifest.loader.gameExe, "Baldur.exe");
    assert.equal(manifest.loader.realExe, "BaldurReal.exe");
    assert.deepEqual(manifest.dialogs, ["lang/en_US/dialog.tlk"]);
    assert.equal(manifest.weidu.mods, 2);
    assert.equal(manifest.selection.included > 0, true);

    const normalizedIni = fs.readFileSync(path.join(out, "tools", "infinityloader", "InfinityLoader.ini"), "utf8");
    assert.match(normalizedIni, /^ExeNames=BaldurReal\.exe$/m);
    assert.match(normalizedIni, /^ExeSwitchAlias=.*BaldurReal\.exe:Baldur\.exe/m);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the Infinity driver rejects a partially removed InfinityLoader install", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-infinity-orphan-"));
  const source = path.join(base, "game");
  const out = path.join(base, "pack");
  try {
    const game = fakeGame(BG2, 999997, "Fake broken BG2");
    write(path.join(source, "override", "mod.itm"), "item");
    write(path.join(source, "lang", "en_US", "dialog.tlk"), "text");
    write(path.join(source, "WeiDU.log"), "~MODA\\SETUP-MODA.TP2~ #0 #0 // Mod A: 1.0\n");
    write(path.join(source, "Baldur.exe"), "loader-stub");
    write(path.join(source, "BaldurReal.exe"), "real-game");
    write(path.join(source, "InfinityLoader.db"), "db");
    write(path.join(source, "InfinityLoaderCommon.dll"), "dll");
    await assert.rejects(
      buildPackFor(game, { recipe: loadRecipe("bg2ee-modded"), source, out, version: "1.0.0", link: false }),
      /InfinityLoader\.exe\/InfinityLoader\.ini are missing/,
    );
    assert.equal(fs.existsSync(path.join(out, "pack.json")), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the Infinity driver supports a no-loader native snapshot", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-infinity-noloader-"));
  const source = path.join(base, "game");
  const out = path.join(base, "pack");
  try {
    const game = fakeGame(PSTEE, 999998, "Fake PSTEE");
    write(path.join(source, "override", "ui.menu"), "menu");
    write(path.join(source, "lang", "en_US", "dialog.tlk"), "text");
    write(path.join(source, "WeiDU.log"), "~FOCUSREADING\\FOCUSREADING.TP2~ #0 #0 // Install Focus Reading: 0.1.1\n");
    write(path.join(source, "Torment.exe"), "real-game");
    write(path.join(source, "engine.lua"), "engine");
    write(path.join(source, "FocusReading", "FocusReading.tp2"), "tp2");
    write(path.join(source, "weidu.conf"), "lang_dir = en_US\n");

    const result = await buildPackFor(game, {
      recipe: loadRecipe("pstee-modded"),
      source,
      out,
      version: "1.0.0",
      link: false,
    });

    assert.equal(result.pack.install.type, "infinity");
    assert.equal(result.pack.loader, undefined);
    assert.equal(result.pack.launch.gameProcess, "Torment.exe");
    assert.equal(result.pack.platforms["linux-native"].exe, "Torment64");
    assert.equal(result.pack.platforms["linux-native"].gameProcess, "Torment64");
    assert.equal(result.pack.platforms["linux-proton"].template, undefined);
    assert.equal(result.pack.platforms["linux-proton"].shortcut, undefined);
    assert.equal(result.pack.contents.count, 1);
    assert.equal(result.pack.contents.items[0].label, "FOCUSREADING");

    const entries = listTarEntries(path.join(out, "payload", "versions", "1.0.0", "payload.tar.gz"));
    assert.ok(entries.includes("override/ui.menu"));
    assert.ok(entries.includes("root/lang/en_US/dialog.tlk"));
    assert.ok(!entries.includes("root/Torment.exe"));
    assert.ok(!entries.includes("root/FocusReading/FocusReading.tp2"));
    assert.ok(!entries.includes("root/weidu.conf"));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("selectFiles uses the base manifest for the base/mod boundary", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-infinity-select-"));
  try {
    write(path.join(base, "override", "mod.itm"), "item");
    write(path.join(base, "lang", "en_US", "dialog.tlk"), "modded dialog");
    write(path.join(base, "Baldur.exe"), "changed game exe");
    write(path.join(base, "scripts", "base.bs"), "base");
    write(path.join(base, "scripts", "mod.bs"), "mod script");
    write(path.join(base, "engine.lua"), "engine");
    write(path.join(base, "chitin.key"), "changed");
    write(path.join(base, "data", "base.bif"), "base");
    write(path.join(base, "data", "new.bif"), "new");
    write(path.join(base, "modfolder", "SETUP.TP2"), "tp2");
    write(path.join(base, "setup-x.exe"), "installer");
    write(path.join(base, "Worldmap", "mod.tbl"), "runtime");
    write(path.join(base, "WeiDU.log"), "log");

    const files = new Map([
      ["lang/en_us/dialog.tlk", { path: "lang/en_US/dialog.tlk", size: 5, depotId: 1 }],
      ["baldur.exe", { path: "Baldur.exe", size: 5, depotId: 1 }],
      ["scripts/base.bs", { path: "scripts/base.bs", size: 4, depotId: 1 }],
      ["engine.lua", { path: "engine.lua", size: 6, depotId: 1 }],
      ["chitin.key", { path: "chitin.key", size: 6, depotId: 1 }],
      ["data/base.bif", { path: "data/base.bif", size: 4, depotId: 1 }],
    ]);
    const selected = selectFiles({
      source: base,
      game: { ...BG2, appId: 1 },
      base: { appId: 1, build: "1", depots: [], files },
      loader: null,
      options: { includeDirs: [], extraFiles: [], includeBaseData: false },
      weidu: { components: 1, mods: [{ tp2: "MODFOLDER/SETUP.TP2", folder: "modfolder", components: 1 }], lines: [] },
      language: "en_US",
      log: () => {},
    });

    assert.ok(selected.rootFiles.includes("lang/en_US/dialog.tlk"));
    assert.ok(selected.rootFiles.includes("scripts/mod.bs"));
    assert.ok(selected.rootFiles.includes("chitin.key"));
    assert.ok(selected.rootFiles.includes("Worldmap/mod.tbl"));
    assert.ok(!selected.rootFiles.includes("Baldur.exe"));
    assert.ok(!selected.rootFiles.includes("scripts/base.bs"));
    assert.ok(!selected.rootFiles.includes("engine.lua"));
    assert.ok(!selected.rootFiles.includes("data/new.bif"));
    assert.ok(!selected.rootFiles.includes("modfolder/SETUP.TP2"));
    assert.ok(!selected.rootFiles.includes("setup-x.exe"));
    assert.ok(!selected.rootFiles.includes("WeiDU.log"));
    assert.deepEqual(selected.dialogs, ["lang/en_US/dialog.tlk"]);
    assert.ok(selected.modifiedBase.includes("lang/en_US/dialog.tlk"));
    assert.ok(selected.modifiedBase.includes("chitin.key"));
    assert.equal(selected.included, 5);
    assert.ok(selected.bytes > 0);
    assert.ok(selected.excluded.some((entry) => entry.path === "scripts/base.bs" && entry.reason === "unchanged base file"));
    assert.ok(selected.excluded.some((entry) => entry.path === "modfolder/" && entry.reason === "WeiDU installer source folder"));
    assert.ok(selected.excluded.some((entry) => entry.path === "data/" && entry.reason === "base data directory"));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
