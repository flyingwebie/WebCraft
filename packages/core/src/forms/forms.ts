import { components, entries, forms, postTypes, templates } from "@webcraft/db/schema";
import {
	type ElementTree,
	FORM_KEY,
	FORM_LIMITS,
	type FormCatalogue,
	type FormEmails,
	type FormVersion,
	formsPlacedIn,
} from "@webcraft/renderer";
import { and, asc, eq } from "drizzle-orm";
import { askConfirmation, type Confirmation, useConfirmation } from "../confirmations.ts";
import { storedComponentVersion } from "../content/component-versions.ts";
import { lockComponents } from "../content/components.ts";
import type { ContentProblem } from "../content/errors.ts";
import { sameJson } from "../content/json.ts";
import { isPagePostType } from "../content/pages.ts";
import { slugify } from "../content/slugs.ts";
import { isUniqueViolation } from "../db-errors.ts";
import { noteDraftChange } from "../history/checkpoints.ts";
import { saveRevision } from "../history/copies.ts";
import { isUuid } from "../ids.ts";
import { personIdOf } from "../permissions/can.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { type FormVersionInput, newFormVersion, readFormVersion, storedFormVersion } from "./definition.ts";
import { type FormEmailsInput, readFormEmails, storedFormEmails } from "./emails.ts";
import {
	FormInUseError,
	FormInvalidError,
	FormKeyTakenError,
	FormNotFoundError,
	type FormPlacement,
} from "./errors.ts";

/**
 * The Site's Forms (GLOSSARY.md): Structure that Staff build in the admin, with a Draft and a
 * published version, placed in Templates and Components with `{{@form <key>}}`. Visitors fill in the
 * published version; what they send is kept by the Module that receives Submissions.
 */

/** Where a Form stands, as for Templates: never published, published as it is, or changed since. */
export type FormStatus = "draft" | "published" | "changed";

export type Form = {
	id: string;
	siteId: string;
	key: string;
	name: string;
	status: FormStatus;
	draft: FormVersion;
	/** What visitors fill in; null until the first publish. */
	published: FormVersion | null;
	createdAt: Date;
	updatedAt: Date;
	publishedAt: Date | null;
	lastPublishedAt: Date | null;
	/**
	 * Its emails (Notifications and the Auto-reply): Content with a Draft of their own, published on
	 * their own by people who may change them (`formEmails.edit`), apart from the Form's Structure.
	 */
	emails: {
		draft: FormEmails;
		/** What a Submission sets off; null until first published (nothing goes out until then). */
		published: FormEmails | null;
		status: FormStatus;
		lastPublishedAt: Date | null;
	};
};

/** Where a Form is placed: the Templates and Components whose Draft or published version holds it. */
export type FormUsage = { usedIn: FormPlacement[] };

export type NewForm = { name: string; key?: string };

export type FormDeletion = { deleted: false; confirmation: Confirmation } | { deleted: true };

type FormRow = typeof forms.$inferSelect;

export function toForm(row: FormRow, language = "en"): Form {
	const draft = storedFormVersion(row.draft, language);
	const published = row.published === null ? null : storedFormVersion(row.published, language);
	const emailsDraft = storedFormEmails(row.emailsDraft);
	const emailsPublished = row.emailsPublished === null ? null : storedFormEmails(row.emailsPublished);
	return {
		id: row.id,
		siteId: row.siteId,
		key: row.key,
		name: row.name,
		status: publishStatus(published, draft),
		draft,
		published,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		publishedAt: row.publishedAt,
		lastPublishedAt: row.lastPublishedAt,
		emails: {
			draft: emailsDraft,
			published: emailsPublished,
			status: publishStatus(emailsPublished, emailsDraft),
			lastPublishedAt: row.emailsLastPublishedAt,
		},
	};
}

/**
 * Creates a Form on the scope's Site (open it with `structure.edit`): its name, and its key (made
 * from the name when not given). It starts as a Draft with no fields, its button and message in the
 * Site's Default language.
 */
