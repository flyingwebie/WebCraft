/**
 * The survey of a source's file: once a file uploaded in parts is whole, the worker reads it through
 * its Module (as a stream) and records what it holds, for the Map step: each type of item, how many
 * items it has, each key its items have (how many have it, and a value from one of them), and the
 * first items of each type as samples (the live sample Entry, and the Preview's real Entries). A file
 * the Module refuses (not one it reads, a document type declared, broken XML) is `refused`, with its
 * reason.
 */
import { importFiles } from "@webcraft/db/schema";
import { isModuleError, type SourceFile, type SourceItem, type SourceValue } from "@webcraft/module-sdk";
import { textFromHtml } from "@webcraft/renderer/body";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { defineJob, type JobContext } from "../jobs/define.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import type { BackgroundScope } from "../tenancy/data-layer.ts";
import { IMPORT_FILE_LIFETIME_MS } from "./files.ts";
import { captureLive } from "./live.ts";
import { streamParts } from "./uploads.ts";

/** How many items of each type a survey keeps as samples. */
export const SURVEY_SAMPLES = 20;

/** The longest HTML value a sample keeps, in characters. */
const SAMPLE_HTML_LENGTH = 20_000;

/** A key of a type's items: what its values are, how many items have it, and one of them. */
export type SurveyKey = {
	key: string;
	/** `title` and `slug` for an item's own; otherwise its values' kind. */
	kind: "title" | "slug" | SourceValue["kind"];
	count: number;
	/** A value from the first item having it, as short plain text. */
	sample: string | null;
};

/** A type of item in a source's file. */
export type SurveyType = {
	key: string;
	label: string;
	holds: "entries" | "media";
	count: number;
	keys: SurveyKey[];
	/** Its first items, in the file's order. */
	samples: SourceItem[];
};

/** What a source's file holds. */
export type SourceSurvey = { items: number; types: SurveyType[] };

/** A source's file once surveyed, or why it was refused. */
export type SourceFileDetails = {
	live?: {
		importId: string;
		connection: import("./live.ts").ImportConnection;
		survey: import("@webcraft/module-sdk").LiveSurvey;
	};
	survey?: SourceSurvey;
	refusal?: { code: string; message: string };
};

type FileRow = typeof importFiles.$inferSelect;

/** Bytes that aren't UTF-8 in a source's file. */
class NotUtf8Error extends Error {}

/** A source's uploaded file as the Module reads it: its text, as many times as it reads it. */
export function sourceFileOf(storage: InstallStorage, row: FileRow): SourceFile {
	return {
		name: row.fileName,
		size: row.sizeBytes,
		async *text() {
			const stream = await streamParts(storage, row);
			if (!stream) throw new Error("The file is missing from storage.");
			const decoder = new TextDecoder("utf-8", { fatal: true });
			const reader = stream.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					let text: string;
					try {
						text = done ? decoder.decode() : decoder.decode(value, { stream: true });
					} catch {
						throw new NotUtf8Error("The file isn't UTF-8.");
					}
					if (text !== "") yield text;
					if (done) return;
				}
			} finally {
				await reader.cancel().catch(() => {});
			}
		},
	};
}

/** How long a survey's job may run before the job queue gives up on it. */
const SURVEY_JOB_SECONDS = 60 * 60;

/**
 * Surveys a source's file in the worker (see the module's comment), for the attempt the job was sent
 * for (0 until the file is surveyed again; see `recoverSurveys`).
 */
export const importsSurvey = defineJob({
	name: "imports.survey",
	payload: z.object({ siteId: z.uuid(), fileId: z.uuid(), attempt: z.number().int().min(0).optional() }),
	queue: { retryLimit: 0, expireInSeconds: SURVEY_JOB_SECONDS },
	run: ({ siteId, fileId, attempt }, context) => runSurvey(context, siteId, fileId, attempt ?? 0),
});

/**
 * A file still `surveying` this long after its survey started lost its worker (killed, out of
 * memory, or its job was never sent): longer than a survey's job may run.
 */
