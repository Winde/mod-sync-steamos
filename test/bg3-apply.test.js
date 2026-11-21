const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { applyBg3, revertBg3, dataDirFor, readApplied } = require("../src/installers/bg3");

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function packWithDataDir(id, dataDir) {
  return {
    id,
    mod: { id: "bg3", version: "1.0.0" },
    platforms: {
      windows: { dataDir, exe: "bin/bg3.exe", gameProcess: "bg3.exe" },
      "linux-proton": { dataDir, exe: "bin/bg3.exe", gameProcess: "bg3.exe" },
      "linux-native": { dataDir, exe: "bin/bg3", gameProcess: "bg3" },
    },
    launch: { dataDir, exe: "bin/bg3.exe", gameProcess: "bg3.exe" },
    install: { type: "bg3" },
  };
}

test("BG3 apply switches versions and reverts to the original files", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-bg3-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  const gameRoot = path.join(base, "game");
  const prefix = path.join(base, "pfx");
  const dataDir = path.join(base, "data");
  const game = { root: gameRoot, prefix: process.platform === "win32" ? null : prefix };
  const pack = packWithDataDir("bg3-modded", dataDir);
  const root = path.join(base, "tv");
  const packRoot = path.join(root, "packs", pack.id);
  assert.equal(dataDirFor(pack, game), dataDir);

  write(path.join(dataDir, "Mods", "a.pak"), "user-a");
  write(path.join(dataDir, "PlayerProfiles", "Public", "modsettings.lsx"), "vanilla-settings");
  write(path.join(gameRoot, "bin", "DWrite.dll"), "vanilla-dll");

  const v1 = path.join(packRoot, "mods", "bg3", "versions", "1.0.0");
  write(path.join(v1, "Mods", "a.pak"), "v1-a");
  write(path.join(v1, "modsettings.lsx"), "v1-settings");
  write(path.join(v1, "bg3se", "DWrite.dll"), "v1-dll");
  write(path.join(v1, "Script Extender", "Test", "Config.json"), "v1-config");

  applyBg3({ pack, root, game, version: "1.0.0", log: () => { } });
  assert.equal(fs.readFileSync(path.join(dataDir, "Mods", "a.pak"), "utf8"), "v1-a");
  assert.equal(fs.readFileSync(path.join(dataDir, "PlayerProfiles", "Public", "modsettings.lsx"), "utf8"), "v1-settings");
  assert.equal(fs.readFileSync(path.join(gameRoot, "bin", "DWrite.dll"), "utf8"), "v1-dll");
  assert.equal(fs.readFileSync(path.join(dataDir, "Script Extender", "Test", "Config.json"), "utf8"), "v1-config");
  assert.equal(readApplied(packRoot).version, "1.0.0");

  const v2 = path.join(packRoot, "mods", "bg3", "versions", "2.0.0");
  write(path.join(v2, "Mods", "a.pak"), "v2-a");
  write(path.join(v2, "Mods", "b.pak"), "v2-b");
  write(path.join(v2, "modsettings.lsx"), "v2-settings");
  write(path.join(v2, "bg3se", "DWrite.dll"), "v2-dll");

  applyBg3({ pack, root, game, version: "2.0.0", log: () => { } });
  assert.equal(fs.readFileSync(path.join(dataDir, "Mods", "a.pak"), "utf8"), "v2-a");
  assert.equal(fs.readFileSync(path.join(dataDir, "Mods", "b.pak"), "utf8"), "v2-b");
  assert.equal(fs.readFileSync(path.join(dataDir, "PlayerProfiles", "Public", "modsettings.lsx"), "utf8"), "v2-settings");
  assert.equal(fs.readFileSync(path.join(gameRoot, "bin", "DWrite.dll"), "utf8"), "v2-dll");
  assert.equal(fs.existsSync(path.join(dataDir, "Script Extender", "Test", "Config.json")), false);
  assert.equal(readApplied(packRoot).version, "2.0.0");

  revertBg3({ pack, root, log: () => { } });
  assert.equal(fs.readFileSync(path.join(dataDir, "Mods", "a.pak"), "utf8"), "user-a");
  assert.equal(fs.existsSync(path.join(dataDir, "Mods", "b.pak")), false);
  assert.equal(fs.readFileSync(path.join(dataDir, "PlayerProfiles", "Public", "modsettings.lsx"), "utf8"), "vanilla-settings");
  assert.equal(fs.readFileSync(path.join(gameRoot, "bin", "DWrite.dll"), "utf8"), "vanilla-dll");
  assert.equal(fs.existsSync(path.join(packRoot, "applied.json")), false);
});

