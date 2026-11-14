import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import {
	DownloadIcon,
	EllipsisIcon,
	GripVerticalIcon,
	SlidersHorizontalIcon,
	TableIcon,
	TrendingUpIcon,
	XIcon,
} from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { WidgetLoading, WidgetState } from "./charts.tsx";
import {
	type DashboardPlace,
	type DashboardRange,
	dashboardsApi,
	daysIn,
	daysText,
	downloadCsv,
	GRID_COLUMNS,
	type Rect,
	WIDGET_MAX,
	WIDGET_MIN,
	type WidgetAnswer,
	type WidgetView,
} from "./model.ts";
import { hasChart, hasSomething, WidgetBody } from "./WidgetBody.tsx";

/** Which edge of a Widget a resize handle drags: the right edge (width), the bottom (height), or the corner (both). */
export type Edge = "width" | "height" | "both";

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
export function stepped(rect: Rect, step: { dx: number; dy: number }, resize: boolean): Rect {
	if (resize) {
		const w = Math.min(Math.max(rect.w + step.dx, WIDGET_MIN), GRID_COLUMNS - rect.x);
		return { ...rect, w, h: Math.min(Math.max(rect.h + step.dy, WIDGET_MIN), WIDGET_MAX) };
	}
	return {
		...rect,
		x: Math.min(Math.max(rect.x + step.dx, 0), GRID_COLUMNS - rect.w),
		y: Math.max(rect.y + step.dy, 0),
	};
}

/** What one Widget shows at its title: its own, else a Funnel's or a Goal's name, else its kind's. */
export function titleOf(widget: WidgetView): string {
	if (widget.title) return widget.title;
	const chosen = widget.settings.funnel ?? (widget.kind.endsWith(":goal") ? widget.settings.goal : undefined);
	return typeof chosen === "string" && chosen ? chosen : widget.label;
}

/**
 * One Widget on the grid. At rest: its title, a menu (the chart as a table, Export as CSV), and what it
 * shows, counted when shown (and, comparing, the period before too). While arranging: a grip to drag it
 * by (or to move it from the keyboard: Space picks it up, the arrows move it, Shift and the arrows
 * resize it, Space puts it down, Escape puts it back; Alt and the arrows move it at once), the gear for
 * its settings, the x to remove it, and handles on its right edge, bottom edge and corner.
 */
