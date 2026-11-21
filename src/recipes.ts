import fs from "node:fs";
import path from "node:path";
import { readJson, errorMessage } from "./util";
import { validateNotes, validatePreconditions } from "./preconditions";
import { validatePlatforms } from "./paths";
import { projectRoot } from "./root";
import type { Recipe } from "./types";

const recipesDir = path.join(projectRoot, "recipes");

export function validateRecipe(recipe: unknown): Recipe {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) throw new Error("recipe: not an object");
  const r = recipe as Record<string, unknown>;
  if (r.schema !== 1) throw new Error("recipe: schema must be 1");
  for (const key of ["id", "game", "name", "modId"]) {
    if (typeof r[key] !== "string" || !r[key]) throw new Error(`recipe: missing ${key}`);
  }
  for (const key of ["description", "artId", "saveFile", "version"]) {
    if (r[key] != null && typeof r[key] !== "string") throw new Error(`recipe: ${key} must be a string`);
  }
  validateNotes(r.notes);
  validatePreconditions(r.preconditions);
  validatePlatforms(r.platforms, "recipe.platforms");
  return r as unknown as Recipe;
}

export function recipeFile(ref: unknown): string {
  if (typeof ref !== "string" || !ref) throw new Error("recipe: id or path required");
  if (ref.endsWith(".json") || ref.includes("/") || ref.includes("\\")) return path.resolve(ref);
  return path.join(recipesDir, `${ref}.json`);
}

export function loadRecipe(ref: string): Recipe {
  const file = recipeFile(ref);
  if (!fs.existsSync(file)) throw new Error(`recipe not found: ${file}`);
  return validateRecipe(readJson(file));
}

export function listRecipes(): Recipe[] {
  if (!fs.existsSync(recipesDir)) return [];
  const out: Recipe[] = [];
  for (const entry of fs.readdirSync(recipesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      out.push(loadRecipe(path.join(recipesDir, entry.name)));
    } catch (err) {
      console.error(`[recipes] ${entry.name}: ${errorMessage(err)}`);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export { recipesDir };
