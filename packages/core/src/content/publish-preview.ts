import {
	components,
	consentBanners,
	designSystems,
	entries,
	forms,
	globals,
	loops,
	scripts,
	templates,
} from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import { FormNotFoundError } from "../forms/errors.ts";
import { isUuid } from "../ids.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import {
	ComponentNotFoundError,
	EntryNotFoundError,
	LoopNotFoundError,
	ScriptNotFoundError,
	TemplateNotFoundError,
} from "./errors.ts";
import { siteLanguages } from "./languages.ts";
import type { PublishItem } from "./publishing.ts";
import { ownValue, storedVersion } from "./values.ts";

/**
 * What publishing an item would do, as an API client is shown it before it confirms (spec ›
 * Management API: publishing takes a preview and a confirmation for API clients). `version` names
 * the Draft that would go live: a confirmation holds only while the Draft stays the same.
 */
export type PublishPreview = {
	item: PublishItem;
	/** Its title or name, where it has one (an Entry's title in the Default language). */
	name: string | null;
	/** Never published yet: visitors see it for the first time. */
	firstPublish: boolean;
	/** Whether its Draft differs from what visitors see now. */
	changed: boolean;
	/** The Draft that would be published: 16 hexadecimal digits of its SHA-256. */
	version: string;
};

/** What publishing `item` would do now, without publishing anything. Throws as publishing would for an item that isn't there. */
export async function publishPreview(scope: SiteScope, item: PublishItem): Promise<PublishPreview> {
	const versions = async (draft: unknown, published: unknown, name: string | null = null) => ({
		item,
		name,
		firstPublish: published === null || published === undefined,
		changed: JSON.stringify(draft ?? null) !== JSON.stringify(published ?? null),
		version: await versionOf(draft ?? null),
	});
	const byId = <T>(row: T | undefined, missing: () => Error): T => {
		if (!row) throw missing();
		return row;
	};
	switch (item.kind) {
		case "entry": {
			const row = byId(
				isUuid(item.id) ? await scope.first(entries, eq(entries.id, item.id)) : undefined,
				() => new EntryNotFoundError(),
			);
			const { defaultLanguage } = await siteLanguages(scope);
			return versions(row.draft, row.published, ownValue(storedVersion(row.draft), "title", defaultLanguage));
		}
		case "template": {
			const row = byId(
				isUuid(item.id) ? await scope.first(templates, eq(templates.id, item.id)) : undefined,
				() => new TemplateNotFoundError(),
			);
			return versions(row.draft, row.published);
		}
		case "component": {
			const row = byId(
				isUuid(item.id) ? await scope.first(components, eq(components.id, item.id)) : undefined,
				() => new ComponentNotFoundError(),
			);
			return versions(row.draft, row.published, row.name);
		}
		case "loop": {
			const row = byId(
				isUuid(item.id) ? await scope.first(loops, eq(loops.id, item.id)) : undefined,
				() => new LoopNotFoundError(),
			);
			return versions(row.draft, row.published, row.name);
		}
		case "script": {
			const row = byId(
				isUuid(item.id) ? await scope.first(scripts, eq(scripts.id, item.id)) : undefined,
				() => new ScriptNotFoundError(),
			);
			return {
				item,
				name: null,
				firstPublish: row.publishedHash === null,
				changed: row.draftHash !== row.publishedHash,
				version: row.draftHash,
			};
		}
		case "form": {
			const row = byId(
				isUuid(item.id) ? await scope.first(forms, eq(forms.id, item.id)) : undefined,
				() => new FormNotFoundError(),
			);
			return versions(row.draft, row.published, row.name);
		}
		case "globals": {
			const row = await scope.first(globals);
			return versions(row?.draft, row?.published);
		}
		case "consentBanner": {
			const row = await scope.first(consentBanners);
			return versions(row?.draft, row?.published);
		}
		case "designSystem": {
			const row = await scope.first(designSystems);
			return versions(row?.draft, row?.published);
		}
	}
}

async function versionOf(value: unknown): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
	return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
