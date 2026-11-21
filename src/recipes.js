const fs = require("node:fs");
const path = require("node:path");
const { readJson } = require("./util");
const { validateNotes, validatePreconditions } = require("./preconditions");

const recipesDir = path.resolve(__dirname, "..", "recipes");

function validateRecipe(recipe) {
  if (!recipe || typeof recipe !== "object") throw new Error("recipe: not an object");
  if (recipe.schema !== 1) throw new Error("recipe: schema must be 1");
  for (const key of ["id", "game", "name", "modId"]) {
    if (typeof recipe[key] !== "string" || !recipe[key]) throw new Error(`recipe: missing ${key}`);
  }
  for (const key of ["description", "artId", "saveFile", "version"]) {
    if (recipe[key] != null && typeof recipe[key] !== "string") throw new Error(`recipe: ${key} must be a string`);
  }
  validateNotes(recipe.notes);
  validatePreconditions(recipe.preconditions);
  return recipe;
}

function recipeFile(ref) {
  if (typeof ref !== "string" || !ref) throw new Error("recipe: id or path required");
  if (ref.endsWith(".json") || ref.includes("/") || ref.includes("\\")) return path.resolve(ref);
  return path.join(recipesDir, `${ref}.json`);
}

function loadRecipe(ref) {
  const file = recipeFile(ref);
  if (!fs.existsSync(file)) throw new Error(`recipe not found: ${file}`);
  return validateRecipe(readJson(file));
}

function listRecipes() {
  if (!fs.existsSync(recipesDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(recipesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try { out.push(loadRecipe(path.join(recipesDir, entry.name))); } catch (err) {
      console.error(`[recipes] ${entry.name}: ${err.message}`);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { recipesDir, validateRecipe, loadRecipe, listRecipes, recipeFile };
