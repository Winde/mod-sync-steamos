# Transport: HTTP pull

The Steam Machine pulls; the PC never connects to it. Only the PC needs an
inbound port.

## PC

```powershell
node bin/modsync.js serve --packs packs --host 192.168.1.98 --port 8787
```

The command prints:

```
ModSync repository: http://192.168.1.98:8787/?token=…
Steam Machine (Desktop Mode):
curl -fsSL 'http://192.168.1.98:8787/bootstrap.sh?token=…' | bash
```

### One-time network setup

- Add a scoped inbound rule (admin PowerShell):
  ```powershell
  New-NetFirewallRule -DisplayName "ModSync HTTP 8787" -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort 8787 -RemoteAddress 192.168.1.0/24 -Profile Any
  ```
- NordVPN: **Allow LAN** on, **Invisibility on LAN** off; exclude
  `192.168.1.0/24` from the tunnel.
- Reserve `192.168.1.98` for the PC in the router.
- The server binds to the LAN IP, not the VPN interfaces.
- No port forwarding; LAN only.

Test from the TV: `curl http://192.168.1.98:8787/api/health`.

## Token

`serve` generates a random token per run unless `--token` is supplied. The token
is required by `/api/*`, `/bootstrap.sh` and `/bootstrap.tar.gz`. The one-liner
includes it; the agent stores it in `agent.json`. The TV dashboard is local and
never exposes the token to the browser.

## Steam Machine bootstrap

In Desktop Mode:

```bash
curl -fsSL 'http://192.168.1.98:8787/bootstrap.sh?token=…' | bash
```

It downloads `bootstrap.tar.gz` (agent + Linux Node), extracts to `~/ModSync`,
writes `agent.json`, creates `~/Desktop/ModSync.desktop`, and starts the agent.

Add `ModSync.desktop` to Steam once. The agent writes game `.desktop` files as
packs are installed.

## Updates

Re-run `pack` on the PC, keep `serve` running, open ModSync on the TV, and press
Update. v1 downloads the full pack version; incremental file sets are a later
optimization. The previous version folder is kept for rollback.

## Why not Steam?

Steam can install the base game and stream it (Remote Play), and Steam Cloud can
sync the vanilla save. Steam has no API to push arbitrary mod files to another
machine. The mod pack needs its own transport; this one is HTTP.
