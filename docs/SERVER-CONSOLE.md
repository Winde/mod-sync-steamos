# Server console

The Server app is the control surface for the packs and the LAN
pack server. It is a separate Electron application from the Client, and runs on
Windows or Linux. Your usual setup is Server on Windows and Client on SteamOS.

The console UI is served from `127.0.0.1` only. The pack server is a separate
listener that binds one LAN address and accepts paired-device tokens plus the
manual token from Settings.

## Start it

```powershell
cd D:\source\mod-sync-steamos
npm run dev
```

`npm run dev:client` starts the Client app from the same checkout (useful for
seeing the Client UI on the server machine).

`npm run build:server:win` produces a Windows installer in `release/`. The installer
adds **ModSync Server** to the Start menu and desktop.

For a disposable checkout or test, `--packs-dir <dir>` overrides the default
packs folder and `--server-config <file>` (or the legacy `--console-config`) overrides the saved settings file.

## Pack server

The **Pack server** card has one primary action:

- **Start server** binds the selected address and port. The card shows the URL
  and the Client install one-liner while it runs.
- **Stop server** closes the LAN listener. The control UI stays open.

The server is meant to run only while the Client installs or updates a
pack. It refuses `0.0.0.0` and is never port-forwarded. Use a single LAN IPv4 if
the server has VPN or virtual adapters.

A TV with no device token appears in the pack library as a pairing request.
**Allow** issues that TV its own device token; **Deny** dismisses it. The Client
stores the token and reconnects without asking again. Revoke it later in
**Paired devices** without affecting other TVs.

The **Paired devices** panel lists every approved TV with its address and last
seen time. **Revoke** removes one device; **Revoke all** clears the list. A TV
that still has the old shared token appears as **manual token**; the Server
identifies it by its stable device id when it sends one, or by its address when
it does not.

The **manual token** in **Settings** is for CLI and unattended installs, and for
older Clients with the shared token. **New manual token** generates a random
replacement; saving restarts a running server, revokes legacy clients, and
leaves paired TVs working.

## Pack library

The path beside the pack count is the folder the library reads. **Change folder**
opens a folder picker and applies the choice immediately, without opening
Settings; the same action appears in the empty state. It is disabled while a
build runs, because the build writes into the current folder.

Each pack card shows its game, mod version, file count, size, target platforms,
build date, and folder. When the pack records its contents, the card also shows
a count such as **72 mods**; pressing it opens the full list and any inactive
pak files from `pack.json`. Actions:

- **Rebuild** builds the recipe into the packs folder. The working install is
  read-only. The build is staged under `.modsync-build/`; the old pack folder is
  replaced only after the new build succeeds. A failure leaves the old pack
  untouched.
- **Open folder** reveals the pack directory in Explorer.
- **Remove** deletes the pack folder and its payload after a confirmation. It
  does not touch the game, saves, or the working mod install.

**Build a pack** in the library header builds a recipe that is not in the
library yet. The recipe list comes from `recipes/`. Version is optional; the
driver uses its normal default (Elden Ring's `current.txt`, BG3's date) when it
is empty.

The form also shows the selected driver's own options. For BG3 these are an
optional game folder (used to include the Windows/Proton Script Extender) and an
optional BG3LE folder (defaults to the pinned download for native Linux).
Directory fields are checked before the build starts.

The progress dialog reports the phase and percent sent by the driver itself:
copying, hashing, then swapping the staged pack into place. The log remains
available for detail but no longer drives progress.

## Settings

- **Packs folder** — the directory the server reads and the library lists. It
  can be changed at any time; a running server restarts if the folder changes.
  **Browse** applies the chosen folder immediately. On the console page without
  the desktop folder picker, type the path and use **Save settings**.
- **Bind** — automatic LAN address, loopback only, or one specific address.
- **Port** — default `8787`.
- **Manual token** — at least four characters, no spaces, commas, or single
  quotes. Used by CLI and unattended installs, and accepted from older Clients
  with the shared token. The current value is masked; **Show** reveals it.
  Paired TVs do not use this token and are not affected when it changes.
- **Start the pack server when ModSync starts** — keeps the server in sync with
  the app's own lifecycle.
- **Start ModSync Server when I sign in** — registers the app's login item.
  Sign-in starts open the window hidden in the tray. Use the tray menu to open
  the console, start or stop the server, or quit.
- **Minimize to the tray instead of the taskbar** — when enabled (the default),
  minimizing the window hides it to the tray and removes it from the taskbar.
  Turn it off to keep a normal minimized window.

## Tray

Closing the window always hides it to the tray while the app keeps running.
Minimizing does the same while **Minimize to the tray** is enabled. The tray
menu has **Open ModSync Server**, **Start/Stop pack server**, **Open packs folder**,
and **Quit**. Quit is the only action that fully stops the app and its server.

## Updates

The console footer shows the running version and a **Check for updates**
button. It contacts GitHub only when pressed. If a newer release exists, an
**Install x.y.z** button appears next to it on an installed Windows Server.
Confirming it downloads the new NSIS installer with a live progress bar,
verifies its SHA-256 checksum, runs it silently, and reopens the Server when the
install finishes. Packs, settings, paired devices, and tokens are kept.
Elsewhere the button is **Update x.y.z** and opens the releases page. Otherwise
the footer reports that the build is current.

The Client has the same manual **Check for updates** chip in its header. It no
longer checks at launch. On the Linux AppImage the Client downloads and verifies
the new build itself; the Windows build opens the releases page.

## Files

| Path | Purpose |
|---|---|
| `state/console.json` (checkout) | Console settings, manual token, packs folder, remembered sources |
| `%APPDATA%/ModSync Server/console.json` (installed) | Same, for the installed build |
| `state/devices.json` (checkout) | Paired-device token hashes, names, addresses, legacy tombstones |
| `%APPDATA%/ModSync Server/devices.json` (installed) | Same, for the installed build |
| `packs/` (checkout) | Default pack output and server root |
| `Documents/ModSync/packs` (installed) | Default pack output and server root |
| `packs/.modsync-build/` | Temporary build and backup folders; safe to remove when no build runs |

## Troubleshooting

- **`EADDRINUSE`** — another program (often an earlier terminal `modsync
  serve`) already has the port. Stop it, or change the port in Settings.
- **No private LAN IPv4 found** — the server is not on a private LAN, or a VPN is
  hiding it. Connect to the LAN, allow LAN traffic in the VPN, or use a
  specific address.
- **The Client cannot reach the URL** — confirm the firewall rule printed in the guide,
  choose the Ethernet/Wi-Fi address if the server has more than one, and make sure
  the server is running.
- **The console looks stale** — it polls the local service; use **Refresh**.
  The log for a rebuild is kept in its progress dialog until the app closes.
