# Design

## Three layers

1. **Core** — game-agnostic. Reads packs, copies/streams files, verifies hashes,
   tracks versions, runs jobs, serves HTTP, records logs.
2. **Game driver** — knows one game family: source layout, pack metadata, loader,
   launch fields, version/build checks. `drivers/eldenring.js` is v1.
3. **Platform decorator** — OS paths, permissions, Proton prefix, launchers,
   shortcuts, art. Windows and SteamOS.

Adding a game means adding a driver and a pack. The core does not change.

## Process model and exposure

- **PC** — the pack server is the only LAN listener. It binds one private IPv4
  (`serve --lan` or `--host`), refuses `0.0.0.0`, requires a token, and is scoped
  to the local subnet. It is never port-forwarded.
- **Steam Machine** — the Electron app runs the installer in its main process.
  The renderer uses IPC; there is no LAN listener. If a local control API is
  kept for automation, it binds `127.0.0.1` and uses a per-run token.
- **Discovery** — no hardcoded PC address. The client discovers `_modsync._tcp`
  over mDNS or stores the URL printed by `serve --lan`, and can re-pair when the
  address changes.

Multiple people can run this project on different LANs without editing code:
the bind address is detected or passed explicitly, and the firewall rule uses
`LocalSubnet`.


## Pack

```
pack.json          metadata: game, mod, launch, art, files manifest path
files.json         source -> target, size, sha256, mode
payload/           the mod files (hardlinked or copied)
profiles/          loader profile (me3 for ELDEN RING; modsettings for BG3)
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
  "platforms": {
    "windows": {
      "exe": "Game/eldenring.exe",
      "gameProcess": "eldenring.exe",
      "loader": "tools/me3-win/bin/me3.exe",
      "template": "loaders/me3.sh"
    },
    "linux-proton": {
      "exe": "Game/eldenring.exe",
      "gameProcess": "eldenring.exe",
      "loader": "tools/me3-linux/bin/me3",
      "loaderSupport": "tools/me3-win/bin",
      "template": "loaders/me3.sh"
    }
  },
  "loader": { "type": "me3", "profile": "profiles/graceborne-0.2.7.me3" },
  "profilePattern": "profiles/{mod}-{version}.me3",
  "launch": {
    "type": "me3",
    "mode": "loader",
    "exe": "Game/eldenring.exe",
    "defaultExe": "Game/eldenring.exe",
    "gameProcess": "eldenring.exe",
    "steamAppId": 1245620,
    "profile": "profiles/graceborne-0.2.7.me3",
    "saveFile": "ER0000.graceborne.sl2"
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

Steam layers `logo` over `hero` on the library details page. Keep `hero` free
of the mod name, and make `logo` a transparent wordmark; otherwise the name is
drawn twice.

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
    },
    {
      "source": "tools/me3-win/bin/me3_mod_host.dll",
      "target": "tools/me3-win/bin/me3_mod_host.dll",
      "size": 6571816,
      "sha256": "…",
      "mode": "644",
      "platforms": ["windows", "linux-proton"]
    }
  ]
}
```

### Platform profiles

A pack is built once and served to Windows and Linux machines. `platforms`
holds the values that differ per machine:

| Variant | Selected when |
|---|---|
| `windows` | the agent runs on Windows |
| `linux-proton` | Linux and the game has a Proton prefix |
| `linux-native` | Linux and the game exposes its native executable |

The installer resolves one profile at install time. A pack only supports the
variants it lists; a game installed in an unsupported mode is blocked with an
explanation instead of writing to the wrong folder. `exe`, `gameProcess`, and
`loader` are relative to the game root or pack root; `dataDir` and `saveDir` are
absolute after token expansion:

| Token | Value |
|---|---|
| `%HOME%` | the user's home directory |
| `%DATA_HOME%` | `XDG_DATA_HOME` on Linux, `%LOCALAPPDATA%` on Windows |
| `%LOCALAPPDATA%` | the Windows local app data directory |
| `%APPDATA%` | the Windows roaming app data directory |
| `%PREFIX%` | the game's Proton prefix |
| `%GAME%` | the game install root |

`files[].platforms` narrows a download to specific variants. Omitting it means
all platforms. Shared mod payloads stay untagged and exist once; only loader
binaries carry platform tags. When two targets have identical content, the pack
keeps one source file and both targets point at it. Run `npm run packs:check`
before serving a pack to verify profiles, loader coverage, target portability,
and duplicate storage.

The generic installer has no game or loader names. `install.type` selects an
adapter in `src/installers/` for game-specific apply/revert work. The launcher
is a template chosen by `platforms.<variant>.template`; the only built-in
default is the generic `launch-steam.sh`. Loader templates live under
`templates/linux/loaders/`, game-specific templates under
`templates/linux/games/`. `loader` and `loaderSupport` are pack-relative paths
passed to the template as `LOADER` and `LOADER_SUPPORT`. `profilePattern` is
the versioned profile path used by rollback and old-version cleanup. The
dashboard summarizes `install` with `install.label`.

### Notes

`notes` is optional, human-readable guidance for steps the core does not
automate. The dashboard shows it before install and in Details; the Electron
client renders the same array.

