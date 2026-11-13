import {
	CONSENT_CATEGORIES,
	CSP_MODES,
	LibraryNotFoundError,
	OUTSIDE_SCRIPT_NAME_MAX_LENGTH,
	OUTSIDE_SCRIPT_PLACEMENTS,
	SNIPPET_MAX_LENGTH,
} from "@webcraft/core";
import { z } from "zod";

import { confirmationInput, confirmedForApiClients } from "../confirm.ts";
import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";
import { languageOf } from "./modules.ts";

/**
 * A Site's Content Security Policy (ADR 0023): Strict by default, Relaxed (inline scripts and eval,
 * for tag managers) or Report only, and the outside hosts it allows. Structure: Staff only
 * (`structure.edit`). Each change applies at once and clears the Site's page cache.
 */
export const csp = {
	/** The Site's policy: its mode, its allowed hosts (with the outside scripts needing each) and the hosts of its running Modules. */
	get: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		const language = await languageOf(context.services, context.person);
		return { policy: await context.services.siteScripts.csp(site, language) };
	}),

	/** Changes how the Site's policy applies: `strict`, `relaxed` or `reportOnly`. */
	setMode: signedIn.input(z.object({ siteId: id, mode: z.enum(CSP_MODES) })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		const language = await languageOf(context.services, context.person);
		return { policy: await context.services.siteScripts.setCspMode(site, input.mode, language) };
	}),

	/**
	 * Allows a host by hand, such as one a tag manager loads from: a host name (`tags.example.com`), or
	 * `*.` and a domain for every host under it; `HOST_INVALID` for anything else. Allowed over https only.
	 */
	addHost: signedIn.input(z.object({ siteId: id, host: z.string().max(300) })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		const language = await languageOf(context.services, context.person);
		return { policy: await context.services.siteScripts.addAllowedHost(site, input.host, language) };
	}),

	/** Removes an allowed host, whoever added it: outside scripts loading from it are then blocked. */
	removeHost: signedIn
		.input(z.object({ siteId: id, host: z.string().max(300) }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const language = await languageOf(context.services, context.person);
			return { policy: await context.services.siteScripts.removeAllowedHost(site, input.host, language) };
		}),
};

const outsideScript = z.object({
	name: z.string().max(OUTSIDE_SCRIPT_NAME_MAX_LENGTH * 2),
	placement: z.enum(OUTSIDE_SCRIPT_PLACEMENTS),
	consentCategory: z.enum(CONSENT_CATEGORIES),
	source: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("url"), url: z.string().max(2000) }),
		z.object({ kind: z.literal("snippet"), snippet: z.string().max(SNIPPET_MAX_LENGTH) }),
	]),
});

/** An outside script's input as the API takes it, as the content store takes it. */
function readInput({ source, ...rest }: z.infer<typeof outsideScript>) {
	return { ...rest, ...source };
}

/**
 * A Site's outside scripts (ADR 0022): tags, pixels and widgets loaded live from another host, given
 * as an https address or pasted as a snippet. They never run in Edit mode. Code a snippet holds is
 * served from the Site as a file (never inline), and the hosts they load from are allowed by
 * themselves. Structure: Staff only (`structure.edit`); a change applies at once.
 */
export const outsideScripts = {
	/** The Site's outside scripts, in the order they load. */
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { outsideScripts: await context.services.siteScripts.outsideScripts.list(site) };
	}),

	/**
	 * Adds an outside script: where it loads (the end of `<head>` or of `<body>`), its Consent category,
	 * and an https address or a pasted snippet. A snippet that isn't only scripts, or an address that
	 * isn't https, is `OUTSIDE_SCRIPT_INVALID` with each problem's line.
	 */
	add: signedIn.input(z.object({ siteId: id }).extend(outsideScript.shape)).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		const { siteId: _, ...given } = input;
		return { outsideScript: await context.services.siteScripts.outsideScripts.add(site, readInput(given)) };
	}),

	/** Changes an outside script: what it loads, where, its name and its Consent category. */
	update: signedIn
		.input(z.object({ siteId: id, outsideScriptId: id }).extend(outsideScript.shape))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, outsideScriptId, ...given } = input;
			return {
				outsideScript: await context.services.siteScripts.outsideScripts.update(
					site,
					outsideScriptId,
					readInput(given),
				),
			};
		}),

	/** Removes an outside script; the hosts only it needed are no longer allowed. */
	remove: signedIn.input(z.object({ siteId: id, outsideScriptId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		await context.services.siteScripts.outsideScripts.remove(site, input.outsideScriptId);
		return { removed: true };
	}),
};

const library = z.discriminatedUnion("source", [
	z.object({
		source: z.literal("npm"),
		packageName: z.string().max(300),
		version: z.string().max(100),
		file: z.string().max(400).nullable().optional(),
	}),
	z.object({ source: z.literal("url"), url: z.string().max(2000) }),
]);

/**
 * A Site's Libraries (ADR 0023): script packages kept at a fixed version, downloaded once (from the
 * npm registry by package and version, or from an https address), served from the Site and loaded on
 * every page before the Site script. Nothing updates on its own. Structure: Staff only
 * (`structure.edit`); a change applies at once.
 */
export const libraries = {
	/** The Site's Libraries, in the order pages load them, each with a newer version when one was found. */
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { libraries: await context.services.siteScripts.libraries.list(site) };
	}),

	/**
	 * Downloads a Library and adds it: a package of the npm registry at a version (exact, partial such
	 * as `3.13`, or a tag such as `latest`), optionally a file of it (else the file its manifest names),
	 * or an https address. Refused with `LIBRARY_REFUSED` and `data.problem`.
	 */
	add: signedIn.input(z.object({ siteId: id, library })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { library: await context.services.siteScripts.libraries.add(site, input.library) };
	}),

	/** Asks the registry which of the Site's Libraries have newer versions. Nothing is updated. */
	checkUpdates: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { libraries: await context.services.siteScripts.libraries.checkUpdates(site) };
	}),

	/**
	 * Updates a Library: one from the registry to `version` (its newest unless given), one added by
	 * address downloaded again. The file it replaces is still served for 30 days.
	 */
	update: signedIn
		.input(z.object({ siteId: id, libraryId: id, version: z.string().max(100).optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return {
				library: await context.services.siteScripts.libraries.update(site, input.libraryId, input.version),
			};
		}),

	/** Removes a Library from the Site's pages; its file is still served for 30 days. */
	remove: signedIn
		.input(z.object({ siteId: id, libraryId: id, confirmation: confirmationInput }))
		.use(
			confirmedForApiClients({
				action: "library.remove",
				permission: () => "structure.edit",
				describe: async (site, input, services) => {
					const found = (await services.siteScripts.libraries.list(site)).find((each) => each.id === input.libraryId);
					if (!found) throw new LibraryNotFoundError();
					const { name, version, src } = found;
					return { target: found.id, preview: { library: { id: found.id, name, version, src } } };
				},
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			await context.services.siteScripts.libraries.remove(site, input.libraryId);
			return { removed: true };
		}),
};
