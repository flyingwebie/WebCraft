/**
 * MCP tools generated from the Management API's OpenAPI document (ADR 0030, ADR 0034): one tool per
 * public procedure, named `noun_verb` after its operation id, with the procedure's summary and its
 * input schema. Sensitive actions never become tools.
 */

/** A JSON Schema, as the OpenAPI document and MCP carry it. */
export type JsonSchema = Record<string, unknown>;

/** A tool made from one public procedure. */
export type GeneratedTool = {
	/** `entries_publish`, `media_folders_list`, `redirects_rules_list`. */
	name: string;
	/** The procedure's operation id: `entries.publish`, `m.redirects.rules.list`. */
	operationId: string;
	/** The procedure's router path: `["entries", "publish"]`. */
	path: string[];
	title: string;
	description: string;
	/** The procedure's input schema, files as base64 objects. */
	inputSchema: JsonSchema;
	/** The input's properties that are files: sent to the procedure as multipart form data. */
	files: string[];
	access: "read" | "write";
	/** The Toolsets it belongs to, or `always`. */
	toolsets: string[] | "always";
	/** The Permissions that let a person call it (any one). */
	permissions: string[];
	/** It publishes: an AI client needs "May publish". */
	publishes: boolean;
	/** It takes two steps for API clients: a preview, then a `confirmation`. */
	confirmation: boolean;
};

type Operation = {
	operationId?: string;
	summary?: string;
	requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
	"x-webcraft-access"?: "read" | "write";
	"x-webcraft-toolsets"?: string[] | "always";
	"x-webcraft-permissions"?: string[];
	"x-webcraft-publishes"?: boolean;
	"x-webcraft-sensitive"?: string;
	"x-webcraft-confirmation"?: boolean;
};

/** What a tool taking two steps says about them. */
const CONFIRMATION_NOTE =
	" Two steps: the first call changes nothing and answers a preview with a confirmation id (valid 5 minutes); show the person the preview, and once they agree call again with `confirmation` set to that id. Clients that can ask the person a question are asked instead.";

/** The schema a file takes in a tool's input: its name, its type and its bytes in base64. */
const FILE_SCHEMA: JsonSchema = {
	type: "object",
	description: "A file: its name, its media type and its content in base64.",
	properties: {
		name: { type: "string", minLength: 1, maxLength: 255 },
		type: { type: "string", description: "Its media type, such as image/png." },
		base64: { type: "string", contentEncoding: "base64" },
	},
	required: ["name", "base64"],
	additionalProperties: false,
};

/**
 * The tool name for an operation id: each part from camelCase to snake_case, joined with `_`; a
 * Module's procedures (`m.<module id>.…`) start with the Module's id instead of `m`.
 * `entries.saveDraft` is `entries_save_draft`, `m.site-analytics.stats.totals` is
 * `site_analytics_stats_totals`.
 */
export function toolName(operationId: string): string {
	const parts = operationId.split(".");
	const named = parts[0] === "m" ? parts.slice(1) : parts;
	return named
		.map((part) =>
			part
				.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
				.replace(/[^A-Za-z0-9]+/g, "_")
				.toLowerCase(),
		)
		.join("_");
}

/** Every tool of the document's operations, in the document's order: every public procedure but Sensitive actions. */
export function generateTools(document: Record<string, unknown>): GeneratedTool[] {
	const paths = (document.paths ?? {}) as Record<string, Record<string, Operation>>;
	const tools: GeneratedTool[] = [];
	for (const operations of Object.values(paths)) {
		for (const operation of Object.values(operations)) {
			const operationId = operation.operationId;
			if (!operationId || operation["x-webcraft-sensitive"]) continue;
			const content = operation.requestBody?.content ?? {};
			const multipart = content["multipart/form-data"]?.schema;
			const schema = content["application/json"]?.schema ?? multipart ?? { type: "object", properties: {} };
			const { inputSchema, files } = toolInput(schema);
			const confirmation = operation["x-webcraft-confirmation"] === true;
			const summary = operation.summary ?? operationId;
			tools.push({
				name: toolName(operationId),
				operationId,
				path: operationId.split("."),
				title: summary.replace(/\.$/, ""),
				description: `${summary}${confirmation ? CONFIRMATION_NOTE : ""}`,
				inputSchema,
				files,
				access: operation["x-webcraft-access"] ?? "write",
				toolsets: operation["x-webcraft-toolsets"] ?? [],
				permissions: operation["x-webcraft-permissions"] ?? [],
				publishes: operation["x-webcraft-publishes"] === true,
				confirmation,
			});
		}
	}
	return tools;
}

/** A procedure's input schema as a tool's: always an object, its file properties as base64 objects. */
function toolInput(schema: JsonSchema): { inputSchema: JsonSchema; files: string[] } {
	const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
	const files = Object.entries(properties)
		.filter(([, property]) => property.type === "string" && typeof property.contentMediaType === "string")
		.map(([name]) => name);
	if (schema.type !== "object") return { inputSchema: { type: "object", properties: {}, ...schema }, files };
	if (files.length === 0) return { inputSchema: schema, files };
	return {
		inputSchema: {
			...schema,
			properties: Object.fromEntries(
				Object.entries(properties).map(([name, property]) => [name, files.includes(name) ? FILE_SCHEMA : property]),
			),
		},
		files,
	};
}
