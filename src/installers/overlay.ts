import fs from "node:fs";
import path from "node:path";
import {
  ensureDir, materialize, readJson, writeJson, safeJoin, isGameRunning,
} from "../util";

/**
 * Reversible writes into game-owned directories.
 *
 * The overlay records every path it adds and every original file it replaces,
 * all relative to named roots (for example `data` and `game`). A later update,
 * rollback, or uninstall can remove the additions and restore the backups
 * without knowing which game produced them.
 */

export interface OverlayRoots {
  [scope: string]: string | undefined;
}

export interface OverlayFile {
  scope: string;
  rel: string;
}

export interface OverlayBackup extends OverlayFile {}

export interface OverlayState {
  packId: string;
  version: string;
  platform: string;
  roots: OverlayRoots;
  files: OverlayFile[];
  backups: OverlayBackup[];
  skipped: string[];
}

export interface OverlayPlan {
  ok: boolean;
  errors: string[];
  warnings: string[];
  actions: string[];
}

export function stateFile(packRoot: string): string {
  return path.join(packRoot, "applied.json");
}

export function readState(packRoot: string): OverlayState | null {
  try { return readJson<OverlayState>(stateFile(packRoot)); } catch { return null; }
}

export function writeState(packRoot: string, state: OverlayState): void {
  writeJson(stateFile(packRoot), state);
}

export function createState({
  packId,
  version,
  platform,
  roots,
}: {
  packId: string;
  version: string;
  platform: string;
  roots: OverlayRoots;
}): OverlayState {
  return {
    packId,
    version,
    platform,
    roots,
    files: [],
    backups: [],
    skipped: [],
  };
}

function backupPath(packRoot: string, scope: string, rel: string): string {
  return path.join(packRoot, "backups", scope, rel);
}

/** Back up the current target once; returns true when a backup exists. */
export function backupFile(
  packRoot: string,
  state: OverlayState,
  scope: string,
  rel: string,
): boolean {
  const base = state.roots[scope];
  if (!base) return false;
  const target = safeJoin(base, rel);
  const backup = backupPath(packRoot, scope, rel);
  if (!fs.existsSync(target)) return fs.existsSync(backup);
  if (!fs.existsSync(backup)) {
    ensureDir(path.dirname(backup));
    fs.copyFileSync(target, backup);
  }
  return true;
}

export function applyFile({
  packRoot,
  state,
  scope,
  rel,
  source,
  link = false,
}: {
  packRoot: string;
  state: OverlayState;
  scope: string;
  rel: string;
  source: string;
  link?: boolean;
}): void {
  const base = state.roots[scope];
  if (!base) throw new Error(`The ${scope} install path is missing.`);
  if (backupFile(packRoot, state, scope, rel)) {
    state.backups.push({ scope, rel });
  }
  const target = safeJoin(base, rel);
  ensureDir(path.dirname(target));
  if (link) materialize(source, target, true);
  else fs.copyFileSync(source, target);
  state.files.push({ scope, rel });
}

export function removeFiles(state: OverlayState): void {
  for (const entry of state.files || []) {
    const base = state.roots[entry.scope];
    if (!base) continue;
    try { fs.rmSync(safeJoin(base, entry.rel), { force: true }); } catch { /* already gone */ }
  }
}

export function restoreBackups(packRoot: string, state: OverlayState): void {
  for (const entry of state.backups || []) {
    const backup = backupPath(packRoot, entry.scope, entry.rel);
    if (!fs.existsSync(backup)) continue;
    const base = state.roots[entry.scope];
    if (!base) continue;
    const target = safeJoin(base, entry.rel);
    ensureDir(path.dirname(target));
    fs.copyFileSync(backup, target);
  }
}

export function clearState(packRoot: string, state: OverlayState): void {
  removeFiles(state);
  restoreBackups(packRoot, state);
  fs.rmSync(stateFile(packRoot), { force: true });
}

export function planState({
  packRoot,
  state,
  processNames = [],
  processLabel = "The game",
}: {
  packRoot: string;
  state: OverlayState;
  processNames?: string[];
  processLabel?: string;
}): OverlayPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const actions: string[] = [];

  if (processNames.length && isGameRunning(processNames)) {
    errors.push(`${processLabel} is running. Close it before uninstalling.`);
  }

  const scopes = new Set([
    ...(state.files || []).map((entry) => entry.scope),
    ...(state.backups || []).map((entry) => entry.scope),
  ]);
  for (const scope of scopes) {
    const base = state.roots[scope];
    const hasFiles = (state.files || []).some((entry) => entry.scope === scope);
    const hasBackups = (state.backups || []).some((entry) => entry.scope === scope);
    if (!base && (hasFiles || hasBackups)) {
      errors.push(`The ${scope} install path is missing.`);
      continue;
    }
    if (base && (hasFiles || hasBackups)) {
      try { fs.accessSync(base, fs.constants.W_OK); } catch { errors.push(`No write access to ${base}.`); }
    }
  }

  for (const entry of state.backups || []) {
    const backup = backupPath(packRoot, entry.scope, entry.rel);
    if (!fs.existsSync(backup)) errors.push(`Missing backup for ${entry.scope}/${entry.rel}; refusing to uninstall.`);
  }

  if (state.files && state.files.length) {
    actions.push(`Remove ${state.files.length} pack file(s) from the game folders`);
  }
  if (state.backups && state.backups.length) {
    actions.push(`Restore ${state.backups.length} original file(s) from backup`);
  }

  return { ok: errors.length === 0, errors, warnings, actions };
}
