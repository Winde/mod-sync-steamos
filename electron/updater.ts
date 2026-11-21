import { createHash } from "node:crypto";
import {
  accessSync, chmodSync, constants, createReadStream, createWriteStream,
  mkdirSync, realpathSync, renameSync, rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const RELEASES_REPO = "Winde/mod-sync-steamos";
const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `${RELEASES_PAGE}/download/`;
const CHECKSUMS_NAME = "SHA256SUMS.txt";
const API_HEADERS: Record<string, string> = {
  accept: "application/vnd.github+json",
  "user-agent": RELEASES_REPO,
};
const CHECK_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export interface ParsedVersion {
  numbers: number[];
  pre: string[];
}

export function parseVersion(value: unknown): ParsedVersion | null {
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value).trim().replace(/^v/, ""));
  if (!match) return null;
  return { numbers: match[1].split(".").map(Number), pre: match[2] ? match[2].split(".") : [] };
}

export function compareVersions(a: unknown, b: unknown): number {
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

export function appImageName(version: string): string {
  return `ModSync-Client-${version}-x86_64.AppImage`;
}

export function windowsInstallerName(product: "Server" | "Client", version: string, arch = "x64"): string {
  return `ModSync-${product}-${version}-${arch}.exe`;
}

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface Release {
  version: string;
  assets: ReleaseAsset[];
}

export function parseRelease(value: unknown): Release {
  if (!value || typeof value !== "object") throw new Error("GitHub sent unexpected release data");
  const release = value as Record<string, unknown>;
  const version = typeof release.tag_name === "string" ? release.tag_name.trim().replace(/^v/, "") : "";
  if (!parseVersion(version)) throw new Error("The latest release has no usable version");
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(release.assets)) {
    for (const raw of release.assets) {
      if (!raw || typeof raw !== "object") continue;
      const asset = raw as Record<string, unknown>;
      if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") continue;
      if (!asset.browser_download_url.startsWith(DOWNLOAD_PREFIX)) continue;
      assets.push({ name: asset.name, url: asset.browser_download_url });
    }
  }
  return { version, assets };
}

export function checksumFor(sums: string, name: string): string | null {
  for (const line of String(sums).split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match && match[2] === name) return match[1].toLowerCase();
  }
  return null;
}

function directoryWritable(directory: string): boolean {
  try { accessSync(directory, constants.W_OK); return true; } catch { return false; }
}

export function currentAppImage(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.APPIMAGE;
  if (!raw) return null;
  try {
    const target = realpathSync(raw);
    return directoryWritable(dirname(target)) ? target : null;
  } catch { return null; }
}

export function relaunchArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const args = argv.filter((arg) => !arg.startsWith("--screenshot="));
  const appDir = env.APPDIR;
  if (appDir && !appDir.includes(".mount_") && !args.includes("--appimage-extract-and-run")) {
    args.push("--appimage-extract-and-run");
  }
  return args;
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface UpdateCheck {
  current: string;
  latest: string;
  available: boolean;
  canInstall: boolean;
  error?: string;
}

export interface InstallerTarget {
  /** Name of the release asset for this version, such as ModSync-Server-0.8.0-x64.exe. */
  assetName: (version: string) => string;
  /** Folder the verified installer is written to before it runs. */
  downloadDir: () => string;
}

export interface UpdateInstall {
  kind: "appimage" | "installer";
  path: string;
}

export class Updater {
  private readonly currentVersion: () => string;
  private readonly appImage: () => string | null;
  private readonly installer: InstallerTarget | null;
  private readonly fetch: FetchLike;
  private pending: Release | null = null;

  constructor({ currentVersion, appImage, installer, fetch }: {
    currentVersion: () => string;
    appImage?: () => string | null;
    installer?: InstallerTarget;
    fetch: FetchLike;
  }) {
    this.currentVersion = currentVersion;
    this.appImage = appImage ?? (() => null);
    this.installer = installer ?? null;
    this.fetch = fetch;
  }

  async check(): Promise<UpdateCheck> {
    const current = this.currentVersion();
    let response: Response;
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
    let json: unknown;
    try { json = await response.json(); } catch { throw new Error("GitHub sent unexpected release data"); }
    const release = parseRelease(json);
    const available = compareVersions(release.version, current) > 0;
    this.pending = available ? release : null;
    return {
      current,
      latest: release.version,
      available,
      canInstall: available && (this.installer !== null || this.appImage() !== null),
    };
  }

  async install(): Promise<UpdateInstall> {
    const release = this.pending;
    if (!release) throw new Error("Check for updates before installing one");

    if (this.installer) {
      const name = this.installer.assetName(release.version);
      const directory = this.installer.downloadDir();
      mkdirSync(directory, { recursive: true });
      const target = join(directory, name);
      await this.download(release, name, target, false);
      // Keep the release pending: if the installer cannot start, the console
      // can retry without checking GitHub again.
      return { kind: "installer", path: target };
    }

    const target = this.appImage();
    if (!target) throw new Error("This copy of ModSync cannot update itself");
    const name = appImageName(release.version);
    await this.download(release, name, target, true);
    this.pending = null;
    return { kind: "appimage", path: target };
  }

  private async download(release: Release, name: string, target: string, executable: boolean): Promise<void> {
    const asset = release.assets.find((entry) => entry.name === name);
    if (!asset) throw new Error(`The latest release does not include ${name}`);
    const checksums = release.assets.find((entry) => entry.name === CHECKSUMS_NAME);
    if (!checksums) throw new Error("The latest release is missing its checksums");

    let sums: string;
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
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        createWriteStream(part, executable ? { mode: 0o755 } : {}),
      );
      const actual = await sha256(part);
      if (actual !== expected) throw new Error("The downloaded update failed its checksum.");
      if (executable) chmodSync(part, 0o755);
      renameSync(part, target);
    } catch (error) {
      rmSync(part, { force: true });
      throw error;
    }
  }
}

export {
  RELEASES_PAGE,
  API_HEADERS,
};
