import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { SiteSmtpForm, type SiteSmtpView } from "../../ui/email/SiteSmtpForm.tsx";
import { formatUtc } from "../../ui/format.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/email")({
	staticData: { crumb: "siteEmail.pageTitle" },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return null;
		const api = await getApi();
		return api.siteSmtp.get({ siteId: params.siteId });
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "siteEmail.pageTitle") }],
	}),
	component: SiteEmailPage,
});

/**
 * Site › Email (SMTP) (Site settings, Staff): which server sends the Site's mail (its Notifications
 * and Auto-replies), its sender, and a test email. Saved at once, never part of Publish all.
 */
function SiteEmailPage() {
	const t = useT();
	const view = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { person } = Route.useRouteContext();
	const router = useRouter();
	// A new form after each save, so it starts from what was saved.
	const [version, setVersion] = useState(0);
	if (!view) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("siteEmail.heading")}>{t("siteEmail.intro")}</PageHeader>
			<div className="grid gap-6">
				<FailingNotice health={view.health} />
				<SiteSmtpForm
					key={version}
					siteId={siteId}
					view={view}
					testTo={person.email}
					onSaved={async (_saved: SiteSmtpView) => {
						toast.success(t("emailSettings.saved"));
						await router.invalidate();
						setVersion((current) => current + 1);
					}}
				/>
			</div>
		</>
	);
}

/** Said at the top while the Site's own server is Failing: its mail waits and retries, never sent another way. */
function FailingNotice({ health }: { health: SiteSmtpView["health"] }) {
	const t = useT();
	if (health.state !== "failing") return null;
	return (
		<div className="border-destructive/60 bg-card flex items-start gap-3 rounded-lg border px-4 py-3">
			<CircleAlertIcon className="text-destructive mt-0.5 size-5 shrink-0" aria-hidden="true" />
			<div className="min-w-0 space-y-1">
				<h2 className="font-semibold">{t("siteEmail.failingTitle")}</h2>
				<p className="text-sm">
					{t("emailSettings.status.failingBody", {
						count: health.failuresInARow,
						since: health.failingSince ? formatUtc(health.failingSince) : "",
					})}
				</p>
				{health.lastResponse ? (
					<p className="text-sm break-words">
						{t("emailSettings.status.lastResponse", { response: health.lastResponse })}
					</p>
				) : null}
			</div>
		</div>
	);
}
