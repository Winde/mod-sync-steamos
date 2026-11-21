const test = require("node:test");
const assert = require("node:assert/strict");
const { parseContentManifest, baseFile } = require("../dist/src/steam-depot");

function varint(value) {
  const bytes = [];
  let n = value;
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

function fileMapping(name, size) {
  const nameBuf = Buffer.from(name, "utf8");
  const inner = Buffer.concat([
    Buffer.from([0x0a]), varint(nameBuf.length), nameBuf,
    Buffer.from([0x10]), varint(size),
  ]);
  return Buffer.concat([Buffer.from([0x0a]), varint(inner.length), inner]);
}

function manifest(files) {
  const header = Buffer.alloc(8);
  return Buffer.concat([header, ...files.map(([name, size]) => fileMapping(name, size))]);
}

test("steam content manifest parser returns file mappings", () => {
  const buffer = manifest([
    ["chitin.key", 881764],
    ["data\\25Areas.bif", 659152],
    ["Baldur.exe", 7202696],
  ]);
  const files = parseContentManifest(buffer, 257354);
  assert.equal(files.length, 3);
  assert.deepEqual(files.map((file) => file.path), ["chitin.key", "data/25Areas.bif", "Baldur.exe"]);
  assert.deepEqual(files.map((file) => file.size), [881764, 659152, 7202696]);
  assert.equal(files.every((file) => file.depotId === 257354), true);
});

test("baseFile lookup is case-insensitive and normalizes backslashes", () => {
  const set = {
    appId: 1,
    build: "1",
    depots: [],
    files: new Map([
      ["data/25areas.bif", { path: "data/25Areas.bif", size: 1, depotId: 1 }],
    ]),
  };
  assert.equal(baseFile(set, "DATA\\25Areas.BIF")?.path, "data/25Areas.bif");
  assert.equal(baseFile(set, "missing.bif"), null);
});
