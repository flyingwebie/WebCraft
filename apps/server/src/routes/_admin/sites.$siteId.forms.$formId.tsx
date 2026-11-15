import { createFileRoute, Link, notFound, useNavigate, useRouter } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import { HammerIcon, InboxIcon, LanguagesIcon, MailIcon, SaveIcon, SettingsIcon, UploadIcon } from "lucide-react";
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
import { HistoryLink } from "../../ui/history/HistoryLink.tsx";
import { pageTitleOf, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { type TabSpec, Tabs } from "../../ui/Tabs.tsx";

/** The tab shown (`?tab=emails`), and the Submission open on the Submissions tab (a Notification links to it). */
const search = z.object({
	tab: z.enum(["submissions", "emails", "build", "settings", "translations"]).optional().catch(undefined),
	submission: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_admin/sites/$siteId/forms/$formId")({
	staticData: { width: "wide" },
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
 * One Form, in the admin shell (frames 01 to 03): its name as the page header, then a tab strip with
 * icons. Clients (Owners and Editors) have Submissions (the Forms Module's mailbox: its inbox and Spam
 * folder, with the Form's count of new ones) and Emails (its Notifications and Auto-reply, Content
 * with a Draft of their own, whose state and Publish emails sit in the header while the tab shows).
 * Staff have those too, and Build (its fields), Settings (its name and key, button, what happens once
 * it is sent, spam limits) and Translations, Structure kept in the browser until saved to the Form's
 * Draft and published: on those tabs the header says its status, where it is placed, and holds Save
 * draft and Publish.
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
	// Where the page header holds the emails' state and Publish emails while their tab shows.
	const [emailsSlot, setEmailsSlot] = useState<HTMLElement | null>(null);
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
	// The tab that shows: the address's, else the first the person has (Submissions for one opened from a link).
	const offered = [
		...(readsSubmissions ? ["submissions"] : []),
		...(changesEmails ? ["emails"] : []),
		...(staff ? ["build", "settings", "translations"] : []),
	];
	const asked = query.tab ?? (query.submission ? "submissions" : undefined);
	const current = asked && offered.includes(asked) ? asked : offered[0];

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
	// How many of its Submissions nobody has opened yet, as the sidebar's row says it.
	const newSubmissions = place.forms.find((each) => each.id === form.id)?.newSubmissions ?? 0;

	const tabs: TabSpec[] = [];
	if (readsSubmissions) {
		tabs.push({
			id: "submissions",
			label: t("forms.tabs.submissions"),
			icon: InboxIcon,
			badge: newSubmissions > 0 ? String(newSubmissions) : undefined,
			panel: (
				<SubmissionsTab
					siteId={siteId}
					formId={form.id}
					fields={(form.published ?? form.draft).fields}
					languages={languages.all}
					defaultLanguage={languages.default}
					canManage={place.modulePermissions.includes("forms.submissions.manage")}
					canResend={staff}
					placedOn={placedOn}
					initialSubmission={query.submission}
					onSelect={(submission) =>
						void navigate({ search: (before) => ({ ...before, submission: submission ?? undefined }), replace: true })
					}
					onCountsChanged={() => void router.invalidate()}
				/>
			),
		});
	}
	if (changesEmails) {
		tabs.push({
			id: "emails",
			label: t("forms.tabs.emails"),
			icon: MailIcon,
			panel: (
				<EmailsTab
					siteId={siteId}
					siteName={place.site.name}
					form={form}
					fields={version.fields}
					languages={languages}
					onSaved={() => router.invalidate()}
					active={current === "emails"}
					actionsSlot={emailsSlot}
				/>
			),
		});
	}
	if (staff) {
		tabs.push(
			{
				id: "build",
				label: t("forms.tabs.build"),
				icon: HammerIcon,
				panel: <BuildTab version={version} onChange={setVersion} problems={problems} />,
			},
			{
				id: "settings",
				label: t("forms.tabs.settings"),
				icon: SettingsIcon,
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
				icon: LanguagesIcon,
				panel: <TranslationsTab version={version} onChange={setVersion} languages={languages} />,
			},
		);
	}
	const structureTab = current === "build" || current === "settings" || current === "translations";

	return (
		<div className="grid">
			<PageHeader
				heading={form.name}
				badge={
					structureTab ? (
						<>
							<StatusBadge status={form.status} />
							{changed ? <Badge variant="outline">{t("forms.unsaved")}</Badge> : null}
						</>
					) : null
				}
				action={
					<>
						<span ref={setEmailsSlot} className="contents" />
						{structureTab ? (
							<>
								{/* The Forms place builds the Form (SPEC 15.1, BA-27): Build, Settings and Translations there. */}
								<Link
									to="/sites/$siteId/build"
									params={{ siteId }}
									search={{ open: `/form/${form.id}`, returnTo: `/sites/${siteId}/forms/${form.id}?tab=${current}` }}
									className={buttonVariants({ variant: "outline" })}
									data-building-area=""
								>
									<HammerIcon data-icon="inline-start" />
									{t("buildingArea.documents.openIn")}
								</Link>
								<HistoryLink siteId={siteId} item={{ kind: "form", id: form.id }} />
								<Button variant="outline" onClick={() => void save()} disabled={busy || !changed}>
									<SaveIcon data-icon="inline-start" />
									{t("forms.saveDraft")}
								</Button>
								<Button onClick={() => void publish()} disabled={busy || (form.status === "published" && !changed)}>
									<UploadIcon data-icon="inline-start" />
									{t("forms.publish")}
								</Button>
							</>
						) : null}
					</>
				}
			>
				{structureTab ? (
					<>
						<span className="font-mono text-sm">{`{{@form ${form.key}}}`}</span>
						{" · "}
						{placedOn.length > 0 ? t("forms.placedOn", { places: placedOn.join(", ") }) : t("forms.notPlaced")}
					</>
				) : null}
			</PageHeader>
			{problems.length > 0 && structureTab ? (
				<div role="alert" className="border-destructive/50 mb-6 rounded-md border p-4 text-sm">
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
				initial={current}
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
