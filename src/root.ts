import path from "node:path";

// Compiled runtime lives in dist/, so the project root is two levels up from
// dist/src and dist/electron. The same layout holds inside app.asar.
export const projectRoot = path.resolve(__dirname, "..", "..");
