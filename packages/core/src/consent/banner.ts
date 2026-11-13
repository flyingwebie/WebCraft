/**
 * A Site's Consent banner (ADR 0020): how the Site asks visitors which Consent categories they accept.
 *
 * - **The setting** (Structure, `structure.edit`, Staff only, no Draft): its mode and layout. A change
 *   applies at once, clears the page cache (pages carry the banner) and is logged as
 *   `consentBanner.change`.
 * - **Its words** (Content, with a Draft and a published version like the Globals): see `text.ts`.
 *
 * `version` goes up with every change visitors can see (the setting, a publish of the words), and each
 * Consent record names the version it answered.
 */
import { consentBanners } from "@webcraft/db/schema";
import type { PageConsent } from "@webcraft/renderer";
import { eq } from "drizzle-orm";

import type { Languages } from "../content/field-values.ts";
import { clearPageCache } from "../content/page-cache.ts";
import { emptyVersion } from "../content/values.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { publishedWords } from "./text.ts";

/**
 * How a Site asks for consent:
 *
 * - `optIn` (the default): nothing held back loads until the visitor accepts its category;
 * - `optOut`: everything loads until the visitor declines its category;
 * - `none`: no banner, and nothing is held back;
 * - `outside`: an outside consent service asks, WebCraft reads its answer (no banner of WebCraft's).
 */
export const CONSENT_MODES = ["optIn", "optOut", "none", "outside"] as const;

export type ConsentMode = (typeof CONSENT_MODES)[number];

/** How the banner shows: along the bottom (`bar`), in a corner (`box`) or centred and modal (`dialog`). */
export const CONSENT_LAYOUTS = ["bar", "box", "dialog"] as const;

export type ConsentLayout = (typeof CONSENT_LAYOUTS)[number];

/** The banner's setting: see `CONSENT_MODES` and `CONSENT_LAYOUTS`. */
export type ConsentSettings = { mode: ConsentMode; layout: ConsentLayout };

export type ConsentBannerRow = typeof consentBanners.$inferSelect;

/** What reads a Site's banner: any scope of the Site, a visitor's included. */
export type BannerReader = Pick<VisitorScope, "first" | "site">;

/** The Site's banner row, or undefined while the Site has never changed it (the default then holds). */
export function bannerRow(scope: BannerReader): Promise<ConsentBannerRow | undefined> {
	return scope.first(consentBanners);
}

/** The setting a row holds, the default (Opt-in, a bottom bar) without one. */
export function settingsOf(row: ConsentBannerRow | undefined): ConsentSettings & { version: number } {
	return {
		mode: isConsentMode(row?.mode) ? row.mode : "optIn",
		layout: isConsentLayout(row?.layout) ? row.layout : "bar",
		version: row?.version ?? 1,
	};
}

export function isConsentMode(value: unknown): value is ConsentMode {
	return (CONSENT_MODES as readonly unknown[]).includes(value);
}

export function isConsentLayout(value: unknown): value is ConsentLayout {
	return (CONSENT_LAYOUTS as readonly unknown[]).includes(value);
}

/**
 * Changes the banner's setting (open the Site with `structure.edit`). What changed is logged with its
 * old and new value, makes a new banner version and clears the page cache; saving what is already
 * there changes nothing.
 */
export async function setConsentSettings(scope: SiteScope, settings: ConsentSettings): Promise<void> {
	await scope.transaction(async (tx) => {
		const row = await lockBanner(tx);
		const before = settingsOf(row);
		const details: Record<string, { from: string; to: string }> = {};
		if (before.mode !== settings.mode) details.mode = { from: before.mode, to: settings.mode };
		if (before.layout !== settings.layout) details.layout = { from: before.layout, to: settings.layout };
		if (Object.keys(details).length === 0) return;
		await tx.update(
			consentBanners,
			{ mode: settings.mode, layout: settings.layout, version: row.version + 1, updatedAt: tx.now() },
			eq(consentBanners.id, row.id),
		);
		await clearPageCache(tx);
		await tx.audit("consentBanner.change", details);
	});
}

/** Reads the Site's banner for a change, making it the first time, and holds it until the transaction ends. */
export async function lockBanner(scope: SiteScope): Promise<ConsentBannerRow> {
	const now = scope.now();
	await scope.db
		.insert(consentBanners)
		.values({
			workspaceId: scope.workspace.id,
			siteId: scope.site.id,
			draft: emptyVersion(),
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing();
	const [row] = await scope.db.select().from(consentBanners).where(scope.where(consentBanners)).for("update");
	if (!row) throw new Error("The Site's Consent banner could not be made.");
	return row;
}

/**
 * What a visitor's page shows of the Site's banner, in the page's language (its published words,
 * WebCraft's own where nobody wrote one), or undefined with the mode None (nothing is asked).
 */
export async function pageConsent(
	scope: BannerReader,
	languages: Languages,
	/** Which version of its words: the published ones, or the Draft, as the Staging address shows them. */
	which: "published" | "draft" = "published",
): Promise<PageConsent | undefined> {
	const row = await bannerRow(scope);
	const settings = settingsOf(row);
	if (settings.mode === "none") return undefined;
	return {
		mode: settings.mode,
		layout: settings.layout,
		version: settings.version,
		...publishedWords(row, languages, which),
	};
}
