# mod-sync-steamos

Reusable mod-pack deployment for Windows and SteamOS. **v1 is mods only** — no
save transfer, no save payload, no save prompts.

The first packs are **ELDEN RING + Graceborne** and **Baldur's Gate 3**. The
core is game-agnostic: a pack manifest, a game driver, and platform decorators.
Skyrim and BG2 are added as drivers/packs later.

## Quick start (PC)

```powershell
cd D:\source\mod-sync-steamos
npm install

# First time only: remember the working install and pack output.
node bin/modsync.js init

# Build a pack from the working install. Hardlinks the 7.3 GB payload.
node bin/modsync.js pack

# Serve it on the LAN. Prints the TV install one-liner and the current URL.
node bin/modsync.js serve --lan --packs packs --port 8787
```

`init` writes `state/config.json`; after that `pack` needs no arguments. The
full form is still available: `pack --recipe eldenring-graceborne --source <dir> --out <dir> --version <ver>`.
Pack identity lives in `recipes/<id>.json` (Graceborne, Convergence, BG3);
the driver only knows the game's layout and loader.
The planned PC pack-builder app uses the same source/output fields.

`serve` binds loopback by default. `--lan` binds the detected LAN IPv4 and
prints the URL/token the TV needs; `--host <ip>` picks a specific interface.
The server is token-protected and never binds `0.0.0.0`.

The TV installs a self-contained AppImage. It does **not** need Node, a browser
kiosk, or SSH; the PC only serves the installer and pack files over HTTP.

## Quick start (Steam Machine)

1. Install the pack's game via Steam and launch it once so its Proton prefix
   exists. ModSync shows the pack's own notes and preconditions before install.
2. In Desktop Mode, run the install one-liner printed by `serve`:
   ```bash
   curl -fsSL 'https://github.com/Winde/mod-sync-steamos/releases/latest/download/install.sh' \
     | bash -s -- --pc 'http://<PC-LAN-IP>:8787' --token '<token>'
   ```
3. The installer puts `ModSync.AppImage` in `~/Applications`, writes
   `~/ModSync/agent.json`, and adds the ModSync Steam shortcut and art
   automatically. Restart Steam once if it is not visible.
4. Open ModSync and install the pack. Default-exe packs (BG3) use the regular
   Steam game link; loader/alternate-exe packs add their own shortcut.
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

Every installed version stays on disk, with the loader artifacts for that
version (me3 profile, BG3 modsettings, and so on). The active version is just a
pointer at `mods/<mod>/current.txt`.

To roll back, open ModSync and press **Roll back**. The app switches to the
previous installed version. Nothing is downloaded, and the newer version stays
installed, so you can move forward again with a normal update.

**Roll back** appears only when a previous version exists. You create rollback
targets by installing a newer version normally; the previous version is kept
automatically. The exact loader differs by game, but the app handles it.

Rollback does **not** roll back saves. Saves are out of v1; the TV save stays
where it is. If you need the save from before an update, copy it manually while
the game is closed.

## What the TV app does

- Reads the pack manifest from the PC, shows its notes, and evaluates its
  structured preconditions (game installed/build, prefix, disk, DLC files).
- Verifies the game build declared by the pack and the Proton prefix.
- Refuses to install while the game is running.
- Downloads each file with SHA-256 verification; writes to a staging version.
- Writes the loader artifacts the pack declares: an me3 profile for ELDEN RING,
  or `modsettings.lsx` plus BG3 Script Extender for Baldur's Gate 3.
- Writes a launcher and adds a Steam shortcut for loader/alternate-exe packs.
  Default-exe packs use the regular Steam game link.

## Docs

- [`docs/DESIGN.md`](docs/DESIGN.md) — pack/driver/platform model and restrictions
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — PC server vs Steam Machine, one-time setup and every use
- [`docs/TRANSPORT.md`](docs/TRANSPORT.md) — HTTP pull, token, firewall/VPN
- [`docs/DRIVERS.md`](docs/DRIVERS.md) — adding Skyrim/BG3/BG2 drivers
- [`docs/TESTING.md`](docs/TESTING.md) — manual acceptance test (install, resume, rollback)
- [`docs/CONTRACT-TESTS.md`](docs/CONTRACT-TESTS.md) — automated black-box suite and refactor rules
