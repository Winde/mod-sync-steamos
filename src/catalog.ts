import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./util";
import { reviewKey } from "./reviews";
import type { ModReview } from "./reviews";
import type { ContentsItem, ContentsSummary } from "./types";

/**
 * The mod catalog.
 *
 * A pack is a snapshot of one working install. This catalog is the longer-lived
 * view: every mod seen in any pack, where it came from, which packs used it,
 * and the review that belongs to it. It is stored beside the console config so
 * it survives pack rebuilds and removal.
 */

export const CATALOG_SCHEMA = 1;
export const CATALOG_MAX_BUILDS = 50;
export const CATALOG_MAX_ALIASES = 24;
export const CATALOG_MAX_TEXT = 2000;

export interface CatalogBuild {
  packId: string;
  packName: string;
  packVersion: string;
  builtAt: string;
}

export interface CatalogStoredEntry {
  gameId: string;
  gameTitle: string;
  modId: string;
  name: string;
  version: string;
  author: string;
  source: string;
  installMethod: string;
  path: string;
  components?: number;
  loadAfter: string[];
  loadBefore: string[];
  active: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  aliases: string[];
  builds: CatalogBuild[];
}

export interface CatalogEntry extends CatalogStoredEntry {
  /** Packs in the current library that contain this mod right now. */
  usedBy: CatalogBuild[];
  /** True when at least one current pack contains the mod. */
  present: boolean;
  review: ModReview | null;
}

export interface CatalogGame {
  id: string;
  title: string;
  count: number;
}

export interface CatalogView {
  schema: 1;
  generatedAt: string;
  entries: CatalogEntry[];
  games: CatalogGame[];
  summary: {
    mods: number;
    games: number;
    packs: number;
    present: number;
    reviewed: number;
  };
}

export interface CatalogPackInput {
  id: string;
  name: string;
  version: string;
  gameId: string;
  gameTitle: string;
  builtAt: string;
  contents: ContentsSummary | null;
}

interface CatalogBook {
  schema: 1;
  entries: Record<string, CatalogStoredEntry>;
}

export interface CatalogStore {
  view: (
    packs: CatalogPackInput[],
    reviewFor?: (entry: CatalogStoredEntry) => ModReview | null,
  ) => CatalogView;
}

function emptyBook(): CatalogBook {
  return { schema: CATALOG_SCHEMA, entries: Object.create(null) as Record<string, CatalogStoredEntry> };
}

function trimText(value: unknown, max = CATALOG_MAX_TEXT): string {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function textArray(value: unknown, max = CATALOG_MAX_ALIASES): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const text = trimText(raw, 500);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function unique(values: Array<string | null | undefined>, max = CATALOG_MAX_ALIASES): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = trimText(value, 500);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeBuild(raw: unknown): CatalogBuild | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const packId = trimText(value.packId, 200);
  const packVersion = trimText(value.packVersion, 200);
  if (!packId || !packVersion) return null;
  return {
    packId,
    packName: trimText(value.packName, 200) || packId,
    packVersion,
    builtAt: trimText(value.builtAt, 80),
  };
}

function normalizeEntry(raw: unknown): CatalogStoredEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const gameId = trimText(value.gameId, 200);
  const modId = trimText(value.modId, 500);
  if (!gameId || !modId) return null;
  const builds: CatalogBuild[] = [];
  if (Array.isArray(value.builds)) {
    for (const item of value.builds) {
      const build = normalizeBuild(item);
      if (build) builds.push(build);
      if (builds.length >= CATALOG_MAX_BUILDS) break;
    }
  }
  const components = Number(value.components);
  return {
    gameId,
    gameTitle: trimText(value.gameTitle, 200) || gameId,
    modId,
    name: trimText(value.name, 500) || modId,
    version: trimText(value.version, 200),
    author: trimText(value.author, 500),
    source: trimText(value.source, 1000),
    installMethod: trimText(value.installMethod, 200),
    path: trimText(value.path, 1000),
    components: Number.isFinite(components) && components > 0 ? Math.trunc(components) : undefined,
    loadAfter: textArray(value.loadAfter),
    loadBefore: textArray(value.loadBefore),
    active: value.active !== false,
    firstSeenAt: trimText(value.firstSeenAt, 80),
    lastSeenAt: trimText(value.lastSeenAt, 80),
    aliases: textArray(value.aliases),
    builds,
  };
}

