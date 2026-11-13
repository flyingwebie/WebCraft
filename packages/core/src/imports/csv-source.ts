/**
 * The CSV source: a CSV file read into one Post Type, one column per Field (or Skip). Each row
 * becomes one Entry item for the pipeline (`pipeline.ts`): its values read through each Field type's
 * own reading of text (`fromText` in `FIELD_TYPE_SPECS`), its matching value (a Field, the title or
 * the slug) and its Source id.
 *
 * - **Empty cells change nothing**: a new Entry keeps the Field's default, an updated one its value.
 * - **A cell a Field can't take** is left out of the row and listed in the Import report, at its row
 *   and column, with the rule; the rest of the row is still imported.
 * - **The language** is the Site's Default language unless the Import names another of the Site's
 *   languages. Translations come in by running a CSV in that language, matched by the same column:
 *   Translatable fields are written in it, shared Fields hold one value for every language (so map
 *   only what is translated), and a row matching no Entry isn't imported (there is nothing to
 *   translate).
 */
import { z } from "zod";
import { PostTypeNotFoundError } from "../content/errors.ts";
import { ENTRY_TITLE_MAX_LENGTH } from "../content/field-rules.ts";
import {
	type FieldDefinition,
	type Json,
	type LeafField,
	specOf,
	type TextReading,
	type ValueSpec,
} from "../content/field-types.ts";
import { languagesFor, siteLanguages } from "../content/languages.ts";
import { getPostType, type PostType } from "../content/post-types.ts";
import { ENTRY_SLUG, ENTRY_SLUG_MAX_LENGTH } from "../content/url-patterns.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { CSV_LIMITS, type CsvRecord } from "./csv.ts";
import { ImportInvalidError, type ImportSettingProblem } from "./errors.ts";
import type { EntryItem, ItemDestination, ItemProblem } from "./items.ts";

/** Where a column goes: the title, the slug or a Field (`fields.price`, `fields.address.city`); null skips it. */
const target = z.string().trim().min(1).max(300);

/** A CSV Import's settings: its Post Type, its language, how rows match Entries, and where each column goes. */
export const csvSettingsSchema = z.object({
	postTypeId: z.uuid(),
	/** One of the Site's languages; null for its Default language. */
	language: z.string().min(2).max(35).nullable(),
	/** What a row matches existing Entries by: `title`, `slug` or a Field (`fields.sku`). */
	match: target,
	columns: z
		.array(z.object({ column: z.string().trim().min(1).max(300), to: target.nullable() }))
		.max(CSV_LIMITS.maxColumns),
});

export type CsvSettings = z.infer<typeof csvSettingsSchema>;

/** Where a column's values go. */
export type CsvTarget =
	| { kind: "title"; to: "title" }
	| { kind: "slug"; to: "slug" }
	| { kind: "field"; to: string; path: string[]; field: LeafField };

/** A CSV Import's settings checked against the Site: what a run needs to read rows. */
export type CsvMapping = ItemDestination & {
	/** Where each mapped column goes, by its name in lower case. */
	columns: Map<string, CsvTarget>;
	match: CsvTarget;
};

/** The Field types a row can match Entries by, besides the title and the slug. */
const MATCHABLE_TYPES: ReadonlySet<string> = new Set(["text", "email", "number"]);

/**
 * Checks a CSV Import's settings against the scope's Site: a Post Type and language it has, columns
 * going to its title, slug or leaf Fields (inside Groups too, never Repeaters), each at most once,
 * and a matching value one of the columns fills. Throws `ImportInvalidError` with every problem.
 */
