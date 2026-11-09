import { type ModuleManifest, wordsIn } from "@webcraft/module-sdk";

import type { LoadedModule } from "./registry.ts";

/**
 * What a Module asks for, as the Superadmin approves it: one consent item per grant, such as
 * `permission:sample.notes.edit:owner` (Owners get the Module's Permission to edit notes),
 * `use:email`, `host:api.example.com`, `script:analytics`, or `script:analytics:before-consent` for a
 * Site script that runs before visitors accept its category (SDK 1.4). An approval stores the items
 * it granted; a later version asks for more when it has an item the approval doesn't.
 */
export function consentItems(manifest: ModuleManifest, beforeConsent = false): string[] {
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

/** Whether everything `manifest` asks for was granted. */
export function isCovered(manifest: ModuleManifest, granted: readonly string[], beforeConsent = false): boolean {
	return consentItems(manifest, beforeConsent).every((item) => granted.includes(item));
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

export function additionsView(module: LoadedModule, language: string): AdditionsView {
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
	};
}
