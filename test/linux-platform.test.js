"use strict";

/**
 * Contract: the Linux launcher receives the profile pattern and the full
 * process list, not just the primary executable. The shell template is
 * responsible for resolving both at launch time.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { remove, tempDir } = require("../test-support/harness");
const linux = require("../dist/src/platforms/linux");

test("the Linux launcher carries the profile pattern and all game processes", () => {
  const root = tempDir("modsync-linux-platform-");
  try {
    const base = { exe: "bin/game.exe", gameProcess: "game.exe", gameProcessAlt: "alt.exe", template: "loaders/me3.sh" };
    const pack = {
      id: "test-pack",
      name: "Test Pack",
      game: { id: "test", title: "Test Game", appId: 1, installDir: "Test" },
      mod: { id: "testmod", version: "1.0.0" },
      launch: { type: "me3", mode: "loader", steamAppId: 1 },
      loader: { type: "me3", saveFile: "save.sav" },
      profilePattern: "profiles/{mod}-{version}.me3",
      platforms: {
        windows: { ...base, loader: "tools/me3-win/bin/me3.exe" },
        "linux-proton": { ...base, loader: "tools/me3-linux/bin/me3" },
      },
      art: { grid: "grid.png", icon: "icon.png" },
    };
    const launcher = linux.writeLauncher({
      pack,
      root,
      game: { root: path.join(root, "game"), prefix: path.join(root, "pfx"), native: false, mode: "proton" },
    });
    const text = fs.readFileSync(launcher, "utf8");
    assert.match(text, /GAME_PROCESSES="game\.exe alt\.exe"/);
    assert.match(text, /PROFILE_PATTERN="profiles\/\{mod\}-\{version\}\.me3"/);
    assert.match(text, /SAVE_FILE="save\.sav"/);
    assert.match(text, /LOADER_REL="tools\/me3-/);

    // Game Mode focus: the shortcut's SteamAppId is kept before the launcher
    // replaces it for the game, and the game window is stamped with it.
    const capture = text.indexOf('SHORTCUT_APP_ID="${SteamAppId:-}"');
    const override = text.indexOf('export SteamAppId="$STEAM_APP_ID"');
    assert.ok(capture > -1, "the launcher captures the shortcut app id");
    assert.ok(capture < override, "the shortcut app id is read before the override");
    assert.match(text, /xprop -display "\$display" -id "\$window" -f STEAM_GAME 32c/);
    assert.match(text, /stamp_game_windows/);
    assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/);
  } finally {
    remove(root);
  }
});
