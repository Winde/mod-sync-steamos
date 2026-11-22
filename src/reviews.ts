import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./util";

/**
 * Mod reviews kept apart from the pack folders.
 *
 * A review belongs to the game + mod pair, not to one pack build, so rebuilding
 * a pack or removing it from the library keeps the review. The console stores
 * them in its own `reviews.json` beside the console config.
 */

export const REVIEW_BODY_MAX = 4000;
export const REVIEW_RATING_MAX = 5;
export const REVIEW_ID_MAX = 200;

export interface ModReview {
  gameId: string;
  modId: string;
  rating: number;
  body: string;
  updatedAt: string;
}

export interface ReviewBook {
  schema: 1;
  reviews: Record<string, ModReview>;
}

export interface ReviewInput {
  gameId: unknown;
  modId: unknown;
  rating: unknown;
  body: unknown;
}

export interface ReviewStore {
  get: (gameId: string, modId: string) => ModReview | null;
  set: (input: ReviewInput) => ModReview | null;
  list: () => Record<string, ModReview>;
}

/** Reviews are indexed by game + mod so every build of a mod shares one. */
export function reviewKey(gameId: string, modId: string): string {
  return `g:${encodeURIComponent(gameId)}::m:${encodeURIComponent(modId)}`;
}

function normalizeId(value: unknown, label: string): string {
  const id = String(value == null ? "" : value).trim();
  if (!id) throw new Error(`${label} is required.`);
  if (id.length > REVIEW_ID_MAX) throw new Error(`${label} is too long.`);
  return id;
}

function normalizeRating(value: unknown): number {
  const rating = Number(value == null ? 0 : value);
  if (!Number.isInteger(rating) || rating < 0 || rating > REVIEW_RATING_MAX) {
    throw new Error(`Rating must be a whole number from 0 to ${REVIEW_RATING_MAX}.`);
  }
  return rating;
}

function normalizeBody(value: unknown): string {
  const body = String(value == null ? "" : value).trim();
  if (body.length > REVIEW_BODY_MAX) {
    throw new Error(`Review must be at most ${REVIEW_BODY_MAX} characters.`);
  }
  return body;
}

function emptyBook(): ReviewBook {
  return { schema: 1, reviews: Object.create(null) as Record<string, ModReview> };
}

function readBook(file: string): ReviewBook {
  const book = emptyBook();
  try {
    const raw = readJson<Record<string, unknown>>(file);
    const reviews = raw.reviews;
    if (!reviews || typeof reviews !== "object" || Array.isArray(reviews)) return book;
    for (const [key, value] of Object.entries(reviews as Record<string, unknown>)) {
      if (!key || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const rating = Number(entry.rating);
      const body = typeof entry.body === "string" ? entry.body : "";
      if (!Number.isInteger(rating) || rating < 0 || rating > REVIEW_RATING_MAX) continue;
      if (!rating && !body.trim()) continue;
      book.reviews[key] = {
        gameId: typeof entry.gameId === "string" ? entry.gameId : "",
        modId: typeof entry.modId === "string" ? entry.modId : "",
        rating,
        body,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
      };
    }
  } catch { /* a missing or damaged review file starts empty */ }
  return book;
}

export function createReviewStore(file: string): ReviewStore {
  const filePath = path.resolve(file);
  let cache: ReviewBook | null = null;

  function load(): ReviewBook {
    if (!cache) cache = readBook(filePath);
    return cache;
  }

  function save(book: ReviewBook): void {
    if (!Object.keys(book.reviews).length) {
      fs.rmSync(filePath, { force: true });
      return;
    }
    writeJson(filePath, book);
  }

  return {
    get(gameId, modId) {
      const key = reviewKey(String(gameId || ""), String(modId || ""));
      return load().reviews[key] || null;
    },
    set(input) {
      const gameId = normalizeId(input.gameId, "Game id");
      const modId = normalizeId(input.modId, "Mod id");
      const rating = normalizeRating(input.rating);
      const body = normalizeBody(input.body);
      const key = reviewKey(gameId, modId);
      const book = load();
      if (!rating && !body) {
        delete book.reviews[key];
        save(book);
        return null;
      }
      const review: ModReview = {
        gameId,
        modId,
        rating,
        body,
        updatedAt: new Date().toISOString(),
      };
      book.reviews[key] = review;
      save(book);
      return review;
    },
    list() {
      return { ...load().reviews };
    },
  };
}