export async function csvMapping(scope: SiteScope, settings: CsvSettings): Promise<CsvMapping> {
	const problems: ImportSettingProblem[] = [];
	let postType: PostType;
	try {
		postType = await getPostType(scope, settings.postTypeId);
	} catch (error) {
		if (!(error instanceof PostTypeNotFoundError)) throw error;
		throw new ImportInvalidError([
			{ at: "settings.postTypeId", rule: "postTypeNotFound", message: "The Site has no such Post Type." },
		]);
	}
	const languages = languagesFor(await siteLanguages(scope), settings.language ?? undefined);
	if (!languages) {
		problems.push({
			at: "settings.language",
			rule: "languageUnknown",
			message: `The Site has no language ${settings.language}.`,
			params: { language: settings.language },
		});
	}
	const columns = new Map<string, CsvTarget>();
	const taken = new Map<string, number>();
	settings.columns.forEach(({ column, to }, index) => {
		const name = column.toLocaleLowerCase();
		if (columns.has(name) || (to === null && taken.has(`column:${name}`))) {
			problems.push({
				at: `settings.columns[${index}].column`,
				rule: "columnTwice",
				message: `The column ${column} is mapped twice.`,
				params: { column },
			});
			return;
		}
		taken.set(`column:${name}`, index);
		if (to === null) return;
		const found = targetOf(postType, to);
		if (typeof found === "string") {
			problems.push({
				at: `settings.columns[${index}].to`,
				rule: found,
				message:
					found === "targetUnknown"
						? `The Post Type has no Field ${to}.`
						: `${to} can't take a column: map its Fields one by one.`,
				params: { to },
			});
			return;
		}
		if (taken.has(found.to)) {
			problems.push({
				at: `settings.columns[${index}].to`,
				rule: "targetTwice",
				message: `Two columns go into ${to}.`,
				params: { to },
			});
			return;
		}
		taken.set(found.to, index);
		columns.set(name, found);
	});
	const match = targetOf(postType, settings.match);
	if (
		typeof match === "string" ||
		(match.kind === "field" && (match.path.length > 1 || !MATCHABLE_TYPES.has(match.field.type)))
	) {
		problems.push({
			at: "settings.match",
			rule: "matchUnknown",
			message: "Rows match Entries by the title, the slug, or a text, email or number Field of the Post Type.",
			params: { to: settings.match },
		});
	} else if (![...columns.values()].some((mapped) => mapped.to === match.to)) {
		problems.push({
			at: "settings.match",
			rule: "matchNotMapped",
			message: "No column goes into what rows match Entries by.",
			params: { to: settings.match },
		});
	}
	if (problems.length > 0 || !languages || typeof match === "string") throw new ImportInvalidError(problems);
	return { postType, languages, columns, match };
}

/** Where `to` goes in a Post Type, or why it can't take a column. */
function targetOf(postType: PostType, to: string): CsvTarget | "targetUnknown" | "targetNotLeaf" {
	if (to === "title") return { kind: "title", to };
	if (to === "slug") return { kind: "slug", to };
	if (!to.startsWith("fields.")) return "targetUnknown";
	const path = to.slice("fields.".length).split(".");
	let fields: readonly FieldDefinition[] = postType.fields;
	for (const [index, key] of path.entries()) {
		const field = fields.find((candidate) => candidate.key === key);
		if (!field) return "targetUnknown";
		const last = index === path.length - 1;
		if (field.type === "group") {
			if (last) return "targetNotLeaf";
			fields = field.fields;
			continue;
		}
		if (field.type === "repeater") return "targetNotLeaf";
		if (!last) return "targetUnknown";
		return { kind: "field", to, path, field };
	}
	return "targetUnknown";
}

/** The columns of a file the settings don't map anywhere: the run skips them and its report lists them. */
export function skippedColumns(mapping: CsvMapping, header: readonly string[]): string[] {
	return header.filter((name) => !mapping.columns.has(name.toLocaleLowerCase()));
}

/**
 * Reads one row of a CSV file as an Entry item: each mapped, non-empty cell through its Field type's
 * reading of text. A cell the Field can't take is a problem at its column, left out of the values.
 */
