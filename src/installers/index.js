"use strict";

/**
 * Game-specific install adapters.
 *
 * The generic installer resolves the pack and calls an adapter only when the
 * pack declares `install.type`. No adapter is chosen by game id or by a
 * hardcoded executable path.
 */

const bg3 = require("./bg3");

const adapters = { bg3 };

function forPack(pack) {
  if (!pack || !pack.install || !pack.install.type) return null;
  return adapters[pack.install.type] || null;
}

module.exports = { adapters, forPack };
