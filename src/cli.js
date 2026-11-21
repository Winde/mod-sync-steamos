const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const util = require("./util");
const { buildPack } = require("./drivers/eldenring");
const { loadPack, packSummary } = require("./manifest");
const { createServer } = require("./server");
const { createAgent } = require("./agent");
const { buildBootstrap } = require("./bootstrap");
const steam = require("./steam");

const repoRoot = path.resolve(__dirname, "..");

const help = `modsync — mod pack deployment for Windows and SteamOS (mods only)

Commands:
  pack      Build a pack from a working install
  serve     Serve packs + bootstrap over HTTP
  agent     Run the TV agent/dashboard
  bootstrap Build the TV bootstrap tarball
  doctor    Inspect packs, Steam, and game detection
  register  Add a .sh launcher to Steam with art
  help      This help

pack:
  --source <dir>    Working install (default: D:\\EldenRingMods)
  --out <dir>       Pack output (default: packs/eldenring-graceborne)
  --version <ver>   Mod version (default: current.txt)
  --copy            Copy payload instead of hardlinking

serve:
  --packs <dir>     Packs directory (default: packs)
  --lan             Bind the detected LAN IPv4 (needed by the TV)
  --host <ip>       Bind a specific address (default: 127.0.0.1)
  --port <n>        Port (default: 8787)
  --token <token>   Fixed token (default: random per run)
  --rebuild-bootstrap
  --skip-bootstrap

agent:
  --config <file>   agent.json (default: ./agent.json)
  --port <n>        Override dashboard port (default: 8788)

register:
  --exe <file> --name <name> --icon <png> [--grid <png>] [--hero <png>] [--logo <png>]
`;

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function cmdPack(values) {
  const source = values.source || "D:\\EldenRingMods";
  const out = path.resolve(values.out || path.join(repoRoot, "packs", "eldenring-graceborne"));
  const result = await buildPack({
    source,
    out,
    link: !values.copy,
    version: values.version,
    log: (m) => console.log(m),
  });
  console.log(`\nPack: ${result.packRoot}`);
  console.log(`Version: ${result.pack.mod.version}`);
  console.log(`Files: ${result.files}`);
  console.log(`Size: ${(result.totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
}

async function cmdServe(values) {
  const packsDir = path.resolve(values.packs || path.join(repoRoot, "packs"));
  const loopback = !values.lan && !values.host;
  const host = values.host || (values.lan ? util.detectLanIp() : "127.0.0.1");
  if (host === "0.0.0.0") {
    fail("Refusing to bind all interfaces. Use --lan, or --host with one LAN IPv4.");
  }
  if (values.lan && host === "127.0.0.1") {
    fail("No private LAN IPv4 found. Connect to the LAN or pass --host.");
  }
  const port = Number(values.port || 8787);
  const token = values.token || util.randomToken();
  const baseUrl = `http://${host}:${port}`;
  const bootstrapTar = path.join(repoRoot, "state", "bootstrap.tar.gz");
  if (!values["skip-bootstrap"] && (values["rebuild-bootstrap"] || !fs.existsSync(bootstrapTar))) {
    await buildBootstrap(repoRoot, bootstrapTar, (m) => console.log(m));
  }
  const packs = fs.existsSync(packsDir)
    ? fs.readdirSync(packsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(packsDir, e.name, "pack.json")))
      .map((e) => { try { return packSummary(path.join(packsDir, e.name)); } catch { return null; } }).filter(Boolean)
    : [];

  const server = createServer({
    packsDir,
    token,
    baseUrl,
    bootstrapTar,
    bootstrapTemplate: path.join(repoRoot, "scripts", "bootstrap.sh"),
  });
  server.listen(port, host, () => {
    console.log(`\nModSync repository: ${baseUrl}/`);
    console.log(`Bind: ${host}${loopback ? " (loopback only)" : ""}`);
    console.log(`Token: ${token}`);
    console.log(`Packs: ${packs.map((p) => `${p.name} ${p.mod.version}`).join(", ") || "none"}`);
    if (loopback) {
      console.log("\nOnly this PC can reach the server. Use --lan when the Steam Machine is ready.");
      return;
    }
    const candidates = util.lanAddresses();
    if (candidates.length > 1) {
      console.log(`LAN interfaces: ${candidates.map((c) => `${c.address} (${c.name})`).join(", ")}`);
      console.log(`Using ${host}. Pass --host <ip> if that is the wrong interface.`);
    }
    if (!fs.existsSync(bootstrapTar)) console.log("WARNING: bootstrap.tar.gz is missing; TV bootstrap will 404.");
    console.log("\nSteam Machine (Desktop Mode):");
    console.log(`curl -fsSL '${baseUrl}/bootstrap.sh?token=${token}' | bash`);
    console.log("\nFirewall (admin PowerShell, once; local subnet only):");
    console.log(`New-NetFirewallRule -DisplayName "ModSync HTTP ${port}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -RemoteAddress LocalSubnet -Profile Any`);
    console.log("\nDo not port-forward this port or enable UPnP. Keep it on the LAN.");
    console.log("Keep this process running while the TV installs/updates.");
  });
}

