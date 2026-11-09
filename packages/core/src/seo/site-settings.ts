import { globals, seoSettings } from "@webcraft/db/schema";

import type { ContentProblem } from "../content/errors.ts";
import { storedFields } from "../content/fields.ts";
import { clearPageCache } from "../content/page-cache.ts";
import { isUuid } from "../ids.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { isSocialImageOf } from "./entry-seo.ts";
import { DEFAULT_SEPARATOR, fieldAt, SEPARATOR_MAX_LENGTH } from "./seo-rules.ts";

/**
 * The organisation behind a Site, as structured data on every page shows it (the SEO decision): an
 * Organization or a LocalBusiness, its name (null for the Site's), its logo (a Media image), its
 * profiles elsewhere (`sameAs`, https addresses), and the Globals its telephone, email and address come
 * from (by path, such as `phone` or `contact.email`; null for none).
 */
export type SeoOrganization = {
	kind: OrganizationKind;
	name: string | null;
	logo: string | null;
	sameAs: string[];
	telephone: string | null;
	email: string | null;
	address: string | null;
};

export const ORGANIZATION_KINDS = ["organization", "localBusiness"] as const;
export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];

/** The Globals an Organisation's details can come from. */
export const ORGANIZATION_GLOBALS = ["telephone", "email", "address"] as const;

/**
 * A Site's SEO settings (Structure, Staff only, applied at once like other Site settings, ADR 0014):
 * the name titles and structured data give the Site (null for its own name), the separator title
 * patterns put between their parts, the social image of every page without one of its own, and its
 * organisation.
 */
export type SiteSeoSettings = {
	siteName: string | null;
	separator: string;
	defaultImage: string | null;
	organization: SeoOrganization;
};

/** A change to a Site's SEO settings: each given replaces that setting (the organisation part by part). */
export type SiteSeoChange = {
	siteName?: string | null;
	separator?: string;
	defaultImage?: string | null;
	organization?: Partial<Record<keyof SeoOrganization, unknown>>;
};

/** The most characters of a Site's name for titles and of an organisation's name. */
export const SEO_NAME_MAX_LENGTH = 100;

/** How many profiles elsewhere an organisation lists at most. */
export const SAME_AS_MAX = 20;

/** A Site's SEO settings can't be saved: `problems` says what and where. */
export class SeoSettingsInvalidError extends Error {
	override name = "SeoSettingsInvalidError";
	readonly problems: readonly ContentProblem[];
	constructor(problems: readonly ContentProblem[]) {
		super(
			`The SEO settings can't be saved: ${problems.map((problem) => `${problem.at}: ${problem.message}`).join("; ")}`,
		);
		this.problems = problems;
	}
}

/** The defaults until a Site changes its SEO settings. */
export function defaultSeoSettings(): SiteSeoSettings {
	return {
		siteName: null,
		separator: DEFAULT_SEPARATOR,
		defaultImage: null,
		organization: {
			kind: "organization",
			name: null,
			logo: null,
			sameAs: [],
			telephone: null,
			email: null,
			address: null,
		},
	};
}

/** A Site's SEO settings (everyone who sees the Site reads them; pages read them through the visitors' scope). */
export async function siteSeoSettings(scope: Pick<SiteScope, "first">): Promise<SiteSeoSettings> {
	const row = await scope.first(seoSettings);
	return row ? settingsOf(row) : defaultSeoSettings();
}

function settingsOf(row: typeof seoSettings.$inferSelect): SiteSeoSettings {
	const defaults = defaultSeoSettings();
	const stored = (row.organization ?? {}) as Partial<Record<keyof SeoOrganization, unknown>>;
	const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
	return {
		siteName: row.siteName,
		separator: row.separator,
		defaultImage: row.defaultImage,
		organization: {
			kind: stored.kind === "localBusiness" ? "localBusiness" : "organization",
			name: text(stored.name),
			logo: text(stored.logo),
			sameAs: Array.isArray(stored.sameAs)
				? stored.sameAs.filter((item): item is string => typeof item === "string")
				: [],
			telephone: text(stored.telephone) ?? defaults.organization.telephone,
			email: text(stored.email) ?? defaults.organization.email,
			address: text(stored.address) ?? defaults.organization.address,
		},
	};
}

/**
 * Changes a Site's SEO settings (open the Site with `structure.edit`). They apply at once: the Site's
 * page cache is cleared and the change is logged as `seoSettings.change`.
 */