```json
"notes": [
  {
    "title": "Stay on build 25827938",
    "body": "Set Only update this game when I launch it in Steam.",
    "tone": "warning"
  }
]
```

A note is either a string or `{ title?, body, tone? }`, where `tone` is
`info` (default), `warning`, `error`, or `success`.

### Preconditions

`preconditions` is optional, structured and machine-checked. Each entry has an
`id`, a `type`, and `required` (default `false`). A check may list `platforms`;
on other variants it is skipped with a pass and a “Not needed” detail.

```json
"preconditions": [
  { "id": "game", "type": "game-installed", "required": true },
  { "id": "build", "type": "game-build", "required": true, "build": "25827938" },
  { "id": "prefix", "type": "proton-prefix", "required": true,
    "hint": "Launch the vanilla game once from Steam." },
  { "id": "space", "type": "disk-free", "required": true, "reserveBytes": 1073741824 }
]
```

Supported types:

| Type | Checks | Fields |
|---|---|---|
| `game-installed` | Game root exists in a Steam library | — |
| `game-build` | Steam `buildid` matches | `build` (defaults to `game.build`) |
| `game-not-running` | Game process is not running | — |
| `proton-prefix` | Proton prefix exists, or the native build needs no prefix | — |
| `disk-free` | Free space at the TV root, game library, or install target | `bytes` or `reserveBytes`, `scope: "tv" \| "game" \| "target"` |
| `path-exists` | A file/dir exists under home, game, TV root, or target | `path` or `paths`, `scope: "home" \| "game" \| "tv" \| "target"` |
| `dlc-installed` | Steam manifest, installed depot, or DLC paths | `dlcAppId`, `depotIds`, `paths` |
| `manual` | User confirms in the app | `hint` |

Each check returns `pass`, `fail`, or `unknown`. A required `fail` blocks the
install. A required `unknown` also blocks unless the pack sets
`"allowUnknown": true`. Non-required checks are advisory.

Steam does not expose DLC ownership offline. `dlc-installed` therefore checks
**installation**: a DLC app manifest, one of the declared `depotIds` in the base
game's `InstalledDepots`, or a declared file path. When none of those are
configured the check is `unknown`. Use `manual` for purchase-only confirmation.

`"confirmable": true` lets the user confirm any failed/unknown check from the
dashboard; confirmations are stored on the TV at
`state/preconditions.json`. `manual` checks are confirmable by definition.

The agent evaluates the checks for the dashboard and again in the installer, so
an install cannot start from a stale or bypassed dashboard. The same
`src/preconditions.ts` module is used by the Electron client. The installer
adds no build, prefix, running-state, or disk policy of its own: if a pack omits
a check, the install is allowed to proceed. Core invariants stay in the
installer: the game must exist, the platform variant must be supported, and the
resolved target must be valid.

The agent writes files whose target starts with
`mods/<mod>/versions/<version>/` into a staging directory, then swaps it in.
Profiles/tools/art are written directly under the pack install root.

### Launch modes

`launch.mode` tells the TV whether the normal Steam link is enough or a tuned
shortcut is required:

| `mode` | Meaning | Steam shortcut |
|---|---|---|
| `default` | The pack uses the game's normal exe; mods are already in place (BG3) | Use the regular Steam game link; no non-Steam shortcut is added |
| `alternate-exe` | The pack must start a different exe (BG2 `InfinityLoader.exe`) | A non-Steam shortcut/wrapper is required |
| `loader` | The pack starts through a loader (me3) | A non-Steam shortcut launches the loader |

`game.exe` is the vanilla/default exe used for discovery. `launch.exe` is what
the pack actually starts; `launch.defaultExe` records the vanilla target when
they differ. This prevents a default-exe pack from silently getting a duplicate
shortcut, and prevents an alternate-exe pack from being launched through the
wrong Steam entry.

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

## Scope

- v1: mods only, Steam games, HTTP pull, Electron app, deploy/update/rollback/
  launch/storage.
- Save transfer is **out of scope**. It is not committed to a version, and it is
  not a generic file copy if it is ever added. It would need per-game save
  models, account identity checks, conflict handling, Steam Cloud interaction,
  atomic writes, and validation.

## Save boundary

- A pack never contains saves.
- The installer never writes a save directory.
- Steam Cloud handles the vanilla save where the game supports it.
- Mod saves stay local to each machine.
- Save transfer is out of scope and is not promised for a future version.

## Rollback

Installs are versioned:

- `mods/<mod>/versions/<version>/`
- `profiles/<mod>-<version>.me3` for me3 packs; BG3 keeps its versioned
  `modsettings.lsx` inside the version directory.
- `mods/<mod>/current.txt`

The launcher reads `current.txt` at launch. Installing a new version keeps the
previous version and profile. Rollback switches the pointer; the previous
version and profile are not rebuilt or downloaded again.

The installer keeps the version folder; a reinstall of the **same** version
moves the old copy to `<version>.bak-<timestamp>` and leaves it out of the
rollback list. Saves are not versioned in v1.

## Console/terminal

For me3 packs, the Linux launcher starts me3, waits for the game process, waits
for exit, then stops me3 and exits. BG3 packs are applied to the per-platform
data folder at install/rollback time, then the launcher starts the game through
Steam. The `.desktop` uses `Terminal=false`.
