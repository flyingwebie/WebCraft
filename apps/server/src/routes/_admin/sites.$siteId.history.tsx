import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { errorCode } from "../../ui/errors.ts";
import { HistoryScreen } from "../../ui/history/HistoryScreen.tsx";
import { readCopyParam, readItem } from "../../ui/history/model.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";

/**
 * The item whose history is shown (its kind, and its id when a Site has many of its kind), the copy
 * compared with the Draft (`revision:<id>` or `checkpoint:<id>`; the newest when none is given), the
 * language compared and whether parts that don't differ are shown too.
 */
const search = z.object({
	item: z.string().max(20).optional().catch(undefined),
	itemId: z.string().max(64).optional().catch(undefined),
	copy: z.string().max(80).optional().catch(undefined),
	language: z.string().min(2).max(35).optional().catch(undefined),
	all: z.boolean().optional().catch(undefined),
});

/** Refusals that mean the item, or the copy asked for, isn't there for this person. */
const NOT_THERE = [
	"ENTRY_NOT_FOUND",
	"TEMPLATE_NOT_FOUND",
	"COMPONENT_NOT_FOUND",
	"LOOP_NOT_FOUND",
	"FILTER_NOT_FOUND",
	"FORM_NOT_FOUND",
	"SCRIPT_NOT_FOUND",
	"BAD_REQUEST",
];

export const Route = createFileRoute("/_admin/sites/$siteId/history")({
	staticData: { crumb: "history.pageTitle", wide: true },
	validateSearch: search,
	loaderDeps: ({ search: { item, itemId, copy, language } }) => ({ item, itemId, copy, language }),
	loader: async ({ params, deps }) => {
		const item = readItem(deps);
		if (!item) throw notFound();
		const api = await getApi();
		const { siteId } = params;
		try {
			const page = await api.history.list({ siteId, item });
			const chosen = readCopyParam(deps.copy) ?? page.copies[0] ?? null;
			const comparison = chosen
				? await api.history
						.compare({ siteId, item, copy: { type: chosen.type, id: chosen.id }, language: deps.language })
						.catch((error: unknown) => {
							if (errorCode(error) === "REVISION_NOT_FOUND" || errorCode(error) === "CHECKPOINT_NOT_FOUND") return null;
							throw error;
						})
				: null;
			return { item, page, comparison, forbidden: false as const };
		} catch (error) {
			if (errorCode(error) === "FORBIDDEN") return { item, page: null, comparison: null, forbidden: true as const };
			if (NOT_THERE.includes(errorCode(error) ?? "")) throw notFound();
			throw error;
		}
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "history.pageTitle") }] }),
	component: HistoryPage,
});

/** Site › an item's history: its Revisions and Checkpoints, Compare and Restore. */
function HistoryPage() {
	const t = useT();
	const { item, page, comparison, forbidden } = Route.useLoaderData();
	const { all } = Route.useSearch();
	const { siteId } = Route.useParams();
	if (forbidden || !page) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<HistoryScreen
			// Another item, or another copy, starts the screen again.
			key={`${item.kind}:${"id" in item ? item.id : ""}`}
			siteId={siteId}
			item={item}
			page={page}
			comparison={comparison}
			showAll={all === true}
		/>
	);
}
