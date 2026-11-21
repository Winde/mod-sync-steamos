# mod-sync-steamos

Reusable mod-pack deployment for Windows and SteamOS. **v1 is mods only** — no
save transfer, no save payload, no save prompts.

The first pack is **ELDEN RING + Graceborne 0.2.7**, but the core is
game-agnostic: a pack manifest, a game driver, and platform decorators. Skyrim,
BG3, BG2 and others are added as drivers/packs later.

## v1 scope

- One base game install, many packs.
- Pack = mod files + loader profile + launcher + art. **No base game, no saves.**
- PC serves packs over HTTP; the Steam Machine pulls with a local agent.
- The agent serves a dashboard on the TV at `127.0.0.1:8788`; add it to Steam as
  a non-Steam game.
- Deploy/update, rollback, launch, verify. No save sync.
- Steam Cloud continues to handle the vanilla save. The mod save stays local on
  each machine.
- ReShade is skipped on SteamOS; the in-game mod changes still apply.
- The launcher waits for the game to exit, stops me3, and exits (no lingering
  console/terminal).

## Quick start (PC)

```powershell
cd D:\source\mod-sync-steamos
npm install

# Build a pack from the working install. Hardlinks the 7.3 GB payload.
node bin/modsync.js pack --source "D:\EldenRingMods" --out packs\eldenring-graceborne

# Serve it on the LAN. Prints the TV bootstrap one-liner and a token.
node bin/modsync.js serve --packs packs --port 8787
```

`serve` builds `state/bootstrap.tar.gz` on first run (agent + Linux Node).
The TV does **not** need Node or SSH; it pulls over HTTP.

## Quick start (Steam Machine)

1. Install ELDEN RING via Steam; launch vanilla once (creates the Proton prefix).
2. Set **Only update this game when I launch it**; keep 1.17.
3. In Desktop Mode, run the one-liner printed by `serve`:
   ```bash
   curl -fsSL 'http://192.168.1.98:8787/bootstrap.sh?token=...' | bash
   ```
4. Add `~/Desktop/ModSync.desktop` to Steam as a non-Steam game.
5. Open ModSync, install Graceborne, and add the generated Graceborne shortcut
   to Steam (the agent writes `~/Desktop/Graceborne.desktop`).
6. Launch from Game Mode. First run creates the TV's own `ER0000.graceborne.sl2`;
   the PC save is not transferred in v1.

## Network (one-time)

The PC is on `192.168.1.98/24` with a **Public** Windows profile and NordVPN
active. The TV pulls from port 8787:

- Add a scoped inbound rule (admin PowerShell):
  ```powershell
  New-NetFirewallRule -DisplayName "ModSync HTTP 8787" -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort 8787 -RemoteAddress 192.168.1.0/24 -Profile Any
  ```
- NordVPN: enable **Allow LAN** / disable **Invisibility on LAN**, and exclude
  `192.168.1.0/24` from the tunnel.
- Reserve `192.168.1.98` for the PC in the router (DHCP reservation).
- Test from the TV: `curl http://192.168.1.98:8787/api/health`.

No SSH. No port forwarding. LAN only.

## Rollback

Every installed version and its me3 profile stay on disk. The launcher reads
`mods/<mod>/current.txt`, so rollback is a pointer switch:

1. Build 0.2.5 and install it on the TV:
   ```powershell
   node bin/modsync.js pack --source "D:\EldenRingMods" --version 0.2.5
   ```
2. Build 0.2.7 and install/update:
   ```powershell
   node bin/modsync.js pack --source "D:\EldenRingMods" --version 0.2.7
   ```
3. The dashboard now shows **Roll back** (home and Details). It switches
   `current.txt` to 0.2.5; 0.2.7 stays installed.

Rollback does **not** roll back saves. Saves are out of v1; the TV save stays
where it is. If you need the save from before an update, copy it manually while
the game is closed.

## What the agent does

- Reads the pack manifest from the PC.
- Verifies the game build (`25827938` = 1.17) and the Proton prefix.
- Refuses to install while the game is running.
- Downloads each file with SHA-256 verification; writes to a staging version.
- Writes a me3 profile, a Linux launcher, and a `.desktop` shortcut.
- Optionally registers the shortcuts in Steam (restart Steam afterwards).

## Save boundary (v1)

- The pack never contains saves.
- The installer never writes the save directory.
- Steam Cloud syncs only the vanilla `ER0000.sl2`.
- Graceborne's `ER0000.graceborne.sl2` stays local to each machine.
- Save sync is a separate **v2** module with per-game parsers/semantics.

## Docs

- [`docs/DESIGN.md`](docs/DESIGN.md) — pack/driver/platform model and restrictions
- [`docs/TRANSPORT.md`](docs/TRANSPORT.md) — HTTP pull, token, firewall/VPN
- [`docs/DRIVERS.md`](docs/DRIVERS.md) — adding Skyrim/BG3/BG2 drivers
