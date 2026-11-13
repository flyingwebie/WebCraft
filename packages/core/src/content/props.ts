/**
 * A Placement's Prop values as Template markup writes them: attribute text, read through the Prop's
 * Field type (the same registry Fields use, `FIELD_TYPE_SPECS`). Each type has one written form:
 *
 * - text, rich text (its HTML), email, a date (`2026-03-02`, `09:30`, `2026-03-02T09:30:00Z`) and a
 *   select's choice (its value): as they are;
 * - a number: `3`, `-2.5`;
 * - true/false: `true` or `false`, or the Prop's name alone for true (`<Card featured />`);
 * - a media file: `media:<id>`;
 * - several choices, or a Relationship's Entries: values or ids separated by commas;
 * - a link: its address, or JSON `{"url": "/about", "text": "About us"}`;
 * - a Group (its Fields' values by key) and a Repeater (a list of rows): JSON, each value as the
 *   APIs take a Field's value.
 *
 * Values that read where the Component is placed (`{{ title }}`) can't be checked until then: a
 * value that doesn't fit renders nothing.
 */
import { mediaReference, RETAINED_KEY, readMetadataJson, retainedValues } from "@webcraft/renderer";
import { MAX_FIELD_DEPTH } from "./field-rules.ts";
import {
	type FieldDefinition,
	type GroupField,
	isContainer,
	type Json,
	type LeafField,
	MAX_ROWS,
	type RepeaterField,
	specOf,
	type ValueSpec,
} from "./field-types.ts";
import { readRetainedContract } from "./prop-contracts.ts";

/** A Prop's value read from its text, or why the text can't be one. */
export type PropText = { value: Json } | { problem: string };

const NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Reads fixed text as a Prop's value, checking it against the Prop's rules. Empty text is no value. */
export function readPropText(prop: FieldDefinition, text: string, checkRetained = true): PropText {
	const trimmed = text.trim();
	if (prop.type === "boolean") {
		const word = trimmed.toLowerCase();
		if (word === "" || word === "true") return { value: true };
		if (word === "false") return { value: false };
		return { problem: "true or false (the Prop's name alone is true)." };
	}
	if (trimmed === "") return prop.required ? { problem: "the Prop is required." } : { value: null };
	if (isContainer(prop)) {
		let input: unknown;
		try {
			input = trimmed.includes(RETAINED_KEY) ? readMetadataJson(trimmed) : JSON.parse(trimmed);
		} catch {
			return { problem: `a ${prop.type === "group" ? "Group" : "Repeater"}'s value is written as JSON.` };
		}
		return readPropJson(prop, input, "", checkRetained);
	}
	const input = leafInput(prop, trimmed);
	if (typeof input === "object" && input !== null && "problem" in input) return input as PropText;
	return readLeaf(prop, input);
}

/** A Prop's value from fixed text, or null when the text isn't one it holds. */
export function propValue(prop: FieldDefinition, text: string): Json {
	const read = readPropText(prop, text, false);
	return "value" in read ? read.value : null;
}

/** What the written text of a leaf type stands for, as the Field type's `parse` takes values. */
function leafInput(prop: LeafField, text: string): unknown {
	switch (prop.type) {
		case "number":
			return NUMBER.test(text) ? Number(text) : { problem: "a number, such as 3 or 2.5." };
		case "media": {
			const id = mediaReference(text);
			return id ?? { problem: "media: and the id of a file in the Site's Media library." };
		}
		case "link":
			if (!text.startsWith("{")) return { url: text, text: "" };
			try {
				return JSON.parse(text);
			} catch {
				return { problem: 'a link is its address, or JSON such as {"url": "/about", "text": "About us"}.' };
			}
		case "select":
		case "relationship":
			return prop.multiple
				? text
						.split(",")
						.map((part) => part.trim())
						.filter(Boolean)
				: text;
		default:
			return text;
	}
}

