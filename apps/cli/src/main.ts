#!/usr/bin/env bun
// The `webcraft` command line: the Install's remote commands (generated from its API), signing in,
// `structure pull/push`, and the server commands under `webcraft admin`. See docs/cli.md.
import { runCli } from "./cli.ts";
import { processIo } from "./io.ts";

process.exit(await runCli(process.argv.slice(2), processIo()));
