const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeShortcut } = require("../src/steam");

function shortcut(name, exe) {
  return { appname: name, Exe: `"${exe}"`, StartDir: `"${exe}"` };
}

test("registering the same shortcut twice keeps one entry", () => {
  const entry = shortcut("ModSync", "/home/tv/ModSync/launch.sh");
  const first = mergeShortcut([], entry);
  assert.equal(first.action, "added");
  assert.equal(first.list.length, 1);

  const second = mergeShortcut(first.list, entry);
  assert.equal(second.action, "updated");
  assert.equal(second.list.length, 1);
});

test("existing duplicate shortcuts collapse to one", () => {
  const entry = shortcut("ModSync", "/home/tv/ModSync/launch.sh");
  const out = mergeShortcut([entry, entry, entry], entry);
  assert.equal(out.action, "updated");
  assert.equal(out.list.length, 1);
  assert.equal(out.deduped, 2);
});

test("the same executable under a new name reuses the entry", () => {
  const oldEntry = shortcut("Old ModSync", "/home/tv/ModSync/launch.sh");
  const newEntry = shortcut("ModSync", "/home/tv/ModSync/launch.sh");
  const out = mergeShortcut([oldEntry], newEntry);
  assert.equal(out.list.length, 1);
  assert.equal(out.list[0].appname, "ModSync");
});

test("different shortcuts are preserved", () => {
  const a = shortcut("ModSync", "/home/tv/ModSync/launch.sh");
  const b = shortcut("Graceborne", "/home/tv/ModSync/packs/g/launch.sh");
  const out = mergeShortcut([a], b);
  assert.equal(out.list.length, 2);
});
