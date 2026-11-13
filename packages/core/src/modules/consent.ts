import { type ModuleManifest, wordsIn } from "@webcraft/module-sdk";

import type { LoadedModule, RunnableModule } from "./registry.ts";

/**
 * What a Module asks for, as the Superadmin approves it: one consent item per grant, such as
 * `permission:sample.notes.edit:owner` (Owners get the Module's Permission to edit notes),
 * `use:email`, `host:api.example.com`, `script:analytics`, or `script:analytics:before-consent` for a
 * Site script that runs before visitors accept its category (SDK 1.4).
 */
function askedItems(manifest: ModuleManifest, beforeConsent: boolean): string[] {
	return [
		...manifest.permissions.flatMap((permission) =>
			permission.roles.map((role) => `permission:${manifest.id}.${permission.key}:${role}`),
		),
		...manifest.uses.map((use) => `use:${use}`),
		...manifest.outsideHosts.map((host) => `host:${host}`),
		...(manifest.siteScript ? [`script:${manifest.siteScript}`] : []),
		...(manifest.siteScript && beforeConsent ? [`script:${manifest.siteScript}:before-consent`] : []),
	];
}

/**
 * The capabilities of a Module that widen what it sees or does, each a consent item of its own and
 * the part of the consent screen's "adds" it is shown as: keeping the Sites' Form Submissions, their
 * Redirect rules (which answer before every page) or their 404 log, answering visitors on Site
 * routes, reacting to an event, importing content from a source.
 */
function capabilities(module: RunnableModule): { item: string; shownAs: Capability }[] {
	return [
		...(module.receiver ? [{ item: "keeps:submissions", shownAs: "submissions" as const }] : []),
		...(module.redirects ? [{ item: "keeps:redirects", shownAs: "redirectRules" as const }] : []),
		...(module.notFoundLog ? [{ item: "keeps:notFoundLog", shownAs: "notFoundLog" as const }] : []),
		...(module.routes.length > 0 ? [{ item: "routes", shownAs: "siteRoutes" as const }] : []),
		...[...module.events].map((event) => ({ item: `event:${event}`, shownAs: "events" as const })),
		...[...module.importSources.keys()].map((key) => ({
			item: `importSource:${key}`,
			shownAs: "importSources" as const,
		})),
	];
}

/** A part of the consent screen's "adds" that an approval covers on its own. */
export type Capability = "submissions" | "redirectRules" | "notFoundLog" | "siteRoutes" | "events" | "importSources";

/**
 * The item of an approval that lists the Module's capabilities with what it asked for. Approvals made
 * before capabilities were consent items don't have it, and say nothing about capabilities: they keep
 * covering whatever the Module does, as they did, until the Module is approved again.
 */
const CAPABILITIES_LISTED = "capabilities";

/**
 * Everything an approval of the Module grants now: what it asks for and its capabilities. An approval
 * stores these; a later version waits for approval when it has an item the approval doesn't.
 */
export function consentItems(module: RunnableModule): string[] {
	return [
		...askedItems(module.manifest, module.siteScript?.beforeConsent === true),
		CAPABILITIES_LISTED,
		...capabilities(module).map((capability) => capability.item),
	];
}

/** The capabilities of the Module that an approval listing capabilities doesn't cover. */
function uncovered(module: RunnableModule, granted: readonly string[]): Capability[] {
	if (!granted.includes(CAPABILITIES_LISTED)) return [];
	const missing = capabilities(module).filter((capability) => !granted.includes(capability.item));
	return [...new Set(missing.map((capability) => capability.shownAs))];
}

/** Whether an approval that granted `granted` covers everything the Module asks for and does. */
export function isCovered(module: RunnableModule, granted: readonly string[]): boolean {
	const asked = askedItems(module.manifest, module.siteScript?.beforeConsent === true);
	return asked.every((item) => granted.includes(item)) && uncovered(module, granted).length === 0;
}

