# Contract tests

`docs/TESTING.md` is the manual acceptance run. This document describes the
automated suite that acts as the safety net for refactoring.

## What "contract" means here

`test/contract/` is black-box. It runs the CLI as a child process and talks to
the PC repository and TV agent over HTTP. It never imports `src/`, so moving,
splitting, or renaming modules does not require touching these tests.

| File | Contract |
|---|---|
| `pack-cli.test.js` | `modsync pack` writes a valid `pack.json`/`files.json`, payload, profile, tools, and art for a requested version |
| `repository-http.test.js` | token auth, catalog, pack documents, art, full and ranged file streaming, bootstrap endpoint |
| `agent-install.test.js` | `/api/state`, install job lifecycle, complete TV output (hashes, `current.txt`, launcher), resume from `.part`, launch errors, dashboard assets |
| `agent-rollback.test.js` | two installed versions, pointer switch, both versions kept, version list and status |
| `agent-preconditions.test.js` | required `manual` checks block, confirm, and unblock via the API |

The tests use `test-support/harness.js`, which creates:

- a disposable working install for the pack builder;
- a fake Steam library (`ProgramFiles` on Windows, `$HOME/.local/share/Steam`
  elsewhere) with an `appmanifest_*.acf`, game executable, and Proton prefix;
- temporary TV roots and ephemeral ports for the repository and agent.

No real game, Steam account, or save file is read or written. The launch
assertion is skipped on Windows because the TV agent is SteamOS-only.

## Running

```bash
node --test             # everything, including the white-box tests
node --test test/contract
```

The suite is fast (a few seconds) because fixtures are a few hundred bytes.

## White-box tests

`test/preconditions.test.js`, `test/rollback.test.js`, and
`test/smoke.test.js` import `src/` functions directly. They are useful
characterization tests, but they are tied to current module boundaries and will
need import updates when those modules are split.

During the refactor:

- keep them as a second signal, not the safety net;
- do not add more internal unit tests for code that is about to move;
- retire assertions that the contract suite covers once the new modules exist
  (for example `rollback.test.js` and the range/version checks in
  `smoke.test.js` are already covered end-to-end).

## Rules for changing the suite

1. A contract test may assert HTTP status, required JSON fields, the on-disk TV
   layout (`mods/<mod>/current.txt`, `versions/`, `profiles/`, `launchers/`),
   and the pack format. Those are external contracts.
2. Do not assert log wording, private function names, HTML structure, or the
   internal shape of the confirmation store. Those are implementation details.
3. If a contract test fails, assume behavior changed. Update the assertion only
   when the contract itself intentionally changed.
4. Add a contract test before changing an untested behavior (for example job
   cancellation).

## Not covered yet

- Browser behavior of `web/app.js` (only the served assets are checked).
- Real Steam shortcut registration and `.desktop` launch on a Steam Machine.
- `modsync bootstrap` downloading the Linux Node runtime.
- Cancel during an active transfer; resume is covered by the `.part` test.
