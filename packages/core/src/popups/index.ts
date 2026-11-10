import { components, entries, popups, postTypes } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { clientNameOf } from "../audit.ts";
import { askConfirmation, useConfirmation } from "../confirmations.ts";
import { storedComponentVersion } from "../content/component-versions.ts";
import { type ComponentSources, createComponent, lockComponents, NO_MODULE_COMPONENTS } from "../content/components.ts";
import type { ContentProblem } from "../content/errors.ts";
import type { FieldInput } from "../content/field-types.ts";
import { checkFields, findingsInEveryLanguage, randomRowId, readFields, writeFields } from "../content/field-values.ts";
import { parseFields } from "../content/fields.ts";
import { sameJson } from "../content/json.ts";
import { languagesFor, siteLanguages } from "../content/languages.ts";
import { clearPageCache } from "../content/page-cache.ts";
import { checkReferences } from "../content/relationships.ts";
import { currentReviews, itemKey } from "../content/review-items.ts";
import { slugify } from "../content/slugs.ts";
import { storedVersion } from "../content/values.ts";
import { noteDraftChange } from "../history/checkpoints.ts";
import { actingPerson, can, personIdOf } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { popupAttachments } from "./catalogue.ts";
import { popupChecks } from "./checks.ts";

export class PopupNotFoundError extends Error {
	override name = "PopupNotFoundError";
	constructor() {
		super("There is no such Popup on this Site.");
	}
}
export class PopupInvalidError extends Error {
	override name = "PopupInvalidError";
	readonly problems: readonly ContentProblem[];
	constructor(problems: readonly ContentProblem[]) {
		super("The Popup cannot be saved.");
		this.problems = problems;
	}
}
const selector = z.string().regex(/^#[a-zA-Z][\w-]*$/);
const trigger = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("load") }),
	z.object({ kind: z.literal("delay"), seconds: z.number().min(0).max(86400) }),
	z.object({ kind: z.literal("scroll"), percent: z.number().min(1).max(100) }),
	z.object({ kind: z.literal("element"), selector }),
	z.object({ kind: z.literal("exit") }),
	z.object({ kind: z.literal("idle"), seconds: z.number().min(1).max(86400) }),
	z.object({ kind: z.literal("click") }),
]);
const paths = z
	.array(
		z
			.string()
			.regex(/^\/(?!\/)[^?#]*$/)
			.refine((path) => !path.slice(0, -1).includes("*"), "Only a final * is a wildcard."),
	)
	.max(100);
const ids = z.array(z.uuid()).max(100);
export const popupSettings = z.object({
	layout: z.enum(["modal", "slide-in", "bar", "full-screen"]),
	trigger,
	additionalTriggers: z.array(trigger).max(6).default([]),
	animation: z.enum(["none", "fade", "slide", "zoom"]).default("fade"),
	backdropClose: z.boolean().default(false),
	autoCloseSeconds: z.number().min(1).max(86400).nullable().default(null),
	afterSubmitCloseSeconds: z.number().min(0).max(86400).nullable().default(null),
	mainButton: selector.nullable().default(null),
	rules: z.strictObject({
		paths,
		postTypeIds: ids,
		entryIds: ids,
		languages: z.array(z.string()).max(100),
		devices: z
			.array(z.enum(["phone", "tablet", "desktop"]))
			.min(1)
			.max(3),
		visitors: z.enum(["all", "new", "returning"]),
		excludePaths: paths.default([]),
		excludePostTypeIds: ids.default([]),
		excludeEntryIds: ids.default([]),
	}),
	frequency: z.object({
		kind: z.enum(["page", "visit", "interval", "closed", "submitted"]),
		days: z.number().min(1).max(3650).default(1),
	}),
});
export type PopupSettings = z.infer<typeof popupSettings>;
export type PopupChange = Partial<Record<keyof PopupSettings, unknown>>;
export const INITIAL_POPUP: PopupSettings = popupSettings.parse({
	layout: "modal",
	trigger: { kind: "click" },
	rules: {
		paths: [],
		postTypeIds: [],
		entryIds: [],
		languages: [],
		devices: ["phone", "tablet", "desktop"],
		visitors: "all",
	},
	frequency: { kind: "page", days: 1 },
});
const inputs: FieldInput[] = [
	{ key: "title", label: "Title", type: "text", translatable: true, maxLength: 200 },
	{ key: "text", label: "Text", type: "richText", translatable: true },
	{ key: "image", label: "Image", type: "media", translatable: true },
	{ key: "enabled", label: "On", type: "boolean", translatable: false },
	{ key: "start", label: "Start", type: "date", mode: "dateTime", translatable: false },
	{ key: "end", label: "End", type: "date", mode: "dateTime", translatable: false },
];
export const POPUP_FIELDS = parseFields(inputs, [], {
	owner: "globals",
	postTypeKeys: new Set(),
	reservedKeys: new Set(),
});
type Row = typeof popups.$inferSelect;
export async function popupRow(scope: Pick<SiteScope, "first">, id: string) {
	const row = await scope.first(popups, eq(popups.id, id));
	if (!row) throw new PopupNotFoundError();
	return row;
}
const status = (draft: unknown, published: unknown) =>
	published === null ? ("draft" as const) : sameJson(draft, published) ? ("published" as const) : ("changed" as const);
export function popupView(
	scope: SiteScope,
	row: Row,
	versions?: { draft: unknown; published: unknown },
	attached = false,
) {
	return {
		...row,
		draft: row.draft as PopupSettings,
		published: row.published as PopupSettings | null,
		status: status(versions?.draft ?? row.draft, versions?.published ?? row.published),
		checks: can(scope.access.actor, "structure.edit", {
			level: "site",
			workspaceId: scope.workspace.id,
			siteId: scope.site.id,
		})
			? popupChecks(row.draft as PopupSettings, attached)
			: [],
	};
}
export async function getPopup(scope: SiteScope, id: string, language?: string) {
	const row = await popupRow(scope, id);
	const langs = languagesFor(await siteLanguages(scope), language);
	if (!langs) throw new PopupInvalidError([{ at: "language", message: "There is no such language on this Site." }]);
	const item = { kind: "popupContent", id } as const;
	const review =
		(await currentReviews(scope, [{ item, draft: row.contentDraft, name: row.name, postType: null }])).get(
			itemKey(item),
		) ?? null;
	return {
		popup: popupView(scope, row, await popupStructureState(scope, row), (await popupAttachments(scope)).has(id)),
		content: {
			review,
			fields: POPUP_FIELDS,
			language: langs.language,
			draft: { values: readFields(storedVersion(row.contentDraft).values, POPUP_FIELDS, langs) },
			published: row.contentPublished
				? { values: readFields(storedVersion(row.contentPublished).values, POPUP_FIELDS, langs) }
				: null,
			status: status(row.contentDraft, row.contentPublished),
		},
	};
}
export async function lockPopup(scope: SiteScope, id: string) {
	const [row] = await scope.db
		.select()
		.from(popups)
		.where(scope.where(popups, eq(popups.id, id)))
		.for("update");
	if (!row) throw new PopupNotFoundError();
	return row;
}
export async function savePopupDraft(scope: SiteScope, id: string, change: PopupChange) {
	return scope.transaction(async (tx) => {
		await lockComponents(tx);
		const row = await lockPopup(tx, id);
		const before = await popupStructureState(tx, row);
		// Public API coercion can include omitted keys as undefined; they still mean no change.
		const supplied = Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined));
		const parsed = popupSettings.safeParse({ ...(row.draft as PopupSettings), ...supplied });
		if (!parsed.success)
			throw new PopupInvalidError(parsed.error.issues.map((i) => ({ at: i.path.join("."), message: i.message })));
		const next = parsed.data;
		const langs = await siteLanguages(tx);
		for (const id of [...next.rules.postTypeIds, ...next.rules.excludePostTypeIds])
			if (!(await tx.first(postTypes, eq(postTypes.id, id))))
				throw new PopupInvalidError([{ at: "rules.postTypeIds", message: "There is no such Post Type on this Site." }]);
		for (const id of [...next.rules.entryIds, ...next.rules.excludeEntryIds])
			if (!(await tx.first(entries, eq(entries.id, id))))
				throw new PopupInvalidError([{ at: "rules.entryIds", message: "There is no such Entry on this Site." }]);
		if (next.rules.languages.some((code) => !langs.languages.some((l) => l.code === code)))
			throw new PopupInvalidError([{ at: "rules.languages", message: "There is no such language on this Site." }]);
		await tx.update(
			popups,
			{
				draft: next,
				updatedAt: tx.now(),
				updatedBy: personIdOf(tx.access.actor),
				updatedVia: clientNameOf(tx.access.via),
			},
			eq(popups.id, id),
		);
		await noteDraftChange(
			tx,
			{ kind: "popup", id },
			{ content: before.draft, changedAt: row.updatedAt, changedBy: row.updatedBy, since: row.createdAt },
			{ ...before.draft, settings: next },
		);
		await tx.audit("popup.save", { popupId: id });
		const saved = await popupRow(tx, id);
		return popupView(tx, saved, await popupStructureState(tx, saved), (await popupAttachments(tx)).has(id));
	});
}
export async function savePopupContent(
	scope: SiteScope,
	id: string,
	change: { language?: string; values: Record<string, unknown> },
) {
	return scope.transaction(async (tx) => {
		const row = await lockPopup(tx, id);
		const langs = languagesFor(await siteLanguages(tx), change.language);
		if (!langs) throw new PopupInvalidError([{ at: "language", message: "There is no such language on this Site." }]);
		const problems: ContentProblem[] = [];
		const references: import("../content/field-values.ts").WriteContext["references"] = [];
		const values = writeFields(
			storedVersion(row.contentDraft).values,
			POPUP_FIELDS,
			change.values,
			{
				...langs,
				by: { kind: "person", personId: actingPerson(tx.access.actor) },
				problems,
				references,
				newRowId: randomRowId,
			},
			"values.",
			"The Popup",
		);
		await checkReferences(
			tx,
			references.map((reference) => ({ ...reference, problems })),
			"refuse",
		);
		if (problems.length) throw new PopupInvalidError(problems);
		const read = readFields(values, POPUP_FIELDS, langs);
		if (read.start && read.end && Date.parse(String(read.start)) >= Date.parse(String(read.end)))
			throw new PopupInvalidError([{ at: "values.end", message: "The end must be after the start." }]);
		const draft = { values };
		await tx.update(
			popups,
			{
				contentDraft: draft,
				contentUpdatedAt: tx.now(),
				contentUpdatedBy: personIdOf(tx.access.actor),
				contentUpdatedVia: clientNameOf(tx.access.via),
			},
			eq(popups.id, id),
		);
		await noteDraftChange(
			tx,
			{ kind: "popupContent", id },
			{
				content: row.contentDraft,
				changedAt: row.contentUpdatedAt,
				changedBy: row.contentUpdatedBy,
				since: row.createdAt,
			},
			draft,
		);
		return getPopup(tx, id, change.language);
	});
}
export async function publishPopup(scope: SiteScope, id: string, content: boolean, version?: unknown) {
	const row = await lockPopup(scope, id);
	const now = scope.now();
	if (content) await checkPopupContentReady(scope, id, version ?? row.contentDraft);
	if (!content) {
		const c = await scope.first(components, eq(components.id, row.componentId));
		if (!c?.published)
			throw new PopupInvalidError([{ at: "component", message: "Publish the Popup's Component first." }]);
	}
	await scope.update(
		popups,
		content
			? { contentPublished: version ?? row.contentDraft, contentPublishedAt: now }
			: { published: version ?? row.draft, publishedAt: row.publishedAt ?? now, lastPublishedAt: now },
		eq(popups.id, id),
	);
	const kind: "popupContent" | "popup" = content ? "popupContent" : "popup";
	await scope.audit(`${kind}.publish`, { [`${kind}Id`]: id, name: row.name });
	return { kind, id, publishedAt: now, pathChanges: [] as import("../content/publishing.ts").PathChange[] };
}
export function createPopups(sources: ComponentSources = NO_MODULE_COMPONENTS) {
	return {
		get: getPopup,
		saveDraft: savePopupDraft,
		saveContent: savePopupContent,
		async list(scope: SiteScope) {
			const attached = await popupAttachments(scope);
			return Promise.all(
				(await scope.select(popups)).map(async (row) =>
					popupView(scope, row, await popupStructureState(scope, row), attached.has(row.id)),
				),
			);
		},
		async create(scope: SiteScope, input: { name: string; key?: string }) {
			return scope.transaction(async (tx) => {
				await lockComponents(tx);
				const name = input.name.trim();
				const key = input.key ?? slugify(name).slice(0, 80).replace(/-+$/, "");
				if (!name || !/^[a-z][a-z0-9-]{0,79}$/.test(key) || (await tx.first(popups, eq(popups.key, key))))
					throw new PopupInvalidError([
						{ at: "key", message: "Choose an unused key of lower-case words joined by dashes." },
					]);
				const baseName = `Popup${key
					.split("-")
					.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
					.join("")}`.slice(0, 64);
				const taken = new Set([
					...(await tx.select(components)).map((component) => component.name),
					...sources.allModuleComponents().map((component) => component.name),
					...(await sources.retainedModuleComponentsAt(tx)).map((component) =>
						component.id.slice(component.id.indexOf(":") + 1),
					),
				]);
				let componentName = baseName;
				for (let suffix = 2; taken.has(componentName); suffix++)
					componentName = `${baseName.slice(0, 64 - String(suffix).length)}${suffix}`;
				const component = await createComponent(
					tx,
					{
						name: componentName,
						props: inputs.filter((p) => ["title", "text", "image"].includes(p.key)),
					},
					sources,
				);
				const now = tx.now();
				const row = await tx.insert(popups, {
					name,
					key,
					componentId: component.id,
					draft: INITIAL_POPUP,
					contentDraft: { values: {} },
					createdAt: now,
					updatedAt: now,
					contentUpdatedAt: now,
					updatedBy: personIdOf(tx.access.actor),
				});
				await tx.audit("popup.create", { popupId: row.id, name, key });
				return popupView(tx, row);
			});
		},
		async delete(scope: SiteScope, id: string, confirmation?: string) {
			return scope.transaction(async (tx) => {
				const row = await lockPopup(tx, id);
				const request = { action: "popup.delete", target: id, preview: { name: row.name } };
				if (!confirmation) return { deleted: false as const, confirmation: await askConfirmation(tx, request) };
				await useConfirmation(tx, confirmation, request);
				await tx.delete(popups, eq(popups.id, id));
				await clearPageCache(tx);
				await tx.audit("popup.delete", { popupId: id });
				return { deleted: true as const };
			});
		},
	};
}
export type Popups = ReturnType<typeof createPopups>;

