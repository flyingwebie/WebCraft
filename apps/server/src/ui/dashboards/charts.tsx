import { cn } from "@webcraft/ui/lib/utils.ts";
import { ChartColumnIcon, TrendingDownIcon, TrendingUpIcon, UnplugIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "use-intl";

import { useT } from "../i18n.tsx";
import { changeOf, percent, type WidgetData } from "./model.ts";

/**
 * The charts every Widget is drawn with (SPEC 14.2): a number is a stat tile with its change, lines
 * over time are 2 px with a ringed dot at the end and a faint wash under the first, the period before
 * is grey, lists are ranked rows with a bar, shares of a whole a thin split bar beside a list, a
 * Funnel its steps with bars and shares. Series take the chart tokens in their fixed order; text never
 * takes a series colour, and colour never carries meaning alone: a second line is dashed as well.
 */

type Series = Extract<WidgetData, { shape: "series" }>;
type Numbers = Extract<WidgetData, { shape: "number" }>;
type Rows = Extract<WidgetData, { shape: "table" }>;
type Funnel = Extract<WidgetData, { shape: "funnel" }>;

/** A series' colour, in the fixed order of SPEC 14.2. */
export function seriesColor(index: number): string {
	return `var(--series-${(index % 6) + 1})`;
}

/** A line's dash beside its colour, so lines are never told apart by colour alone. The first is solid. */
const DASHES = [undefined, "6 4", "2 3", "10 3 2 3", "4 2", "1 3"] as const;
function dashOf(index: number): string | undefined {
	return DASHES[index % DASHES.length];
}

/** Numbers as the admin writes them; a count of ten thousand and more shortened: 12.5K. */
export function useNumbers() {
	const locale = useLocale();
	return useMemo(() => {
		const whole = new Intl.NumberFormat(locale);
		const short = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
		const signed = new Intl.NumberFormat(locale, {
			style: "percent",
			maximumFractionDigits: 1,
			minimumFractionDigits: 1,
			signDisplay: "exceptZero",
		});
		const share = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
		return {
			whole: (value: number) => whole.format(value),
			count: (value: number) => (Math.abs(value) >= 10_000 ? short.format(value) : whole.format(value)),
			change: (value: number) => signed.format(value),
			share: (value: number) => share.format(value),
		};
	}, [locale]);
}

/** A day as "14 Oct", or an hour as "14:00" (UTC, as the admin counts). */
export function useDayText() {
	const locale = useLocale();
	return useMemo(() => {
		const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
		return (start: Date | string, hourly: boolean) => {
			const date = new Date(start);
			if (hourly) return date.toISOString().slice(11, 16);
			const parts = day.formatToParts(date);
			const of = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
			return `${of("day")} ${of("month").replace(/\.$/, "")}`;
		};
	}, [locale]);
}

/** A short line in a series' colour and dash, as the legend and the readout show it. */
export function Swatch({ color, dash }: { color: string; dash?: string }) {
	return (
		<svg width="14" height="8" aria-hidden="true" className="shrink-0">
			<line x1="0" x2="14" y1="4" y2="4" stroke={color} strokeWidth={2} strokeDasharray={dash} />
		</svg>
	);
}

/** How a count changed on the period before, in a table's cell: the arrow and the signed share ("–" with nothing before). */
export function ChangeCell({ now, before }: { now: number; before: number }) {
	const numbers = useNumbers();
	const change = changeOf(now, before);
	if (change === null) return <span className="text-muted-foreground">–</span>;
	const Icon = change < 0 ? TrendingDownIcon : TrendingUpIcon;
	return (
		<span className="inline-flex items-center gap-1.5">
			<Icon aria-hidden="true" className={cn("size-3.5", change < 0 ? "text-series-critical" : "text-series-good")} />
			<span className="font-medium tabular-nums">{numbers.change(change)}</span>
		</span>
	);
}

/** How a count changed on the period before: the arrow, the signed share, and what it is compared with. */
function Change({ now, before, versus }: { now: number; before: number; versus: string }) {
	const numbers = useNumbers();
	const t = useT();
	const change = changeOf(now, before);
	if (change === null) {
		return <p className="text-muted-foreground mt-1.5 text-xs">{t("dashboards.nothingBefore")}</p>;
	}
	const Icon = change < 0 ? TrendingDownIcon : TrendingUpIcon;
	return (
		<p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs">
			<Icon aria-hidden="true" className={cn("size-3.5", change < 0 ? "text-series-critical" : "text-series-good")} />
			<span className="font-medium tabular-nums">{numbers.change(change)}</span>
			<span className="text-muted-foreground">{versus}</span>
		</p>
	);
}

/**
 * Numbers as stat tiles: the label, the number (a rate as its share, with its two counts under it),
 * and, comparing, how it changed on the period before.
 */
export function StatTiles({ data, before, versus }: { data: Numbers; before: Numbers | null; versus: string }) {
	const t = useT();
	const numbers = useNumbers();
	return (
		<dl className="grid grid-cols-2 gap-x-8 gap-y-5 @xl/widget:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
			{data.values.map((value) => {
				const then = before?.values.find((each) => each.key === value.key);
				const rate = value.of !== null && value.of !== undefined;
				return (
					<div key={value.key} className="min-w-0">
						<dt className="text-muted-foreground truncate text-[0.8125rem]">{value.label}</dt>
						<dd className="mt-1.5">
							<span className="flex items-end gap-2.5">
								<span className="block text-[1.75rem] leading-[2.125rem] font-semibold tracking-[-0.025rem] tabular-nums">
									{rate ? (percent(value.count, value.of ?? 0) ?? "–") : numbers.whole(value.count)}
								</span>
								{value.points && value.points.length > 1 ? <Spark points={value.points} /> : null}
							</span>
							{rate ? (
								<span className="text-muted-foreground block text-xs">
									{t("dashboards.rateOf", { count: numbers.whole(value.count), of: numbers.whole(value.of ?? 0) })}
								</span>
							) : null}
							{then ? (
								<Change
									now={rate ? value.count / Math.max(1, value.of ?? 0) : value.count}
									before={rate ? then.count / Math.max(1, then.of ?? 0) : then.count}
									versus={versus}
								/>
							) : null}
						</dd>
					</div>
				);
			})}
		</dl>
	);
}

/**
 * A number's small trend: its counts hour by hour or day by day over the range, the earlier part grey
 * and the latest part in the first series colour. Only a picture: the number beside it is the figure,
 * and "Show as a table" gives the counts.
 */
function Spark({ points }: { points: readonly number[] }) {
	const width = 96;
	const height = 28;
	const max = Math.max(...points);
	const min = Math.min(...points);
	const x = (index: number) => (index / (points.length - 1)) * (width - 6) + 3;
	const y = (value: number) => 3 + (height - 6) - ((value - min) / (max - min || 1)) * (height - 6);
	const cut = Math.floor(points.length * 0.6);
	const path = (from: number, to: number) =>
		points
			.slice(from, to + 1)
			.map((value, index) => `${index === 0 ? "M" : "L"} ${x(from + index).toFixed(1)} ${y(value).toFixed(1)}`)
			.join(" ");
	return (
		// 96 by 28 where there is room; narrower in a narrow tile, never wider than its tile.
		<svg
			viewBox={`0 0 ${width} ${height}`}
			preserveAspectRatio="none"
			aria-hidden="true"
			className="ms-auto mb-1 h-7 w-full max-w-24 min-w-0"
			data-spark=""
		>
			<path
				d={path(0, cut)}
				fill="none"
				stroke="var(--series-before)"
				strokeWidth="2"
				strokeLinejoin="round"
				strokeLinecap="round"
				vectorEffect="non-scaling-stroke"
			/>
			<path
				d={path(cut, points.length - 1)}
				fill="none"
				stroke="var(--series-1)"
				strokeWidth="2"
				strokeLinejoin="round"
				strokeLinecap="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

/** A round top for the y axis: 1,600 becomes 2,000; 0 becomes 1. */
function niceMax(max: number): number {
	if (max <= 0) return 1;
	const step = 10 ** Math.floor(Math.log10(max));
	const half = step / 2;
	return Math.max(1, Math.ceil(max / half) * half);
}

function isHourly(points: Series["points"]): boolean {
	const [first, second] = points;
	return (
		first !== undefined &&
		second !== undefined &&
		new Date(second.start).getTime() - new Date(first.start).getTime() < 86_400_000
	);
}

/** The size of an element, as it changes. */
function useSize<Element extends HTMLElement>() {
	const ref = useRef<Element>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => {
			const box = element.getBoundingClientRect();
			setSize((before) =>
				Math.round(before.width) === Math.round(box.width) && Math.round(before.height) === Math.round(box.height)
					? before
					: { width: box.width, height: box.height },
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return { ref, ...size };
}

/**
 * Lines over time: one y axis with solid hairlines, the first line washed faintly underneath, the
 * period before in grey, a legend for two lines or more (or when comparing), and under the pointer one
 * readout listing every line at that day. The same readout moves with the arrow keys once the chart
 * has focus, so a keyboard reaches every point too.
 */
export function LineChart({
	data,
	before,
	title,
	nowLabel,
	beforeLabel,
}: {
	data: Series;
	before: Series | null;
	title: string;
	/** What the range is called ("Last 30 days"), for the legend when one line is compared. */
	nowLabel: string;
	/** What the period before is called ("The 30 days before"). */
	beforeLabel: string;
}) {
	const t = useT();
	const numbers = useNumbers();
	const dayText = useDayText();
	const id = useId();
	const { ref, width, height } = useSize<HTMLDivElement>();
	const [active, setActive] = useState<number | null>(null);
	const hourly = isHourly(data.points);
	const one = data.lines.length === 1;
	const comparing = before !== null;
	const valueAt = (series: Series | null, index: number, key: string) => series?.points[index]?.values[key] ?? 0;
	const top = niceMax(
		Math.max(
			0,
			...data.points.flatMap((_, index) =>
				data.lines.flatMap((line) => [
					valueAt(data, index, line.key),
					comparing ? valueAt(before, index, line.key) : 0,
				]),
			),
		),
	);
	const ticks = [top, top / 2, 0];
	const tickText = ticks.map((tick) => numbers.count(tick));
	const pad = { top: 6, right: 6, bottom: 22, left: 38 };
	const plotWidth = Math.max(1, width - pad.left - pad.right);
	const plotHeight = Math.max(1, height - pad.top - pad.bottom);
	const count = data.points.length;
	const xOf = (index: number) => pad.left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
	const yOf = (value: number) => pad.top + (1 - value / top) * plotHeight;
	const pathOf = (series: Series, key: string) =>
		series.points
			.map((_, index) => `${index === 0 ? "M" : "L"}${xOf(index)},${yOf(valueAt(series, index, key))}`)
			.join(" ");
	const labels = count === 0 ? [] : [...new Set([0, Math.floor((count - 1) / 2), count - 1])];
	const first = data.points[0];
	const last = data.points.at(-1);
	const summary = t("dashboards.chartSummary", {
		lines: data.lines.map((line) => line.label).join(", "),
		interval: t(hourly ? "dashboards.intervals.hour" : "dashboards.intervals.day"),
		from: first ? dayText(first.start, hourly) : "",
		to: last ? dayText(last.start, hourly) : "",
		max: numbers.whole(
			Math.max(0, ...data.points.flatMap((point) => data.lines.map((line) => point.values[line.key] ?? 0))),
		),
	});
	const legend = !one || comparing;
	const lineName = (label: string) => (one && comparing ? nowLabel : label);
	const beforeName = (label: string) => (one ? beforeLabel : t("dashboards.lineBefore", { line: label }));

	const pointAt = (clientX: number) => {
		const box = ref.current?.getBoundingClientRect();
		if (!box || count === 0) return null;
		const x = clientX - box.left - pad.left;
		return Math.min(count - 1, Math.max(0, Math.round((x / plotWidth) * (count - 1))));
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (count === 0) return;
		const rtl = document.documentElement.dir === "rtl";
		const at = active ?? count - 1;
		const next =
			event.key === "ArrowLeft"
				? at + (rtl ? 1 : -1)
				: event.key === "ArrowRight"
					? at + (rtl ? -1 : 1)
					: event.key === "Home"
						? 0
						: event.key === "End"
							? count - 1
							: null;
		if (next === null) return;
		event.preventDefault();
		setActive(Math.min(count - 1, Math.max(0, next)));
	};
	const point = active === null ? null : data.points[active];
	/** What the readout says at a point, for screen readers: the day, then every line's count. */
	const valueText = (index: number) => {
		const at = data.points[index];
		if (!at) return "";
		const lines = data.lines.map((line) => `${line.label} ${numbers.whole(valueAt(data, index, line.key))}`);
		const then = comparing
			? data.lines.map(
					(line) =>
						`${one ? t("dashboards.before") : t("dashboards.lineBefore", { line: line.label })} ${numbers.whole(valueAt(before, index, line.key))}`,
				)
			: [];
		return `${dayText(at.start, hourly)}: ${[...lines, ...then].join(", ")}`;
	};
	const readoutLeft = active === null ? 0 : xOf(active);
	const flip = readoutLeft > width * 0.6;

	return (
		<figure className="flex h-full min-h-44 flex-col gap-3">
			{legend ? (
				<figcaption>
					<ul className="text-muted-foreground flex flex-wrap gap-x-3.5 gap-y-1 text-xs">
						{data.lines.map((line, index) => (
							<li key={line.key} className="flex items-center gap-1.5">
								<Swatch color={seriesColor(index)} dash={dashOf(index)} />
								{lineName(line.label)}
							</li>
						))}
						{comparing
							? (one ? data.lines.slice(0, 1) : data.lines).map((line, index) => (
									<li key={`before-${line.key}`} className="flex items-center gap-1.5">
										<Swatch color="var(--series-before)" dash={dashOf(index) ?? "3 2"} />
										{beforeName(line.label)}
									</li>
								))
							: null}
					</ul>
				</figcaption>
			) : null}
			<div
				ref={ref}
				role="slider"
				tabIndex={0}
				aria-label={`${title}. ${summary}`}
				aria-describedby={`${id}-help`}
				aria-orientation="horizontal"
				aria-valuemin={1}
				aria-valuemax={Math.max(1, count)}
				aria-valuenow={(active ?? Math.max(0, count - 1)) + 1}
				aria-valuetext={valueText(active ?? count - 1)}
				className="focus-visible:ring-ring/50 relative min-h-36 flex-1 rounded-sm outline-none focus-visible:ring-3"
				onPointerMove={(event) => setActive(pointAt(event.clientX))}
				onPointerLeave={() => setActive(null)}
				onFocus={() => setActive((before) => before ?? (count > 0 ? count - 1 : null))}
				onBlur={() => setActive(null)}
				onKeyDown={onKeyDown}
			>
				<span id={`${id}-help`} className="sr-only">
					{t("dashboards.readoutHelp")}
				</span>
				{width > 0 && height > 0 ? (
					<svg width={width} height={height} className="absolute inset-0 overflow-visible" aria-hidden="true">
						{ticks.map((tick, index) => (
							<g key={tick}>
								<line
									x1={pad.left}
									x2={width - pad.right}
									y1={yOf(tick)}
									y2={yOf(tick)}
									stroke="var(--border)"
									strokeWidth={1}
									shapeRendering="crispEdges"
								/>
								<text x={pad.left - 8} y={yOf(tick) + 4} textAnchor="end" fontSize="11" fill="var(--muted-foreground)">
									{tickText[index]}
								</text>
							</g>
						))}
						{labels.map((index) => {
							const start = data.points[index]?.start;
							if (start === undefined) return null;
							const anchor = index === 0 ? "start" : index === count - 1 ? "end" : "middle";
							return (
								<text
									key={index}
									x={xOf(index)}
									y={height - 4}
									textAnchor={count <= 1 ? "middle" : anchor}
									fontSize="11"
									fill="var(--muted-foreground)"
								>
									{dayText(start, hourly)}
								</text>
							);
						})}
						{count > 1 && data.lines[0] ? (
							<path
								d={`${pathOf(data, data.lines[0].key)} L${xOf(count - 1)},${yOf(0)} L${xOf(0)},${yOf(0)} Z`}
								fill="var(--series-wash)"
							/>
						) : null}
						{comparing
							? data.lines.map((line, index) => (
									<path
										key={`before-${line.key}`}
										d={pathOf(before, line.key)}
										fill="none"
										stroke="var(--series-before)"
										strokeWidth={2}
										strokeDasharray={dashOf(index)}
										strokeLinejoin="round"
									/>
								))
							: null}
						{data.lines.map((line, index) => (
							<path
								key={line.key}
								d={pathOf(data, line.key)}
								fill="none"
								stroke={seriesColor(index)}
								strokeWidth={2}
								strokeDasharray={dashOf(index)}
								strokeLinejoin="round"
								strokeLinecap="round"
							/>
						))}
						{active === null && count > 0
							? data.lines.map((line, index) => (
									<circle
										key={`end-${line.key}`}
										cx={xOf(count - 1)}
										cy={yOf(valueAt(data, count - 1, line.key))}
										r={4}
										fill={seriesColor(index)}
										stroke="var(--card)"
										strokeWidth={2}
									/>
								))
							: null}
						{active !== null ? (
							<g>
								<line
									x1={xOf(active)}
									x2={xOf(active)}
									y1={pad.top}
									y2={yOf(0)}
									stroke="var(--muted-foreground)"
									strokeWidth={1}
									shapeRendering="crispEdges"
								/>
								{data.lines.map((line, index) => (
									<circle
										key={`at-${line.key}`}
										cx={xOf(active)}
										cy={yOf(valueAt(data, active, line.key))}
										r={4}
										fill={seriesColor(index)}
										stroke="var(--card)"
										strokeWidth={2}
									/>
								))}
							</g>
						) : null}
					</svg>
				) : null}
				{point ? (
					<div
						aria-hidden="true"
						className="bg-popover text-popover-foreground pointer-events-none absolute top-1 z-10 w-33 rounded-lg border p-2.5 text-xs shadow-md"
						style={flip ? { right: width - readoutLeft + 8 } : { left: readoutLeft + 8 }}
					>
						<p className="text-muted-foreground mb-1.5 text-[0.6875rem] font-semibold">
							{dayText(point.start, hourly)}
						</p>
						<ul className="grid gap-1.5">
							{data.lines.map((line, index) => (
								<li key={line.key} className="flex items-center gap-2">
									<Swatch color={seriesColor(index)} dash={dashOf(index)} />
									<span className="flex-1">{line.label}</span>
									<span className="font-medium tabular-nums">
										{numbers.whole(valueAt(data, active ?? 0, line.key))}
									</span>
								</li>
							))}
							{comparing
								? data.lines.map((line, index) => (
										<li key={`before-${line.key}`} className="text-muted-foreground flex items-center gap-2">
											<Swatch color="var(--series-before)" dash={dashOf(index)} />
											<span className="flex-1">
												{one ? t("dashboards.before") : t("dashboards.lineBefore", { line: line.label })}
											</span>
											<span className="tabular-nums">{numbers.whole(valueAt(before, active ?? 0, line.key))}</span>
										</li>
									))
								: null}
						</ul>
					</div>
				) : null}
			</div>
		</figure>
	);
}

/** The cell's words: a source, a country, a device as people say them. */
export function useCellText() {
	const t = useT();
	const locale = useLocale();
	const regions = useMemo(() => {
		try {
			return new Intl.DisplayNames([locale, "en"], { type: "region" });
		} catch {
			return null;
		}
	}, [locale]);
	return (kind: string, value: string): string => {
		if (kind === "source") return value === "" ? t("dashboards.direct") : value;
		if (kind === "country") return value === "" ? t("dashboards.unknown") : (regions?.of(value) ?? value);
		if (kind === "device") {
			return value === "desktop" || value === "mobile" || value === "tablet"
				? t(`dashboards.devices.${value}`)
				: value || t("dashboards.unknown");
		}
		return value;
	};
}

/** A bar's fill in its track, rounded at the data end. */
export function Bar({
	share,
	className,
	fill = "rounded-s-[2px] rounded-e-[4px]",
	color = "var(--series-1)",
}: {
	share: number;
	className?: string;
	fill?: string;
	color?: string;
}) {
	return (
		<span aria-hidden="true" className={cn("bg-muted flex overflow-hidden", className)}>
			<span
				className={cn("block h-full", fill)}
				style={{ width: `${Math.max(share > 0 ? 1.5 : 0, Math.min(1, share) * 100)}%`, background: color }}
			/>
		</span>
	);
}

/**
 * A list as ranked rows: the name, a bar for its count beside the biggest, and the count. A list with
 * a rate (Goals) shows its count, a small bar for the rate and the rate; devices are a thin split bar
 * over the list of their shares.
 */
export function RankedRows({ data, title }: { data: Rows; title: string }) {
	const numbers = useNumbers();
	const cellText = useCellText();
	const name = data.columns.find((column) => column.kind !== "count" && column.kind !== "rate");
	const count = data.columns.find((column) => column.kind === "count");
	const rate = data.columns.find((column) => column.kind === "rate");
	const countOf = (row: Rows["rows"][number]) => Number(count ? (row.cells[count.key] ?? 0) : 0);
	const nameOf = (row: Rows["rows"][number]) =>
		cellText(name?.kind ?? "text", String(name ? (row.cells[name.key] ?? "") : ""));
	if (name?.kind === "device") return <SplitList data={data} title={title} countOf={countOf} nameOf={nameOf} />;
	if (rate) {
		return (
			<ul aria-label={title} className="grid gap-1 text-xs">
				{data.rows.map((row) => {
					const cell = row.cells[rate.key];
					const share = typeof cell === "object" && cell !== null && cell.of > 0 ? cell.count / cell.of : 0;
					return (
						<li
							key={row.key}
							className="grid h-[1.125rem] grid-cols-[minmax(0,1fr)_2.5rem_2.25rem_1.75rem] items-center gap-x-2"
						>
							<span className="truncate">{nameOf(row)}</span>
							<span className="text-end text-[0.6875rem] font-medium tabular-nums">{numbers.whole(countOf(row))}</span>
							<Bar share={share} className="h-1.5 rounded-[3px]" fill="rounded-[3px]" />
							<span className="text-muted-foreground text-[0.6875rem] tabular-nums">
								{typeof cell === "object" && cell !== null && cell.of > 0 ? numbers.share(cell.count / cell.of) : "–"}
							</span>
						</li>
					);
				})}
			</ul>
		);
	}
	const max = Math.max(1, ...data.rows.map(countOf));
	return (
		<ol aria-label={title} className="grid gap-2.5 text-[0.8125rem]">
			{data.rows.map((row) => (
				<li
					key={row.key}
					className="grid h-5 grid-cols-[minmax(0,5.625rem)_minmax(0,1fr)_2.75rem] items-center gap-x-2.5 @sm/widget:grid-cols-[minmax(0,8.125rem)_minmax(0,1fr)_2.75rem]"
				>
					<span className="truncate" title={nameOf(row)}>
						{nameOf(row)}
					</span>
					<Bar share={countOf(row) / max} className="h-2 rounded-[4px]" />
					<span className="text-end text-xs font-medium tabular-nums">{numbers.count(countOf(row))}</span>
				</li>
			))}
		</ol>
	);
}

/** Shares of a whole: a thin split bar in the series colours, over the list that names each share. */
function SplitList({
	data,
	title,
	countOf,
	nameOf,
}: {
	data: Rows;
	title: string;
	countOf: (row: Rows["rows"][number]) => number;
	nameOf: (row: Rows["rows"][number]) => string;
}) {
	const numbers = useNumbers();
	const total = data.rows.reduce((sum, row) => sum + countOf(row), 0);
	return (
		<div className="grid gap-3">
			<div aria-hidden="true" className="flex h-2 gap-0.5">
				{data.rows.map((row, index) => (
					<span
						key={row.key}
						className="block h-full rounded-full"
						style={{ width: `${total > 0 ? (countOf(row) / total) * 100 : 0}%`, background: seriesColor(index) }}
					/>
				))}
			</div>
			<ul aria-label={title} className="grid gap-1 text-xs">
				{data.rows.map((row, index) => (
					<li key={row.key} className="flex h-4 items-center gap-2">
						<span
							aria-hidden="true"
							className="size-2 shrink-0 rounded-[2px]"
							style={{ background: seriesColor(index) }}
						/>
						<span className="min-w-0 flex-1 truncate">{nameOf(row)}</span>
						<span className="font-medium tabular-nums">{total > 0 ? numbers.share(countOf(row) / total) : "–"}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/** A Funnel: its steps in order, each with a bar for the visitors who reached it, the count and the share of the first. */
export function FunnelSteps({ data, title }: { data: Funnel; title: string }) {
	const t = useT();
	const numbers = useNumbers();
	const first = data.steps[0]?.count ?? 0;
	return (
		<ol aria-label={title} className="grid gap-3 text-[0.8125rem]">
			{data.steps.map((step, index) => (
				<li
					// biome-ignore lint/suspicious/noArrayIndexKey: a Funnel's steps are in a fixed order.
					key={index}
					className="grid h-6 grid-cols-[1.25rem_minmax(0,9.125rem)_minmax(0,1fr)_3rem_3rem] items-center gap-x-3"
				>
					<span
						aria-hidden="true"
						className="bg-muted text-muted-foreground flex size-5 items-center justify-center rounded-full text-[0.6875rem] font-semibold tabular-nums"
					>
						{index + 1}
					</span>
					<span className="truncate">
						<span className="sr-only">{t("dashboards.funnelStepN", { n: index + 1 })}: </span>
						{step.label}
					</span>
					<Bar share={first > 0 ? step.count / first : 0} className="h-6 rounded-[5px]" fill="rounded-e-[4px]" />
					<span className="text-end font-medium tabular-nums">{numbers.whole(step.count)}</span>
					<span className="text-muted-foreground text-end text-xs tabular-nums">
						{first > 0 ? numbers.share(step.count / first) : "–"}
					</span>
				</li>
			))}
		</ol>
	);
}

/** A Widget still counting: grey blocks where its numbers will be. */
export function WidgetLoading() {
	const t = useT();
	return (
		<div className="grid gap-3">
			<span className="sr-only">{t("dashboards.loading")}</span>
			<span aria-hidden="true" className="bg-muted block h-6 w-2/5 rounded-md" />
			<span aria-hidden="true" className="bg-muted block h-2.5 w-full rounded-full" />
			<span aria-hidden="true" className="bg-muted block h-2.5 w-full rounded-full" />
			<span aria-hidden="true" className="bg-muted block h-2.5 w-3/4 rounded-full" />
		</div>
	);
}

/** A Widget with nothing to show: an icon and one line, in the middle of it. */
export function WidgetState({ icon, children }: { icon: "nothing" | "module"; children: ReactNode }) {
	const Icon = icon === "nothing" ? ChartColumnIcon : UnplugIcon;
	return (
		<div className="text-muted-foreground flex h-full min-h-20 flex-col items-center justify-center gap-2 text-center text-sm">
			<Icon aria-hidden="true" className="size-4" />
			<p>{children}</p>
		</div>
	);
}
