import { CSS_MAX_LENGTH, TREE_LIMITS } from "@webcraft/renderer";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { fieldInputs } from "../fields.ts";
import { id } from "../inputs.ts";

/** The longest Template markup the builder reads, in characters (as a markup save takes). */
const MARKUP_MAX_LENGTH = 2_000_000;

/** What the builder opens: one of the Site's Templates, by kind (and Post Type), or one of its own Components. */
const target = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("siteTemplate") }),
	z.object({ kind: z.literal("searchTemplate") }),
	z.object({ kind: z.literal("entryTemplate"), postTypeId: id }),
	z.object({ kind: z.literal("archiveTemplate"), postTypeId: id }),
	z.object({ kind: z.literal("component"), componentId: id }),
]);

/** One-off styles the builder hasn't saved yet, by element id: CSS declarations, as an inline style holds them. */
const styles = z
	.record(z.string().max(64), z.string().max(CSS_MAX_LENGTH))
	.refine((value) => Object.keys(value).length <= TREE_LIMITS.nodes, "Too many one-off styles.")
	.optional();

/** The tree as the builder has it, with its pending one-off styles and, for a Component, its Props. */
const draft = { tree: z.unknown(), styles, props: fieldInputs.optional() };

/**
 * The visual builder (Structure, Staff only): Templates and Components opened, previewed on the
 * canvas and turned to and from Template markup. It saves through `templates.save…Markup` and
 * `components.saveMarkup`, so the builder and Template markup are two views of one Draft.
 */
export const builder = {
	/**
	 * Opens a Template (`siteTemplate`, `searchTemplate`, a Post Type's `entryTemplate` or
	 * `archiveTemplate`) or one of the Site's Components: its Draft's tree (empty while there is
	 * none), its version for the next save's `basedOn`, and what the builder offers there (elements,
	 * Template commands, Classes, token utilities and variables, Components, Loops, Forms, values).
	 */
	open: signedIn.input(z.object({ siteId: id, target })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return context.services.builder.open(site, input.target);
	}),

	/**
	 * The canvas for a tree as the builder has it: its HTML, rendered as the Site renders it with real
	 * values where the Site has them (every element tagged `data-wc-code="b#<id>"`, no scripts), and
	 * the Design system's Draft's stylesheet, pending one-off styles shown as the generated Classes
	 * they will become. Refused with `TEMPLATE_INVALID` and each problem where it is, as a save would be.
	 */
	preview: signedIn.input(z.object({ siteId: id, target, ...draft })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		const { siteId: _, target: which, ...rest } = input;
		return context.services.builder.preview(site, which, rest);
	}),

	/**
	 * The tree as Template markup, pending one-off styles as inline styles: the Template markup view,
	 * and what a save sends to `templates.save…Markup` or `components.saveMarkup`.
	 */
	markup: signedIn.input(z.object({ siteId: id, target, ...draft })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		const { siteId: _, target: which, ...rest } = input;
		return context.services.builder.markup(site, which, rest);
	}),

	/**
	 * Reads Template markup into a tree as saving it would (`TEMPLATE_MARKUP_INVALID` with each
	 * problem's line and column), its inline styles kept as pending one-off styles: switching from the
	 * Template markup view back to the builder saves and makes nothing.
	 */
	read: signedIn
		.input(z.object({ siteId: id, target, markup: z.string().max(MARKUP_MAX_LENGTH), props: fieldInputs.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.builder.read(site, input.target, { markup: input.markup, props: input.props });
		}),
};
