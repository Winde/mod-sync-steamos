#!/usr/bin/env node
/**
 * Install a real pack into an empty TV root and verify it, or verify an
 * existing root without installing.
 *
 * The game install, Steam, and saves are never touched. The root must be under
 * state/ so a mistyped path cannot wipe something real.
 *
 *   node scripts/e2e-factory.js
 *   node scripts/e2e-factory.js --verify-only --root state/manual-tv
 *   node scripts/e2e-factory.js --clean
 */
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { createServer } = require("../src/server");
const { createAgent } = require("../src/agent");
const { loadPack } = require("../src/manifest");
const versionStore = require("../src/version-store");
const { sha256File, mapLimit, safeJoin, walkFiles, formatBytes } = require("../src/util");

const repoRoot = path.resolve(__dirname, "..");
const stateDir = path.join(repoRoot, "state");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function progressLine(job, startedAt) {
  const pct = job.bytesTotal ? Math.min(100, Math.round((job.bytesDone / job.bytesTotal) * 100)) : 0;
  const secs = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const speed = job.bytesDone / secs;
  return `${String(pct).padStart(3)}%  ${formatBytes(job.bytesDone)} / ${formatBytes(job.bytesTotal)}` +
    `  ${formatBytes(speed)}/s  ${job.done || 0}/${job.total || 0} files`;
}

async function verifyRoot(pack, files, root, verifyHashes) {
  const installedRoot = versionStore.packRoot(root, pack.id);
  const currentPath = versionStore.currentFile(installedRoot, pack.mod.id);
  if (!fs.existsSync(currentPath)) throw new Error(`not installed: missing ${currentPath}`);
  const current = versionStore.readCurrent(installedRoot, pack.mod.id);
  if (current !== pack.mod.version) throw new Error(`current.txt is ${current}, expected ${pack.mod.version}`);

  const versionDir = versionStore.versionDir(installedRoot, pack.mod.id, pack.mod.version);
  if (!fs.existsSync(versionDir)) throw new Error(`missing version dir ${versionDir}`);

  const problems = [];
  let verified = 0;
  let bytes = 0;
  await mapLimit(files.files, 6, async (f) => {
    const target = safeJoin(installedRoot, f.target);
    if (!fs.existsSync(target)) {
      problems.push(`missing ${f.target}`);
      return;
    }
    const stat = fs.statSync(target);
    if (stat.size !== f.size) problems.push(`size ${f.target} (${stat.size} != ${f.size})`);
    if (verifyHashes) {
      const hash = await sha256File(target);
      if (hash !== f.sha256) problems.push(`sha256 ${f.target}`);
    }
    verified++;
    bytes += stat.size;
  });
  if (problems.length) {
    throw new Error(`verification failed:\n  ${problems.slice(0, 20).join("\n  ")}${problems.length > 20 ? `\n  ...and ${problems.length - 20} more` : ""}`);
  }

  const launcher = versionStore.launcherFile(installedRoot, pack.mod.id);
  if (!fs.existsSync(launcher)) throw new Error(`missing launcher ${launcher}`);
  const launcherText = fs.readFileSync(launcher, "utf8");
  if (!launcherText.includes(pack.launch.saveFile) || !launcherText.includes("--online false")) {
    throw new Error("launcher does not contain the save file / offline flag");
  }
  const parts = walkFiles(installedRoot).filter((f) => f.rel.endsWith(".part"));
  if (parts.length) throw new Error(`${parts.length} .part files left behind`);

  console.log(`Verified: ${verified}/${files.files.length} files, ${formatBytes(bytes)}`);
  console.log(`Version:  ${current}`);
  console.log(`Launcher: ${launcher}`);
  console.log("Partials: none");
  return { current, launcher, verified, bytes };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pack: { type: "string" },
      root: { type: "string" },
      clean: { type: "boolean" },
      "skip-hashes": { type: "boolean" },
      "verify-only": { type: "boolean" },
    },
  });

  const packRoot = path.resolve(values.pack || path.join(repoRoot, "packs", "eldenring-graceborne"));
  const root = path.resolve(values.root || path.join(stateDir, "e2e-factory"));
  if (!root.startsWith(stateDir + path.sep)) {
    throw new Error(`Refusing to use a test root outside ${stateDir}: ${root}`);
  }

  const { pack, files } = loadPack(packRoot);
  const totalBytes = files.files.reduce((n, f) => n + f.size, 0);
  console.log(`Pack:     ${pack.name} ${pack.mod.version} (${files.files.length} files, ${formatBytes(totalBytes)})`);
  console.log(`Pack dir: ${packRoot}`);
  console.log(`TV root:  ${root}`);

  if (values["verify-only"]) {
    await verifyRoot(pack, files, root, !values["skip-hashes"]);
    console.log("");
    console.log("PASS — installed root matches the pack manifest.");
    return;
  }

  if (fs.existsSync(root)) {
    console.log("Removing previous test root...");
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.mkdirSync(root, { recursive: true });

  const token = "e2e";
  const server = createServer({
    packsDir: path.dirname(packRoot),
    token,
    baseUrl: "http://127.0.0.1",
    bootstrapTar: path.join(stateDir, "bootstrap.tar.gz"),
    bootstrapTemplate: path.join(repoRoot, "scripts", "bootstrap.sh"),
  });
  const serverPort = await listen(server);
  const pcUrl = `http://127.0.0.1:${serverPort}`;
  const agent = createAgent({ pcUrl, token, root, port: 0 });
  const agentPort = await listen(agent.server);
  const agentUrl = `http://127.0.0.1:${agentPort}`;
  console.log(`Server:   ${pcUrl}`);
  console.log(`Agent:    ${agentUrl}`);
  console.log("");

  try {
    const res = await fetch(`${agentUrl}/api/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packId: pack.id }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `install HTTP ${res.status}`);

    const startedAt = Date.now();
    let lastPrint = 0;
    let job;
    while (true) {
      const r = await fetch(`${agentUrl}/api/jobs/${encodeURIComponent(body.jobId)}`);
      job = await r.json();
      if (job.status === "error") throw new Error(job.error || "install failed");
      if (job.status === "canceled") throw new Error("install was canceled");
      if (job.status === "done") break;
      const now = Date.now();
      if (now - lastPrint > 2000) {
        console.log(`Installing ${progressLine(job, startedAt)}`);
        lastPrint = now;
      }
      await sleep(500);
    }
    const elapsed = (Date.now() - startedAt) / 1000;
    console.log(`Installed in ${elapsed.toFixed(1)}s (${formatBytes(totalBytes / elapsed)}/s)`);
    console.log("");

    await verifyRoot(pack, files, root, !values["skip-hashes"]);
    console.log("");
    console.log("PASS — pack installs from an empty TV root on this machine.");
  } finally {
    await close(agent.server);
    await close(server);
    if (values.clean) {
      fs.rmSync(root, { recursive: true, force: true });
      console.log(`Cleaned ${root}`);
    } else {
      console.log(`Test root kept at ${root}`);
    }
  }
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
