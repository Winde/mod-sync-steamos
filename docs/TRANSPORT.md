# Transport: HTTP pull

The Steam Machine pulls; the PC never connects to it. Only the PC needs a
listener, and only on the LAN.

## Two servers, one listener

- **PC pack server** (`modsync serve --lan`) — the only LAN listener. Serves
  pack metadata and files. A paired device token, or the manual token for
  CLI/unattended installs, is required.
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

## Tokens

A TV normally gets its own device token through pairing. If it gets `HTTP 403`,
it asks `/api/pair/request`; the Server console shows the request, and **Allow**
issues a random token for that device. The Server stores only the token hash;
the Client saves the token in `~/ModSync/agent.json`. Later launches connect
without another approval. Revoke one TV from **Paired devices** without touching
the others.

The Server also keeps a **manual token**. It is accepted for CLI and unattended
installs, and for older Clients that still have the shared token. A legacy
Client is identified by its stable device id when it sends one, or by its
address when it does not. Those clients appear as **manual token** devices.
Rotating the manual token revokes every legacy client; paired device tokens stay
valid. The normal install one-liner does not include the manual token.

`modsync serve` (without the Server console) has no approval UI, so it prints the
tokenized install one-liner. The Electron Server console prints the pairing
one-liner instead.

## Steam Machine install

In Desktop Mode:

```bash
curl -fsSL 'https://github.com/Winde/mod-sync-steamos/releases/latest/download/install.sh' \
  | bash -s -- --pc 'http://<PC-LAN-IP>:8787'
```

The installer downloads `ModSync.AppImage` into `~/Applications`, verifies its
checksum, writes `~/ModSync/agent.json`, creates the desktop entry, and adds the
ModSync Steam shortcut and art. Open ModSync once and approve the pairing
request in the Server console. For an unattended install, add `--token '…'` with
the manual token from Settings.

## Pairing and changing IPs

Do not hardcode a PC address in the client. The intended Electron flow is:

1. Discover the PC over mDNS (`_modsync._tcp`) on the LAN, or
2. Ask for the URL printed by `serve --lan` once, then store it.

If the stored address stops answering, rediscover or let the user re-pair. If
the Server rejects the stored token, the Client request appears in the Server
console for one-click approval. The Client also stores a stable device id in
`agent.json`; the Server uses it to keep a legacy client on the same device
record when its IP changes. The base URL is not a secret.

## Updates

Re-run `pack` on the PC, keep `serve` running, open ModSync on the TV, and press
Update. v1 downloads the full pack version; incremental file sets are a later
optimization. The previous version folder is kept for rollback.

## Why not Steam?

Steam can install the base game and stream it (Remote Play), and Steam Cloud can
sync the vanilla save. Steam has no API to push arbitrary mod files to another
machine. The mod pack needs its own transport; this one is HTTP.
