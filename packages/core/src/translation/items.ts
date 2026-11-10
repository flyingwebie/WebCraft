import { entries, forms, globals, popups } from "@webcraft/db/schema";
import type { FormEmails, FormText } from "@webcraft/renderer";
import { asc, eq } from "drizzle-orm";
import { writeEntryTranslations } from "../content/entries.ts";
import type { FieldDefinition } from "../content/field-types.ts";
import type { StoredValues } from "../content/field-values.ts";
import { storedFields } from "../content/fields.ts";
import { writeGlobalsTranslations } from "../content/globals.ts";
import { getPostType, listPostTypes } from "../content/post-types.ts";
import { readValue, storedVersion } from "../content/values.ts";
import { hiddenLanguagesIn } from "../content/visibility.ts";
import { type FormEmailsVersions, formEmailsVersions, writeFormEmailsTranslations } from "../forms/forms.ts";
import { noteDraftChange } from "../history/checkpoints.ts";
import { saveRevision } from "../history/copies.ts";
import { isUuid } from "../ids.ts";
import { lockPopup, POPUP_FIELDS } from "../popups/index.ts";
import type { BackgroundScope, SiteScope } from "../tenancy/data-layer.ts";
import { entryFields, type StoredLeaf, textField, type Unit, unitsOf } from "./units.ts";

/**
 * What AI translation translates, item by item: an Entry (its title, Translatable fields and SEO title
 * and description), the Globals, and a Form's emails (its Auto-reply's subject and text). Each is read
 * as stored values per language, so the engine, Outdated translations and the Translations screen
 * treat them alike, and written back where it lives.
 */

export type ItemKind = "entry" | "globals" | "formEmails" | "popupContent";

/** An item: an Entry or a Form by id; the Site's Globals have none. */
export type ItemRef =
	| { kind: "entry"; id: string }
	| { kind: "globals" }
	| { kind: "formEmails"; id: string }
	| { kind: "popupContent"; id: string };

/** An item as translations read it. */
export type ItemSnapshot = {
	ref: ItemRef;
	/** What people call it: an Entry's title, "Globals", a Form's name. */
	title: string;
	postTypeId: string | null;
	draft: StoredValues;
	published: StoredValues | null;
	/** The translatable values of a version. */
	units(values: StoredValues): Unit[];
	/** The languages it is hidden in (an Entry's Language visibility): never translated there. */
	hiddenLanguages: string[];
};

/** What a write changes; unchanged when absent. */
export type ItemWrite = { draft?: StoredValues; published?: StoredValues } | null;

/** A Form's emails as values: its Auto-reply's subject and text (Notifications go out in the Default language only). */
const FORM_EMAIL_FIELDS: FieldDefinition[] = [
	{
		key: "autoReply",
		label: "Auto-reply",
		type: "group",
		help: "",
		required: false,
		translatable: false,
		default: null,
		fields: [textField("subject", "Subject"), textField("text", "Text")],
	} as FieldDefinition,
];

const FORM_EMAIL_PARTS = ["subject", "text"] as const;

type Marks = Record<string, Record<string, { text: string; source: string }>>;

/** A Form's emails as stored values: the text as written is the Default language's; the AI's translations say so. */
function emailValues(emails: FormEmails, marks: Marks, defaultLanguage: string): StoredValues {
	const leaf = (text: FormText, path: string): StoredLeaf => {
		const out: StoredLeaf = { [defaultLanguage]: { value: text.text, by: null } };
		for (const [language, translation] of Object.entries(text.translations ?? {})) {
			const mark = marks[language]?.[path];
			out[language] =
				mark && mark.text === translation
					? { value: translation, by: { kind: "ai" }, source: mark.source }
					: { value: translation, by: null };
		}
		return out;
	};
	return {
		autoReply: {
			values: Object.fromEntries(
				FORM_EMAIL_PARTS.map((part) => [part, leaf(emails.autoReply[part], `autoReply.${part}`)]),
			),
		},
	};
}

