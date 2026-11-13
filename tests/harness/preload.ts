// Loaded by `bun test` before any test file (see bunfig.toml). A hook registered here runs once
// for the whole run, after every test file has finished.
import { afterAll } from "bun:test";

import { dropTemplate } from "./database.ts";

afterAll(async () => {
	await dropTemplate();
});
