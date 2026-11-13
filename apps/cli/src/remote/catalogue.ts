/**
 * The remote commands, generated from an Install's OpenAPI document (ADR 0030, ADR 0034), the same
 * source its MCP tools come from, so they never drift from the procedures:
 *
 * - one command per public procedure, its words the operation id's parts, each from camelCase to
 *   kebab-case: `entries.saveDraft` is `webcraft entries save-draft`, `media.folders.list` is
 *   `webcraft media folders list`;
 * - a Module's procedures (`m.<module id>.…`) start with the Module's id, as its MCP tools do:
 *   `m.redirects.rules.list` is `webcraft redirects rules list` (and always `webcraft m redirects
 *   rules list`, which is how it is reached should a procedure of WebCraft's own ever take its words);
 * - Sensitive actions (`x-webcraft-sensitive`) are never commands: they need a fresh identity check
 *   in the admin.
 */

/** A JSON Schema, as the OpenAPI document carries it. */
export type JsonSchema = Record<string, unknown>;

/** One command made from one public procedure. */
export type RemoteCommand = {
	/** The procedure's operation id: `entries.saveDraft`, `m.redirects.rules.list`. */
	operationId: string;
	/** The command's words after `webcraft`: `["entries", "save-draft"]`. */
	words: string[];
	/** Where it is called: `POST /api/v1/<path>`. */
	path: string;
	summary: string;
	access: "read" | "write";
	/** The Toolsets it belongs to, or `always`. */
	toolsets: string[] | "always";
	/** It publishes. */
	publishes: boolean;
	/** It takes two steps for API clients: a preview, then the confirmation. */
	confirmation: boolean;
	/** The procedure's input: an object schema. */
	input: JsonSchema;
	/** Its input's properties that are files, sent as multipart form data. */
	files: string[];
	/** The Module whose procedure it is, or null for WebCraft's own. */
	module: string | null;
};

/** What a document offers: its commands, and the Sensitive procedures it leaves out. */
export type Catalogue = {
	commands: RemoteCommand[];
	/** Sensitive procedures by their would-be words (`members invite`), with the action. */
	sensitive: Map<string, { operationId: string; action: string }>;
	/** The command named by `words`, with the words after it, or null. */
	find(words: readonly string[]): { command: RemoteCommand; rest: string[] } | null;
};

type Operation = {
	operationId?: string;
	summary?: string;
	requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
	"x-webcraft-access"?: "read" | "write";
	"x-webcraft-toolsets"?: string[] | "always";
	"x-webcraft-publishes"?: boolean;
	"x-webcraft-sensitive"?: string;
	"x-webcraft-confirmation"?: boolean;
};

/** A camelCase part as a command word: `saveDraft` is `save-draft`. */
export function commandWord(part: string): string {
	return part
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.toLowerCase();
}

/** The words of an operation id: `m.site-analytics.stats.totals` is `site-analytics stats totals`. */
export function commandWords(operationId: string): string[] {
	const parts = operationId.split(".");
	return (parts[0] === "m" ? parts.slice(1) : parts).map(commandWord);
}

/** Every command of a document's operations, in the document's order. */
export function catalogueOf(document: unknown): Catalogue {
	const paths = ((document as { paths?: unknown } | null)?.paths ?? {}) as Record<string, Record<string, Operation>>;
	const commands: RemoteCommand[] = [];
	const sensitive = new Map<string, { operationId: string; action: string }>();
	for (const operations of Object.values(paths)) {
		for (const operation of Object.values(operations)) {
			const operationId = operation.operationId;
			if (!operationId) continue;
			if (operation["x-webcraft-sensitive"]) {
				sensitive.set(commandWords(operationId).join(" "), {
					operationId,
					action: operation["x-webcraft-sensitive"],
				});
				continue;
			}
			const content = operation.requestBody?.content ?? {};
			const multipart = content["multipart/form-data"]?.schema;
			const input = content["application/json"]?.schema ?? multipart ?? { type: "object", properties: {} };
			const properties = (input.properties ?? {}) as Record<string, JsonSchema>;
			const parts = operationId.split(".");
			commands.push({
				operationId,
				words: commandWords(operationId),
				path: parts.join("/"),
				summary: operation.summary ?? operationId,
				access: operation["x-webcraft-access"] ?? "write",
				toolsets: operation["x-webcraft-toolsets"] ?? [],
				publishes: operation["x-webcraft-publishes"] === true,
				confirmation: operation["x-webcraft-confirmation"] === true,
				input,
				files: Object.entries(properties)
					.filter(([, property]) => typeof property.contentMediaType === "string")
					.map(([name]) => name),
				module: parts[0] === "m" ? (parts[1] ?? null) : null,
			});
		}
	}

	// WebCraft's own procedures keep their words; a Module's that would take the same words is reached
	// with `m <module id> …` only.
	const byWords = new Map<string, RemoteCommand>();
	for (const command of commands) {
		if (command.module === null) byWords.set(command.words.join(" "), command);
	}
	for (const command of commands) {
		if (command.module === null) continue;
		const key = command.words.join(" ");
		if (!byWords.has(key)) byWords.set(key, command);
		byWords.set(["m", ...command.words].join(" "), command);
	}

	return {
		commands,
		sensitive,
		find(words) {
			const spelled = spelledOut(words);
			for (let length = Math.min(spelled.length, 6); length > 0; length--) {
				const command = byWords.get(spelled.slice(0, length).join(" "));
				if (command) return { command, rest: [...spelled.slice(length)] };
			}
			return null;
		},
	};
}

/** Words as typed, with an operation id written whole (`entries.saveDraft`) split into its words. */
function spelledOut(words: readonly string[]): string[] {
	const [first, ...rest] = words;
	if (first?.includes(".")) return [...commandWords(first), ...rest];
	return words.map((word) => (/[A-Z]/.test(word) ? commandWord(word) : word));
}

/** The commands whose words start with `prefix`, for help and suggestions. */
export function commandsUnder(catalogue: Catalogue, prefix: readonly string[]): RemoteCommand[] {
	return catalogue.commands.filter((command) => prefix.every((word, index) => command.words[index] === word));
}
