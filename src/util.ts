import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const fsp = fs.promises;

export interface WalkEntry {
  abs: string;
  rel: string;
  size: number;
}

export interface LanAddress {
  name: string;
  address: string;
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function readJson<T = unknown>(p: string): T {
  const text = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text) as T;
}

export function writeJson(p: string, value: unknown): void {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + "\n");
}

export function readText(p: string, fallback = ""): string {
  try { return fs.readFileSync(p, "utf8"); } catch { return fallback; }
}

export function writeText(p: string, text: string, mode?: number): void {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, text, "utf8");
  if (mode != null) fs.chmodSync(p, mode);
}

export function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(p);
    s.on("data", (d) => h.update(d));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

export function walkFiles(root: string, base = root): WalkEntry[] {
  const out: WalkEntry[] = [];
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

export function safeJoin(root: string, rel: string): string {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) throw new Error("invalid path");
  const norm = rel.replace(/\\/g, "/");
  if (path.posix.isAbsolute(norm)) throw new Error("absolute path not allowed");
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, norm);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new Error("path escapes root");
  return abs;
}

export function relPosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function randomToken(): string {
  return crypto.randomBytes(12).toString("hex");
}

export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) {
        out.push({ name, address: a.address });
      }
    }
  }
  return out;
}

export function detectLanIp(): string {
  const candidates = lanAddresses();
  const preferred = candidates.find((c) => c.address.startsWith("192.168."))
    || candidates.find((c) => c.address.startsWith("192."))
    || candidates.find((c) => c.address.startsWith("10."))
    || candidates[0];
  return preferred ? preferred.address : "127.0.0.1";
}

export function isGameRunning(processNames: string | string[] | null | undefined): boolean {
  const names = (Array.isArray(processNames) ? processNames : [processNames]).filter(Boolean) as string[];
  for (const processName of names) {
    try {
      if (process.platform === "win32") {
        const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${processName}`], { encoding: "utf8" });
        if (out.toLowerCase().includes(processName.toLowerCase())) return true;
      } else {
        execFileSync("pgrep", ["-x", processName], { stdio: "ignore" });
        return true;
      }
    } catch {
      // Try the next configured process name.
    }
  }
  return false;
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  const results = new Array<R>(items.length);
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

export function materialize(src: string, dst: string, link = true): "link" | "copy" {
  ensureDir(path.dirname(dst));
  if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
  if (link) {
    try {
      fs.linkSync(src, dst);
      return "link";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(code)) throw err;
    }
  }
  fs.copyFileSync(src, dst);
  return "copy";
}

export function modeFor(rel: string): "755" | "644" {
  return rel.replace(/\\/g, "/").endsWith(".sh") ? "755" : "644";
}

export function tailText(text: string, lines = 200): string {
  const arr = text.split(/\r?\n/);
  return arr.slice(Math.max(0, arr.length - lines)).join("\n");
}

export function tailFile(p: string, lines = 200): string {
  return tailText(readText(p), lines);
}

export function freeBytes(dir: string): number | null {
  let p = path.resolve(dir);
  while (p) {
    try {
      const s = fs.statfsSync(p);
      return Number(s.bavail) * Number(s.bsize);
    } catch { /* walk up to a parent that exists */ }
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return null;
}

export async function fetchJson<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return (await res.json()) as T;
}

export async function fetchToFile(url: string, dest: string, options: RequestInit = {}): Promise<void> {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  if (!res.body) throw new Error(`HTTP ${res.status} ${url}: empty body`);
  ensureDir(path.dirname(dest));
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), fs.createWriteStream(dest));
}

export { fsp };
