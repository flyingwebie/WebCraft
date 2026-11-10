import { POPUP_FIELDS } from "../popups/index.ts";
import type { IdMap } from "./remap.ts";

type Row = Record<string, unknown>;
type Column = { name: string; array: boolean };
/** Reads a bounded piece of the original, staged Structure. No Site-sized in-memory catalogue. */
export type ReferenceLookup = (table: string, id: string | null, path: string[]) => Promise<unknown>;
const record = (value: unknown): Row =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only core's documented two-part Audit actions have these detail contracts. A Module's
// arbitrary Audit payload can use the same property names for literal text.
const CORE_AUDIT_NOUNS = new Set([
	"accessibilityStatement",
	"class",
	"component",
	"dashboard",
	"dashboardTemplate",
	"designSystem",
	"domain",
	"draft",
	"entry",
	"filter",
	"form",
	"formEmails",
	"formUpload",
	"globals",
	"import",
	"library",
	"loop",
	"media",
	"mediaFolder",
	"member",
	"pausedDomain",
	"popup",
	"popupContent",
	"postType",
	"report",
	"reportRecipients",
	"review",
	"scheduledPublish",
	"script",
	"site",
	"siteExport",
	"template",
	"translation",
	"webhook",
	"workspace",
]);

/**
 * References follow SQL types and the stored contracts of Content, never a string's resemblance
 * to an ID. Unknown Module JSON is opaque. In particular, a text Field containing an existing
 * Entry's UUID is still text. Only URI slots interpret the reserved `media:` protocol.
 */
