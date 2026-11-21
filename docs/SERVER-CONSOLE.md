# Server console

The Server app is the control surface for the packs and the LAN
pack server. It is a separate Electron application from the Client, and runs on
Windows or Linux. Your usual setup is Server on Windows and Client on SteamOS.

The console UI is served from `127.0.0.1` only. The pack server is a separate
listener that binds one LAN address and uses the token shown in the console.

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

- **Start server** binds the selected address and port. The card shows the URL,
  token, and the Client install one-liner while it runs.
- **Stop server** closes the LAN listener. The control UI stays open.

The server is meant to run only while the Client installs or updates a
pack. It refuses `0.0.0.0` and is never port-forwarded. Use a single LAN IPv4 if
the server has VPN or virtual adapters.

The token in **Settings** is the live token. **New token** generates a random
replacement; saving restarts a running server so the change takes effect
immediately. Copy the install one-liner again after changing it.

## Pack library

Each pack card shows its game, mod version, file count, size, target platforms,
build date, and folder. Actions:

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

## Settings

- **Packs folder** — the directory the server reads and the library lists. It
  can be changed at any time; a running server restarts if the folder changes.
- **Bind** — automatic LAN address, loopback only, or one specific address.
- **Port** — default `8787`.
- **Token** — at least four characters, no spaces, commas, or single quotes. The current value is masked;
  **Show** reveals it and **Copy** puts it on the clipboard.
- **Start the pack server when ModSync starts** — keeps the server in sync with
  the app's own lifecycle.
- **Start ModSync Server when I sign in** — registers the app's login item.
  Sign-in starts open the window hidden in the tray. Use the tray menu to open
  the console, start or stop the server, or quit.

## Tray

Closing the window hides it to the tray while the app keeps running. The tray
menu has **Open ModSync Server**, **Start/Stop pack server**, **Open packs folder**,
and **Quit**. Quit is the only action that fully stops the app and its server.

## Files

| Path | Purpose |
|---|---|
| `state/console.json` (checkout) | Console settings, token, packs folder, remembered sources |
| `%APPDATA%/ModSync Server/console.json` (installed) | Same, for the installed build |
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
