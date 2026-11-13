import type { ApiClient } from "@webcraft/api";
import type { CsvSettings, FieldDefinition, ImportProblem } from "@webcraft/core";

import type { MessageKey } from "../i18n.tsx";

/** An Import as the Management API answers it, with its newest run. */
export type ImportView = Awaited<ReturnType<ApiClient["imports"]["get"]>>["import"];

/** A run's progress and Import report. */
export type RunReport = Awaited<ReturnType<ApiClient["imports"]["report"]>>["run"];

/** What a run would do with a file. */
export type PreviewView = Awaited<ReturnType<ApiClient["imports"]["preview"]>>["preview"];

/** A CSV file uploaded for an Import: its columns with the first row's values, rows and separator. */
export type CsvFileView = Awaited<ReturnType<ApiClient["imports"]["uploadCsv"]>>["file"];

/** A Post Type with its Fields. */
export type ImportPostType = Awaited<ReturnType<ApiClient["postTypes"]["get"]>>["postType"];

/** A file uploaded in parts for a Module's import source, and what the worker found in it. */
export type SourceFileView = Awaited<ReturnType<ApiClient["imports"]["file"]>>["file"];

/** A Module source's Import settings: where each type and key goes. */
export type SourceSettings = NonNullable<SourceFileView["suggested"]>;

/** The Map step's live sample: one item read with the settings as they are. */
export type SourceSampleView = Awaited<ReturnType<ApiClient["imports"]["sample"]>>["sample"];

/** What a run of a source's file would do, worked out in the worker. */
export type SourcePreviewView = Awaited<ReturnType<ApiClient["imports"]["previewSource"]>>["preview"];

/** An Entry as the Preview and the sample show it. */
export type PreviewEntryView = SourcePreviewView["entries"][number];

/**
 * A Block in short, for the Preview: its text, a list's items, an image's file (with its alt text),
 * a video's address, a table's size.
 */
export function blockSummary(
	block: NonNullable<PreviewEntryView["body"]>["blocks"][number],
	images: readonly { blockId: string; address: string }[] = [],
): string {
	const runs = (text: unknown) =>
		Array.isArray(text) ? text.map((run) => (run as { text?: string }).text ?? "").join("") : "";
	const value = block as unknown as Record<string, unknown>;
	switch (block.type) {
		case "paragraph":
		case "quote":
		case "callout":
		case "heading":
			return runs(value.text);
		case "list": {
			const items = (value.items as { text: unknown }[] | undefined) ?? [];
			return items.map((item) => `• ${runs(item.text)}`).join("  ");
		}
		case "image":
			return (
				images
					.find((image) => image.blockId === block.id)
					?.address.split("/")
					.pop() ?? ""
			);
		case "video":
			return String(value.url ?? "");
		case "table":
			return `${((value.rows as unknown[]) ?? []).length} × ${(((value.rows as unknown[][]) ?? [])[0] ?? []).length}`;
		case "code":
			return String(value.code ?? "").split("\n")[0] ?? "";
		case "toggle":
			return runs(value.summary);
		default:
			return "";
	}
}

/** A refused upload, worded: why, with what fills it in. Null for any other error. */
export function uploadRefusal(error: unknown): { key: MessageKey; values: Record<string, number> } | null {
	const { code, data } = (error ?? {}) as { code?: unknown; data?: Record<string, unknown> };
	if (code !== "IMPORT_UPLOAD_REFUSED") return null;
	const maxBytes = typeof data?.maxBytes === "number" ? data.maxBytes : 0;
	switch (data?.reason) {
		case "size":
			return { key: "imports.sourceFlow.uploadRefused.size", values: { gigabytes: Math.round(maxBytes / 1024 ** 3) } };
		case "hash":
		case "offset":
		case "part":
		case "status":
			return { key: `imports.sourceFlow.uploadRefused.${data.reason}`, values: {} };
		default:
			return { key: "errors.generic", values: {} };
	}
}

