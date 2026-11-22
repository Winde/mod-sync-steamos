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
   Or open the Server console (`npm run dev:server`) and press **Rebuild** on the pack.
4. Allow the LAN port once (admin PowerShell):
   ```powershell
   New-NetFirewallRule -DisplayName "ModSync HTTP 8787" -Direction Inbound `
     -Action Allow -Protocol TCP -LocalPort 8787 -RemoteAddress LocalSubnet -Profile Any
   ```
5. If NordVPN is active, enable **Allow LAN** and keep the LAN out of the tunnel.
6. Do not port-forward 8787 or enable UPnP.

## Server: the console

`npm run dev:server` opens the Server console. It owns the pack server and the
pack library. The console UI is loopback only; the LAN server is a separate
listener. See [`SERVER-CONSOLE.md`](SERVER-CONSOLE.md) for every control.

The useful flow is:

1. **Pack library → Rebuild** after the working install changes. The old pack
   stays in place until the new build succeeds.
2. **Pack server → Start server**.
3. Run the Client installer/update.
4. **Pack server → Stop server**.

A TV with no device token shows up as a pairing request in the Server console;
**Allow** issues it a device token, and the Client keeps it in `agent.json`.
The token in **Settings** is the **manual token** for CLI and unattended
installs, and for older Clients with the shared token. Change or generate it
there; a running server restarts, legacy clients are revoked, and paired TVs
keep their own tokens. The **Paired devices** panel can revoke one TV or all of
them.

## Steam Machine: one-time setup

1. Install the game through Steam and launch the vanilla game once. This creates
   the Proton prefix.
2. Set the game to update only when launched, and keep the build the pack needs
   (Graceborne: 1.17 / `25827938`).
3. In Desktop Mode, run the install one-liner printed by the Server console:
   ```bash
   curl -fsSL 'https://github.com/Winde/mod-sync-steamos/releases/latest/download/install.sh' \
     | bash -s -- --pc 'http://<PC-LAN-IP>:8787'
   ```
   This installs `~/Applications/ModSync.AppImage`, writes `agent.json`, and
   registers the ModSync Steam shortcut and art.
4. Restart Steam once if the ModSync shortcut is not visible.
5. Open ModSync and approve its pairing request in the Server console. The TV
   gets its own device token.
6. Install the pack. Default-exe packs use the regular Steam game link;
   loader/alternate-exe packs add their own shortcut.
7. Launch the game once from the correct link. It creates the mod save.

## Every install or update

On the server, open the console (`npm run dev:server`) and press **Pack server → Start
server**. Leave it running while the TV downloads. The CLI form still works:

```powershell
cd D:\source\mod-sync-steamos
npm start -- serve --lan --packs packs --port 8787 --token <token>
```

On the Steam Machine:

1. Start **ModSync** from Steam.
2. **Games → game → pack → Install/Update**.
3. Wait for “Installed …”.
4. Press **Stop server** in the console (or `Ctrl+C` in the CLI); it is not
   needed after the download.

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

On the PC: update the working install, press **Rebuild** in the console, then
**Start server**. On the TV: open ModSync, press **Update**, then play. The
previous version stays on disk for rollback.

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

## When the game crashes on the Steam Machine

Collect the logs before changing anything. On the Steam Machine, run the
collector from a checkout (or copy it over) and send the archive:

```bash
bash scripts/collect-bg3-logs.sh
# ~/bg3-logs-<date>-<time>.tgz
```

It gathers the ModSync install/agent logs, the pack's launch logs, BG3LE's
`~/.local/share/bg3le` logs, BG3's `Player.log` / `Player-prev.log`, the active
`modsettings.lsx`, the game's `bin/` listing, and the BG3 launch options. It
does not include saves or account credentials.

For BG3 specifically, the useful paths are:

| Path | What it answers |
|---|---|
| `~/.local/share/bg3le/logs/*.log` and `launch.log` | Did BG3LE attach, and how far did it get? No files means it never attached. |
| `~/.local/share/Larian Studios/Baldur's Gate 3/Player.log` | BG3's own startup log and the last mod it tried to load. |
| `<game>/bin/gold.log`, `<game>/bin/db/attachments` | Larian crash dumps and the launcher log. |
| `~/ModSync/logs/agent.log`, `install.log` | What ModSync installed and where. |
| `~/ModSync/packs/<pack>/logs/launch-bg3-native-*.log` | What the native launcher did. |

If the whole machine rebooted or froze rather than the game exiting, also run
`journalctl -b -1 -p err --no-pager` after it comes back; that previous-boot
kernel log is the only place a driver or GPU crash shows up.

Native Baldur's Gate 3 is a Steam Deck build; Larian does not support it on
desktop Linux. On an NVIDIA + Wayland desktop the known launch crash is fixed
by `SDL_VIDEODRIVER=x11` in Steam's launch options, or by running the game
under Proton. The pack supports both the native and Proton variants.

## What runs when

| Time | PC server | Steam Machine |
|---|---|---|
| Playing an installed pack | not needed | game shortcut → loader |
| Installing/updating | console → **Start server** | ModSync → download |
| Rolling back | not needed (target) | ModSync → Roll back |
| Clearing storage | not needed | ModSync → Storage |
| Building a new pack | console → **Rebuild**, then **Start server** | nothing |

The PC server is a temporary sync service, not a Windows service. Start it when
the TV needs bytes; stop it afterwards. The console can start it with Windows
sign-in, or you can start it by hand. It binds one private LAN address, needs a
device token or the manual token, and is scoped to the local subnet.

## Interim vs target

The current dashboard is a browser page served by the local agent on
`127.0.0.1:8788`. The planned Electron app replaces that browser shell, keeps
installed-pack state locally, and uses the PC only for downloads. Storage and
rollback are local operations.
