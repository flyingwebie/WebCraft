import { createFileRoute } from "@tanstack/react-router";
import { isEditPath } from "@webcraft/core/edit-paths";
import { useEffect, useState } from "react";
import { z } from "zod";
import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";

/**
 * Where a Staging address's "Sign in" link goes: once the person is signed in (the admin's sign-in
 * page brings them back here), the admin asks for a single-use link to the Staging address at the
 * page they wanted, and goes there. Someone who doesn't see the Site is told so.
 */
export const Route = createFileRoute("/_admin/staging/$siteId")({
	validateSearch: z.object({
		path: z.string().max(2000).refine(isEditPath).optional().catch(undefined),
	}),
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "staging.pageTitle") }] }),
	component: OpenStaging,
});

function OpenStaging() {
	const t = useT();
	const { siteId } = Route.useParams();
	const { path } = Route.useSearch();
	const [problem, setProblem] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const api = await getApi();
				const { url } = await api.staging.open({ siteId, path: path ?? "/" });
				if (!cancelled) window.location.replace(url);
			} catch (error) {
				if (!cancelled) setProblem(t(errorMessage(error)));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [siteId, path, t]);
	return (
		<div className="grid gap-4">
			<PageHeader heading={t("staging.pageTitle")} />
			{problem ? (
				<p role="alert" className="text-destructive text-sm">
					{problem}
				</p>
			) : (
				<p role="status" className="text-muted-foreground text-sm">
					{t("staging.opening")}
				</p>
			)}
		</div>
	);
}
