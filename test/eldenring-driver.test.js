const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildPack } = require("../src/drivers/eldenring");
const { loadRecipe } = require("../src/recipes");
const { loadPack } = require("../src/manifest");

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function fixture() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-er-src-"));
  for (const [mod, version] of [["graceborne", "1.0.0"], ["convergence", "2.0.0"]]) {
    write(path.join(src, "mods", mod, "versions", version, "mod", "file.bin"), `${mod}-${version}`);
    write(path.join(src, "mods", mod, "current.txt"), `${version}\n`);
    write(path.join(src, "profiles", `${mod}-${version}.me3`), `profileVersion = "v1"
savefile = "ER0000.${mod}.sl2"
start_online = false

[[natives]]
path = '../mods/${mod}/versions/${version}/mod/loader.dll'
optional = false
enabled = true

[[packages]]
enabled = true
path = '../mods/${mod}/versions/${version}/mod'
load_after = []
load_before = []
`);
    for (const art of ["grid", "hero", "logo", "icon"]) {
      write(path.join(src, "art", mod, `${art}.png`), `art-${mod}-${art}`);
    }
  }
  write(path.join(src, "tools", "me3-linux", "bin", "me3"), "#!/bin/sh\n");
  write(path.join(src, "tools", "me3-linux", "win64", "me3.exe"), "win");
  write(path.join(src, "tools", "me3-win", "bin", "me3.exe"), "win");
  return src;
}

test("the Elden Ring driver builds recipes without knowing the mod ids in code", async () => {
  const src = fixture();
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-er-out-"));
  try {
    const grace = await buildPack({
      recipe: loadRecipe("eldenring-graceborne"),
      source: src,
      out: path.join(outRoot, "grace"),
    });
    const convergence = await buildPack({
      recipe: loadRecipe("eldenring-convergence"),
      source: src,
      out: path.join(outRoot, "convergence"),
    });

    assert.equal(grace.pack.id, "eldenring-graceborne");
    assert.equal(grace.pack.name, "Graceborne");
    assert.equal(grace.pack.mod.id, "graceborne");
    assert.equal(grace.pack.launch.saveFile, "ER0000.graceborne.sl2");
    assert.equal(grace.pack.contents.kind, "packages");
    assert.equal(grace.pack.contents.count, 1);
    assert.match(grace.pack.contents.packages[0].path, /mods\/graceborne\/versions\/1\.0\.0\/mod/);
    const graceDoc = loadPack(path.join(outRoot, "grace")).files;
    assert.ok(graceDoc.files.some((f) => f.target.startsWith("mods/graceborne/")));

    assert.equal(convergence.pack.id, "eldenring-convergence");
    assert.equal(convergence.pack.name, "The Convergence");
    assert.equal(convergence.pack.mod.id, "convergence");
    assert.equal(convergence.pack.launch.saveFile, "ER0000.convergence.sl2");
    assert.ok(convergence.pack.preconditions.some((p) => p.id === "sote" && p.type === "manual"));
    assert.ok(convergence.pack.notes.some((n) => n.title.includes("Shadow of the Erdtree")));

    const loaded = loadPack(path.join(outRoot, "convergence"));
    assert.equal(loaded.pack.id, "eldenring-convergence");
    assert.equal(loaded.files.pack, "eldenring-convergence");
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(outRoot, { recursive: true, force: true });
  }
});

test("missing recipes are rejected", () => {
  assert.throws(() => loadRecipe("not-a-recipe"), /recipe not found/);
});
