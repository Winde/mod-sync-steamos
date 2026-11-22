import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import readline from "node:readline/promises";
import * as util from "./util";
import { driverFor } from "./drivers";
import * as recipes from "./recipes";
import { loadPack, packSummary } from "./manifest";
import * as packDocs from "./pack-docs";
import { createServer } from "./server";
import { createAgent } from "./agent";
import labels from "./labels";
import * as paths from "./paths";
import * as steam from "./steam";
import { projectRoot } from "./root";
import type { AgentConfig } from "./agent";
import type { PackSummary } from "./types";

interface CliValues {
  source?: string;
  out?: string;
  version?: string;
  recipe?: string;
  "game-root"?: string;
  "include-dirs"?: string;
  "extra-files"?: string;
  "include-base-data"?: boolean;
  copy?: boolean;
  packs?: string;
  host?: string;
  lan?: boolean;
  port?: string;
  token?: string;
  config?: string;
  exe?: string;
  name?: string;
  icon?: string;
  grid?: string;
  hero?: string;
  logo?: string;
  header?: string;
  portrait?: string;
  help?: boolean;
}

interface CliConfig {
  recipe?: string;
  source?: string;
  out?: string;
  version?: string;
}

const repoRoot = projectRoot;
const configPath = path.join(repoRoot, "state", "config.json");

const help = `modsync — mod pack deployment for Windows and SteamOS (mods only)

Commands:
  init      Remember the working install and pack output
  pack      Build a pack from a working install
  serve     Serve packs over HTTP
  agent     Run the TV agent/dashboard
  doctor    Inspect packs, Steam, and game detection
  register  Add a .sh launcher to Steam with art
  help      This help

pack:
  --recipe <id|file> Pack recipe from recipes/ (e.g. eldenring-graceborne)
  --source <dir>    Working install (default: state/config.json or the game's data dir)
  --out <dir>       Pack output (default: config or packs/<recipe>)
  --version <ver>   Mod version (default: current.txt for ER, date for BG3)
  --game-root <dir> BG3 game install (default: detected Steam library)
  --include-dirs <list> Comma-separated mod folders that load at runtime
  --extra-files <list>  Comma-separated game-relative runtime files/folders
  --include-base-data   Include bulk data/ content (total conversions only)
  --copy            Copy payload instead of hardlinking

init:
  --recipe <id|file> Pack recipe to remember
  Asks once for the recipe, working install, and pack output, then writes
  state/config.json. After that, \`modsync pack\` needs no arguments.

serve:
  --packs <dir>     Packs directory (default: packs)
  --lan             Bind the detected LAN IPv4 (needed by the TV)
  --host <ip>       Bind a specific address (default: 127.0.0.1)
  --port <n>        Port (default: 8787)
  --token <token>   Fixed token (default: random per run)

agent:
  --config <file>   agent.json (default: ./agent.json)
  --port <n>        Override dashboard port (default: 8788)

register:
  --exe <file> --name <name> --icon <png> [--grid <png>] [--hero <png>] [--logo <png>]
  [--header <png>] [--portrait <png>]
`;

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function readConfig(): CliConfig {
  try { return util.readJson<CliConfig>(configPath); } catch { return {}; }
}

async function cmdInit(values: CliValues = {}): Promise<CliConfig | undefined> {
  const current = readConfig();
  const list = recipes.listRecipes();
  if (!list.length) fail(`No recipes in ${recipes.recipesDir}. Add a recipe first.`);
  const recipeDefault = values.recipe || current.recipe || list[0].id;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`Recipes: ${list.map((r) => r.id).join(", ")}`);
    const recipeAnswer = await rl.question(`Pack recipe [${recipeDefault}]: `);
    const recipe = recipes.loadRecipe(recipeAnswer.trim() || recipeDefault);
    const driver = driverFor(recipe.game);
    const same = recipe.id === current.recipe;
    const sourceDefault = values.source || (same && current.source) || driver.defaultSource();
    const outDefault = values.out || (same && current.out) || path.join("packs", recipe.id);
    const sourceAnswer = await rl.question(`Working install [${sourceDefault}]: `);
    const source = sourceAnswer.trim() || sourceDefault;
    const outAnswer = await rl.question(`Pack output [${outDefault}]: `);
    const out = outAnswer.trim() || outDefault;
    util.ensureDir(path.dirname(configPath));
    util.writeJson(configPath, { recipe: recipe.id, source, out });
    console.log(`Wrote ${configPath}`);
    if (!fs.existsSync(source)) console.log(`WARNING: ${source} does not exist yet.`);
    return { recipe: recipe.id, source, out };
  } finally {
    rl.close();
  }
}

