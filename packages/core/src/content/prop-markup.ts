/** Component declarations are a preamble, not rendered tree nodes. Field validation stays in the content model. */
import {
	type MarkupProblem,
	type ParseMarkupOptions,
	parseTemplateMarkup,
	propsBlockAt,
	TemplateMarkupInvalidError,
} from "@webcraft/renderer";
import type { ContentProblem } from "./errors.ts";
import type { FieldDefinition, FieldInput } from "./fields.ts";
import { stableJson } from "./json.ts";

export type PropDeclarations = {
	markup: string;
	props?: FieldInput[];
	lines: number[];
	offset: number;
	/** Character offset of the rendered markup in the normalized authored source. */
	markupStart: number;
};
const SETTINGS = new Set([
	"id",
	"label",
	"help",
	"required",
	"exposed",
	"translatable",
	"default",
	"minLength",
	"maxLength",
	"pattern",
	"min",
	"max",
	"integer",
	"mode",
	"options",
	"multiple",
	"postTypes",
	"twoWay",
	"fields",
]);

export function readPropDeclarations(input: string): PropDeclarations {
	const text = input.replace(/\r\n?/g, "\n");
	const lines = text.split("\n");
	const block = propsBlockAt(text);
	if (!block) return { markup: text, lines: [], offset: 0, markupStart: 0 };
	const { first, end } = block;
	const problems: MarkupProblem[] = [];
	const fail = (line: number, message: string) => {
		problems.push({ line, column: 1, message });
	};
	if (end < 0)
		throw new TemplateMarkupInvalidError([
			{ line: first + 1, column: 1, message: "Close the Props declaration with {{/props}} on its own line." },
		]);
	const props: FieldInput[] = [];
	const positions: number[] = [];
	for (let i = first + 1; i < end; i++) {
		const line = lines[i]?.trim() ?? "";
		if (!line) continue;
		const match = /^([a-z][A-Za-z0-9_]*):\s*([A-Za-z]+)(?=\s|$)(.*)$/.exec(line);
		if (!match) {
			fail(i + 1, "Declare a Prop as name: FieldType, with optional required, default=JSON and exposed.");
			continue;
		}
		const [, key = "", type = "", tail = ""] = match;
		const settings: Record<string, unknown> = {};
		let rest = tail.trim();
		try {
			while (rest) {
				const setting = /^([A-Za-z][A-Za-z0-9]*)(=)?/.exec(rest);
				if (!setting) throw new Error("Expected a Prop setting.");
				const name = setting[1] as string;
				if (!SETTINGS.has(name)) throw new Error(`Unknown Prop setting ${name}.`);
				if (Object.hasOwn(settings, name)) throw new Error(`Prop setting ${name} is given twice.`);
				rest = rest.slice(setting[0].length);
				if (!setting[2]) {
					if (name !== "required" && name !== "exposed") throw new Error(`${name} needs a JSON value after =.`);
					settings[name] = true;
				} else {
					// Find the end of one JSON value, respecting strings and nested objects/arrays.
					let quoted = false;
					let escaped = false;
					let depth = 0;
					let length = 0;
					for (; length < rest.length; length++) {
						const c = rest[length];
						if (quoted) {
							if (escaped) escaped = false;
							else if (c === "\\") escaped = true;
							else if (c === '"') quoted = false;
						} else if (c === '"') quoted = true;
						else if (c === "[" || c === "{") depth++;
						else if (c === "]" || c === "}") depth--;
						else if (/\s/.test(c ?? "") && depth === 0) break;
					}
					try {
						settings[name] = JSON.parse(rest.slice(0, length));
					} catch {
						throw new Error(`${name} needs a valid JSON value.`);
					}
					rest = rest.slice(length);
				}
				if (rest && !/^\s/.test(rest)) throw new Error("Separate Prop settings with spaces.");
				rest = rest.trim();
			}
			if (type === "url" && typeof settings.default === "string")
				settings.default = { url: settings.default, text: "" };
			if (type === "media" && typeof settings.default === "string" && settings.default.startsWith("media:"))
				settings.default = settings.default.slice(6);
			const field = { label: key, ...settings, key, type: type === "url" ? "link" : type };
			checkShape(field);
			props.push(field as FieldInput);
			positions.push(i + 1);
		} catch (error) {
			fail(i + 1, (error as Error).message);
		}
	}
	if (problems.length) throw new TemplateMarkupInvalidError(problems);
	const markup = lines.slice(end + 1).join("\n");
	return { props, lines: positions, markup, offset: end + 1, markupStart: text.length - markup.length };
}