async function cmdAgent(values) {
  const configPath = path.resolve(values.config || path.join(process.cwd(), "agent.json"));
  if (!fs.existsSync(configPath)) fail(`agent config not found: ${configPath} (run the TV bootstrap once)`);
  const config = util.readJson(configPath);
  if (values.port) config.port = Number(values.port);
  const agent = createAgent(config);
  agent.listen(() => {
    console.log(`ModSync TV dashboard: http://127.0.0.1:${config.port || 8788}`);
    console.log(`Root: ${config.root || "~/ModSync"}`);
    console.log(`PC: ${config.pcUrl || "(not configured)"}`);
  });
}

async function cmdBootstrap(values) {
  const out = path.resolve(values.out || path.join(repoRoot, "state", "bootstrap.tar.gz"));
  await buildBootstrap(repoRoot, out, (m) => console.log(m));
}

function cmdDoctor(values) {
  console.log(`Node: ${process.version} (${process.platform}/${process.arch})`);
  console.log(`Repo: ${repoRoot}`);
  console.log(`Steam roots: ${steam.steamRoots().join(", ") || "none"}`);
  console.log(`Steam libraries: ${steam.libraries().join(", ") || "none"}`);
  const packsDir = path.resolve(values.packs || path.join(repoRoot, "packs"));
  if (!fs.existsSync(packsDir)) return console.log("Packs: none");
  for (const ent of fs.readdirSync(packsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const root = path.join(packsDir, ent.name);
    if (!fs.existsSync(path.join(root, "pack.json"))) continue;
    try {
      const { pack } = loadPack(root);
      const game = steam.findGame(pack.game);
      console.log(`Pack: ${pack.name} ${pack.mod.version}`);
      console.log(`  Game: ${pack.game.title} (${pack.game.appId}) required build ${pack.game.build || "-"}`);
      console.log(`  Found: ${game ? game.root : "NO"} build=${game ? game.build : "-"} prefix=${game ? game.prefixReady : "-"}`);
    } catch (err) {
      console.log(`Pack ${ent.name}: INVALID (${err.message})`);
    }
  }
}

async function cmdRegister(values) {
  if (!values.exe || !values.name) fail("register needs --exe and --name");
  const out = await steam.registerShortcut({
    exePath: path.resolve(values.exe),
    name: values.name,
    icon: values.icon ? path.resolve(values.icon) : "",
    art: {
      grid: values.grid ? path.resolve(values.grid) : "",
      hero: values.hero ? path.resolve(values.hero) : "",
      logo: values.logo ? path.resolve(values.logo) : "",
    },
  });
  console.log(`Steam shortcut: ${out.appId} in ${out.configDir}`);
  console.log("Restart Steam if it does not appear.");
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    allowPositionals: true,
    options: {
      source: { type: "string" }, out: { type: "string" }, version: { type: "string" },
      copy: { type: "boolean" }, packs: { type: "string" }, host: { type: "string" }, lan: { type: "boolean" },
      port: { type: "string" }, token: { type: "string" }, config: { type: "string" },
      "rebuild-bootstrap": { type: "boolean" }, "skip-bootstrap": { type: "boolean" },
      exe: { type: "string" }, name: { type: "string" }, icon: { type: "string" },
      grid: { type: "string" }, hero: { type: "string" }, logo: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0] || "help";
  if (cmd === "help" || values.help) return console.log(help);
  if (cmd === "pack") return cmdPack(values);
  if (cmd === "serve") return cmdServe(values);
  if (cmd === "agent") return cmdAgent(values);
  if (cmd === "bootstrap") return cmdBootstrap(values);
  if (cmd === "doctor") return cmdDoctor(values);
  if (cmd === "register") return cmdRegister(values);
  return console.log(help);
}

module.exports = { main, repoRoot };
