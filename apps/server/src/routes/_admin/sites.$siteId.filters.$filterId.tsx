import { createFileRoute, notFound, useNavigate, useRouter } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { UploadIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { useAfterRender } from "../../ui/after-render.ts";
import { getApi } from "../../ui/api.ts";
import { errorCode, errorMessage } from "../../ui/errors.ts";
import { ControlsTab } from "../../ui/filters/ControlsTab.tsx";
import { FilterStatus } from "../../ui/filters/FilterStatus.tsx";
import { LayoutTab, placementName } from "../../ui/filters/LayoutTab.tsx";
import { changeOf, type FilterProblem, type FilterVersion, problemsOf, untranslated } from "../../ui/filters/model.ts";
import { Preview } from "../../ui/filters/Preview.tsx";
import { Segmented } from "../../ui/filters/Segmented.tsx";
import { SettingsTab } from "../../ui/filters/SettingsTab.tsx";
import { TranslationsTab } from "../../ui/filters/TranslationsTab.tsx";
import { pageTitleOf, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { SaveBar, type SaveState } from "../../ui/shell/page.tsx";
import { type TabSpec, Tabs } from "../../ui/Tabs.tsx";

/** The tab shown (`?tab=layout`) and the control selected (`?control=<id>`), so a link can open either. */
const search = z.object({
	tab: z.enum(["controls", "layout", "settings", "translations"]).optional().catch(undefined),
	control: z.string().max(32).optional().catch(undefined),
});

export const Route = createFileRoute("/_admin/sites/$siteId/filters/$filterId")({
	staticData: { width: "wide" },
	validateSearch: search,
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return { details: null, crumb: "" };
		const api = await getApi();
		try {
			const details = await api.filters.get({ siteId: params.siteId, filterId: params.filterId });
			return { details, crumb: details.filter.name };
		} catch (error) {
			if (errorCode(error) === "FILTER_NOT_FOUND" || errorCode(error) === "BAD_REQUEST") throw notFound();
			throw error;
		}
	},
	head: ({ match, loaderData }) => ({
		meta: [{ title: pageTitleOf(match.context.shell.language.code, loaderData?.crumb, match.context.site.name) }],
	}),
	component: FilterPage,
});

/**
 * One Filter in its builder (Structure, Staff only), as the approved design has it: its name, status
 * and the Loop it narrows, the Live / On submit switch, Save and Publish; then the Controls, Layout,
 * Settings and Translations tabs beside the live preview, which renders the Draft as it changes with
 * the Loop's published Entries and real counts. The Draft is kept in the browser until saved
 * (`filters.saveDraft`) and published (`filters.publish`, which Publish all also lists).
 */
function FilterPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const query = Route.useSearch();
	const { place } = Route.useRouteContext();
	const router = useRouter();
	const navigate = useNavigate({ from: Route.fullPath });
	const saved = data.details?.filter.draft ?? null;
	const [version, setDraft] = useState<FilterVersion | null>(saved);
	const [problems, setProblems] = useState<FilterProblem[]>([]);
	const [busy, setBusy] = useState(false);
	// How the last save went, for the foot bar: "Saved" until the next change, or why it failed.
	const [lastSave, setLastSave] = useState<"saved" | "failed" | null>(null);
	const [selected, setSelected] = useState<string | null>(query.control ?? saved?.controls[0]?.id ?? null);
	const [phoneWidth, setPhoneWidth] = useState<number | null>(null);
	const summary = useRef<HTMLDivElement>(null);
	const setVersion = (next: FilterVersion) => {
		setDraft(next);
		setLastSave((before) => (before === "failed" ? before : null));
	};
	const afterRender = useAfterRender();
	const changed = saved !== null && version !== null && JSON.stringify(version) !== JSON.stringify(saved);

	if (!data.details || !version || place.level !== "site") {
		return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	}
	const { filter, usage, sources } = data.details;
	const languages = place.languages;
	const markup = `{{@filter ${filter.name} for="${filter.loop}"}}`;

	const refused = (error: unknown) => {
		const found = problemsOf(error);
		if (found.length > 0) {
			setProblems(found);
			afterRender(() => summary.current?.focus());
		} else toast.error(t(errorMessage(error)));
	};

	const save = async (): Promise<boolean> => {
		setBusy(true);
		setProblems([]);
		try {
			const api = await getApi();
			const { filter: stored } = await api.filters.saveDraft({ siteId, filterId: filter.id, ...changeOf(version) });
			setDraft(stored.draft);
			await router.invalidate();
			setLastSave("saved");
			toast.success(t("filters.savedDraft"));
			return true;
		} catch (error) {
			setLastSave("failed");
			refused(error);
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
			await api.filters.publish({ siteId, filterId: filter.id });
			await router.invalidate();
			toast.success(t("filters.published", { name: filter.name }));
		} catch (error) {
			refused(error);
		} finally {
			setBusy(false);
		}
	};

	const index = version.controls.findIndex((control) => control.id === selected);
	const other = languages.all.find((code) => code !== languages.default);
	const missing = other ? untranslated(version, other) : 0;
	const tabs: TabSpec[] = [
		{
			id: "controls",
			label: t("filters.tabs.controls"),
			badge: String(version.controls.length),
			panel: (
				<ControlsTab
					version={version}
					onChange={setVersion}
					selected={selected}
					onSelect={setSelected}
					sources={sources}
					filterName={filter.name}
					loop={filter.loop}
					language={languages.default}
					problems={problems}
				/>
			),
		},
		{
			id: "layout",
			label: t("filters.tabs.layout"),
			panel: (
				<LayoutTab
					siteId={siteId}
					filterId={filter.id}
					version={version}
					onChange={setVersion}
					placements={usage.usedIn}
					phoneWidth={phoneWidth}
					markup={markup}
				/>
			),
		},
		{
			id: "settings",
			label: t("filters.tabs.settings"),
			panel: (
				<SettingsTab
					name={filter.name}
					loop={filter.loop}
					markup={markup}
					version={version}
					onChange={setVersion}
					language={languages.default}
					problems={problems}
				/>
			),
		},
		{
			id: "translations",
			label: t("filters.tabs.translations"),
			...(other && missing > 0 ? { badge: `${other.toUpperCase()} ${missing}` } : {}),
			panel: <TranslationsTab version={version} onChange={setVersion} languages={languages} />,
		},
	];

	const saveState: SaveState = busy
		? "saving"
		: changed
			? lastSave === "failed"
				? "failed"
				: "dirty"
			: lastSave === "saved"
				? "saved"
				: "clean";

	return (
		<div className="grid gap-6">
			<PageHeader
				heading={filter.name}
				badge={
					<>
						<FilterStatus status={filter.status} />
						<Badge variant="outline">{t("filters.structure")}</Badge>
					</>
				}
				action={
					<>
						<Segmented
							label={t("filters.mode.label")}
							value={version.mode}
							onChange={(mode) => setVersion({ ...version, mode })}
							options={[
								{ value: "live", label: t("filters.mode.live") },
								{ value: "submit", label: t("filters.mode.submit") },
							]}
						/>
						<Button onClick={() => void publish()} disabled={busy || (filter.status === "published" && !changed)}>
							<UploadIcon data-icon="inline-start" />
							{t("filters.publish")}
						</Button>
					</>
				}
			>
				<span className="text-sm">
					{t("filters.narrows")} <span className="font-mono">{filter.loop}</span>
					{usage.usedIn.length > 0
						? ` · ${t("filters.placedOn", { places: usage.usedIn.map((placement) => placementName(t, placement)).join(", ") })}`
						: ` · ${t("filters.notPlaced")}`}
					{" · "}
					<span className="font-mono">{markup}</span>
				</span>
			</PageHeader>
			<SaveBar
				state={saveState}
				onSave={() => void save()}
				onDiscard={() => {
					if (saved) setDraft(saved);
					setProblems([]);
					setLastSave(null);
				}}
			/>
			{problems.length > 0 ? (
				<div
					ref={summary}
					tabIndex={-1}
					role="alert"
					className="border-destructive/50 rounded-md border p-4 text-sm outline-none"
				>
					<p className="font-medium">{t("filters.problems")}</p>
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
				label={t("filters.tabsLabel", { name: filter.name })}
				tabs={tabs}
				initial={query.tab}
				onSelect={(tab) =>
					void navigate({
						search: (before) => ({ ...before, tab: tab as z.infer<typeof search>["tab"] }),
						replace: true,
					})
				}
				aside={
					<Preview
						siteId={siteId}
						filterId={filter.id}
						filterName={filter.name}
						version={version}
						selected={index}
						onSelect={(at) => {
							const control = version.controls[at];
							if (control) setSelected(control.id);
						}}
						onShown={(previewed) => setPhoneWidth(previewed.phoneWidth)}
						languages={languages}
					/>
				}
			/>
		</div>
	);
}
