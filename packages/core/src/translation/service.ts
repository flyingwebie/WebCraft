import type { Database } from "@webcraft/db";
import {
	aiCalls,
	people,
	siteLanguages as siteLanguageRows,
	sites,
	translationCounts,
	translationTasks,
} from "@webcraft/db/schema";
import { storedBlocks } from "@webcraft/renderer";
import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { AiCapReachedError } from "../ai/errors.ts";
import { type AiKeys, monthOf } from "../ai/keys.ts";
import { AiKeyMissingError, AiProviderError, type AiProviders } from "../ai/providers.ts";
import type { RecordedAuditEntry } from "../audit.ts";
import type { Clock } from "../clock.ts";
import type { ModuleComponentProps } from "../content/components.ts";
import type { Json } from "../content/field-types.ts";
import { sameJson } from "../content/json.ts";
import { siteLanguages } from "../content/languages.ts";
import { clearPageCache } from "../content/page-cache.ts";
import { blockContent } from "../content/translation-sources.ts";
import type { LanguageValue } from "../content/values.ts";
import { defineJob, type JobQueue } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import type { Logger } from "../log.ts";
import { actingPerson, can, type PersonActor } from "../permissions/can.ts";
import type { Permission } from "../permissions/roles.ts";
import { indexPublishedEntry } from "../search/indexing.ts";
import type { DataLayer, SiteScope, WorkspaceScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError, SiteNotFoundError } from "../tenancy/errors.ts";
import { pendingJobs, translateValues } from "./engine.ts";
import { type ItemRef, type ItemSnapshot, readItem, siteItems, writeItem } from "./items.ts";
import { type ItemTranslation, itemTranslation } from "./status.ts";
import {
	addProtectedTerms,
	findProtectedTerm,
	glossaryOf,
	listProtectedTerms,
	type NewProtectedTerm,
	type ProtectedTerm,
	removeProtectedTerm,
} from "./terms.ts";
import { apiPath, breaksRules, leafAt, readableText, storedPath, withLeafAt } from "./units.ts";

/** Source types identify human text even when the installed Module is absent or incompatible. */
async function modulePropsForTranslation(scope: SiteScope): Promise<readonly ModuleComponentProps[]> {
	const declarations = new Map(
		scope.componentSources.allModuleComponents().map(({ id, props }) => [id, { id, props }]),
	);
	for (const component of await scope.componentSources.retainedModuleComponentsAt(scope.site))
		declarations.set(component.id, component);
	return [...declarations.values()];
}

/**
 * AI translation of a Site's languages (GLOSSARY.md › Translation mode): each language other than the
 * Default language is Automatic (AI translation is published together with the Default language's
 * publish, by a job after it), Review (AI translation lands in the Draft for a person to publish) or
 * Manual (nothing automatic). A publish never waits for a translation and never fails because of
 * one: it only queues work. Values a person wrote are never overwritten; they become Outdated
 * translations when their source changes.
 */

export const TRANSLATION_MODES = ["automatic", "review", "manual"] as const;
export type TranslationMode = (typeof TRANSLATION_MODES)[number];

/** Why translation work waits: no AI key, the monthly cap reached; or why it failed. */
export type WaitingReason = "noKey" | "cap" | "unavailable" | "refused" | "answer" | "access" | "error";

export type LanguageTranslations = {
	code: string;
	name: string;
	mode: TranslationMode;
	/** How many of the Site's values have a translation of their own in this language, in per cent. */
	progress: number;
	toReview: number;
	outdated: number;
	missing: number;
	/** Work queued for this language, and work that waits or failed, with why. */
	queued: number;
	waiting: { reason: WaitingReason; count: number }[];
};

export type TranslationsOverview = {
	defaultLanguage: { code: string; name: string };
	languages: LanguageTranslations[];
	/**
	 * Whether the Workspace has an AI key, which, whether its cap stopped AI calls this month, and the
	 * share of the cap used (only for people who see costs; null without a cap).
	 */
	key: { inUse: "own" | "shared" | null; capReached: boolean; capPercent: number | null };
	/** This month, for this Site: its AI calls and their cost (only for people who see costs), and the cache's share. */
	usage: { month: string; calls: number; tokens: number; cost: number | null; cacheHits: number | null };
};