function readBook(file: string): CatalogBook {
  const book = emptyBook();
  try {
    const raw = readJson<Record<string, unknown>>(file);
    if (raw.schema !== CATALOG_SCHEMA) return book;
    if (!raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) return book;
    for (const [key, value] of Object.entries(raw.entries as Record<string, unknown>)) {
      const entry = normalizeEntry(value);
      if (entry) book.entries[key] = entry;
    }
  } catch {
    /* A missing or damaged catalog starts empty; packs refill it. */
  }
  return book;
}

function sameBuild(a: CatalogBuild, b: CatalogBuild): boolean {
  return a.packId === b.packId && a.packVersion === b.packVersion && a.builtAt === b.builtAt;
}

function sortedBuilds(builds: CatalogBuild[]): CatalogBuild[] {
  const out: CatalogBuild[] = [];
  for (const build of builds) {
    if (!out.some((candidate) => sameBuild(candidate, build))) out.push(build);
  }
  return out
    .sort((a, b) => (a.builtAt || "").localeCompare(b.builtAt || ""))
    .slice(-CATALOG_MAX_BUILDS);
}

function itemAliases(item: ContentsItem): string[] {
  return unique([item.id, item.label, item.path], CATALOG_MAX_ALIASES);
}

function itemModId(item: ContentsItem): string {
  return trimText(item.catalogId || item.id || item.label || item.path, 500);
}

function mergePrior(entry: CatalogStoredEntry, prior: CatalogStoredEntry, gameTitle: string): CatalogStoredEntry {
  return {
    ...entry,
    gameTitle: gameTitle || prior.gameTitle || entry.gameTitle,
    name: entry.name || prior.name,
    version: entry.version || prior.version,
    author: entry.author || prior.author,
    source: entry.source || prior.source,
    installMethod: entry.installMethod || prior.installMethod,
    path: entry.path || prior.path,
    components: entry.components ?? prior.components,
    loadAfter: entry.loadAfter.length ? entry.loadAfter : prior.loadAfter,
    loadBefore: entry.loadBefore.length ? entry.loadBefore : prior.loadBefore,
    firstSeenAt: prior.firstSeenAt || entry.firstSeenAt,
    lastSeenAt: (prior.lastSeenAt || "").localeCompare(entry.lastSeenAt || "") > 0
      ? prior.lastSeenAt
      : entry.lastSeenAt,
    aliases: unique([...prior.aliases, prior.modId, ...entry.aliases, entry.modId].filter((value) => value !== entry.modId)),
    builds: sortedBuilds([...prior.builds, ...entry.builds]),
  };
}

function containsIdentifier(entry: CatalogStoredEntry, ids: Set<string>): boolean {
  if (ids.has(entry.modId)) return true;
  return entry.aliases.some((alias) => ids.has(alias));
}

function latestCurrentBuild(entry: CatalogStoredEntry, pack: CatalogPackInput): CatalogBuild {
  const matches = entry.builds.filter((build) => build.packId === pack.id);
  const latest = matches.sort((a, b) => (a.builtAt || "").localeCompare(b.builtAt || "")).at(-1);
  // The current pack owns the display name and version even when it was
  // renamed in the library after its last build.
  return {
    packId: pack.id,
    packName: pack.name || latest?.packName || pack.id,
    packVersion: pack.version || latest?.packVersion || "",
    builtAt: pack.builtAt || latest?.builtAt || "",
  };
}

/**
 * Record one pack's contents. A rebuild replaces the pack directory, so the
 * build reference is keyed by pack id, version, and build time; the same pack
 * id with a new version adds history rather than overwriting it.
 */