/** Reads one leaf value through its Field type and checks its rules. */
function readLeaf(field: LeafField, input: unknown): PropText {
	const spec = specOf(field).value as unknown as ValueSpec<LeafField>;
	let failed: string | undefined;
	const value = spec.parse(
		input,
		field,
		(message) => {
			failed = message;
			return null;
		},
		() => {},
	);
	if (failed !== undefined) return { problem: failed };
	if (value === null || (spec.isEmpty?.(value) ?? (Array.isArray(value) && value.length === 0))) {
		return field.required ? { problem: "the Prop is required." } : { value: null };
	}
	const broken = spec.rules(value, field);
	if (broken.length > 0) return { problem: broken.map((rule) => rule.message).join(" ") };
	return { value };
}

/** Reads a Group's or Repeater's value from JSON, each Field's value as the APIs take it. */
export function readPropJson(
	field: FieldDefinition,
	input: unknown,
	at = "",
	checkRetained = true,
	depth = 1,
): PropText {
	if (depth > MAX_FIELD_DEPTH)
		return { problem: `Prop values nest at most ${MAX_FIELD_DEPTH} Fields deep, including retained values.` };
	if (field.type === "group") return readGroup(field, input, at, checkRetained, depth);
	if (field.type === "repeater") return readRepeater(field, input, at, checkRetained, depth);
	const read = readLeaf(field, input ?? null);
	return "problem" in read && at ? { problem: `${at}: ${read.problem}` } : read;
}

function readGroup(field: GroupField, input: unknown, at: string, checkRetained: boolean, depth: number): PropText {
	if (input === null) return field.required ? { problem: "the Prop is required." } : { value: null };
	if (typeof input !== "object" || Array.isArray(input))
		return { problem: `${at || field.key}: an object of its Fields' values.` };
	const given = input as Record<string, unknown>;
	const heldIds = new Set<string>();
	if (checkRetained && RETAINED_KEY in given) {
		try {
			for (const held of retainedValues(given[RETAINED_KEY])) {
				heldIds.add(held.id);
				const declaration = held.contract
					? readRetainedContract(held.contract, held.id)
					: field.fields.find((f) => f.id === held.id);
				if (!declaration) return { problem: "The retained value has no matching declaration identity." };
				const checked = readPropJson(declaration, held.value, at, checkRetained, depth + 1);
				if ("problem" in checked) return checked;
			}
		} catch (error) {
			return { problem: (error as Error).message };
		}
	}
	const unknown = Object.keys(given).find(
		(key) => key !== RETAINED_KEY && !field.fields.some((inner) => inner.key === key),
	);
	if (unknown !== undefined)
		return { problem: `${at ? `${at}.` : ""}${unknown}: the Group has no Field named ${unknown}.` };
	const value: Record<string, Json> = {};
	for (const inner of field.fields) {
		if (Object.hasOwn(value, inner.key)) continue;
		if (!Object.hasOwn(given, inner.key) && inner.id && heldIds.has(inner.id)) continue;
		const read = readPropJson(
			inner,
			given[inner.key] ?? null,
			at ? `${at}.${inner.key}` : inner.key,
			checkRetained,
			depth + 1,
		);
		if ("problem" in read) return read;
		value[inner.key] = read.value;
	}
	return { value };
}

function readRepeater(
	field: RepeaterField,
	input: unknown,
	at: string,
	checkRetained: boolean,
	depth: number,
): PropText {
	if (input === null) return field.required ? { problem: "the Prop is required." } : { value: null };
	if (!Array.isArray(input))
		return { problem: `${at || field.key}: a list of rows, each an object of its Fields' values.` };
	if (input.length > MAX_ROWS) return { problem: `At most ${MAX_ROWS} rows.` };
	if (field.min !== null && input.length < field.min) return { problem: `At least ${field.min} rows.` };
	if (field.max !== null && input.length > field.max) return { problem: `At most ${field.max} rows.` };
	if (field.required && input.length === 0) return { problem: "the Prop is required." };
	const rows: Json[] = [];
	for (const [index, row] of input.entries()) {
		const read = readGroup(
			{ ...field, type: "group", required: false } as unknown as GroupField,
			row ?? {},
			`${at || field.key}[${index}]`,
			checkRetained,
			depth,
		);
		if ("problem" in read) return read;
		rows.push(read.value);
	}
	return { value: rows };
}
