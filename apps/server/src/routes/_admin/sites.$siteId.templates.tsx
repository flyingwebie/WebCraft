import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "@webcraft/ui/components/button.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { LayoutTemplateIcon } from "lucide-react";

import { getApi } from "../../ui/api.ts";
import { StatusBadge } from "../../ui/content/DraftParts.tsx";
import { HistoryLink } from "../../ui/history/HistoryLink.tsx";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

/**
 * Site › Templates (Structure, Staff only): every Template the Site can have, made or not, each
 * opened in the visual builder. Pages have none: they are arranged with Page layouts.
 */
export const Route = createFileRoute("/_admin/sites/$siteId/templates")({
	staticData: { crumb: "templates.pageTitle" },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return { templates: null };
		const api = await getApi();
		return { templates: (await api.templates.list({ siteId: params.siteId })).templates };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "templates.pageTitle") }] }),
	component: TemplatesPage,
});

function TemplatesPage() {
	const t = useT();
	const { templates } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	if (!templates) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("templates.pageTitle")}>{t("templates.intro")}</PageHeader>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>{t("templates.columns.template")}</TableHead>
						<TableHead>{t("templates.columns.status")}</TableHead>
						<TableHead>
							<span className="sr-only">{t("templates.columns.open")}</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{templates.map((row) => {
						const name =
							row.kind === "site"
								? t("builder.kinds.siteTemplate")
								: row.kind === "search"
									? t("builder.kinds.searchTemplate")
									: t(`builder.titles.${row.kind === "entry" ? "entryTemplate" : "archiveTemplate"}`, {
											postType: row.postType?.name ?? "",
										});
						const splat =
							row.kind === "site"
								? "site-template"
								: row.kind === "search"
									? "search-template"
									: `${row.kind}-template/${row.postType?.id ?? ""}`;
						return (
							<TableRow key={`${row.kind}-${row.postType?.id ?? ""}`}>
								<TableCell>
									<span className="flex items-center gap-2 font-medium">
										<LayoutTemplateIcon className="text-muted-foreground size-4" aria-hidden="true" />
										{name}
									</span>
								</TableCell>
								<TableCell>
									{row.template ? (
										<StatusBadge status={row.template.status} />
									) : (
										<span className="text-muted-foreground">
											{row.unavailable ? t("templates.noAddress") : t("templates.notMade")}
										</span>
									)}
								</TableCell>
								<TableCell className="text-end">
									{row.unavailable ? null : (
										<span className="inline-flex flex-wrap justify-end gap-2">
											{row.template ? (
												<HistoryLink
													siteId={siteId}
													item={{ kind: "template", id: row.template.id }}
													name={name}
													size="sm"
												/>
											) : null}
											<Link
												to="/builder/$siteId/$"
												params={{ siteId, _splat: splat }}
												className={buttonVariants({ variant: "outline", size: "sm" })}
											>
												{t("templates.open")}
												<span className="sr-only">{t("templates.openNamed", { name })}</span>
											</Link>
										</span>
									)}
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</>
	);
}
