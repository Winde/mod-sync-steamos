const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { loadPack, packSummary } = require("./manifest");
const labels = require("./labels");
const { safeJoin } = require("./util");

function contentType(p) {
  switch (path.extname(p).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".json": return "application/json";
    case ".js": return "text/javascript";
    case ".css": return "text/css";
    case ".html": return "text/html";
    case ".desktop": return "text/plain";
    default: return "application/octet-stream";
  }
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, code, text, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return { invalid: true };
  let start;
  let end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (!n) return { invalid: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Number(m[2]) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { invalid: true };
  if (end >= size) end = size - 1;
  return { start, end };
}

function sendFile(req, res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const stat = fs.statSync(file);
  const range = parseRange(req && req.headers ? req.headers.range : null, stat.size);
  if (range && range.invalid) {
    res.writeHead(416, { "content-range": `bytes */${stat.size}`, "accept-ranges": "bytes" });
    res.end();
    return true;
  }
  if (range) {
    res.writeHead(206, {
      "content-type": contentType(file),
      "content-length": range.end - range.start + 1,
      "content-range": `bytes ${range.start}-${range.end}/${stat.size}`,
      "accept-ranges": "bytes",
    });
    fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    return true;
  }
  res.writeHead(200, { "content-type": contentType(file), "content-length": stat.size, "accept-ranges": "bytes" });
  fs.createReadStream(file).pipe(res);
  return true;
}

function loadPacks(packsDir) {
  if (!fs.existsSync(packsDir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(packsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const root = path.join(packsDir, ent.name);
    if (!fs.existsSync(path.join(root, "pack.json"))) continue;
    try { out.push({ root, summary: packSummary(root) }); } catch (err) {
      console.error(`[packs] ${ent.name}: ${err.message}`);
    }
  }
  return out;
}

function createServer({ packsDir, token, baseUrl }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, baseUrl || "http://localhost");
    const authorized = url.searchParams.get("token") === token || req.headers["x-modsync-token"] === token;

    if (url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, name: "modsync", version: "0.1.0" });
    }
    if (url.pathname === "/") {
      const packs = loadPacks(packsDir);
      const list = packs.map((p) => `<li>${p.summary.name} ${p.summary.mod.version} <span>(${p.summary.files} files)</span></li>`).join("");
      return sendText(res, 200, `<!doctype html><meta charset="utf-8"><title>${labels.brand}</title><style>body{font:15px system-ui;background:#0b0e14;color:#e9edf5;padding:24px}code{background:#151b27;padding:2px 6px;border-radius:4px}li{margin:6px 0}span{color:#8b94a7}</style><h2>${labels.server.title}</h2><ul>${list || `<li>${labels.server.noPacks}</li>`}</ul><p>${labels.server.installHint}</p>`, "text/html; charset=utf-8");
    }
    if (!authorized) return sendJson(res, 403, { error: "bad or missing token" });

    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/api/packs") {
      return sendJson(res, 200, loadPacks(packsDir).map((p) => p.summary));
    }
    if (parts[0] === "api" && parts[1] === "packs" && parts[2]) {
      const packId = decodeURIComponent(parts[2]);
      const entry = loadPacks(packsDir).find((p) => p.summary.id === packId);
      if (!entry) return sendJson(res, 404, { error: "pack not found" });
      if (parts[3] === "pack.json") {
        const { pack } = loadPack(entry.root);
        return sendJson(res, 200, pack);
      }
      if (parts[3] === "files.json") {
        const { files } = loadPack(entry.root);
        return sendJson(res, 200, files);
      }
      if (parts[3] === "art" && parts[4]) {
        const { pack } = loadPack(entry.root);
        const rel = pack.art[decodeURIComponent(parts[4])];
        if (!rel) return sendJson(res, 404, { error: "art not found" });
        const file = safeJoin(entry.root, rel);
        if (!sendFile(req, res, file)) return sendJson(res, 404, { error: "art missing" });
        return;
      }
      if (parts[3] === "file") {
        const rel = url.searchParams.get("path");
        if (!rel) return sendJson(res, 400, { error: "path required" });
        const { files } = loadPack(entry.root);
        const f = files.files.find((x) => x.source === rel);
        if (!f) return sendJson(res, 404, { error: "file not in manifest" });
        const file = safeJoin(entry.root, f.source);
        if (!sendFile(req, res, file)) return sendJson(res, 404, { error: "file missing" });
        return;
      }
    }
    return sendJson(res, 404, { error: "not found" });
  });
}

module.exports = { createServer, loadPacks, parseRange };