/** What a Module asks for, in the person's language, each marked new when the approval didn't grant it. */
export type ConsentView = {
	permissions: { key: string; label: string; roles: string[]; isNew: boolean }[];
	uses: { use: string; isNew: boolean }[];
	outsideHosts: { host: string; isNew: boolean }[];
	/** The Consent category of the script it adds to Site pages, and whether it runs before visitors accept it. */
	siteScript: { category: string; beforeConsent: boolean; isNew: boolean } | null;
};

/** What a Module adds to WebCraft besides what it asks for, for the consent screen. */
export type AdditionsView = {
	/** Where it answers on Sites (`/_wc/m/sample/`), or null. */
	siteRoutes: string | null;
	/** The labels of its admin pages. */
	adminPages: string[];
	/** How many tables of its own it keeps. */
	tables: number;
	/** The events it reacts to. */
	events: string[];
	/** The names (PascalCase tags) of the Components it adds. */
	components: string[];
	/** Whether it keeps what visitors send through Forms (the Sites' Form Submissions). */
	submissions: boolean;
	/** Whether it keeps the Sites' Redirect rules, which answer before the Sites' own pages (SDK 1.5). */
	redirectRules: boolean;
	/** Whether it keeps the Sites' 404 log, the paths visitors asked for that have no page (SDK 1.5). */
	notFoundLog: boolean;
	/** Its jobs that run on a schedule: how often each runs. */
	schedules: ("hour" | "day")[];
	/** What it imports content from (SDK 1.7): its import sources' labels. */
	importSources: string[];
	/** The capabilities among these that its approval doesn't cover yet: what an update added. */
	unapproved: Capability[];
};

export function consentView(
	manifest: ModuleManifest,
	beforeConsent: boolean,
	granted: readonly string[] | null,
	language: string,
): ConsentView {
	const isNew = (item: string) => granted === null || !granted.includes(item);
	const words = (label: Readonly<Record<string, string>>) => wordsIn(label, language, manifest.adminLanguages);
	return {
		permissions: manifest.permissions.map((permission) => {
			const key = `${manifest.id}.${permission.key}`;
			return {
				key,
				label: words(permission.label),
				roles: [...permission.roles],
				isNew: permission.roles.some((role) => isNew(`permission:${key}:${role}`)),
			};
		}),
		uses: manifest.uses.map((use) => ({ use, isNew: isNew(`use:${use}`) })),
		outsideHosts: manifest.outsideHosts.map((host) => ({ host, isNew: isNew(`host:${host}`) })),
		siteScript: manifest.siteScript
			? {
					category: manifest.siteScript,
					beforeConsent,
					isNew:
						isNew(`script:${manifest.siteScript}`) ||
						(beforeConsent && isNew(`script:${manifest.siteScript}:before-consent`)),
				}
			: null,
	};
}

export function additionsView(
	module: LoadedModule,
	granted: readonly string[] | null,
	language: string,
): AdditionsView {
	if (!module.runnable) {
		return {
			siteRoutes: null,
			adminPages: [],
			tables: 0,
			events: [],
			components: [],
			submissions: false,
			redirectRules: false,
			notFoundLog: false,
			schedules: [],
			importSources: [],
			unapproved: [],
		};
	}
	const { manifest } = module;
	return {
		siteRoutes: module.routes.length > 0 ? `/_wc/m/${manifest.routePrefix}/` : null,
		adminPages: module.pages.map((page) => wordsIn(page.label, language, manifest.adminLanguages)),
		tables: module.tables.size,
		events: [...module.events],
		components: module.components.map((component) => component.name),
		submissions: module.receiver !== null,
		redirectRules: module.redirects !== null,
		notFoundLog: module.notFoundLog !== null,
		schedules: module.schedules.map((schedule) => schedule.every),
		importSources: [...module.importSources.values()].map((source) =>
			wordsIn(source.label, language, manifest.adminLanguages),
		),
		unapproved: granted === null ? [] : uncovered(module, granted),
	};
}
