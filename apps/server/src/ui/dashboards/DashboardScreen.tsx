import { useRouter } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { Field, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import {
	DownloadIcon,
	EllipsisIcon,
	GripIcon,
	PencilIcon,
	PlusIcon,
	SaveIcon,
	TableIcon,
	TrashIcon,
	TrendingUpIcon,
} from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type PointerEvent,
	type RefObject,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";

import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";
import {
	type CatalogKind,
	type DashboardPlace,
	type DashboardRange,
	type DashboardView,
	dashboardsApi,
	daysText,
	downloadCsv,
	GRID_COLUMNS,
	GRID_GAP,
	ROW_HEIGHT,
	sameRange,
	type WidgetAnswer,
	type WidgetView,
} from "./model.ts";
import { hasChart, WidgetBody } from "./WidgetBody.tsx";
import { needsChoice, RangeFields, WidgetPicker, WidgetSettingsDialog } from "./WidgetDialogs.tsx";

type Rect = { x: number; y: number; w: number; h: number };

/**
 * A Dashboard (Site › Dashboards › one, or Workspace › Dashboards › one): its Widgets on a grid of
 * twelve columns, each counting when shown, for its own days or the Dashboard's (which anyone may
 * explore without changing it: `explored`, kept in the address). Staff add Widgets from the catalog,
 * edit, move and resize them: by dragging the handle (or the corner), or from the keyboard on the
 * handle (Alt with the arrows moves, Alt and Shift with the arrows resizes; Space picks it up so the
 * arrows move it, Space puts it down, Escape puts it back), every change said in a live region.
 */
export function DashboardScreen({
	place,
	dashboard,
	catalog,
	explored,
	onExplore,
	workspaceName,
	listPath,
}: {
	place: DashboardPlace;
	dashboard: DashboardView;
	catalog: readonly CatalogKind[] | null;
	explored: DashboardRange | null;
	onExplore: (range: DashboardRange | null) => void;
	workspaceName: string;
	listPath: () => Promise<void>;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const range = explored ?? dashboard.range;
	const [layout, setLayout] = useState(dashboard.widgets);
	const [announcement, setAnnouncement] = useState("");
	const [picking, setPicking] = useState(false);
	const [editing, setEditing] = useState<{ widget: WidgetView; from: RefObject<HTMLElement | null> } | null>(null);
	const [dialog, setDialog] = useState<"rename" | "template" | "delete" | null>(null);
	const addButton = useRef<HTMLButtonElement>(null);
	const menuButton = useRef<HTMLButtonElement>(null);
	const grid = useRef<HTMLUListElement>(null);
	// The layout as last saved: what a failed move goes back to.
	const saved = useRef(dashboard.widgets);
	useEffect(() => {
		saved.current = dashboard.widgets;
		setLayout(dashboard.widgets);
	}, [dashboard.widgets]);
	const kindOf = (widget: WidgetView) => catalog?.find((kind) => kind.kind === widget.kind);
	const isWorkspace = "workspaceId" in place;

	const reload = async () => {
		await router.invalidate();
	};
	const announce = (widget: WidgetView, rect: Rect) =>
		setAnnouncement(
			t("dashboards.moved", {
				title: widget.title || widget.label,
				x: rect.x + 1,
				y: rect.y + 1,
				w: rect.w,
				h: rect.h,
			}),
		);
	const preview = (widget: WidgetView, rect: Rect) =>
		setLayout((before) => before.map((each) => (each.id === widget.id ? { ...each, ...rect } : each)));
	// Moves show at once and are saved one after another, so quick key presses never undo each other;
	// the saved layout (the Widgets a move pushed down) shows once the last of them is saved.
	const saving = useRef<Promise<void>>(Promise.resolve());
	const waiting = useRef(0);
	const move = (widget: WidgetView, rect: Rect): Promise<void> => {
		preview(widget, rect);
		waiting.current += 1;
		saving.current = saving.current.then(async () => {
			try {
				const api = await dashboardsApi();
				const answer = await api.widgets.move({ ...place, dashboardId: dashboard.id, widgetId: widget.id, ...rect });
				waiting.current -= 1;
				saved.current = answer.dashboard.widgets;
				if (waiting.current > 0) return;
				setLayout(answer.dashboard.widgets);
				const placed = answer.dashboard.widgets.find((each) => each.id === widget.id);
				if (placed) announce(widget, placed);
			} catch (failure) {
				waiting.current -= 1;
				setLayout(saved.current);
				toast.error(t(errorMessage(failure)));
			}
		});
		return saving.current;
	};

	const pick = async (kind: CatalogKind) => {
		try {
			const api = await dashboardsApi();
			const answer = await api.widgets.add({ ...place, dashboardId: dashboard.id, kind: kind.kind });
			setPicking(false);
			setLayout(answer.dashboard.widgets);
			const added = answer.dashboard.widgets.find((each) => each.id === answer.widgetId);
			toast.success(t("dashboards.addedToast", { title: kind.label }));
			await reload();
			if (added && needsChoice(kind)) setEditing({ widget: added, from: addButton });
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	const exportAll = async () => {
		try {
			const api = await dashboardsApi();
			const file = await api.export({ ...place, dashboardId: dashboard.id, range: explored ?? undefined });
			downloadCsv(file);
			toast.success(t("dashboards.exportedToast", { filename: file.filename }));
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	const share = async (sharedWithEveryone: boolean) => {
		try {
			const api = await dashboardsApi();
			await api.update({ ...place, dashboardId: dashboard.id, sharedWithEveryone });
			toast.success(t(sharedWithEveryone ? "dashboards.sharedToast" : "dashboards.unsharedToast"));
			await reload();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	const keepRange = async () => {
		try {
			const api = await dashboardsApi();
			await api.update({ ...place, dashboardId: dashboard.id, range });
			toast.success(t("dashboards.rangeSavedToast"));
			onExplore(null);
			await reload();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};

	const ordered = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
	return (
		<>
			<PageHeader
				heading={dashboard.name}
				action={
					<div className="flex flex-wrap items-center gap-2">
						{dashboard.canManage ? (
							<Button ref={addButton} onClick={() => setPicking(true)} disabled={!catalog}>
								<PlusIcon aria-hidden="true" />
								{t("dashboards.addWidget")}
							</Button>
						) : null}
						<Button variant="outline" onClick={exportAll}>
							<DownloadIcon aria-hidden="true" />
							{t("dashboards.exportCsv")}
						</Button>
						{dashboard.canManage ? (
							<DropdownMenu>
								<DropdownMenuTrigger
									ref={menuButton}
									render={<Button variant="outline" size="icon" aria-label={t("dashboards.menu")} />}
								>
									<EllipsisIcon aria-hidden="true" />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-auto min-w-56">
									<DropdownMenuItem onClick={() => setDialog("rename")}>
										<PencilIcon aria-hidden="true" />
										{t("dashboards.rename")}
									</DropdownMenuItem>
									<DropdownMenuCheckboxItem
										checked={dashboard.sharedWithEveryone}
										onCheckedChange={(checked) => share(checked)}
									>
										{t(isWorkspace ? "dashboards.shareEveryoneWorkspace" : "dashboards.shareEveryone")}
									</DropdownMenuCheckboxItem>
									<DropdownMenuItem onClick={() => setDialog("template")}>
										<SaveIcon aria-hidden="true" />
										{t("dashboards.saveTemplate")}
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem variant="destructive" onClick={() => setDialog("delete")}>
										<TrashIcon aria-hidden="true" />
										{t("dashboards.delete")}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						) : null}
					</div>
				}
			>
				{t(dashboard.sharedWithEveryone ? "dashboards.shownToEveryone" : "dashboards.shownToViewers")}
			</PageHeader>
			<div className="mb-6 flex flex-wrap items-end gap-3">
				<RangeFields
					id={`${id}-range`}
					label={t("dashboards.rangeLabel")}
					range={range}
					onChange={(next) => onExplore(sameRange(next, dashboard.range) ? null : next)}
				/>
				{explored && dashboard.canManage ? (
					<Button variant="outline" onClick={keepRange}>
						{t("dashboards.saveRange")}
					</Button>
				) : null}
			</div>
			{isWorkspace ? <p className="text-muted-foreground mb-4 text-sm">{t("dashboards.workspaceNote")}</p> : null}
			<p role="status" aria-live="polite" className="sr-only">
				{announcement}
			</p>
			{ordered.length === 0 ? (
				<div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
					<p>{t("dashboards.empty")}</p>
					{dashboard.canManage ? <p>{t("dashboards.emptyManage")}</p> : null}
				</div>
			) : (
				<ul
					ref={grid}
					aria-label={t("dashboards.gridLabel", { name: dashboard.name })}
					className="grid grid-cols-1 gap-4 md:auto-rows-[minmax(5rem,auto)] md:grid-cols-12"
				>
					{ordered.map((widget) => (
						<WidgetCard
							key={widget.id}
							place={place}
							dashboardId={dashboard.id}
							widget={widget}
							explored={explored}
							canManage={dashboard.canManage}
							grid={grid}
							onPreview={preview}
							onMove={move}
							onAnnounce={setAnnouncement}
							onEdit={(from) => setEditing({ widget, from })}
							onRemoved={reload}
						/>
					))}
				</ul>
			)}
			{picking && catalog ? (
				<WidgetPicker catalog={catalog} onPick={pick} onClose={() => setPicking(false)} finalFocus={addButton} />
			) : null}
			{editing ? (
				<WidgetSettingsDialog
					place={place}
					dashboardId={dashboard.id}
					widget={editing.widget}
					kind={kindOf(editing.widget)}
					onSaved={reload}
					onClose={() => setEditing(null)}
					finalFocus={editing.from}
				/>
			) : null}
			{dialog === "rename" ? (
				<RenameDialog place={place} dashboard={dashboard} onClose={() => setDialog(null)} finalFocus={menuButton} />
			) : null}
			{dialog === "template" ? (
				<TemplateDialog
					place={place}
					dashboard={dashboard}
					workspaceName={workspaceName}
					onClose={() => setDialog(null)}
					finalFocus={menuButton}
				/>
			) : null}
			{dialog === "delete" ? (
				<DeleteDialog
					place={place}
					dashboard={dashboard}
					onClose={() => setDialog(null)}
					finalFocus={menuButton}
					onDeleted={listPath}
				/>
			) : null}
		</>
	);
}

/** Arrow keys as grid steps (left and right flip in right-to-left languages). */
function stepOf(event: KeyboardEvent): { dx: number; dy: number } | null {
	const rtl = document.documentElement.dir === "rtl";
	switch (event.key) {
		case "ArrowLeft":
			return { dx: rtl ? 1 : -1, dy: 0 };
		case "ArrowRight":
			return { dx: rtl ? -1 : 1, dy: 0 };
		case "ArrowUp":
			return { dx: 0, dy: -1 };
		case "ArrowDown":
			return { dx: 0, dy: 1 };
		default:
			return null;
	}
}

/** A rect moved or resized by a step, kept on the grid. */
function stepped(rect: Rect, step: { dx: number; dy: number }, resize: boolean): Rect {
	if (resize) {
		const w = Math.min(Math.max(rect.w + step.dx, 2), GRID_COLUMNS - rect.x);
		return { ...rect, w, h: Math.min(Math.max(rect.h + step.dy, 2), 12) };
	}
	return {
		...rect,
		x: Math.min(Math.max(rect.x + step.dx, 0), GRID_COLUMNS - rect.w),
		y: Math.max(rect.y + step.dy, 0),
	};
}

function WidgetCard({
	place,
	dashboardId,
	widget,
	explored,
	canManage,
	grid,
	onPreview,
	onMove,
	onAnnounce,
	onEdit,
	onRemoved,
}: {
	place: DashboardPlace;
	dashboardId: string;
	widget: WidgetView;
	explored: DashboardRange | null;
	canManage: boolean;
	grid: RefObject<HTMLUListElement | null>;
	onPreview: (widget: WidgetView, rect: Rect) => void;
	onMove: (widget: WidgetView, rect: Rect) => Promise<void>;
	onAnnounce: (message: string) => void;
	onEdit: (from: RefObject<HTMLElement | null>) => void;
	onRemoved: () => Promise<void>;
}) {
	const t = useT();
	const id = useId();
	const menu = useRef<HTMLButtonElement>(null);
	const [answer, setAnswer] = useState<WidgetAnswer | null>(null);
	const [failed, setFailed] = useState(false);
	const [asTable, setAsTable] = useState(false);
	const [picked, setPicked] = useState<Rect | null>(null);
	const drag = useRef<{ startX: number; startY: number; from: Rect; resize: boolean; at: Rect } | null>(null);
	const title = widget.title || widget.label;
	const rect: Rect = { x: widget.x, y: widget.y, w: widget.w, h: widget.h };
	// What the Widget counts: a change to it (or to the days explored) counts again.
	const counted = JSON.stringify([
		place,
		dashboardId,
		widget.id,
		widget.kind,
		widget.range,
		widget.filters,
		widget.settings,
		widget.rows,
		widget.title,
		explored,
	]);
	useEffect(() => {
		let live = true;
		setFailed(false);
		const [where, dashboard, widgetId, , , , , , , range] = JSON.parse(counted) as [
			DashboardPlace,
			string,
			string,
			...unknown[],
		];
		void dashboardsApi()
			.then((api) =>
				api.widgets.data({
					...where,
					dashboardId: dashboard,
					widgetId,
					range: (range as DashboardRange | null) ?? undefined,
				}),
			)
			.then((answered) => live && setAnswer(answered.widget))
			.catch(() => live && setFailed(true));
		return () => {
			live = false;
		};
	}, [counted]);

	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		const step = stepOf(event);
		if (picked) {
			if (step) {
				event.preventDefault();
				const next = stepped({ ...rect }, step, event.shiftKey);
				onPreview(widget, next);
				onAnnounce(t("dashboards.moved", { title, x: next.x + 1, y: next.y + 1, w: next.w, h: next.h }));
			} else if (event.key === " " || event.key === "Enter") {
				event.preventDefault();
				setPicked(null);
				void onMove(widget, rect);
			} else if (event.key === "Escape") {
				event.preventDefault();
				setPicked(null);
				onPreview(widget, picked);
				onAnnounce(t("dashboards.droppedBack", { title }));
			}
			return;
		}
		if (step && event.altKey) {
			event.preventDefault();
			void onMove(widget, stepped(rect, step, event.shiftKey));
		} else if (event.key === " ") {
			event.preventDefault();
			setPicked(rect);
			onAnnounce(t("dashboards.pickedUp", { title }));
		}
	};

	/** Grid cells per pixel, from the grid's width. */
	const cell = () => {
		const width = grid.current?.getBoundingClientRect().width ?? 1200;
		return { x: (width + GRID_GAP) / GRID_COLUMNS, y: ROW_HEIGHT + GRID_GAP };
	};
	const startDrag = (resize: boolean) => (event: PointerEvent<HTMLElement>) => {
		if (event.button !== 0) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { startX: event.clientX, startY: event.clientY, from: rect, resize, at: rect };
	};
	const onDrag = (event: PointerEvent<HTMLElement>) => {
		const current = drag.current;
		if (!current) return;
		const size = cell();
		const rtl = document.documentElement.dir === "rtl";
		const dx = Math.round(((event.clientX - current.startX) * (rtl ? -1 : 1)) / size.x);
		const dy = Math.round((event.clientY - current.startY) / size.y);
		const next = stepped(current.from, { dx, dy }, current.resize);
		if (JSON.stringify(next) === JSON.stringify(current.at)) return;
		current.at = next;
		onPreview(widget, next);
	};
	const endDrag = () => {
		const current = drag.current;
		drag.current = null;
		if (current && JSON.stringify(current.at) !== JSON.stringify(current.from)) void onMove(widget, current.at);
	};

	const exportOne = async () => {
		try {
			const api = await dashboardsApi();
			const file = await api.widgets.export({
				...place,
				dashboardId,
				widgetId: widget.id,
				range: explored ?? undefined,
			});
			downloadCsv(file);
			toast.success(t("dashboards.exportedToast", { filename: file.filename }));
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	const remove = async () => {
		try {
			const api = await dashboardsApi();
			await api.widgets.remove({ ...place, dashboardId, widgetId: widget.id });
			toast.success(t("dashboards.removedToast", { title }));
			await onRemoved();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};

	const data = answer?.data ?? null;
	return (
		<li
			aria-labelledby={`${id}-title`}
			className={`bg-card text-card-foreground relative flex flex-col gap-3 rounded-xl border p-4 shadow-xs md:[grid-column:var(--wc-x)_/_span_var(--wc-w)] md:[grid-row:var(--wc-y)_/_span_var(--wc-h)] ${picked ? "ring-ring ring-3" : ""}`}
			style={
				{ "--wc-x": widget.x + 1, "--wc-w": widget.w, "--wc-y": widget.y + 1, "--wc-h": widget.h } as Record<
					string,
					number
				>
			}
		>
			<header className="flex items-start gap-2">
				{canManage ? (
					<button
						type="button"
						className="text-muted-foreground hover:bg-accent focus-visible:ring-ring/50 -ms-1 mt-0.5 cursor-grab touch-none rounded-sm p-1 outline-none focus-visible:ring-3"
						aria-label={t("dashboards.moveHandle", { title })}
						aria-describedby={`${id}-move-help`}
						aria-pressed={picked !== null}
						onKeyDown={onKeyDown}
						onPointerDown={startDrag(false)}
						onPointerMove={onDrag}
						onPointerUp={endDrag}
						onPointerCancel={endDrag}
						onBlur={() => {
							if (picked) {
								setPicked(null);
								onPreview(widget, picked);
							}
						}}
					>
						<GripIcon className="size-4" aria-hidden="true" />
					</button>
				) : null}
				<div className="min-w-0 flex-1">
					<h2 id={`${id}-title`} className="leading-snug font-medium break-words">
						{title}
					</h2>
					<p className="text-muted-foreground text-xs">
						{answer ? daysText(answer.range) : null}
						{widget.range ? ` · ${t("dashboards.ownRange")}` : null}
					</p>
				</div>
				{data && hasChart(data.shape) ? (
					<Button
						variant="ghost"
						size="icon-sm"
						aria-pressed={asTable}
						aria-label={t(asTable ? "dashboards.showChart" : "dashboards.showTable")}
						onClick={() => setAsTable((before) => !before)}
					>
						{asTable ? <TrendingUpIcon aria-hidden="true" /> : <TableIcon aria-hidden="true" />}
					</Button>
				) : null}
				<DropdownMenu>
					<DropdownMenuTrigger
						ref={menu}
						render={<Button variant="ghost" size="icon-sm" aria-label={t("dashboards.widgetMenu", { title })} />}
					>
						<EllipsisIcon aria-hidden="true" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-auto min-w-44">
						{canManage ? (
							<DropdownMenuItem onClick={() => onEdit(menu)}>
								<PencilIcon aria-hidden="true" />
								{t("dashboards.editWidget")}
							</DropdownMenuItem>
						) : null}
						<DropdownMenuItem onClick={exportOne}>
							<DownloadIcon aria-hidden="true" />
							{t("dashboards.exportWidget")}
						</DropdownMenuItem>
						{canManage ? (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem variant="destructive" onClick={remove}>
									<TrashIcon aria-hidden="true" />
									{t("dashboards.removeWidget")}
								</DropdownMenuItem>
							</>
						) : null}
					</DropdownMenuContent>
				</DropdownMenu>
			</header>
			{canManage ? (
				<p id={`${id}-move-help`} className="sr-only">
					{t("dashboards.moveHelp")}
				</p>
			) : null}
			<div className="min-w-0 flex-1">
				{failed ? (
					<p className="text-muted-foreground text-sm">{t("dashboards.problems.generic")}</p>
				) : !answer ? (
					<p className="text-muted-foreground text-sm">{t("dashboards.loading")}</p>
				) : data ? (
					<WidgetBody data={data} asTable={asTable} title={title} />
				) : (
					<ProblemText code={answer.problem?.code ?? ""} />
				)}
			</div>
			{answer?.sites || answer?.countedFrom ? (
				<footer className="text-muted-foreground grid gap-1 text-xs">
					{answer.sites ? (
						<p>{t("dashboards.sitesCounted", { counted: answer.sites.counted, of: answer.sites.of })}</p>
					) : null}
					{answer.countedFrom ? (
						<p>{t("dashboards.countedFrom", { day: new Date(answer.countedFrom).toISOString().slice(0, 10) })}</p>
					) : null}
				</footer>
			) : null}
			{canManage ? (
				<span
					aria-hidden="true"
					className="text-muted-foreground absolute end-1 bottom-1 hidden cursor-nwse-resize touch-none p-1 md:block"
					onPointerDown={startDrag(true)}
					onPointerMove={onDrag}
					onPointerUp={endDrag}
					onPointerCancel={endDrag}
				>
					<svg width="10" height="10" viewBox="0 0 10 10" className="rtl:-scale-x-100" aria-hidden="true">
						<path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" strokeWidth="1.5" />
					</svg>
				</span>
			) : null}
		</li>
	);
}

const PROBLEMS = [
	"GOAL_NOT_FOUND",
	"FUNNEL_NOT_FOUND",
	"MODULE_NOT_RUNNING",
	"WIDGET_FAILED",
	"WIDGET_UNKNOWN",
	"WIDGET_SETTING_MISSING",
] as const;

function ProblemText({ code }: { code: string }) {
	const t = useT();
	const known = (PROBLEMS as readonly string[]).includes(code) ? (code as (typeof PROBLEMS)[number]) : "generic";
	return (
		<p className="text-sm">
			<Badge variant="outline" className="me-2">
				{t("dashboards.notCounted")}
			</Badge>
			{t(`dashboards.problems.${known}`)}
		</p>
	);
}

function RenameDialog({
	place,
	dashboard,
	onClose,
	finalFocus,
}: {
	place: DashboardPlace;
	dashboard: DashboardView;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [name, setName] = useState(dashboard.name);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		try {
			const api = await dashboardsApi();
			await api.update({ ...place, dashboardId: dashboard.id, name: name.trim() });
			toast.success(t("dashboards.renamedToast"));
			onClose();
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("dashboards.close")} finalFocus={finalFocus}>
				<form onSubmit={save}>
					<DialogHeader>
						<DialogTitle>{t("dashboards.renameTitle")}</DialogTitle>
						<DialogDescription>{t("dashboards.renameIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6">
						<Field>
							<FieldLabel htmlFor={`${id}-name`}>{t("dashboards.name")}</FieldLabel>
							<Input
								id={`${id}-name`}
								value={name}
								required
								maxLength={100}
								onChange={(change) => setName(change.target.value)}
							/>
						</Field>
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("dashboards.cancel")}</DialogClose>
						<Button type="submit">{t("dashboards.save")}</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function TemplateDialog({
	place,
	dashboard,
	workspaceName,
	onClose,
	finalFocus,
}: {
	place: DashboardPlace;
	dashboard: DashboardView;
	workspaceName: string;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const id = useId();
	const [name, setName] = useState(dashboard.name);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		try {
			const api = await dashboardsApi();
			await api.saveAsTemplate({ ...place, dashboardId: dashboard.id, name: name.trim() });
			toast.success(t("dashboards.templateSavedToast"));
			onClose();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("dashboards.close")} finalFocus={finalFocus}>
				<form onSubmit={save}>
					<DialogHeader>
						<DialogTitle>{t("dashboards.saveTemplateTitle")}</DialogTitle>
						<DialogDescription>{t("dashboards.saveTemplateIntro", { workspace: workspaceName })}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="my-6">
						<Field>
							<FieldLabel htmlFor={`${id}-name`}>{t("dashboards.name")}</FieldLabel>
							<Input
								id={`${id}-name`}
								value={name}
								required
								maxLength={100}
								onChange={(change) => setName(change.target.value)}
							/>
						</Field>
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("dashboards.cancel")}</DialogClose>
						<Button type="submit">{t("dashboards.saveTemplate")}</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function DeleteDialog({
	place,
	dashboard,
	onClose,
	finalFocus,
	onDeleted,
}: {
	place: DashboardPlace;
	dashboard: DashboardView;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
	onDeleted: () => Promise<void>;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const remove = async () => {
		setBusy(true);
		try {
			const api = await dashboardsApi();
			await api.delete({ ...place, dashboardId: dashboard.id });
			toast.success(t("dashboards.deletedToast"));
			onClose();
			await onDeleted();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("dashboards.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("dashboards.deleteTitle", { name: dashboard.name })}</DialogTitle>
					<DialogDescription>{t("dashboards.deleteIntro")}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>{t("dashboards.cancel")}</DialogClose>
					<Button variant="destructive" onClick={remove} disabled={busy}>
						{t("dashboards.delete")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
