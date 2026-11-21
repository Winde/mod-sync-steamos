import { execFileSync } from "node:child_process";

/**
 * Thin `tar` wrapper. The project uses the system tar for the large,
 * many-small-files payload: Windows 10+ and SteamOS both ship a compatible
 * bsdtar/GNU tar, and one archive avoids tens of thousands of HTTP requests.
 */

function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  throw new Error(`tar failed: ${message}`);
}

export function runTar(args: string[]): void {
  try {
    execFileSync("tar", args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    fail(err);
  }
}

export function listTarEntries(archive: string): string[] {
  let text: string;
  try {
    text = execFileSync("tar", ["-tzf", archive], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    fail(err);
  }
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function validateTarEntries(entries: string[], allowedTop: string[]): void {
  const allowed = new Set(allowedTop);
  for (const raw of entries) {
    const name = raw.replace(/\/+$/, "");
    if (!name) continue;
    if (name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
      throw new Error(`Unsafe path in pack archive: ${raw}`);
    }
    const top = name.split("/")[0];
    if (!allowed.has(top)) throw new Error(`Unexpected path in pack archive: ${raw}`);
  }
}

export function extractTar(archive: string, dest: string): void {
  runTar(["-xzf", archive, "-C", dest]);
}
