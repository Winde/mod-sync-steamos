# Manual acceptance test

You drive this test. It is split so the PC-only part proves install, resume, and
rollback without touching the game or saves; the Steam Machine part proves the
Linux launcher and me3.

## 0. Server console

On the server machine, `npm run dev:server` opens the Server console. Check without touching the game:

1. The pack library lists the packs in `packs/`, with version, size, and path.
   **Change folder** switches to another folder and lists its packs; it is
   disabled while a build runs.
2. **Pack server → Start server** shows a URL and token; **Stop server** closes
   it. If port 8787 is busy, stop the old CLI `serve` or change the port.
3. **Show**, **Copy**, and **New token** reveal and replace the token. Save
   settings; a running server restarts and the install one-liner uses the new
   token.
4. **Rebuild** opens the build dialog with the remembered working install.
   A build log and percentage are shown, and a failed build leaves the old pack
   in place.
5. **Remove** asks for confirmation and deletes only the pack folder.
6. Minimizing the window hides it to the tray while the setting is enabled;
   closing it always hides it. **Quit** in the tray exits.
7. **Check for updates** in the footer reports that the build is current, or
   offers the latest release. It does not run on its own.

## 0b. Stop old listeners

Check for leftovers from preview runs:

```powershell
Get-NetTCPConnection -LocalPort 8787,8788 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalPort, OwningProcess
```

Stop those PIDs before starting. Do not stop Steam or the game.

## 1. Start the PC pack server

From `D:\source\mod-sync-steamos`, build once after `npm install` (the manual
commands below run the compiled `dist/` code directly):

```powershell
npm run build
node bin/modsync.js serve --lan --packs packs --port 8787 --token test123
```

The output should show the **actual** LAN address, for example:

```
ModSync repository: http://192.168.x.x:8787/
Bind: 192.168.x.x
Token: test123
```

If more than one interface is printed, pick the Ethernet/Wi-Fi one with
`--host <ip>`. If the server says loopback only, `--lan` did not find a private
IPv4.

Leave this terminal running.

## 2. Start a disposable “TV” agent on the PC

Open a second PowerShell terminal:

```powershell
cd D:\source\mod-sync-steamos
New-Item -ItemType Directory -Force state\manual | Out-Null
@'
{"pcUrl":"http://<PC-LAN-IP>:8787","token":"test123","root":"D:\\source\\mod-sync-steamos\\state\\manual-tv","port":8788}
'@ | Set-Content state\manual\agent.json -Encoding ascii

node bin/modsync.js agent --config state\manual\agent.json
```

Replace `<PC-LAN-IP>` with the address printed by `serve`. Open
`http://127.0.0.1:8788` in a browser on the PC. This is the same agent UI the TV
will run.

## 3. Install 0.2.7 and watch it

1. **Games → ELDEN RING → Graceborne → Install.**
2. Read the **Before you install** notes and the checks. On Windows the Proton
   prefix check says “Not needed”; the rest should pass.
3. Press **Start download**.
4. Watch the percentage, MB/s, ETA, and file count.
5. At roughly 20–40%, press **Cancel download**.
   - You should return to the pack with “Download paused” and **Resume install**.
   - The completed files stay on disk.
6. Press **Resume install** and let it finish.
   - It may briefly re-check files already on disk; it should not re-download
     the whole 7.3 GB.
7. When it says **Installed 0.2.7**, verify every file from PowerShell:

```powershell
node scripts/e2e-factory.js --verify-only --root state/manual-tv
```

That hashes all 1,466 files against `files.json`. The game install and saves
were not touched: the installer writes under
`state/manual-tv/packs/eldenring-graceborne/` only.

## 4. Rollback with two versions

The source still has 0.2.5, so build a second pack in a disposable directory:

```powershell
node bin/modsync.js pack --recipe eldenring-graceborne --source "D:\EldenRingMods" --version 0.2.5 --out "state\packs-0.2.5\eldenring-graceborne"
```

Then:

1. Stop the 0.2.7 server with `Ctrl+C`.
2. Serve 0.2.5:
   ```powershell
   node bin/modsync.js serve --lan --packs "state\packs-0.2.5" --port 8787 --token test123
   ```
3. Refresh the dashboard. It will offer an update to 0.2.5. Install it.
4. Stop the server, serve the normal `packs` directory again, refresh, and
   update back to 0.2.7.
5. **Roll back** should now appear. Press it.
6. Confirm the pointer:
   ```powershell
   Get-Content state\manual-tv\packs\eldenring-graceborne\mods\graceborne\current.txt
   ```
   It should say `0.2.5`; the 0.2.7 folder is still on disk.

Saves are not rolled back. That is intentional in v1.

## 5. Steam Machine

This is the step that proves the Linux launcher and me3, which the PC cannot.

1. In Desktop Mode, run the install one-liner printed by `serve --lan` (AppImage + Steam shortcut).
2. Add `~/Desktop/ModSync.desktop` to Steam once.
3. Install the pack from the dashboard.
4. Launch from the generated game shortcut, not the Steam Play button.
5. Confirm Graceborne loads; exit the game and check
   `~/ModSync/packs/eldenring-graceborne/mods/graceborne/current.txt`.
6. Press **Check for updates** in the header. It should report the current
   version or open the release offer; it must not check automatically at launch.

## What to report back

- The `serve --lan` bind/interface lines (redact the public IP if you prefer).
- Where cancel/resume or rollback behaved differently than above.
- The `--verify-only` output.
- Any dashboard error text or terminal traceback.