export async function updateSiteSeoSettings(scope: SiteScope, change: SiteSeoChange): Promise<SiteSeoSettings> {
	return scope.transaction(async (tx) => {
		const current = await siteSeoSettings(tx);
		const problems: ContentProblem[] = [];
		const next: SiteSeoSettings = { ...current, organization: { ...current.organization } };
		if (change.siteName !== undefined) {
			const name = (change.siteName ?? "").trim();
			if (name.length > SEO_NAME_MAX_LENGTH) {
				problems.push({
					at: "siteName",
					message: `A Site's name has at most ${SEO_NAME_MAX_LENGTH} characters.`,
					rule: "seoSiteNameLength",
					params: { max: SEO_NAME_MAX_LENGTH },
				});
			} else next.siteName = name || null;
		}
		if (change.separator !== undefined) {
			const separator = change.separator.trim();
			if (separator === "" || [...separator].length > SEPARATOR_MAX_LENGTH || /[{}<>]/.test(separator)) {
				problems.push({
					at: "separator",
					message: `A separator has 1 to ${SEPARATOR_MAX_LENGTH} characters, such as · or |.`,
					rule: "seoSeparator",
					params: { max: SEPARATOR_MAX_LENGTH },
				});
			} else next.separator = separator;
		}
		if (change.defaultImage !== undefined) {
			const image = await imageSetting(tx, "defaultImage", change.defaultImage, problems);
			if (image !== undefined) next.defaultImage = image;
		}
		if (change.organization !== undefined) {
			await changeOrganization(tx, next.organization, change.organization, problems);
		}
		if (problems.length > 0) throw new SeoSettingsInvalidError(problems);

		const now = tx.now();
		const values = {
			siteName: next.siteName,
			separator: next.separator,
			defaultImage: next.defaultImage,
			organization: next.organization,
			updatedAt: now,
		};
		const [row] = await tx.update(seoSettings, values);
		if (!row) await tx.insert(seoSettings, { ...values, createdAt: now });
		await clearPageCache(tx);
		await tx.audit("seoSettings.change", {
			changed: Object.keys(change).filter((key) => change[key as keyof SiteSeoChange] !== undefined),
		});
		return next;
	});
}

/** A Media image a setting names: null to clear it; undefined (with a problem) when it can't be one. */
async function imageSetting(
	scope: SiteScope,
	at: string,
	value: unknown,
	problems: ContentProblem[],
): Promise<string | null | undefined> {
	if (value === null || value === "") return null;
	if (typeof value === "string" && isUuid(value) && (await isSocialImageOf(scope, value))) return value.toLowerCase();
	problems.push({
		at,
		message: "Choose a JPEG, PNG, WebP, AVIF or GIF image of the Site's Media library.",
		rule: "seoImage",
	});
	return undefined;
}

async function changeOrganization(
	scope: SiteScope,
	organization: SeoOrganization,
	change: Partial<Record<keyof SeoOrganization, unknown>>,
	problems: ContentProblem[],
): Promise<void> {
	if (change.kind !== undefined) {
		if ((ORGANIZATION_KINDS as readonly unknown[]).includes(change.kind)) {
			organization.kind = change.kind as OrganizationKind;
		} else {
			problems.push({
				at: "organization.kind",
				message: "An organisation is an Organization or a LocalBusiness.",
				rule: "seoOrganizationKind",
			});
		}
	}
	if (change.name !== undefined) {
		const name = typeof change.name === "string" ? change.name.trim() : "";
		if (name.length > SEO_NAME_MAX_LENGTH) {
			problems.push({
				at: "organization.name",
				message: `An organisation's name has at most ${SEO_NAME_MAX_LENGTH} characters.`,
				rule: "seoOrganizationName",
				params: { max: SEO_NAME_MAX_LENGTH },
			});
		} else organization.name = name || null;
	}
	if (change.logo !== undefined) {
		const logo = await imageSetting(scope, "organization.logo", change.logo, problems);
		if (logo !== undefined) organization.logo = logo;
	}
	if (change.sameAs !== undefined) {
		const list = Array.isArray(change.sameAs) ? change.sameAs : [];
		const wrong = list.findIndex((item) => typeof item !== "string" || !isProfileAddress(item.trim()));
		if (!Array.isArray(change.sameAs) || list.length > SAME_AS_MAX || wrong >= 0) {
			problems.push({
				at: wrong >= 0 ? `organization.sameAs[${wrong}]` : "organization.sameAs",
				message: `Up to ${SAME_AS_MAX} https addresses of the organisation's profiles elsewhere.`,
				rule: "seoSameAs",
				params: { max: SAME_AS_MAX },
			});
		} else organization.sameAs = [...new Set(list.map((item) => (item as string).trim()))];
	}
	const globalsRow = await scope.first(globals);
	const globalFields = storedFields(globalsRow?.fields);
	for (const key of ORGANIZATION_GLOBALS) {
		const path = change[key];
		if (path === undefined) continue;
		if (path === null || path === "") {
			organization[key] = null;
			continue;
		}
		const located = typeof path === "string" ? fieldAt(globalFields, path) : undefined;
		if (!located || located.repeater || !["text", "richText", "email"].includes(located.field.type)) {
			problems.push({
				at: `organization.${key}`,
				message: "Choose a text, rich text or email Global.",
				rule: "seoGlobal",
				params: { global: String(path) },
			});
			continue;
		}
		organization[key] = path as string;
	}
}

/** An https address of a profile elsewhere (a social network, a directory). */
function isProfileAddress(text: string): boolean {
	if (text.length > 500) return false;
	try {
		const url = new URL(text);
		return url.protocol === "https:" && url.hostname.includes(".") && !url.username && !url.password;
	} catch {
		return false;
	}
}
