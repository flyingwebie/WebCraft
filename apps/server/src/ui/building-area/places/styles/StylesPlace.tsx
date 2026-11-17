import {
	CheckIcon,
	FileCodeIcon,
	LoaderCircleIcon,
	MonitorSmartphoneIcon,
	SwatchBookIcon,
	TagIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
	type DesignSystemApi,
	type DesignSystemClient,
	useDesignSystemEditing,
} from "../../../design-system/editing.ts";
import type { DesignSystemView, Preview } from "../../../design-system/model.ts";
import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING, type Icon } from "../../controls.tsx";
import { managementApi } from "../../management.ts";
import { usePublishSources } from "../../publish/sources.ts";
import { rememberPlace } from "../memory.ts";
import { Place } from "../Place.tsx";
import type { PlaceProps } from "../registry.ts";
import { BreakpointsTab } from "./BreakpointsTab.tsx";
import { followBreakpoints, showDraftStyles } from "./canvas.ts";
import { ClassesTab, type ClassUsage } from "./ClassesTab.tsx";
import { SiteCssTab } from "./SiteCssTab.tsx";
import { TokensTab } from "./TokensTab.tsx";
import { printView, readView, type StylesTab, type StylesView, tabOf } from "./view.ts";

/** What the place reads as it opens: the Design system, its preview, and how widely each Class is used. */
type Loaded = { designSystem: DesignSystemView; preview: Preview; usage: Map<string, ClassUsage> };

/** A refusal as the place words it, with the problems the server listed (each where and what). */
export type Failure = { text: string; problems: string[] };

/** The code a refusal carries, or `network`. */
function codeOf(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "network";
}

/** A refusal in the person's words, with what the server listed. */
export function failureOf(error: unknown, words: Words): Failure {
	const shown = words.styles.errors;
	const code = codeOf(error);
	const known: Record<string, string> = {
		DESIGN_SYSTEM_INVALID: shown.invalid,
		CLASS_IN_USE: shown.classInUse,
		TOKEN_IN_USE: shown.tokenInUse,
		FORBIDDEN: shown.forbidden,
		network: shown.network,
	};
	const data = (error as { data?: { problems?: unknown; usedBy?: unknown } } | null)?.data;
	const problems = Array.isArray(data?.problems)
		? (data.problems as { at?: string; message: string; line?: number }[]).map((problem) =>
				[problem.at, problem.line ? `(${problem.line})` : "", problem.message].filter(Boolean).join(" "),
			)
		: [];
	const used = Array.isArray(data?.usedBy) ? data.usedBy.length : 0;
	if (used > 0) problems.push(fill(shown.usedIn, { count: String(used) }));
	return { text: known[code] ?? fill(shown.other, { code }), problems };
}

const TAB_ICONS: Record<StylesTab, Icon> = {
	classes: TagIcon,
	tokens: SwatchBookIcon,
	"site-css": FileCodeIcon,
	breakpoints: MonitorSmartphoneIcon,
};

/**
 * The Styles place (SPEC 8; `places-assets/05`, `06`, `07`): the Site's Design system edited over the
 * canvas, in four tabs that are sections of the place (an icon and a word each, each an address:
 * `styles/classes`, `styles/tokens`, `styles/site-css`, `styles/breakpoints`). Classes, Design tokens,
 * the Site CSS and the Breakpoints are the Design system's Draft, saved by itself a moment after each
 * change, through the same editing as the admin's Design system screen (`useDesignSystemEditing`) with
 * the Management API on the Site's own address. Once something is saved here, the page on the canvas
 * shows the Draft's stylesheet. Staff only, as the Design system is.
 */