/** Stored values back into a Form's emails, with the AI's translations noted (`marks`, changed in place). */
function emailsFrom(values: StoredValues, emails: FormEmails, marks: Marks, defaultLanguage: string): FormEmails {
	const parts = (values.autoReply as { values?: Record<string, StoredLeaf> } | undefined)?.values ?? {};
	const autoReply = { ...emails.autoReply };
	for (const part of FORM_EMAIL_PARTS) {
		const path = `autoReply.${part}`;
		const leaf = parts[part] ?? {};
		const translations: Record<string, string> = {};
		for (const [language, value] of Object.entries(leaf)) {
			if (language === defaultLanguage || typeof value?.value !== "string" || value.value === "") continue;
			translations[language] = value.value;
			const languageMarks = { ...(marks[language] ?? {}) };
			if (value.by?.kind === "ai" && typeof value.source === "string") {
				languageMarks[path] = { text: value.value, source: value.source };
			} else if (languageMarks[path]?.text !== value.value) {
				delete languageMarks[path];
			}
			marks[language] = languageMarks;
		}
		autoReply[part] =
			Object.keys(translations).length > 0
				? { text: autoReply[part].text, translations }
				: { text: autoReply[part].text };
	}
	return { ...emails, autoReply };
}

/** Reads an item; null when it is gone. */
export async function readItem(
	scope: SiteScope | BackgroundScope,
	ref: ItemRef,
	defaultLanguage: string,
): Promise<ItemSnapshot | null> {
	if (ref.kind === "popupContent") {
		const row = await scope.first(popups, eq(popups.id, ref.id));
		return row
			? {
					ref,
					title: row.name,
					postTypeId: null,
					draft: storedVersion(row.contentDraft).values,
					published: row.contentPublished ? storedVersion(row.contentPublished).values : null,
					units: (values) => unitsOf(values, POPUP_FIELDS),
					hiddenLanguages: [],
				}
			: null;
	}
	if (ref.kind === "entry") {
		const row = isUuid(ref.id) ? await scope.first(entries, eq(entries.id, ref.id)) : undefined;
		if (!row) return null;
		const postType = await getPostType(scope as SiteScope, row.postTypeId);
		const draft = storedVersion(row.draft);
		return {
			ref,
			title: readValue(draft, { key: "title", language: defaultLanguage, defaultLanguage }) ?? "",
			postTypeId: row.postTypeId,
			draft: draft.values,
			published: row.published === null ? null : storedVersion(row.published).values,
			units: (values) => unitsOf(values, entryFields(postType)),
			hiddenLanguages: hiddenLanguagesIn(draft, defaultLanguage),
		};
	}
	if (ref.kind === "globals") {
		const row = await scope.first(globals);
		if (!row) return null;
		return globalsSnapshot(
			ref,
			storedVersion(row.draft).values,
			row.published ? storedVersion(row.published).values : null,
			storedFields(row.fields),
		);
	}
	const row = isUuid(ref.id) ? await scope.first(forms, eq(forms.id, ref.id)) : undefined;
	if (!row || row.emailsDraft === null) return null;
	return formEmailsSnapshot(ref, formEmailsVersions(row), defaultLanguage);
}

/**
 * Writes an item's translated values, locked: `change` gets it as it is now and answers what to
 * write. Answers whether anything was written.
 */
