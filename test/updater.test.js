const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  Updater,
  appImageName,
  checksumFor,
  compareVersions,
  parseRelease,
} = require("../dist/electron/updater");

const REPO = "Winde/mod-sync-steamos";
const DOWNLOAD = `https://github.com/${REPO}/releases/download`;

test("release versions compare like semver", () => {
  assert.ok(compareVersions("0.2.0", "0.1.0") > 0);
  assert.ok(compareVersions("0.2.0-beta.1", "0.2.0") < 0);
  assert.equal(compareVersions("v0.2.0", "0.2.0"), 0);
});

test("release parsing keeps only assets from our download path", () => {
  const release = parseRelease({
    tag_name: "v0.2.0",
    assets: [
      { name: appImageName("0.2.0"), browser_download_url: `${DOWNLOAD}/v0.2.0/${appImageName("0.2.0")}` },
      { name: "SHA256SUMS.txt", browser_download_url: `${DOWNLOAD}/v0.2.0/SHA256SUMS.txt` },
      { name: "evil", browser_download_url: "https://example.com/evil" },
    ],
  });
  assert.equal(release.version, "0.2.0");
  assert.equal(release.assets.length, 2);
});

test("checksum lookup accepts sha256sum output", () => {
  const hash = "a".repeat(64);
  assert.equal(checksumFor(`${hash}  ${appImageName("0.2.0")}\n`, appImageName("0.2.0")), hash);
  assert.equal(checksumFor(`${hash} *${appImageName("0.2.0")}\n`, appImageName("0.2.0")), hash);
  assert.equal(checksumFor(`${hash}  other\n`, appImageName("0.2.0")), null);
});

test("the updater checks and installs a checksummed AppImage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-updater-"));
  const target = path.join(dir, "ModSync.AppImage");
  const name = appImageName("0.2.0");
  const payload = Buffer.from("new appimage bytes");
  const hash = crypto.createHash("sha256").update(payload).digest("hex");
  const fetch = async (url) => {
    if (url.endsWith("/releases/latest")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: "v0.2.0",
          assets: [
            { name, browser_download_url: `${DOWNLOAD}/v0.2.0/${name}` },
            { name: "SHA256SUMS.txt", browser_download_url: `${DOWNLOAD}/v0.2.0/SHA256SUMS.txt` },
          ],
        }),
        text: async () => "",
        body: null,
      };
    }
    if (url.endsWith("SHA256SUMS.txt")) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => `${hash}  ${name}\n`, body: null };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
      body: new Response(payload).body,
    };
  };
  const updater = new Updater({ currentVersion: () => "0.1.0", appImage: () => target, fetch });
  try {
    const info = await updater.check();
    assert.equal(info.latest, "0.2.0");
    assert.equal(info.available, true);
    assert.equal(info.canInstall, true);
    const installed = await updater.install();
    assert.equal(installed, target);
    assert.deepEqual(fs.readFileSync(target), payload);
    assert.equal(fs.existsSync(`${target}.part`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the updater refuses a bad checksum", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modsync-updater-bad-"));
  const target = path.join(dir, "ModSync.AppImage");
  const name = appImageName("0.2.0");
  const fetch = async (url) => {
    if (url.endsWith("/releases/latest")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: "v0.2.0",
          assets: [
            { name, browser_download_url: `${DOWNLOAD}/v0.2.0/${name}` },
            { name: "SHA256SUMS.txt", browser_download_url: `${DOWNLOAD}/v0.2.0/SHA256SUMS.txt` },
          ],
        }),
        text: async () => "",
        body: null,
      };
    }
    if (url.endsWith("SHA256SUMS.txt")) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => `${"0".repeat(64)}  ${name}\n`, body: null };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "", body: new Response(Buffer.from("bad")).body };
  };
  const updater = new Updater({ currentVersion: () => "0.1.0", appImage: () => target, fetch });
  try {
    await updater.check();
    await assert.rejects(updater.install(), /checksum/);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(`${target}.part`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
