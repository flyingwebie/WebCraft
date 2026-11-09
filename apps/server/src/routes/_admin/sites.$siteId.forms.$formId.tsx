import { createFileRoute, notFound, useNavigate, useRouter } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { SaveIcon, UploadIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { errorCode, errorMessage } from "../../ui/errors.ts";
import { BuildTab } from "../../ui/forms/BuildTab.tsx";
import { EmailsTab } from "../../ui/forms/EmailsTab.tsx";
import { changeOf, type FormProblem, type FormVersion, problemsOf } from "../../ui/forms/model.ts";
import { SettingsTab } from "../../ui/forms/SettingsTab.tsx";
import { StatusBadge } from "../../ui/forms/StatusBadge.tsx";
import { SubmissionsTab } from "../../ui/forms/SubmissionsTab.tsx";
import { TranslationsTab } from "../../ui/forms/TranslationsTab.tsx";
import { pageTitleOf, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";
import { type TabSpec, Tabs } from "../../ui/Tabs.tsx";

/** The tab shown (`?tab=emails`), and the Submission open on the Submissions tab (a Notification links to it). */
const search = z.object({
	tab: z.enum(["submissions", "emails", "build", "settings", "translations"]).optional().catch(undefined),
	submission: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_admin/sites/$siteId/forms/$formId")({
	staticData: { wide: true },
	validateSearch: search,
	loader: async ({ context, params }) => {
		const permissions = context.place.permissions;
		const staff = permissions.includes("structure.edit");
		if (!staff && !permissions.includes("formEmails.edit")) {
			return { form: null, usage: { usedIn: [] }, pages: [], crumb: "" };
		}
		const api = await getApi();
		try {
			const { form, usage } = await api.forms.get({ siteId: params.siteId, formId: params.formId });
			// The Pages a Form may send visitors to once sent: only Staff choose (Settings).
			let pages: { id: string; title: string; path: string | null }[] = [];
			if (staff) {
				const { postTypes } = await api.postTypes.list({ siteId: params.siteId });
				const pagesType = postTypes.find((postType) => postType.builtIn === "page");
				pages = pagesType
					? (await api.entries.list({ siteId: params.siteId, postTypeId: pagesType.id })).entries.map((entry) => ({
							id: entry.id,
							title: (entry.published ?? entry.draft).title,
							path: entry.path,
						}))
					: [];
			}
			return { form, usage, pages, crumb: form.name };
		} catch (error) {
			if (errorCode(error) === "FORM_NOT_FOUND" || errorCode(error) === "BAD_REQUEST") throw notFound();
			throw error;
		}
	},
	head: ({ match, loaderData }) => ({
		meta: [{ title: pageTitleOf(match.context.shell.language.code, loaderData?.crumb, match.context.site.name) }],
	}),
	component: FormPage,
});

/**
 * One Form, in the admin shell: its name and status, where it is placed, and its tabs. Clients
 * (Owners and Editors) have Submissions (the Forms Module's: its inbox and Spam folder) and Emails
 * (its Notifications and Auto-reply, Content with a Draft of their own). Staff have those too, and
 * Build (its fields), Settings (its name and key, button, what happens once it is sent, spam limits)
 * and Translations, Structure kept in the browser until saved to the Form's Draft and published.
 */
function FormPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const query = Route.useSearch();
	const { place } = Route.useRouteContext();
	const router = useRouter();
	const navigate = useNavigate({ from: Route.fullPath });
	const saved = data.form?.draft ?? null;
	const [version, setVersion] = useState<FormVersion | null>(saved);
	const [problems, setProblems] = useState<FormProblem[]>([]);
	const [busy, setBusy] = useState(false);
	const changed = saved !== null && version !== null && JSON.stringify(version) !== JSON.stringify(saved);

	useEffect(() => {
		if (!changed) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [changed]);

	if (!data.form || !version || place.level !== "site") {
		return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	}
	const form = data.form;
	const languages = place.languages;
	const staff = place.permissions.includes("structure.edit");
	const readsSubmissions = place.modulePermissions.includes("forms.submissions.view");
	const changesEmails = place.permissions.includes("formEmails.edit");

	const save = async (): Promise<boolean> => {
		setBusy(true);
		setProblems([]);
		try {
			const api = await getApi();
			const { form: stored } = await api.forms.saveDraft({ siteId, formId: form.id, form: changeOf(version) });
			setVersion(stored.draft);
			await router.invalidate();
			toast.success(t("forms.savedDraft"));
			return true;
		} catch (error) {
			const found = problemsOf(error);
			if (found.length > 0) setProblems(found);
			else toast.error(t(errorMessage(error)));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const publish = async () => {
		if (changed && !(await save())) return;
		setBusy(true);
		try {
			const api = await getApi();
			await api.forms.publish({ siteId, formId: form.id });
			await router.invalidate();
			toast.success(t("forms.published", { name: form.name }));
		} catch (error) {
			const found = problemsOf(error);
			if (found.length > 0) setProblems(found);
			else toast.error(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};

	const placedOn = data.usage.usedIn.map((placement) =>
		placement.kind === "siteTemplate"
			? t("forms.placedOnSiteTemplate")
			: placement.kind === "entryTemplate"
				? t("forms.placedOnEntryTemplate", { name: placement.name ?? "" })
				: placement.kind === "archiveTemplate"
					? t("forms.placedOnArchiveTemplate", { name: placement.name ?? "" })
					: t("forms.placedOnComponent", { name: placement.name ?? "" }),
	);

	const tabs: TabSpec[] = [];
	if (readsSubmissions) {
		tabs.push({
			id: "submissions",
			label: t("forms.tabs.submissions"),
			panel: (
				<SubmissionsTab
					siteId={siteId}
					formId={form.id}
					fields={(form.published ?? form.draft).fields}
					languages={languages.all}
					defaultLanguage={languages.default}
					canManage={place.modulePermissions.includes("forms.submissions.manage")}
					initialSubmission={query.submission}
					onSelect={(submission) =>
						void navigate({ search: (before) => ({ ...before, submission: submission ?? undefined }), replace: true })
					}
				/>
			),
		});
	}
	if (changesEmails) {
		tabs.push({
			id: "emails",
			label: t("forms.tabs.emails"),
			panel: (
				<EmailsTab
					siteId={siteId}
					siteName={place.site.name}
					form={form}
					fields={version.fields}
					languages={languages}
					onSaved={() => router.invalidate()}
				/>
			),
		});
	}
	if (staff) {
		tabs.push(
			{
				id: "build",
				label: t("forms.tabs.build"),
				panel: <BuildTab version={version} onChange={setVersion} problems={problems} />,
			},
			{
				id: "settings",
				label: t("forms.tabs.settings"),
				panel: (
					<SettingsTab
						siteId={siteId}
						form={form}
						version={version}
						onChange={setVersion}
						pages={data.pages}
						problems={problems}
					/>
				),
			},
			{
				id: "translations",
				label: t("forms.tabs.translations"),
				panel: <TranslationsTab version={version} onChange={setVersion} languages={languages} />,
			},
		);
	}

	return (
		<div className="grid gap-6">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<h1 className="text-2xl font-semibold tracking-tight">{form.name}</h1>
						{staff ? (
							<>
								<StatusBadge status={form.status} />
								<Badge variant="outline">{t("forms.structure")}</Badge>
								{changed ? <Badge variant="outline">{t("forms.unsaved")}</Badge> : null}
							</>
						) : null}
					</div>
					<p className="text-muted-foreground text-sm">
						{staff ? (
							<>
								<span className="font-mono">{`{{@form ${form.key}}}`}</span>
								{" · "}
							</>
						) : null}
						{placedOn.length > 0 ? t("forms.placedOn", { places: placedOn.join(", ") }) : t("forms.notPlaced")}
					</p>
				</div>
				{staff ? (
					<div className="flex flex-wrap gap-2">
						<Button variant="outline" onClick={() => void save()} disabled={busy || !changed}>
							<SaveIcon data-icon="inline-start" />
							{t("forms.saveDraft")}
						</Button>
						<Button onClick={() => void publish()} disabled={busy || (form.status === "published" && !changed)}>
							<UploadIcon data-icon="inline-start" />
							{t("forms.publish")}
						</Button>
					</div>
				) : null}
			</div>
			{problems.length > 0 ? (
				<div role="alert" className="border-destructive/50 rounded-md border p-4 text-sm">
					<p className="font-medium">{t("forms.problems")}</p>
					<ul className="mt-2 list-disc ps-5">
						{problems.map((problem) => (
							<li key={`${problem.at}-${problem.message}`}>
								<span className="font-mono">{problem.at}</span>: {problem.message}
							</li>
						))}
					</ul>
				</div>
			) : null}
			<Tabs
				label={t("forms.tabsLabel", { name: form.name })}
				tabs={tabs}
				initial={query.tab ?? (query.submission ? "submissions" : undefined)}
				onSelect={(tab) =>
					void navigate({
						search: (before) => ({ ...before, tab: tab as z.infer<typeof search>["tab"] }),
						replace: true,
					})
				}
			/>
		</div>
	);
}
