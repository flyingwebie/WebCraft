/**
 * What a Dashboard is made of (#103, GLOSSARY.md): its range, and its Widgets on a grid of
 * `GRID_COLUMNS` columns, each with its kind, its place and size, its own range (or the
 * Dashboard's), its filters and its settings. Kept as JSON with the Dashboard (`StoredWidget`).
 */
import type { WidgetCell, WidgetData, WidgetFilters } from "@webcraft/module-sdk";
import { z } from "zod";

/** The grid's columns. */
export const GRID_COLUMNS = 12;
/** A Widget's smallest and largest size, in grid cells. */
export const WIDGET_SIZE = { min: 2, maxWidth: GRID_COLUMNS, maxHeight: 12 } as const;
/** How many Widgets one Dashboard holds. */
export const MAX_WIDGETS = 40;
/** How many Dashboards one Site or Workspace has, and how many templates one Workspace keeps. */
export const MAX_DASHBOARDS = 50;
export const MAX_TEMPLATES = 50;
/** How many rows a table Widget shows. */
export const WIDGET_ROWS = [5, 10, 20, 50] as const;
/** How long a note Widget's text may be. */
export const NOTE_MAX_LENGTH = 2000;
/** The longest custom range, in days (ten years). */
export const MAX_RANGE_DAYS = 3660;

/** The kind of the note Widget WebCraft itself adds: Staff's own words on a Dashboard. */
export const NOTE_KIND = "note";

export const RANGE_PRESETS = [
	"today",
	"yesterday",
	"last7Days",
	"last30Days",
	"last90Days",
	"thisMonth",
	"lastMonth",
	"last12Months",
] as const;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A day is written YYYY-MM-DD.");

/** A Dashboard's or Widget's range: a moving one (`last30Days`), or two days (both counted, UTC). */
export const dashboardRangeSchema = z.union([
	z.object({ preset: z.enum(RANGE_PRESETS) }).strict(),
	z.object({ preset: z.literal("custom"), from: day, to: day }).strict(),
]);

export type DashboardRange = z.infer<typeof dashboardRangeSchema>;

export const DEFAULT_RANGE: DashboardRange = { preset: "last30Days" };

/** A Widget's filters, as people give them (see `WidgetFilters` in the Module SDK). */
export const widgetFiltersSchema = z
	.object({
		page: z
			.object({
				path: z.string().trim().min(1).max(1000).startsWith("/"),
				match: z.enum(["exact", "prefix"]).default("exact"),
			})
			.optional(),
		source: z.string().trim().toLowerCase().max(200).optional(),
		country: z
			.string()
			.trim()
			.regex(/^(?:[A-Za-z]{2})?$/, "A country is its two-letter code.")
			.toUpperCase()
			.optional(),
		device: z.enum(["desktop", "mobile", "tablet"]).optional(),
		goal: z.string().trim().min(1).max(100).optional(),
	})
	.strict();

/** A Widget's settings, by key: one value, or several. */
export const widgetSettingsSchema = z.record(
	z.string().max(40),
	z.union([z.string().max(NOTE_MAX_LENGTH), z.array(z.string().max(200)).max(100)]),
);

/** A Widget as a Dashboard keeps it. */
export type StoredWidget = {
	id: string;
	/** `note`, or a Module's kind: `<module id>:<kind>`, such as `site-analytics:totals`. */
	kind: string;
	/** Staff's own title, or null for the kind's name. */
	title: string | null;
	x: number;
	y: number;
	w: number;
	h: number;
	/** Its own range, or null to show the Dashboard's. */
	range: DashboardRange | null;
	filters: WidgetFilters;
	settings: Record<string, string | string[]>;
	/** How many rows a table shows. */
	rows: number;
};

const storedWidgetSchema = z.object({
	id: z.string(),
	kind: z.string(),
	title: z.string().nullable(),
	x: z.number().int(),
	y: z.number().int(),
	w: z.number().int(),
	h: z.number().int(),
	range: dashboardRangeSchema.nullable(),
	filters: widgetFiltersSchema,
	settings: widgetSettingsSchema,
	rows: z.number().int(),
});

/** A Dashboard's Widgets as stored (a Widget that no longer reads is left out). */
export function storedWidgets(json: unknown): StoredWidget[] {
	if (!Array.isArray(json)) return [];
	return json.flatMap((each) => {
		const parsed = storedWidgetSchema.safeParse(each);
		return parsed.success ? [parsed.data as StoredWidget] : [];
	});
}

