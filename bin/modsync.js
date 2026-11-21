#!/usr/bin/env node
const { main } = require("../dist/src/cli");

main(process.argv).catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
