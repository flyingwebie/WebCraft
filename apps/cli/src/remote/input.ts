import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { CliError, EXIT } from "../exit-codes.ts";
import type { CliIo } from "../io.ts";
import type { JsonSchema, RemoteCommand } from "./catalogue.ts";

/**
 * A remote command's input from its options, read through the procedure's input schema:
 *
 * - every property is an option, its name in kebab-case (`siteId` is `--site-id`; `--siteId` works too);
 * - text, numbers and choices are written as they are (`--limit 20`, `--kind image`); `null` is null
 *   where the schema allows it;
 * - true/false properties are switches: `--trash`, `--no-trash`, or `--trash=false`;
 * - lists of text or numbers repeat the option (`--hidden-languages fr --hidden-languages de`) or take
 *   a JSON array;
 * - anything else (objects, lists of objects) takes JSON, or `@file` to read the JSON from a file;
 * - files (uploads) take a path;
 * - `--data <json | @file | ->` gives the whole input (or its base, which options then change).
 */
export async function inputOf(
	command: RemoteCommand,
	args: readonly string[],
	io: CliIo,
): Promise<Record<string, unknown>> {
	const properties = propertiesOf(command.input);
	const byOption = new Map<string, string>();
	for (const name of Object.keys(properties)) {
		byOption.set(optionName(name), name);
		byOption.set(name, name);
	}
	let input: Record<string, unknown> = {};
	const given: Record<string, unknown> = {};
	const repeated = new Map<string, unknown[]>();

	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (!arg.startsWith("--")) {
			throw new CliError(
				EXIT.usage,
				`Unexpected argument "${arg}". Options start with --; see webcraft ${command.words.join(" ")} --help.`,
			);
		}
		const equals = arg.indexOf("=");
		const flag = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
		const inline = equals === -1 ? undefined : arg.slice(equals + 1);
		if (flag === "data") {
			const text = inline ?? args[++index];
			if (text === undefined) throw new CliError(EXIT.usage, "--data needs JSON, @file or - (standard input).");
			input = await dataOption(text, io);
			continue;
		}
		const negated = flag.startsWith("no-") && !byOption.has(flag) ? byOption.get(flag.slice(3)) : undefined;
		const name = byOption.get(flag) ?? negated;
		if (!name) {
			throw new CliError(
				EXIT.usage,
				`webcraft ${command.words.join(" ")} has no option --${flag}. See webcraft ${command.words.join(" ")} --help.`,
			);
		}
		const schema = properties[name] ?? {};
		const kinds = kindsOf(schema);
		if (kinds.has("boolean") && kinds.size <= 2 && (inline === undefined || negated)) {
			if (negated && inline !== undefined) throw new CliError(EXIT.usage, `--no-${optionName(name)} takes no value.`);
			given[name] = !negated;
			continue;
		}
		if (negated) throw new CliError(EXIT.usage, `--${optionName(name)} isn't a switch: give it a value.`);
		const text = inline ?? args[++index];
		if (text === undefined)
			throw new CliError(EXIT.usage, `--${optionName(name)} needs a value (${placeholder(schema, command, name)}).`);
		if (command.files.includes(name)) {
			given[name] = await fileOption(text, io);
			continue;
		}
		const items = itemSchema(schema);
		if (items && !text.trim().startsWith("[")) {
			const list = repeated.get(name) ?? [];
			list.push(await optionValue(name, items, text, io));
			repeated.set(name, list);
			given[name] = list;
			continue;
		}
		given[name] = await optionValue(name, schema, text, io);
	}

	input = { ...input, ...given };
	const required = Array.isArray(command.input.required) ? (command.input.required as string[]) : [];
	const missing = required.filter((name) => input[name] === undefined && name !== "confirmation");
	if (missing.length > 0) {
		throw new CliError(
			EXIT.usage,
			`webcraft ${command.words.join(" ")} needs ${missing.map((name) => `--${optionName(name)}`).join(", ")}.`,
		);
	}
	return input;
}