export async function writeItem(
	scope: SiteScope,
	ref: ItemRef,
	defaultLanguage: string,
	change: (item: ItemSnapshot) => ItemWrite | Promise<ItemWrite>,
): Promise<boolean> {
	if (ref.kind === "popupContent")
		return scope.transaction(async (tx) => {
			const row = await lockPopup(tx, ref.id);
			const snapshot = await readItem(tx, ref, defaultLanguage);
			if (!snapshot) return false;
			const result = await change(snapshot);
			if (!result) return false;
			await tx.update(
				popups,
				{
					...(result.draft ? { contentDraft: { values: result.draft }, contentUpdatedAt: tx.now() } : {}),
					...(result.published && row.contentPublished ? { contentPublished: { values: result.published } } : {}),
				},
				eq(popups.id, row.id),
			);
			if (result.draft)
				await noteDraftChange(
					tx,
					{ kind: "popupContent", id: row.id },
					{
						content: row.contentDraft,
						changedAt: row.contentUpdatedAt,
						changedBy: row.contentUpdatedBy,
						since: row.createdAt,
					},
					{ values: result.draft },
				);
			if (result.published && row.contentPublished) await saveRevision(tx, { kind: "popupContent", id: row.id });
			return true;
		});
	if (ref.kind === "entry") {
		const { written } = await writeEntryTranslations(
			scope,
			ref.id,
			async ({ draft, published, postType, hiddenLanguages }) => {
				const result = await change({
					ref,
					title: readValue(draft, { key: "title", language: defaultLanguage, defaultLanguage }) ?? "",
					postTypeId: postType.id,
					draft: draft.values,
					published: published?.values ?? null,
					units: (values) => unitsOf(values, entryFields(postType)),
					hiddenLanguages,
				});
				if (!result) return null;
				return {
					...(result.draft ? { draft: { values: result.draft } } : {}),
					...(result.published ? { published: { values: result.published } } : {}),
				};
			},
		);
		return written !== null;
	}
	if (ref.kind === "globals") {
		return writeGlobalsTranslations(scope, async ({ draft, published, fields }) => {
			const result = await change(globalsSnapshot(ref, draft.values, published?.values ?? null, fields));
			if (!result) return null;
			return {
				...(result.draft ? { draft: { values: result.draft } } : {}),
				...(result.published ? { published: { values: result.published } } : {}),
			};
		});
	}
	return writeFormEmailsTranslations(scope, ref.id, async (versions) => {
		const result = await change(formEmailsSnapshot(ref, versions, defaultLanguage));
		if (!result) return null;
		const marks: Marks = structuredClone(versions.aiTranslations);
		return {
			...(result.draft ? { draft: emailsFrom(result.draft, versions.draft, marks, defaultLanguage) } : {}),
			...(result.published && versions.published
				? { published: emailsFrom(result.published, versions.published, marks, defaultLanguage) }
				: {}),
			aiTranslations: marks,
		};
	});
}

/** The Globals as AI translation sees them: their two versions' values, split by their Fields. */
function globalsSnapshot(
	ref: ItemRef,
	draft: StoredValues,
	published: StoredValues | null,
	fields: readonly FieldDefinition[],
): ItemSnapshot {
	return {
		ref,
		title: "Globals",
		postTypeId: null,
		draft,
		published,
		units: (values) => unitsOf(values, fields),
		hiddenLanguages: [],
	};
}

/** A Form's emails as AI translation sees them: each text a value, in every language it has. */
function formEmailsSnapshot(ref: ItemRef, versions: FormEmailsVersions, defaultLanguage: string): ItemSnapshot {
	return {
		ref,
		title: versions.name,
		postTypeId: null,
		draft: emailValues(versions.draft, versions.aiTranslations, defaultLanguage),
		published: versions.published ? emailValues(versions.published, versions.aiTranslations, defaultLanguage) : null,
		units: (values) => unitsOf(values, FORM_EMAIL_FIELDS),
		hiddenLanguages: [],
	};
}

/** Every item of the Site AI translation could translate: its Entries, its Globals and its Forms' emails. */
export async function siteItems(scope: SiteScope | BackgroundScope): Promise<ItemRef[]> {
	const items: ItemRef[] = [];
	const postTypes = await listPostTypes(scope as SiteScope);
	for (const postType of postTypes) {
		const rows = await scope.select(entries, eq(entries.postTypeId, postType.id), {
			orderBy: [asc(entries.createdAt)],
		});
		for (const row of rows) items.push({ kind: "entry", id: row.id });
	}
	for (const row of await scope.select(popups)) items.push({ kind: "popupContent", id: row.id });
	if (await scope.first(globals)) items.push({ kind: "globals" });
	for (const row of await scope.select(forms, undefined, { orderBy: [asc(forms.name)] })) {
		if (row.emailsDraft !== null) items.push({ kind: "formEmails", id: row.id });
	}
	return items;
}
