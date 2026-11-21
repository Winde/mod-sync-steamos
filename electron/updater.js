const { createHash } = require("node:crypto");
const {
  accessSync, chmodSync, constants, createReadStream, createWriteStream,
  realpathSync, renameSync, rmSync,
} = require("node:fs");
const { dirname } = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const RELEASES_REPO = "Winde/mod-sync-steamos";
const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `${RELEASES_PAGE}/download/`;
const CHECKSUMS_NAME = "SHA256SUMS.txt";
const API_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": RELEASES_REPO,
};
const CHECK_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

function parseVersion(value) {
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value).trim().replace(/^v/, ""));
  if (!match) return null;
  return { numbers: match[1].split(".").map(Number), pre: match[2] ? match[2].split(".") : [] };
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  const parts = Math.max(left.numbers.length, right.numbers.length);
  for (let i = 0; i < parts; i++) {
    const diff = (left.numbers[i] || 0) - (right.numbers[i] || 0);
    if (diff) return diff;
  }
  if (!left.pre.length && right.pre.length) return 1;
  if (left.pre.length && !right.pre.length) return -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    if (left.pre[i] === undefined) return -1;
    if (right.pre[i] === undefined) return 1;
    if (left.pre[i] === right.pre[i]) continue;
    const ln = Number(left.pre[i]);
    const rn = Number(right.pre[i]);
    if (Number.isFinite(ln) && Number.isFinite(rn)) return ln - rn;
    return left.pre[i] < right.pre[i] ? -1 : 1;
  }
  return 0;
}

function appImageName(version) {
  return `ModSync-${version}-x86_64.AppImage`;
}

function parseRelease(value) {
  if (!value || typeof value !== "object") throw new Error("GitHub sent unexpected release data");
  const version = typeof value.tag_name === "string" ? value.tag_name.trim().replace(/^v/, "") : "";
  if (!parseVersion(version)) throw new Error("The latest release has no usable version");
  const assets = [];
  if (Array.isArray(value.assets)) {
    for (const asset of value.assets) {
      if (!asset || typeof asset !== "object") continue;
      if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") continue;
      if (!asset.browser_download_url.startsWith(DOWNLOAD_PREFIX)) continue;
      assets.push({ name: asset.name, url: asset.browser_download_url });
    }
  }
  return { version, assets };
}

function checksumFor(sums, name) {
  for (const line of String(sums).split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match && match[2] === name) return match[1].toLowerCase();
  }
  return null;
}

function directoryWritable(directory) {
  try { accessSync(directory, constants.W_OK); return true; } catch { return false; }
}

function currentAppImage(env = process.env) {
  const raw = env.APPIMAGE;
  if (!raw) return null;
  try {
    const target = realpathSync(raw);
    return directoryWritable(dirname(target)) ? target : null;
  } catch { return null; }
}

function relaunchArgs(argv, env = process.env) {
  const args = argv.filter((arg) => !arg.startsWith("--screenshot="));
  const appDir = env.APPDIR;
  if (appDir && !appDir.includes(".mount_") && !args.includes("--appimage-extract-and-run")) {
    args.push("--appimage-extract-and-run");
  }
  return args;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

class Updater {
  constructor({ currentVersion, appImage, fetch }) {
    this.currentVersion = currentVersion;
    this.appImage = appImage;
    this.fetch = fetch;
    this.pending = null;
  }

  async check() {
    const current = this.currentVersion();
    let response;
    try {
      response = await this.fetch(LATEST_RELEASE_API, {
        headers: { ...API_HEADERS, "user-agent": `${API_HEADERS["user-agent"]} ${current}` },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
    } catch {
      throw new Error("Could not reach GitHub. Check the connection and try again.");
    }
    if (!response.ok) {
      throw new Error(response.status === 404
        ? "No release has been published yet."
        : `GitHub answered ${response.status}. Try again later.`);
    }
    let json;
    try { json = await response.json(); } catch { throw new Error("GitHub sent unexpected release data"); }
    const release = parseRelease(json);
    const available = compareVersions(release.version, current) > 0;
    this.pending = available ? release : null;
    return {
      current,
      latest: release.version,
      available,
      canInstall: available && this.appImage() !== null,
    };
  }

  async install() {
    const release = this.pending;
    if (!release) throw new Error("Check for updates before installing one");
    const target = this.appImage();
    if (!target) throw new Error("This copy of ModSync cannot update itself");

    const name = appImageName(release.version);
    const asset = release.assets.find((entry) => entry.name === name);
    const checksums = release.assets.find((entry) => entry.name === CHECKSUMS_NAME);
    if (!asset || !checksums) throw new Error("The latest release is missing its AppImage or checksums");

    let sums;
    try {
      const response = await this.fetch(checksums.url, { headers: API_HEADERS, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      sums = await response.text();
    } catch {
      throw new Error("Could not download the release checksums.");
    }
    const expected = checksumFor(sums, name);
    if (!expected) throw new Error(`The release does not list ${name}`);

    const part = `${target}.part`;
    try {
      const response = await this.fetch(asset.url, { headers: API_HEADERS, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`The update download failed (${response.status}).`);
      if (!response.body) throw new Error("The update download was empty.");
      await pipeline(Readable.fromWeb(response.body), createWriteStream(part, { mode: 0o755 }));
      const actual = await sha256(part);
      if (actual !== expected) throw new Error("The downloaded update failed its checksum.");
      chmodSync(part, 0o755);
      renameSync(part, target);
    } catch (error) {
      rmSync(part, { force: true });
      throw error;
    }
    this.pending = null;
    return target;
  }
}

module.exports = {
  RELEASES_PAGE,
  Updater,
  appImageName,
  checksumFor,
  compareVersions,
  currentAppImage,
  parseRelease,
  relaunchArgs,
};