/** A Module source's settings refused (`IMPORT_INVALID`), worded by its first problem. Null for any other error. */
export function sourceSettingWording(error: unknown): MessageKey | null {
	const { code, data } = (error ?? {}) as { code?: unknown; data?: { problems?: { rule: string }[] } };
	if (code !== "IMPORT_INVALID") return null;
	const rule = data?.problems?.[0]?.rule;
	switch (rule) {
		case "keyKind":
		case "fieldKeyTaken":
		case "bodyOnPage":
		case "bodyTwice":
		case "relationshipTarget":
		case "targetTwice":
		case "targetUnknown":
		case "postTypeNotFound":
		case "typeTwice":
			return `imports.sourceFlow.settingRules.${rule}`;
		default:
			return "imports.sourceFlow.settingRules.other";
	}
}

export type { CsvSettings, ImportProblem };

/** Where a column can go: the title, the slug, or a Field (inside Groups too), with how people see it. */
export type ColumnTarget = {
	to: string;
	/** The Field's label, with its Groups' labels before it (`Origin › City`). */
	label: string;
	/** Its type (`title` and `slug` for the built-in ones). */
	type: string;
	/** Whether rows can match existing Entries by it. */
	matchable: boolean;
};

/** The Field types rows can match Entries by, besides the title and the slug (as the server checks). */
const MATCHABLE_TYPES = new Set(["text", "email", "number"]);

/** Every place a Post Type's column can go: its title and slug, then its Fields and Groups' Fields in order. */
export function columnTargets(postType: ImportPostType, labels: { title: string; slug: string }): ColumnTarget[] {
	const targets: ColumnTarget[] = [
		{ to: "title", label: labels.title, type: "title", matchable: true },
		{ to: "slug", label: labels.slug, type: "slug", matchable: true },
	];
	const walk = (fields: readonly FieldDefinition[], path: string, label: string, top: boolean) => {
		for (const field of fields) {
			if (field.type === "repeater") continue;
			const to = `${path}${field.key}`;
			const named = label ? `${label} › ${field.label}` : field.label;
			if (field.type === "group") walk(field.fields, `${to}.`, named, false);
			else targets.push({ to, label: named, type: field.type, matchable: top && MATCHABLE_TYPES.has(field.type) });
		}
	};
	walk(postType.fields, "fields.", "", true);
	return targets;
}

/** Words without case, spaces, dashes or underscores, for comparing a column's name with a Field's. */
function folded(name: string): string {
	return name.toLocaleLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Where each column goes at first: the Field whose key or label is the column's name (`price`,
 * `Price`), `name` and `title` to the title, `slug` to the slug; anything else is skipped.
 */
export function suggestedColumns(
	columns: readonly string[],
	targets: readonly ColumnTarget[],
): { column: string; to: string | null }[] {
	const taken = new Set<string>();
	return columns.map((column) => {
		const name = folded(column);
		const found =
			targets.find(
				(target) =>
					!taken.has(target.to) &&
					(folded(target.to.split(".").at(-1) ?? "") === name || folded(target.label) === name),
			) ?? (name === "name" && !taken.has("title") ? targets.find((target) => target.to === "title") : undefined);
		if (!found) return { column, to: null };
		taken.add(found.to);
		return { column, to: found.to };
	});
}

/** What rows match Entries by at first: a mapped matchable Field (a SKU), else the slug, else the title. */
export function suggestedMatch(columns: readonly { to: string | null }[], targets: readonly ColumnTarget[]): string {
	const mapped = new Set(columns.flatMap((column) => (column.to ? [column.to] : [])));
	const field = targets.find(
		(target) => target.matchable && target.type !== "title" && target.type !== "slug" && mapped.has(target.to),
	);
	if (field) return field.to;
	return mapped.has("slug") ? "slug" : "title";
}

