const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ensureDir, fetchToFile, formatBytes } = require("./util");

function ensureNodeLinux(repoRoot, log = () => {}) {
  const nodeDir = path.join(repoRoot, "tools", "node-linux");
  const nodeBin = path.join(nodeDir, "bin", "node");
  if (fs.existsSync(nodeBin)) return nodeDir;

  const version = process.version;
  const folder = `node-${version}-linux-x64`;
  const cache = path.join(repoRoot, "state", "cache");
  const archive = path.join(cache, `${folder}.tar.xz`);
  const extract = path.join(cache, `${folder}-extract`);
  const url = `https://nodejs.org/dist/${version}/${folder}.tar.xz`;

  ensureDir(cache);
  if (!fs.existsSync(archive)) {
    log(`Downloading Linux Node ${version} (${url})...`);
    return fetchToFile(url, archive).then(() => {
      extractAndInstall(archive, extract, folder, nodeDir, log);
      return nodeDir;
    });
  }
  extractAndInstall(archive, extract, folder, nodeDir, log);
  return nodeDir;
}

function extractAndInstall(archive, extract, folder, nodeDir, log) {
  fs.rmSync(extract, { recursive: true, force: true });
  ensureDir(extract);
  log("Extracting Linux Node runtime...");
  const res = spawnSync("tar", ["-xJf", archive, "-C", extract], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`tar failed: ${res.stderr || res.status}`);
  const src = path.join(extract, folder);
  if (!fs.existsSync(src)) throw new Error(`Node archive did not contain ${folder}`);
  fs.rmSync(nodeDir, { recursive: true, force: true });
  ensureDir(nodeDir);
  fs.cpSync(src, nodeDir, { recursive: true });
  try { fs.chmodSync(path.join(nodeDir, "bin", "node"), 0o755); } catch { }
  fs.rmSync(extract, { recursive: true, force: true });
}

async function buildBootstrap(repoRoot, outFile, log = () => {}) {
  await ensureNodeLinux(repoRoot, log);
  const stage = path.join(repoRoot, "state", "bootstrap-stage");
  const agent = path.join(stage, "agent");
  const tools = path.join(stage, "tools");
  fs.rmSync(stage, { recursive: true, force: true });
  ensureDir(agent);
  ensureDir(tools);

  for (const dir of ["bin", "src", "web", "templates"]) {
    fs.cpSync(path.join(repoRoot, dir), path.join(agent, dir), { recursive: true });
  }
  for (const file of ["package.json", "package-lock.json"]) {
    const src = path.join(repoRoot, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(agent, file));
  }
  const modules = path.join(repoRoot, "node_modules");
  if (fs.existsSync(modules)) fs.cpSync(modules, path.join(agent, "node_modules"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "scripts", "agent-install.sh"), path.join(agent, "install.sh"));
  fs.chmodSync(path.join(agent, "install.sh"), 0o755);
  fs.cpSync(path.join(repoRoot, "tools", "node-linux"), path.join(tools, "node"), { recursive: true });

  ensureDir(path.dirname(outFile));
  log("Packing bootstrap tarball...");
  const res = spawnSync("tar", ["-czf", outFile, "-C", stage, "agent", "tools"], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`tar failed: ${res.stderr || res.status}`);
  const size = fs.statSync(outFile).size;
  fs.rmSync(stage, { recursive: true, force: true });
  log(`Bootstrap: ${outFile} (${formatBytes(size)})`);
  return { outFile, size };
}

module.exports = { ensureNodeLinux, buildBootstrap };
