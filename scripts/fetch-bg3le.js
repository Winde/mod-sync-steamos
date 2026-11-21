#!/usr/bin/env node
"use strict";

/**
 * Fetch the pinned BG3LE release used by the native Baldur's Gate 3 pack.
 * The implementation lives in src/; this stays a thin CLI for npm scripts.
 */

const { ensureBg3le } = require("../dist/src/bg3le");

ensureBg3le().then((dir) => console.log(dir)).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
