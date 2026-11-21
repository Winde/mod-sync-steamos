import fs from "node:fs";
import path from "node:path";
import { ensureDir, modeFor } from "../util";
import type { ContentsInput, ContentsSummary, Variant } from "../types";

export const TYPE = "me3";
export const TEMPLATE = "loaders/me3.sh";
export const PROFILE_PATTERN = "profiles/{mod}-{version}.me3";

const TOOL_PLATFORMS: Record<string, Variant[]> = {
  "me3-linux/": ["linux-proton"],
  "me3-win/": ["windows"],
};

interface Me3Block {
  type: string;
  [key: string]: unknown;
}

export function profileFile(source: string, modId: string, version: string): string {
  return path.join(source, "profiles", `${modId}-${version}.me3`);
}

export function parseMe3Profile(text: string): { packages: Me3Block[]; natives: Me3Block[] } {
  const packages: Me3Block[] = [];
  const natives: Me3Block[] = [];
  let block: Me3Block | null = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const section = /^\[\[(.+)\]\]$/.exec(line);
    if (section) {
      block = { type: section[1] };
      if (section[1] === "packages") packages.push(block);
      else if (section[1] === "natives") natives.push(block);
      else block = null;
      continue;
    }
    if (line.startsWith("[")) { block = null; continue; }
    if (!block) continue;
    const kv = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const rawValue = kv[2].trim();
    let value: string | boolean | string[] = rawValue;
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
      value = rawValue.slice(1, -1);
    } else if (rawValue === "true") value = true;
    else if (rawValue === "false") value = false;
    else if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      value = rawValue.slice(1, -1).split(",").map((v) => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    block[kv[1]] = value;
  }
  return { packages, natives };
}

export function contentsFor({ recipe, source, version }: ContentsInput): ContentsSummary {
  const parsed = parseMe3Profile(fs.readFileSync(profileFile(source, recipe.modId, version), "utf8"));
  const packages = parsed.packages.map((entry, index) => {
    const entryPath = typeof entry.path === "string" ? entry.path : "";
    return {
      path: entryPath,
      label: index === 0 ? recipe.name : (entryPath.split("/").filter(Boolean).pop() || ""),
      enabled: entry.enabled !== false,
      loadAfter: entry.load_after || [],
      loadBefore: entry.load_before || [],
    };
  });
  return {
    source: "me3 profile",
    generatedAt: new Date().toISOString(),
    count: packages.length,
    itemsLabel: "Included packages",
    items: packages.map((entry) => ({
      label: entry.label,
      path: entry.path,
      active: entry.enabled,
    })),
    inactive: [],
  };
}

function requirePath(p: string, label: string): void {
  if (!fs.existsSync(p)) throw new Error(`${label} not found: ${p}`);
}

function sameFile(a: string, b: string): boolean {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
  if (fs.statSync(a).size !== fs.statSync(b).size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/**
 * Keep one copy of the Windows host binaries. The Linux me3 launcher can use
 * the Windows distribution's bin directory, so the duplicate win64 tree is
 * only kept when the two downloads are not byte-identical.
 */
export function copyRuntime(me3Linux: string, me3Win: string, toolsDst: string): string {
  const linuxLoader = path.join(me3Linux, "bin", "me3");
  requirePath(linuxLoader, "me3 Linux loader");
  for (const name of ["me3.exe", "me3-launcher.exe", "me3_mod_host.dll"]) {
    requirePath(path.join(me3Win, "bin", name), `me3 Windows ${name}`);
  }

  const linuxBinDst = path.join(toolsDst, "me3-linux", "bin");
  ensureDir(linuxBinDst);
  fs.copyFileSync(linuxLoader, path.join(linuxBinDst, "me3"));

  const winBinSrc = path.join(me3Win, "bin");
  const winBinDst = path.join(toolsDst, "me3-win", "bin");
  ensureDir(winBinDst);
  for (const name of ["me3.exe", "me3-launcher.exe", "me3_mod_host.dll"]) {
    fs.copyFileSync(path.join(winBinSrc, name), path.join(winBinDst, name));
  }

  const linuxHost = path.join(me3Linux, "bin", "win64");
  const sameHost = ["me3-launcher.exe", "me3_mod_host.dll"].every(
    (name) => sameFile(path.join(linuxHost, name), path.join(winBinSrc, name)),
  );
  let windowsBinaries = "tools/me3-win/bin";
  if (!sameHost && fs.existsSync(linuxHost)) {
    fs.cpSync(linuxHost, path.join(toolsDst, "me3-linux", "bin", "win64"), { recursive: true });
    windowsBinaries = "tools/me3-linux/bin/win64";
  }

  const licenseDst = path.join(toolsDst, "me3");
  ensureDir(licenseDst);
  for (const name of ["LICENSE-MIT", "LICENSE-APACHE"]) {
    const file = path.join(me3Win, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(licenseDst, name));
  }
  return windowsBinaries;
}

export function platformsForTool(rel: string, windowsBinaries: string): Variant[] | null {
  if (rel.startsWith("me3-win/") && windowsBinaries === "tools/me3-win/bin") {
    // Linux me3 needs the launcher and host DLL, not the Windows CLI.
    return rel.endsWith("/me3.exe") ? ["windows"] : ["windows", "linux-proton"];
  }
  const prefix = Object.keys(TOOL_PLATFORMS).find((candidate) => rel.startsWith(candidate));
  return prefix ? TOOL_PLATFORMS[prefix] : null;
}

export function modeForTarget(targetRel: string): string {
  return targetRel === "tools/me3-linux/bin/me3" ? "755" : modeFor(targetRel);
}
