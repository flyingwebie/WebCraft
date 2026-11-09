import { media } from "@webcraft/db/schema";
import { type BodyCheck, type BodyCheckKind, bodyChecks, storedBlocks } from "@webcraft/renderer";
import { inArray } from "drizzle-orm";

import { isUuid } from "../ids.ts";
import { readText, storedTexts } from "../media/texts.ts";
import type { SeoCheckKind } from "../seo/seo-rules.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import type { FieldDefinition, Json } from "./field-types.ts";

/**
 * A Check on an Entry (`GLOSSARY.md`): a warning shown while it is edited, which never stops it
 * being published. `at` is where it is (`fields.body[3]`, a Body field's fourth Block; `seo.title`),
 * `check` what it is about, for the admin to word, and `detail` the words it is about (a vague link's
 * text). Body fields' Checks come from here, the SEO check's from `seo/checks.ts`.
 */
export type EntryCheck = {
	at: string;
	check: BodyCheckKind | SeoCheckKind;
	message: string;
	detail?: string;
	/** The numbers the Check's words need (the SEO check's lengths). */
	params?: Readonly<Record<string, number>>;
};

const MESSAGES: Readonly<Record<BodyCheckKind, (detail: string | undefined) => string>> = {
	skippedHeading: (detail) =>
		`A heading skips a level (${detail}): people using screen readers find their way by heading levels.`,
	missingAlt: () => "An image has no alt text in the Media library.",
	vagueLink: (detail) => `A link's text ("${detail}") doesn't say where it goes.`,
	tableHeader: () => "A table has no header row.",
	untitledVideo: () => "A video has no title for people who can't see it.",
};

/**
 * The Checks the Body fields of Entries' values raise, one list per set of values, in a language:
 * what the admin shows next to each body while it is written. The Site's list of open Checks (#95)
 * collects them with those of Templates and pages.
 */
export async function bodyChecksOf(
	scope: Pick<SiteScope, "select">,
	fields: readonly FieldDefinition[],
	valueSets: readonly Readonly<Record<string, Json>>[],
	languages: { language: string; defaultLanguage: string },
): Promise<EntryCheck[][]> {
	const bodies = fields.filter((field) => field.type === "body");
	if (bodies.length === 0) return valueSets.map(() => []);
	const images = new Set<string>();
	for (const values of valueSets) {
		for (const body of bodies) {
			for (const block of storedBlocks(values[body.key])) {
				if (block.type === "image" && block.media && isUuid(block.media)) images.add(block.media);
			}
		}
	}
	const alts = new Map<string, string | null>();
	if (images.size > 0) {
		for (const row of await scope.select(media, inArray(media.id, [...images]))) {
			alts.set(row.id, readText(storedTexts(row.texts), "alt", languages));
		}
	}
	return valueSets.map((values) =>
		bodies.flatMap((body) =>
			bodyChecks(storedBlocks(values[body.key]), { language: languages.language, altOf: (id) => alts.get(id) }).map(
				(check) => entryCheck(`fields.${body.key}`, check),
			),
		),
	);
}

function entryCheck(at: string, check: BodyCheck): EntryCheck {
	return {
		at: `${at}[${check.index}]`,
		check: check.check,
		message: MESSAGES[check.check](check.detail),
		...(check.detail === undefined ? {} : { detail: check.detail }),
	};
}
