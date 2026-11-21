const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const steam = require("../src/steam");

function shortcut(name, exe) {
  return { appname: name, Exe: `"${exe}"`, StartDir: `"${exe}"` };
}

test("registering the same shortcut twice keeps one entry", () => {
  const entry = shortcut("ModSync", "/home/tv/ModSync/launch.sh");
  const first = steam.mergeShortcut([], entry);
  assert.equal(first.action, "added");
  assert.equal(first.list.length, 1);

  const second = steam.mergeShortcut(first.list, entry);
  assert.equal(second.action, "updated");
  assert.equal(second.list.length, 1);
});

test("existing duplicate shortcuts collapse to one", () => {
  const entry = shortcut("ModSync", "/home/tv/ModSync/launch.sh");
  const out = steam.mergeShortcut([entry, entry, entry], entry);
  assert.equal(out.action, "updated");
  assert.equal(out.list.length, 1);
  assert.equal(out.deduped, 2);
});

test("the same executable under a new name reuses the entry", () => {
  const oldEntry = shortcut("Old ModSync", "/home/tv/ModSync/launch.sh");
  const newEntry = shortcut("ModSync", "/home/tv/ModSync/launch.sh");
  const out = steam.mergeShortcut([oldEntry], newEntry);
  assert.equal(out.list.length, 1);
  assert.equal(out.list[0].appname, "ModSync");
});

test("different shortcuts are preserved", () => {
  const a = shortcut("ModSync", "/home/tv/ModSync/launch.sh");
  const b = shortcut("Graceborne", "/home/tv/ModSync/packs/g/launch.sh");
  const out = steam.mergeShortcut([a], b);
  assert.equal(out.list.length, 2);
});

test("registerShortcut writes one Steam entry and updates it on a second run", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-steam-"));
  const oldEnv = {
    home: process.env.HOME,
    pf: process.env["ProgramFiles(x86)"],
    pfx: process.env.ProgramFiles,
  };
  let userConfig;
  try {
    if (process.platform === "win32") {
      const pf = path.join(base, "ProgramFiles");
      process.env["ProgramFiles(x86)"] = pf;
      process.env.ProgramFiles = pf;
      userConfig = path.join(pf, "Steam", "userdata", "123", "config");
    } else {
      process.env.HOME = path.join(base, "home");
      userConfig = path.join(process.env.HOME, ".steam", "steam", "userdata", "123", "config");
    }
    fs.mkdirSync(userConfig, { recursive: true });

    const art = path.join(base, "art.png");
    fs.writeFileSync(art, Buffer.from("not a real png, but copied by path"));
    const args = {
      exePath: process.platform === "win32" ? "C:\\ModSync\\launch.cmd" : "/home/tv/ModSync/launch.sh",
      name: "ModSync",
      icon: art,
      art: { grid: art, hero: art, logo: art, header: art, portrait: art, icon: art },
    };

    const first = await steam.registerShortcut(args);
    const second = await steam.registerShortcut(args);
    assert.equal(first.action, "added");
    assert.equal(second.action, "updated");
    assert.equal(second.appId, first.appId);

    const parser = require("steam-shortcut-editor");
    const parsed = await new Promise((resolve, reject) => {
      parser.parseFile(path.join(userConfig, "shortcuts.vdf"), { autoConvertArrays: true, autoConvertBooleans: true }, (err, value) => {
        if (err) reject(err); else resolve(value);
      });
    });
    const list = Array.isArray(parsed.shortcuts) ? parsed.shortcuts : Object.values(parsed.shortcuts || {});
    assert.equal(list.filter((s) => String(s.appname || s.AppName || "").toLowerCase() === "modsync").length, 1);
    for (const suffix of [".png", "p.png", "_grid.png", "_hero.png", "_logo.png", "_icon.png"]) {
      assert.ok(fs.existsSync(path.join(userConfig, "grid", `${first.appId}${suffix}`)), `missing art ${suffix}`);
    }
  } finally {
    if (oldEnv.home === undefined) delete process.env.HOME; else process.env.HOME = oldEnv.home;
    if (oldEnv.pf === undefined) delete process.env["ProgramFiles(x86)"]; else process.env["ProgramFiles(x86)"] = oldEnv.pf;
    if (oldEnv.pfx === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = oldEnv.pfx;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("findGame reads the install directory from the app manifest", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-steam-manifest-"));
  const oldRoot = process.env.STEAM_ROOT;
  t.after(() => {
    if (oldRoot === undefined) delete process.env.STEAM_ROOT; else process.env.STEAM_ROOT = oldRoot;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  process.env.STEAM_ROOT = root;
  fs.mkdirSync(path.join(root, "steamapps", "common", "Actual Folder", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "steamapps", "appmanifest_999999.acf"), `"AppState"
{
  "appid" "999999"
  "installdir" "Actual Folder"
  "buildid" "12345"
}
`);
  fs.writeFileSync(path.join(root, "steamapps", "common", "Actual Folder", "bin", "game.exe"), "");
  const game = steam.findGame({ appId: 999999, installDir: "Wrong Folder", exe: "bin/game.exe" });
  assert.ok(game);
  assert.equal(game.installDir, "Actual Folder");
  assert.equal(game.root, path.join(root, "steamapps", "common", "Actual Folder"));
  assert.equal(game.build, "12345");
  assert.ok(game.exe.endsWith(path.join("bin", "game.exe")));
});