/** One line of the Review queue: an AI translation waiting for a person, or an Outdated translation. */
export type QueueLine = {
	item: { kind: ItemRef["kind"]; id: string | null; title: string; postTypeId: string | null };
	language: string;
	at: string;
	block: string | null;
	labels: string[];
	status: "toReview" | "outdated";
	writtenBy: { kind: "ai" } | { kind: "person"; id: string | null; name: string | null };
	source: string;
	translation: string;
	/** For an Outdated translation: its source when it was written. */
	oldSource: string | null;
};

export type Translations = {
	overview(scope: SiteScope, options: { costs: boolean }): Promise<TranslationsOverview>;
	setMode(scope: SiteScope, language: string, mode: TranslationMode): Promise<void>;
	/** Queues AI translation of every item into the Automatic and Review languages (or one of them). */
	translateNow(scope: SiteScope, language?: string): Promise<{ queued: number }>;
	queue(scope: SiteScope, filter: { language?: string }): Promise<QueueLine[]>;
	/** Publishes the AI's translations waiting in the Draft, in one language, for some items or all. */
	approve(scope: SiteScope, input: { language: string; items?: ItemRef[] }): Promise<{ approved: number }>;
	/** Marks a person's translation as checked against its source as it is now. */
	confirm(
		scope: SiteScope,
		input: { item: ItemRef; language: string; at: string; block?: string | null },
	): Promise<void>;
	/** Translates one value again with AI, into the Draft, whoever wrote it. */
	retranslate(
		scope: SiteScope,
		input: { item: ItemRef; language: string; at: string; block?: string | null },
	): Promise<void>;
	/** An item's translations in a language, from its Draft. */
	itemTranslation(scope: SiteScope, item: ItemRef, language: string): Promise<ItemTranslation | null>;
	/** Hears of every Audit log entry: a publish queues AI translation for the Automatic and Review languages. */
	afterAudit(entry: RecordedAuditEntry): Promise<void>;
	/** For the worker: runs a Site's queued translation work. */
	runSite(siteId: string): Promise<void>;
	/** For the worker, hourly: picks up work that waited (a new month), and gives back stale reservations. */
	resume(): Promise<void>;
	/** Picks up the Workspace's waiting work again (its key or cap changed). */
	resumeWorkspace(workspaceId: string): Promise<void>;
	/** Protected terms: the Workspace's, and each Site's. */
	terms: {
		list(scope: WorkspaceScope, siteIds?: readonly string[]): Promise<ProtectedTerm[]>;
		add(scope: WorkspaceScope, siteId: string | null, terms: readonly NewProtectedTerm[]): Promise<number>;
		find(scope: WorkspaceScope, termId: string): Promise<{ id: string; siteId: string | null }>;
		remove(scope: WorkspaceScope, termId: string): Promise<void>;
	};
};

/** A language that can't take this Translation mode (the Default language), or one the Site doesn't have. */
export class TranslationLanguageError extends Error {
	override name = "TranslationLanguageError";
	readonly reason: "default" | "unknown";
	constructor(reason: "default" | "unknown") {
		super(
			reason === "default"
				? "The Default language is written by people; it has no Translation mode."
				: "The Site has no such language.",
		);
		this.reason = reason;
	}
}

/** No value to confirm or translate at that place, in that language. */
export class TranslationNotFoundError extends Error {
	override name = "TranslationNotFoundError";
	constructor() {
		super("There is no translation there.");
	}
}

export const translationsRun = defineJob({
	name: "translations.run",
	payload: z.object({ siteId: z.uuid() }),
	queue: { retryLimit: 2, retryDelay: 60, expireInSeconds: 60 * 60 },
	run: ({ siteId }, context) => context.translations.runSite(siteId),
});

export const translationsResume = defineJob({
	name: "translations.resume",
	payload: z.object({}),
	queue: { retryLimit: 0 },
	run: (_payload, context) => context.translations.resume(),
});

/** Hourly: work held for the month's cap starts again in a new month, and stale reservations come back. */
export const translationsResumeSchedule = defineSchedule({ job: translationsResume, cron: "7 * * * *", payload: {} });

/** How many tasks a run takes at once; more are left for the next run. */
const RUN_SIZE = 20;

/** A task left `running` this long (its process stopped) is queued again. */
const STALE_RUN_MS = 30 * 60 * 1000;

