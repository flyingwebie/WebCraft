/**
 * Site script safety (ADRs 0022, 0023): a Site's Content Security Policy, its outside scripts and its
 * Libraries, all Structure that Staff manage (`structure.edit`), and what each page loads of them.
 */
import type { GuardedFetch } from "../guarded-fetch.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import {
	addAllowedHost,
	type CspSettings,
	getCsp,
	type ModuleOutsideHost,
	removeAllowedHost,
	setCspMode,
} from "./csp.ts";
import {
	addLibrary,
	checkLibraryUpdates,
	type Library,
	type LibraryInput,
	listLibraries,
	removeLibrary,
	updateLibrary,
} from "./libraries.ts";
import {
	addOutsideScript,
	listOutsideScripts,
	type OutsideScript,
	type OutsideScriptInput,
	removeOutsideScript,
	updateOutsideScript,
} from "./outside-scripts.ts";
import type { CspMode } from "./policy.ts";

export type { AllowedHost, CspSettings, ModuleOutsideHost } from "./csp.ts";
export {
	LibraryNotFoundError,
	type LibraryProblem,
	LibraryRefusedError,
	OutsideScriptNotFoundError,
	TooManyHostsError,
} from "./errors.ts";
export {
	LIBRARIES_PER_SITE,
	LIBRARY_MAX_BYTES,
	LIBRARY_PATH,
	type Library,
	type LibraryFile,
	type LibraryInput,
} from "./libraries.ts";
export { LIBRARY_ARCHIVE_UNPACKED_MAX_BYTES, NPM_REGISTRY } from "./npm.ts";
export {
	CONSENT_CATEGORIES,
	OUTSIDE_SCRIPT_NAME_MAX_LENGTH,
	OUTSIDE_SCRIPT_PLACEMENTS,
	OUTSIDE_SCRIPTS_PER_SITE,
	type OutsideScript,
	type OutsideScriptInput,
	type OutsideScriptPlacement,
} from "./outside-scripts.ts";
export {
	ALLOWED_HOSTS_PER_SITE,
	CSP_MODES,
	type CspMode,
	editModePolicy,
	FILE_POLICY,
	HostInvalidError,
	MEDIA_POLICY,
	mediaPolicy,
	pagePolicyHeaders,
	readHost,
	SITE_SECURITY_HEADERS,
	SVG_POLICY,
} from "./policy.ts";
export { RETIRED_FILE_LIFETIME_MS, siteFilesPurge, siteFilesPurgeSchedule } from "./retired.ts";
export { SNIPPET_MAX_LENGTH, SnippetInvalidError, type SnippetProblem } from "./snippets.ts";

/** What Staff do with a Site's script safety, each on a Site opened with `structure.edit`. */
export type SiteScripts = {
	/** The Site's policy: its mode, its allowed hosts and the hosts of the Modules running on it (named in `language`). */
	csp(scope: SiteScope, language: string): Promise<CspSettings>;
	setCspMode(scope: SiteScope, mode: CspMode, language: string): Promise<CspSettings>;
	addAllowedHost(scope: SiteScope, host: string, language: string): Promise<CspSettings>;
	removeAllowedHost(scope: SiteScope, host: string, language: string): Promise<CspSettings>;
	outsideScripts: {
		list(scope: SiteScope): Promise<OutsideScript[]>;
		add(scope: SiteScope, input: OutsideScriptInput): Promise<OutsideScript>;
		update(scope: SiteScope, outsideScriptId: string, input: OutsideScriptInput): Promise<OutsideScript>;
		remove(scope: SiteScope, outsideScriptId: string): Promise<void>;
	};
	libraries: {
		list(scope: SiteScope): Promise<Library[]>;
		add(scope: SiteScope, input: LibraryInput): Promise<Library>;
		update(scope: SiteScope, libraryId: string, version?: string): Promise<Library>;
		remove(scope: SiteScope, libraryId: string): Promise<void>;
		checkUpdates(scope: SiteScope): Promise<Library[]>;
	};
};

export function createSiteScripts(options: {
	fetch: GuardedFetch;
	storage: InstallStorage;
	/** The outside hosts of the Modules running on a Site. */
	moduleHosts(site: SiteScope["site"], language: string): Promise<ModuleOutsideHost[]>;
}): SiteScripts {
	const deps = { fetch: options.fetch, storage: options.storage };
	const csp = async (scope: SiteScope, language: string) =>
		getCsp(scope, await options.moduleHosts(scope.site, language));
	return {
		csp,
		async setCspMode(scope, mode, language) {
			await setCspMode(scope, mode);
			return csp(scope, language);
		},
		async addAllowedHost(scope, host, language) {
			await addAllowedHost(scope, host);
			return csp(scope, language);
		},
		async removeAllowedHost(scope, host, language) {
			await removeAllowedHost(scope, host);
			return csp(scope, language);
		},
		outsideScripts: {
			list: listOutsideScripts,
			add: addOutsideScript,
			update: updateOutsideScript,
			remove: removeOutsideScript,
		},
		libraries: {
			list: listLibraries,
			add: (scope, input) => addLibrary(scope, deps, input),
			update: (scope, libraryId, version) => updateLibrary(scope, deps, libraryId, version),
			remove: removeLibrary,
			checkUpdates: (scope) => checkLibraryUpdates(scope, deps),
		},
	};
}
