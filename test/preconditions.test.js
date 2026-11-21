const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  validateNotes, validatePreconditions, evaluatePreconditions,
} = require("../src/preconditions");
const { validatePack } = require("../src/manifest");

function basePack(preconditions, notes) {
  return {
    schema: 1,
    id: "test-pack",
    name: "Test",
    game: { id: "test", title: "Test Game", installDir: "Test", appId: 1, build: "42", prefix: false },
    mod: { id: "test", version: "1.0.0" },
    launch: { type: "me3", exe: "Game/test.exe", gameProcess: "test-game-not-running.exe", profile: "p", saveFile: "s.sl2" },
    art: { grid: "g", icon: "i" },
    files: "files.json",
    notes,
    preconditions,
  };
}

test("notes accept strings and objects, reject bad tone", () => {
  assert.equal(validateNotes(["hello", { title: "T", body: "B", tone: "warning" }]).length, 2);
  assert.throws(() => validateNotes([{ body: "B", tone: "loud" }]), /tone/);
});

test("preconditions reject unknown types and duplicate ids", () => {
  assert.throws(() => validatePreconditions([{ id: "a", type: "nope" }]), /unknown type/);
  assert.throws(() => validatePreconditions([{ id: "a", type: "manual" }, { id: "a", type: "manual" }]), /duplicate/);
  assert.throws(() => validatePreconditions([{ id: "d", type: "disk-free", bytes: "lots" }]), /bytes/);
});

test("validatePack accepts notes and preconditions", () => {
  const pack = basePack([
    { id: "game", type: "game-installed", required: true },
    { id: "disk", type: "disk-free", required: true, reserveBytes: 1 },
  ], [{ title: "Read me", body: "Extra steps", tone: "info" }]);
  assert.equal(validatePack(pack).preconditions.length, 2);
});

test("required failures block, optional failures do not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-pre-"));
  const game = { root, build: "41", prefixReady: true, library: root };
  const pack = basePack([
    { id: "build", type: "game-build", required: true, build: "42" },
    { id: "optional", type: "path-exists", required: false, path: "missing.file" },
  ]);
  const out = evaluatePreconditions({ pack, game, root, totalBytes: 10 });
  assert.equal(out.blocked, true);
  assert.equal(out.checks[0].status, "fail");
  assert.equal(out.checks[0].blocked, true);
  assert.equal(out.checks[1].blocked, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("manual checks pass only after confirmation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-pre-"));
  const pack = basePack([{ id: "dlc", type: "manual", required: true, title: "Own the DLC" }]);
  const game = { root, build: "42", prefixReady: true, library: root };
  assert.equal(evaluatePreconditions({ pack, game, root, totalBytes: 1 }).blocked, true);
  const confirmed = evaluatePreconditions({ pack, game, root, totalBytes: 1, confirmed: { dlc: {} } });
  assert.equal(confirmed.blocked, false);
  assert.equal(confirmed.checks[0].status, "pass");
  fs.rmSync(root, { recursive: true, force: true });
});

test("unknown values can be allowed by the pack author", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-pre-"));
  const pack = basePack([{ id: "space", type: "disk-free", required: true, allowUnknown: true }]);
  const game = { root, build: "42", prefixReady: true, library: root };
  const original = fs.statfsSync;
  fs.statfsSync = () => { const err = new Error("no statfs"); err.code = "ENOSYS"; throw err; };
  try {
    const out = evaluatePreconditions({ pack, game, root, totalBytes: 1 });
    assert.equal(out.checks[0].status, "unknown");
    assert.equal(out.blocked, false);
  } finally {
    fs.statfsSync = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
