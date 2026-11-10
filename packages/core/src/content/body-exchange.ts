/**
 * Bodies as Markdown for API clients, the MCP server and the CLI (ADR 0018, spec story 88): an Entry
 * is read with its Body field as Markdown (`bodyFormat: "markdown"`), and a body given as Markdown is
 * converted to Blocks before it is saved. Markdown that doesn't convert cleanly is refused with each
 * problem's line; nothing is dropped silently. The dialect is the one Markdown copies use
 * (`bodyMarkdown`): links as written, images as `media:<id>`, Components as their tags.
 */
import { type Block, blocksFromMarkdown, bodyMarkdown, storedBlocks } from "@webcraft/renderer";

import type { SiteScope } from "../tenancy/data-layer.ts";
import { bodyComponentFinder, componentNames } from "./body-components.ts";
import type { ContentProblem } from "./errors.ts";
import type { BodyField, FieldDefinition, Json } from "./field-types.ts";

/** How an Entry's body is read and written: the JSON Blocks (the default) or Markdown. */
export const ENTRY_BODY_FORMATS = ["blocks", "markdown"] as const;
export type BodyFormat = (typeof ENTRY_BODY_FORMATS)[number];

/** A body's Blocks as the exchange Markdown, given the names of the Site's Components. */
export function exchangeMarkdown(blocks: readonly Block[], names: ReadonlyMap<string, string>): string {
	return bodyMarkdown(blocks, {
		link: (url) => url,
		image: (id) => ({ url: `media:${id}`, alt: null, caption: null }),
		exchange: true,
		component: (block) => {
			const name = names.get(block.component);
			return name ? { name } : undefined;
		},
	});
}

/** The Body field among a Post Type's Fields (at most one, at the top), if it has one. */
export function bodyFieldOf(fields: readonly FieldDefinition[]): BodyField | undefined {
	return fields.find((field): field is BodyField => field.type === "body");
}

/**
 * The values given with the body as Markdown turned into Blocks, ready for the Field's own checks:
 * `previous` is the body they replace (its Blocks keep their ids). A value that isn't Markdown text, or
 * Markdown that doesn't convert, is reported at the Field with its lines.
 */
export async function withBodyFromMarkdown(
	scope: SiteScope,
	fields: readonly FieldDefinition[],
	given: Record<string, unknown>,
	previous: Json | undefined,
	problems: ContentProblem[],
): Promise<Record<string, unknown>> {
	const field = bodyFieldOf(fields);
	if (!field || !(field.key in given)) return given;
	const input = given[field.key];
	const at = `fields.${field.key}`;
	if (input === null || input === "") return given;
	if (typeof input !== "string") {
		problems.push({ at, message: "With bodyFormat markdown, the body is Markdown text." });
		const { [field.key]: _, ...rest } = given;
		return rest;
	}
	const { blocks, problems: found } = blocksFromMarkdown(input, {
		component: await bodyComponentFinder(scope, field),
		previous: storedBlocks(previous),
	});
	if (found.length > 0) {
		for (const problem of found) problems.push({ at, line: problem.line, message: problem.message });
		const { [field.key]: _, ...rest } = given;
		return rest;
	}
	return { ...given, [field.key]: blocks };
}

/** Entries' values with their bodies as Markdown, in place of the Blocks. */
export async function bodiesAsMarkdown<
	Item extends { draft: { fields: Record<string, Json> }; published: { fields: Record<string, Json> } | null },
>(scope: SiteScope, fields: readonly FieldDefinition[], items: Item[]): Promise<Item[]> {
	const field = bodyFieldOf(fields);
	if (!field || items.length === 0) return items;
	const names = await componentNames(scope);
	const convert = (values: Record<string, Json>) => ({
		...values,
		[field.key]: exchangeMarkdown(storedBlocks(values[field.key]), names),
	});
	return items.map((item) => ({
		...item,
		draft: { ...item.draft, fields: convert(item.draft.fields) },
		published: item.published ? { ...item.published, fields: convert(item.published.fields) } : null,
	}));
}
