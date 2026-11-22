const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildOptions, buildPack, contentsFor, parseModSettings } = require("../dist/src/drivers/bg3");
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

test("BG3 contents match published pak names without crossing duplicate prefixes", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-bg3-contents-"));
  const source = path.join(base, "data");
  try {
    const paks = [
      "Path of Undeath.pak",
      "Valkrana's Skeleton Crew.pak",
      "Valkrana's Spellbook.pak",
      "Warlock Spell List Fixer.pak",
      "WotD-Aasimar.pak",
      "extra_encounters_plus_6324f71c7nct.pak",
      "test_27f18a86-94f8-1f5c-760c-1-gxcc.pak",
      "test_4b516620-9c56-aa18-96ae-a-dk21.pak",
      "CombatMod.pak",
    ];
    for (const name of paks) write(path.join(source, "Mods", name), name);
    const modules = [
      { name: "Path of Undeath", folder: "PathOfUndeath", id: "fe04695e-d206-4a88-b3f9-b2a65855ac4c" },
      { name: "Valkrana&apos;s Skeleton Crew", folder: "Valkrana&apos;s Skeleton Crew", id: "0dd8b949-b56e-4248-9bf0-b03b3c3bd8c5" },
      { name: "Valkrana&apos;s Spellbook", folder: "Valkrana&apos;s Spellbook", id: "9deeb371-f01e-41b4-b20e-c5eee0751b12" },
      { name: "Warlock Spell List Fixer", folder: "CharlatanListSupport", id: "da838ab2-4d4b-4ca2-9e11-0257a03b13fc" },
      { name: "Whispers of the Divine: Aasimar Script Extender Edition", folder: "Trips_Aasimar", id: "4806bd2a-929b-406e-b1d4-2e0e9cc23bb2" },
      { name: "Extra encounters and Minibosses", folder: "Extra_encounters_plus_6324f71c-80f2-6c13-b2e8-1c3441fa6072", id: "6324f71c-80f2-6c13-b2e8-1c3441fa6072" },
      { name: "Mystra&apos;s Spells", folder: "Test_4b516620-9c56-aa18-96ae-a9ee4f57b515", id: "4b516620-9c56-aa18-96ae-a9ee4f57b515" },
      { name: "Dread Overlord | Mystra&apos;s Spells - Compatibility", folder: "TEST_27f18a86-94f8-1f5c-760c-18aaa41ab230", id: "27f18a86-94f8-1f5c-760c-18aaa41ab230" },
      { name: "GustavX", folder: "GustavX", id: "cb555efe-2d9e-131f-8195-a89329d218ea" },
    ];
    const xml = `<save><version major="4" minor="8"/><region id="ModuleSettings"><node id="root"><children>
      <node id="Mods"><children>
        ${modules.map(moduleNode).join("\n")}
      </children></node>
    </children></node></region></save>`;
    write(path.join(source, "PlayerProfiles", "Public", "modsettings.lsx"), xml);

    const mods = parseModSettings(xml);
    assert.ok(mods.some((mod) => mod.name === "Valkrana's Skeleton Crew"));
    assert.ok(mods.some((mod) => mod.name === "Mystra's Spells"));

    const contents = contentsFor({ recipe: loadRecipe("bg3-modded"), source, version: "2026.11.21" });
    const byLabel = Object.fromEntries(contents.items.map((item) => [item.label, item.path]));
    assert.equal(contents.count, 8);
    assert.equal(byLabel["Path of Undeath"], "Mods/Path of Undeath.pak");
    assert.equal(byLabel["Valkrana's Skeleton Crew"], "Mods/Valkrana's Skeleton Crew.pak");
    assert.equal(byLabel["Valkrana's Spellbook"], "Mods/Valkrana's Spellbook.pak");
    assert.equal(byLabel["Warlock Spell List Fixer"], "Mods/Warlock Spell List Fixer.pak");
    assert.equal(byLabel["Whispers of the Divine: Aasimar Script Extender Edition"], "Mods/WotD-Aasimar.pak");
    assert.equal(byLabel["Extra encounters and Minibosses"], "Mods/extra_encounters_plus_6324f71c7nct.pak");
    assert.equal(byLabel["Mystra's Spells"], "Mods/test_4b516620-9c56-aa18-96ae-a-dk21.pak");
    assert.equal(byLabel["Dread Overlord | Mystra's Spells - Compatibility"], "Mods/test_27f18a86-94f8-1f5c-760c-1-gxcc.pak");
    assert.deepEqual(contents.inactive, ["CombatMod.pak"]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

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

    assert.deepEqual(buildOptions().map((option) => option.key), ["gameRoot", "bg3leRoot"]);
    const updates = [];
    const result = await buildPack({
      recipe: loadRecipe("bg3-modded"),
      source,
      out,
      version: "2026.11.21",
      driverOptions: { gameRoot, bg3leRoot: bg3le },
      progress: (update) => updates.push(update),
    });

    assert.equal(updates[0].phase, "copying");
    assert.equal(updates[0].done, 0);
    assert.ok(updates.some((update) => update.phase === "copying" && update.done === 2 && update.total === 2));
    assert.ok(updates.some((update) => update.phase === "hashing"));
    assert.equal(updates.at(-1).phase, "hashing");
    assert.equal(updates.at(-1).done, updates.at(-1).total);
    assert.equal(result.pack.id, "bg3-modded");
    assert.equal(result.pack.contents.count, 1);
    assert.equal(result.pack.contents.itemsLabel, "Included mods");
    assert.deepEqual(result.pack.contents.items.map((item) => item.label), ["Mod A"]);
    assert.equal(result.pack.contents.items[0].path, "Mods/ModA_uuid.pak");
    assert.deepEqual(result.pack.contents.inactive, ["extra.pak"]);

    assert.equal(result.pack.platforms["linux-native"].exe, "bin/bg3");
    assert.equal(result.pack.platforms["linux-native"].gameProcess, "bg3");
    assert.equal(result.pack.platforms["linux-native"].template, "games/bg3-native.sh");
    assert.equal(result.pack.platforms["linux-proton"].gameProcess, "bg3.exe");
    assert.match(result.pack.platforms["linux-proton"].dataDir, /^%PREFIX%/);
    assert.equal(result.pack.install.type, "bg3");
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
