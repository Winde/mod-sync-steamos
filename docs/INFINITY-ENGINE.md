# Infinity Engine family plan

Status: **implemented for the four Steam EE games; IWD2 and EET remain deferred.**

The target is one generic snapshot path for the Steam Enhanced Edition games,
not a pack tied to any particular mod set:

- Baldur's Gate: Enhanced Edition (BG1EE)
- Baldur's Gate II: Enhanced Edition (BG2EE)
- Icewind Dale: Enhanced Edition (IWDEE)
- Planescape: Torment: Enhanced Edition (PSTEE)

Icewind Dale II and EET are deliberately separate tracks and are deferred.

## Why a family driver

All four EE games use the same WeiDU install shape:

```text
override/                 installed mod resources
lang/<lang>/dialog.tlk    active language text table
lang/<lang>/dialogf.tlk   optional female table
WeiDU.log                 installed TP2/component order
weidu.conf                selected language
```

Mods install resources into `override/`, patch the active text table, and
occasionally add root-level runtime files. The game-specific differences are
metadata (Steam app, install folder, exe), the optional Windows loader, native
Linux exe names, and a few DLC/base-preparation cases.

The implementation should therefore be:

- one shared Infinity Engine snapshot core;
- thin per-game drivers that only supply the game table;
- one generic `infinity` install adapter;
- generic InfinityLoader/EEex detection;
- recipes per mod set, not per game implementation.

No mod names belong in code. Pack contents and the dashboard list are derived
from the source install (`WeiDU.log`, `override/`, the active text table, and
detected runtime files).

## Base/mod boundary from Steam depot manifests

Steam keeps the installed depot manifests under the Steam installation's
`depotcache/`, named `<depot>_<manifest>.manifest`. The appmanifest lists the
installed depot and manifest IDs.

Parsing those manifests gives the exact base file list for the installed build:
relative paths, sizes, and content hashes, including the executable depot and
installed DLC depots. The local manifests already prove this:

- BG2EE: `257351` (exe/redist) + `257354` (content)
- BG1EE: `228281` (exe/redist) + `228284` (content) + `385970` (SoD DLC)
- PSTEE: `466301` (content) + `466302` (exe/redist)

This lets the builder distinguish:

- base files that are unchanged: exclude;
- base files that changed: include only when they are required runtime data
  (text tables, `engine.lua`, and similar), and report the rest;
- paths absent from the base manifests: mod-added, subject to the selection
  rules below.

It avoids a clean reference copy, a hand-maintained per-build manifest, and any
list of known mods. The parser is a small local protobuf reader; the manifest
has a short binary header/footer and a stable `ContentManifest`/`FileMapping`
layout. A saved parsed list can be cached in `state/` for builds when Steam has
cleared `depotcache/`.

Fallback for GOG/local installs (notably IWD2): generate a base manifest once
from a clean install, or use conservative rules and require review.

## Snapshot pack pipeline

1. Resolve the source game root and Steam build.
2. Read the base file list from the installed depot manifests.
3. Read `WeiDU.log` for mod list and component count.
4. Read `weidu.conf` for the active language.
5. Detect a Windows loader by files, not by game id:
   - `InfinityLoader.exe`, `InfinityLoader.ini`, `EEex.dll`;
   - parse `ExeNames` and `ExeSwitchAlias` from the ini.
6. Select runtime files (below).
7. Write one `payload.tar.gz` with:
   - `override/`
   - `root/` (modified base files and root-level mod runtime)
   - `modsync.json` (game, build, language, loader description, selection)
   - `meta/WeiDU.log` for reference
   - `meta/selection.json` with every included/excluded path and reason
8. Copy loader support files separately under `tools/infinityloader/`.
9. Emit `pack.json`/`files.json` and contents derived from `WeiDU.log`.

One compressed tar is intentional. The current BG2EE install has 44,056
`override` files; a file-per-request transfer is unusable. The tar keeps the
pack manifest small, makes resume and hashing one operation, and gives the
adapter an atomic payload.

## File selection rules

Default include:

- `override/**` (WeiDU installs runtime resources here; the base game ships an
  empty `override/`);
- the active `lang/<lang>/dialog.tlk` and `dialogf.tlk` when present;
- classic-layout `dialog.tlk`/`dialogf.tlk` at the game root (IWD2);
- base files that changed, when they are required runtime data;
- root-level files that are not in the base manifest and are not installer
  artifacts;
