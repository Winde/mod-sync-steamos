const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, value) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + "\n");
}

function readText(p, fallback = "") {
  try { return fs.readFileSync(p, "utf8"); } catch { return fallback; }
}

function writeText(p, text, mode) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, text, "utf8");
  if (mode != null) fs.chmodSync(p, mode);
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(p);
    s.on("data", (d) => h.update(d));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

function walkFiles(root, base = root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, ent.name);
    if (ent.isDirectory()) {
      out.push(...walkFiles(abs, base));
    } else if (ent.isFile()) {
      const rel = path.relative(base, abs).split(path.sep).join("/");
      out.push({ abs, rel, size: fs.statSync(abs).size });
    }
  }
  return out;
}

function safeJoin(root, rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) throw new Error("invalid path");
  const norm = rel.replace(/\\/g, "/");
  if (path.posix.isAbsolute(norm)) throw new Error("absolute path not allowed");
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, norm);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new Error("path escapes root");
  return abs;
}

function relPosix(from, to) {
  return path.relative(from, to).split(path.sep).join("/");
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function randomToken() {
  return crypto.randomBytes(12).toString("hex");
}

function detectLanIp() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) {
        candidates.push({ name, address: a.address });
      }
    }
  }
  const preferred = candidates.find((c) => c.address.startsWith("192.168."))
    || candidates.find((c) => c.address.startsWith("192."))
    || candidates.find((c) => c.address.startsWith("10."))
    || candidates[0];
  return preferred ? preferred.address : "127.0.0.1";
}

function isGameRunning(processName) {
  if (!processName) return false;
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${processName}`], { encoding: "utf8" });
      return out.toLowerCase().includes(processName.toLowerCase());
    }
    execFileSync("pgrep", ["-x", processName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function materialize(src, dst, link = true) {
  ensureDir(path.dirname(dst));
  if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
  if (link) {
    try {
      fs.linkSync(src, dst);
      return "link";
    } catch (err) {
      if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(err.code)) throw err;
    }
  }
  fs.copyFileSync(src, dst);
  return "copy";
}

function modeFor(rel) {
  if (rel.endsWith(".sh")) return "755";
  if (rel.replace(/\\/g, "/") === "tools/me3-linux/bin/me3") return "755";
  return "644";
}

function tailText(text, lines = 200) {
  const arr = text.split(/\r?\n/);
  return arr.slice(Math.max(0, arr.length - lines)).join("\n");
}

function tailFile(p, lines = 200) {
  return tailText(readText(p), lines);
}

function freeBytes(dir) {
  let p = path.resolve(dir);
  while (p) {
    try {
      const s = fs.statfsSync(p);
      return Number(s.bavail) * Number(s.bsize);
    } catch { }
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return null;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function fetchToFile(url, dest, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  ensureDir(path.dirname(dest));
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

module.exports = {
  ensureDir, readJson, writeJson, readText, writeText,
  sha256File, walkFiles, safeJoin, relPosix, formatBytes,
  nowStamp, randomToken, detectLanIp, isGameRunning, mapLimit,
  materialize, modeFor, tailText, tailFile, fetchJson, fetchToFile,
  freeBytes, fsp,
};