test("BG3 apply on a native Linux build installs BG3LE and wraps the game binary", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-bg3-native-"));
  const oldDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(base, "datahome");
  t.after(() => {
    if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldDataHome;
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const gameRoot = path.join(base, "game");
  const dataDir = path.join(base, "data");
  const game = { root: gameRoot, prefix: null, native: true, mode: "native" };
  const pack = packWithDataDir("bg3-native", dataDir);
  const root = path.join(base, "tv");
  const packRoot = path.join(root, "packs", pack.id);
  const src = path.join(packRoot, "mods", "bg3", "versions", "1.0.0");
  write(path.join(gameRoot, "bin", "bg3"), "native-binary");
  write(path.join(packRoot, "tools", "bg3le", "build", "libbg3le.so"), "library");
  write(path.join(packRoot, "tools", "bg3le", "install.py"), "installer");
  write(path.join(src, "Mods", "a.pak"), "native-a");
  write(path.join(src, "modsettings.lsx"), "native-settings");
  write(path.join(src, "bg3se", "DWrite.dll"), "windows-dll");
  write(path.join(src, "Script Extender", "Test", "Config.json"), "windows-config");
  write(path.join(dataDir, "PlayerProfiles", "Public", "modsettings.lsx"), "vanilla-settings");

  const applied = applyBg3({ pack, root, game, version: "1.0.0", platform: "linux", log: () => { } });

  assert.equal(applied.platform, "linux-native");
  assert.deepEqual(applied.skipped, ["bg3se"]);
  assert.equal(fs.readFileSync(path.join(dataDir, "Mods", "a.pak"), "utf8"), "native-a");
  assert.equal(fs.readFileSync(path.join(dataDir, "PlayerProfiles", "Public", "modsettings.lsx"), "utf8"), "native-settings");
  assert.equal(fs.existsSync(path.join(gameRoot, "bin", "DWrite.dll")), false);
  assert.equal(fs.readFileSync(path.join(dataDir, "Script Extender", "Test", "Config.json"), "utf8"), "windows-config");
  assert.equal(fs.readFileSync(path.join(gameRoot, "bin", "bg3.bg3le-real"), "utf8"), "native-binary");
  assert.match(fs.readFileSync(path.join(gameRoot, "bin", "bg3"), "utf8"), /ModSync BG3LE wrapper/);
  assert.equal(fs.readFileSync(path.join(process.env.XDG_DATA_HOME, "bg3le", "build", "libbg3le.so"), "utf8"), "library");
  assert.equal(applied.nativeLoader.wrapper, "bin/bg3");

  revertBg3({ pack, root, log: () => { } });
  assert.equal(fs.existsSync(path.join(dataDir, "Mods", "a.pak")), false);
  assert.equal(fs.existsSync(path.join(dataDir, "Script Extender", "Test", "Config.json")), false);
  assert.equal(fs.readFileSync(path.join(dataDir, "PlayerProfiles", "Public", "modsettings.lsx"), "utf8"), "vanilla-settings");
  assert.equal(fs.readFileSync(path.join(gameRoot, "bin", "bg3"), "utf8"), "native-binary");
  assert.equal(fs.existsSync(path.join(gameRoot, "bin", "bg3.bg3le-real")), false);
  assert.equal(fs.existsSync(path.join(process.env.XDG_DATA_HOME, "bg3le")), false);
});