- non-base files under `scripts/`, `Worldmap/`, and similar runtime folders;
- non-base voice/data files under `lang/<lang>/sounds` only when small or when
  the recipe opts in.

Default exclude:

- mod source folders named by `WeiDU.log` (installer sources are not runtime);
- `setup-*`, `*.DEBUG`, `WeiDU.log`, `weidu.conf`, `*.bak-*`, `_*`, `*.log`,
  `*.dmp`, crash dumps;
- `_downloads/`, `weidu_external/`, `InfinityLoader_Crash/`, `.openchamber/`;
- bulk base directories (`data/`, `movies/`, `music/`, `bin/`, `dlc/`, and
  other `lang/` files) unless the recipe sets `includeBaseData`.

Escape hatches, per recipe or build option:

- `includeDirs`: extra top-level folders loaded at runtime by a mod that does
  not install through `override/`;
- `extraFiles`: explicit root-relative paths;
- `includeBaseData`: allow bulk base-directory content for unusual installs
  (for example an EET/base-delta pack);
- `includeModFolders`: keep the mod source folders as well.

The builder always writes `selection.json` and reports total included size and
any modified base files, so the pack can be reviewed before serving.

## Loader handling

InfinityLoader/EEex is Windows-only. It is supported, but only for the
`windows` and `linux-proton` variants.

The adapter reads the loader description in `modsync.json`:

- `gameExe`: the name Steam launches (for example `Baldur.exe`, `icewind.exe`);
- `realExe`: the name the loader spawns (for example `BaldurReal.exe`);
- `ini`: `InfinityLoader.ini`;
- `support`: the pack-relative loader support folder.

On install:

1. back up the current `gameExe`;
2. rename `gameExe` to `realExe` if `realExe` is absent;
3. install `InfinityLoader.exe` as `gameExe`;
4. install the loader DLL/database/ini support files;
5. record the original state in `applied.json`.

On rollback/uninstall, restore the original executable and remove files that
the pack created. The Linux launcher repairs the swap before launching the
Steam entry, because a Steam verify or update restores `gameExe`.

If no loader is detected, there is no swap and no Windows-only component. That
is the signal that a native Linux profile is possible.

## Adapter and rollback

`install.type: "infinity"`, one adapter for all games.

- Reject `linux-native` when the pack has a loader.
- Back up `override/` as a directory, the active text tables, and every
  root-level file the pack replaces.
- Move the extracted `override/` into place atomically inside the game root.
- Apply `root/**` with per-file backups.
- Record the complete applied state in the pack directory.
- Update/rollback reverts the previous state first, then applies the target
  version.
- Uninstall restores the backups and removes only pack-owned files.

A target with `WeiDU.log` or a non-empty `override/` is treated as a previous
manual install and blocked unless the recipe declares allowed base-preparation
TP2s (for example DLC Merger for BG1EE + SoD).

No WeiDU or Wine is needed on the deck for a snapshot pack.

## Platforms

| Variant | Use |
|---|---|
| `windows` | Windows source/target; loader swap if present |
| `linux-proton` | SteamOS/Proton; required for loader packs |
| `linux-native` | Only when the pack has no loader; uses the native exe/process from the game table |

Native Linux executable names are game-specific and must be verified against
the installed native depot before shipping:

| Game | Windows exe | Native Linux exe (verify) |
|---|---|---|
| BG1EE | `Baldur.exe` | `BaldursGate` |
| BG2EE | `Baldur.exe` | `BaldursGateII` |
| IWDEE | `icewind.exe` | `IcewindDale` |
| PSTEE | `Torment.exe` | `Torment64` |

## Game table

| Game | Steam app | Install folder | Windows exe | Loader | Special |
|---|---|---|---|---|---|
| BG1EE | 228280 | `Baldur's Gate Enhanced Edition` | `Baldur.exe` | EEex/InfinityLoader | SoD DLC `385970` is an unmerged `dlc/sod-dlc.zip`; DLC Merger is a base-prep step; EET is separate |
| BG2EE | 257350 | `Baldur's Gate II Enhanced Edition` | `Baldur.exe` | EEex/InfinityLoader | EET installs on top of this game; snapshot is not an EET solution |
| IWDEE | 321800 | `Icewind Dale Enhanced Edition` | `icewind.exe` | EEex/InfinityLoader | Expansions are included; no DLC merger |
| PSTEE | 466300 | `Planescape Torment Enhanced Edition` | `Torment.exe` | none (EEex unsupported) | Pure WeiDU/UI mods; native Linux is the easy path |
| IWD2 | GOG/local | varies | `IWD2.exe` | none | No Steam/appmanifest, no native Linux, no EEex; needs a local game provider |

