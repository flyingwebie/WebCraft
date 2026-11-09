import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { type ReactNode, useId, useMemo } from "react";
import { useLocale } from "use-intl";

import { useT } from "../i18n.tsx";
import { percent, type WidgetData } from "./model.ts";

/**
 * A Widget's data, drawn by its shape with WebCraft's own pieces (ADR 0024: no Module code runs in
 * the admin). Every chart has the same numbers as a table (`asTable`), and never says anything by
 * colour alone: lines differ by their dash and marker too, and every bar is labelled with its number.
 */
export function WidgetBody({ data, asTable, title }: { data: WidgetData; asTable: boolean; title: string }) {
	switch (data.shape) {
		case "note":
			return <p className="text-sm whitespace-pre-wrap">{data.text}</p>;
		case "number":
			return <Numbers data={data} />;
		case "series":
			return asTable ? <SeriesTable data={data} title={title} /> : <SeriesChart data={data} title={title} />;
		case "table":
			return <RowsTable data={data} title={title} />;
		case "funnel":
			return asTable ? <FunnelTable data={data} title={title} /> : <FunnelBars data={data} />;
	}
}

/** Whether a shape has a chart that can be shown as a table instead. */
export function hasChart(shape: WidgetData["shape"]): boolean {
	return shape === "series" || shape === "funnel";
}

function useNumber() {
	const locale = useLocale();
	return useMemo(() => new Intl.NumberFormat(locale), [locale]);
}

function Numbers({ data }: { data: Extract<WidgetData, { shape: "number" }> }) {
	const t = useT();
	const number = useNumber();
	return (
		<dl className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-4">
			{data.values.map((value) => (
				<div key={value.key} className="grid gap-1">
					<dt className="text-muted-foreground text-sm">{value.label}</dt>
					<dd className="text-2xl font-semibold tabular-nums">
						{value.of === null ? number.format(value.count) : (percent(value.count, value.of) ?? "–")}
						{value.of === null ? null : (
							<span className="text-muted-foreground block text-xs font-normal">
								{t("dashboards.rateOf", { count: number.format(value.count), of: number.format(value.of) })}
							</span>
						)}
					</dd>
				</div>
			))}
		</dl>
	);
}

/** The strokes series lines are drawn with: each its own colour, dash and marker, never colour alone. */
const LINE_STYLES = [
	{ color: "var(--primary)", dash: undefined, marker: "circle" },
	{ color: "var(--foreground)", dash: "6 4", marker: "square" },
	{ color: "var(--muted-foreground)", dash: "2 3", marker: "triangle" },
	{ color: "var(--chart-5)", dash: "10 3 2 3", marker: "diamond" },
] as const;

function Marker({ kind, x, y, color }: { kind: string; x: number; y: number; color: string }) {
	switch (kind) {
		case "square":
			return <rect x={x - 3} y={y - 3} width={6} height={6} fill={color} />;
		case "triangle":
			return <path d={`M${x} ${y - 4} L${x + 4} ${y + 3} L${x - 4} ${y + 3} Z`} fill={color} />;
		case "diamond":
			return <path d={`M${x} ${y - 4} L${x + 4} ${y} L${x} ${y + 4} L${x - 4} ${y} Z`} fill={color} />;
		default:
			return <circle cx={x} cy={y} r={3} fill={color} />;
	}
}

