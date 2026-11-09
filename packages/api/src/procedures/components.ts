import { publishPermission } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { fieldInputs } from "../fields.ts";
import { id } from "../inputs.ts";

/** The longest Template markup one save takes, in characters. */
const MARKUP_MAX_LENGTH = 2_000_000;

/** A Component's id: a UUID for the Site's own, `<module id>:<Name>` for a Module's. */
const componentId = z.union([id, z.string().regex(/^[a-z][a-z0-9-]{0,31}:[A-Z][A-Za-z0-9]{0,63}$/)]);

/** A Component's name, its PascalCase tag; the server checks its form. */
const componentName = z.string().max(200);

/**
 * Components: reusable element trees with Props, placed in Templates and other Components with
 * PascalCase tags. Structure, with a Draft and a published version: Staff change and publish them.
 */
export const components = {
	/** The Site's Components, and those of the Modules running on it, each with where it is used. */
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { components: await context.services.components.list(site) };
	}),

	/**
	 * One Component: its Draft and published version (each its Props and element tree), with where
	 * it is placed and on how many published pages visitors see it.
	 */
	get: signedIn.input(z.object({ siteId: id, componentId })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return context.services.components.get(site, input.componentId);
	}),

	/** Creates a Component with its name (its PascalCase tag) and Props, as a Draft with an empty tree. */
	create: signedIn
		.input(z.object({ siteId: id, name: componentName, props: fieldInputs.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { component: await context.services.components.create(site, input) };
		}),

	/**
	 * Saves a Component's Draft: its Props (the full list, in order) and its element tree, either or
	 * both. The tree reads its Props as `props.x` and the Globals as `site.x`; it is checked against
	 * the Props it will have. Visitors see nothing until it is published.
	 */
	saveDraft: signedIn
		.input(z.object({ siteId: id, componentId, props: fieldInputs.optional(), tree: z.unknown().optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, componentId: target, ...change } = input;
			return { component: await context.services.components.saveDraft(site, target, change) };
		}),

	/**
	 * A Component as Template markup, its Draft and published version (null until the first publish),
	 * with where it is placed and on how many published pages it shows (`usage.pages`).
	 */
	getMarkup: signedIn.input(z.object({ siteId: id, componentId })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return context.services.components.markup(site, input.componentId);
	}),

	/**
	 * Saves a Component's Draft from Template markup, with new Props when given. Answers the
	 * Component, its markup as stored now, notices (an inline style that became a generated Class)
	 * and its usage. Refused with each problem's line and column when the markup can't be saved.
	 */
	saveMarkup: signedIn
		.input(
			z.object({
				siteId: id,
				componentId,
				markup: z.string().max(MARKUP_MAX_LENGTH),
				props: fieldInputs.optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, componentId: target, ...change } = input;
			return context.services.components.saveMarkup(site, target, change);
		}),

	/**
	 * Publishes a Component's Draft, its Props and tree together: every copy changes at once, and the
	 * Site's page cache is cleared. Refused while it places a Component that isn't published.
	 */
	publish: signedIn.input(z.object({ siteId: id, componentId })).handler(async ({ context, input }) => {
		const item = { kind: "component", id: input.componentId } as const;
		const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
		const published = await context.services.publishing.publish(site, item);
		return { published, ...(await context.services.components.get(site, input.componentId)) };
	}),
};
