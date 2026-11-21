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

test("BG3 apply switches versions and reverts to the original files", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-bg3-"));
  const oldLocal = process.env.LOCALAPPDATA;
  try {
    if (process.platform === "win32") process.env.LOCALAPPDATA = path.join(base, "local");
    const gameRoot = path.join(base, "game");
    const prefix = path.join(base, "pfx");
    const game = { root: gameRoot, prefix: process.platform === "win32" ? null : prefix };
    const pack = {
      id: "bg3-modded",
      mod: { id: "bg3", version: "1.0.0" },
      launch: { dataDir: "drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3" },
      install: { type: "bg3", dataDir: "drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3" },
    };
    const root = path.join(base, "tv");
    const packRoot = path.join(root, "packs", pack.id);
    const dataDir = dataDirFor(pack, game);

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
  } finally {
    if (oldLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = oldLocal;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
