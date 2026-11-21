const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildPack } = require("../src/drivers/bg3");
const { loadRecipe } = require("../src/recipes");
const { loadPack } = require("../src/manifest");

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function moduleNode({ name, folder, id }) {
  return `<node id="ModuleShortDesc">
    <attribute id="Folder" type="LSString" value="${folder}"/>
    <attribute id="MD5" type="LSString" value="d41d8cd98f00b204e9800998ecf8427e"/>
    <attribute id="Name" type="LSString" value="${name}"/>
    <attribute id="PublishHandle" type="uint64" value="1"/>
    <attribute id="UUID" type="guid" value="${id}"/>
    <attribute id="Version64" type="int64" value="36028797018963968"/>
  </node>`;
}

test("the BG3 driver records the active module list in the pack", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-bg3-driver-"));
  const source = path.join(base, "data");
  const gameRoot = path.join(base, "game");
  const out = path.join(base, "pack");
  try {
    write(path.join(source, "Mods", "ModA_uuid.pak"), "a");
    write(path.join(source, "Mods", "extra.pak"), "extra");
    write(path.join(source, "Script Extender", "Test", "Config.json"), "{}");
    const xml = `<save><version major="4" minor="8"/><region id="ModuleSettings"><node id="root"><children>
      <node id="Mods"><children>
        ${moduleNode({ name: "Mod A", folder: "ModA_uuid", id: "11111111-1111-1111-1111-111111111111" })}
        ${moduleNode({ name: "GustavX", folder: "GustavX", id: "22222222-2222-2222-2222-222222222222" })}
      </children></node>
    </children></node></region></save>`;
    write(path.join(source, "PlayerProfiles", "Public", "modsettings.lsx"), xml);
    write(path.join(gameRoot, "bin", "DWrite.dll"), "dll");
    write(path.join(gameRoot, "bin", "ScriptExtenderSettings.json"), "{}");
    const bg3le = path.join(base, "bg3le");
    write(path.join(bg3le, "build", "libbg3le.so"), "library");
    write(path.join(bg3le, "install.py"), "installer");

    const result = await buildPack({
      recipe: loadRecipe("bg3-modded"),
      source,
      out,
      version: "2026.11.21",
      gameRoot,
      bg3leRoot: bg3le,
    });

    assert.equal(result.pack.id, "bg3-modded");
    assert.equal(result.pack.contents.kind, "mods");
    assert.equal(result.pack.contents.count, 1);
    assert.equal(result.pack.contents.modules, 2);
    assert.equal(result.pack.contents.paks, 2);
    assert.equal(result.pack.contents.inactivePaks.length, 1);
    assert.equal(result.pack.contents.mods[0].name, "Mod A");
    assert.equal(result.pack.contents.mods[0].file, "Mods/ModA_uuid.pak");
    assert.equal(result.pack.contents.mods[1].builtin, true);

    assert.equal(result.pack.platforms["linux-native"].exe, "bin/bg3");
    assert.equal(result.pack.platforms["linux-native"].gameProcess, "bg3.bg3le-real");
    assert.equal(result.pack.platforms["linux-native"].gameProcessAlt, "bg3");
    assert.equal(result.pack.platforms["linux-native"].template, "games/bg3-native.sh");
    assert.equal(result.pack.platforms["linux-proton"].gameProcess, "bg3.exe");
    assert.match(result.pack.platforms["linux-proton"].dataDir, /^%PREFIX%/);
    assert.equal(result.pack.install.bg3le.version, "0.4.6");

    const loaded = loadPack(out);
    assert.equal(loaded.pack.contents.count, 1);
    assert.equal(loaded.files.files.filter((f) => f.target.startsWith("mods/bg3/")).length > 0, true);
    const dll = loaded.files.files.find((f) => f.target.endsWith("/bg3se/DWrite.dll"));
    assert.deepEqual(dll.platforms, ["windows", "linux-proton"]);
    const pak = loaded.files.files.find((f) => f.target.endsWith("/Mods/ModA_uuid.pak"));
    assert.equal(pak.platforms, undefined);
    const extConfig = loaded.files.files.find((f) => f.target.endsWith("/Script Extender/Test/Config.json"));
    assert.equal(extConfig.platforms, undefined);
    const nativeFiles = loaded.files.files.filter((f) => !f.platforms || f.platforms.includes("linux-native"));
    assert.ok(nativeFiles.some((f) => f.target.endsWith("/Script Extender/Test/Config.json")));
    assert.ok(nativeFiles.some((f) => f.target === "tools/bg3le/build/libbg3le.so"));
    assert.ok(!nativeFiles.some((f) => f.target.endsWith("/bg3se/DWrite.dll")));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
