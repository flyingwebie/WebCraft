import { FIRST_PARTY_MODULES } from "@webcraft/core";
import type { AnyModuleDefinition, ModuleApi } from "@webcraft/module-sdk";

import { sampleBoard } from "../modules/sample/board.ts";
import { sample } from "../modules/sample/index.ts";
import type { TestBrowser } from "./browser.ts";

/** The test suite's sample Modules, which use every extension point of the SDK. */
export const SAMPLE_MODULES: readonly AnyModuleDefinition[] = [sample, sampleBoard];

/**
 * Every Module a test may load: this build's first-party Modules and the samples. Every test
 * database has had their migrations, as an Install's database has had its build's first-party
 * Modules'; a test Install loads those it is given (the first-party ones unless given).
 */
export const TEST_MODULES: readonly AnyModuleDefinition[] = [...FIRST_PARTY_MODULES, ...SAMPLE_MODULES];

/**
 * A Module's procedures, called the way the admin calls them (`m.<module id>.…` in the Management
 * API), typed from its definition: `moduleApi<typeof sample>(browser, "sample").notes.list({ siteId })`.
 */
export function moduleApi<Definition extends AnyModuleDefinition>(
	browser: TestBrowser,
	moduleId: string,
): ModuleApi<Definition> {
	return (browser.api as unknown as { m: Record<string, ModuleApi<Definition>> }).m[moduleId] as ModuleApi<Definition>;
}
