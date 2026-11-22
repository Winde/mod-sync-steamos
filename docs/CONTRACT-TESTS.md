# Contract tests

`docs/TESTING.md` is the manual acceptance run. This document describes the
automated suite that acts as the safety net for refactoring.

## What "contract" means here

`test/contract/` is black-box. It runs the CLI as a child process and talks to
the PC repository and TV agent over HTTP. It never imports `src/`, so moving,
splitting, or renaming modules does not require touching these tests.

| File | Contract |
|---|---|
| `pack-cli.test.js` | `modsync pack` writes a valid `pack.json`/`files.json`, payload, profile, tools, and art for a requested version; prints build progress |
| `pack-bg3-cli.test.js` | the BG3 pack builder writes the same external format: platform-tagged BG3SE/BG3LE files, native template, install metadata, and normalized contents |
| `pack-loader-contract.test.js` | ER packs expose one launcher template and platform-tagged Windows/Linux loader runtimes; the installer does not select them by game |
| `repository-http.test.js` | device/manual token auth, catalog, pack documents, art, full and ranged file streaming, loopback default, refusal to bind all interfaces |
| `agent-install.test.js` | `/api/state`, install job lifecycle, complete TV output (hashes, `current.txt`, launcher), resume from `.part`, launch errors, BOM config, dashboard assets |
| `agent-install-gates.test.js` | a mismatched build, a running game, a secondary game process, and a missing Proton prefix block install before the TV pack directory exists |
| `agent-install-policy.test.js` | a pack that omits a build, prefix, running-state, or disk precondition is not blocked by hidden installer policy; the declared checks are authoritative |
| `agent-bg3-overlay.test.js` | BG3 install/update/rollback/pack removal keep the game data directory and Script Extender files reversible |
| `agent-bg3-native.test.js` | native Linux BG3 installs BG3LE in the canonical per-user layout, leaves `bin/bg3` untouched, skips Windows BG3SE files, and reverts the loader and data files on removal (Linux only) |
| `agent-rollback.test.js` | two installed versions, pointer switch, both versions kept, version list and status; offline listing, BOM pack data, and offline rollback |
| `agent-offline.test.js` | an installed pack remains listed after the PC server stops |
| `agent-storage.test.js` | `/api/storage` usage report, staging/old-version/log/pack clearing, invalid input, pack removal safety, and the running-game and active-install guards |
| `contents-refresh.test.js` | `scripts/refresh-contents.js` refreshes both an ER and a BG3 pack through the driver interface, with no game-specific branch, and regenerates their docs |
| `agent-multi-pack.test.js` | multiple packs are merged and sorted by game then pack name |
| `agent-preconditions.test.js` | required `manual` checks block, confirm, and unblock via the API |
| `steam-shortcuts.test.js` | `register` writes one shortcut with header/portrait/grid/hero/logo/icon art, updates instead of duplicating, collapses existing duplicates, and finds Flatpak Steam roots |

The tests use `test-support/harness.js`, which creates:

- a disposable working install for the pack builder;
- fake ELDEN RING and BG3 Steam libraries (`ProgramFiles` on Windows,
  `$HOME/.local/share/Steam` elsewhere) with an `appmanifest_*.acf`, game
  executable, Proton prefix, and `userdata/*/config` for shortcut tests;
- a BG3 working data directory and a fake BG3LE cache, so the BG3 builder runs
  without a network request;
- temporary TV roots and ephemeral ports for the repository and agent.

No real game, Steam account, or save file is read or written. Sentinel saves
only ever exist inside the disposable fake trees. The launch assertion is
skipped on Windows because the TV agent is SteamOS-only; the Flatpak Steam-root
and native BG3 tests are skipped there for the same reason.

## Running

```bash
npm test                 # build, then everything including the white-box tests
npm run build && node --test test/contract
```

The suite runs in under ten seconds because fixtures are a few hundred bytes.
Two offline tests wait for the agent's 2.5-second remote-catalog cache to expire.

## White-box tests

`test/preconditions.test.js`, `test/rollback.test.js`, `test/smoke.test.js`,
`test/storage.test.js`, `test/steam.test.js`, `test/catalog-docs.test.js`, and
`test/console.test.js` import the compiled functions from `dist/` directly. They are useful characterization
tests, but they are tied to current module boundaries and will need import
updates when those modules are split. `test/web-app.test.js` and
`test/web-pc.test.js` load the compiled React renderers into jsdom with a stub
API and assert the visible behavior and actions.

During the refactor:

- keep them as a second signal, not the safety net;
- do not add more internal unit tests for code that is about to move;
- retire assertions that the contract suite covers once the new modules exist
  (for example `rollback.test.js` and the range/version checks in
  `smoke.test.js` are already covered end-to-end).

## Rules for changing the suite

1. A contract test may assert HTTP status, required JSON fields, the on-disk TV
   layout (`mods/<mod>/current.txt`, `versions/`, `profiles/`, `launchers/`),
   the pack format, and the Steam VDF/art files. Those are external contracts.
2. Do not assert log wording, private function names, HTML structure, or the
   internal shape of the confirmation store. Those are implementation details.
   The exception is output that is itself the feature (pack build progress).
3. If a contract test fails, assume behavior changed. Update the assertion only
   when the contract itself intentionally changed.
4. Add a contract test before changing an untested behavior (for example job
   cancellation).

## Not covered yet

- Real Chromium rendering, focus movement, and gamepad input for the React
  renderers; jsdom covers the visible states and actions but not layout.
- `serve --lan` interface selection; the loopback default and the refusal to bind
  `0.0.0.0` are covered, but choosing a specific LAN IP is environment-dependent
  and remains part of the manual run.
- Real Steam shortcut registration and `.desktop` launch on a Steam Machine.
- Cancel during an active transfer; resume is covered by the `.part` test. A
  storage clear during an install is covered.