async function cmdPack(values: CliValues): Promise<void> {
  if (!fs.existsSync(configPath) && !values.recipe && !values.source && !values.out && process.stdin.isTTY) {
    console.log("No pack config yet. Set it once; press Enter to accept each default.\n");
    await cmdInit(values);
    console.log("");
  }
  const config = readConfig();
  const recipeRef = values.recipe || config.recipe;
  if (!recipeRef) {
    const list = recipes.listRecipes().map((r) => r.id).join(", ") || "none";
    fail(`No pack recipe. Run modsync init or pass --recipe <id>. Recipes: ${list}`);
  }
  const recipe = recipes.loadRecipe(recipeRef);
  const driver = driverFor(recipe.game);
  const source = values.source || config.source || driver.defaultSource();
  const out = path.resolve(values.out || config.out || path.join(repoRoot, "packs", recipe.id));
  console.log(`Game: ${driver.GAME.title}`);
  console.log(`Pack: ${recipe.name} (${recipe.id})`);
  console.log(`Source: ${source}`);
  console.log(`Output: ${out}`);
  const driverOptions: Record<string, unknown> = {};
  if (values["game-root"]) driverOptions.gameRoot = values["game-root"];
  if (values["include-dirs"]) driverOptions.includeDirs = values["include-dirs"];
  if (values["extra-files"]) driverOptions.extraFiles = values["extra-files"];
  if (values["include-base-data"]) driverOptions.includeBaseData = "yes";
  const result = await driver.buildPack({
    recipe,
    source,
    out,
    link: !values.copy,
    version: values.version || config.version || recipe.version,
    driverOptions,
    log: (m) => console.log(m),
  });
  try {
    packDocs.writePackDoc(result.packRoot);
    console.log(`Docs: ${packDocs.packDocFile(result.packRoot)}`);
  } catch (err) {
    console.warn(`WARNING: could not write pack documentation: ${util.errorMessage(err)}`);
  }
  console.log(`\nPack: ${result.packRoot}`);
  console.log(`Version: ${result.pack.mod.version}`);
  console.log(`Files: ${result.files}`);
  console.log(`Size: ${(result.totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
}

async function cmdServe(values: CliValues): Promise<void> {
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
  const packs = fs.existsSync(packsDir)
    ? fs.readdirSync(packsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(packsDir, e.name, "pack.json")))
      .map((e) => { try { return packSummary(path.join(packsDir, e.name)); } catch { return null; } }).filter((p): p is PackSummary => p !== null)
    : [];

  const server = createServer({
    packsDir,
    token,
    baseUrl,
  });
  server.listen(port, host, () => {
    console.log(`\n${labels.serve.repository(baseUrl)}`);
    console.log(labels.serve.bind(host, loopback));
    console.log(labels.serve.token(token));
    console.log(labels.serve.packs(packs.map((p) => `${p.name} ${p.mod.version}`).join(", ")));
    if (loopback) {
      console.log(`\n${labels.serve.loopbackOnly}`);
      return;
    }
    const candidates = util.lanAddresses();
    if (candidates.length > 1) {
      console.log(labels.serve.lanInterfaces(candidates.map((c) => `${c.address} (${c.name})`).join(", ")));
      console.log(labels.serve.usingHost(host));
    }
    console.log(`\n${labels.serve.steamMachine}`);
    console.log(labels.serve.install(baseUrl, token));
    console.log(`\n${labels.serve.firewallTitle}`);
    console.log(labels.serve.firewall(port));
    console.log(`\n${labels.serve.lanOnly}`);
    console.log(labels.serve.keepRunning);
  });
}

async function cmdAgent(values: CliValues): Promise<void> {
  const agentConfigPath = path.resolve(values.config || path.join(process.cwd(), "agent.json"));
  if (!fs.existsSync(agentConfigPath)) fail(`agent config not found: ${agentConfigPath} (install the TV app once)`);
  const config = util.readJson<AgentConfig>(agentConfigPath);
  if (values.port) config.port = Number(values.port);
  const saveConnection = (connection: { pcUrl: string; token: string }): void => {
    let current: Record<string, unknown> = {};
    try { current = util.readJson<Record<string, unknown>>(agentConfigPath); } catch { /* write a fresh file */ }
    util.writeJson(agentConfigPath, { ...current, pcUrl: connection.pcUrl, token: connection.token });
  };
  const agent = createAgent({ ...config, saveConnection });
  agent.listen(() => {
    console.log(labels.agent.dashboard(Number(config.port || 8788)));
    console.log(labels.agent.root(config.root || "~/ModSync"));
    console.log(labels.agent.pc(String(config.pcUrl || "")));
  });
}

function cmdDoctor(values: CliValues): void {
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
      const target = paths.resolve(pack, game);
      console.log(`Pack: ${pack.name} ${pack.mod.version}`);
      console.log(`  Game: ${pack.game.title} (${pack.game.appId}) required build ${pack.game.build || "-"}`);
      console.log(`  Found: ${game ? game.root : "NO"} build=${game ? game.build : "-"} mode=${game ? game.mode : "-"} prefix=${game ? game.prefixReady : "-"}`);
      console.log(`  Target: ${target.variant} supported=${target.supported}${target.error ? ` error=${target.error}` : ""}`);
    } catch (err) {
      console.log(`Pack ${ent.name}: INVALID (${util.errorMessage(err)})`);
    }
  }
}

async function cmdRegister(values: CliValues): Promise<void> {
  if (!values.exe || !values.name) fail("register needs --exe and --name");
  const resolve = (value: string | undefined) => value ? path.resolve(value) : "";
  const out = await steam.registerShortcut({
    exePath: path.resolve(values.exe),
    name: values.name,
    icon: values.icon ? path.resolve(values.icon) : "",
    art: {
      grid: resolve(values.grid),
      hero: resolve(values.hero),
      logo: resolve(values.logo),
      header: resolve(values.header),
      portrait: resolve(values.portrait),
      icon: values.icon ? path.resolve(values.icon) : "",
    },
  });
  console.log(`Steam shortcut: ${out.appId} in ${out.configDir} (${out.action}${out.deduped ? `, removed ${out.deduped} duplicate(s)` : ""})`);
  console.log("Restart Steam if it does not appear.");
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const parsed = parseArgs({
    args: argv.slice(2),
    allowPositionals: true,
    options: {
      source: { type: "string" }, out: { type: "string" }, version: { type: "string" },
      recipe: { type: "string" }, "game-root": { type: "string" },
      "include-dirs": { type: "string" }, "extra-files": { type: "string" },
      "include-base-data": { type: "boolean" },
      copy: { type: "boolean" }, packs: { type: "string" }, host: { type: "string" }, lan: { type: "boolean" },
      port: { type: "string" }, token: { type: "string" }, config: { type: "string" },
      exe: { type: "string" }, name: { type: "string" }, icon: { type: "string" },
      grid: { type: "string" }, hero: { type: "string" }, logo: { type: "string" },
      header: { type: "string" }, portrait: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const values = parsed.values as CliValues;
  const cmd = parsed.positionals[0] || "help";
  if (cmd === "help" || values.help) { console.log(help); return; }
  if (cmd === "init") { await cmdInit(values); return; }
  if (cmd === "pack") { await cmdPack(values); return; }
  if (cmd === "serve") { await cmdServe(values); return; }
  if (cmd === "agent") { await cmdAgent(values); return; }
  if (cmd === "doctor") { cmdDoctor(values); return; }
  if (cmd === "register") { await cmdRegister(values); return; }
  console.log(help);
}