export const STALLED_SURVEY_MS = SURVEY_JOB_SECONDS * 1000 + 30 * 60_000;

/** How many times a file is surveyed again before it is refused instead (see `RUN_ATTEMPTS`). */
export const SURVEY_ATTEMPTS = 3;

/** Why a file whose survey kept stopping its worker, or failed unexpectedly, is refused. */
const SURVEY_FAILED = { code: "error", message: "The file couldn't be read." };

async function runSurvey(context: JobContext, siteId: string, fileId: string, attempt: number): Promise<void> {
	const scope = await context.data.background(siteId);
	const row = scope ? await scope.first(importFiles, eq(importFiles.id, fileId)) : undefined;
	if (!scope || !row || row.status !== "surveying") return;
	// The file was surveyed again after this job was sent: the new attempt's job records the survey.
	if (row.surveyAttempt !== attempt) return;
	const finish = (result: SourceFileDetails) => finishSurvey(scope, row, result);
	const source = await context.modules.importSource(scope.site, row.source);
	if (!source) {
		return finish({ refusal: { code: "source", message: "The Module reading this file isn't on for the Site." } });
	}
	try {
		return await finish({
			survey:
				source.kind === "live"
					? await captureLive(context, row, source)
					: await surveyItems(source.read(sourceFileOf(context.storage, row))),
		});
	} catch (error) {
		const refusal = refusalOf(error);
		if (refusal) return finish({ refusal });
		context.log.error("An import source couldn't survey a file", { siteId, fileId, error });
		return finish({ refusal: SURVEY_FAILED });
	}
}

/** Records what a file's survey found (or why it was refused), for the attempt that surveyed it. */
async function finishSurvey(scope: BackgroundScope, row: FileRow, result: SourceFileDetails): Promise<void> {
	const details = { ...(row.details as SourceFileDetails), ...result };
	const now = scope.now();
	await scope.update(
		importFiles,
		{
			status: details.survey ? "ready" : "refused",
			details,
			expiresAt: new Date(now.getTime() + IMPORT_FILE_LIFETIME_MS),
		},
		and(
			eq(importFiles.id, row.id),
			eq(importFiles.status, "surveying"),
			eq(importFiles.surveyAttempt, row.surveyAttempt),
		),
	);
}

/**
 * Surveys again, on every Site, the files whose survey lost its worker (`STALLED_SURVEY_MS`), with a
 * new attempt whose job is the only one that records the survey. A file surveyed again
 * `SURVEY_ATTEMPTS` times already is refused instead.
 */
export async function recoverSurveys(context: JobContext): Promise<void> {
	const { database, data, jobs, clock, log } = context;
	const before = new Date(clock.now().getTime() - STALLED_SURVEY_MS);
	// A file that started surveying before its start was recorded counts as stalled.
	const stalled = and(
		eq(importFiles.status, "surveying"),
		or(isNull(importFiles.surveyStartedAt), lt(importFiles.surveyStartedAt, before)),
	);
	// Install-wide enumeration only; each file is read and changed in its Site's background scope.
	const sites = await database.db.selectDistinct({ siteId: importFiles.siteId }).from(importFiles).where(stalled);
	for (const { siteId } of sites) {
		const scope = await data.background(siteId);
		if (!scope) continue;
		for (const { id } of await scope.select(importFiles, stalled)) {
			const picked = await scope.transaction(async (tx) => {
				const [row] = await tx.db
					.select()
					.from(importFiles)
					.where(tx.where(importFiles, and(eq(importFiles.id, id), stalled)))
					.for("update");
				// It was surveyed meanwhile.
				if (!row) return null;
				if (row.surveyAttempt >= SURVEY_ATTEMPTS) {
					await finishSurvey(tx, row, { refusal: SURVEY_FAILED });
					return { row, again: false };
				}
				const [saved] = await tx.update(
					importFiles,
					{ surveyAttempt: row.surveyAttempt + 1, surveyStartedAt: tx.now() },
					eq(importFiles.id, row.id),
				);
				return { row: saved as FileRow, again: true };
			});
			if (!picked) continue;
			const { row, again } = picked;
			if (again) {
				log.warn("An Import file's survey lost its worker: it is surveyed again", {
					siteId,
					fileId: row.id,
					attempt: row.surveyAttempt,
				});
				await jobs.send(importsSurvey, { siteId, fileId: row.id, attempt: row.surveyAttempt });
			} else {
				log.warn("An Import file's survey lost its worker too many times: the file is refused", {
					siteId,
					fileId: row.id,
				});
			}
		}
	}
}

