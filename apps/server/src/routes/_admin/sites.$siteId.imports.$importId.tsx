import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { errorCode } from "../../ui/errors.ts";
import { pageTitleOf } from "../../ui/i18n.tsx";

/** One Import: running it again, and its runs below it. */
export const Route = createFileRoute("/_admin/sites/$siteId/imports/$importId")({
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("import.run")) throw notFound();
		const api = await getApi();
		try {
			const { import: found } = await api.imports.get({ siteId: params.siteId, importId: params.importId });
			return { import: found, crumb: found.name };
		} catch (error) {
			if (errorCode(error) === "IMPORT_NOT_FOUND" || errorCode(error) === "BAD_REQUEST") throw notFound();
			throw error;
		}
	},
	head: ({ match, loaderData }) => ({
		meta: [{ title: pageTitleOf(match.context.shell.language.code, loaderData?.import.name, match.context.site.name) }],
	}),
	component: Outlet,
});
