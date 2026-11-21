# Design

## Three layers

1. **Core** — game-agnostic. Reads packs, copies/streams files, verifies hashes,
   tracks versions, runs jobs, serves HTTP, records logs.
2. **Game driver** — knows one game family: source layout, pack metadata, loader,
   launch fields, version/build checks. `drivers/eldenring.js` is v1.
3. **Platform decorator** — OS paths, permissions, Proton prefix, launchers,
   shortcuts, art. Windows and SteamOS.

Adding a game means adding a driver and a pack. The core does not change.

## Pack

```
pack.json          metadata: game, mod, launch, art, files manifest path
files.json         source -> target, size, sha256, mode
payload/           the mod files (hardlinked or copied)
profiles/          loader profile (me3)
tools/             loader runtime (me3 Linux/Windows)
art/               grid/hero/logo/icon
README.md
```

A pack never contains the base game or saves.

`pack.json` (v1):

```json
{
  "schema": 1,
  "id": "eldenring-graceborne",
  "name": "Graceborne",
  "game": {
    "id": "eldenring",
    "title": "ELDEN RING",
    "store": "steam",
    "appId": 1245620,
    "installDir": "ELDEN RING",
    "build": "25827938",
    "version": "1.17",
    "prefix": true
  },
  "mod": { "id": "graceborne", "version": "0.2.7" },
  "loader": { "type": "me3", "profile": "profiles/graceborne-0.2.7.me3" },
  "launch": {
    "type": "me3",
    "exe": "Game/eldenring.exe",
    "gameProcess": "eldenring.exe",
    "steamAppId": 1245620,
    "profile": "profiles/graceborne-0.2.7.me3",
    "saveFile": "ER0000.graceborne.sl2",
    "me3": "tools/me3-linux/bin/me3",
    "windowsBinaries": "tools/me3-linux/win64"
  },
  "art": {
    "grid": "art/graceborne/grid.png",
    "hero": "art/graceborne/hero.png",
    "logo": "art/graceborne/logo.png",
    "icon": "art/graceborne/icon.png"
  },
  "files": "files.json"
}
```

`files.json`:

```json
{
  "schema": 1,
  "pack": "eldenring-graceborne",
  "version": "0.2.7",
  "files": [
    {
      "source": "payload/versions/0.2.7/mod/regulation.bin",
      "target": "mods/graceborne/versions/0.2.7/mod/regulation.bin",
      "size": 2097152,
      "sha256": "…",
      "mode": "644"
    }
  ]
}
```

The agent writes files whose target starts with
`mods/<mod>/versions/<version>/` into a staging directory, then swaps it in.
Profiles/tools/art are written directly under the pack install root.

## Restrictions

A game is in scope when:

- the base game is installed by a store on the target (never shipped);
- the install path and build/version are identifiable (Steam appmanifest first);
- the loader is command-line launchable with a profile/path (me3, SKSE,
  BG3MM, WeiDU);
- the mod shape is an **overlay**, a **profile manager**, or a deterministic
  **in-place recipe**;
- saves are local files (saves are out of v1 anyway);
- online/anti-cheat is either absent or enforced offline by the loader.

v1 supports overlay packs on SteamOS. Profile/in-place drivers come later.

## v1 vs v2

- v1: mods only, ER + SteamOS, HTTP pull, dashboard, deploy/update/launch.
- v2: save sync as a separate module. It needs per-game save models, account
  identity checks, conflict handling, Steam Cloud interaction, atomic writes
  and validation. It is not a generic file copy.

## Console/terminal

The Linux launcher starts me3, waits for the game process, waits for exit, then
stops me3 and exits. The `.desktop` uses `Terminal=false`. Windows uses the same
wait/kill pattern in PowerShell.
