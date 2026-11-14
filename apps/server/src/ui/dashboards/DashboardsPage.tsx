import { Link, useRouter } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { PlusIcon, TrashIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";
import type { DashboardPlace, DashboardSummary, TemplateView } from "./model.ts";
import { NewDashboardDialog } from "./NewDashboardDialog.tsx";

/** What a Dashboards page shows: the Dashboards the person sees, and the templates they may start from. */
export type DashboardsData = { dashboards: DashboardSummary[]; templates: TemplateView[] | null; canManage: boolean };

/** Loads a Site's or Workspace's Dashboards (and, for Staff, the Dashboard templates they may use). */
export async function dashboardsData(place: DashboardPlace, canManage: boolean): Promise<DashboardsData> {
	const api = await getApi();
	const [{ dashboards }, templates] = await Promise.all([
		api.dashboards.list(place),
		canManage ? api.dashboardTemplates.list().then((answer) => answer.templates) : Promise.resolve(null),
	]);
	return { dashboards, templates, canManage };
}

/**
 * Site › Dashboards (or Workspace › Dashboards): the Dashboards the person sees, each with how many
 * Widgets it has and who sees it; for Staff, New Dashboard (empty, or from a Dashboard template) and
 * the templates of the Workspaces where they build Dashboards.
 */
export function DashboardsPage({ place, data }: { place: DashboardPlace; data: DashboardsData }) {
	const t = useT();
	const newButton = useRef<HTMLButtonElement>(null);
	const [creating, setCreating] = useState(false);
	const isWorkspace = "workspaceId" in place;
	return (
		<>
			<PageHeader
				heading={t(isWorkspace ? "dashboards.workspaceHeading" : "dashboards.heading")}
				action={
					data.canManage ? (
						<Button ref={newButton} onClick={() => setCreating(true)}>
							<PlusIcon aria-hidden="true" />
							{t("dashboards.new")}
						</Button>
					) : null
				}
			>
				{t(isWorkspace ? "dashboards.introWorkspace" : "dashboards.introSite")}
			</PageHeader>
			<div className="grid max-w-5xl gap-8">
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("dashboards.listTitle")}</h2>
						</CardTitle>
					</CardHeader>
					<CardContent>
						{data.dashboards.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								{t(data.canManage ? "dashboards.none" : "dashboards.noneShown")}
							</p>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t("dashboards.name")}</TableHead>
										<TableHead className="text-end">{t("dashboards.widgetsCount")}</TableHead>
										<TableHead>{t("dashboards.shownTo")}</TableHead>
										<TableHead>{t("dashboards.updated")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.dashboards.map((dashboard) => (
										<TableRow key={dashboard.id}>
											<TableCell className="font-medium">
												{isWorkspace ? (
													<Link
														to="/workspaces/$workspaceId/dashboards/$dashboardId"
														params={{ workspaceId: place.workspaceId, dashboardId: dashboard.id }}
														className="underline-offset-4 hover:underline"
													>
														{dashboard.name}
													</Link>
												) : (
													<Link
														to="/sites/$siteId/dashboards/$dashboardId"
														params={{ siteId: place.siteId, dashboardId: dashboard.id }}
														className="underline-offset-4 hover:underline"
													>
														{dashboard.name}
													</Link>
												)}
											</TableCell>
											<TableCell className="text-end tabular-nums">{dashboard.widgets}</TableCell>
											<TableCell>
												<Badge variant={dashboard.sharedWithEveryone ? "secondary" : "outline"}>
													{t(dashboard.sharedWithEveryone ? "dashboards.shownEveryone" : "dashboards.shownViewers")}
												</Badge>
											</TableCell>
											<TableCell className="text-muted-foreground text-sm">{formatUtc(dashboard.updatedAt)}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>
				{data.templates ? <Templates templates={data.templates} /> : null}
			</div>
			{creating ? <NewDashboardDialog place={place} onClose={() => setCreating(false)} finalFocus={newButton} /> : null}
		</>
	);
}

function Templates({ templates }: { templates: TemplateView[] }) {
	const t = useT();
	const router = useRouter();
	const remove = async (template: TemplateView) => {
		try {
			await (await getApi()).dashboardTemplates.delete({ workspaceId: template.workspaceId, templateId: template.id });
			toast.success(t("dashboards.templateDeletedToast"));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("dashboards.templatesTitle")}</h2>
				</CardTitle>
				<CardDescription>{t("dashboards.templatesIntro")}</CardDescription>
			</CardHeader>
			<CardContent>
				{templates.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t("dashboards.templatesNone")}</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t("dashboards.name")}</TableHead>
								<TableHead>{t("dashboards.workspace")}</TableHead>
								<TableHead>{t("dashboards.madeFrom")}</TableHead>
								<TableHead className="text-end">{t("dashboards.widgetsCount")}</TableHead>
								<TableHead>
									<span className="sr-only">{t("dashboards.actions")}</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{templates.map((template) => (
								<TableRow key={template.id}>
									<TableCell className="font-medium">{template.name}</TableCell>
									<TableCell>{template.workspace}</TableCell>
									<TableCell>{template.madeFrom}</TableCell>
									<TableCell className="text-end tabular-nums">{template.widgets}</TableCell>
									<TableCell className="text-end">
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={t("dashboards.deleteTemplateFor", { name: template.name })}
											onClick={() => remove(template)}
										>
											<TrashIcon aria-hidden="true" />
										</Button>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}
