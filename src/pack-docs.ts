import fs from "node:fs";
import path from "node:path";
import { loadPack } from "./manifest";
import { readPackLibrary } from "./pack-library";
import { formatBytes, writeText } from "./util";
import type { CatalogEntry } from "./catalog";
import type { ContentsItem, FilesDoc, Note, Pack } from "./types";

/**
 * Human-readable documentation generated from a frozen pack and the mod
 * catalog. The pack copy (`DOCS.md`) travels with the pack folder and is safe
 * to keep beside files.json; it is generated, not authored.
 */

export const PACK_DOC_FILE = "DOCS.md";

export function packDocFile(packRoot: string): string {
  return path.join(packRoot, PACK_DOC_FILE);
}

function cell(value: unknown): string {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function inlineCode(value: unknown): string {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "";
  return `\`${text.replace(/`/g, "\\`")}\``;
}

function dateLabel(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

interface NormalizedNote {
  title: string;
  body: string;
  tone: string;
}

function normalizedNotes(notes: Note[] | undefined): NormalizedNote[] {
  const out: NormalizedNote[] = [];
  for (const note of notes || []) {
    if (typeof note === "string") {
      const body = note.trim();
      if (body) out.push({ title: "", body, tone: "" });
      continue;
    }
    const body = String(note.body || "").trim();
    if (!body) continue;
    out.push({
      title: String(note.title || "").trim(),
      body,
      tone: String(note.tone || "").trim(),
    });
  }
  return out;
}

function methodLabel(item: ContentsItem): string {
  const method = item.installMethod || "";
  if (!method) return "";
  return item.components && item.components > 1 ? `${method} (${item.components} components)` : method;
}

function platformList(pack: Pack, files: FilesDoc): string[] {
  const out = new Set<string>(Object.keys(pack.platforms || {}));
  for (const file of files.files) {
    for (const platform of file.platforms || []) out.add(platform);
  }
  return [...out].sort();
}

export interface PackDocOptions {
  builtAt?: string;
  libraryNotes?: string;
  generatedAt?: string;
  /** Display name from the console library; defaults to pack.name. */
  title?: string;
}

export function renderPackDoc(pack: Pack, files: FilesDoc, options: PackDocOptions = {}): string {
  const generatedAt = dateLabel(options.generatedAt || new Date().toISOString()) || new Date().toISOString();
  const builtAt = dateLabel(options.builtAt || "");
  const title = options.title || pack.name || pack.id;
  const game = pack.game.title || pack.game.id;
  const gameVersion = [pack.game.version, pack.game.build ? `build ${pack.game.build}` : ""].filter(Boolean).join(", ");
  const platforms = platformList(pack, files);
  const totalBytes = files.files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  const contents = pack.contents || null;
  const items = (contents?.items || []).filter((item) => item.label || item.path);
  const inactive = contents?.inactive || [];
  const notes = normalizedNotes(pack.notes);
  const libraryNotes = String(options.libraryNotes || "").trim();
  if (libraryNotes) notes.push({ title: "Server notes", body: libraryNotes, tone: "info" });
  const preconditions = pack.preconditions || [];

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  if (pack.description) {
    lines.push(pack.description.trim());
    lines.push("");
  }
  lines.push("> Generated pack documentation. This pack contains mods only; the base game and saves are not included.");
  lines.push("");
  lines.push("## Pack");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Pack id | ${inlineCode(pack.id)} |`);
  lines.push(`| Game | ${cell(game)}${gameVersion ? ` (${cell(gameVersion)})` : ""} |`);
  lines.push(`| Pack version | ${cell(pack.mod.version)} |`);
  lines.push(`| Recipe | ${inlineCode(pack.recipe || pack.id)} |`);
  lines.push(`| Platforms | ${platforms.length ? platforms.map(cell).join(", ") : "all"} |`);
  lines.push(`| Files | ${files.files.length} |`);
  lines.push(`| Size | ${formatBytes(totalBytes)} |`);
  if (builtAt) lines.push(`| Built | ${cell(builtAt)} |`);
  lines.push(`| Generated | ${cell(generatedAt)} |`);
  lines.push("");

  lines.push("## Mods");
  lines.push("");
  if (contents?.source) {
    lines.push(`Source: ${inlineCode(contents.source)}${contents.generatedAt ? ` · recorded ${dateLabel(contents.generatedAt)}` : ""}`);
    lines.push("");
  }
  if (items.length) {
    const hasVersion = items.some((item) => item.version);
    const hasMethod = items.some((item) => methodLabel(item));
    const hasAuthor = items.some((item) => item.author);
    const hasSource = items.some((item) => item.source);
    const headers = ["#", "Mod"];
    if (hasVersion) headers.push("Version");
    if (hasMethod) headers.push("Method");
    if (hasAuthor) headers.push("Author");
    if (hasSource) headers.push("Source");
    headers.push("Path");
    lines.push(`| ${headers.join(" | ")} |`);
    lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
    items.forEach((item, index) => {
      const values: string[] = [String(index + 1), `${cell(item.label || item.path || "Unnamed item")}${item.active === false ? " (inactive)" : ""}`];
      if (hasVersion) values.push(cell(item.version || ""));
      if (hasMethod) values.push(cell(methodLabel(item)));
      if (hasAuthor) values.push(cell(item.author || ""));
      if (hasSource) values.push(cell(item.source || ""));
      values.push(inlineCode(item.path || ""));
      lines.push(`| ${values.join(" | ")} |`);
    });
    lines.push("");

    const order = items.filter((item) => (item.loadAfter || []).length || (item.loadBefore || []).length);
    if (order.length) {
      lines.push("### Load order hints");
      lines.push("");
      for (const item of order) {
        const hints: string[] = [];
        if (item.loadAfter?.length) hints.push(`after ${item.loadAfter.map(cell).join(", ")}`);
        if (item.loadBefore?.length) hints.push(`before ${item.loadBefore.map(cell).join(", ")}`);
        lines.push(`- **${cell(item.label || item.path || "Unnamed item")}** — ${hints.join("; ")}`);
      }
      lines.push("");
    }
  } else {
    lines.push("No item list was recorded for this build. Rebuild the pack or run the contents refresh to add one.");
    lines.push("");
  }
  if (inactive.length) {
    lines.push("### Inactive files");
    lines.push("");
    lines.push("These files were present in the working install but are not referenced by the pack's active list.");
    lines.push("");
    for (const name of inactive) lines.push(`- ${inlineCode(name)}`);
    lines.push("");
  }

  if (notes.length) {
    lines.push("## Notes");
    lines.push("");
    for (const note of notes) {
      lines.push(`### ${note.title || "Note"}`);
      lines.push("");
      if (note.tone && note.tone !== "info") lines.push(`**Tone:** ${cell(note.tone)}`);
      lines.push(note.body);
      lines.push("");
    }
  }

  if (preconditions.length) {
    lines.push("## Preconditions");
    lines.push("");
    lines.push("| Id | Type | Required | Check |");
    lines.push("| --- | --- | --- | --- |");
    for (const check of preconditions) {
      lines.push(`| ${cell(check.id)} | ${cell(check.type)} | ${check.required ? "yes" : "no"} | ${cell(check.title || check.hint || "")} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(`Generated by ModSync from ${inlineCode("pack.json")} and ${inlineCode(pack.files)}. Do not edit by hand; rebuild or run the docs refresh instead.`);
  lines.push("");
  return lines.join("\n");
}

export function writePackDoc(packRoot: string, options: PackDocOptions = {}): string {
  const { pack, files } = loadPack(packRoot);
  const library = readPackLibrary(packRoot);
  const packFile = path.join(packRoot, "pack.json");
  let builtAt = options.builtAt || "";
  if (!builtAt) {
    try { builtAt = fs.statSync(packFile).mtime.toISOString(); } catch { builtAt = ""; }
  }
  const markdown = renderPackDoc(pack, files, {
    ...options,
    title: options.title || library?.name || pack.name,
    builtAt,
    libraryNotes: options.libraryNotes ?? library?.notes ?? "",
  });
  writeText(packDocFile(packRoot), markdown);
  return markdown;
}

function reviewStars(rating: number): string {
  if (!rating) return "—";
  const filled = "★".repeat(Math.max(0, Math.min(5, rating)));
  const empty = "☆".repeat(Math.max(0, 5 - rating));
  return `${filled}${empty} (${rating}/5)`;
}

function packUsage(entry: CatalogEntry): string {
  if (!entry.usedBy.length) return "Not in a current pack";
  return entry.usedBy.map((build) => `${build.packName} ${build.packVersion}`.trim()).join(", ");
}

export interface CatalogDocOptions {
  generatedAt?: string;
}

/**
 * A portable markdown export of the catalog. It intentionally uses the same
 * information the Server console shows, including per-mod reviews and current
 * pack usage.
 */
export function renderCatalogDoc(entries: CatalogEntry[], options: CatalogDocOptions = {}): string {
  const generatedAt = dateLabel(options.generatedAt || new Date().toISOString()) || new Date().toISOString();
  const lines: string[] = [];
  lines.push("# Mod catalog");
  lines.push("");
  lines.push(`Generated ${cell(generatedAt)} by ModSync.`);
  lines.push("");
  const games = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const group = games.get(entry.gameTitle || entry.gameId) || [];
    group.push(entry);
    games.set(entry.gameTitle || entry.gameId, group);
  }
  const present = entries.filter((entry) => entry.present).length;
  const reviewed = entries.filter((entry) => entry.review && (entry.review.rating || entry.review.body.trim())).length;
  lines.push(`**${entries.length}** mods across **${games.size}** game${games.size === 1 ? "" : "s"} · **${present}** in a current pack · **${reviewed}** reviewed.`);
  lines.push("");

  for (const [game, group] of [...games.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${game}`);
    lines.push("");
    lines.push("| Mod | Version | Method | Author | Source | Packs | Rating |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const entry of group.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`| ${cell(entry.name)} | ${cell(entry.version)} | ${cell(entry.installMethod)} | ${cell(entry.author)} | ${cell(entry.source)} | ${cell(packUsage(entry))} | ${cell(reviewStars(entry.review?.rating || 0))} |`);
    }
    lines.push("");

    const reviewedEntries = group.filter((entry) => entry.review?.body.trim());
    if (reviewedEntries.length) {
      lines.push("### Notes");
      lines.push("");
      for (const entry of reviewedEntries) {
        lines.push(`- **${cell(entry.name)}** — ${cell(entry.review?.body || "")}`);
      }
      lines.push("");
    }

    const ordered = group.filter((entry) => entry.loadAfter.length || entry.loadBefore.length);
    if (ordered.length) {
      lines.push("### Load order hints");
      lines.push("");
      for (const entry of ordered) {
        const hints: string[] = [];
        if (entry.loadAfter.length) hints.push(`after ${entry.loadAfter.map(cell).join(", ")}`);
        if (entry.loadBefore.length) hints.push(`before ${entry.loadBefore.map(cell).join(", ")}`);
        lines.push(`- **${cell(entry.name)}** — ${hints.join("; ")}`);
      }
      lines.push("");
    }
  }

  const historical = entries.filter((entry) => !entry.present);
  if (historical.length) {
    lines.push("## No longer in a current pack");
    lines.push("");
    for (const entry of historical.sort((a, b) => a.name.localeCompare(b.name))) {
      const last = entry.builds.at(-1);
      const detail = last ? `last seen in ${last.packName} ${last.packVersion}${last.builtAt ? ` on ${dateLabel(last.builtAt)}` : ""}` : "no build recorded";
      lines.push(`- **${cell(entry.name)}** (${cell(entry.gameTitle)}) — ${detail}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("Generated by ModSync. Reviews belong to the mod, not to one pack build.");
  lines.push("");
  return lines.join("\n");
}
