// User-facing Node/CLI/server text. Browser UI text lives in web/labels.js.
// Keep new terminal or HTTP-page strings here so a locale can replace one file.

const labels = {
  brand: "ModSync",
  installUrl: "https://github.com/Winde/mod-sync-steamos/releases/latest/download/install.sh",

  server: {
    title: "ModSync repository",
    noPacks: "No packs",
    installHint: "Install the TV app from the URL and token printed by modsync serve.",
  },

  serve: {
    repository: (url) => `ModSync repository: ${url}/`,
    bind: (host, loopback) => `Bind: ${host}${loopback ? " (loopback only)" : ""}`,
    token: (token) => `Token: ${token}`,
    packs: (packs) => `Packs: ${packs || "none"}`,
    loopbackOnly: "Only this PC can reach the server. Use --lan when the Steam Machine is ready.",
    lanInterfaces: (list) => `LAN interfaces: ${list}`,
    usingHost: (host) => `Using ${host}. Pass --host <ip> if that is the wrong interface.`,
    steamMachine: "Steam Machine (Desktop Mode):",
    install: (baseUrl, token) => `curl -fsSL '${labels.installUrl}' | bash -s -- --pc '${baseUrl}' --token '${token}'`,
    firewallTitle: "Firewall (admin PowerShell, once; local subnet only):",
    firewall: (port) => `New-NetFirewallRule -DisplayName "ModSync HTTP ${port}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -RemoteAddress LocalSubnet -Profile Any`,
    lanOnly: "Do not port-forward this port or enable UPnP. Keep it on the LAN.",
    keepRunning: "Keep this process running while the TV installs/updates.",
  },

  agent: {
    dashboard: (port) => `ModSync TV dashboard: http://127.0.0.1:${port}`,
    root: (root) => `Root: ${root}`,
    pc: (pc) => `PC: ${pc || "(not configured)"}`,
  },
};

module.exports = labels;
