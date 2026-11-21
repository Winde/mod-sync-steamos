# Transport: HTTP pull

The Steam Machine pulls; the PC never connects to it. Only the PC needs a
listener, and only on the LAN.

## Two servers, one listener

- **PC pack server** (`modsync serve --lan`) — the only LAN listener. Serves
  pack metadata, files, and the bootstrap tarball. Token required.
- **Electron app on the TV** — runs the installer in-process. Its renderer talks
  to the main process over IPC, not HTTP. It does not listen on the LAN. If a
  local control API is kept for automation, it binds `127.0.0.1` and uses a
  per-run token.

## PC

```powershell
node bin/modsync.js serve --lan --packs packs --port 8787
```

`serve` binds loopback by default. `--lan` binds the detected private IPv4;
`--host <ip>` picks a specific interface. It refuses `0.0.0.0`. The command
prints the URL it actually bound, all private interfaces when there is more than
one, and a random token:

```
ModSync repository: http://<PC-LAN-IP>:8787/
Bind: <PC-LAN-IP>
Token: …
Packs: Graceborne 0.2.7
Steam Machine (Desktop Mode):
curl -fsSL 'https://github.com/Winde/mod-sync-steamos/releases/latest/download/install.sh' \
  | bash -s -- --pc 'http://<PC-LAN-IP>:8787' --token '…'
```

If the PC has a VPN or virtual adapter, check the printed interface list and
choose one with `--host <ip>`.

### One-time network setup

- Add a scoped inbound rule (admin PowerShell):
  ```powershell
  New-NetFirewallRule -DisplayName "ModSync HTTP 8787" -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort 8787 -RemoteAddress LocalSubnet -Profile Any
  ```
  `LocalSubnet` works for any private range, so no IP is baked in.
- NordVPN: **Allow LAN** on, **Invisibility on LAN** off; keep the LAN subnet out
  of the tunnel.
- Do **not** port-forward 8787 or enable UPnP.
- DHCP reservation is optional; `serve --lan` always prints the current address.

Test from the TV: `curl http://<PC-LAN-IP>:8787/api/health`.

## Token

`serve` generates a random token per run unless `--token` is supplied. The token
is required by `/api/*`, `/bootstrap.sh` and `/bootstrap.tar.gz`. The install
one-liner includes it; the TV app stores it in `~/ModSync/agent.json`. The
dashboard is local and never exposes the token to the browser.

## Steam Machine install

In Desktop Mode:

```bash
curl -fsSL 'https://github.com/Winde/mod-sync-steamos/releases/latest/download/install.sh' \
  | bash -s -- --pc 'http://<PC-LAN-IP>:8787' --token '…'
```

The installer downloads `ModSync.AppImage` into `~/Applications`, verifies its
checksum, writes `~/ModSync/agent.json`, creates the desktop entry, and adds the
ModSync Steam shortcut and art.

The legacy browser agent is still available from the PC:

```bash
curl -fsSL 'http://<PC-LAN-IP>:8787/bootstrap.sh?token=…' | bash
```

It installs the agent + Linux Node under `~/ModSync` and starts the local
dashboard. Do not run both on the same port.

## Pairing and changing IPs

Do not hardcode a PC address in the client. The intended Electron flow is:

1. Discover the PC over mDNS (`_modsync._tcp`) on the LAN, or
2. Ask for the URL printed by `serve --lan` once, then store it.

If the stored address stops answering, rediscover or let the user re-pair. The
token stays in `agent.json`; the base URL is not a secret.

## Updates

Re-run `pack` on the PC, keep `serve` running, open ModSync on the TV, and press
Update. v1 downloads the full pack version; incremental file sets are a later
optimization. The previous version folder is kept for rollback.

## Why not Steam?

Steam can install the base game and stream it (Remote Play), and Steam Cloud can
sync the vanilla save. Steam has no API to push arbitrary mod files to another
machine. The mod pack needs its own transport; this one is HTTP.
