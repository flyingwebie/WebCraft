import { useNavigate, useRouter } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { CircleAlertIcon, EyeIcon, UploadIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useAfterRender } from "../after-render.ts";
import { getApi } from "../api.ts";
import { useAutosave } from "../content/autosave.ts";
import { SaveStatusText, StatusBadge } from "../content/DraftParts.tsx";
import { errorMessage } from "../errors.ts";
import { HistoryLink } from "../history/HistoryLink.tsx";
import { useT } from "../i18n.tsx";
import { Tabs } from "../Tabs.tsx";
import { ClassesTab } from "./ClassesTab.tsx";
import { BaseStylesTab, CustomCssTab } from "./CssTabs.tsx";
import { ExportMenu, ImportDialog } from "./ImportExport.tsx";
import {
	type Change,
	type ClassPatch,
	type ColourMode,
	type DesignSystemView,
	type Draft,
	type EditableClass,
	mergeChanges,
	type Preview,
	type Problem,
	problemsOf,
} from "./model.ts";
import { TokensTab } from "./TokensTab.tsx";

export type DesignSystemTab = "tokens" | "classes" | "base" | "css";

/** What every tab of the screen edits with: the Draft as it is now, its preview and how to change it. */
export type Editing = {
	siteId: string;
	draft: Draft;
	preview: Preview;
	mode: ColourMode;
	setMode(mode: ColourMode): void;
	/** Replaces a section of the Draft; saved a moment later. */
	setSection<Key extends "tokens" | "baseStyles" | "customCss" | "darkMode">(key: Key, value: Draft[Key]): void;
	/** Changes a Class; saved a moment later. */
	changeClass(classId: string, patch: ClassPatch): void;
	/** Saves what is waiting, then runs a change the server must answer at once (adding or removing). */
	now<Result>(work: () => Promise<Result>): Promise<Result | undefined>;
	/** The Draft as the server answered after such a change. */
	replaceDraft(draft: Draft): void;
};

/**
 * Site › Design system (ADR 0009, spec stories 63 to 70): the Site's Design tokens, Classes, base
 * styles and custom CSS, edited in the Design system's Draft (saved by itself a moment after each
 * change, as the other Structure screens without Co-editing do), each beside a live preview built
 * from the Draft's compiled stylesheet, with the contrast Check; imported and exported as one file,
 * and published as one item. Staff only.
 */