/** A point's start, as the axis and the table say it: the day, or the hour (UTC). */
function startText(start: Date | string, hourly: boolean): string {
	const iso = new Date(start).toISOString();
	return hourly ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

function isHourly(data: Extract<WidgetData, { shape: "series" }>): boolean {
	const [first, second] = data.points;
	return (
		first !== undefined &&
		second !== undefined &&
		new Date(second.start).getTime() - new Date(first.start).getTime() < 86_400_000
	);
}

function SeriesChart({ data, title }: { data: Extract<WidgetData, { shape: "series" }>; title: string }) {
	const t = useT();
	const number = useNumber();
	const id = useId();
	const width = 600;
	const height = 200;
	const pad = { top: 12, right: 12, bottom: 24, left: 44 };
	const max = Math.max(1, ...data.points.flatMap((point) => data.lines.map((line) => point.values[line.key] ?? 0)));
	const hourly = isHourly(data);
	const xOf = (index: number) =>
		pad.left + (data.points.length <= 1 ? 0 : (index / (data.points.length - 1)) * (width - pad.left - pad.right));
	const yOf = (value: number) => pad.top + (1 - value / max) * (height - pad.top - pad.bottom);
	const first = data.points[0];
	const last = data.points.at(-1);
	const summary = t("dashboards.chartSummary", {
		lines: data.lines.map((line) => line.label).join(", "),
		interval: t(hourly ? "dashboards.intervals.hour" : "dashboards.intervals.day"),
		from: first ? startText(first.start, hourly) : "",
		to: last ? startText(last.start, hourly) : "",
		max: number.format(max),
	});
	return (
		<figure className="grid gap-2">
			<svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-labelledby={`${id}-summary`}>
				<title id={`${id}-summary`}>{`${title}. ${summary}`}</title>
				<line
					x1={pad.left}
					x2={width - pad.right}
					y1={height - pad.bottom}
					y2={height - pad.bottom}
					stroke="var(--border)"
				/>
				<line
					x1={pad.left}
					x2={width - pad.right}
					y1={pad.top}
					y2={pad.top}
					stroke="var(--border)"
					strokeDasharray="2 4"
				/>
				<text x={pad.left - 6} y={pad.top + 4} textAnchor="end" fontSize="11" fill="var(--muted-foreground)">
					{number.format(max)}
				</text>
				<text
					x={pad.left - 6}
					y={height - pad.bottom + 4}
					textAnchor="end"
					fontSize="11"
					fill="var(--muted-foreground)"
				>
					0
				</text>
				{first ? (
					<text x={pad.left} y={height - 6} fontSize="11" fill="var(--muted-foreground)">
						{startText(first.start, hourly)}
					</text>
				) : null}
				{last && data.points.length > 1 ? (
					<text x={width - pad.right} y={height - 6} textAnchor="end" fontSize="11" fill="var(--muted-foreground)">
						{startText(last.start, hourly)}
					</text>
				) : null}
				{data.lines.map((line, index) => {
					const style = LINE_STYLES[index % LINE_STYLES.length] ?? LINE_STYLES[0];
					const points = data.points.map((point, at) => [xOf(at), yOf(point.values[line.key] ?? 0)] as const);
					return (
						<g key={line.key}>
							<polyline
								points={points.map(([x, y]) => `${x},${y}`).join(" ")}
								fill="none"
								stroke={style.color}
								strokeWidth={2}
								strokeDasharray={style.dash}
							/>
							{points.length <= 48
								? points.map(([x, y], at) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: points are in a fixed order.
										<Marker key={at} kind={style.marker} x={x} y={y} color={style.color} />
									))
								: null}
						</g>
					);
				})}
			</svg>
			<figcaption>
				<ul className="flex flex-wrap gap-4 text-sm">
					{data.lines.map((line, index) => {
						const style = LINE_STYLES[index % LINE_STYLES.length] ?? LINE_STYLES[0];
						return (
							<li key={line.key} className="flex items-center gap-2">
								<svg width="28" height="10" aria-hidden="true">
									<line
										x1="0"
										x2="28"
										y1="5"
										y2="5"
										stroke={style.color}
										strokeWidth={2}
										strokeDasharray={style.dash}
									/>
									<Marker kind={style.marker} x={14} y={5} color={style.color} />
								</svg>
								{line.label}
							</li>
						);
					})}
				</ul>
			</figcaption>
		</figure>
	);
}

function SeriesTable({ data, title }: { data: Extract<WidgetData, { shape: "series" }>; title: string }) {
	const t = useT();
	const number = useNumber();
	const hourly = isHourly(data);
	return (
		<ScrollTable caption={title}>
			<TableHeader>
				<TableRow>
					<TableHead scope="col">{t("dashboards.start")}</TableHead>
					{data.lines.map((line) => (
						<TableHead key={line.key} scope="col" className="text-end">
							{line.label}
						</TableHead>
					))}
				</TableRow>
			</TableHeader>
			<TableBody>
				{data.points.map((point) => (
					<TableRow key={String(point.start)}>
						<TableCell>{startText(point.start, hourly)}</TableCell>
						{data.lines.map((line) => (
							<TableCell key={line.key} className="text-end tabular-nums">
								{number.format(point.values[line.key] ?? 0)}
							</TableCell>
						))}
					</TableRow>
				))}
			</TableBody>
		</ScrollTable>
	);
}

/** A table's caption for screen readers (the Widget's title shows above it), and a scroll area of its own. */
function ScrollTable({ caption, children }: { caption: string; children: ReactNode }) {
	return (
		<Table>
			<caption className="sr-only">{caption}</caption>
			{children}
		</Table>
	);
}

