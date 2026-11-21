# BG3 sync acceptance test

This is the test for the machine set aside for BG3. It checks the real
`modsettings.lsx` / `Mods` / BG3SE deployment, not a fixture.

## Prerequisites

- SteamOS/Linux machine with **Baldur's Gate 3** installed.
- BG3 has been launched once so the Proton prefix exists.
- BG3 is on **build 25605617 (Patch 8)**. The pack refuses a different build.
- PC and TV are on the same LAN.
- ModSync 0.1.0 or newer is installed on the TV.

## PC

```powershell
cd D:\source\mod-sync-steamos
node bin/modsync.js serve --lan --packs packs --port 8787 --token <token>
```

The pack list should include `BG3 Modded 2026.11.21`.

## TV

Run the install one-liner printed by `serve` (Desktop Mode):

```bash
curl -fsSL 'https://github.com/Winde/mod-sync-steamos/releases/latest/download/install.sh' \
  | bash -s -- --pc 'http://<PC-LAN-IP>:8787' --token '<token>'
```

Restart Steam once if the ModSync shortcut is not visible, then open ModSync.

## Install

1. **Games → Baldur's Gate 3 → BG3 Modded → Install.**
2. Expect **3.13 GB · 94 files · 72 mods**.
3. Let it finish. BG3 is a default-exe pack, so the app should **not** add a
   second game shortcut; the regular Steam entry is the launch path.

## Verify on the TV (no Node)

Use the prefix path for the Steam library that holds BG3:

```bash
PFX="$HOME/.local/share/Steam/steamapps/compatdata/1086940/pfx"
DATA="$PFX/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3"

# 78 pak files deployed
find "$DATA/Mods" -maxdepth 1 -name '*.pak' | wc -l

# modsettings contains the expected module
grep -c '<node id="ModuleShortDesc">' "$DATA/PlayerProfiles/Public/modsettings.lsx"

# BG3SE loader present in the game
ls -l "<BG3 install>/bin/DWrite.dll"
ls -l "<BG3 install>/bin/ScriptExtenderSettings.json"
```

Then launch BG3 from the **regular Steam library entry** and confirm a mod is
active in game (for example a modded class or UI element). Check the BG3SE log
if a Script Extender mod does not load.

## Rollback

Rollback needs a second installed version. I will prepare a second BG3 pack
version on the PC when this test is scheduled. Then:

1. Install the second version.
2. ModSync → **Roll back**.
3. Confirm the older `modsettings.lsx`/paks are active again.
4. Saves are not rolled back.

## Remove

ModSync → **Storage → Remove pack**. The apply step should:

- remove the pak files it added;
- restore the previous `modsettings.lsx`;
- restore the original `DWrite.dll` / `ScriptExtenderSettings.json`;
- leave the game and saves intact.

Confirm BG3 still launches after removal.

## Report

- Pack install result and file count.
- `find`/`grep` output from the prefix.
- Whether the game showed the mod.
- BG3SE log if relevant.
- Rollback/remove result, if tested.