export function DesignSystemScreen({
	siteId,
	designSystem,
	preview: firstPreview,
	tab,
	classId,
}: {
	siteId: string;
	designSystem: DesignSystemView;
	preview: Preview;
	tab?: DesignSystemTab;
	classId?: string;
}) {
	const t = useT();
	const router = useRouter();
	const navigate = useNavigate();
	const afterRender = useAfterRender();
	const alert = useRef<HTMLDivElement>(null);
	const [view, setView] = useState(designSystem);
	const [draft, setDraft] = useState(designSystem.draft);
	const [preview, setPreview] = useState(firstPreview);
	const [previewProblems, setPreviewProblems] = useState<Problem[]>([]);
	const [mode, setMode] = useState<ColourMode>("light");
	const [failure, setFailure] = useState<{ message: string; problems: Problem[] } | null>(null);
	const [publishing, setPublishing] = useState(false);
	const [opening, setOpening] = useState(false);

	const showFailure = useCallback(
		(error: unknown) => {
			setFailure({ message: t(errorMessage(error)), problems: [...problemsOf(error), ...usedByProblems(error, t)] });
			afterRender(() => alert.current?.focus());
		},
		[t, afterRender],
	);

	const autosave = useAutosave<Change>({
		merge: mergeChanges,
		save: async (change) => {
			const api = await getApi();
			const sections = change.sections ?? {};
			if (Object.keys(sections).length > 0) {
				const saved = await api.designSystem.saveDraft({ siteId, ...sections });
				setView(saved.designSystem);
			}
			for (const [id, patch] of Object.entries(change.classes ?? {})) {
				const saved = await api.designSystem.updateClass({ siteId, classId: id, ...patch });
				setView(saved.designSystem);
			}
		},
		onSaved: () => setFailure(null),
		onFailed: showFailure,
	});

	// The preview follows the Draft as it is on screen, a moment after it stops changing.
	const shown = JSON.stringify({
		tokens: draft.tokens,
		classes: draft.classes.map(({ id, name, styles, breakpoints, css }) => ({ id, name, styles, breakpoints, css })),
		baseStyles: draft.baseStyles,
		customCss: draft.customCss,
		darkMode: draft.darkMode,
	});
	useEffect(() => {
		let current = true;
		const timer = setTimeout(async () => {
			try {
				const api = await getApi();
				const answered = await api.designSystem.preview({ siteId, ...JSON.parse(shown) });
				if (!current) return;
				setPreview(answered.preview);
				setPreviewProblems([]);
			} catch (error) {
				if (current) setPreviewProblems(problemsOf(error));
			}
		}, 300);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [siteId, shown]);

	const editing: Editing = {
		siteId,
		draft,
		preview,
		mode,
		setMode,
		setSection: (key, value) => {
			setDraft((before) => ({ ...before, [key]: value }));
			autosave.change({ sections: { [key]: value } });
		},
		changeClass: (classId, patch) => {
			setDraft((before) => ({
				...before,
				classes: before.classes.map((each) => (each.id === classId ? { ...each, ...patch } : each)),
			}));
			autosave.change({ classes: { [classId]: patch } });
		},
		now: async (work) => {
			if (!(await autosave.flush())) return undefined;
			try {
				const result = await work();
				setFailure(null);
				return result;
			} catch (error) {
				showFailure(error);
				return undefined;
			}
		},
		replaceDraft: (next) => {
			setDraft(next);
			setView((before) => ({ ...before, draft: next }));
		},
	};

	const publish = async () => {
		setPublishing(true);
		try {
			if (!(await autosave.flush())) return;
			const api = await getApi();
			await api.designSystem.publish({ siteId });
			const { designSystem: after } = await api.designSystem.get({ siteId });
			setView(after);
			setFailure(null);
			toast.success(t("designSystem.published"));
			await router.invalidate();
		} catch (error) {
			showFailure(error);
		} finally {
			setPublishing(false);
		}
	};

	// Edit mode shows the Site's pages with the Design system's Draft.
	const previewInEditMode = async () => {
		setOpening(true);
		try {
			if (!(await autosave.flush())) return;
			const api = await getApi();
			const { url } = await api.editMode.open({ siteId, path: "/", safeMode: false });
			window.location.assign(url);
		} catch (error) {
			showFailure(error);
			setOpening(false);
		}
	};

	const imported = (designSystem: DesignSystemView) => {
		setView(designSystem);
		setDraft(designSystem.draft);
		setFailure(null);
		void router.invalidate();
	};

	const tabs = [
		{
			id: "tokens",
			label: t("designSystem.tabs.tokens"),
			badge: String(tokenCount(draft)),
			panel: <TokensTab editing={editing} />,
		},
		{
			id: "classes",
			label: t("designSystem.tabs.classes"),
			badge: String(draft.classes.length),
			panel: (
				<ClassesTab
					editing={editing}
					selected={classId}
					onSelect={(id) =>
						void navigate({
							to: "/sites/$siteId/design-system",
							params: { siteId },
							search: (before) => ({ ...before, tab: "classes", class: id }),
							replace: true,
						})
					}
				/>
			),
		},
		{ id: "base", label: t("designSystem.tabs.base"), panel: <BaseStylesTab editing={editing} /> },
		{ id: "css", label: t("designSystem.tabs.css"), panel: <CustomCssTab editing={editing} /> },
	];

	return (
		<div className="grid min-w-0 content-start gap-6">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div className="grid max-w-2xl gap-1">
					<div className="flex flex-wrap items-center gap-3">
						<h1 className="text-2xl font-semibold tracking-tight">{t("designSystem.heading")}</h1>
						<StatusBadge status={view.status} />
						<Badge variant="outline">{t("postTypes.staffOnly")}</Badge>
						<span className="text-muted-foreground text-sm">
							<SaveStatusText status={autosave.status} savedAt={view.updatedAt} />
						</span>
					</div>
					<p className="text-muted-foreground text-sm">{t("designSystem.intro")}</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<ImportDialog siteId={siteId} beforeImport={autosave.flush} onImported={imported} />
					<ExportMenu siteId={siteId} beforeExport={autosave.flush} />
					<Button type="button" variant="outline" disabled={opening} onClick={previewInEditMode}>
						<EyeIcon aria-hidden="true" />
						{t("designSystem.previewInEditMode")}
					</Button>
					<HistoryLink siteId={siteId} item={{ kind: "designSystem" }} />
					<Button type="button" disabled={publishing} onClick={publish}>
						<UploadIcon aria-hidden="true" />
						{t("designSystem.publish")}
					</Button>
				</div>
			</div>
			{failure ? (
				<div
					ref={alert}
					tabIndex={-1}
					role="alert"
					className="border-destructive/50 text-destructive grid gap-2 rounded-lg border p-4 text-sm outline-none"
				>
					<p className="flex items-center gap-2 font-medium">
						<CircleAlertIcon className="size-4" aria-hidden="true" />
						{failure.message}
					</p>
					<ProblemList problems={failure.problems} />
				</div>
			) : null}
			{previewProblems.length > 0 ? (
				<div role="status" className="grid gap-2 rounded-lg border border-amber-600/50 p-4 text-sm">
					<p className="font-medium">{t("designSystem.previewProblems")}</p>
					<ProblemList problems={previewProblems} />
				</div>
			) : null}
			<Tabs
				label={t("designSystem.tabs.label")}
				tabs={tabs}
				initial={tab}
				onSelect={(id) =>
					void navigate({
						to: "/sites/$siteId/design-system",
						params: { siteId },
						search: (before) => ({ ...before, tab: id === "tokens" ? undefined : (id as DesignSystemTab) }),
						replace: true,
					})
				}
			/>
		</div>
	);
}

/** Problems as the server words them, each with where (`classes[2].styles`, line and column). */
export function ProblemList({ problems }: { problems: readonly Problem[] }) {
	if (problems.length === 0) return null;
	return (
		<ul className="grid gap-1 ps-6">
			{problems.map((problem) => (
				<li key={`${problem.at}:${problem.line ?? ""}:${problem.column ?? ""}:${problem.message}`}>
					{problem.at ? <code className="font-mono">{problem.at}</code> : null}
					{problem.line ? (
						<span className="font-mono">
							{" "}
							({problem.line}:{problem.column ?? 1})
						</span>
					) : null}
					{problem.at || problem.line ? ": " : null}
					{problem.message}
				</li>
			))}
		</ul>
	);
}

/** Where a Class or token in use is used, as the refusal (`CLASS_IN_USE`, `TOKEN_IN_USE`) says, in words. */
function usedByProblems(error: unknown, t: ReturnType<typeof useT>): Problem[] {
	const usedBy = (error as { data?: { usedBy?: unknown } }).data?.usedBy;
	if (!Array.isArray(usedBy)) return [];
	return (usedBy as UseOf[]).map((use) => ({ at: "", message: useWords(use, t) }));
}

type UseOf =
	| { kind: "template"; templateKind: string; version: string; elements: string[] }
	| { kind: "component"; name: string; version: string; elements: string[] }
	| { kind: "class"; name: string }
	| { kind: "baseStyle"; target: string }
	| { kind: "customCss" }
	| { kind: "focus" };

function useWords(use: UseOf, t: ReturnType<typeof useT>): string {
	switch (use.kind) {
		case "template":
			return t("designSystem.usedIn.template", {
				kind: use.templateKind,
				version: t(`designSystem.usedIn.${use.version === "published" ? "published" : "draft"}`),
				count: use.elements.length,
			});
		case "component":
			return t("designSystem.usedIn.component", {
				name: use.name,
				version: t(`designSystem.usedIn.${use.version === "published" ? "published" : "draft"}`),
				count: use.elements.length,
			});
		case "class":
			return t("designSystem.usedIn.class", { name: use.name });
		case "baseStyle":
			return t("designSystem.usedIn.baseStyle", { element: use.target });
		case "customCss":
			return t("designSystem.usedIn.customCss");
		default:
			return t("designSystem.usedIn.focus");
	}
}

/** How many Design tokens the Draft has: every colour, scale step and other token. */
function tokenCount(draft: Draft): number {
	const { tokens } = draft;
	return (
		tokens.colours.length +
		tokens.space.steps.length +
		tokens.text.steps.length +
		tokens.fonts.length +
		tokens.radius.length +
		tokens.shadows.length +
		tokens.breakpoints.length +
		tokens.widths.length
	);
}

export type { EditableClass };