export async function createForm(
	scope: SiteScope,
	input: NewForm,
	languages: { defaultLanguage: string; others: readonly string[] },
): Promise<Form> {
	const problems: ContentProblem[] = [];
	const name = checkName(input.name, problems);
	const key = checkKey(input.key ?? keyFromName(name), problems);
	if (problems.length > 0) throw new FormInvalidError(problems);
	return keyed(key, () =>
		scope.transaction(async (tx) => {
			await checkKeyUnused(tx, key);
			const now = tx.now();
			const row = await tx.insert(forms, {
				key,
				name,
				draft: newFormVersion(languages.defaultLanguage, languages.others),
				createdAt: now,
				updatedAt: now,
				updatedBy: personIdOf(tx.access.actor),
			});
			await tx.audit("form.create", { formId: row.id, key, name });
			return toForm(row);
		}),
	);
}

/** The Site's Forms, by name, each with where it is placed. */
export async function listForms(scope: SiteScope): Promise<(Form & { usage: FormUsage })[]> {
	const rows = await scope.select(forms, undefined, { orderBy: [asc(forms.name), asc(forms.key)] });
	const usageOf = await formUsages(scope);
	return rows.map((row) => ({ ...toForm(row), usage: usageOf(row.id) }));
}

/** One Form of the Site, with where it is placed; `FormNotFoundError` otherwise. */
export async function getForm(scope: SiteScope, formId: string): Promise<{ form: Form; usage: FormUsage }> {
	const row = isUuid(formId) ? await scope.first(forms, eq(forms.id, formId)) : undefined;
	if (!row) throw new FormNotFoundError();
	return { form: toForm(row), usage: (await formUsages(scope))(row.id) };
}

/**
 * Saves a Form's Draft (open the Site with `structure.edit`): each part given (`fields`,
 * `submitLabel`, `success`, `spam`) replaces that part. Refused with every problem where it is
 * (`FormInvalidError`). Visitors see nothing of it until it is published.
 */
export async function saveFormDraft(scope: SiteScope, formId: string, input: FormVersionInput): Promise<Form> {
	return scope.transaction(async (tx) => {
		const row = await lockForm(tx, formId);
		const problems: ContentProblem[] = [];
		const { version, pageIds } = readFormVersion(input, storedFormVersion(row.draft), problems);
		for (const pageId of pageIds) {
			if (!(await isPage(tx, pageId)))
				problems.push({ at: "success.pageId", message: "There is no such Page on this Site." });
		}
		if (problems.length > 0) throw new FormInvalidError(problems);
		const [updated] = await tx.update(
			forms,
			{ draft: version, updatedAt: tx.now(), updatedBy: personIdOf(tx.access.actor) },
			eq(forms.id, row.id),
		);
		if (!updated) throw new FormNotFoundError();
		await noteDraftChange(
			tx,
			{ kind: "form", id: row.id },
			{ content: row.draft, changedAt: row.updatedAt, changedBy: row.updatedBy },
			version,
		);
		return toForm(updated);
	});
}

/**
 * Saves a Form's emails Draft (open the Site with `formEmails.edit`): each part given
 * (`notifications`, `autoReply`) replaces that part, checked against the Form's Draft fields.
 * Refused with every problem where it is (`FormInvalidError`). Nothing goes out differently until
 * the emails are published.
 */
export async function saveFormEmails(scope: SiteScope, formId: string, input: FormEmailsInput): Promise<Form> {
	return scope.transaction(async (tx) => {
		const row = await lockForm(tx, formId);
		const problems: ContentProblem[] = [];
		const emails = readFormEmails(
			input,
			storedFormEmails(row.emailsDraft),
			storedFormVersion(row.draft).fields,
			problems,
		);
		if (problems.length > 0) throw new FormInvalidError(problems);
		const [updated] = await tx.update(
			forms,
			{
				emailsDraft: emails,
				updatedAt: tx.now(),
				emailsUpdatedAt: tx.now(),
				emailsUpdatedBy: personIdOf(tx.access.actor),
			},
			eq(forms.id, row.id),
		);
		if (!updated) throw new FormNotFoundError();
		await noteEmailsChange(tx, row, emails);
		return toForm(updated);
	});
}

/**
 * Publishes a Form's emails Draft: what a Submission sets off from now on. Part of `publish` (open the
 * Site with `formEmails.edit`); the Form's fields stay as they are.
 */
export async function publishFormEmails(scope: SiteScope, formId: string): Promise<{ id: string; publishedAt: Date }> {
	const row = await lockForm(scope, formId);
	const now = scope.now();
	await scope.update(
		forms,
		{ emailsPublished: storedFormEmails(row.emailsDraft), emailsLastPublishedAt: now, updatedAt: now },
		eq(forms.id, row.id),
	);
	await scope.audit("formEmails.publish", { formEmailsId: row.id, formId: row.id, key: row.key, name: row.name });
	return { id: row.id, publishedAt: now };
}

