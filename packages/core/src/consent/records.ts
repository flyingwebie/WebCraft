/**
 * Consent records (GLOSSARY.md): the proof of one visitor's choice on a Site's Consent banner. A
 * record holds a random id, the time, the choices, the banner version and the language, and nothing
 * that identifies the visitor: the client address only counts towards the per-address limit, and is
 * never kept. Records are kept 12 months (`consent.purge-records`, daily).
 */
import type { Database } from "@webcraft/db";
import { consentRecords } from "@webcraft/db/schema";
import { CHOSEN_CATEGORIES, type ChosenCategory } from "@webcraft/renderer";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";

import type { Clock } from "../clock.ts";
import { siteLanguages } from "../content/languages.ts";
import { isUuid } from "../ids.ts";
import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import type { RateLimitRule, RateLimits } from "../rate-limits.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { bannerRow, settingsOf } from "./banner.ts";

/** How many choices one client address may record on a Site in a minute. */
export const CONSENT_RECORD_LIMIT: RateLimitRule = { limit: 10, windowMs: 60_000 };

/** How long records are kept, in months. */
export const CONSENT_RECORD_MONTHS = 12;

/** What a visitor chose: whether each category is accepted (Necessary always is). */
export type ConsentChoices = Record<ChosenCategory, boolean>;

/** One Consent record. */
export type ConsentRecord = {
	id: string;
	createdAt: Date;
	choices: { necessary: true } & ConsentChoices;
	bannerVersion: number;
	language: string;
};

/** A choice as the consent script sends it: exactly the three categories, a banner version and a language. */
const choiceInput = z
	.object({
		choices: z.object({ analytics: z.boolean(), marketing: z.boolean(), media: z.boolean() }).strict(),
		version: z.number().int().min(1),
		language: z.string().max(35),
	})
	.strict();

/** What recording a choice did. */
export type RecordAnswer =
	| { kind: "recorded"; id: string; version: number; choices: ConsentChoices }
	/** The Site doesn't ask with a banner of its own (None, or an outside consent service). */
	| { kind: "notAsked" }
	/** The choice doesn't say what was chosen, or names a version or language the Site doesn't have. */
	| { kind: "invalid" }
	/** Too many choices from this address in the last minute. */
	| { kind: "limited"; retryAfterSeconds: number };

/** The record with this id, of the Site's; refused as not found otherwise. */
export class ConsentRecordNotFoundError extends Error {
	override name = "ConsentRecordNotFoundError";
	constructor() {
		super("There is no such Consent record on this Site.");
	}
}

/**
 * Records a visitor's choice on the Site's banner. Only a Site asking with its own banner (Opt-in or
 * Opt-out) records; the choice must name the three categories, a banner version the Site has had
 * and one of its languages. Each client address may record `CONSENT_RECORD_LIMIT` choices a minute
 * on a Site. The record is the one thing a visitor's request writes: through the visitor scope's
 * database, with the Site filled in.
 */
export async function recordConsent(
	scope: VisitorScope,
	input: unknown,
	limiter: { rateLimits: RateLimits; clientAddress: string | null },
): Promise<RecordAnswer> {
	const settings = settingsOf(await bannerRow(scope));
	if (settings.mode !== "optIn" && settings.mode !== "optOut") return { kind: "notAsked" };
	const read = choiceInput.safeParse(input);
	if (!read.success || read.data.version > settings.version) return { kind: "invalid" };
	const { languages } = await siteLanguages(scope);
	if (!languages.some((language) => language.code === read.data.language)) return { kind: "invalid" };
	const key = `consent:${scope.site.id}:${limiter.clientAddress ?? "unknown"}`;
	if (!(await limiter.rateLimits.count(key, CONSENT_RECORD_LIMIT))) {
		return { kind: "limited", retryAfterSeconds: CONSENT_RECORD_LIMIT.windowMs / 1000 };
	}
	const id = crypto.randomUUID();
	const choices = read.data.choices;
	await scope.db.insert(consentRecords).values({
		id,
		workspaceId: scope.site.workspaceId,
		siteId: scope.site.id,
		createdAt: scope.now(),
		choices,
		bannerVersion: read.data.version,
		language: read.data.language,
	});
	return { kind: "recorded", id, version: read.data.version, choices };
}

/** One of the Site's Consent records (open the Site with `site.view`): `ConsentRecordNotFoundError` for any other id. */
export async function findConsentRecord(scope: SiteScope, recordId: string): Promise<ConsentRecord> {
	const row = isUuid(recordId) ? await scope.first(consentRecords, eq(consentRecords.id, recordId)) : undefined;
	if (!row) throw new ConsentRecordNotFoundError();
	const stored = (row.choices ?? {}) as Partial<ConsentChoices>;
	const choices = Object.fromEntries(CHOSEN_CATEGORIES.map((category) => [category, stored[category] === true]));
	return {
		id: row.id,
		createdAt: row.createdAt,
		choices: { necessary: true, ...(choices as ConsentChoices) },
		bannerVersion: row.bannerVersion,
		language: row.language,
	};
}

/** Deletes every Site's Consent records older than `CONSENT_RECORD_MONTHS`; answers how many. */
export async function purgeConsentRecords(database: Database, clock: Clock): Promise<number> {
	const cutoff = clock.now();
	cutoff.setUTCMonth(cutoff.getUTCMonth() - CONSENT_RECORD_MONTHS);
	const deleted = await database.db
		.delete(consentRecords)
		.where(and(lt(consentRecords.createdAt, cutoff)))
		.returning({ id: consentRecords.id });
	return deleted.length;
}

/** Deletes Consent records once they are 12 months old. */
export const consentRecordsPurge = defineJob({
	name: "consent.purge-records",
	payload: z.object({}),
	async run(_payload, { database, clock, log }) {
		const deleted = await purgeConsentRecords(database, clock);
		if (deleted > 0) log.info("Deleted Consent records older than 12 months", { deleted });
	},
});

/** The Consent record purge runs every day at 04:41 UTC. */
export const consentRecordsPurgeSchedule = defineSchedule({
	job: consentRecordsPurge,
	cron: "41 4 * * *",
	payload: {},
});
