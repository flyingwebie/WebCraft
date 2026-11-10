import extraBlocks from "@webcraft/module-extra-blocks";
import forms from "@webcraft/module-forms";
import popups from "@webcraft/module-popups";
import redirects from "@webcraft/module-redirects";
import type { ModuleDefinition } from "@webcraft/module-sdk";
import siteAnalytics from "@webcraft/module-site-analytics";
import wordpressImport from "@webcraft/module-wordpress-import";

/**
 * The first-party Modules this build of WebCraft loads (ADR 0024): Site analytics, Forms, Popups,
 * Redirects and 404 log, Extra blocks and WordPress import, as each one's ticket adds it. Each is a
 * workspace package under `modules/<id>` that imports only `@webcraft/module-sdk`; add its default
 * export here (and the package to `@webcraft/core`'s dependencies). Web, worker and the `migrate`
 * step all load this list, so every process runs the same Modules.
 */
export const FIRST_PARTY_MODULES: readonly ModuleDefinition[] = [
	forms,
	popups,
	siteAnalytics,
	redirects,
	wordpressImport,
	extraBlocks,
];