/**
 * Changes a Form's name or key, or both (open the Site with `structure.edit`). Templates and
 * Components place it by id, so `{{@form <key>}}` writes the new key everywhere at once.
 */
export async function renameForm(
	scope: SiteScope,
	formId: string,
	input: { name?: string; key?: string },
): Promise<Form> {
	const problems: ContentProblem[] = [];
	const name = input.name === undefined ? undefined : checkName(input.name, problems);
	const key = input.key === undefined ? undefined : checkKey(input.key, problems);
	if (problems.length > 0) throw new FormInvalidError(problems);
	return keyed(key ?? "", () =>
		scope.transaction(async (tx) => {
			const row = await lockForm(tx, formId);
			const next = { name: name ?? row.name, key: key ?? row.key };
			if (next.name === row.name && next.key === row.key) return toForm(row);
			if (next.key !== row.key) await checkKeyUnused(tx, next.key);
			const [updated] = await tx.update(forms, { ...next, updatedAt: tx.now() }, eq(forms.id, row.id));
			if (!updated) throw new FormNotFoundError();
			await tx.audit("form.rename", { formId: row.id, from: { name: row.name, key: row.key }, to: next });
			return toForm(updated);
		}),
	);
}

/**
 * Deletes a Form (open the Site with `structure.edit`), in two steps: without a confirmation it
 * deletes nothing and answers a confirmation id; with that id it deletes it. Refused while any
 * Template or Component places it (`FormInUseError`). Submissions stay with the Module that keeps them.
 */
export async function deleteForm(
	scope: SiteScope,
	formId: string,
	confirmation: string | undefined,
): Promise<FormDeletion> {
	return scope.transaction(async (tx) => {
		// Which trees place which Forms is read under the trees' lock.
		await lockComponents(tx);
		const row = await lockForm(tx, formId);
		const { usedIn } = (await formUsages(tx))(row.id);
		if (usedIn.length > 0) throw new FormInUseError(usedIn);
		const request = { action: "form.delete", target: row.id, preview: { name: row.name, key: row.key } };
		if (confirmation === undefined) return { deleted: false, confirmation: await askConfirmation(tx, request) };
		await useConfirmation(tx, confirmation, request);
		await tx.delete(forms, eq(forms.id, row.id));
		await tx.audit("form.delete", { formId: row.id, key: row.key, name: row.name });
		return { deleted: true };
	});
}

/**
 * Publishes a Form's Draft: what visitors fill in from now on. Part of `publish` (open the Site with
 * `structure.edit`), which clears the page cache. A redirect to a Page that has gone since is refused.
 */
export async function publishFormDraft(scope: SiteScope, formId: string): Promise<{ id: string; publishedAt: Date }> {
	const row = await lockForm(scope, formId);
	const draft = storedFormVersion(row.draft);
	if (draft.success.kind === "redirect" && !(await isPage(scope, draft.success.pageId))) {
		throw new FormInvalidError([{ at: "success.pageId", message: "There is no such Page on this Site." }]);
	}
	const now = scope.now();
	await scope.update(
		forms,
		{ published: draft, publishedAt: row.publishedAt ?? now, lastPublishedAt: now, updatedAt: now },
		eq(forms.id, row.id),
	);
	await scope.audit("form.publish", { formId: row.id, key: row.key, name: row.name });
	return { id: row.id, publishedAt: now };
}

/** A Form's emails as translations see them: each version, and the translations AI translation wrote. */
export type FormEmailsVersions = {
	name: string;
	draft: FormEmails;
	published: FormEmails | null;
	/** By language and place (`autoReply.subject`): the text the AI wrote and the text it translated. */
	aiTranslations: Record<string, Record<string, { text: string; source: string }>>;
};

/**
 * Writes translations into a Form's emails (AI translation's, an approved one), as
 * `writeEntryTranslations` does for an Entry: the Form is locked, `change` answers what to write.
 * Open the Site with `formEmails.edit`; the caller finishes publishing.
 */