/** A rule a problem breaks, worded: its message key and what fills it in. */
export function problemWording(problem: Pick<ImportProblem, "rule" | "params">): {
	key: MessageKey;
	values: Record<string, string | number>;
} {
	const params = problem.params ?? {};
	switch (problem.rule) {
		case "number":
		case "boolean":
		case "date":
		case "mediaAddress":
		case "mediaNotFound":
		case "link":
		case "tooLong":
		case "slug":
		case "matchMissing":
		case "translationWithoutEntry":
		case "media":
			return { key: `imports.rules.${problem.rule}`, values: {} };
		case "choice":
			return { key: "imports.rules.choice", values: { value: String(params.value ?? "") } };
		case "entryNotFound":
		case "entryAmbiguous":
			return { key: `imports.rules.${problem.rule}`, values: { name: String(params.name ?? "") } };
		case "notFetched":
			return {
				key: `imports.fetchProblems.${fetchProblem(params.problem)}`,
				values: { status: Number(params.status ?? 0) },
			};
		case "columnCount":
			return { key: "imports.rules.columnCount", values: { columns: Number(params.columns ?? 0) } };
		case "matchedTwice":
			return { key: "imports.rules.matchedTwice", values: { row: Number(params.row ?? 0) } };
		case "matchesSeveral":
			return { key: "imports.rules.matchesSeveral", values: { count: Number(params.count ?? 0) } };
		case "slugTaken":
			return { key: "imports.rules.slugTaken", values: { slug: String(params.slug ?? "") } };
		default:
			return { key: "imports.rules.refused", values: {} };
	}
}

const FETCH_PROBLEMS = [
	"scheme",
	"host",
	"address",
	"redirects",
	"timeout",
	"size",
	"status",
	"type",
	"quota",
] as const;

function fetchProblem(problem: unknown): (typeof FETCH_PROBLEMS)[number] | "unreachable" {
	return FETCH_PROBLEMS.includes(problem as (typeof FETCH_PROBLEMS)[number])
		? (problem as (typeof FETCH_PROBLEMS)[number])
		: "unreachable";
}

/** A refused CSV file, worded: why, with what fills it in. Null for any other error. */
export function fileRefusal(error: unknown): { key: MessageKey; values: Record<string, number> } | null {
	const { code, data } = (error ?? {}) as { code?: unknown; data?: Record<string, unknown> };
	if (code !== "IMPORT_FILE_REFUSED") return null;
	const values = Object.fromEntries(
		Object.entries(data ?? {}).flatMap(([key, value]) => (typeof value === "number" ? [[key, value]] : [])),
	);
	if (typeof values.maxBytes === "number") values.megabytes = Math.round(values.maxBytes / (1024 * 1024));
	switch (data?.reason) {
		case "size":
		case "encoding":
		case "empty":
		case "header":
		case "quote":
		case "cell":
		case "rows":
		case "columns":
			return { key: `imports.fileRefused.${data.reason}`, values };
		default:
			return { key: "errors.generic", values: {} };
	}
}

/** A setting problem the server answered (`IMPORT_INVALID`), worded. */
export function settingWording(rule: string): MessageKey {
	switch (rule) {
		case "postTypeNotFound":
		case "languageUnknown":
		case "columnTwice":
		case "targetUnknown":
		case "targetNotLeaf":
		case "targetTwice":
		case "matchUnknown":
		case "matchNotMapped":
			return `imports.settingRules.${rule}`;
		default:
			return "errors.generic";
	}
}

/** A file name without its `.csv` (or `.tsv`, `.txt`, `.xml`) ending: an Import's name until people give one. */
export function nameOfFile(fileName: string): string {
	return fileName.replace(/\.(csv|tsv|txt|xml)$/i, "") || fileName;
}

/** Whether a run is still going (waiting for the worker, or running). */
export function isGoing(status: string): boolean {
	return status === "waiting" || status === "running";
}
