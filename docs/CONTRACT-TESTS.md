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
| `repository-http.test.js` | token auth, catalog, pack documents, art, full and ranged file streaming, loopback default, refusal to bind all interfaces |
| `agent-install.test.js` | `/api/state`, install job lifecycle, complete TV output (hashes, `current.txt`, launcher), resume from `.part`, launch errors, BOM config, dashboard assets |
| `agent-rollback.test.js` | two installed versions, pointer switch, both versions kept, version list and status; offline listing, BOM pack data, and offline rollback |
| `agent-offline.test.js` | an installed pack remains listed after the PC server stops |
| `agent-storage.test.js` | `/api/storage` usage report, staging/old-version/log/pack clearing, invalid input, pack removal safety, and the running-game and active-install guards |
| `agent-multi-pack.test.js` | multiple packs are merged and sorted by game then pack name |
| `agent-preconditions.test.js` | required `manual` checks block, confirm, and unblock via the API |
| `steam-shortcuts.test.js` | `register` writes one shortcut with header/portrait/grid/hero/logo/icon art, updates instead of duplicating, collapses existing duplicates, and finds Flatpak Steam roots |

The tests use `test-support/harness.js`, which creates:

- a disposable working install for the pack builder;
- a fake Steam library (`ProgramFiles` on Windows, `$HOME/.local/share/Steam`
  elsewhere) with an `appmanifest_*.acf`, game executable, Proton prefix, and
  `userdata/*/config` for shortcut tests;
- temporary TV roots and ephemeral ports for the repository and agent.

No real game, Steam account, or save file is read or written. Sentinel saves
only ever exist inside the disposable fake trees. The launch assertion is
skipped on Windows because the TV agent is SteamOS-only; the Flatpak Steam-root
test is skipped there for the same reason.

## Running

```bash
node --test             # everything, including the white-box tests
node --test test/contract
```

The suite runs in under ten seconds because fixtures are a few hundred bytes.
Two offline tests wait for the agent's 2.5-second remote-catalog cache to expire.

## White-box tests

`test/preconditions.test.js`, `test/rollback.test.js`, `test/smoke.test.js`,
`test/storage.test.js`, and `test/steam.test.js` import `src/` functions
directly. They are useful characterization tests, but they are tied to current
module boundaries and will need import updates when those modules are split.

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

- Browser behavior of `web/app.js` (only the served assets are checked), including
  the Games and Storage views.
- `serve --lan` interface selection; the loopback default and the refusal to bind
  `0.0.0.0` are covered, but choosing a specific LAN IP is environment-dependent
  and remains part of the manual run.
- Real Steam shortcut registration and `.desktop` launch on a Steam Machine.
- Cancel during an active transfer; resume is covered by the `.part` test. A
  storage clear during an install is covered.