export function createRowRemapper(
	lookup: ReferenceLookup,
	ids: IdMap,
	missingPeople: ReadonlyMap<string, string | null>,
	onPerson?: (id: string) => void,
) {
	const ref = (value: unknown, person = false): unknown => {
		if (typeof value !== "string" || !UUID.test(value)) return value;
		if (person) onPerson?.(value);
		const mapped = ids.id(value);
		return person && missingPeople.has(mapped) ? missingPeople.get(mapped) : mapped;
	};
	const at = (value: unknown, key: string, person = false) => {
		const object = record(value);
		if (key in object) object[key] = ref(object[key], person);
	};
	const refs = (value: unknown) => list(value).map((part) => ref(part));
	const classRef = (value: unknown): unknown => {
		if (typeof value !== "string") return value;
		// Utility IDs are u:<property>:<token ID>[:step]; the token has its own identity.
		const utility = /^(u:[a-z-]+:)([^:]+)(:[^:]+)?$/.exec(value);
		return utility ? `${utility[1]}${ref(utility[2])}${utility[3] ?? ""}` : ref(value);
	};
	const uri = (value: unknown): unknown =>
		typeof value === "string" && /^media:[0-9a-f-]{36}$/i.test(value) ? `media:${ref(value.slice(6))}` : value;
	const writer = (value: unknown) => {
		if (record(value).kind === "person") at(value, "personId", true);
	};
	const via = (value: unknown) => {
		if (record(value).kind === "impersonation") at(value, "by", true);
	};
	const richText = (value: unknown): unknown =>
		typeof value === "string"
			? value.replace(
					/(\b(?:href|src)=["'])(media:[0-9a-f-]{36})(["'])/gi,
					(_match, before, url, after) => `${before}${uri(url)}${after}`,
				)
			: value;
	const inline = (value: unknown) => {
		for (const part of list(value)) {
			const node = record(part);
			if ("link" in node) node.link = uri(node.link);
		}
	};
	async function props(componentId: unknown, values: unknown, tree: boolean) {
		if (typeof componentId !== "string" || !UUID.test(componentId)) return;
		const fields = list(await lookup("public.components", componentId, ["draft", "props"]));
		for (const prop of list(values)) {
			const item = record(prop);
			const field = fields.map(record).find((field) => field.key === item.name);
			if (!field) continue;
			if (field.type === "media" || field.type === "relationship" || field.type === "link") {
				const fixed = field.type === "relationship" ? ref : uri;
				if (tree) {
					for (const part of list(item.value))
						if (record(part).type === "text") {
							const text = record(part);
							text.text = fixed(text.text);
						}
				} else item.value = fixed(item.value);
			}
		}
	}
	async function body(value: unknown) {
		for (const part of list(value)) {
			const block = record(part);
			at(block, "id");
			if (block.type === "image") at(block, "media");
			if (block.type === "component") {
				await props(block.component, block.props, false);
				at(block, "component");
			}
			const source = record(block.source);
			at(source, "id");
			if (source.was) await body([source.was]);
			inline(block.text);
			inline(block.summary);
			for (const row of list(block.rows)) for (const cell of list(row)) inline(cell);
			const items = (value: unknown) => {
				for (const item of list(value)) {
					const row = record(item);
					at(row, "id");
					inline(row.text);
					items(row.children);
				}
			};
			items(block.items);
		}
	}
	async function fieldValue(value: unknown, field: Row): Promise<unknown> {
		if (field.type === "media" || field.type === "relationship") return Array.isArray(value) ? refs(value) : ref(value);
		if (field.type === "body") await body(value);
		if (field.type === "richText") return richText(value);
		if (field.type === "link") {
			const link = record(value);
			if ("url" in link) link.url = uri(link.url);
		}
		return value;
	}
	async function definitions(value: unknown) {
		for (const item of list(value)) {
			const field = record(item);
			if (field.type === "body" && Array.isArray(field.components)) field.components = refs(field.components);
			if (field.type === "group" || field.type === "repeater") await definitions(field.fields);
			if ("default" in field) field.default = await fieldValue(field.default, field);
		}
	}
	async function languageValues(value: unknown, field: Row) {
		for (const item of Object.values(record(value))) {
			const language = record(item);
			writer(language.by);
			if ("value" in language) language.value = await fieldValue(language.value, field);
			if ("source" in language) language.source = await fieldValue(language.source, field);
		}
	}
	async function values(value: unknown, fields: unknown) {
		const stored = record(value);
		const byKey = new Map(list(fields).map((field) => [record(field).key, record(field)]));
		for (const [key, item] of Object.entries(stored)) {
			const field = byKey.get(key) ?? { type: "text" };
			if (key === "seo") {
				await values(record(item).values, [{ key: "image", type: "media" }]);
			} else if (field.type === "group") await values(record(item).values, field.fields);
			else if (field.type === "repeater") {
				for (const row of list(record(item).rows)) {
					at(row, "id");
					await values(record(row).values, field.fields);
				}
			} else await languageValues(item, field);
		}
	}
	const css = (value: unknown) => {
		for (const part of list(value)) {
			at(part, "token");
			if ("class" in record(part)) record(part).class = classRef(record(part).class);
		}
	};
	async function tree(value: unknown) {
		const visit = async (nodes: unknown) => {
			for (const item of list(nodes)) {
				const node = record(item);
				if (node.type === "element") {
					at(node, "id");
					if (Array.isArray(node.classes)) node.classes = node.classes.map(classRef);
					for (const attribute of list(node.attributes)) {
						const attr = record(attribute);
						if (!["src", "href", "poster"].includes(String(attr.name))) continue;
						for (const item of list(attr.value)) {
							const part = record(item);
							if (part.type === "text") part.text = uri(part.text);
						}
					}
					await visit(node.children);
				} else if (node.type === "component") {
					await props(node.component, node.props, true);
					at(node, "id");
					at(node, "component");
				} else if (node.type === "form") at(node, "form");
				else if (node.type === "popup") at(node, "popup");
				else if (node.type === "filter") at(node, "filter");
				else if (node.type === "loop") {
					await visit(node.children);
					await visit(node.empty);
				} else if (node.type === "condition") {
					for (const branch of list(node.branches)) await visit(record(branch).children);
					await visit(node.otherwise);
				}
			}
		};
		await visit(record(value).nodes);
	}
	function design(value: unknown) {
		const document = record(value);
		const tokens = record(document.tokens);
		for (const name of ["colours", "fonts", "radius", "shadows", "breakpoints", "widths"])
			for (const token of list(tokens[name])) at(token, "id");
		for (const name of ["space", "text"]) for (const step of list(record(tokens[name]).steps)) at(step, "id");
		at(record(tokens.focus).colour, "colour");
		for (const value of list(document.classes)) {
			const item = record(value);
			at(item, "id");
			css(item.styles);
			css(item.css);
			if (item.breakpoints)
				item.breakpoints = Object.fromEntries(
					Object.entries(record(item.breakpoints)).map(([id, value]) => {
						css(value);
						return [ref(id), value];
					}),
				);
		}
		for (const value of Object.values(record(document.baseStyles))) css(value);
		css(document.customCss);
	}
	function popupSettings(value: unknown) {
		const rules = record(record(value).rules);
		for (const name of ["postTypeIds", "entryIds", "excludePostTypeIds", "excludeEntryIds"])
			if (name in rules) rules[name] = refs(rules[name]);
	}
	async function version(kind: string, id: string | null, value: unknown, fields?: unknown) {
		const content = record(value);
		if (kind === "entry") {
			const typeId = await lookup("public.entries", id, ["post_type_id"]);
			await values(content.values, [
				{ key: "parent", type: "relationship" },
				...list(fields ?? (await lookup("public.post_types", typeof typeId === "string" ? typeId : null, ["fields"]))),
			]);
			at(content, "parentId");
		} else if (kind === "globals")
			await values(content.values, fields ?? (await lookup("public.globals", null, ["fields"])));
		else if (kind === "popupContent") await values(content.values, POPUP_FIELDS);
		else if (kind === "popup") {
			popupSettings(content.settings);
			await version("component", null, content.component);
		} else if (kind === "template") await tree(content);
		else if (kind === "component") {
			await definitions(content.props);
			await tree(content.tree);
			css(content.css);
		} else if (kind === "loop") {
			await definitions(content.fields);
			await values(content.values, [{ key: "items", type: "repeater", fields: content.fields }]);
			for (const value of list(record(content.query).filters)) {
				const filter = record(value);
				if (filter.type === "relationship") filter.entries = refs(filter.entries);
			}
		} else if (kind === "designSystem") design(content);
		else if (kind === "form" && record(content.success).kind === "redirect") at(content.success, "pageId");
	}
	return async (
		row: Row,
		table: string,
		columns: readonly Column[],
		personColumns: readonly string[] = [],
	): Promise<Row> => {
		const originalId = typeof row.id === "string" ? row.id : null;
		// Visit JSON before changing top-level lookup IDs.
		const kinds: Record<string, string> = {
			"public.entries": "entry",
			"public.globals": "globals",
			"public.templates": "template",
			"public.components": "component",
			"public.loops": "loop",
			"public.design_systems": "designSystem",
			"public.forms": "form",
		};
		const kind = kinds[table];
		if (kind) {
			const fields =
				kind === "entry" ? await lookup("public.post_types", String(row.post_type_id), ["fields"]) : row.fields;
			for (const key of ["draft", "published"]) if (row[key]) await version(kind, originalId, row[key], fields);
		}
		if (table === "public.popups") {
			for (const key of ["draft", "published"]) popupSettings(row[key]);
			for (const key of ["content_draft", "content_published"]) await version("popupContent", originalId, row[key]);
		}
		if (["public.post_types", "public.globals"].includes(table)) await definitions(row.fields);
		if (table === "public.media") await values(record(row.texts).values, []);
		if (table === "public.seo_settings") at(row.organization, "logo");
		if (table === "m_redirects.rules") row.target = uri(row.target);
		if (["public.revisions", "public.checkpoints"].includes(table))
			await version(String(row.item_kind), typeof row.item_id === "string" ? row.item_id : null, row.content);
		for (const name of ["via", "changed_via", "submitted_via", "decided_via"]) via(row[name]);
		if (table === "public.dashboards") for (const widget of list(row.widgets)) at(widget, "id");
		if (table === "m_site_analytics.goals" && row.kind === "form") at(row.definition, "formId");
		if (table === "m_site_analytics.funnels")
			for (const step of list(row.steps)) if (record(step).kind === "goal") at(step, "goalId");
		if (table === "m_site_analytics.events" && row.type === "form") at(row, "target");
		if (table === "public.audit_log") {
			// Audit identities deliberately have no FK; discover them without reattributing history.
			for (const key of ["person_id", "impersonator_id"]) if (typeof row[key] === "string") onPerson?.(row[key]);
			const details = record(row.details);
			if (String(row.action).startsWith("redirects.") && "to" in details) details.to = uri(details.to);
			const action = String(row.action).split(".");
			if (action.length === 2 && CORE_AUDIT_NOUNS.has(action[0] ?? "")) {
				for (const name of [
					"entryId",
					"postTypeId",
					"popupId",
					"popupContentId",
					"componentId",
					"templateId",
					"formId",
					"loopId",
					"filterId",
					"mediaId",
					"webhookId",
					"siteId",
					"workspaceId",
					"importId",
					"reportId",
					"dashboardId",
					"reviewId",
					"scheduleId",
					"folderId",
					"libraryId",
				])
					at(details, name);
				for (const name of ["personId", "publishedBy", "decidedBy", "requestedBy"]) at(details, name, true);
				at(details.item, "id");
				for (const item of list(details.items)) at(item, "id");
			}
		}
		if (table === "m_forms.submissions") {
			for (const value of list(row.values)) {
				const field = record(value);
				if (field.type === "file")
					for (const value of list(field.value)) {
						const file = record(value);
						at(file, "uploadId");
						delete file.url;
					}
			}
		}
		if (["public.media_files", "public.form_uploads"].includes(table) && typeof row.key === "string")
			row.key = ids.key(row.key);
		if (table === "public.libraries" && typeof row.storage_key === "string") row.storage_key = ids.key(row.storage_key);
		for (const column of columns)
			if (column.name in row && row[column.name] !== null) {
				row[column.name] = column.array
					? refs(row[column.name])
					: personColumns.includes(column.name)
						? ref(row[column.name], true)
						: ids.id(String(row[column.name]));
			}
		return row;
	};
}
