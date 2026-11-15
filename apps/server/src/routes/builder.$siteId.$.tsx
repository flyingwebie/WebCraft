import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { isBuildingDocument } from "@webcraft/core/building-addresses";
import { z } from "zod";

/**
 * The old visual builder's addresses (`/builder/<site>/site-template`, `…/entry-template/<Post Type>`,
 * `…/component/<id>` and so on), kept for links and bookmarks made before the building area (ADR 0037)
 * replaced it: each goes to the admin's way into the building area, opening the same Template or
 * Component, with the Entry it previewed, the element or Filter it selected and the admin screen to go
 * back to. An address that names no document is not found.
 */
const search = z.object({
	entry: z.uuid().optional().catch(undefined),
	element: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,64}$/)
		.optional()
		.catch(undefined),
	returnPath: z
		.string()
		.max(2000)
		.regex(/^\/(?![/\\])[^\s\\?#]*$/)
		.optional()
		.catch(undefined),
	filter: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/builder/$siteId/$")({
	validateSearch: search,
	beforeLoad: ({ params, search }) => {
		const splat = params._splat ?? "";
		const open = `/${splat}${splat.startsWith("entry-template/") && search.entry ? `?entry=${search.entry}` : ""}`;
		if (splat === "" || splat.startsWith("page") || !isBuildingDocument(open)) throw notFound();
		throw redirect({
			to: "/sites/$siteId/build",
			params: { siteId: params.siteId },
			search: {
				open,
				...(search.returnPath ? { returnTo: search.returnPath } : {}),
				...(search.element ? { element: search.element } : {}),
				...(search.filter ? { filter: search.filter } : {}),
			},
			replace: true,
		});
	},
});
