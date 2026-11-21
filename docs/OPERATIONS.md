# Operating ModSync

Two machines, two different jobs:

- **PC** — owns the packs and runs the temporary pack server.
- **Steam Machine** — owns the installed files and runs the local agent/app.

## PC: one-time setup

1. Install Node 22+ and run `npm install` and `npm run build` in this repo.
2. Remember the working install once:
   ```powershell
   npm start -- init
   ```
   This writes `state/config.json` with the source and output paths.
3. Build a pack from the working install:
   ```powershell
   npm start -- pack
   ```
4. Allow the LAN port once (admin PowerShell):
   ```powershell
   New-NetFirewallRule -DisplayName "ModSync HTTP 8787" -Direction Inbound `
     -Action Allow -Protocol TCP -LocalPort 8787 -RemoteAddress LocalSubnet -Profile Any
   ```
4. If NordVPN is active, enable **Allow LAN** and keep the LAN out of the tunnel.
5. Do not port-forward 8787 or enable UPnP.

## Steam Machine: one-time setup

1. Install the game through Steam and launch the vanilla game once. This creates
   the Proton prefix.
2. Set the game to update only when launched, and keep the build the pack needs
   (Graceborne: 1.17 / `25827938`).
3. In Desktop Mode, run the install one-liner printed by `serve`:
   ```bash
   curl -fsSL 'https://github.com/Winde/mod-sync-steamos/releases/latest/download/install.sh' \
     | bash -s -- --pc 'http://<PC-LAN-IP>:8787' --token '<token>'
   ```
   This installs `~/Applications/ModSync.AppImage`, writes `agent.json`, and
   registers the ModSync Steam shortcut and art.
4. Restart Steam once if the ModSync shortcut is not visible.
5. Open ModSync and install the pack. Default-exe packs use the regular Steam
   game link; loader/alternate-exe packs add their own shortcut.
6. Launch the game once from the correct link. It creates the mod save.

## Every install or update

On the PC:

```powershell
cd D:\source\mod-sync-steamos
npm start -- serve --lan --packs packs --port 8787 --token <token>
```

Keep that terminal open while the TV downloads. On the Steam Machine:

1. Start **ModSync** from Steam.
2. **Games → game → pack → Install/Update**.
3. Wait for “Installed …”.
4. Stop the PC server with `Ctrl+C`; it is not needed after the download.

## Every play session

Launch the game from its **pack shortcut**, not the Steam Play button.
For me3 packs, the launcher starts me3 with the installed profile, waits for the
game, and exits. For profile packs, install/rollback writes into the data folder
for the detected platform and the shortcut starts the game through Steam. For a
default-exe pack, launch the regular Steam game entry; for an alternate-exe or
loader pack, use the generated ModSync shortcut.
The PC server is not needed. Once the local-first change lands, ModSync will not
need the PC either just to play an installed pack.

## When a new mod version comes out

On the PC: update the working install, rebuild the pack, start `serve --lan`.
On the TV: open ModSync, press **Update**, then play. The previous version stays
on disk for rollback.

## Rollback

Open ModSync → **Roll back**. It switches `current.txt` to the previous version;
nothing is downloaded again. Saves are not rolled back.

## Storage

Open **Storage** in ModSync to see free space, per-pack size, old versions, and
partial downloads. From there you can:

- clear an interrupted download;
- remove old versions (keeps the current one);
- remove a pack entirely.

The base game and saves are never touched.

## What runs when

| Time | PC server | Steam Machine |
|---|---|---|
| Playing an installed pack | not needed | game shortcut → loader |
| Installing/updating | `serve --lan` must run | ModSync → download |
| Rolling back | not needed (target) | ModSync → Roll back |
| Clearing storage | not needed | ModSync → Storage |
| Building a new pack | `pack`, then `serve` | nothing |

The PC server is a temporary sync service, not a Windows service. Start it when
the TV needs bytes; stop it afterwards. It binds one private LAN address, needs
a token, and is scoped to the local subnet.

## Interim vs target

The current dashboard is a browser page served by the local agent on
`127.0.0.1:8788`. The planned Electron app replaces that browser shell, keeps
installed-pack state locally, and uses the PC only for downloads. Storage and
rollback are local operations.
