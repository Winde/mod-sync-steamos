# Drivers

A driver describes one game family for the pack builder and the agent.

## v1 contract (implemented in `src/drivers/eldenring.js`)

- `id` — `eldenring`
- `buildPack({ source, out, link })` — read the working install and write
  `pack.json`, `files.json`, payload, profile, tools, art.
- The agent does not execute driver code; it uses the generic `pack.json` fields:
  - `game` — Steam app id, install dir, build, prefix requirement.
  - `launch` — exe, process name, loader binary, profile, save file.
  - `files` — the file manifest.

This keeps the agent game-agnostic. A driver can add code later if a game needs
custom install steps (e.g. WeiDU).

## Planned drivers

| Game | Shape | Driver | Loader | Notes |
|---|---|---|---|---|
| ELDEN RING | Overlay | `eldenring` | me3 | v1; build 25827938 / 1.17 |
| Skyrim SE | Overlay/profile | `skyrim-se` | SKSE + MO2/Vortex | save paths/MO2 profile later |
| Baldur's Gate 3 | Profile | `bg3` | BG3MM | `modsettings.lsx` + profile |
| Baldur's Gate 2 EE | In-place recipe | `bg2-weidu` | WeiDU | needs clean game backup + install order |

## Adding a game

1. Add a driver that maps its working install to the pack format.
2. Add the pack to `packs/`.
3. Extend the agent's launch template if the loader differs from me3.
4. Add tests with a fake source and fake game root.

The restrictions are in `docs/DESIGN.md`. If a game cannot meet them, it needs a
custom driver, not a change to the core.