export function StylesPlace(props: PlaceProps) {
	const { config, words, place, view, leave } = props;
	const api = useMemo(() => managementApi(config.token), [config.token]);
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [failed, setFailed] = useState<Failure | null>(null);
	const siteId = config.site.id;

	useEffect(() => rememberPlace(place, view), [place, view]);
	// The bar's Publish covers the Design system while Styles is open (BA-12).
	usePublishSources([{ kind: "designSystem" }]);

	const read = useCallback(async () => {
		setFailed(null);
		try {
			const [{ designSystem }, { preview }] = await Promise.all([
				api.designSystem.get({ siteId }),
				api.designSystem.preview({ siteId }),
			]);
			const ids = designSystem.draft.classes.map((each) => each.id).slice(0, 500);
			const css = await api.builder.css({ siteId, classes: ids });
			const usage = new Map(css.classes.map((each) => [each.id, each.usage]));
			setLoaded({ designSystem, preview, usage });
		} catch (error) {
			setFailed(failureOf(error, words));
		}
	}, [api, siteId, words]);
	useEffect(() => {
		void read();
	}, [read]);

	if (loaded) return <StylesEditor {...props} api={api} loaded={loaded} />;
	return (
		<Place words={words} title={words.places.styles} backTo={null} onBack={leave} place={place}>
			<div className="grid grow place-items-center p-8" data-wc-styles-loading="">
				{failed ? (
					<div role="alert" className="flex max-w-md flex-col items-center gap-2 text-center">
						<p className="text-chrome-strong m-0 text-[13px] font-semibold">{failed.text}</p>
						<button
							type="button"
							onClick={() => void read()}
							className={`text-chrome-accent rounded-sm text-[12px] font-medium underline-offset-2 hover:underline ${FOCUS_RING}`}
						>
							{words.styles.retry}
						</button>
					</div>
				) : (
					<p role="status" className="text-chrome-muted m-0 text-[12px]">
						{words.styles.loading}
					</p>
				)}
			</div>
		</Place>
	);
}

