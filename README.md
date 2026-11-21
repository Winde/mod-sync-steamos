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

# First time only: remember the working install and pack output.
node bin/modsync.js init

# Build a pack from the working install. Hardlinks the 7.3 GB payload.
node bin/modsync.js pack

# Serve it on the LAN. Prints the TV bootstrap one-liner and the current URL.
node bin/modsync.js serve --lan --packs packs --port 8787
```

`init` writes `state/config.json`; after that `pack` needs no arguments. The
full form is still available: `pack --source <dir> --out <dir> --version <ver>`.
The planned PC pack-builder app uses the same source/output fields.

`serve` binds loopback by default. `--lan` binds the detected LAN IPv4 and
prints the URL/token the TV needs; `--host <ip>` picks a specific interface.
The server is token-protected and never binds `0.0.0.0`.

`serve` builds `state/bootstrap.tar.gz` on first run (agent + Linux Node).
The TV does **not** need Node or SSH; it pulls over HTTP.

## Quick start (Steam Machine)

1. Install the pack's game via Steam and launch it once so its Proton prefix
   exists. Pack-specific prerequisites live in `docs/packs/<pack-id>.md`.
2. In Desktop Mode, run the one-liner printed by `serve`:
   ```bash
   curl -fsSL 'http://<PC-LAN-IP>:8787/bootstrap.sh?token=<token>' | bash
   ```
3. The bootstrap registers ModSync in Steam automatically (idempotent: running
   it again updates the same shortcut). Restart Steam once if it is not visible.
4. Open ModSync and install the pack. The installer registers the game shortcut
   automatically; restart Steam once if it is not visible.
5. Launch from Game Mode. Saves stay local to each machine in v1.

## Network (one-time, generic)

The PC pack server is the only LAN listener. The TV-side Electron app has no
public server; it runs the installer in-process and talks to its renderer over
IPC. Any local HTTP control API stays on `127.0.0.1`.

- Let `serve --lan` print the current PC IPv4. If the PC has multiple
  interfaces (VPN, virtual adapters), choose one with `--host <ip>`.
- Add a scoped inbound rule (admin PowerShell):
  ```powershell
  New-NetFirewallRule -DisplayName "ModSync HTTP 8787" -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort 8787 -RemoteAddress LocalSubnet -Profile Any
  ```
- Do **not** port-forward 8787 or enable UPnP. The server is for the LAN only.
- NordVPN: enable **Allow LAN** / disable **Invisibility on LAN**, and keep the
  LAN subnet out of the tunnel.
- DHCP reservation is optional; `--lan` always prints the current address.
- Test from the TV: `curl http://<PC-LAN-IP>:8787/api/health`.

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

- Reads the pack manifest from the PC, shows its notes, and evaluates its
  structured preconditions (game installed/build, prefix, disk, DLC files).
- Verifies the game build declared by the pack and the Proton prefix.
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
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — PC server vs Steam Machine, one-time setup and every use
- [`docs/TRANSPORT.md`](docs/TRANSPORT.md) — HTTP pull, token, firewall/VPN
- [`docs/DRIVERS.md`](docs/DRIVERS.md) — adding Skyrim/BG3/BG2 drivers
- [`docs/TESTING.md`](docs/TESTING.md) — manual acceptance test (install, resume, rollback)
- [`docs/CONTRACT-TESTS.md`](docs/CONTRACT-TESTS.md) — automated black-box suite and refactor rules
- [`docs/packs/eldenring-graceborne.md`](docs/packs/eldenring-graceborne.md) — pack-specific setup