/** Why a file was refused, from what its reading threw; null for a failure that isn't a refusal. */
export function refusalOf(error: unknown): { code: string; message: string } | null {
	if (error instanceof NotUtf8Error) return { code: "encoding", message: "The file isn't UTF-8 text." };
	if (isModuleError(error)) return { code: error.code, message: error.message };
	return null;
}

/** Goes through a source's items, counting them by type and key and keeping each type's first items. */
export async function surveyItems(items: AsyncIterable<SourceItem>): Promise<SourceSurvey> {
	const types = new Map<string, SurveyType & { keyMap: Map<string, SurveyKey> }>();
	let count = 0;
	const typeOf = (key: string, holds: "entries" | "media", label?: string) => {
		let type = types.get(key);
		if (!type) {
			type = { key, label: label ?? key, holds, count: 0, keys: [], samples: [], keyMap: new Map() };
			types.set(key, type);
		}
		return type;
	};
	const note = (
		type: SurveyType & { keyMap: Map<string, SurveyKey> },
		key: string,
		kind: SurveyKey["kind"],
		sample: string | null,
	) => {
		let found = type.keyMap.get(key);
		if (!found) {
			found = { key, kind, count: 0, sample: null };
			type.keyMap.set(key, found);
			type.keys.push(found);
		}
		found.count++;
		if (found.sample === null && sample) found.sample = sample;
	};
	for await (const item of items) {
		if (item.kind === "type") {
			typeOf(item.key, item.holds, item.label);
			continue;
		}
		count++;
		if (item.kind === "media") {
			const type = typeOf(item.type, "media");
			type.count++;
			if (type.samples.length < SURVEY_SAMPLES) type.samples.push(item);
			continue;
		}
		const type = typeOf(item.type, "entries");
		type.count++;
		note(type, "title", "title", item.values.title ? sampleOf(item.values.title) : shortText(item.title));
		if (item.slug) note(type, "slug", "slug", item.slug);
		for (const [key, value] of Object.entries(item.values))
			if (key !== "title") note(type, key, value.kind, sampleOf(value));
		if (type.samples.length < SURVEY_SAMPLES) type.samples.push(trimmedSample(item));
	}
	return {
		items: count,
		types: [...types.values()].map(({ keyMap: _, ...type }) => type),
	};
}

/** A sample as kept: long HTML values shortened. */
function trimmedSample(item: Extract<SourceItem, { kind: "entry" }>): SourceItem {
	const values: Record<string, SourceValue> = {};
	for (const [key, value] of Object.entries(item.values)) {
		values[key] = value.kind === "html" ? { kind: "html", html: value.html.slice(0, SAMPLE_HTML_LENGTH) } : value;
	}
	return { ...item, values };
}

/** A value as short plain text, for the Map step. */
function sampleOf(value: SourceValue): string | null {
	switch (value.kind) {
		case "text":
			return shortText(value.text);
		case "html":
			return shortText(textFromHtml(value.html));
		case "date":
			return value.date;
		case "file":
			return shortText(value.file.address.split("/").pop() ?? value.file.address);
		case "items":
			return `${value.sourceIds.length}`;
	}
}

function shortText(text: string): string | null {
	const plain = text.replace(/\s+/g, " ").trim();
	if (plain === "") return null;
	return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain;
}
