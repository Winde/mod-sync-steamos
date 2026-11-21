# Drivers

A driver describes one game family for the pack builder and the agent.

## Pack recipes

A driver knows the **game**: Steam metadata, install layout, loader, launch
mechanics. A recipe in `recipes/<id>.json` knows the **pack**: name, mod id,
save file, notes, and preconditions. Adding a total conversion is a new recipe,
not a driver change.

```json
{
  "schema": 1,
  "id": "eldenring-graceborne",
  "game": "eldenring",
  "name": "Graceborne",
  "modId": "graceborne",
  "artId": "graceborne",
  "saveFile": "ER0000.graceborne.sl2",
  "notes": [],
  "preconditions": []
}
```

`modsync init` lists recipes; `modsync pack --recipe <id>` builds one. The
generated `pack.json` remains the definition the agent serves.

## v1 contract (implemented in `src/drivers/eldenring.js`)

- `id` — `eldenring`
- `buildPack({ recipe, source, out, link })` — read the working install and
  write `pack.json`, `files.json`, payload, profile/tools/art. The recipe owns
  the pack's name, save file, `notes`, and `preconditions`; they are data, not
  driver code.
- The agent does not execute driver code; it uses the generic `pack.json` fields:
  - `game` — Steam app id, install dir, build, prefix requirement.
  - `loader` / `launch` — loader type, exe, process name, profile, save file.
  - `install` — for drivers that apply files outside the pack root (BG3).
  - `files` — the file manifest.

This keeps the agent game-agnostic. A driver can add code later if a game needs
custom install steps (e.g. WeiDU).

## Planned drivers

| Game | Shape | Driver | Loader | Notes |
|---|---|---|---|---|
| ELDEN RING | Overlay | `eldenring` | me3 | v1; build 25827938 / 1.17; recipes for Graceborne and Convergence |
| Skyrim SE | Overlay/profile | `skyrim-se` | SKSE + MO2/Vortex | save paths/MO2 profile later |
| Baldur's Gate 3 | Profile | `bg3` | BG3SE + modsettings | implemented; applies to the Proton prefix |
| Baldur's Gate 2 EE | In-place recipe | `bg2-weidu` | WeiDU | needs clean game backup + install order |

## Adding a game

1. Add a driver that maps its working install to the pack format.
2. Add one or more recipes in `recipes/`.
3. Extend the installer/launch template if the loader or apply step differs.
4. Add tests with a fake source and fake game root.

The restrictions are in `docs/DESIGN.md`. If a game cannot meet them, it needs a
custom driver, not a change to the core.
