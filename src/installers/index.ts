"use strict";

/**
 * Game-specific install adapters.
 *
 * The generic installer resolves the pack and calls an adapter only when the
 * pack declares `install.type`. No adapter is chosen by game id or by a
 * hardcoded executable path.
 */

import * as bg3 from "./bg3";
import type { Pack, PackAdapter } from "../types";

const adapters: Record<string, PackAdapter> = {
  bg3,
};

export function forPack(pack: Pack | null | undefined): PackAdapter | null {
  if (!pack || !pack.install || !pack.install.type) return null;
  return adapters[pack.install.type] || null;
}

export { adapters };
