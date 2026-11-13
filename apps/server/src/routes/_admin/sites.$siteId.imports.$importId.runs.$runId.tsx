import { createFileRoute, notFound } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { errorCode } from "../../ui/errors.ts";
import { pageTitleOf } from "../../ui/i18n.tsx";
import { RunReportPage } from "../../ui/imports/RunReport.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/imports/$importId/runs/$runId")({
	loader: async ({ params }) => {
		const api = await getApi();
		try {
			const { run } = await api.imports.report({ siteId: params.siteId, runId: params.runId });
			if (run.importId !== params.importId) throw notFound();
			return { run, crumb: `#${run.number}` };
		} catch (error) {
			if (errorCode(error) === "IMPORT_RUN_NOT_FOUND" || errorCode(error) === "BAD_REQUEST") throw notFound();
			throw error;
		}
	},
	head: ({ match, loaderData }) => ({
		meta: [
			{
				title: pageTitleOf(
					match.context.shell.language.code,
					loaderData ? `${loaderData.run.importName} #${loaderData.run.number}` : undefined,
					match.context.site.name,
				),
			},
		],
	}),
	component: RunPage,
});

/** An Import run: its progress while it runs, then its Import report. */
function RunPage() {
	const { run } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	return <RunReportPage siteId={siteId} initial={run} />;
}
