import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@webcraft/ui/components/tabs.tsx";
import { SaveIcon, UploadIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorCode, errorMessage } from "../../ui/errors.ts";
import { BuildTab } from "../../ui/forms/BuildTab.tsx";
import { changeOf, type FormProblem, type FormVersion, problemsOf } from "../../ui/forms/model.ts";
import { SettingsTab } from "../../ui/forms/SettingsTab.tsx";
import { StatusBadge } from "../../ui/forms/StatusBadge.tsx";
import { TranslationsTab } from "../../ui/forms/TranslationsTab.tsx";
import { pageTitleOf, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/forms/$formId")({
	staticData: { wide: true },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) {
			return { form: null, usage: { usedIn: [] }, pages: [], crumb: "" };
		}
		const api = await getApi();
		try {
			const [{ form, usage }, { postTypes }] = await Promise.all([
				api.forms.get({ siteId: params.siteId, formId: params.formId }),
				api.postTypes.list({ siteId: params.siteId }),
			]);
			const pagesType = postTypes.find((postType) => postType.builtIn === "page");
			const pages = pagesType
				? (await api.entries.list({ siteId: params.siteId, postTypeId: pagesType.id })).entries.map((entry) => ({
						id: entry.id,
						title: (entry.published ?? entry.draft).title,
						path: entry.path,
					}))
				: [];
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
 * One Form (Structure, Staff only), in the admin shell: its name and status, where it is placed, and
 * its tabs. Build arranges its fields and their settings; Settings holds its name and key, its
 * button, what happens once it is sent and its spam limits; Translations gives every text its value
 * in the Site's other languages. Changes stay in the browser until saved to the Draft; publishing
 * makes the Draft what visitors fill in. (Submissions and Emails, for clients, come next to them.)
 */
function FormPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	const router = useRouter();
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

	if (!data.form || !version) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	const form = data.form;
	const languages = place.level === "site" ? place.languages : { default: "en", all: ["en"] };

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
				: t("forms.placedOnComponent", { name: placement.name ?? "" }),
	);

	return (
		<div className="grid gap-6">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<h1 className="text-2xl font-semibold tracking-tight">{form.name}</h1>
						<StatusBadge status={form.status} />
						<Badge variant="outline">{t("forms.structure")}</Badge>
						{changed ? <Badge variant="outline">{t("forms.unsaved")}</Badge> : null}
					</div>
					<p className="text-muted-foreground text-sm">
						<span className="font-mono">{`{{@form ${form.key}}}`}</span>
						{" · "}
						{placedOn.length > 0 ? t("forms.placedOn", { places: placedOn.join(", ") }) : t("forms.notPlaced")}
					</p>
				</div>
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
			<Tabs defaultValue="build">
				<TabsList variant="line">
					<TabsTrigger value="build">{t("forms.tabs.build")}</TabsTrigger>
					<TabsTrigger value="settings">{t("forms.tabs.settings")}</TabsTrigger>
					<TabsTrigger value="translations">{t("forms.tabs.translations")}</TabsTrigger>
				</TabsList>
				<TabsContent value="build" className="pt-4">
					<BuildTab version={version} onChange={setVersion} problems={problems} />
				</TabsContent>
				<TabsContent value="settings" className="pt-4">
					<SettingsTab
						siteId={siteId}
						form={form}
						version={version}
						onChange={setVersion}
						pages={data.pages}
						problems={problems}
					/>
				</TabsContent>
				<TabsContent value="translations" className="pt-4">
					<TranslationsTab version={version} onChange={setVersion} languages={languages} />
				</TabsContent>
			</Tabs>
		</div>
	);
}