export function storedRange(json: unknown): DashboardRange {
	const parsed = dashboardRangeSchema.safeParse(json);
	return parsed.success ? parsed.data : DEFAULT_RANGE;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a range covers now: whole UTC days, and how a series counts them (by hour up to two days). */
export type ResolvedRange = { from: Date; to: Date; interval: "hour" | "day" };

/** The days a range covers at `now`: moving ones end with today (UTC); custom ones are fixed. */
export function resolveRange(range: DashboardRange, now: Date): ResolvedRange {
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const month = (offset: number) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1);
	const days = (back: number) => ({ from: today - back * DAY_MS, to: today + DAY_MS });
	const span = (): { from: number; to: number } => {
		switch (range.preset) {
			case "today":
				return days(0);
			case "yesterday":
				return { from: today - DAY_MS, to: today };
			case "last7Days":
				return days(6);
			case "last30Days":
				return days(29);
			case "last90Days":
				return days(89);
			case "thisMonth":
				return { from: month(0), to: month(1) };
			case "lastMonth":
				return { from: month(-1), to: month(0) };
			case "last12Months":
				return { from: month(-11), to: month(1) };
			case "custom":
				return { from: Date.parse(`${range.from}T00:00:00Z`), to: Date.parse(`${range.to}T00:00:00Z`) + DAY_MS };
		}
	};
	const { from, to } = span();
	return { from: new Date(from), to: new Date(to), interval: to - from <= 2 * DAY_MS ? "hour" : "day" };
}

/** The problem with a custom range, or null: real days, the first not after the last, at most ten years. */
export function rangeProblem(range: DashboardRange): string | null {
	if (range.preset !== "custom") return null;
	const from = Date.parse(`${range.from}T00:00:00Z`);
	const to = Date.parse(`${range.to}T00:00:00Z`);
	const real = (text: string, at: number) => Number.isFinite(at) && new Date(at).toISOString().startsWith(text);
	if (!real(range.from, from) || !real(range.to, to)) return "A range's days must be real days (YYYY-MM-DD).";
	if (from > to) return "A range's first day comes before its last.";
	if ((to - from) / DAY_MS + 1 > MAX_RANGE_DAYS) return `A range covers at most ${MAX_RANGE_DAYS} days.`;
	return null;
}

/** A Widget's place and size on the grid. */
export type Rect = { x: number; y: number; w: number; h: number };

/** A size that fits the grid, at a place that keeps it on the grid. */
export function clampRect(rect: Rect): Rect {
	const w = Math.min(Math.max(Math.round(rect.w), WIDGET_SIZE.min), WIDGET_SIZE.maxWidth);
	const h = Math.min(Math.max(Math.round(rect.h), WIDGET_SIZE.min), WIDGET_SIZE.maxHeight);
	const x = Math.min(Math.max(Math.round(rect.x), 0), GRID_COLUMNS - w);
	const y = Math.max(Math.round(rect.y), 0);
	return { x, y, w, h };
}

