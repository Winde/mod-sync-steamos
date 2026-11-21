const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildPack, contentsFor } = require("../dist/src/drivers/bg3");
const { loadRecipe } = require("../dist/src/recipes");
const { loadPack } = require("../dist/src/manifest");

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
      driverOptions: { bg3leRoot: bg3le },
    });

    assert.equal(result.pack.id, "bg3-modded");
    assert.equal(result.pack.contents.count, 1);
    assert.equal(result.pack.contents.itemsLabel, "Included mods");
    assert.deepEqual(result.pack.contents.items.map((item) => item.label), ["Mod A"]);
    assert.equal(result.pack.contents.items[0].path, "Mods/ModA_uuid.pak");
    assert.deepEqual(result.pack.contents.inactive, ["extra.pak"]);

    assert.equal(result.pack.platforms["linux-native"].exe, "bin/bg3");
    assert.equal(result.pack.platforms["linux-native"].gameProcess, "bg3.bg3le-real");
    assert.equal(result.pack.platforms["linux-native"].gameProcessAlt, "bg3");
    assert.equal(result.pack.platforms["linux-native"].template, "games/bg3-native.sh");
    assert.equal(result.pack.platforms["linux-proton"].gameProcess, "bg3.exe");
    assert.match(result.pack.platforms["linux-proton"].dataDir, /^%PREFIX%/);
    assert.equal(result.pack.install.options.bg3le.version, "0.4.6");
    assert.equal(result.pack.install.options.bg3se, true);
    assert.equal(result.pack.launch.profile, undefined);
    assert.equal(result.pack.launch.saveFile, undefined);

    const contents = contentsFor({
      recipe: loadRecipe("bg3-modded"),
      source,
      version: "2026.11.21",
    });
    assert.equal(contents.count, 1);
    assert.equal(contents.itemsLabel, "Included mods");
    assert.deepEqual(contents.items.map((item) => item.label), ["Mod A"]);
    assert.deepEqual(contents.inactive, ["extra.pak"]);

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