export async function writeFormEmailsTranslations(
	scope: SiteScope,
	formId: string,
	change: (emails: FormEmailsVersions) =>
		| { draft?: FormEmails; published?: FormEmails; aiTranslations?: FormEmailsVersions["aiTranslations"] }
		| null
		| Promise<{
				draft?: FormEmails;
				published?: FormEmails;
				aiTranslations?: FormEmailsVersions["aiTranslations"];
		  } | null>,
): Promise<boolean> {
	return scope.transaction(async (tx) => {
		const row = await lockForm(tx, formId);
		const written = await change(formEmailsVersions(row));
		if (!written) return false;
		await tx.update(
			forms,
			{
				...(written.draft ? { emailsDraft: written.draft, updatedAt: tx.now() } : {}),
				...(written.published && row.emailsPublished ? { emailsPublished: written.published } : {}),
				...(written.aiTranslations ? { emailsAiTranslations: written.aiTranslations } : {}),
			},
			eq(forms.id, row.id),
		);
		if (written.draft) await noteEmailsChange(tx, row, written.draft);
		// Translated words published: a publish, which saves a Revision like any other.
		if (written.published && row.emailsPublished) await saveRevision(tx, { kind: "formEmails", id: row.id });
		return true;
	});
}

/** Notes a change to a Form's emails Draft for their history: who changed what, and Checkpoints. */
async function noteEmailsChange(scope: SiteScope, row: FormRow, emails: unknown): Promise<void> {
	await noteDraftChange(
		scope,
		{ kind: "formEmails", id: row.id },
		{ content: row.emailsDraft, changedAt: row.emailsUpdatedAt ?? row.updatedAt, changedBy: row.emailsUpdatedBy },
		emails,
	);
}

/** A Form's emails, each version and the AI's translations, as stored. */
export function formEmailsVersions(row: FormRow): FormEmailsVersions {
	const marks = row.emailsAiTranslations;
	return {
		name: row.name,
		draft: storedFormEmails(row.emailsDraft),
		published: row.emailsPublished ? storedFormEmails(row.emailsPublished) : null,
		aiTranslations:
			marks && typeof marks === "object" && !Array.isArray(marks)
				? (marks as FormEmailsVersions["aiTranslations"])
				: {},
	};
}

/** Reads one of the Site's Forms to change it, holding it until the transaction ends. */
export async function lockForm(scope: SiteScope, formId: string): Promise<FormRow> {
	if (!isUuid(formId)) throw new FormNotFoundError();
	const [row] = await scope.db
		.select()
		.from(forms)
		.where(scope.where(forms, eq(forms.id, formId)))
		.for("update");
	if (!row) throw new FormNotFoundError();
	return row;
}

// ---------------------------------------------------------------------------------------------------
// The Site's Forms, as trees placing them see them

/** The Site's Forms in one version, for reading, checking, printing and rendering trees that place them. */
export type SiteForms = FormCatalogue & {
	/** The key of a Form of the Site (`{{@form <key>}}`). */
	keyOf(formId: string): string | undefined;
	/** The version a placed Form shows. */
	version(formId: string): FormVersion | undefined;
};

/** The Site's Forms by name, with their keys: what a builder offers to place with `{{@form <key>}}`. */
export async function siteFormList(
	scope: Pick<SiteScope, "select">,
): Promise<{ id: string; key: string; name: string }[]> {
	const rows = await scope.select(forms, undefined, { orderBy: [asc(forms.name)] });
	return rows.map((row) => ({ id: row.id, key: row.key, name: row.name }));
}

/**
 * The Site's Forms in one version: Drafts (what Drafts of Templates and Components may place) or
 * published (what published ones place; a Form never published can't be placed there yet).
 */
export async function siteForms(
	scope: Pick<SiteScope | VisitorScope, "select">,
	which: "draft" | "published",
): Promise<SiteForms> {
	const rows = await scope.select(forms);
	const byId = new Map(rows.map((row) => [row.id, row]));
	const byKey = new Map(rows.map((row) => [row.key, row]));
	const versionOf = (row: FormRow | undefined): FormVersion | undefined => {
		if (!row) return undefined;
		const stored = which === "draft" ? row.draft : row.published;
		return stored === null ? undefined : storedFormVersion(stored);
	};
	const found = (row: FormRow | undefined) => {
		if (!row) return undefined;
		if (!versionOf(row)) return { refused: `The Form ${row.key} isn't published yet: publish it first.` };
		return { id: row.id, key: row.key };
	};
	return {
		keyed: (key) => found(byKey.get(key)),
		byId: (formId) => found(byId.get(formId)),
		keyOf: (formId) => byId.get(formId)?.key,
		version: (formId) => versionOf(byId.get(formId)),
	};
}