function overlaps(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The first free place for a new Widget of this size: the topmost row, then the leftmost column. */
export function freePlace(widgets: readonly Rect[], size: { w: number; h: number }): Rect {
	const { w, h } = clampRect({ x: 0, y: 0, ...size });
	const bottom = widgets.reduce((most, widget) => Math.max(most, widget.y + widget.h), 0);
	for (let y = 0; y <= bottom; y++) {
		for (let x = 0; x + w <= GRID_COLUMNS; x++) {
			const rect = { x, y, w, h };
			if (!widgets.some((widget) => overlaps(widget, rect))) return rect;
		}
	}
	return { x: 0, y: bottom, w, h };
}

/**
 * Puts one Widget at a place and size, and moves every Widget it would cover down below it, and those
 * they would cover in turn: nothing else moves, so moving a Widget never shuffles the rest.
 */
export function placeWidget<Widget extends Rect & { id: string }>(
	widgets: readonly Widget[],
	id: string,
	rect: Rect,
): Widget[] {
	const moved = widgets.find((widget) => widget.id === id);
	if (!moved) return [...widgets];
	const placed: Widget[] = [{ ...moved, ...clampRect(rect) }];
	const rest = widgets
		.filter((widget) => widget.id !== id)
		.map((widget) => ({ ...widget }))
		.sort((a, b) => a.y - b.y || a.x - b.x);
	for (const widget of rest) {
		let blocker = placed.find((other) => overlaps(other, widget));
		while (blocker) {
			widget.y = blocker.y + blocker.h;
			blocker = placed.find((other) => overlaps(other, widget));
		}
		placed.push(widget);
	}
	return widgets.map((widget) => placed.find((each) => each.id === widget.id) ?? widget);
}

/** A Funnel-shaped answer, as one Site gives it. */
type FunnelAnswer = Extract<WidgetData, { shape: "funnel" }>;

/**
 * Whether a Workspace Widget's Funnel answers don't all share the same steps: each Site builds its
 * own Funnel of a name, matched across Sites by that name only, so two Sites' "same" Funnel can have
 * different steps (a step's label is its Goal's name or its path). When they differ, `addUp` must not
 * add them step by step (a later step of one Site would land under an earlier step's label of
 * another): the caller (`dashboards/index.ts`) checks this first and answers a problem instead.
 */
export function funnelStepsDiffer(answers: readonly WidgetData[]): boolean {
	const funnels = answers.filter((answer): answer is FunnelAnswer => answer.shape === "funnel");
	const [first, ...rest] = funnels;
	if (!first) return false;
	const labels = first.steps.map((step) => step.label);
	return rest.some(
		(answer) =>
			answer.steps.length !== labels.length || answer.steps.some((step, index) => step.label !== labels[index]),
	);
}

/**
 * Several Sites' answers for one Widget, added up (a Workspace Dashboard): counts add (visitors
 * Site by Site and day by day, as Site analytics counts them), a rate's two counts add, a table's rows
 * add by their key (then the biggest first, at most `limit`), a Funnel's steps add by their label (the
 * caller keeps mismatched Funnels, `funnelStepsDiffer`, from reaching here at all; matching by label
 * rather than position keeps this from quietly mixing one Site's step into another's here too).
 */
export function addUp(answers: readonly WidgetData[], limit: number): WidgetData | null {
	const [first] = answers;
	if (!first) return null;
	const countedFrom =
		answers
			.map((answer) => answer.countedFrom ?? null)
			.filter((at): at is Date => at !== null)
			.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
	switch (first.shape) {
		case "number": {
			const values = first.values.map((value) => ({ ...value, of: value.of }));
			for (const answer of answers.slice(1)) {
				if (answer.shape !== "number") continue;
				for (const value of answer.values) {
					const into = values.find((each) => each.key === value.key);
					if (!into) continue;
					into.count += value.count;
					if (into.of !== undefined) into.of += value.of ?? 0;
				}
			}
			return { shape: "number", values, countedFrom };
		}
		case "series": {
			const points = new Map<number, Record<string, number>>();
			for (const answer of answers) {
				if (answer.shape !== "series") continue;
				for (const point of answer.points) {
					const into = points.get(point.start.getTime()) ?? {};
					for (const [key, value] of Object.entries(point.values)) into[key] = (into[key] ?? 0) + value;
					points.set(point.start.getTime(), into);
				}
			}
			return {
				shape: "series",
				lines: first.lines,
				points: [...points].sort(([a], [b]) => a - b).map(([start, values]) => ({ start: new Date(start), values })),
				countedFrom,
			};
		}
		case "table": {
			const rows = new Map<string, Record<string, WidgetCell>>();
			for (const answer of answers) {
				if (answer.shape !== "table") continue;
				for (const row of answer.rows) {
					const into = rows.get(row.key);
					if (!into) {
						rows.set(row.key, { ...row.cells });
						continue;
					}
					for (const [key, cell] of Object.entries(row.cells)) into[key] = plusCell(into[key], cell);
				}
			}
			const sortBy = first.columns.find((column) => column.kind === "count")?.key;
			const sorted = [...rows]
				.map(([key, cells]) => ({ key, cells }))
				.sort((a, b) => (sortBy ? Number(b.cells[sortBy] ?? 0) - Number(a.cells[sortBy] ?? 0) : 0));
			return { shape: "table", columns: first.columns, rows: sorted.slice(0, limit), countedFrom };
		}
		case "funnel": {
			const steps = first.steps.map((step) => ({ ...step }));
			const indexByLabel = new Map(steps.map((step, index) => [step.label, index]));
			for (const answer of answers.slice(1)) {
				if (answer.shape !== "funnel") continue;
				for (const step of answer.steps) {
					const index = indexByLabel.get(step.label);
					const into = index === undefined ? undefined : steps[index];
					if (into) into.count += step.count;
				}
			}
			return { shape: "funnel", steps, countedFrom };
		}
	}
}

function plusCell(a: WidgetCell | undefined, b: WidgetCell): WidgetCell {
	if (typeof a === "number" && typeof b === "number") return a + b;
	if (typeof a === "object" && a !== null && typeof b === "object")
		return { count: a.count + b.count, of: a.of + b.of };
	return a ?? b;
}
