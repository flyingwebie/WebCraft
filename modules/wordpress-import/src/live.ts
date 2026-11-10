import {
	type LiveConnection,
	type LiveImportSource,
	type LiveSurvey,
	ModuleError,
	type SourceEntry,
	type SourceItem,
	type SourceValue,
} from "@webcraft/module-sdk";
import { INTERNAL_POST_TYPES, INTERNAL_TAXONOMIES } from "./export.ts";

const PAGE_SIZE = 100;
const MAX_ITEMS = 1_000_000;
const fail = (code: string, message: string): never => {
	throw new ModuleError(code, message);
};
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return fail("response", "WordPress returned an invalid response.");
	return value as RecordValue;
}
function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function html(value: unknown): string {
	const v = object(value ?? {});
	return text(v.raw ?? v.rendered);
}
function id(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1)
		return fail("response", "WordPress returned an invalid Source id.");
	return value as number;
}
async function get(
	connection: LiveConnection,
	route: string,
	anonymous = false,
): Promise<{ response: Response; value: unknown }> {
	let response: Response;
	try {
		response = await connection.http(route, { anonymous });
	} catch {
		return fail("fetch", "The WordPress source could not be reached safely. Test the connection again.");
	}
	if (!response.ok) {
		if (response.status === 401 || response.status === 403)
			return fail(
				"authentication",
				"WordPress refused access. Check the application password and the account's permissions.",
			);
		if (response.status === 429)
			return fail("rateLimit", "WordPress limited requests. Wait before testing the connection again.");
		return fail(
			"fetch",
			"WordPress refused a REST route or redirected the request. Check the Site address and try again.",
		);
	}
	try {
		return { response, value: await response.json() };
	} catch {
		return fail("response", "WordPress did not return JSON.");
	}
}
function total(response: Response, name: string): number {
	const raw = response.headers.get(name);
	if (!raw || !/^\d+$/.test(raw) || Number(raw) > MAX_ITEMS)
		return fail("pagination", "WordPress did not return bounded pagination totals.");
	return Number(raw);
}
function query(
	type: LiveSurvey["types"][number],
	connection: LiveConnection,
	page: number,
	perPage = PAGE_SIZE,
): string {
	const params = new URLSearchParams({
		context: connection.includeHidden ? "edit" : "view",
		per_page: String(perPage),
		page: String(page),
		orderby: "id",
		order: "asc",
	});
	if (type.taxonomy) params.set("hide_empty", "false");
	else if (type.holds === "media") params.set("status", "inherit");
	else params.set("status", connection.includeHidden ? "publish,draft,pending,future,private" : "publish");
	return `${type.route}?${params}`;
}
export const liveSource: LiveImportSource = {
	async test(connection) {
		const user = object((await get(connection, "wp/v2/users/me?context=edit")).value);
		if (!Array.isArray(user.roles) || !user.roles.every((role) => typeof role === "string"))
			return fail("authentication", "WordPress did not expose the account's roles.");
		const types: LiveSurvey["types"] = [];
		for (const [endpoint, taxonomy] of [
			["types", false],
			["taxonomies", true],
		] as const) {
			const found = object((await get(connection, `wp/v2/${endpoint}?context=view`)).value);
			if (Object.keys(found).length > 100) return fail("types", "The source exposes too many types.");
			for (const [key, raw] of Object.entries(found)) {
				if ((taxonomy ? INTERNAL_TAXONOMIES : INTERNAL_POST_TYPES).has(key)) continue;
				const type = object(raw);
				const namespace = text(type.rest_namespace) || "wp/v2";
				const base = text(type.rest_base);
				if (
					!/^[a-zA-Z0-9_-]+$/.test(key) ||
					!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(namespace) ||
					!/^[a-zA-Z0-9_-]+$/.test(base)
				)
					return fail("route", "WordPress exposed an invalid REST route.");
				const entry: LiveSurvey["types"][number] = {
					key,
					label: text(type.name) || key,
					route: `${namespace}/${base}`,
					taxonomy,
					holds: key === "attachment" ? "media" : "entries",
					count: 0,
				};
				const answer = await get(
					connection,
					query(entry, connection, 1, 1),
					entry.holds === "media" && !connection.includeHidden,
				);
				if (!Array.isArray(answer.value)) return fail("response", "WordPress did not return a collection.");
				entry.count = total(answer.response, "x-wp-total");
				if (
					total(answer.response, "x-wp-totalpages") !== entry.count ||
					answer.value.length !== Math.min(1, entry.count)
				)
					return fail("pagination", "WordPress returned inconsistent counts.");
				types.push(entry);
			}
		}
		return {
			roles: user.roles as string[],
			types: types.sort((a, b) => Number(b.taxonomy) - Number(a.taxonomy) || a.key.localeCompare(b.key)),
		};
	},
	async *read(connection, survey) {
		for (const type of survey.types) {
			yield { kind: "type", key: type.key, label: type.label, holds: type.holds };
			const yielded = new Set<number>();
			const visiting = new Set<number>();
			async function* ordered(row: RecordValue): AsyncIterable<SourceItem> {
				const current = id(row.id);
				if (yielded.has(current)) return;
				if (visiting.has(current) || visiting.size >= 100)
					return fail("hierarchy", "The source has a cyclic or excessively deep hierarchy.");
				if (
					!type.taxonomy &&
					type.holds !== "media" &&
					(!connection.includeHidden
						? row.status !== "publish"
						: !["publish", "draft", "pending", "future", "private"].includes(text(row.status)))
				)
					return fail("visibility", "WordPress returned content outside the requested visibility.");
				visiting.add(current);
				if (row.parent && type.holds !== "media") {
					const parentId = id(row.parent);
					if (!yielded.has(parentId)) {
						const parent = object(
							(await get(connection, `${type.route}/${parentId}?context=${connection.includeHidden ? "edit" : "view"}`))
								.value,
						);
						if (parent.id !== parentId) return fail("hierarchy", "WordPress returned a different parent.");
						yield* ordered(parent);
					}
				}
				yield await itemOf(row, type, survey, connection);
				visiting.delete(current);
				yielded.add(current);
			}
			let lastId = 0;
			let seen = 0;
			// Always read even an empty collection: detect changes since Test connection.
			const pages = Math.max(1, Math.ceil(type.count / PAGE_SIZE));
			for (let page = 1; page <= pages; page++) {
				const { response, value } = await get(
					connection,
					query(type, connection, page),
					type.holds === "media" && !connection.includeHidden,
				);
				if (
					!Array.isArray(value) ||
					total(response, "x-wp-total") !== type.count ||
					total(response, "x-wp-totalpages") !== Math.ceil(type.count / PAGE_SIZE) ||
					value.length !== Math.min(PAGE_SIZE, type.count - seen)
				)
					return fail("pagination", "The source changed or returned an incomplete page. Test the connection again.");
				for (const raw of value) {
					const row = object(raw);
					const sourceId = id(row.id);
					if (sourceId <= lastId) return fail("pagination", "WordPress returned repeated or unordered Source ids.");
					lastId = sourceId;
					seen++;
					if (
						!type.taxonomy &&
						type.holds !== "media" &&
						(!connection.includeHidden
							? row.status !== "publish"
							: !["publish", "draft", "pending", "future", "private"].includes(text(row.status)))
					)
						return fail("visibility", "WordPress returned content outside the requested visibility.");
					yield* ordered(row);
				}
			}
			if (yielded.size !== type.count)
				return fail("pagination", "The source hierarchy changed while reading. Test the connection again.");
		}
	},
};
function path(value: unknown): string | null {
	try {
		const url = new URL(text(value));
		return url.protocol === "https:" || url.protocol === "http:" ? url.pathname : null;
	} catch {
		return null;
	}
}
function mediaFile(row: RecordValue) {
	return {
		address: text(row.source_url),
		title: html(row.title),
		alt: text(row.alt_text),
		caption: html(row.caption),
		path: path(row.source_url) ?? undefined,
	};
}
async function itemOf(
	row: RecordValue,
	type: LiveSurvey["types"][number],
	survey: LiveSurvey,
	connection: LiveConnection,
): Promise<SourceItem> {
	if (type.holds === "media")
		return {
			kind: "media",
			type: type.key,
			sourceId: `wp:attachment:${id(row.id)}`,
			file: mediaFile(row),
			path: path(row.source_url),
		};
	const values: Record<string, SourceValue> = {};
	if (type.taxonomy) values.description = { kind: "html", html: text(row.description) };
	else {
		values.content = { kind: "html", html: html(row.content) };
		values.excerpt = { kind: "html", html: html(row.excerpt) };
		if (text(row.date_gmt)) values.date = { kind: "date", date: `${text(row.date_gmt)}Z` };
		for (const tax of survey.types.filter((t) => t.taxonomy)) {
			const ids = row[tax.route.split("/").at(-1) ?? ""];
			if (Array.isArray(ids))
				values[`terms:${tax.key}`] = { kind: "items", sourceIds: ids.map((value) => `wp:${tax.key}:${id(value)}`) };
		}
		if (row.featured_media) {
			const media = object(
				(await get(connection, `wp/v2/media/${id(row.featured_media)}?context=view`, !connection.includeHidden)).value,
			);
			values.featured_image = { kind: "file", file: mediaFile(media) };
		}
	}
	const meta = row.meta;
	if (meta && typeof meta === "object" && !Array.isArray(meta))
		for (const [key, value] of Object.entries(meta)) {
			if (key in values) continue;
			values[key] = { kind: "text", text: typeof value === "string" ? value : JSON.stringify(value) };
		}
	const prefix = `wp:${type.key}:`;
	const entry: SourceEntry = {
		kind: "entry",
		type: type.key,
		sourceId: `${prefix}${id(row.id)}`,
		title: type.taxonomy ? text(row.name) : html(row.title),
		slug: text(row.slug) || null,
		parent: row.parent ? `${prefix}${id(row.parent)}` : null,
		path: path(row.link),
		values,
	};
	return entry;
}