function useCellText() {
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

function RowsTable({ data, title }: { data: Extract<WidgetData, { shape: "table" }>; title: string }) {
	const t = useT();
	const number = useNumber();
	const cellText = useCellText();
	const [first] = data.columns.filter((column) => column.kind === "count");
	const max = Math.max(1, ...data.rows.map((row) => Number(first ? (row.cells[first.key] ?? 0) : 0)));
	if (data.rows.length === 0) return <p className="text-muted-foreground text-sm">{t("dashboards.noData")}</p>;
	return (
		<ScrollTable caption={title}>
			<TableHeader>
				<TableRow>
					{data.columns.map((column) => (
						<TableHead
							key={column.key}
							scope="col"
							className={column.kind === "count" || column.kind === "rate" ? "text-end" : undefined}
						>
							{column.label}
						</TableHead>
					))}
				</TableRow>
			</TableHeader>
			<TableBody>
				{data.rows.map((row) => (
					<TableRow key={row.key}>
						{data.columns.map((column, index) => {
							const cell = row.cells[column.key];
							if (typeof cell === "object" && cell !== null) {
								return (
									<TableCell key={column.key} className="text-end tabular-nums">
										{percent(cell.count, cell.of) ?? "–"}
									</TableCell>
								);
							}
							if (typeof cell === "number") {
								return (
									<TableCell key={column.key} className="text-end tabular-nums">
										{number.format(cell)}
									</TableCell>
								);
							}
							const share = first ? Number(row.cells[first.key] ?? 0) / max : 0;
							return (
								<TableCell
									key={column.key}
									className={`max-w-64 break-all whitespace-normal ${column.kind === "path" ? "font-mono text-xs" : ""}`}
								>
									<span className="grid gap-1">
										{cellText(column.kind, cell ?? "")}
										{index === 0 ? (
											<span
												aria-hidden="true"
												className="bg-primary/70 block h-1 rounded-full"
												style={{ width: `${Math.max(2, share * 100)}%` }}
											/>
										) : null}
									</span>
								</TableCell>
							);
						})}
					</TableRow>
				))}
			</TableBody>
		</ScrollTable>
	);
}

function FunnelBars({ data }: { data: Extract<WidgetData, { shape: "funnel" }> }) {
	const t = useT();
	const number = useNumber();
	const first = data.steps[0]?.count ?? 0;
	return (
		<ol className="grid gap-3">
			{data.steps.map((step, index) => {
				const before = index === 0 ? null : (data.steps[index - 1]?.count ?? 0);
				const share = first > 0 ? step.count / first : 0;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: a Funnel's steps are in a fixed order.
					<li key={index} className="grid gap-1">
						<div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
							<span className="font-medium break-all">
								{t("dashboards.funnelStepN", { n: index + 1 })} · {step.label}
							</span>
							<span className="tabular-nums">
								{t("dashboards.funnelReached", {
									count: number.format(step.count),
									percent: percent(step.count, first) ?? "–",
								})}
							</span>
						</div>
						<span aria-hidden="true" className="bg-muted block h-3 overflow-hidden rounded">
							<span className="bg-primary block h-full" style={{ width: `${Math.max(1, share * 100)}%` }} />
						</span>
						{before !== null ? (
							<span className="text-muted-foreground text-xs">
								{t("dashboards.funnelDropped", {
									count: number.format(before - step.count),
									percent: percent(before - step.count, before) ?? "–",
								})}
							</span>
						) : null}
					</li>
				);
			})}
		</ol>
	);
}

function FunnelTable({ data, title }: { data: Extract<WidgetData, { shape: "funnel" }>; title: string }) {
	const t = useT();
	const number = useNumber();
	const first = data.steps[0]?.count ?? 0;
	return (
		<ScrollTable caption={title}>
			<TableHeader>
				<TableRow>
					<TableHead scope="col">{t("dashboards.funnelStep")}</TableHead>
					<TableHead scope="col" className="text-end">
						{t("dashboards.funnelVisitors")}
					</TableHead>
					<TableHead scope="col" className="text-end">
						{t("dashboards.funnelOfFirst")}
					</TableHead>
					<TableHead scope="col" className="text-end">
						{t("dashboards.funnelLeft")}
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{data.steps.map((step, index) => {
					const before = index === 0 ? null : (data.steps[index - 1]?.count ?? 0);
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: a Funnel's steps are in a fixed order.
						<TableRow key={index}>
							<TableCell className="break-all whitespace-normal">{step.label}</TableCell>
							<TableCell className="text-end tabular-nums">{number.format(step.count)}</TableCell>
							<TableCell className="text-end tabular-nums">{percent(step.count, first) ?? "–"}</TableCell>
							<TableCell className="text-end tabular-nums">
								{before === null ? "–" : (percent(before - step.count, before) ?? "–")}
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</ScrollTable>
	);
}