/** Forms are refused in a tree that can't name the Site's Forms, such as a Module's Component. */
export const NO_FORMS: FormCatalogue = {
	keyed: () => ({ refused: "Forms belong to one Site: a Module's Component can't place one." }),
	byId: () => ({ refused: "Forms belong to one Site: a Module's Component can't place one." }),
};

/**
 * Where each Form is placed: every Template and Component whose Draft or published version holds
 * `{{@form}}` for it.
 */
export async function formUsages(scope: Pick<SiteScope, "select">): Promise<(formId: string) => FormUsage> {
	const placements = new Map<string, FormPlacement[]>();
	const add = (formIds: Iterable<string>, placement: FormPlacement) => {
		for (const formId of formIds) {
			const list = placements.get(formId) ?? [];
			if (!list.some((known) => known.kind === placement.kind && known.id === placement.id)) list.push(placement);
			placements.set(formId, list);
		}
	};
	const placedIn = (...trees: unknown[]) =>
		new Set(trees.flatMap((tree) => (tree ? formsPlacedIn(tree as ElementTree) : [])));
	const names = new Map((await scope.select(postTypes)).map((postType) => [postType.id, postType.name]));
	for (const row of await scope.select(templates)) {
		add(placedIn(row.draft, row.published), {
			kind: row.kind === "site" ? "siteTemplate" : row.kind === "archive" ? "archiveTemplate" : "entryTemplate",
			id: row.id,
			name: row.postTypeId ? (names.get(row.postTypeId) ?? null) : null,
		});
	}
	for (const row of await scope.select(components)) {
		add(
			placedIn(
				storedComponentVersion(row.draft).tree,
				row.published === null ? null : storedComponentVersion(row.published).tree,
			),
			{ kind: "component", id: row.id, name: row.name },
		);
	}
	return (formId) => ({ usedIn: placements.get(formId) ?? [] });
}

// ---------------------------------------------------------------------------------------------------
// Names and keys

function checkName(input: string, problems: ContentProblem[]): string {
	const name = typeof input === "string" ? input.trim() : "";
	if (name === "" || name.length > FORM_LIMITS.nameLength) {
		problems.push({ at: "name", message: `A Form's name is 1 to ${FORM_LIMITS.nameLength} characters.` });
	}
	return name;
}

function checkKey(input: string, problems: ContentProblem[]): string {
	const key = typeof input === "string" ? input.trim() : "";
	if (!FORM_KEY.test(key) || key.length > FORM_LIMITS.keyLength) {
		problems.push({
			at: "key",
			message: `A Form's key is lower-case letters and digits, words joined by dashes, at most ${FORM_LIMITS.keyLength}: such as contact or wedding-cake.`,
		});
	}
	return key;
}

/** A key made from a name: `Wedding cake enquiry` gives `wedding-cake-enquiry`. */
function keyFromName(name: string): string {
	const slug = slugify(name).slice(0, FORM_LIMITS.keyLength).replace(/-+$/, "");
	return /^[a-z]/.test(slug) ? slug : `form-${slug}`.replace(/-+$/, "");
}

async function checkKeyUnused(scope: SiteScope, key: string): Promise<void> {
	if (await scope.first(forms, eq(forms.key, key))) throw new FormKeyTakenError(key);
}

/** Runs a save, turning another Form's key taken meanwhile into `FormKeyTakenError`. */
async function keyed<Result>(key: string, save: () => Promise<Result>): Promise<Result> {
	try {
		return await save();
	} catch (error) {
		if (isUniqueViolation(error, "forms_site_id_key_unique")) throw new FormKeyTakenError(key);
		throw error;
	}
}

/** Whether `pageId` is one of the Site's Pages. */
async function isPage(scope: Pick<SiteScope, "select" | "first">, pageId: string): Promise<boolean> {
	if (!isUuid(pageId)) return false;
	const pages = (await scope.select(postTypes)).find((postType) => isPagePostType({ builtIn: postType.builtIn }));
	if (!pages) return false;
	return (await scope.first(entries, and(eq(entries.id, pageId), eq(entries.postTypeId, pages.id)))) !== undefined;
}

/** Where a Draft stands against what is published: never published, the same, or changed since. */
function publishStatus(published: unknown, draft: unknown): "draft" | "published" | "changed" {
	if (published === null) return "draft";
	return sameJson(published, draft) ? "published" : "changed";
}
