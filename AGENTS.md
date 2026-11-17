# WebCraft

Setup, commands and conventions: `docs/development.md`. Project rules: `CLAUDE.md`.

## Tests

CI runs the suite with one Bun worker per core, and each worker keeps one process across the files it runs (`--no-isolate`). A file that leaves something behind breaks whichever file that worker runs next. Every test file:

- Creates what it uses in `beforeAll` (`createTestInstall()`, its own Workspaces and Sites) and closes it in `afterAll` (`await install.close()`, which stops the Install and drops its database). It never reuses another file's Install, database or data.
- Restores every global it changes before the file ends: `process.env`, `globalThis`, `Bun.env`, fake timers and `mock.module`. Prefer passing a fake through `createTestInstall` options to changing a global.
- Stops what it starts: servers (`server.stop()`), child processes, sockets, intervals and timers, and removes the temporary folders it made.
- Drains or discards the jobs it enqueues. A file whose tests share one Install drains after each test (`afterEach(() => install.drainJobs())`) so no test inherits another's queue.
- Lets each test set up its own state: a test never relies on an earlier test in the file having run. `bun test --randomize` checks it; 88 files still fail it (#146), so a new or changed file must pass `bun test --randomize <file>` before it lands.

Assertions:

- Await a promise, then assert on its value: `expect(await rejection(promise)).toMatchObject(…)`, `expect(await thrown(promise)).toThrow(…)`, `expect(await promise).toEqual(…)` (`tests/harness/settled.ts`). Never `expect(promise)` with `.rejects` or `.resolves`: Bun stalls there (`docs/development.md`, "Testing").
- Never add `--retry`, raise a timeout or skip a test to make it pass. A test that needs one of those has a bug: find it.

Before pushing, run the files you touched the way CI does: `bun test --parallel --no-isolate <files>`. The pre-push hook checks format, lint and types on its own; never skip it with `--no-verify`.
