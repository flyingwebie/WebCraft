import {
	CONSENT_CATEGORIES,
	componentSourceTarget,
	LIBRARIES_PER_SITE,
	madeTexts,
	newComponentPlace,
	publishPermission,
	SCRIPT_MAX_LENGTH,
	treePath,
} from "@webcraft/core";
import { z } from "zod";

import { confirmationInput, confirmedPublish } from "../confirm.ts";
import { signedIn } from "../context.ts";
import { fieldInputs } from "../fields.ts";
import { basedOn, componentId, id } from "../inputs.ts";

/** The longest Template markup one save takes, in characters. */
const MARKUP_MAX_LENGTH = 2_000_000;

/** A Component's name, its PascalCase tag; the server checks its form. */
const componentName = z.string().max(200);

/**
 * Components: reusable element trees with Props, placed in Templates and other Components with
 * PascalCase tags. Structure, with a Draft and a published version: Staff change and publish them.
 */
export const components = {
	/**
	 * The Site's library Components, and those of the Modules running on it, each with where it is
	 * used. A Page's Sections (Components with a `pageId`) belong to their Page and aren't listed.
	 */
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

	/**
	 * Creates a Component with its name (its PascalCase tag) and Props, as a Draft with an empty tree.
	 * With `place`, it is also placed in a Template's or Component's Draft at `place.path`, in the same
	 * step: `place.list` is the list it goes into as you read it, and a change made there meanwhile
	 * refuses both (`CHANGED_MEANWHILE`). Answers the Placement too.
	 *
	 * With `pageId` instead of `name`, it is a Section of that Page (a Page section): a Component the
	 * Page owns, with a name made for it, listed nowhere, placed only on that Page (through its Page
	 * layout), published with the Page and deleted with it, until `makeReusable` makes it a library
	 * Component. `PAGE_NOT_FOUND` when `pageId` isn't a Page of the Site.
	 */
	create: signedIn
		.input(
			z
				.object({
					siteId: id,
					name: componentName.optional(),
					pageId: id.optional(),
					props: fieldInputs.optional(),
					place: newComponentPlace.optional(),
				})
				.refine((input) => (input.name === undefined) !== (input.pageId === undefined), {
					message: "Give a name, or the Page a Section is made on (pageId), not both.",
					path: ["name"],
				})
				.refine((input) => input.pageId === undefined || input.place === undefined, {
					message: "A Page's Section is placed on its Page, never in a Template or Component.",
					path: ["place"],
				}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { place, name, pageId, props } = input;
			if (pageId !== undefined) return { component: await context.services.components.create(site, { pageId, props }) };
			const component = { name: name ?? "", props };
			if (!place) return { component: await context.services.components.create(site, component) };
			return context.services.components.createPlaced(site, component, place);
		}),

	/**
	 * Make Component: moves the element or Placement at `path` in a Template's or Component's Draft into
	 * a new Component named `name`, and places that Component there instead, so the page looks the
	 * same. What the markup read there (the Entry's values, an outer Loop's items, the outer
	 * Component's Props) becomes Props of the new Component, declared as the source declares them and
	 * bound on the Placement to what they read. `texts` turns pieces of fixed text (in order, depth
	 * first) into text Props whose default is the text. `node` is the node as you read it: a change
	 * made to it meanwhile refuses the whole step (`CHANGED_MEANWHILE`), as does anything the new
	 * Component or the source can't hold; nothing is made then.
	 */
	make: signedIn
		.input(
			z.object({
				siteId: id,
				name: componentName,
				source: componentSourceTarget,
				path: treePath,
				node: z.unknown(),
				texts: madeTexts.optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, ...make } = input;
			return context.services.components.make(site, make);
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
				basedOn,
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, componentId: target, basedOn: base, ...change } = input;
			return context.services.components.saveMarkup(site, target, change, { basedOn: base });
		}),

	/**
	 * Publishes a Component's Draft, its Props and tree together: every copy changes at once, and the
	 * Site's page cache is cleared. Refused while it places a Component that isn't published.
	 */
	publish: signedIn
		.input(z.object({ siteId: id, componentId, confirmation: confirmationInput }))
		.use(confirmedPublish((input) => ({ kind: "component", id: input.componentId })))
		.handler(async ({ context, input }) => {
			const item = { kind: "component", id: input.componentId } as const;
			const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
			const published = await context.services.publishing.publish(site, item);
			return { published, ...(await context.services.components.get(site, input.componentId)) };
		}),

	/**
	 * A Component's Component script: its Draft and published version (each its code, Consent
	 * category and the Libraries it declares), null while it has none. A Module's Components have none.
	 */
	getScript: signedIn.input(z.object({ siteId: id, componentId })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { script: await context.services.scripts.component(site, input.componentId) };
	}),

	/**
	 * Saves the Draft of a Component's Component script, making it the first time: its code (an ES
	 * module whose default export WebCraft calls with each Placement's root element), and its Consent
	 * category and Libraries when given (they stay as they were otherwise). Answers the script and its
	 * Draft's version; with `basedOn`, refused with `CHANGED_MEANWHILE` when someone saved it
	 * meanwhile. Visitors run nothing of it until the Component is published, which publishes it too.
	 */
	saveScriptDraft: signedIn
		.input(
			z.object({
				siteId: id,
				componentId,
				code: z.string().max(SCRIPT_MAX_LENGTH),
				consentCategory: z.enum(CONSENT_CATEGORIES).optional(),
				libraryIds: z.array(id).max(LIBRARIES_PER_SITE).optional(),
				basedOn,
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, componentId: target, basedOn: base, ...change } = input;
			const script = await context.services.scripts.saveComponentDraft(site, target, change, { basedOn: base });
			return { script, version: script.version };
		}),

	/**
	 * Make reusable Component: a Page's Section (a Component with a `pageId`) becomes a library
	 * Component named `name`: listed with the others and placeable anywhere. Its Placement on the
	 * Page stays as it is. `COMPONENT_NOT_PAGE_SECTION` for a Component that is reusable already;
	 * `COMPONENT_NAME_TAKEN` when another has the name.
	 */
	makeReusable: signedIn
		.input(z.object({ siteId: id, componentId, name: componentName }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return {
				component: await context.services.components.makeReusable(site, input.componentId, input.name),
			};
		}),

	/** Renames a Component: every Template and Component placing it writes the new name at once. */
	rename: signedIn
		.input(z.object({ siteId: id, componentId, name: componentName }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { component: await context.services.components.rename(site, input.componentId, input.name) };
		}),

	/**
	 * Deletes a Component, in two steps. The first call deletes nothing and answers a `confirmation`
	 * id, valid for 5 minutes; calling again with it deletes the Component. Refused with
	 * `COMPONENT_IN_USE` (and `data.usedIn`) while any Template, Component or Page places it, unless
	 * `placements` is `remove` (in both calls): its Placements then go with it, Draft and published,
	 * and the first answer's `usage` says where it is placed and on how many published pages it shows.
	 * A Popup showing it, or the accessibility statement's link, still refuses it.
	 */
	delete: signedIn
		.input(
			z.object({
				siteId: id,
				componentId,
				confirmation: z.string().max(100).optional(),
				placements: z.enum(["refuse", "remove"]).optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.components.delete(site, input.componentId, input.confirmation, input.placements);
		}),
};