export type TranslationsOptions = {
	database: Database;
	data: DataLayer;
	ai: AiProviders;
	keys: AiKeys;
	jobs: JobQueue;
	clock: Clock;
	log: Logger;
	actors: { person(personId: string): Promise<PersonActor> };
};

type TaskRow = typeof translationTasks.$inferSelect;

function itemOf(row: Pick<TaskRow, "itemKind" | "itemId">): ItemRef | null {
	if (row.itemKind === "globals") return { kind: "globals" };
	if ((row.itemKind === "entry" || row.itemKind === "formEmails") && row.itemId)
		return { kind: row.itemKind, id: row.itemId };
	return null;
}

function itemId(item: ItemRef): string | null {
	return item.kind === "globals" ? null : item.id;
}

/** The Permission writing an item's Draft (`publish`: its published version) takes. */
function writePermission(item: ItemRef, publish: boolean): Permission {
	if (item.kind === "formEmails") return "formEmails.edit";
	return publish ? "entry.publish" : "entry.edit";
}

export function createTranslations(options: TranslationsOptions): Translations {
	const { database, data, ai, keys, jobs, clock, log, actors } = options;

	const modesOf = async (siteId: string) => {
		const rows = await database.db
			.select({ code: siteLanguageRows.code, mode: siteLanguageRows.translationMode })
			.from(siteLanguageRows)
			.where(eq(siteLanguageRows.siteId, siteId));
		return new Map(
			rows.map((row) => [
				row.code,
				(TRANSLATION_MODES as readonly string[]).includes(row.mode) ? (row.mode as TranslationMode) : "manual",
			]),
		);
	};

	/** Queues (or queues again) one item's translation into a language, as `personId`. */
	const enqueue = async (
		place: { workspaceId: string; siteId: string },
		item: ItemRef,
		language: string,
		publish: boolean,
		personId: string,
	) => {
		const now = clock.now();
		await database.db
			.insert(translationTasks)
			.values({
				workspaceId: place.workspaceId,
				siteId: place.siteId,
				itemKind: item.kind,
				itemId: itemId(item),
				language,
				publish,
				status: "queued",
				reason: null,
				requestedBy: personId,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [
					translationTasks.siteId,
					translationTasks.itemKind,
					translationTasks.itemId,
					translationTasks.language,
				],
				set: { publish, status: "queued", reason: null, requestedBy: personId, updatedAt: now },
			});
	};

	const kick = async (siteId: string) => {
		try {
			await jobs.send(translationsRun, { siteId });
		} catch (error) {
			log.error("AI translation couldn't be queued", { siteId, error });
		}
	};

	/** The text of a value in a language, for the Review queue. */
	const textOf = (kind: Parameters<typeof readableText>[0], value: LanguageValue | undefined) =>
		readableText(kind, value?.value);

	/** Finishes publishing translated values: the page cache, Site search and the Audit log. */
	const afterPublish = async (scope: SiteScope, item: ItemSnapshot, language: string, at: string[]) => {
		await clearPageCache(scope);
		if (item.ref.kind === "entry") await indexPublishedEntry(scope, item.ref.id);
		await scope.audit("translation.publish", {
			item: { kind: item.ref.kind, id: itemId(item.ref), ...(item.postTypeId ? { postTypeId: item.postTypeId } : {}) },
			language,
			fields: at,
		});
	};

	const runTask = async (
		task: TaskRow,
	): Promise<{ status: "done" } | { status: "held" | "failed"; reason: WaitingReason }> => {
		const item = itemOf(task);
		if (!item || !task.requestedBy) return { status: "failed", reason: "access" };
		let scope: SiteScope;
		try {
			// The work runs as the person who asked for it (who published), with their access as it is now.
			const actor = await actors.person(task.requestedBy);
			scope = await data.site(
				{ actor, via: { kind: "translation" } },
				task.siteId,
				writePermission(item, task.publish),
			);
		} catch (error) {
			if (!(error instanceof PermissionDeniedError) && !(error instanceof SiteNotFoundError)) {
				log.warn("AI translation couldn't act as the person who asked for it", { siteId: task.siteId, error });
			}
			return { status: "failed", reason: "access" };
		}
		const site = await siteLanguages(scope);
		const target = site.languages.find((language) => language.code === task.language && !language.default);
		const from = site.languages.find((language) => language.default);
		if (!target || !from) return { status: "done" };
		const languages = { language: target.code, defaultLanguage: site.defaultLanguage };
		const snapshot = await readItem(scope, item, site.defaultLanguage);
		if (!snapshot || snapshot.hiddenLanguages.includes(target.code)) return { status: "done" };
		const base = task.publish ? snapshot.published : snapshot.draft;
		if (!base) return { status: "done" };
		const work = pendingJobs(base, snapshot.units(base), languages);
		if (work.length === 0) return { status: "done" };
		const values = await translateValues(
			{
				ai,
				keys,
				db: scope.db,
				moduleComponents: await modulePropsForTranslation(scope),
				place: { workspaceId: scope.workspace.id, siteId: scope.site.id },
				from: { code: from.code, name: from.name },
				to: { code: target.code, name: target.name },
				glossary: await glossaryOf(scope.db, scope.workspace.id, scope.site.id),
				now: clock.now(),
			},
			work,
		);
		const published: string[] = [];
		await writeItem(scope, item, site.defaultLanguage, (current) => {
			const currentBase = task.publish ? current.published : current.draft;
			if (!currentBase) return null;
			let nextBase = currentBase;
			let nextDraft = current.draft;
			let draftChanged = false;
			for (const job of work) {
				const value = values.get(job.unit.path);
				const leaf = leafAt(currentBase, job.unit.path);
				// Written meanwhile (a new source, a person's translation): left for the next run.
				if (
					!value ||
					!sameJson(leaf?.[languages.defaultLanguage]?.value, job.source) ||
					!sameJson(leaf?.[languages.language], job.target)
				) {
					continue;
				}
				// A translation breaking its Field's rules waits in the Draft for a person.
				const live = task.publish && !breaksRules(job.unit.field, value.value);
				if (live) {
					nextBase = withLeafAt(nextBase, job.unit.path, { ...leaf, [languages.language]: value });
					published.push(apiPath(job.unit.path));
				}
				const draftLeaf = leafAt(current.draft, job.unit.path);
				if (!task.publish || sameJson(draftLeaf?.[languages.language], job.target)) {
					nextDraft = withLeafAt(nextDraft, job.unit.path, { ...(draftLeaf ?? {}), [languages.language]: value });
					draftChanged = true;
				}
			}
			return {
				...(draftChanged ? { draft: nextDraft } : {}),
				...(task.publish && published.length > 0 ? { published: nextBase } : {}),
			};
		});
		if (published.length > 0) await afterPublish(scope, snapshot, target.code, published);
		return { status: "done" };
	};

	const settleTask = async (task: TaskRow, outcome: Awaited<ReturnType<typeof runTask>>) => {
		if (outcome.status === "done") {
			// Unless it was queued again meanwhile (a newer publish), it is finished.
			await database.db
				.delete(translationTasks)
				.where(and(eq(translationTasks.id, task.id), eq(translationTasks.status, "running")));
			return;
		}
		await database.db
			.update(translationTasks)
			.set({ status: outcome.status, reason: outcome.reason, updatedAt: clock.now() })
			.where(and(eq(translationTasks.id, task.id), eq(translationTasks.status, "running")));
	};

	const resumeWorkspace = async (workspaceId: string) => {
		const readiness = await keys.readiness(workspaceId);
		if (!readiness.key || readiness.capReached) return;
		const resumed = await database.db
			.update(translationTasks)
			.set({ status: "queued", reason: null, updatedAt: clock.now() })
			.where(and(eq(translationTasks.workspaceId, workspaceId), eq(translationTasks.status, "held")))
			.returning({ siteId: translationTasks.siteId });
		for (const siteId of new Set(resumed.map((row) => row.siteId))) await kick(siteId);
	};

	keys.onChange(resumeWorkspace);

	/** An item's Draft and published version, checked: a person may change it in this scope. */
	const itemFor = async (scope: SiteScope, item: ItemRef, defaultLanguage: string) => {
		const snapshot = await readItem(scope, item, defaultLanguage);
		if (!snapshot) throw new TranslationNotFoundError();
		return snapshot;
	};

	const languageOf = async (scope: SiteScope, code: string) => {
		const site = await siteLanguages(scope);
		const language = site.languages.find((candidate) => candidate.code.toLowerCase() === code.toLowerCase());
		if (!language) throw new TranslationLanguageError("unknown");
		if (language.default) throw new TranslationLanguageError("default");
		const from = site.languages.find((candidate) => candidate.default) ?? language;
		return { site, language, from };
	};

	return {
		async overview(scope, options) {
			const site = await siteLanguages(scope);
			const modes = await modesOf(scope.site.id);
			const items = await siteItems(scope);
			const snapshots = (await Promise.all(items.map((item) => readItem(scope, item, site.defaultLanguage)))).filter(
				(snapshot): snapshot is ItemSnapshot => snapshot !== null,
			);
			const tasks = await scope.select(translationTasks);
			const languages: LanguageTranslations[] = [];
			for (const language of site.languages.filter((candidate) => !candidate.default)) {
				const counts = { total: 0, translated: 0, toReview: 0, outdated: 0, missing: 0 };
				for (const snapshot of snapshots) {
					if (snapshot.hiddenLanguages.includes(language.code)) continue;
					const found = itemTranslation(snapshot.draft, snapshot.published, snapshot.units(snapshot.draft), {
						language: language.code,
						defaultLanguage: site.defaultLanguage,
					});
					counts.total += found.total;
					counts.missing += found.missing.length;
					counts.translated += found.total - found.missing.length;
					counts.toReview += found.toReview.length;
					counts.outdated += found.outdated.length;
				}
				const own = tasks.filter((task) => task.language === language.code);
				const waiting = new Map<WaitingReason, number>();
				for (const task of own.filter((candidate) => candidate.status === "held" || candidate.status === "failed")) {
					const reason = (task.reason ?? "error") as WaitingReason;
					waiting.set(reason, (waiting.get(reason) ?? 0) + 1);
				}
				languages.push({
					code: language.code,
					name: language.name,
					mode: modes.get(language.code) ?? "manual",
					progress: counts.total === 0 ? 100 : Math.floor((counts.translated / counts.total) * 100),
					toReview: counts.toReview,
					outdated: counts.outdated,
					missing: counts.missing,
					queued: own.filter((task) => task.status === "queued" || task.status === "running").length,
					waiting: [...waiting].map(([reason, count]) => ({ reason, count })),
				});
			}
			const readiness = await keys.readiness(scope.workspace.id);
			const month = monthOf(clock.now());
			const [calls] = await database.db
				.select({
					calls: sql<number>`count(*)::int`,
					tokens: sql<number>`coalesce(sum(${aiCalls.inputTokens} + ${aiCalls.outputTokens}), 0)::int`,
					cost: sql<number>`coalesce(sum(${aiCalls.cost}), 0)::bigint`,
				})
				.from(aiCalls)
				.where(
					and(
						eq(aiCalls.workspaceId, scope.workspace.id),
						eq(aiCalls.siteId, scope.site.id),
						eq(aiCalls.month, month),
						eq(aiCalls.status, "done"),
					),
				);
			const [counted] = await scope.select(translationCounts, eq(translationCounts.month, month));
			const pieces = (counted?.cached ?? 0) + (counted?.sent ?? 0);
			const from = site.languages.find((candidate) => candidate.default);
			return {
				defaultLanguage: { code: site.defaultLanguage, name: from?.name ?? site.defaultLanguage },
				languages,
				key: {
					inUse: readiness.key,
					capReached: readiness.capReached,
					capPercent: options.costs ? readiness.percent : null,
				},
				usage: {
					month,
					calls: Number(calls?.calls ?? 0),
					tokens: Number(calls?.tokens ?? 0),
					cost: options.costs ? Number(calls?.cost ?? 0) / 1_000_000 : null,
					cacheHits: pieces === 0 ? null : Math.round(((counted?.cached ?? 0) / pieces) * 100),
				},
			};
		},

		async setMode(scope, code, mode) {
			const { language } = await languageOf(scope, code);
			await scope.transaction(async (tx) => {
				await tx.db
					.update(siteLanguageRows)
					.set({ translationMode: mode })
					.where(and(eq(siteLanguageRows.siteId, tx.site.id), eq(siteLanguageRows.code, language.code)));
				await tx.audit("translationMode.change", { language: language.code, mode });
			});
		},

		async translateNow(scope, code) {
			const site = await siteLanguages(scope);
			const modes = await modesOf(scope.site.id);
			const wanted = code === undefined ? null : (await languageOf(scope, code)).language.code;
			const targets = site.languages
				.filter((language) => !language.default && (wanted === null || language.code === wanted))
				.filter((language) => modes.get(language.code) === "automatic" || modes.get(language.code) === "review");
			const items = await siteItems(scope);
			const personId = actingPerson(scope.access.actor);
			const place = { workspaceId: scope.workspace.id, siteId: scope.site.id };
			let queued = 0;
			for (const language of targets) {
				for (const item of items) {
					await enqueue(place, item, language.code, modes.get(language.code) === "automatic", personId);
					queued++;
				}
			}
			await scope.audit("translation.run", {
				languages: targets.map((language) => language.code),
				items: items.length,
			});
			if (queued > 0) await kick(scope.site.id);
			return { queued };
		},

		async queue(scope, filter) {
			const site = await siteLanguages(scope);
			const wanted = filter.language === undefined ? null : (await languageOf(scope, filter.language)).language.code;
			const targets = site.languages.filter(
				(language) => !language.default && (wanted === null || language.code === wanted),
			);
			const lines: QueueLine[] = [];
			const writers = new Set<string>();
			// A Form's emails are read only by people who may change them (recipients decide who gets leads).
			const readsEmails = can(scope.access.actor, "formEmails.edit", {
				level: "site",
				workspaceId: scope.workspace.id,
				siteId: scope.site.id,
			});
			for (const item of await siteItems(scope)) {
				if (item.kind === "formEmails" && !readsEmails) continue;
				const snapshot = await readItem(scope, item, site.defaultLanguage);
				if (!snapshot) continue;
				const units = snapshot.units(snapshot.draft);
				for (const language of targets) {
					if (snapshot.hiddenLanguages.includes(language.code)) continue;
					const found = itemTranslation(snapshot.draft, snapshot.published, units, {
						language: language.code,
						defaultLanguage: site.defaultLanguage,
					});
					const header = {
						kind: item.kind,
						id: itemId(item),
						title: snapshot.title,
						postTypeId: snapshot.postTypeId,
					};
					for (const at of found.toReview) {
						const unit = units.find((candidate) => apiPath(candidate.path) === at);
						if (!unit) continue;
						const leaf = leafAt(snapshot.draft, unit.path);
						lines.push({
							item: header,
							language: language.code,
							at,
							block: null,
							labels: unit.labels,
							status: "toReview",
							writtenBy: { kind: "ai" },
							source: textOf(unit.kind, leaf?.[site.defaultLanguage]),
							translation: textOf(unit.kind, leaf?.[language.code]),
							oldSource: null,
						});
					}
					for (const outdated of found.outdated) {
						const unit = units.find((candidate) => apiPath(candidate.path) === outdated.at);
						const by = unit ? leafAt(snapshot.draft, unit.path)?.[language.code]?.by : null;
						const personId = by?.kind === "person" ? by.personId : null;
						if (personId) writers.add(personId);
						lines.push({
							item: header,
							language: language.code,
							at: outdated.at,
							block: outdated.block,
							labels: outdated.labels,
							status: "outdated",
							writtenBy: { kind: "person", id: personId, name: null },
							source: outdated.newSource,
							translation: outdated.translation,
							oldSource: outdated.oldSource,
						});
					}
				}
			}
			if (writers.size > 0) {
				const names = new Map(
					(
						await scope.db
							.select({ id: people.id, name: people.name })
							.from(people)
							.where(inArray(people.id, [...writers]))
					).map((row) => [row.id, row.name]),
				);
				for (const line of lines) {
					if (line.writtenBy.kind === "person" && line.writtenBy.id) {
						line.writtenBy = { ...line.writtenBy, name: names.get(line.writtenBy.id) ?? null };
					}
				}
			}
			return lines;
		},

		async approve(scope, input) {
			const { site, language } = await languageOf(scope, input.language);
			const items = input.items ?? (await siteItems(scope));
			let approved = 0;
			for (const item of items) {
				if (
					item.kind === "formEmails" &&
					!can(scope.access.actor, "formEmails.edit", {
						level: "site",
						workspaceId: scope.workspace.id,
						siteId: scope.site.id,
					})
				) {
					continue;
				}
				if (
					item.kind !== "formEmails" &&
					!can(scope.access.actor, "entry.publish", {
						level: "site",
						workspaceId: scope.workspace.id,
						siteId: scope.site.id,
					})
				) {
					throw new PermissionDeniedError("entry.publish");
				}
				const paths: string[] = [];
				let snapshot: ItemSnapshot | null = null;
				await writeItem(scope, item, site.defaultLanguage, (current) => {
					snapshot = current;
					if (!current.published) return null;
					let published = current.published;
					for (const unit of current.units(current.draft)) {
						const draftLeaf = leafAt(current.draft, unit.path);
						const own = draftLeaf?.[language.code];
						const liveLeaf = leafAt(published, unit.path);
						if (own?.by?.kind !== "ai" || sameJson(own, liveLeaf?.[language.code])) continue;
						if (breaksRules(unit.field, own.value)) continue;
						published = withLeafAt(published, unit.path, { ...(liveLeaf ?? {}), [language.code]: own });
						paths.push(apiPath(unit.path));
					}
					return paths.length > 0 ? { published } : null;
				});
				if (snapshot && paths.length > 0) {
					await afterPublish(scope, snapshot, language.code, paths);
					approved += paths.length;
				}
			}
			return { approved };
		},

		async confirm(scope, input) {
			const { site, language } = await languageOf(scope, input.language);
			const path = storedPath(input.at);
			let found = false;
			await writeItem(scope, input.item, site.defaultLanguage, (current) => {
				const leaf = leafAt(current.draft, path);
				const own = leaf?.[language.code];
				const source = leaf?.[site.defaultLanguage]?.value;
				if (!leaf || !own || source === undefined) return null;
				if (input.block) {
					const defaults = storedBlocks(source);
					const blocks = storedBlocks(own.value).map((block) => {
						if (block.id !== input.block || !block.source) return block;
						const from = defaults.find((candidate) => candidate.id === block.source?.id);
						if (!from) return block;
						found = true;
						return { ...block, source: { ...block.source, was: blockContent(from) } };
					});
					const value = { ...own, value: blocks as unknown as Json };
					return found ? { draft: withLeafAt(current.draft, path, { ...leaf, [language.code]: value }) } : null;
				}
				found = true;
				return { draft: withLeafAt(current.draft, path, { ...leaf, [language.code]: { ...own, source } }) };
			});
			if (!found) throw new TranslationNotFoundError();
		},

		async retranslate(scope, input) {
			const { site, language, from } = await languageOf(scope, input.language);
			const snapshot = await itemFor(scope, input.item, site.defaultLanguage);
			const path = storedPath(input.at);
			const unit = snapshot.units(snapshot.draft).find((candidate) => candidate.path === path);
			if (!unit) throw new TranslationNotFoundError();
			const leaf = leafAt(snapshot.draft, path);
			const source = leaf?.[site.defaultLanguage]?.value;
			if (source === undefined || source === null) throw new TranslationNotFoundError();
			let target = leaf?.[language.code];
			let force = true;
			if (unit.kind === "body" && input.block) {
				// One Block again: it is marked as written by the AI from another source, so only it is translated.
				force = false;
				const blocks = storedBlocks(target?.value).map((block) =>
					block.id === input.block
						? { ...block, source: { id: block.source?.id ?? block.id, by: "ai" as const, was: {} } }
						: block,
				);
				target = target ? { ...target, value: blocks as unknown as Json } : target;
			}
			const job = [{ unit, source, target }];
			const values = await translateValues(
				{
					ai,
					keys,
					db: scope.db,
					moduleComponents: await modulePropsForTranslation(scope),
					place: { workspaceId: scope.workspace.id, siteId: scope.site.id },
					from: { code: from.code, name: from.name },
					to: { code: language.code, name: language.name },
					glossary: await glossaryOf(scope.db, scope.workspace.id, scope.site.id),
					now: clock.now(),
				},
				job,
				force,
			);
			const value = values.get(path);
			if (!value) return;
			await writeItem(scope, input.item, site.defaultLanguage, (current) => {
				const now = leafAt(current.draft, path);
				if (!sameJson(now?.[site.defaultLanguage]?.value, source)) return null;
				return { draft: withLeafAt(current.draft, path, { ...(now ?? {}), [language.code]: value }) };
			});
		},

		async itemTranslation(scope, item, language) {
			const site = await siteLanguages(scope);
			const snapshot = await readItem(scope, item, site.defaultLanguage);
			if (!snapshot) return null;
			return itemTranslation(snapshot.draft, snapshot.published, snapshot.units(snapshot.draft), {
				language,
				defaultLanguage: site.defaultLanguage,
			});
		},

		async afterAudit(entry) {
			try {
				if (entry.via.kind === "translation" || !entry.siteId || !entry.workspaceId || !entry.personId) return;
				const details = entry.details;
				const item: ItemRef | null =
					entry.action === "entry.publish" && typeof details.entryId === "string"
						? { kind: "entry", id: details.entryId }
						: entry.action === "globals.publish"
							? { kind: "globals" }
							: entry.action === "formEmails.publish" && typeof details.formId === "string"
								? { kind: "formEmails", id: details.formId }
								: null;
				if (!item) return;
				const [site] = await database.db
					.select({ defaultLanguage: sites.defaultLanguage })
					.from(sites)
					.where(eq(sites.id, entry.siteId));
				const modes = await modesOf(entry.siteId);
				const place = { workspaceId: entry.workspaceId, siteId: entry.siteId };
				let queued = false;
				for (const [code, mode] of modes) {
					if (code === site?.defaultLanguage || mode === "manual") continue;
					await enqueue(place, item, code, mode === "automatic", entry.personId);
					queued = true;
				}
				if (queued) await kick(entry.siteId);
			} catch (error) {
				// A publish never fails because of translation: at worst, nothing is queued.
				log.error("AI translation couldn't be queued after a publish", { siteId: entry.siteId, error });
			}
		},

		async runSite(siteId) {
			const claimed = await database.db
				.update(translationTasks)
				.set({ status: "running", updatedAt: clock.now() })
				.where(
					inArray(
						translationTasks.id,
						sql`(select ${translationTasks.id} from ${translationTasks}
							where ${translationTasks.siteId} = ${siteId} and ${translationTasks.status} = 'queued'
							order by ${translationTasks.createdAt} limit ${RUN_SIZE} for update skip locked)`,
					),
				)
				.returning();
			for (const task of claimed) {
				let outcome: Awaited<ReturnType<typeof runTask>>;
				try {
					outcome = await runTask(task);
				} catch (error) {
					if (error instanceof AiKeyMissingError) outcome = { status: "held", reason: "noKey" };
					else if (error instanceof AiCapReachedError) outcome = { status: "held", reason: "cap" };
					else if (error instanceof AiProviderError) outcome = { status: "failed", reason: error.problem };
					else {
						log.error("AI translation failed", { siteId, item: task.itemKind, language: task.language, error });
						outcome = { status: "failed", reason: "error" };
					}
				}
				await settleTask(task, outcome);
			}
			const [more] = await database.db
				.select({ id: translationTasks.id })
				.from(translationTasks)
				.where(and(eq(translationTasks.siteId, siteId), eq(translationTasks.status, "queued")))
				.limit(1);
			if (claimed.length === RUN_SIZE && more) await kick(siteId);
		},

		async resume() {
			await keys.releaseStale();
			const stale = new Date(clock.now().getTime() - STALE_RUN_MS);
			const requeued = await database.db
				.update(translationTasks)
				.set({ status: "queued", updatedAt: clock.now() })
				.where(and(eq(translationTasks.status, "running"), lt(translationTasks.updatedAt, stale)))
				.returning({ siteId: translationTasks.siteId });
			for (const siteId of new Set(requeued.map((row) => row.siteId))) await kick(siteId);
			const held = await database.db
				.selectDistinct({ workspaceId: translationTasks.workspaceId })
				.from(translationTasks)
				.where(and(eq(translationTasks.status, "held"), ne(translationTasks.reason, "access")))
				.orderBy(asc(translationTasks.workspaceId));
			for (const { workspaceId } of held) await resumeWorkspace(workspaceId);
		},

		resumeWorkspace,

		terms: {
			list: listProtectedTerms,
			add: addProtectedTerms,
			find: findProtectedTerm,
			remove: removeProtectedTerm,
		},
	};
}