export async function restorePopupContent(scope: SiteScope, id: string, version: unknown) {
	await scope.transaction(async (tx) => {
		const row = await lockPopup(tx, id);
		const draft = storedVersion(version);
		await tx.update(
			popups,
			{
				contentDraft: draft,
				contentUpdatedAt: tx.now(),
				contentUpdatedBy: personIdOf(tx.access.actor),
				contentUpdatedVia: clientNameOf(tx.access.via),
			},
			eq(popups.id, id),
		);
		await noteDraftChange(
			tx,
			{ kind: "popupContent", id },
			{
				content: row.contentDraft,
				changedAt: row.contentUpdatedAt,
				changedBy: row.contentUpdatedBy,
				since: row.createdAt,
			},
			draft,
		);
	});
}

export async function checkPopupContentReady(scope: SiteScope, id: string, version?: unknown) {
	const row = await popupRow(scope, id);
	const site = await siteLanguages(scope);
	const findings = findingsInEveryLanguage(site.languages, site.defaultLanguage, (langs) => {
		const found: import("../content/field-values.ts").Findings = { problems: [], missing: [], references: [] };
		checkFields(storedVersion(version ?? row.contentDraft).values, POPUP_FIELDS, langs, found);
		return found;
	});
	await checkReferences(scope, findings.references, "rule");
	if (findings.problems.length) throw new PopupInvalidError(findings.problems);
}

/** A Popup publishes its backing Component and settings as one Structure item; the tree still uses all Component tooling. */
export async function popupStructureState(scope: Pick<SiteScope, "first">, row: Row) {
	const component = await scope.first(components, eq(components.id, row.componentId));
	return {
		draft: { settings: row.draft as PopupSettings, component: storedComponentVersion(component?.draft) },
		published:
			row.published === null
				? null
				: { settings: row.published as PopupSettings, component: storedComponentVersion(component?.published) },
	};
}
