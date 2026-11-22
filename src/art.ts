import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "./root";
import { ensureDir } from "./util";

/**
 * Generic ModSync pack art.
 *
 * Drivers that have no game-specific artwork copy these placeholders into the
 * pack so a pack card and TV tile always have an image. A pack's cover can be
 * replaced from the Server console after the build.
 */
export const DEFAULT_ART_FILES = [
  ["modsync-grid.png", "grid.png"],
  ["modsync-hero.png", "hero.png"],
  ["modsync-logo.png", "logo.png"],
  ["icon.png", "icon.png"],
  ["modsync-header.png", "header.png"],
  ["modsync-portrait.png", "portrait.png"],
] as const;

export function copyDefaultArt(dst: string, artId: string): void {
  const source = path.join(projectRoot, "web");
  const target = path.join(dst, "art", artId);
  ensureDir(target);
  for (const [from, to] of DEFAULT_ART_FILES) {
    const file = path.join(source, from);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(target, to));
  }
}