export function declarationProblems(declarations: PropDeclarations, problems: readonly ContentProblem[]): never {
	throw new TemplateMarkupInvalidError(
		problems.map((problem) => ({
			line: declarations.lines[Number(/^props\[(\d+)\]/.exec(problem.at)?.[1] ?? 0)] ?? 1,
			column: 1,
			message: `${problem.at}: ${problem.message}`,
		})),
	);
}

export function parseDeclaredTree(declarations: PropDeclarations, options: ParseMarkupOptions) {
	try {
		const locate = options.locate;
		const parsed = parseTemplateMarkup(declarations.markup, {
			...options,
			locate: locate
				? (locations) =>
						locate(
							locations.map((range) => ({
								...range,
								start: range.start + declarations.markupStart,
								end: range.end + declarations.markupStart,
							})),
						)
				: undefined,
		});
		return {
			...parsed,
			notices: parsed.notices.map((notice) => ({ ...notice, line: notice.line + declarations.offset })),
		};
	} catch (error) {
		if (!(error instanceof TemplateMarkupInvalidError)) throw error;
		throw new TemplateMarkupInvalidError(
			error.problems.map((problem) => ({ ...problem, line: problem.line + declarations.offset })),
		);
	}
}

/** Stable order, JSON strings/containers, all Field settings: no information hidden in a sidecar. */
export function printPropDeclarations(props: readonly FieldDefinition[]): string {
	if (!props.length) return "{{@props}}\n{{/props}}\n";
	return `{{@props}}\n${props
		.map((prop) => {
			const { key, type, required, default: fallback, exposed, ...settings } = prop;
			const tokens = [`  ${key}: ${type}`];
			if (required) tokens.push("required");
			if (fallback !== null && fallback !== undefined)
				tokens.push(`default=${stableJson(type === "media" ? `media:${fallback}` : fallback)}`);
			if (exposed) tokens.push("exposed");
			for (const name of Object.keys(settings).sort()) {
				const value = settings[name as keyof typeof settings];
				if (value !== undefined) tokens.push(`${name}=${stableJson(value)}`);
			}
			return tokens.join(" ");
		})
		.join("\n")}\n{{/props}}\n`;
}

/** The markup is untyped input; reject malformed JSON settings before the Field registry reads them. */
function checkShape(input: unknown, depth = 1): void {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("A nested Field is an object with key, label and type.");
	if (depth > 3) throw new Error("Groups and Repeaters nest at most 3 deep.");
	for (const [key, value] of Object.entries(input)) {
		if (!["key", "type"].includes(key) && !SETTINGS.has(key)) throw new Error(`Unknown Field setting ${key}.`);
		if (["key", "type", "label", "help", "id", "mode"].includes(key) && typeof value !== "string")
			throw new Error(`${key} must be a string.`);
		if (
			["required", "exposed", "translatable", "multiple", "integer", "twoWay"].includes(key) &&
			typeof value !== "boolean"
		)
			throw new Error(`${key} must be true or false.`);
		if (["minLength", "maxLength"].includes(key) && value !== null && typeof value !== "number")
			throw new Error(`${key} must be a number or null.`);
		if (key === "pattern" && value !== null && typeof value !== "string")
			throw new Error("pattern must be a string or null.");
		if (key === "fields") {
			if (!Array.isArray(value)) throw new Error("fields must be a JSON array.");
			for (const field of value) checkShape(field, depth + 1);
		}
		if (key === "postTypes" && (!Array.isArray(value) || value.some((item) => typeof item !== "string")))
			throw new Error("postTypes must be an array of Post Type keys.");
		if (
			key === "options" &&
			(!Array.isArray(value) ||
				value.some(
					(item) =>
						!item || typeof item !== "object" || typeof item.value !== "string" || typeof item.label !== "string",
				))
		)
			throw new Error("options must be an array of choices with value and label strings.");
	}
}
