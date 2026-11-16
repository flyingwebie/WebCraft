import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";

/**
 * The way into the building area (ADR 0037): the admin asks for a single-use link that opens it on
 * the Site's own address (`editMode.open` with `building`), then follows it, so every admin screen
 * that opens the building area is a plain link here. `open` names the document (`/page/<path>`, the
 * home page unless given) and `returnTo` the admin path its logo tile goes back to (this Site's page
 * unless given); the server checks both. `filter` (a Filter's id, from the Filters screen) opens it
 * with the element placing that Filter selected (BA-34), `element` (an element's id in the document's
 * markup, from the Checks) with that element selected (BA-28); `safe` opens it in Safe mode. Every way
 * into Edit mode comes here: "Edit on site" and its Safe mode, the Templates', Components', Popups'
 * and Checks' links, and the old visual builder's addresses (`/builder/…`, redirected).
 */
export const Route = createFileRoute("/_admin/sites/$siteId/build")({
	validateSearch: z.object({
		open: z.string().max(4000).optional().catch(undefined),
		returnTo: z.string().max(2000).optional().catch(undefined),
		filter: z.uuid().optional().catch(undefined),
		element: z
			.string()
			.regex(/^[A-Za-z0-9_-]{1,64}$/)
			.optional()
			.catch(undefined),
		safe: z.boolean().optional().catch(undefined),
	}),
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "buildingArea.pageTitle") }] }),
	component: OpenBuildingArea,
});

function OpenBuildingArea() {
	const t = useT();
	const { siteId } = Route.useParams();
	const { open, returnTo, filter, element, safe } = Route.useSearch();
	const [problem, setProblem] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const api = await getApi();
				// The Filter or element to select are the shell's own parameters, after the document.
				const asked = new URLSearchParams();
				if (filter) asked.set("wc-filter", filter);
				if (element) asked.set("wc-element", element);
				const opening = open && asked.size > 0 ? `${open}${open.includes("?") ? "&" : "?"}${asked.toString()}` : open;
				const { url } = await api.editMode.open({
					siteId,
					...(opening ? { open: opening } : {}),
					...(safe ? { safeMode: true } : {}),
					returnTo: returnTo ?? `/sites/${siteId}`,
				});
				if (!cancelled) window.location.replace(url);
			} catch (error) {
				if (!cancelled) setProblem(t(errorMessage(error)));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [siteId, open, returnTo, filter, element, safe, t]);
	return (
		<div className="grid gap-4">
			<PageHeader heading={t("buildingArea.pageTitle")} />
			{problem ? (
				<p role="alert" className="text-destructive text-sm">
					{problem}
				</p>
			) : (
				<p role="status" className="text-muted-foreground text-sm">
					{t("buildingArea.opening")}
				</p>
			)}
		</div>
	);
}
