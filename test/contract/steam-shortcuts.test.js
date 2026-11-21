"use strict";

/**
 * Contract: `modsync register` writes a single Steam shortcut with the
 * expected art, updates it instead of duplicating on a second run, collapses
 * pre-existing duplicates, and finds Flatpak Steam roots. The Steam client is
 * never involved; a fake userdata tree is used.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const shortcutEditor = require("steam-shortcut-editor");
const {
  makeSteamEnv,
  remove,
  runCli,
  tempDir,
  write,
} = require("../../test-support/harness");

function readShortcuts(file) {
  return new Promise((resolve, reject) => {
    shortcutEditor.parseFile(file, {
      autoConvertArrays: true,
      autoConvertBooleans: true,
      dateProperties: ["LastPlayTime"],
    }, (err, parsed) => {
      if (err) reject(err);
      else resolve(parsed);
    });
  });
}

function writeShortcuts(file, value) {
  return new Promise((resolve, reject) => {
    shortcutEditor.writeFile(file, value, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function listOf(parsed) {
  return Array.isArray(parsed.shortcuts) ? parsed.shortcuts : Object.values(parsed.shortcuts || {});
}

function makeArt() {
  const dir = tempDir("modsync-steam-art-");
  const files = {};
  for (const name of ["icon", "grid", "hero", "logo", "header", "portrait"]) {
    files[name] = write(dir, `${name}.png`, Buffer.from(`art-${name}`));
  }
  return { dir, ...files };
}

function register(exe, art, env, name = "ModSync") {
  return runCli([
    "register",
    "--exe", exe,
    "--name", name,
    "--icon", art.icon,
    "--grid", art.grid,
    "--hero", art.hero,
    "--logo", art.logo,
    "--header", art.header,
    "--portrait", art.portrait,
  ], { env });
}

test("register writes one shortcut with all art and updates it in place", { timeout: 60000 }, async (t) => {
  const steam = makeSteamEnv();
  const art = makeArt();
  const exe = path.join(tempDir("modsync-steam-exe-"), "modsync-dashboard.sh");
  fs.writeFileSync(exe, "#!/bin/sh\n");

  const configDir = path.join(steam.steamRoot, "userdata", "12345678", "config");
  fs.mkdirSync(configDir, { recursive: true });

  t.after(() => {
    remove(steam.base);
    remove(art.dir);
    remove(path.dirname(exe));
  });

  const first = await register(exe, art, steam.env);
  assert.match(first.stdout, /\(added\)/);

  const file = path.join(configDir, "shortcuts.vdf");
  let entries = listOf(await readShortcuts(file));
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.appname, "ModSync");
  assert.equal(entry.Exe, `"${exe}"`);
  assert.equal(entry.StartDir, `"${path.dirname(exe)}${path.sep}"`);
  assert.equal(entry.icon, art.icon);

  const id = entry.appid >>> 0;
  const grid = path.join(configDir, "grid");
  for (const [source, target] of [
    [art.header, `${id}.png`],
    [art.portrait, `${id}p.png`],
    [art.grid, `${id}_grid.png`],
    [art.hero, `${id}_hero.png`],
    [art.logo, `${id}_logo.png`],
    [art.icon, `${id}_icon.png`],
  ]) {
    assert.deepEqual(fs.readFileSync(path.join(grid, target)), fs.readFileSync(source), target);
  }

  // Duplicate the entry, then re-register. It should update and collapse the
  // duplicate instead of adding a third entry.
  await writeShortcuts(file, { shortcuts: [entry, { ...entry }] });
  const second = await register(exe, art, steam.env);
  assert.match(second.stdout, /\(updated/);
  assert.match(second.stdout, /removed 1 duplicate/);

  entries = listOf(await readShortcuts(file));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].appname, "ModSync");
  assert.ok(
    fs.readdirSync(configDir).some((name) => name.startsWith("shortcuts.vdf.modsync-")),
    "the previous shortcuts.vdf is backed up",
  );

  // Renaming the same executable updates the existing entry rather than
  // adding a second shortcut.
  const renamed = await register(exe, art, steam.env, "ModSync Dashboard");
  assert.match(renamed.stdout, /\(updated/);
  entries = listOf(await readShortcuts(file));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].appname, "ModSync Dashboard");
});

test("register finds a Flatpak Steam root", {
  timeout: 60000,
  skip: process.platform === "win32",
}, async (t) => {
  const steam = makeSteamEnv({ layout: "flatpak" });
  const art = makeArt();
  const exe = path.join(tempDir("modsync-steam-exe-flatpak-"), "modsync-dashboard.sh");
  fs.writeFileSync(exe, "#!/bin/sh\n");

  const configDir = path.join(steam.steamRoot, "userdata", "12345678", "config");
  fs.mkdirSync(configDir, { recursive: true });

  t.after(() => {
    remove(steam.base);
    remove(art.dir);
    remove(path.dirname(exe));
  });

  const result = await register(exe, art, steam.env);
  assert.match(result.stdout, /\(added\)/);

  const entries = listOf(await readShortcuts(path.join(configDir, "shortcuts.vdf")));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].appname, "ModSync");
});
