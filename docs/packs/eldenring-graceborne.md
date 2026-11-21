# ELDEN RING + Graceborne

Pack id: `eldenring-graceborne` · mod version: `0.2.7`

This is pack-specific setup. The generic install flow is in the
[README](../../README.md).

## Steam Machine prerequisites

1. Install **ELDEN RING** via Steam.
2. Launch the vanilla game once so the Proton prefix is created. The agent
   refuses to install without it.
3. In the game's Steam properties, set **Only update this game when I launch
   it** and keep the game on **1.17 (build 25827938)**. The pack pins that
   build; the agent refuses to install on a different one.
4. Run the ModSync bootstrap from `serve`, then install the pack from the TV
   dashboard.

## Launch

The agent writes a Linux launcher and a `.desktop` shortcut. Launch through
that shortcut (Game Mode or Desktop Mode), not the Steam Play button, so me3
loads the profile.

- Launcher: waits for `eldenring.exe`, then stops me3 when the game exits.
- Profile: `profiles/graceborne-<version>.me3`.
- Game process: `eldenring.exe`.

## Saves

- Vanilla save: `ER0000.sl2` — untouched; Steam Cloud keeps syncing it.
- Mod save: `ER0000.graceborne.sl2` — local to each machine, not synced.
- v1 does not transfer saves. The TV creates its own mod save on first launch.

## Rollback

Build and install 0.2.5 before 0.2.7 if you want a rollback target:

```powershell
node bin/modsync.js pack --source "D:\EldenRingMods" --version 0.2.5
node bin/modsync.js pack --source "D:\EldenRingMods" --version 0.2.7
```

The dashboard switches `current.txt` back to the older version; the save is
not rolled back.
