# Drivers

A driver describes one game family for the pack builder and the agent.

## Pack recipes

A driver knows the **game**: Steam metadata, install layout, loader, launch
mechanics. A recipe in `recipes/<id>.json` knows the **pack**: name, mod id,
save file, platform profiles, notes, and preconditions. Adding a total
conversion is a new recipe, not a driver change.

```json
{
  "schema": 1,
  "id": "eldenring-graceborne",
  "game": "eldenring",
  "name": "Graceborne",
  "modId": "graceborne",
  "artId": "graceborne",
  "saveFile": "ER0000.graceborne.sl2",
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
  "notes": [],
  "preconditions": []
}
```

Drivers provide default profiles for their game; a recipe overrides only the
entries that differ. The builder merges both into `pack.json.platforms`, and the
agent selects a profile from the target OS and the detected game build. A
recipe that does not list `linux-native` makes the agent report that native
Linux needs Proton rather than guessing at a prefix path.

`platforms.<variant>.template` names a launcher template under
`templates/linux`; loader templates (`loaders/`) and game templates (`games/`)
are selected by pack data, never by a game check in the generic installer.
`install.type` selects an adapter in `src/installers/` for apply/revert steps.
`profilePattern` is the versioned profile path used by rollback and cleanup.

`modsync init` lists recipes; `modsync pack --recipe <id>` builds one. The
generated `pack.json` remains the definition the agent serves.

## v1 contract (implemented in `src/drivers/eldenring.ts`)

- `id` — `eldenring`
- `buildPack({ recipe, source, out, link })` — read the working install and
  write `pack.json`, `files.json`, payload, profile/tools/art. The recipe is
  required and owns the pack's id, name, save file, `notes`, and
  `preconditions`; they are data, not driver code.
- `contentsFor({ recipe, source, version })` — return the normalized contents
  summary. Every driver exposes the same method and emits `items`/`itemsLabel`,
  so renderers and PC tooling do not branch on the game id.
- Loader helpers live under `src/loaders/` (`me3`, `bg3le`) and own runtime
  layout, profile parsing, tool platform tags, and executable modes. Drivers
  supply the game-specific source paths.
- The agent does not execute driver code; it uses the generic `pack.json` fields:
  - `game` — Steam app id, install dir, build, prefix requirement.
  - `platforms` — per-OS exe, process, loader, and data paths.
  - `loader` — loader type, profile, and save file.
  - `launch` — launch mode, exe, game process, and Steam app id.
  - `install` — for drivers that apply files outside the pack root (BG3).
  - `files` — the file manifest, optionally tagged per platform.

This keeps the agent game-agnostic. A driver can add code later if a game needs
custom install steps (e.g. WeiDU).

## Planned drivers

| Game | Shape | Driver | Loader | Notes |
|---|---|---|---|---|
| ELDEN RING | Overlay | `eldenring` | me3 | v1; build 25827938 / 1.17; recipes for Graceborne and Convergence |
| Skyrim SE | Overlay/profile | `skyrim-se` | SKSE + MO2/Vortex | save paths/MO2 profile later |
| Baldur's Gate 3 | Profile | `bg3` | BG3SE on Windows/Proton, BG3LE on native Linux, modsettings | implemented |
| Baldur's Gate 2 EE | In-place recipe | `bg2-weidu` | WeiDU + InfinityLoader | alternate exe, clean game backup, install order |

## Adding a game

1. Add a driver that maps its working install to the pack format.
2. Define the driver's default `platforms` whenever game paths or loaders differ by OS.
3. Add one or more recipes in `recipes/`; override platform entries only when needed.
4. Extend the installer/launch template if the loader or apply step differs.
5. Add tests with a fake source and fake game root, and run `npm run packs:check`.

The restrictions are in `docs/DESIGN.md`. If a game cannot meet them, it needs a
custom driver, not a change to the core.
