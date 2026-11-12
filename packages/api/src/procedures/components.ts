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
import { basedOn, id } from "../inputs.ts";

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

	/**
	 * Creates a Component with its name (its PascalCase tag) and Props, as a Draft with an empty tree.
	 * With `place`, it is also placed in a Template's or Component's Draft at `place.path`, in the same
	 * step: `place.list` is the list it goes into as you read it, and a change made there meanwhile
	 * refuses both (`CHANGED_MEANWHILE`). Answers the Placement too.
	 */
	create: signedIn
		.input(
			z.object({
				siteId: id,
				name: componentName,
				props: fieldInputs.optional(),
				place: newComponentPlace.optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { place, ...component } = input;
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
	 * `COMPONENT_IN_USE` (and `data.usedIn`) while any Template or Component places it.
	 */
	delete: signedIn
		.input(z.object({ siteId: id, componentId, confirmation: z.string().max(100).optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.components.delete(site, input.componentId, input.confirmation);
		}),
};
