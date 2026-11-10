import { entries, popups } from "@webcraft/db/schema";
import type { ElementTree } from "@webcraft/renderer";
import { asc, eq } from "drizzle-orm";
import { type Languages, readFields } from "../content/field-values.ts";
import { storedVersion } from "../content/values.ts";
import type { VisitorScope } from "../tenancy/data-layer.ts";
import { POPUP_FIELDS, type PopupSettings, popupSettings } from "./index.ts";
export async function pagePopups(
	scope: Pick<VisitorScope, "select" | "first" | "now">,
	options: {
		on: boolean;
		which: "draft" | "published";
		languages: Languages;
		path: string;
		entryId: string | null;
		phoneWidth: number;
		tabletWidth: number;
		attachedIds: ReadonlySet<string>;
	},
) {
	const found: {
		id: string;
		title: string;
		tree: ElementTree;
		config: PopupSettings & {
			start: string | null;
			end: string | null;
			phoneWidth: number;
			tabletWidth: number;
			key: string;
			attached: boolean;
		};
	}[] = [];
	let changesAt: Date | null = null;
	if (!options.on) return { items: found, changesAt };
	const entry = options.entryId ? await scope.first(entries, eq(entries.id, options.entryId)) : undefined;
	for (const row of await scope.select(popups, undefined, { orderBy: [asc(popups.createdAt), asc(popups.id)] })) {
		const stored = options.which === "draft" ? row.draft : row.published;
		const content = options.which === "draft" ? row.contentDraft : row.contentPublished;
		if (!stored || !content) continue;
		const settings = popupSettings.parse(stored);
		const values = readFields(storedVersion(content).values, POPUP_FIELDS, options.languages);
		if (!values.enabled) continue;
		const r = settings.rules;
		const attached = options.attachedIds.has(row.id);
		const match = (pattern: string) =>
			pattern.endsWith("*") ? options.path.startsWith(pattern.slice(0, -1)) : pattern === options.path;
		if (!attached) {
			if ((r.paths.length && !r.paths.some(match)) || r.excludePaths.some(match)) continue;
			if (
				(r.entryIds.length && !r.entryIds.includes(options.entryId ?? "")) ||
				r.excludeEntryIds.includes(options.entryId ?? "")
			)
				continue;
			if (
				(r.postTypeIds.length && !r.postTypeIds.includes(entry?.postTypeId ?? "")) ||
				r.excludePostTypeIds.includes(entry?.postTypeId ?? "")
			)
				continue;
			if (r.languages.length && !r.languages.includes(options.languages.language)) continue;
		}
		const start = typeof values.start === "string" ? values.start : null;
		const end = typeof values.end === "string" ? values.end : null;
		for (const instant of [start, end])
			if (
				instant &&
				Date.parse(instant) > scope.now().getTime() &&
				(!changesAt || Date.parse(instant) < changesAt.getTime())
			)
				changesAt = new Date(instant);
		if ((start && Date.parse(start) > scope.now().getTime()) || (end && Date.parse(end) <= scope.now().getTime()))
			continue;
		found.push({
			id: row.id,
			title: String(values.title || row.name),
			config: {
				...settings,
				start,
				end,
				phoneWidth: options.phoneWidth,
				tabletWidth: options.tabletWidth,
				key: row.key,
				attached,
			},
			tree: {
				version: 1,
				nodes: [
					{
						type: "component",
						id: `popup-${row.id}`,
						component: row.componentId,
						props: ["title", "text", "image"].map((name) => ({
							name,
							value: [
								{
									type: "text",
									text: name === "image" && values[name] ? `media:${values[name]}` : String(values[name] ?? ""),
								},
							],
						})),
					},
				],
			},
		});
	}
	return { items: found, changesAt };
}