function StylesEditor({
	config,
	words,
	place,
	view: printed,
	documents,
	announce,
	onSaving,
	leave,
	api,
	loaded,
}: PlaceProps & { api: ReturnType<typeof managementApi>; loaded: Loaded }) {
	const shown = words.styles;
	const siteId = config.site.id;
	const tab = tabOf(place);
	const view = readView(printed);
	const [failure, setFailure] = useState<Failure | null>(null);
	const [usage, setUsage] = useState(loaded.usage);
	const client = useCallback<DesignSystemApi>(async () => api as unknown as DesignSystemClient, [api]);

	const designSystem = useDesignSystemEditing({
		siteId,
		api: client,
		designSystem: loaded.designSystem,
		preview: loaded.preview,
		onFailure: (error) => {
			const worded = failureOf(error, words);
			setFailure(worded);
			announce(worded.text, true);
		},
		onSaved: () => {
			setFailure(null);
			showDraftStyles();
		},
	});
	const { editing, status } = designSystem;

	// The Draft state beside Publish follows the Design system's saving.
	const reported = useRef(status);
	useEffect(() => {
		if (reported.current === status) return;
		reported.current = status;
		onSaving(status === "failed" ? "failed" : status === "saved" ? "saved" : "saving");
	}, [status, onSaving]);

	// The canvas's Breakpoint lines follow the Breakpoints as they change here.
	const breakpoints = editing.draft.tokens.breakpoints;
	useEffect(() => {
		followBreakpoints(
			breakpoints.flatMap((each) => (each.id ? [{ id: each.id, name: each.name, width: each.width }] : [])),
		);
	}, [breakpoints]);

	/** Changes the tab's view: filters and the token group are history entries; the search and the selection replace. */
	const setView = useCallback(
		(next: StylesView, replace = false) => documents.setView(printView(next), replace ? "replace" : "push"),
		[documents],
	);
	const openTab = (next: StylesTab) => documents.openPlace(`styles/${next}`, printView({ ...view, query: "" }));

	const refreshUsage = useCallback(async () => {
		try {
			const ids = editing.draft.classes.map((each) => each.id).slice(0, 500);
			const css = await api.builder.css({ siteId, classes: ids });
			setUsage(new Map(css.classes.map((each) => [each.id, each.usage])));
		} catch {
			// The counts stay as they were.
		}
	}, [api, siteId, editing.draft.classes]);

	const tabs: { key: StylesTab; label: string }[] = [
		{ key: "classes", label: shown.tabs.classes },
		{ key: "tokens", label: shown.tabs.tokens },
		{ key: "site-css", label: shown.tabs.siteCss },
		{ key: "breakpoints", label: shown.tabs.breakpoints },
	];

	return (
		<Place
			words={words}
			title={words.places.styles}
			backTo={null}
			onBack={leave}
			place={place}
			actions={<DraftChip words={words} status={status} />}
		>
			<div className="flex min-h-0 grow flex-col gap-2.5 px-2 pb-2" data-wc-styles={tab}>
				<div className="flex items-center gap-1.5">
					<nav aria-label={shown.tabs.label} className="flex items-center gap-1.5">
						{tabs.map(({ key, label }) => {
							const Glyph = TAB_ICONS[key];
							const current = key === tab;
							return (
								<button
									key={key}
									type="button"
									aria-current={current ? "page" : undefined}
									onClick={() => openTab(key)}
									className={`border-chrome-hover inline-flex h-[33px] items-center gap-[7px] rounded-md border ps-[11px] pe-3.5 text-[12px] font-medium ${
										current
											? "bg-chrome-raised text-chrome-strong"
											: "text-chrome-muted hover:bg-chrome-raised hover:text-chrome-text"
									} ${CHROME_EASE} ${FOCUS_RING}`}
									data-wc-styles-tab={key}
								>
									<Glyph aria-hidden="true" className="size-3.5" />
									{label}
								</button>
							);
						})}
					</nav>
				</div>
				{failure ? (
					<div
						role="alert"
						className="border-chrome-danger/50 flex flex-col gap-1 rounded-md border px-3 py-2 text-[12px] text-red-200"
						data-wc-styles-failure=""
					>
						<p className="m-0 flex items-center gap-1.5 font-medium">
							<TriangleAlertIcon aria-hidden="true" className="text-chrome-danger size-3.5 flex-none" />
							{failure.text}
						</p>
						{failure.problems.length > 0 ? (
							<ul className="m-0 flex flex-col gap-0.5 ps-5">
								{failure.problems.map((problem) => (
									<li key={problem} className="font-mono text-[11px]">
										{problem}
									</li>
								))}
							</ul>
						) : null}
					</div>
				) : null}
				<div className="flex min-h-0 grow" data-wc-styles-pane={tab}>
					{tab === "classes" ? (
						<ClassesTab
							words={words}
							editing={editing}
							view={view}
							setView={setView}
							usage={usage}
							refreshUsage={refreshUsage}
							announce={announce}
						/>
					) : tab === "tokens" ? (
						<TokensTab words={words} editing={editing} view={view} setView={setView} announce={announce} />
					) : tab === "site-css" ? (
						<SiteCssTab words={words} editing={editing} />
					) : (
						<BreakpointsTab words={words} editing={editing} announce={announce} />
					)}
				</div>
			</div>
		</Place>
	);
}

/** The Design system's Draft state, on the right of the place's header (SPEC 8, `places-assets/05`). */
function DraftChip({ words, status }: { words: Words; status: "saved" | "waiting" | "saving" | "failed" }) {
	const shown = words.styles.draft;
	const text =
		status === "failed"
			? shown.failed
			: status === "saved"
				? shown.saved
				: status === "saving"
					? shown.saving
					: shown.waiting;
	return (
		<p
			className={`m-0 inline-flex items-center gap-1.5 text-[12px] font-medium ${
				status === "failed" ? "text-chrome-danger" : "text-chrome-muted"
			}`}
			data-wc-styles-draft={status}
		>
			{status === "saving" ? (
				<LoaderCircleIcon aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
			) : status === "failed" ? (
				<TriangleAlertIcon aria-hidden="true" className="size-3.5" />
			) : (
				<CheckIcon aria-hidden="true" className="size-3.5" />
			)}
			{text}
		</p>
	);
}