function recordPack(book: CatalogBook, input: CatalogPackInput, now: string): boolean {
  const items = input.contents?.items || [];
  if (!items.length) return false;
  let dirty = false;
  const gameId = trimText(input.gameId, 200) || "unknown";
  const gameTitle = trimText(input.gameTitle, 200) || gameId;
  const builtAt = input.builtAt || now;
  const build: CatalogBuild = {
    packId: input.id,
    packName: input.name,
    packVersion: input.version,
    builtAt,
  };

  for (const item of items) {
    const modId = itemModId(item);
    if (!modId) continue;
    const aliases = itemAliases(item);
    const key = reviewKey(gameId, modId);

    let prior: CatalogStoredEntry | null = book.entries[key] || null;
    let priorKey = key;
    if (!prior) {
      // A driver can start writing a better stable id for a mod that already
      // exists under its old label. Merge only when exactly one old entry
      // shares an alias, so duplicate display names are left alone.
      const candidates = Object.entries(book.entries).filter(([candidateKey, candidate]) => {
        if (candidateKey === key || candidate.gameId !== gameId) return false;
        return candidate.aliases.some((alias) => aliases.includes(alias));
      });
      if (candidates.length === 1) {
        priorKey = candidates[0][0];
        prior = candidates[0][1];
      }
    }

    const base: CatalogStoredEntry = {
      gameId,
      gameTitle,
      modId,
      name: trimText(item.label, 500) || modId,
      version: trimText(item.version, 200),
      author: trimText(item.author, 500),
      source: trimText(item.source, 1000),
      installMethod: trimText(item.installMethod, 200),
      path: trimText(item.path, 1000),
      components: item.components && item.components > 0 ? Math.trunc(item.components) : undefined,
      loadAfter: textArray(item.loadAfter),
      loadBefore: textArray(item.loadBefore),
      active: item.active !== false,
      firstSeenAt: now,
      lastSeenAt: builtAt || now,
      aliases: unique([...aliases, ...(prior?.aliases || []), prior?.modId].filter((value) => value !== modId)),
      builds: [build],
    };
    const entry = prior ? mergePrior(base, prior, gameTitle) : base;
    if (!entry.builds.some((candidate) => sameBuild(candidate, build))) {
      entry.builds = sortedBuilds([...entry.builds, build]);
      entry.lastSeenAt = builtAt || now;
    }

    const before = prior ? JSON.stringify(prior) : "";
    if (JSON.stringify(entry) !== before || priorKey !== key) dirty = true;
    if (priorKey !== key) delete book.entries[priorKey];
    book.entries[key] = entry;
  }
  return dirty;
}

export function createCatalogStore(file: string): CatalogStore {
  const filePath = path.resolve(file);
  let cache: CatalogBook | null = null;

  function load(): CatalogBook {
    if (!cache) cache = readBook(filePath);
    return cache;
  }

  function save(book: CatalogBook): void {
    if (!Object.keys(book.entries).length) {
      fs.rmSync(filePath, { force: true });
      return;
    }
    writeJson(filePath, book);
  }

  return {
    view(packs, reviewFor) {
      const book = load();
      const now = new Date().toISOString();
      let dirty = false;
      for (const pack of packs) {
        if (recordPack(book, pack, now)) dirty = true;
      }
      if (dirty) save(book);

      const packIds = packs.map((pack) => ({
        pack,
        ids: new Set<string>((pack.contents?.items || []).flatMap((item) => {
          const modId = itemModId(item);
          return [modId, ...itemAliases(item)].filter(Boolean);
        })),
      }));

      const entries: CatalogEntry[] = Object.values(book.entries).map((entry) => {
        const usedBy = packIds
          .filter(({ ids }) => containsIdentifier(entry, ids))
          .map(({ pack }) => latestCurrentBuild(entry, pack));
        return {
          ...entry,
          builds: sortedBuilds(entry.builds),
          usedBy,
          present: usedBy.length > 0,
          review: reviewFor ? reviewFor(entry) : null,
        };
      });

      entries.sort((a, b) => a.gameTitle.localeCompare(b.gameTitle)
        || a.name.localeCompare(b.name)
        || a.modId.localeCompare(b.modId));

      const games = new Map<string, CatalogGame>();
      const usedPacks = new Set<string>();
      let reviewed = 0;
      for (const entry of entries) {
        const game = games.get(entry.gameId) || { id: entry.gameId, title: entry.gameTitle, count: 0 };
        game.count++;
        games.set(entry.gameId, game);
        for (const build of entry.usedBy) usedPacks.add(build.packId);
        if (entry.review && (entry.review.rating || entry.review.body.trim())) reviewed++;
      }

      return {
        schema: CATALOG_SCHEMA,
        generatedAt: now,
        entries,
        games: [...games.values()].sort((a, b) => a.title.localeCompare(b.title)),
        summary: {
          mods: entries.length,
          games: games.size,
          packs: usedPacks.size,
          present: entries.filter((entry) => entry.present).length,
          reviewed,
        },
      };
    },
  };
}
