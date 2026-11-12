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

/** The id of a Class or a breakpoint token. */
const designId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** Which CSS a save changes: one piece of a Class (its styles, own CSS, or a breakpoint's styles), or the Site CSS. */
const cssTarget = z.union([
	z.object({ kind: z.literal("class"), classId: designId, part: z.literal("styles") }),
	z.object({ kind: z.literal("class"), classId: designId, part: z.literal("css") }),
	z.object({ kind: z.literal("class"), classId: designId, part: z.literal("breakpoint"), breakpointId: designId }),
	z.object({ kind: z.literal("site") }),
]);

/** The tree as the builder has it, with its pending one-off styles and, for a Component, its Props. */
const draft = { tree: z.unknown(), styles, props: fieldInputs.optional() };

/**
 * The visual builder (Structure, Staff only): Templates and Components opened, previewed on the
 * canvas and turned to and from Template markup. It saves through `templates.save…Markup` and
 * `components.saveMarkup`, so the builder and Template markup are two views of one Draft.
 */
export const builder = {
	/** Renderable editing destinations, including never-published Entries and repeated Component Placements. */
	destinations: signedIn
		.input(z.object({ siteId: id, target, entryId: id.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.builder.destinations(site, input.target, input.entryId);
		}),
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
	preview: signedIn
		.input(z.object({ siteId: id, target, ...draft, entryId: id.optional() }))
		.handler(async ({ context, input }) => {
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

	/**
	 * What the CSS panel shows on the Builder canvas, as on Code mode's: the Classes the element has
	 * now, by id in its order (token utilities and unknown ids left out), each with its CSS as text,
	 * its version and how many elements and published pages use it; the breakpoints, the Site CSS and
	 * the tokens' custom properties.
	 */
	css: signedIn
		.input(z.object({ siteId: id, classes: z.array(z.string().max(200)).max(500) }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.builder.css(site, input.classes);
		}),

	/**
	 * Saves a piece of a Class, or the Site CSS, to the Design system's Draft, based on the version
	 * `css` answered: `CHANGED_MEANWHILE` with the newer version when someone changed it meanwhile,
	 * `DESIGN_SYSTEM_INVALID` with each problem when its checks refuse the CSS.
	 */
	saveCss: signedIn
		.input(
			z.object({
				siteId: id,
				target: cssTarget,
				text: z.string().max(CSS_MAX_LENGTH),
				version: z
					.string()
					.regex(/^[0-9a-f]{16}$/)
					.nullable(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, ...save } = input;
			return context.services.builder.saveCss(site, save);
		}),
};