export function csvItem(record: CsvRecord, header: readonly string[], mapping: CsvMapping): EntryItem {
	const problems: ItemProblem[] = [];
	const item: EntryItem = {
		position: record.position,
		sourceId: null,
		match: null,
		values: { fields: {} },
		finds: [],
		problems,
	};
	let matchValue: Json | undefined;
	let matchColumn = "";
	const extra = record.cells.slice(header.length).some((cell) => cell.trim() !== "");
	if (extra) {
		problems.push({ column: null, rule: "columnCount", params: { columns: header.length }, row: true });
	}
	header.forEach((column, index) => {
		const target = mapping.columns.get(column.toLocaleLowerCase());
		const cell = record.cells[index] ?? "";
		if (!target) return;
		if (target.to === mapping.match.to) matchColumn = column;
		if (cell.trim() === "") return;
		const read = readCell(cell, target);
		if ("problem" in read) {
			problems.push({ column, rule: read.problem, ...(read.params ? { params: read.params } : {}) });
			return;
		}
		if ("reading" in read) {
			if (target.kind === "field") {
				item.finds.push({ column, path: target.path, field: target.field, reading: read.reading });
			}
			return;
		}
		if (target.kind === "title" || target.kind === "slug") {
			item.values[target.kind] = read.value as string;
		} else if (target.field.type === "media") {
			// A file already in the Media library: found (and checked) before the row is written.
			item.finds.push({ column, path: target.path, field: target.field, reading: { media: String(read.value) } });
		} else {
			setAt(item.values.fields, target.path, read.input);
		}
		if (target.to === mapping.match.to) matchValue = read.value;
	});
	if (matchValue === undefined || matchValue === null || matchValue === "") {
		problems.push({ column: matchColumn || null, rule: "matchMissing", row: true });
	} else {
		item.match = { to: mapping.match.to, value: matchValue };
		item.sourceId = `${mapping.match.to}:${matchKey(matchValue)}`;
	}
	return item;
}

/** A value's form for matching: text in lower case, without the spaces around it; numbers as written by JavaScript. */
export function matchKey(value: Json): string {
	return typeof value === "string" ? value.trim().toLocaleLowerCase() : JSON.stringify(value);
}

export type CellRead =
	| { value: Json; input: unknown }
	| { reading: Extract<TextReading, { entries: string[] } | { file: string }> }
	| { problem: string; params?: Record<string, string | number> };

/** One cell read for where it goes. */
function readCell(cell: string, target: CsvTarget): CellRead {
	if (target.kind === "title") {
		const title = cell.trim();
		return title.length > ENTRY_TITLE_MAX_LENGTH
			? { problem: "tooLong", params: { max: ENTRY_TITLE_MAX_LENGTH } }
			: { value: title, input: title };
	}
	if (target.kind === "slug") {
		const slug = cell.trim().toLowerCase();
		return ENTRY_SLUG.test(slug) && slug.length <= ENTRY_SLUG_MAX_LENGTH
			? { value: slug, input: slug }
			: { problem: "slug" };
	}
	return readFieldText(cell, target.field);
}

/**
 * A value written as text, read for a Field through its type's reading of text (`fromText`): the
 * value to store, what must be found first (Entries, a file), or why the Field can't take it.
 */
export function readFieldText(cell: string, field: LeafField): CellRead {
	const spec = specOf(field).value as unknown as ValueSpec<LeafField>;
	const reading = spec.fromText(cell, field);
	if ("problem" in reading) return reading;
	if (!("input" in reading)) return { reading };
	let refused = false;
	const value = spec.parse(
		reading.input,
		field,
		() => {
			refused = true;
			return null;
		},
		() => {},
	);
	if (refused) return { problem: reading.rule };
	return { value, input: reading.input };
}

/** Sets a value inside nested Group values, by its path of keys. */
export function setAt(values: Record<string, unknown>, path: readonly string[], value: unknown): void {
	const [key, ...rest] = path;
	if (key === undefined) return;
	if (rest.length === 0) {
		values[key] = value;
		return;
	}
	const inner = (values[key] ?? {}) as Record<string, unknown>;
	values[key] = inner;
	setAt(inner, rest, value);
}