## Special cases

### BG1EE with Siege of Dragonspear

Steam ships SoD as a DLC depot containing `dlc/sod-dlc.zip`. WeiDU mods that
need SoD require DLC Merger first. The pack records whether the source was
merged (`WeiDU.log` has DLC Merger, or the merge state is otherwise detected).
The target must be in the same state before installing; the adapter allows the
declared DLC Merger TP2 as a base-preparation component. The pack does not
ship the merged SoD content.

Without SoD, BG1EE behaves like IWDEE: a normal WeiDU overlay.

### EET

EET is a total conversion installed on BG2EE, not a standalone store game. It
modifies base game data extensively. A snapshot would either need a large
base-data delta or ship base game content. The planned solution is a replay or
base-delta mode, not the snapshot path. Deferred.

### IWD2

IWD2 has the same runtime shape (`override/`, classic root `dialog.tlk`,
WeiDU `GAME_IS iwd2`, no EEex), but it is GOG/local only:

- no Steam appmanifest or depot manifest;
- no native Linux build;
- no Steam app id for the launch template;
- usually runs through Wine/Proton on SteamOS.

The missing work is a **local game provider**: configured game root and prefix,
game detection without Steam, a non-Steam launch/shortcut, and a clean-install
base manifest or conservative selection. The overlay adapter itself is the same.
Deferred as a separate track.

### Native Linux

BG1EE, BG2EE, IWDEE, and PSTEE have native Linux builds. A no-loader snapshot is
cross-platform data and can support `linux-native`. A loader snapshot cannot:
EEex/InfinityLoader is a Windows binary. Those packs expose only `windows` and
`linux-proton`.

## Phases

1. **Core** — Steam depot-manifest reader; shared Infinity file selection;
   one tar payload; generic `infinity` adapter; InfinityLoader ini detection;
   selection report; tests with fake roots.
2. **Reference games** — BG2EE and PSTEE (one loader, one no-loader) to prove
   the shared path, then BG1EE and IWDEE from the same table.
3. **Native + base prep** — native profiles for no-loader packs; BG1EE SoD
   merge-state handling and base-preparation allowlist.
4. **Separate tracks** — EET replay/base delta; IWD2 local/GOG provider.

## Implementation

- `src/steam-depot.ts` — reads installed depot manifests from Steam's
  `depotcache/` and returns the base file set.
- `src/drivers/infinity.ts` — shared game table, WeiDU parsing, language,
  file selection, tar payload, metadata, preconditions, and selection report.
- `src/drivers/bg1.ts`, `bg2.ts`, `iwdee.ts`, `pstee.ts` — thin game drivers.
- `src/installers/infinity.ts` — generic apply/revert/rollback adapter for
  `install.type: "infinity"`.
- `src/loaders/infinityloader.ts` — `InfinityLoader.ini` parsing and
  executable-swap metadata.
- `src/tar.ts` — system-tar wrapper for the single compressed payload.
- `templates/linux/games/infinity.sh` — loader repair + Steam launch helper.
- `recipes/bg1ee-modded.json`, `bg2ee-modded.json`, `iwdee-modded.json`,
  `pstee-modded.json` — generic recipe templates.

Build examples:

```powershell
node bin/modsync.js pack --recipe bg2ee-modded `
  --source "D:\SteamLibrary\steamapps\common\Baldur's Gate II Enhanced Edition" `
  --out packs\bg2ee-modded --version 2026.11.21 `
  --include-dirs some-mod-folder
```

`--include-dirs` is the escape hatch for a mod that loads files from its own
top-level folder instead of installing them into `override/`. `--extra-files`
forces individual paths, and `--include-base-data` is for total conversions
that change bulk `data/`, `lang/`, `movies/`, `music/`, `bin/` or `dlc/`
content.

The builder refuses a partially removed InfinityLoader install: if loader
DLLs/database or a loader-stub executable are present but
`InfinityLoader.exe`/`InfinityLoader.ini` are gone, repair EEex before
building.

## Non-goals for this plan

- no hardcoded mod list;
- no WeiDU replay in the first pass;
- no base game copying;
- no save transfer;
- no EET/IWD2 in the first pass.
