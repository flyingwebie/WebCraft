// The production web process (apps/server/src/serve.ts), started with the test suite's Modules so
// the browser tests see the Module screens with Modules on them. The web process loads the Modules
// a program hands it in its own process before it starts (`webModules()` in web-services.ts).
import { TEST_MODULES } from "../harness/modules.ts";

(globalThis as { webcraftModules?: unknown }).webcraftModules = TEST_MODULES;
await import("../../apps/server/src/serve.ts");
