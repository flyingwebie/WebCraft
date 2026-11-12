import {
	type AttributePart,
	attributeProblem,
	commentProblem,
	elementProblem,
	RETAINED_KEY,
	readBody,
	readMetadataJson,
	readPropBinding,
	retainedPropProblem,
	retainedPropsProblem,
	retainedValueIdentity,
	retainedValues,
} from "@webcraft/renderer";
import { cleanRichText } from "@webcraft/renderer/rich-text";
import type { ContentProblem } from "../content/errors.ts";
import type { FieldDefinition } from "../content/field-types.ts";
import { type FieldInput, parseFields } from "../content/fields.ts";
import { sameJson } from "../content/json.ts";
import { readRetainedContract } from "../content/prop-contracts.ts";
import { readPropJson, readPropText } from "../content/props.ts";
import { POPUP_FIELDS } from "../popups/index.ts";
import { ArchiveRefusedError } from "./format.ts";
import type { ReferenceLookup, ReferenceVersion } from "./lookup.ts";
import type { IdMap } from "./remap.ts";

type Row = Record<string, unknown>;
type Column = { name: string; array: boolean };
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
 *
 * With `incoming` (an import reading an archive), what the rows hold is checked as a save checks it:
 * an archive is input anyone can write, its checksums its own, not a copy of a database. Rich text is
 * cleaned against its allowlist, as a save cleans it; an element tree holding an element, attribute
 * or comment no Template may hold, and a Body no save would keep, refuse the archive. Reads trust
 * what is stored (the renderer writes a tree's tag and attribute names as they are), so nothing
 * unchecked may be stored.
 */
export function createRowRemapper(
	lookup: ReferenceLookup,
	ids: IdMap,
	missingPeople: ReadonlyMap<string, string | null>,
	onPerson?: (id: string) => void,
	moduleProps: ReadonlyMap<string, readonly FieldDefinition[]> = new Map(),
	incoming = false,
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
	/** Refuses an archive holding something no save would store. */
	const refuseUnless = (problem: string | undefined, what: string) => {
		if (incoming && problem !== undefined) throw new ArchiveRefusedError("damaged", `${what}: ${problem}`);
	};
	const inline = (value: unknown) => {
		for (const part of list(value)) {
			const node = record(part);
			if ("link" in node) node.link = uri(node.link);
		}
	};
	async function props(componentId: unknown, values: unknown, tree: boolean, context: ReferenceVersion) {
		if (typeof componentId !== "string") return;
		if (!UUID.test(componentId) && !moduleProps.has(componentId) && list(values).length > 0)
			throw new ArchiveRefusedError(
				"damaged",
				`The Module Component ${componentId} has stored Props but no source declaration. Restore its source Module version before transferring this Site.`,
				{ componentId },
			);
		const definition = async (path: string[], retainedId?: string): Promise<Row> => {
			if (UUID.test(componentId)) return record(await lookup.prop(componentId, path, context, retainedId));
			let fields: unknown = moduleProps.get(componentId);
			let field: Row = {};
			for (const key of path) {
				field = record(list(fields).find((item) => record(item).key === key));
				if (!field.type)
					throw new ArchiveRefusedError(
						"damaged",
						`The source declaration for Module Component ${componentId} has no Prop ${path.join(".")}. Restore its source Module version before transferring this Site.`,
						{ componentId, path },
					);
				fields = field.fields;
			}
			return field;
		};
		const retainedDefinition = (input: unknown, id: string): Row => {
			try {
				return record(readRetainedContract(input, id));
			} catch (error) {
				throw new ArchiveRefusedError("damaged", (error as Error).message);
			}
		};
		const jsonValue = async (value: unknown, field: Row, path: string[]): Promise<unknown> => {
			if (field.type !== "group" && field.type !== "repeater") return fieldValue(value, field, context);
			for (const row of field.type === "group" ? [value] : list(value)) {
				const object = record(row);
				for (const key of Object.keys(object)) {
					if (key === RETAINED_KEY) {
						let values: ReturnType<typeof retainedValues>;
						try {
							values = retainedValues(object[key]);
						} catch (error) {
							throw new ArchiveRefusedError("damaged", (error as Error).message);
						}
						for (const held of values) {
							const nested = held.contract
								? retainedDefinition(held.contract, held.id)
								: list(field.fields)
										.map(record)
										.find((f) => f.id === held.id);
							if (!nested)
								throw new ArchiveRefusedError("damaged", "A retained value has no source declaration identity.");
							const checked = readPropJson(nested as FieldDefinition, held.value);
							if ("problem" in checked)
								throw new ArchiveRefusedError("damaged", `Invalid retained value: ${checked.problem}`);
							held.value = await jsonValue(held.value, nested, [...path, held.name]);
							if (held.contract) await definitions([held.contract], context);
						}
						continue;
					}
					const nestedPath = [...path, key];
					const nested =
						list(field.fields)
							.map(record)
							.find((field) => field.key === key) ?? (await definition(nestedPath));
					object[key] = await jsonValue(object[key], nested, nestedPath);
				}
			}
			return value;
		};
		const fixed = async (value: unknown, field: Row, path: string[]): Promise<unknown> => {
			if (typeof value !== "string") return value;
			if (field.type === "relationship") return value.replace(/[^\s,]+/g, (id) => String(ref(id)));
			if (field.type === "richText") return richText(value);
			if (field.type === "media" || (field.type === "link" && !value.trimStart().startsWith("{")))
				return value.replace(/^(\s*)(\S+)(\s*)$/, (_all, before, url, after) => `${before}${uri(url)}${after}`);
			if (!["group", "repeater", "link"].includes(String(field.type))) return value;
			let parsed: unknown;
			try {
				parsed = value.includes(RETAINED_KEY) ? readMetadataJson(value) : JSON.parse(value);
			} catch {
				if (value.includes(RETAINED_KEY)) throw new ArchiveRefusedError("damaged", "Invalid retained JSON values.");
				return value;
			}
			const before = JSON.stringify(parsed);
			const after = JSON.stringify(await jsonValue(parsed, field, path));
			// Keep literal JSON and its formatting intact when no typed reference changed.
			return before === after ? value : after;
		};
		const retentionProblem = retainedPropsProblem(list(values));
		if (retentionProblem) throw new ArchiveRefusedError("damaged", retentionProblem);
		const retainedIds = new Set<string>();
		for (const prop of list(values)) {
			const item = record(prop);
			if (item.retained !== undefined) {
				const problem = retainedPropProblem(item);
				if (problem) throw new ArchiveRefusedError("damaged", problem);
				const id = retainedValueIdentity(String(item.retained), item.contract as Record<string, unknown> | undefined);
				if (retainedIds.has(id) || retainedIds.size >= 256)
					throw new ArchiveRefusedError("damaged", "Retained declarations are distinct, at most 256 Props.");
				retainedIds.add(id);
			}
			if (typeof item.name !== "string") continue;
			const path = [item.name];
			let field = await definition(path, typeof item.retained === "string" ? item.retained : undefined);
			if (item.contract !== undefined) {
				const identity = item.retained ?? record(item.contract).id;
				if (typeof identity !== "string")
					throw new ArchiveRefusedError("damaged", "A Prop source contract needs its declaration identity.");
				field = retainedDefinition(item.contract, identity);
			}
			if (item.retained !== undefined && (!tree || !field.id || item.retained !== field.id))
				throw new ArchiveRefusedError("damaged", "A retained Prop has no source declaration identity.");
			if (tree) {
				if (item.retained !== undefined) {
					const parts = list(item.value).map(record);
					if (parts.every((part) => part.type === "text")) {
						const languages = new Set(["", ...parts.flatMap((part) => Object.keys(record(part.translations)))]);
						for (const language of languages) {
							const text = parts.map((part) => record(part.translations)[language] ?? part.text).join("");
							const checked = readPropText(field as FieldDefinition, text);
							if ("problem" in checked)
								throw new ArchiveRefusedError("damaged", `Invalid retained Prop: ${checked.problem}`);
						}
					}
				}
				if (item.binding !== undefined) {
					const paths = (fields: unknown, prefix = ""): string[] =>
						list(fields).flatMap((field) => {
							const own = record(field);
							const key = prefix + own.key;
							return [key, ...paths(own.fields, `${key}.`)];
						});
					const checked = readPropBinding(
						item.binding,
						list(item.value) as AttributePart[],
						field.type === "group" || field.type === "repeater" ? paths(field.fields) : undefined,
					);
					if ("problem" in checked)
						throw new ArchiveRefusedError("damaged", `Invalid Prop binding metadata: ${checked.problem}`);
				}
				for (const part of list(item.value)) {
					const text = record(part);
					if (text.type !== "text") continue;
					text.text = await fixed(text.text, field, path);
					const translations = record(text.translations);
					for (const language of Object.keys(translations))
						translations[language] = await fixed(translations[language], field, path);
				}
			} else item.value = await fixed(item.value, field, path);
			if (item.contract) await definitions([item.contract], context);
		}
	}
	async function body(value: unknown, context: ReferenceVersion) {
		for (const part of list(value)) {
			const block = record(part);
			at(block, "id");
			if (block.type === "image") at(block, "media");
			if (block.type === "component") {
				await props(block.component, block.props, false, context);
				at(block, "component");
			}
			const source = record(block.source);
			at(source, "id");
			if (source.was) await body([source.was], context);
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
	async function fieldValue(value: unknown, field: Row, context: ReferenceVersion): Promise<unknown> {
		if (field.type === "media" || field.type === "relationship") return Array.isArray(value) ? refs(value) : ref(value);
		if (field.type === "body") await body(value, context);
		if (field.type === "richText") return richText(value);
		if (field.type === "link") {
			const link = record(value);
			if ("url" in link) link.url = uri(link.url);
		}
		return value;
	}
	async function definitions(value: unknown, context: ReferenceVersion) {
		for (const item of list(value)) {
			const field = record(item);
			if (field.type === "body" && Array.isArray(field.components)) field.components = refs(field.components);
			if (field.type === "group" || field.type === "repeater") await definitions(field.fields, context);
			if ("default" in field) field.default = await fieldValue(field.default, field, context);
		}
	}
	/**
	 * A Field's value as its save keeps it: rich text cleaned against its allowlist (the one thing a
	 * Field's save changes without refusing). Component Props are kept as written by their saves too,
	 * and aren't read here.
	 */
	const asSaved = (value: unknown, field: Row): unknown =>
		incoming && field.type === "richText" && typeof value === "string" ? cleanRichText(value) : value;
	async function languageValues(value: unknown, field: Row, context: ReferenceVersion) {
		for (const item of Object.values(record(value))) {
			const language = record(item);
			writer(language.by);
			if (field.type === "body" && Array.isArray(language.value)) {
				const { problems } = readBody(language.value);
				refuseUnless(problems[0] && `${problems[0].at} ${problems[0].message}`, "A Body holds what no save keeps");
			}
			if ("value" in language) language.value = asSaved(await fieldValue(language.value, field, context), field);
			if ("source" in language) language.source = asSaved(await fieldValue(language.source, field, context), field);
		}
	}
	async function values(value: unknown, fields: unknown, context: ReferenceVersion) {
		const stored = record(value);
		const byKey = new Map(list(fields).map((field) => [record(field).key, record(field)]));
		for (const [key, item] of Object.entries(stored)) {
			const field = byKey.get(key) ?? { type: "text" };
			if (key === "seo") {
				await values(record(item).values, [{ key: "image", type: "media" }], context);
			} else if (field.type === "group") await values(record(item).values, field.fields, context);
			else if (field.type === "repeater") {
				for (const row of list(record(item).rows)) {
					at(row, "id");
					await values(record(row).values, field.fields, context);
				}
			} else await languageValues(item, field, context);
		}
	}
	const css = (value: unknown) => {
		for (const part of list(value)) {
			at(part, "token");
			if ("class" in record(part)) record(part).class = classRef(record(part).class);
		}
	};
	async function tree(value: unknown, context: ReferenceVersion) {
		const visit = async (nodes: unknown) => {
			for (const item of list(nodes)) {
				const node = record(item);
				if (node.type === "comment") {
					refuseUnless(commentProblem(String(node.text)), "An element tree holds a comment no Template may hold");
				} else if (node.type === "element") {
					refuseUnless(elementProblem(String(node.tag)), "An element tree holds an element no Template may hold");
					for (const attribute of list(node.attributes)) {
						refuseUnless(
							attributeProblem(String(record(attribute).name)),
							"An element tree holds an attribute no Template may hold",
						);
					}
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
					await props(node.component, node.props, true, context);
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
	async function version(kind: string, id: string | null, value: unknown, context: ReferenceVersion, fields?: unknown) {
		const content = record(value);
		if (kind === "entry") {
			for (const placement of list(record(content.layout).placements)) {
				const p = record(placement);
				if (typeof p.component !== "string")
					throw new ArchiveRefusedError("damaged", "A Page Placement needs its Component source.");
				for (const snapshot of [p, ...list(p.retained).map(record)]) {
					if (!Array.isArray(snapshot.props))
						throw new ArchiveRefusedError("damaged", "A Page Placement needs its Prop source contracts.");
					if (UUID.test(p.component)) {
						for (const field of snapshot.props) {
							try {
								readRetainedContract(field, String(record(field).id));
							} catch (error) {
								throw new ArchiveRefusedError("damaged", (error as Error).message);
							}
						}
					} else {
						// Module declarations use their source keys and Field types, not own-Component ids.
						if (!moduleProps.has(p.component))
							throw new ArchiveRefusedError("damaged", "A Module Page Placement needs its source declaration.");
						const problems: ContentProblem[] = [];
						const parsed = parseFields(snapshot.props as FieldInput[], problems, {
							owner: "moduleComponent",
							postTypeKeys: new Set(),
							reservedKeys: new Set(),
							listName: "props",
						});
						if (problems.length || !sameJson(parsed, snapshot.props))
							throw new ArchiveRefusedError("damaged", "Invalid Module Page Prop source contract.");
					}
					await values(snapshot.values, snapshot.props, context);
					await definitions(snapshot.props, context);
				}
				at(p, "component");
			}
			const typeId = await lookup.row("public.entries", id, ["post_type_id"]);
			await values(
				content.values,
				[
					{ key: "parent", type: "relationship" },
					...list(
						fields ?? (await lookup.row("public.post_types", typeof typeId === "string" ? typeId : null, ["fields"])),
					),
				],
				context,
			);
			at(content, "parentId");
		} else if (kind === "globals")
			await values(content.values, fields ?? (await lookup.row("public.globals", null, ["fields"])), context);
		else if (kind === "popupContent") await values(content.values, POPUP_FIELDS, context);
		else if (kind === "popup") {
			popupSettings(content.settings);
			await version("component", null, content.component, context);
		} else if (kind === "template") await tree(content, context);
		else if (kind === "component") {
			await definitions(content.props, context);
			await definitions(content.propBaseline, context);
			await tree(content.tree, context);
			css(content.css);
		} else if (kind === "loop") {
			await definitions(content.fields, context);
			await values(content.values, [{ key: "items", type: "repeater", fields: content.fields }], context);
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
		if (table === "public.page_layout_settings") row.allowed_components = refs(row.allowed_components);
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
				kind === "entry" ? await lookup.row("public.post_types", String(row.post_type_id), ["fields"]) : row.fields;
			for (const key of ["draft", "published"] as const)
				if (row[key]) await version(kind, originalId, row[key], { kind: key }, fields);
		}
		if (table === "public.popups") {
			for (const key of ["draft", "published"]) popupSettings(row[key]);
			for (const key of ["draft", "published"] as const)
				await version("popupContent", originalId, row[`content_${key}`], { kind: key });
		}
		if (["public.post_types", "public.globals"].includes(table)) await definitions(row.fields, { kind: "draft" });
		if (table === "public.media") await values(record(row.texts).values, [], { kind: "draft" });
		if (table === "public.seo_settings") at(row.organization, "logo");
		if (table === "m_redirects.rules") row.target = uri(row.target);
		if (["public.revisions", "public.checkpoints"].includes(table))
			await version(String(row.item_kind), typeof row.item_id === "string" ? row.item_id : null, row.content, {
				kind: table === "public.revisions" ? "published" : "draft",
				at: String(table === "public.revisions" ? row.published_at : row.changed_at),
			});
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
