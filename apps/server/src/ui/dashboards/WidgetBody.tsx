import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import type { ReactNode } from "react";

import { useT } from "../i18n.tsx";
import { Bar, ChangeCell, FunnelSteps, LineChart, RankedRows, StatTiles, useCellText, useNumbers } from "./charts.tsx";
import { changeOf, percent, type WidgetData } from "./model.ts";

/**
 * A Widget's data, drawn by its shape with WebCraft's own pieces (ADR 0024: no Module code runs in
 * the admin; `charts.tsx` draws them). Every chart has the same numbers as a table (`asTable`).
 * `before` is the period before, when the Dashboard compares and the kind does.
 */
export function WidgetBody({
	data,
	before,
	asTable,
	title,
	versus,
	nowLabel,
	beforeLabel,
}: {
	data: WidgetData;
	before: WidgetData | null;
	asTable: boolean;
	title: string;
	/** What a change is compared with ("vs previous 30 days"). */
	versus: string;
	nowLabel: string;
	beforeLabel: string;
}) {
	switch (data.shape) {
		case "note":
			return <p className="text-sm leading-relaxed whitespace-pre-wrap">{data.text}</p>;
		case "number":
			return <StatTiles data={data} before={before?.shape === "number" ? before : null} versus={versus} />;
		case "series":
			return asTable ? (
				<SeriesTable data={data} title={title} />
			) : (
				<LineChart
					data={data}
					before={before?.shape === "series" ? before : null}
					title={title}
					nowLabel={nowLabel}
					beforeLabel={beforeLabel}
				/>
			);
		case "table":
			return asTable ? (
				<RowsTable data={data} title={title} />
			) : data.columns.some((column) => column.kind === "site") ? (
				<SitesTable data={data} title={title} />
			) : (
				<RankedRows data={data} title={title} />
			);
		case "funnel":
			return asTable ? <FunnelTable data={data} title={title} /> : <FunnelSteps data={data} title={title} />;
	}
}

/** Whether a shape has a chart that can be shown as a table instead. */
export function hasChart(shape: WidgetData["shape"]): boolean {
	return shape === "series" || shape === "funnel" || shape === "table";
}

/** Whether the data have anything to show in the range: a count above nothing, a row, a step reached. */
export function hasSomething(data: WidgetData): boolean {
	switch (data.shape) {
		case "note":
			return true;
		case "number":
			return data.values.some((value) => value.count > 0 || (value.of ?? 0) > 0);
		case "series":
			return data.points.some((point) => Object.values(point.values).some((value) => value > 0));
		case "table":
			return data.rows.length > 0;
		case "funnel":
			return data.steps.some((step) => step.count > 0);
	}
}

/** A point's start, as the table says it: the day, or the hour (UTC). */
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

function useNumber() {
	const numbers = useNumbers();
	return { format: numbers.whole };
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

function RowsTable({ data, title }: { data: Extract<WidgetData, { shape: "table" }>; title: string }) {
	const number = useNumber();
	const numbers = useNumbers();
	const cellText = useCellText();
	return (
		<ScrollTable caption={title}>
			<TableHeader>
				<TableRow>
					{data.columns.map((column) => (
						<TableHead
							key={column.key}
							scope="col"
							className={
								column.kind === "count" || column.kind === "rate" || column.kind === "change" ? "text-end" : undefined
							}
						>
							{column.label}
						</TableHead>
					))}
				</TableRow>
			</TableHeader>
			<TableBody>
				{data.rows.map((row) => (
					<TableRow key={row.key}>
						{data.columns.map((column) => {
							const cell = row.cells[column.key];
							if (typeof cell === "object" && cell !== null) {
								const change = column.kind === "change" ? changeOf(cell.count, cell.of) : null;
								return (
									<TableCell key={column.key} className="text-end tabular-nums">
										{column.kind === "change"
											? change === null
												? "–"
												: numbers.change(change)
											: (percent(cell.count, cell.of) ?? "–")}
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
							return (
								<TableCell key={column.key} className="max-w-64 break-all whitespace-normal">
									{cellText(column.kind, cell ?? "")}
								</TableCell>
							);
						})}
					</TableRow>
				))}
			</TableBody>
		</ScrollTable>
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
						// oxlint-disable-next-line react/no-array-index-key -- a Funnel's steps are in a fixed order.
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

/**
 * By Site (a Workspace's Dashboard): a table of the Sites, each by name, with its counts, how the
 * first changed on the period before (arrow and signed share), and a bar beside each later count for
 * its share of the most (Form Submissions), as frame "Workspace Dashboard" draws it.
 */
function SitesTable({ data, title }: { data: Extract<WidgetData, { shape: "table" }>; title: string }) {
	const numbers = useNumbers();
	const counts = data.columns.filter((column) => column.kind === "count");
	const barred = new Set(counts.slice(1).map((column) => column.key));
	const most = (key: string) =>
		Math.max(1, ...data.rows.map((row) => (typeof row.cells[key] === "number" ? (row.cells[key] as number) : 0)));
	return (
		// Fixed columns that fit the Widget: a long Site name is cut, never scrolled.
		<div className="overflow-hidden rounded-lg border">
			<Table className="table-fixed">
				<caption className="sr-only">{title}</caption>
				<colgroup>
					{data.columns.map((column) => (
						<col
							key={column.key}
							className={column.kind === "site" ? undefined : barred.has(column.key) ? "w-[30%]" : "w-[20%]"}
						/>
					))}
				</colgroup>
				<TableHeader className="bg-muted/50 [&_th]:text-muted-foreground [&_th]:font-normal">
					<TableRow className="hover:bg-transparent">
						{data.columns.map((column) => (
							<TableHead key={column.key} scope="col" className="truncate first:ps-4 last:pe-4" title={column.label}>
								{column.label}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{data.rows.map((row) => (
						<TableRow key={row.key}>
							{data.columns.map((column) => {
								const cell = row.cells[column.key];
								const place = "overflow-hidden py-3 first:ps-4 last:pe-4";
								if (column.kind === "site") {
									return (
										<TableCell key={column.key} className={`${place} truncate font-medium`} title={String(cell ?? "")}>
											{String(cell ?? "")}
										</TableCell>
									);
								}
								if (column.kind === "change" && typeof cell === "object" && cell !== null) {
									return (
										<TableCell key={column.key} className={place}>
											<ChangeCell now={cell.count} before={cell.of} />
										</TableCell>
									);
								}
								const count = typeof cell === "number" ? cell : 0;
								return (
									<TableCell key={column.key} className={`${place} tabular-nums`}>
										{barred.has(column.key) ? (
											<span className="flex items-center gap-2">
												<span className="font-medium">{numbers.whole(count)}</span>
												<Bar
													share={count / most(column.key)}
													className="h-1.5 w-12 min-w-0 shrink rounded-[3px]"
													fill="rounded-[3px]"
												/>
											</span>
										) : (
											<span className="text-muted-foreground">{numbers.whole(count)}</span>
										)}
									</TableCell>
								);
							})}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
