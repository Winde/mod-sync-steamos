// Development dispatcher. Packaged Server and Client builds replace this with
// their own main entry through electron-builder extraMetadata.
const wantsClient = process.argv.includes("--client") || process.argv.includes("--tv");
const wantsServer = process.argv.includes("--server") || process.argv.includes("--pc");
if (wantsServer && !wantsClient) {
  require("./server-main");
} else if (wantsClient) {
  require("./client-main");
} else if (process.platform === "win32") {
  require("./server-main");
} else {
  require("./client-main");
}