/** A property's option: `siteId` is `site-id`. */
export function optionName(property: string): string {
	return property.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function propertiesOf(schema: JsonSchema): Record<string, JsonSchema> {
	return (schema.properties ?? {}) as Record<string, JsonSchema>;
}

/** The JSON types a schema takes: `string`, `number`, `null`, … or `any`. */
export function kindsOf(schema: JsonSchema): Set<string> {
	const kinds = new Set<string>();
	const visit = (part: JsonSchema) => {
		if (Array.isArray(part.anyOf)) for (const each of part.anyOf as JsonSchema[]) visit(each);
		else if (Array.isArray(part.oneOf)) for (const each of part.oneOf as JsonSchema[]) visit(each);
		else if (Array.isArray(part.type)) for (const each of part.type as string[]) kinds.add(each);
		else if (typeof part.type === "string") kinds.add(part.type);
		else if ("const" in part) kinds.add(part.const === null ? "null" : typeof part.const);
		else if (Array.isArray(part.enum)) for (const each of part.enum) kinds.add(each === null ? "null" : typeof each);
		else kinds.add("any");
	};
	visit(schema);
	if (kinds.has("integer")) kinds.add("number");
	return kinds;
}

/** The schema of a list's items when the list holds text or numbers only (a repeatable option). */
function itemSchema(schema: JsonSchema): JsonSchema | null {
	const kinds = kindsOf(schema);
	if (!kinds.has("array") || [...kinds].some((kind) => kind !== "array" && kind !== "null")) return null;
	const items = (schema.items ??
		(schema.anyOf as JsonSchema[] | undefined)?.find((part) => part.type === "array")?.items) as JsonSchema | undefined;
	if (!items) return null;
	const itemKinds = kindsOf(items);
	return [...itemKinds].every((kind) => kind === "string" || kind === "number") ? items : null;
}

/** The choices a schema allows, when it lists them. */
export function choicesOf(schema: JsonSchema): unknown[] | null {
	if (Array.isArray(schema.enum)) return schema.enum as unknown[];
	if ("const" in schema) return [schema.const];
	if (Array.isArray(schema.anyOf)) {
		const all = (schema.anyOf as JsonSchema[]).map(choicesOf);
		if (all.every((each) => each !== null)) return all.flat();
	}
	return null;
}

/** How help writes an option's value. */
export function placeholder(schema: JsonSchema, command: RemoteCommand, name: string): string {
	if (command.files.includes(name)) return "<path>";
	const choices = choicesOf(schema);
	if (choices) return `<${choices.map((choice) => String(choice)).join("|")}>`;
	const items = itemSchema(schema);
	if (items) return `${placeholder(items, command, "")}…`;
	const kinds = kindsOf(schema);
	kinds.delete("null");
	if (kinds.size === 1) {
		const [kind] = kinds;
		if (kind === "string") return formatOf(schema) === "uuid" ? "<id>" : "<text>";
		if (kind === "integer" || kind === "number")
			return `<${kind === "integer" || kindsOf(schema).has("integer") ? "integer" : "number"}>`;
		if (kind === "boolean") return "";
	}
	return "<json>";
}

/** A text schema's format (`uuid`), looking inside `anyOf` (text or null). */
function formatOf(schema: JsonSchema): unknown {
	if (schema.format !== undefined) return schema.format;
	const parts = Array.isArray(schema.anyOf) ? (schema.anyOf as JsonSchema[]) : [];
	return parts.find((part) => part.format !== undefined)?.format;
}

/** One option's value through its schema. */
async function optionValue(name: string, schema: JsonSchema, text: string, io: CliIo): Promise<unknown> {
	const kinds = kindsOf(schema);
	const option = `--${optionName(name)}`;
	if (text === "null" && kinds.has("null")) return null;
	const choices = choicesOf(schema);
	const onlyText = [...kinds].every((kind) => kind === "string" || kind === "null");
	if (onlyText) {
		if (choices && !choices.includes(text)) {
			throw new CliError(EXIT.usage, `${option} is one of ${choices.map(String).join(", ")}.`);
		}
		return text;
	}
	const onlyNumbers = [...kinds].every((kind) => kind === "number" || kind === "integer" || kind === "null");
	if (onlyNumbers) {
		const number = Number(text);
		if (text.trim() === "" || !Number.isFinite(number) || (kinds.has("integer") && !Number.isInteger(number))) {
			throw new CliError(EXIT.usage, `${option} takes ${kinds.has("integer") ? "a whole number" : "a number"}.`);
		}
		return number;
	}
	if (kinds.has("boolean") && [...kinds].every((kind) => kind === "boolean" || kind === "null")) {
		if (text === "true" || text === "false") return text === "true";
		throw new CliError(EXIT.usage, `${option} is true or false.`);
	}
	const json = text.startsWith("@") ? await readFileOption(text.slice(1), io, option) : text;
	try {
		return JSON.parse(json);
	} catch {
		if (kinds.has("string") || kinds.has("any")) return text;
		throw new CliError(EXIT.usage, `${option} takes JSON (or @file to read it from a file).`);
	}
}

async function dataOption(text: string, io: CliIo): Promise<Record<string, unknown>> {
	const json =
		text === "-"
			? await io.readStdin()
			: text.startsWith("@")
				? await readFileOption(text.slice(1), io, "--data")
				: text;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new CliError(EXIT.usage, "--data takes a JSON object (or @file, or - for standard input).");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CliError(EXIT.usage, "--data takes a JSON object: the procedure's whole input.");
	}
	return value as Record<string, unknown>;
}

async function readFileOption(path: string, io: CliIo, option: string): Promise<string> {
	try {
		return await readFile(resolve(io.cwd, path), "utf8");
	} catch (error) {
		throw new CliError(EXIT.usage, `${option}: can't read ${path} (${(error as { code?: string }).code ?? "error"}).`);
	}
}

async function fileOption(path: string, io: CliIo): Promise<File> {
	const full = resolve(io.cwd, path);
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = new Uint8Array(await readFile(full));
	} catch (error) {
		throw new CliError(EXIT.usage, `Can't read the file ${path} (${(error as { code?: string }).code ?? "error"}).`);
	}
	return new File([bytes], basename(full), { type: Bun.file(full).type || "application/octet-stream" });
}
