"use strict";

/**
 * Fetch the pinned BG3LE release used by the native Baldur's Gate 3 pack.
 *
 * The pack builder caches the unpacked release under state/bg3le. The zip is
 * verified against the published GitHub release checksum before it is used.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const VERSION = "0.4.6";
const ASSET = `bg3le-v${VERSION}-linux-x86_64.zip`;
const URL = `https://github.com/lenonk/bg3le/releases/download/v${VERSION}/${ASSET}`;
const SHA256 = "22d97ff3e9c5f07f8e55c9c8c792f6061097889556b1f20cb08c562dc056647b";
const CACHE = path.join(REPO_ROOT, "state", "bg3le", `bg3le-v${VERSION}-linux-x86_64`);

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function extract(zip, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    const quote = (value) => `'${value.replace(/'/g, "''")}'`;
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(dir)} -Force`,
    ], { stdio: "inherit" });
    return;
  }
  execFileSync("unzip", ["-q", zip, "-d", dir], { stdio: "inherit" });
}

async function ensureBg3le() {
  if (process.env.BG3LE_DIR) {
    const local = path.resolve(process.env.BG3LE_DIR);
    if (fs.existsSync(path.join(local, "build", "libbg3le.so"))) return local;
    throw new Error(`BG3LE_DIR does not contain build/libbg3le.so: ${local}`);
  }
  const lib = path.join(CACHE, "build", "libbg3le.so");
  if (fs.existsSync(lib)) return CACHE;

  const tmp = path.join(REPO_ROOT, "state", "bg3le", ".download");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, ASSET);
  console.log(`Downloading ${URL}`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`BG3LE download failed: HTTP ${res.status}`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const got = sha256File(zip);
  if (got !== SHA256) throw new Error(`BG3LE checksum mismatch: ${got}`);

  extract(zip, path.join(tmp, "unpacked"));
  const unpacked = path.join(tmp, "unpacked");
  const entries = fs.readdirSync(unpacked, { withFileTypes: true });
  const root = entries.length === 1 && entries[0].isDirectory()
    ? path.join(unpacked, entries[0].name)
    : unpacked;
  if (!fs.existsSync(path.join(root, "build", "libbg3le.so"))) {
    throw new Error(`BG3LE archive did not contain build/libbg3le.so: ${root}`);
  }
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.cpSync(root, CACHE, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  return CACHE;
}

if (require.main === module) {
  ensureBg3le().then((dir) => console.log(dir)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { ensureBg3le, CACHE, VERSION };
