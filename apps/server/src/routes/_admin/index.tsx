import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "@webcraft/ui/components/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@webcraft/ui/components/card.tsx";
import { ChevronRightIcon, MailIcon, SettingsIcon, ShieldCheckIcon } from "lucide-react";

import { pageTitle, useT } from "../../ui/i18n.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { roleLabel } from "../../ui/shell/context.ts";

export const Route = createFileRoute("/_admin/")({
	staticData: { crumb: "overview.pageTitle" },
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "overview.pageTitle") }] }),
	component: OverviewPage,
});

/** The Install level's first page. */
function OverviewPage() {
	const t = useT();
	const { shell, person } = Route.useRouteContext();
	const canManage = shell.permissions.includes("install.manage");
	const role = t(roleLabel(person.installRole));
	return (
		<>
			<PageHeader heading={t("overview.heading")}>
				{t("overview.intro", { name: shell.install.name ?? t("app.name"), role })}
			</PageHeader>
			<div className="grid gap-6">
				{canManage && shell.setup.stage === "continue" ? (
					<Card>
						<CardHeader>
							<CardTitle>
								<h2>{t("overview.setupUnfinished.heading")}</h2>
							</CardTitle>
							<CardDescription>{t("overview.setupUnfinished.body")}</CardDescription>
						</CardHeader>
						<CardFooter>
							<Link to="/setup" className={buttonVariants()}>
								{t("overview.setupUnfinished.action")}
							</Link>
						</CardFooter>
					</Card>
				) : null}
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("overview.nextSteps.heading")}</h2>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<ul className="divide-y">
							{shell.twoFactor?.on ? null : (
								<li>
									<Link
										to="/account"
										hash="two-factor"
										className="flex items-center gap-3 rounded-md py-3 hover:underline"
									>
										<ShieldCheckIcon className="text-muted-foreground size-4" aria-hidden="true" />
										<span className="flex-1">{t("overview.nextSteps.twoFactor")}</span>
										<ChevronRightIcon className="size-4 rtl:rotate-180" aria-hidden="true" />
									</Link>
								</li>
							)}
							{canManage ? (
								<li>
									<Link to="/settings/general" className="flex items-center gap-3 rounded-md py-3 hover:underline">
										<SettingsIcon className="text-muted-foreground size-4" aria-hidden="true" />
										<span className="flex-1">{t("overview.nextSteps.general")}</span>
										<ChevronRightIcon className="size-4 rtl:rotate-180" aria-hidden="true" />
									</Link>
								</li>
							) : null}
							{canManage ? (
								<li>
									<Link to="/settings/email" className="flex items-center gap-3 rounded-md py-3 hover:underline">
										<MailIcon className="text-muted-foreground size-4" aria-hidden="true" />
										<span className="flex-1">{t("overview.nextSteps.email")}</span>
										<ChevronRightIcon className="size-4 rtl:rotate-180" aria-hidden="true" />
									</Link>
								</li>
							) : null}
						</ul>
					</CardContent>
				</Card>
			</div>
		</>
	);
}
