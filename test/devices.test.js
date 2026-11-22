"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDeviceStore } = require("../dist/src/devices");

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-devices-"));
  return { dir, file: path.join(dir, "devices.json") };
}

test("a device token authorizes until it is revoked", () => {
  const { dir, file } = tempStore();
  try {
    const store = createDeviceStore({ file, legacyToken: "legacy-token" });
    const issued = store.issue({ name: "Living room TV", address: "192.168.1.50", deviceId: "dev-1" });
    assert.match(issued.token, /^ms_/);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].legacy, false);
    assert.equal(store.authorize(issued.token, { address: "192.168.1.50" }).name, "Living room TV");
    assert.equal(store.authorize("wrong-token", { address: "192.168.1.50" }), null);
    assert.equal(fs.readFileSync(file, "utf8").includes(issued.token), false);

    assert.equal(store.revoke(issued.device.id), true);
    assert.equal(store.authorize(issued.token, { address: "192.168.1.50" }), null);
    assert.equal(store.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("re-pairing the same installation replaces its old token", () => {
  const { dir, file } = tempStore();
  try {
    const store = createDeviceStore({ file, legacyToken: "legacy-token" });
    const first = store.issue({ name: "TV", address: "10.0.0.2", deviceId: "same-device" });
    const second = store.issue({ name: "TV renamed", address: "10.0.0.3", deviceId: "same-device" });
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].name, "TV renamed");
    assert.equal(store.authorize(first.token, { address: "10.0.0.2" }), null);
    assert.equal(store.authorize(second.token, { address: "10.0.0.3" }).name, "TV renamed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy clients use a device id, or the address when they have none", () => {
  const { dir, file } = tempStore();
  try {
    const store = createDeviceStore({ file, legacyToken: "legacy-token" });
    const first = store.authorize("legacy-token", { address: "10.0.0.5", deviceId: "client-a", name: "TV A" });
    assert.equal(first.legacy, true);
    assert.equal(first.name, "TV A");

    const moved = store.authorize("legacy-token", { address: "10.0.0.9", deviceId: "client-a" });
    assert.equal(moved.id, first.id);

    const noId = store.authorize("legacy-token", { address: "10.0.0.7" });
    assert.equal(noId.legacy, true);
    const sameAddress = store.authorize("legacy-token", { address: "10.0.0.7" });
    assert.equal(sameAddress.id, noId.id);
    const otherAddress = store.authorize("legacy-token", { address: "10.0.0.8" });
    assert.notEqual(otherAddress.id, noId.id);
    assert.equal(store.list().length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an address-only legacy record is adopted when the client starts sending a device id", () => {
  const { dir, file } = tempStore();
  try {
    const store = createDeviceStore({ file, legacyToken: "legacy-token" });
    const old = store.authorize("legacy-token", { address: "10.0.0.7" });
    const adopted = store.authorize("legacy-token", { address: "10.0.0.7", deviceId: "client-b", name: "TV B" });
    assert.equal(adopted.id, old.id);
    assert.equal(adopted.name, "TV B");
    assert.equal(store.list().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a revoked legacy client stays revoked, including after reopening the store", () => {
  const { dir, file } = tempStore();
  try {
    const store = createDeviceStore({ file, legacyToken: "legacy-token" });
    const device = store.authorize("legacy-token", { address: "10.0.0.7", deviceId: "client-c" });
    assert.equal(store.revoke(device.id), true);
    assert.equal(store.authorize("legacy-token", { address: "10.0.0.7", deviceId: "client-c" }), null);

    const reopened = createDeviceStore({ file, legacyToken: "legacy-token" });
    assert.equal(reopened.authorize("legacy-token", { address: "10.0.0.7", deviceId: "client-c" }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("changing the manual token revokes legacy clients but keeps paired devices", () => {
  const { dir, file } = tempStore();
  try {
    const store = createDeviceStore({ file, legacyToken: "legacy-token" });
    const paired = store.issue({ name: "Paired TV", address: "10.0.0.4", deviceId: "dev-2" });
    const legacy = store.authorize("legacy-token", { address: "10.0.0.7", deviceId: "client-d" });
    assert.ok(paired.device.id);
    assert.ok(legacy.id);

    store.setLegacyToken("new-legacy");
    assert.equal(store.authorize("legacy-token", { address: "10.0.0.7", deviceId: "client-d" }), null);
    assert.equal(store.authorize(paired.token, { address: "10.0.0.4" }).id, paired.device.id);
    assert.ok(store.authorize("new-legacy", { address: "10.0.0.7", deviceId: "client-d" }));
    assert.equal(store.list().length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("revoke all clears paired and legacy devices", () => {
  const { dir, file } = tempStore();
  try {
    const store = createDeviceStore({ file, legacyToken: "legacy-token" });
    store.issue({ name: "One", address: "10.0.0.2" });
    store.issue({ name: "Two", address: "10.0.0.3" });
    store.authorize("legacy-token", { address: "10.0.0.7", deviceId: "client-e" });
    assert.equal(store.revokeAll(), 3);
    assert.equal(store.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