export function WidgetCard({
	place,
	dashboardId,
	widget,
	rect,
	explored,
	compare,
	nowLabel,
	arranging,
	lifted,
	settleFrom,
	selected,
	flash,
	readout,
	neverCounted,
	onPreview,
	onMove,
	onAnnounce,
	onLift,
	onResize,
	onSettings,
	onRemove,
}: {
	place: DashboardPlace;
	dashboardId: string;
	widget: WidgetView;
	/** Where it shows now, which a drag or a step may have changed before it is saved. */
	rect: Rect;
	explored: DashboardRange | null;
	compare: boolean;
	/** What the Dashboard's range is called ("Last 30 days"). */
	nowLabel: string;
	arranging: boolean;
	/** How far the pointer carried it, while it is dragged. */
	lifted: { dx: number; dy: number } | null;
	/** Where it was on screen when it was dropped: it settles from there to its place in 150 ms. */
	settleFrom: { left: number; top: number } | null;
	/** Its settings are open in the panel. */
	selected: boolean;
	/** A new Widget flashes once. */
	flash: boolean;
	/** The size readout while its width or height changes ("6 of 12 wide · 4 rows"). */
	readout: string | null;
	/** The Site never counted anything: an empty Widget says counting hasn't started. */
	neverCounted: boolean;
	onPreview: (rect: Rect | null) => void;
	onMove: (rect: Rect) => void;
	onAnnounce: (message: string) => void;
	onLift: (event: PointerEvent<HTMLElement>) => void;
	onResize: (event: PointerEvent<HTMLElement>, edge: Edge) => void;
	onSettings: () => void;
	onRemove: () => void;
}) {
	const t = useT();
	const id = useId();
	const card = useRef<HTMLLIElement>(null);
	const [answer, setAnswer] = useState<WidgetAnswer | null>(null);
	const [failed, setFailed] = useState(false);
	const [asTable, setAsTable] = useState(false);
	const [picked, setPicked] = useState<Rect | null>(null);
	const title = titleOf(widget);
	// What the Widget counts: a change to it (or to the days explored, or comparing) counts again. A
	// named shape, not a positional array, so reordering a field here can't silently read back another.
	const counted = JSON.stringify({
		place,
		dashboardId,
		widgetId: widget.id,
		kind: widget.kind,
		range: widget.range,
		filters: widget.filters,
		settings: widget.settings,
		rows: widget.rows,
		title: widget.title,
		explored,
		compare,
	});
	useEffect(() => {
		let live = true;
		setFailed(false);
		const asked = JSON.parse(counted) as {
			place: DashboardPlace;
			dashboardId: string;
			widgetId: string;
			explored: DashboardRange | null;
			compare: boolean;
		};
		void dashboardsApi()
			.then((api) =>
				api.widgets.data({
					...asked.place,
					dashboardId: asked.dashboardId,
					widgetId: asked.widgetId,
					range: asked.explored ?? undefined,
					compare: asked.compare || undefined,
				}),
			)
			.then((answered) => live && setAnswer(answered.widget))
			.catch(() => live && setFailed(true));
		return () => {
			live = false;
		};
	}, [counted]);

	// Dropped, it settles from where the pointer left it to its place on the grid.
	useLayoutEffect(() => {
		const element = card.current;
		if (!element || !settleFrom) return;
		const box = element.getBoundingClientRect();
		const dx = settleFrom.left - box.left;
		const dy = settleFrom.top - box.top;
		if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
		element.style.transition = "none";
		element.style.transform = `translate(${dx}px, ${dy}px)`;
		element.getBoundingClientRect();
		element.style.transition = "transform 150ms ease";
		element.style.transform = "";
		const done = window.setTimeout(() => {
			element.style.transition = "";
		}, 160);
		return () => window.clearTimeout(done);
	}, [settleFrom]);

	useEffect(() => {
		if (flash) card.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
	}, [flash]);

	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		const step = stepOf(event);
		if (picked) {
			if (step) {
				event.preventDefault();
				const next = stepped(rect, step, event.shiftKey);
				onPreview(next);
				onAnnounce(t("dashboards.moved", { title, x: next.x + 1, y: next.y + 1, w: next.w, h: next.h }));
			} else if (event.key === " " || event.key === "Enter") {
				event.preventDefault();
				setPicked(null);
				onPreview(null);
				onMove(rect);
			} else if (event.key === "Escape") {
				event.preventDefault();
				setPicked(null);
				onPreview(null);
				onAnnounce(t("dashboards.droppedBack", { title }));
			}
			return;
		}
		if (step && event.altKey) {
			event.preventDefault();
			onMove(stepped(rect, step, event.shiftKey));
		} else if (event.key === " ") {
			event.preventDefault();
			setPicked(rect);
			onAnnounce(t("dashboards.pickedUp", { title }));
		}
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

	const data = answer?.data ?? null;
	const before = compare ? (answer?.previous?.data ?? null) : null;
	const days = answer ? daysIn(answer.range) : 30;
	const problem = answer?.problem?.code ?? null;
	return (
		<li
			ref={card}
			aria-labelledby={`${id}-title`}
			data-widget={widget.id}
			className={cn(
				"bg-card text-card-foreground group/card @container/widget relative flex min-w-0 flex-col rounded-[14px] border shadow-xs @2xl/page:[grid-column:var(--wc-x)_/_span_var(--wc-w)] @2xl/page:[grid-row:var(--wc-y)_/_span_var(--wc-h)]",
				arranging && "select-none",
				(lifted || picked) && "border-primary ring-primary/80 z-20 shadow-lg ring-1",
				lifted && "pointer-events-none",
				(selected || readout) && "border-primary ring-primary/80 ring-1",
				flash && "ring-primary ring-2",
			)}
			style={
				{
					"--wc-x": rect.x + 1,
					"--wc-w": rect.w,
					"--wc-y": rect.y + 1,
					"--wc-h": rect.h,
					transform: lifted ? `translate(${lifted.dx}px, ${lifted.dy}px)` : undefined,
				} as Record<string, number | string | undefined>
			}
		>
			<header
				className={cn(
					"flex h-12 shrink-0 items-center gap-2 pe-3",
					arranging ? "cursor-grab touch-none ps-2.5" : "ps-5",
				)}
				onPointerDown={arranging ? onLift : undefined}
			>
				{arranging ? (
					<button
						type="button"
						className="text-muted-foreground hover:bg-accent aria-pressed:bg-accent aria-pressed:text-foreground focus-visible:ring-ring/50 flex h-7 w-6 cursor-grab touch-none items-center justify-center rounded-md outline-none focus-visible:ring-3"
						aria-label={t("dashboards.moveHandle", { title })}
						aria-describedby={`${id}-move-help`}
						aria-pressed={picked !== null}
						onKeyDown={onKeyDown}
						onBlur={() => {
							if (picked) {
								setPicked(null);
								onPreview(null);
							}
						}}
					>
						<GripVerticalIcon className="size-4" aria-hidden="true" />
					</button>
				) : null}
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<h2 id={`${id}-title`} className="truncate text-sm font-semibold">
						{title}
					</h2>
					{title !== widget.label && widget.shape === "funnel" ? (
						<span className="text-muted-foreground shrink-0 text-xs">{widget.label}</span>
					) : null}
					{widget.range && answer ? (
						<span className="text-muted-foreground truncate text-xs">
							{t("dashboards.ownDays", { days: daysText(answer.range) })}
						</span>
					) : null}
				</div>
				{arranging ? (
					<div className="flex items-center gap-0.5" onPointerDown={(event) => event.stopPropagation()}>
						<Button
							variant="ghost"
							size="icon-xs"
							className="text-muted-foreground"
							aria-label={t("dashboards.widgetSettings", { title })}
							aria-pressed={selected}
							title={t("dashboards.widgetSettings", { title })}
							onClick={onSettings}
						>
							<SlidersHorizontalIcon aria-hidden="true" />
						</Button>
						<Button
							variant="ghost"
							size="icon-xs"
							className="text-muted-foreground"
							aria-label={t("dashboards.removeNamed", { title })}
							title={t("dashboards.removeNamed", { title })}
							onClick={onRemove}
						>
							<XIcon aria-hidden="true" />
						</Button>
					</div>
				) : (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon-xs"
									className="text-muted-foreground"
									aria-label={t("dashboards.widgetMenu", { title })}
								/>
							}
						>
							<EllipsisIcon aria-hidden="true" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-auto min-w-44">
							{data && hasChart(data.shape) ? (
								<DropdownMenuItem onClick={() => setAsTable((before) => !before)}>
									{asTable ? <TrendingUpIcon aria-hidden="true" /> : <TableIcon aria-hidden="true" />}
									{t(asTable ? "dashboards.showChart" : "dashboards.showTable")}
								</DropdownMenuItem>
							) : null}
							<DropdownMenuItem onClick={exportOne}>
								<DownloadIcon aria-hidden="true" />
								{t("dashboards.exportWidget")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</header>
			{arranging ? (
				<p id={`${id}-move-help`} className="sr-only">
					{t("dashboards.moveHelp")}
				</p>
			) : null}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-5 pb-5">
				{failed ? (
					<p className="text-muted-foreground text-sm">{t("dashboards.problems.generic")}</p>
				) : !answer ? (
					<WidgetLoading />
				) : data && hasSomething(data) ? (
					<WidgetBody
						data={data}
						before={before}
						asTable={asTable}
						title={title}
						versus={t("dashboards.versus", { days })}
						nowLabel={widget.range ? daysText(answer.range) : nowLabel}
						beforeLabel={t("dashboards.daysBefore", { days })}
					/>
				) : data && neverCounted ? (
					<WidgetState icon="nothing">
						<span className="text-foreground block font-medium">{t("dashboards.nothingCountedYet")}</span>
						<span className="block">{t("dashboards.countingStarts")}</span>
					</WidgetState>
				) : data ? (
					<WidgetState icon="nothing">{t("dashboards.nothingInRange")}</WidgetState>
				) : problem === "MODULE_NOT_RUNNING" ? (
					<WidgetState icon="module">
						{t("dashboards.needsModule")}
						<span className="sr-only"> {t("dashboards.problems.MODULE_NOT_RUNNING")}</span>
					</WidgetState>
				) : (
					<ProblemText code={problem ?? ""} />
				)}
			</div>
			{answer?.countedFrom || (answer?.sites && answer.sites.counted < answer.sites.of) ? (
				<footer className="text-muted-foreground -mt-2 grid gap-1 px-5 pb-4 text-xs">
					{answer.sites && answer.sites.counted < answer.sites.of ? (
						<p>{t("dashboards.sitesCounted", { counted: answer.sites.counted, of: answer.sites.of })}</p>
					) : null}
					{answer.countedFrom ? (
						<p>{t("dashboards.countedFrom", { day: new Date(answer.countedFrom).toISOString().slice(0, 10) })}</p>
					) : null}
				</footer>
			) : null}
			{arranging ? (
				<>
					<span
						aria-hidden="true"
						className="absolute inset-y-4 end-0 hidden w-3 cursor-ew-resize touch-none items-center justify-center @2xl/page:flex"
						onPointerDown={(event) => onResize(event, "width")}
					>
						<span
							className={cn(
								"h-9 w-1.5 rounded-[3px] transition-colors",
								readout ? "bg-primary" : "bg-muted-foreground opacity-0 group-hover/card:opacity-100",
							)}
						/>
					</span>
					<span
						aria-hidden="true"
						className="absolute inset-x-4 bottom-0 hidden h-3 cursor-ns-resize touch-none items-center justify-center @2xl/page:flex"
						onPointerDown={(event) => onResize(event, "height")}
					>
						<span
							className={cn(
								"h-1.5 w-9 rounded-[3px] transition-colors",
								readout ? "bg-primary" : "bg-muted-foreground opacity-0 group-hover/card:opacity-100",
							)}
						/>
					</span>
					<span
						aria-hidden="true"
						className="text-muted-foreground hover:text-primary absolute -end-0.5 -bottom-0.5 hidden cursor-nwse-resize touch-none p-1 @2xl/page:block"
						onPointerDown={(event) => onResize(event, "both")}
					>
						<svg width="10" height="10" viewBox="0 0 10 10" className="rtl:-scale-x-100" aria-hidden="true">
							<path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" strokeWidth="1.5" />
						</svg>
					</span>
				</>
			) : null}
			{readout ? (
				<span
					role="status"
					className="bg-popover text-popover-foreground absolute start-0 -bottom-8 z-10 rounded-md border px-1.5 py-0.5 font-mono text-[0.6875rem] whitespace-nowrap shadow-sm"
				>
					{readout}
				</span>
			) : null}
		</li>
	);
}

const PROBLEMS = [
	"GOAL_NOT_FOUND",
	"FUNNEL_NOT_FOUND",
	"FUNNEL_STEPS_DIFFER",
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
