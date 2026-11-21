const fs = require("node:fs");
const path = require("node:path");
const {
  ensureDir, readJson, writeJson, writeText, walkFiles, materialize,
  sha256File, modeFor, formatBytes, relPosix,
} = require("../util");

const MOD_ID = "graceborne";
const PACK_ID = "eldenring-graceborne";

function requirePath(p, label) {
  if (!fs.existsSync(p)) throw new Error(`${label} not found: ${p}`);
}

async function buildPack({ source, out, link = true, version: requestedVersion, log = () => {} }) {
  const src = path.resolve(source);
  const dst = path.resolve(out);
  const versionFile = path.join(src, "mods", MOD_ID, "current.txt");
  if (!fs.existsSync(versionFile)) throw new Error(`Graceborne is not installed at ${src}`);
  const version = String(requestedVersion || fs.readFileSync(versionFile, "utf8")).trim();
  if (!version) throw new Error("version is empty");

  const payloadSrc = path.join(src, "mods", MOD_ID, "versions", version);
  const profileSrc = path.join(src, "profiles", `${MOD_ID}-${version}.me3`);
  const me3Linux = path.join(src, "tools", "me3-linux");
  const me3Win = path.join(src, "tools", "me3-win");
  const artSrc = path.join(src, "art", MOD_ID);
  requirePath(payloadSrc, "mod payload");
  requirePath(profileSrc, "me3 profile");
  requirePath(me3Linux, "me3 Linux runtime");
  requirePath(me3Win, "me3 Windows runtime");
  requirePath(artSrc, "art");

  log(`Packing Graceborne ${version} from ${src}`);
  fs.rmSync(dst, { recursive: true, force: true });
  ensureDir(path.join(dst, "payload", "versions"));

  let links = 0;
  let copies = 0;
  for (const file of walkFiles(payloadSrc)) {
    const target = path.join(dst, "payload", "versions", version, file.rel);
    const how = materialize(file.abs, target, link);
    if (how === "link") links++; else copies++;
  }
  log(`Payload: ${links} hardlinks, ${copies} copies`);

  fs.cpSync(profileSrc, path.join(dst, "profiles", path.basename(profileSrc)), { recursive: true });
  fs.cpSync(me3Linux, path.join(dst, "tools", "me3-linux"), { recursive: true });
  fs.cpSync(me3Win, path.join(dst, "tools", "me3-win"), { recursive: true });
  fs.cpSync(artSrc, path.join(dst, "art", MOD_ID), { recursive: true });

  const files = [];
  const add = async (sourceRel, targetRel) => {
    const abs = path.join(dst, sourceRel);
    const size = fs.statSync(abs).size;
    const sha256 = await sha256File(abs);
    files.push({ source: sourceRel, target: targetRel, size, sha256, mode: modeFor(targetRel) });
  };

  for (const file of walkFiles(path.join(dst, "payload", "versions", version))) {
    const rel = relPosix(path.join(dst, "payload", "versions", version), file.abs);
    await add(`payload/versions/${version}/${rel}`, `mods/${MOD_ID}/versions/${version}/${rel}`);
  }
  await add(`profiles/${path.basename(profileSrc)}`, `profiles/${path.basename(profileSrc)}`);
  for (const tool of walkFiles(path.join(dst, "tools"))) {
    const rel = relPosix(path.join(dst, "tools"), tool.abs);
    await add(`tools/${rel}`, `tools/${rel}`);
  }
  for (const art of walkFiles(path.join(dst, "art", MOD_ID))) {
    const rel = relPosix(path.join(dst, "art", MOD_ID), art.abs);
    await add(`art/${MOD_ID}/${rel}`, `art/${MOD_ID}/${rel}`);
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const pack = {
    schema: 1,
    id: PACK_ID,
    name: "Graceborne",
    description: "Bloodborne-inspired overhaul for ELDEN RING 1.17",
    game: {
      id: "eldenring",
      title: "ELDEN RING",
      store: "steam",
      appId: 1245620,
      installDir: "ELDEN RING",
      build: "25827938",
      version: "1.17",
      prefix: true,
    },
    mod: { id: MOD_ID, version },
    loader: { type: "me3", profile: `profiles/${MOD_ID}-${version}.me3` },
    launch: {
      type: "me3",
      exe: "Game/eldenring.exe",
      gameProcess: "eldenring.exe",
      steamAppId: 1245620,
      profile: `profiles/${MOD_ID}-${version}.me3`,
      saveFile: "ER0000.graceborne.sl2",
      me3: "tools/me3-linux/bin/me3",
      windowsBinaries: "tools/me3-linux/win64",
    },
    art: {
      grid: `art/${MOD_ID}/grid.png`,
      hero: `art/${MOD_ID}/hero.png`,
      logo: `art/${MOD_ID}/logo.png`,
      icon: `art/${MOD_ID}/icon.png`,
    },
    notes: [
      {
        title: "Install 1.17 and launch vanilla once",
        body: "Install ELDEN RING via Steam, then start the vanilla game once so its Proton prefix exists. The installer refuses to run without it.",
        tone: "info",
      },
      {
        title: "Stay on build 25827938",
        body: "In the game's Steam properties choose Only update this game when I launch it. This pack is built for 1.17; a newer build may break the mod.",
        tone: "warning",
      },
      {
        title: "Play offline",
        body: "Launch through the ModSync shortcut. Playing online with mods can get the account banned; the launcher starts the game with online disabled.",
        tone: "warning",
      },
      {
        title: "Saves are separate",
        body: "The mod uses ER0000.graceborne.sl2. Vanilla ER0000.sl2 and Steam Cloud are untouched. v1 does not transfer saves between machines.",
        tone: "info",
      },
    ],
    preconditions: [
      { id: "game-installed", type: "game-installed", required: true, title: "ELDEN RING is installed" },
      { id: "game-build", type: "game-build", required: true, build: "25827938", title: "Game is build 25827938 (1.17)" },
      { id: "proton-prefix", type: "proton-prefix", required: true, title: "Proton prefix exists", hint: "Launch the vanilla game once from Steam." },
      { id: "game-closed", type: "game-not-running", required: true, title: "Game is closed" },
      { id: "disk-free", type: "disk-free", required: true, reserveBytes: 1073741824, title: "Enough free space" },
    ],
    files: "files.json",
    save: { transfer: "out-of-scope" },
  };
  writeJson(path.join(dst, "pack.json"), pack);
  writeJson(path.join(dst, "files.json"), {
    schema: 1,
    pack: PACK_ID,
    version,
    files,
  });
  writeText(path.join(dst, "README.md"), `# Graceborne pack\n\nELDEN RING ${pack.game.version} (build ${pack.game.build})\nGraceborne ${version}\n\nThis pack is mod-only. It contains no base game and no saves.\n`);
  log(`Wrote ${files.length} files, ${formatBytes(totalBytes)}`);
  return { packRoot: dst, pack, files: files.length, totalBytes };
}

module.exports = { buildPack, PACK_ID, MOD_ID };
