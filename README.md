# mod-sync-steamos

Reusable mod-pack deployment for Windows and SteamOS. **v1 is mods only** — no
save transfer, no save payload, no save prompts.

The first packs are **ELDEN RING + Graceborne**, **Baldur's Gate 3**, and the
four Steam **Infinity Engine Enhanced Editions** (BG1EE, BG2EE, IWDEE, PSTEE).
The core is game-agnostic: a pack manifest, a game driver, and platform
decorators. Skyrim, Icewind Dale II, and EET are added later.

## Quick start (PC)

```powershell
cd D:\source\mod-sync-steamos
npm install
npm run build

# First time only: remember the working install and pack output.
npm start -- init

# Build a pack from the working install. Hardlinks the 7.3 GB payload.
npm start -- pack

# Serve it on the LAN. Prints the TV install one-liner and the current URL.
npm start -- serve --lan --packs packs --port 8787
```

Source lives in `src/*.ts`, `electron/*.ts`, `web-tv/` (the Client React
renderer), and `web-pc/` (the Server console React renderer). `npm run build`
compiles the Node/Electron code to `dist/` and bundles both renderers with Vite
into `web/tv/` and `web/pc/`; the `npm start`/`npm test`/packaging scripts run
it for you. `node bin/modsync.js` works after a build. `npm run typecheck`
checks without emitting, and `npm test` builds and runs the full suite.

`init` writes `state/config.json`; after that `pack` needs no arguments. The
full form is still available: `pack --recipe eldenring-graceborne --source <dir> --out <dir> --version <ver>`.
Pack identity lives in `recipes/<id>.json` (Graceborne, Convergence, BG3, and
the four EE games); the driver only knows the game's layout and loader.
The Server console uses the same source/output fields.

`serve` binds loopback by default. `--lan` binds the detected LAN IPv4 and
prints the URL/token the Client needs; `--host <ip>` picks a specific interface.
The server is token-protected and never binds `0.0.0.0`.

The Client installs a self-contained AppImage. It does **not** need Node, a
browser kiosk, or SSH; the Server only serves the installer and pack files over
HTTP.

## Server and Client apps

There are two separate Electron apps:

- **ModSync Server** — the new app that owns the packs and the LAN server. It
  lists packs, rebuilds or removes them, controls the server, and manages the
  token. It runs on Windows or Linux. It is the app on the machine that serves
  packs.
- **ModSync Client** — the pre-existing app that installs, updates, rolls back,
  and launches packs on the machine that plays the game. It runs on SteamOS
  (AppImage) or Windows (NSIS). Its **Check for updates** header button checks
  only when pressed; the Linux AppImage can install the update itself.

The Server console:

- **Pack library** — lists the packs in the selected folder, shows version,
  size, file count, and build date. **Change folder** points the library at an
  existing packs folder. Each card can rebuild the pack from its working
  install, open the folder, or remove it.
- **Pack server** — start and stop the LAN server, copy its URL, token, and the
  Client install one-liner. A server error (busy port, no LAN address) is shown
  in the same card. A TV with an old or missing token appears as a pairing
  request; **Allow** sends it the current token once.
- **Settings** — packs folder, bind address, port, token (with generate), start
  the server on launch, start ModSync Server at sign-in, and minimize to the
  tray instead of the taskbar. The app starts hidden in the tray for sign-in
  starts.
- **Update check** — the footer asks GitHub for the latest release only when
  you press **Check for updates**. On Windows the installed Server updates
  itself: it downloads the new installer, verifies its checksum, installs it
  silently, and reopens. Other builds link to the releases page when a newer
  build exists.
- **Rebuilds are staged** — the old pack stays in place until the new build is
  complete, then it is swapped in. A failed build does not destroy the working
  pack.
- **Removal** requires confirmation and only deletes the pack folder; the
  working mod install and game are never touched.

The Server console serves its own UI on `127.0.0.1` only. The LAN pack server
stays a separate listener with the token you set in the console.

```powershell
# Development: Server on Windows, Client on Linux by default
npm run dev

# Explicit development targets
npm run dev:server
npm run dev:client

# Installers
npm run build:server:win     # release/ModSync-Server-<version>-x64.exe
npm run build:server:linux   # release/ModSync-Server-<version>-x86_64.AppImage
npm run build:client:win     # release/ModSync-Client-<version>-x64.exe
npm run build:client:linux   # release/ModSync-Client-<version>-x86_64.AppImage
```

The first run creates `state/console.json` in a checkout, or
`%APPDATA%\ModSync Server\console.json` for an installed Server. The packs
folder defaults to `packs/` in a checkout, `Documents/ModSync/packs` on
Windows, or `~/ModSync/packs` on Linux. The Client keeps its data under
`~/ModSync` and its existing AppImage install path.

## Quick start (Steam Machine)

1. Install the pack's game via Steam. On Linux, launch it once so its Proton
   prefix exists. ModSync shows the pack's own notes and preconditions before
   install.
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
- Writes the loader artifacts the pack declares: profiles, `modsettings.lsx`,
  and the platform's script extender.
- Writes the launcher selected by the pack profile and adds a Steam shortcut
  when the pack asks for one. Default Steam packs use the regular game link.

## Docs

- [`docs/DESIGN.md`](docs/DESIGN.md) — pack/driver/platform model and restrictions
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) - Server vs Client, one-time setup and every use
- [`docs/SERVER-CONSOLE.md`](docs/SERVER-CONSOLE.md) - Server app, pack library, token, tray, and sign-in start
- [`docs/TRANSPORT.md`](docs/TRANSPORT.md) — HTTP pull, token, firewall/VPN
- [`docs/DRIVERS.md`](docs/DRIVERS.md) — drivers and the Infinity Engine family
- [`docs/INFINITY-ENGINE.md`](docs/INFINITY-ENGINE.md) — BG1EE/BG2EE/IWDEE/PSTEE snapshot design
- [`docs/TESTING.md`](docs/TESTING.md) — manual acceptance test (install, resume, rollback)
- [`docs/CONTRACT-TESTS.md`](docs/CONTRACT-TESTS.md) — automated black-box suite and refactor rules
